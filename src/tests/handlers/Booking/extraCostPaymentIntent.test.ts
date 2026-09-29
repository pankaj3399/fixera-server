import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bookingFindById: vi.fn(),
  paymentFindOneAndUpdate: vi.fn(),
  stripeCreate: vi.fn(),
  stripeCancel: vi.fn(),
  platformConfig: vi.fn(),
  loyaltyConfig: vi.fn(),
  startSession: vi.fn(),
  convertToStripeAmount: vi.fn(),
  buildPaymentMetadata: vi.fn(),
  generateIdempotencyKey: vi.fn(),
}));

vi.mock('../../../models/booking', () => ({ default: { findById: mocks.bookingFindById } }));
vi.mock('../../../models/user', () => ({ default: { findById: vi.fn() } }));
vi.mock('../../../models/platformSettings', () => ({ default: { getCurrentConfig: mocks.platformConfig } }));
vi.mock('../../../models/loyaltyConfig', () => ({ default: { getCurrentConfig: mocks.loyaltyConfig } }));
vi.mock('../../../models/payment', () => ({ default: { findOneAndUpdate: mocks.paymentFindOneAndUpdate } }));
vi.mock('../../../services/stripe', () => ({
  stripe: { paymentIntents: { create: mocks.stripeCreate, cancel: mocks.stripeCancel, retrieve: vi.fn() } },
  STRIPE_CONFIG: { environment: 'test' },
}));
vi.mock('../../../utils/payment', () => ({
  convertToStripeAmount: mocks.convertToStripeAmount,
  buildPaymentMetadata: mocks.buildPaymentMetadata,
  generateIdempotencyKey: mocks.generateIdempotencyKey,
}));
vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongoose')>();
  return { ...actual, default: { ...actual.default, startSession: mocks.startSession } };
});

import { createExtraCostPaymentIntent } from '../../../handlers/Booking/completion';

const paymentTerms = {
  vatRate: 21,
  reverseCharge: false,
  currency: 'EUR',
};

const createBooking = (overrides: Record<string, any> = {}) => {
  const booking: any = {
    _id: { toString: () => 'booking-1' },
    bookingNumber: 'BK-1',
    status: 'professional_completed',
    customer: { _id: { toString: () => 'customer-1' }, loyaltyLevel: 'Bronze' },
    professional: { _id: { toString: () => 'pro-1' }, stripe: { accountId: 'acct_1' } },
    project: null,
    extraCostTotal: 21.9,
    extraCosts: [{ amount: 21.9 }],
    payment: { ...paymentTerms },
    set: vi.fn(function (this: any, path: string, value: unknown) {
      const keys = path.split('.');
      let target = this;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      target[keys[keys.length - 1]] = value;
    }),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return booking;
};

const request = { params: { bookingId: 'booking-1' }, user: { _id: 'customer-1' } } as any;

const callEndpoint = async () => {
  const json = vi.fn();
  const status = vi.fn().mockReturnThis();
  await createExtraCostPaymentIntent(request, { json, status } as any);
  return { json, status };
};

describe('createExtraCostPaymentIntent response terms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindById.mockImplementation(() => {
      const query: any = { populate: vi.fn(() => query) };
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(createBooking()).then(resolve);
      return query;
    });
    mocks.platformConfig.mockResolvedValue({ commissionPercent: 0 });
    mocks.loyaltyConfig.mockResolvedValue({ globalSettings: { isEnabled: false }, tiers: [] });
    mocks.convertToStripeAmount.mockImplementation((amount: number) => Math.round(amount * 100));
    mocks.buildPaymentMetadata.mockReturnValue({});
    mocks.generateIdempotencyKey.mockReturnValue('extra-cost-key');
    mocks.stripeCreate.mockResolvedValue({ id: 'pi_extra', client_secret: 'secret_extra' });
    mocks.paymentFindOneAndUpdate.mockResolvedValue({});
    mocks.startSession.mockResolvedValue({
      withTransaction: (callback: () => Promise<void>) => callback(),
      endSession: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('returns net, VAT, and VAT rate for a fresh VAT-inclusive intent', async () => {
    const { json } = await callEndpoint();

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        customerChargeAmount: 26.5,
        customerNetChargeAmount: 21.9,
        vatAmount: 4.6,
        vatRate: 21,
      }),
    }));
    expect(mocks.stripeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2650 }),
      expect.anything(),
    );
  });

  it('returns the stored VAT terms when reusing an existing intent', async () => {
    const booking = createBooking({
      payment: {
        ...paymentTerms,
        extraCostStripePaymentIntentId: 'pi_existing',
        extraCostClientSecret: 'secret_existing',
        extraCostAmount: 26.5,
        extraCostCustomerNetAmount: 21.9,
        extraCostVatAmount: 4.6,
      },
    });
    mocks.bookingFindById.mockImplementation(() => {
      const query: any = { populate: vi.fn(() => query) };
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(booking).then(resolve);
      return query;
    });

    const { json } = await callEndpoint();

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        clientSecret: 'secret_existing',
        customerChargeAmount: 26.5,
        customerNetChargeAmount: 21.9,
        vatAmount: 4.6,
        vatRate: 21,
      }),
    }));
    expect(mocks.stripeCreate).not.toHaveBeenCalled();
  });
});
