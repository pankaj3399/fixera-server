import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  bookingFind: vi.fn(),
  bookingCountDocuments: vi.fn(),
  bookingAggregate: vi.fn(),
  bookingDistinct: vi.fn(),
  paymentFind: vi.fn(),
  paymentCountDocuments: vi.fn(),
  paymentAggregate: vi.fn(),
  userFindById: vi.fn(),
  userFind: vi.fn(),
  projectFind: vi.fn(),
  projectDistinct: vi.fn(),
}));

vi.mock('../../../models/booking', () => ({
  default: {
    find: mocks.bookingFind,
    findById: vi.fn(),
    countDocuments: mocks.bookingCountDocuments,
    aggregate: mocks.bookingAggregate,
    distinct: mocks.bookingDistinct,
    create: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../../models/payment', () => ({
  default: {
    find: mocks.paymentFind,
    findById: vi.fn(),
    countDocuments: mocks.paymentCountDocuments,
    aggregate: mocks.paymentAggregate,
  },
}));

vi.mock('../../../models/user', () => ({
  default: {
    findById: mocks.userFindById,
    find: mocks.userFind,
  },
}));

vi.mock('../../../models/project', () => ({
  default: {
    find: mocks.projectFind,
    distinct: mocks.projectDistinct,
  },
}));

vi.mock('../../../models/cancellationRequest', () => ({
  default: { find: vi.fn(), findOne: vi.fn() },
  ACTIVE_CANCELLATION_STATUSES: ['pending'],
  CANCELLATION_REASON_CATEGORIES: ['other'],
  CANCELLATION_REASON_LABELS: { other: 'Other' },
}));

vi.mock('../../../models/warrantyClaim', () => ({
  default: { updateMany: vi.fn() },
}));

vi.mock('../../../services/stripe', () => ({
  stripe: {},
  STRIPE_CONFIG: {
    supportedCurrencies: ['EUR'],
    defaultCurrency: 'EUR',
    environment: 'test',
    commissionPercent: 0,
  },
}));

vi.mock('../../../handlers/Stripe/payment', () => ({
  createPaymentIntent: vi.fn(),
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));

vi.mock('../../../services/invoiceArtifacts', () => ({
  ensureBookingInvoiceArtifacts: vi.fn(),
}));

vi.mock('../../../services/extraCostPayment', () => ({
  reconcileExtraCostPayment: vi.fn(),
}));

vi.mock('../../../utils/notifications/notify', () => ({
  notify: vi.fn(async () => undefined),
  notifyAsync: vi.fn(async () => undefined),
}));

vi.mock('../../../utils/emailService', () => ({
  sendDisputeRaisedAdminEmail: vi.fn(),
  sendCancellationRequestAdminEmail: vi.fn(),
  sendDisputeRaisedEmail: vi.fn(),
  sendCancellationRequestAdminEmail: vi.fn(),
}));

vi.mock('../../../utils/referralSystem', () => ({
  processReferralCompletion: vi.fn(),
}));

vi.mock('../../../utils/professionalLevelSystem', () => ({
  updateProfessionalLevel: vi.fn(),
}));

vi.mock('../../../utils/loyaltySystem', () => ({
  getCurrentTier: vi.fn(),
  updateUserLoyalty: vi.fn(),
}));

vi.mock('../../../utils/pointsSystem', () => ({
  addPoints: vi.fn(),
}));

import { getMyBookings, getMyPayments } from '../../../handlers/Booking';
import { getTransactions, getPaymentStats } from '../../../handlers/Professional/payments';

const mockRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

const chainFor = (rows: any[]) => {
  const chain: any = {};
  chain.populate = vi.fn(() => chain);
  chain.sort = vi.fn(() => chain);
  chain.skip = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  chain.lean = vi.fn(async () => rows);
  return chain;
};

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const PRO_ID = '507f1f77bcf86cd799439012';

describe('dashboard list counts and search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindById.mockResolvedValue({ _id: CUSTOMER_ID, role: 'customer' });
    mocks.userFind.mockReturnValue({ select: vi.fn(async () => []) });
    mocks.projectFind.mockReturnValue({ select: vi.fn(async () => []) });
    mocks.projectDistinct.mockResolvedValue([]);
    mocks.bookingDistinct.mockResolvedValue([]);
  });

  it('computes status counts without the status facet and service counts without the service facet', async () => {
    const bookingDoc = {
      _id: 'b1',
      bookingType: 'project',
      status: 'booked',
      bookingNumber: 'BK-2026-1',
      customer: { _id: CUSTOMER_ID, name: 'Anna' },
      professional: { _id: PRO_ID, name: 'Piet', adminTags: ['verified'] },
      project: { _id: 'p1', priceModel: 'unit' },
      payment: {
        status: 'completed',
        currency: 'EUR',
        totalWithVat: 1210,
        professionalPayout: 1089,
        transferredAt: new Date('2026-04-01T00:00:00.000Z'),
        transferStatus: 'succeeded',
      },
      toObject() {
        const { toObject: _omit, ...rest } = this as any;
        return { ...rest };
      },
    };
    mocks.bookingFind.mockReturnValue(chainFor([bookingDoc]));
    mocks.bookingCountDocuments.mockResolvedValue(1);
    mocks.bookingAggregate
      .mockResolvedValueOnce([{ _id: 'booked', count: 3 }, { _id: 'completed', count: 5 }])
      .mockResolvedValueOnce([{ _id: 'Cleaning', count: 8 }]);

    const res = mockRes();
    await getMyBookings(
      {
        user: { _id: CUSTOMER_ID },
        query: { status: 'booked', service: 'Cleaning', search: 'anna' },
      } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.statusCounts).toEqual({ booked: 3, completed: 5 });
    expect(res.body.serviceCounts).toEqual({ Cleaning: 8 });

    // Status-count aggregation must respect search but drop the status facet.
    const statusMatch = mocks.bookingAggregate.mock.calls[0][0].find((stage: any) => stage.$match)?.$match;
    expect(statusMatch).toBeTruthy();
    const statusSources = JSON.stringify(statusMatch, (_key, value) =>
      value instanceof RegExp ? value.source : value,
    );
    expect(statusSources).not.toContain('"status"');
    expect(statusSources).toContain('anna');
    // Service-count aggregation must respect status but drop the service facet.
    const serviceMatch = mocks.bookingAggregate.mock.calls[1][0].find((stage: any) => stage.$match)?.$match;
    const serviceSources = JSON.stringify(serviceMatch, (_key, value) =>
      value instanceof RegExp ? value.source : value,
    );
    expect(serviceSources).toContain('booked');
    expect(serviceSources).not.toContain('Cleaning');

    // Customer list payload strips the pro payout summary server-side.
    const row = res.body.bookings[0];
    expect(row.payment.professionalPayout).toBeUndefined();
    expect(row.payment.transferredAt).toBeUndefined();
    expect(row.payment.transferStatus).toBeUndefined();
    expect(row.payment.totalWithVat).toBe(1210);
    expect(row.priceModel).toBe('unit');
    expect(row.professional.adminTags).toEqual(['verified']);
  });

  it('expands the awaiting_payment alias server-side', async () => {
    mocks.bookingFind.mockReturnValue(chainFor([]));
    mocks.bookingCountDocuments.mockResolvedValue(0);
    mocks.bookingAggregate.mockResolvedValue([]);

    const res = mockRes();
    await getMyBookings(
      { user: { _id: CUSTOMER_ID }, query: { status: 'awaiting_payment' } } as unknown as Request,
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
    const findQuery = mocks.bookingFind.mock.calls[0][0];
    const andClauses: any[] = findQuery.$and || [];
    expect(andClauses).toContainEqual({ status: { $in: ['quote_accepted', 'payment_pending'] } });
  });

  it('searches customer payments by escaped booking number and exact booking id', async () => {
    const paymentDoc = {
      _id: 'pay1',
      bookingNumber: 'BK-2026-1',
      booking: { _id: 'b1', bookingNumber: 'BK-2026-1' },
      professional: { _id: 'p1', name: 'Piet' },
      status: 'completed',
    };
    const findChain: any = {};
    findChain.populate = vi.fn(() => findChain);
    findChain.sort = vi.fn(() => findChain);
    findChain.skip = vi.fn(() => findChain);
    findChain.limit = vi.fn(() => findChain);
    findChain.lean = vi.fn(async () => [paymentDoc]);
    mocks.paymentFind.mockReturnValue(findChain);
    mocks.paymentCountDocuments.mockResolvedValue(1);
    mocks.paymentAggregate.mockResolvedValue([]);

    const res = mockRes();
    await getMyPayments(
      {
        user: { _id: CUSTOMER_ID },
        query: { q: 'BK-2026.1 (test)' },
      } as unknown as Request,
      res,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
    const query = mocks.paymentFind.mock.calls[0][0];
    const searchOr = query.$and[0].$or;
    // Literal text: regex metacharacters are escaped, never raw.
    expect(String(searchOr[0].bookingNumber)).toContain('BK-2026\\.1 \\(test\\)');
    expect(res.body.data.payments).toHaveLength(1);
  });

  it('pages professional transactions with booking links and transfer-only dates', async () => {
    const txDocs = [
      {
        _id: 't1',
        booking: { _id: 'b1', bookingNumber: 'BK-1' },
        bookingNumber: 'BK-1',
        status: 'completed',
        currency: 'EUR',
        professionalPayout: 100,
        transferredAt: new Date('2026-04-02T00:00:00.000Z'),
        capturedAt: new Date('2026-04-01T00:00:00.000Z'),
        transferStatus: 'succeeded',
      },
      {
        _id: 't2',
        booking: { _id: 'b2', bookingNumber: 'BK-2' },
        bookingNumber: 'BK-2',
        status: 'completed',
        currency: 'EUR',
        professionalPayout: 50,
        capturedAt: new Date('2026-04-01T00:00:00.000Z'),
        transferStatus: null,
        stripeTransferId: null,
      },
    ];
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.populate = vi.fn(() => chain);
    chain.sort = vi.fn(() => chain);
    chain.skip = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.lean = vi.fn(async () => txDocs);
    mocks.paymentFind.mockReturnValue(chain);
    mocks.paymentCountDocuments.mockResolvedValue(19);

    const res = mockRes();
    await getTransactions(
      { user: { _id: PRO_ID }, query: { page: '2', limit: '10' } } as unknown as Request,
      res,
    );
    expect(res.body.pagination).toMatchObject({ page: 2, limit: 10, total: 19, totalPages: 2 });
    expect(res.body.data[0]).toMatchObject({ bookingId: 'b1', bookingNumber: 'BK-1' });
    expect(new Date(res.body.data[0].date).toISOString()).toBe('2026-04-02T00:00:00.000Z');
    // No transfer record: date is null, never a capturedAt fallback.
    expect(res.body.data[1].date).toBeNull();
    expect(chain.skip).toHaveBeenCalledWith(10);
  });
  it('filters professional transactions with escaped booking search under role and transfer filters', async () => {
    const chain: any = chainFor([]);
    chain.select = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    mocks.paymentFind.mockReturnValue(chain);
    mocks.paymentCountDocuments.mockResolvedValue(0);
    mocks.bookingFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'b1' }] }) });
    const res = mockRes();
    await getTransactions({ user: { _id: PRO_ID }, query: { q: 'BK-.*', status: 'transfer_failed' } } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    const query = mocks.paymentFind.mock.calls[0][0];
    expect(query.professional).toBe(PRO_ID);
    expect(query.status).toBe('completed');
    expect(query.$or).toBeDefined();
    expect(query.$and[0].$or[0].bookingNumber.test('BK-123')).toBe(false);
    expect(query.$and[0].$or[0].bookingNumber.test('BK-.*')).toBe(true);
    expect(query.$and[0].$or[1].booking.$in).toEqual(['b1']);
  });
  it('counts only canonical recorded customer reviews', async () => {
    mocks.paymentAggregate.mockResolvedValue([]);
    mocks.bookingAggregate.mockResolvedValue([]);
    const res = mockRes();
    await getPaymentStats({ user: { _id: PRO_ID } } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(mocks.bookingAggregate.mock.calls[0][0][0].$match).toEqual({
      professional: PRO_ID, 'customerReview.communicationLevel': { $exists: true, $ne: null },
    });
    expect(res.body.data.reviewCount).toBe(0);
  });

});
