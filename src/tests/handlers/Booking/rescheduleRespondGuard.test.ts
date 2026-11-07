import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({ booking: null as any }));

const chainable = (doc: any) => {
  const chain: any = {
    populate: () => chain,
    then: (resolve: any, reject: any) => Promise.resolve(doc).then(resolve, reject),
  };
  return chain;
};

vi.mock('../../../models/booking', () => ({
  default: { findById: vi.fn(() => chainable(mocks.booking)) },
}));
vi.mock('../../../models/project', () => ({ default: {} }));
vi.mock('../../../models/platformSettings', () => ({ default: {} }));
vi.mock('../../../models/pointsConfig', () => ({ default: {} }));
vi.mock('../../../models/pointTransaction', () => ({ default: {} }));
vi.mock('../../../models/user', () => ({ default: { findById: vi.fn() } }));
vi.mock('../../../models/warrantyClaim', () => ({ default: {} }));
vi.mock('../../Stripe/payment', () => ({
  createPaymentIntent: vi.fn(),
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));
vi.mock('../../../utils/payment', () => ({
  computeGrossBookingAmount: vi.fn(() => 0),
}));
vi.mock('../../../utils/referralSystem', () => ({}));
vi.mock('../../../utils/professionalLevelSystem', () => ({}));
vi.mock('../../../utils/loyaltySystem', () => ({}));
vi.mock('../../../utils/pointsSystem', () => ({}));
vi.mock('../../../utils/scheduleEngine', () => ({}));
vi.mock('../../../utils/reschedulePlanning', () => ({}));
vi.mock('../../../utils/warranty', () => ({}));
vi.mock('../../../utils/bookingHelpers', () => ({}));
vi.mock('../../../utils/notifications/notify', () => ({ notify: vi.fn() }));
vi.mock('../../../utils/displayName', () => ({}));
vi.mock('../../../utils/scheduleConflict', () => ({}));
vi.mock('../../../utils/scheduleRelease', () => ({}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: async (_ids: any, write: any) => write(undefined),
}));
vi.mock('../../../utils/bookingDetails/capture', () => ({}));
vi.mock('../../../utils/support/bookingCalendar', () => ({}));
vi.mock('../../../utils/invoiceVisibility', () => ({ bookingForRequest: vi.fn((booking: any) => booking) }));

import { respondToBookingReschedule } from '../../../handlers/Booking/payment-integration';

const customerId = new Types.ObjectId('507f1f77bcf86cd799439011');
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');

const pendingRequest = () => ({
  status: 'pending',
  requestedBy: professionalId,
  requestedAt: new Date('2026-02-07T10:00:00.000Z'),
  reason: 'New date needed',
  proposedSchedule: { scheduledStartDate: new Date('2026-02-12T09:00:00.000Z') },
});

const res = () => {
  const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return response;
};

describe('respondToBookingReschedule terminal guards (client bug list #9c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.booking = null;
  });

  it('rejects accept/decline with 409 once the request was disputed', async () => {
    mocks.booking = {
      _id: new Types.ObjectId(),
      status: 'dispute',
      customer: customerId,
      professional: professionalId,
      rescheduleRequest: undefined,
      dispute: { type: 'reschedule', raisedAt: new Date(), raisedBy: customerId },
    };
    const response = res();
    await respondToBookingReschedule(
      { params: { bookingId: String(mocks.booking._id) }, body: { action: 'accept' }, user: { _id: String(customerId) } } as any,
      response as any,
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json.mock.calls[0][0].error.code).toBe('RESCHEDULE_DISPUTED');
  });

  it('still rejects with 400 when no request is pending and no dispute is open', async () => {
    mocks.booking = {
      _id: new Types.ObjectId(),
      status: 'booked',
      customer: customerId,
      professional: professionalId,
      rescheduleRequest: undefined,
    };
    const response = res();
    await respondToBookingReschedule(
      { params: { bookingId: String(mocks.booking._id) }, body: { action: 'accept' }, user: { _id: String(customerId) } } as any,
      response as any,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].error.code).toBe('INVALID_STATUS');
  });

  it('explicitly rejects accept/decline while a reschedule dispute is open', async () => {
    mocks.booking = {
      _id: new Types.ObjectId(),
      status: 'rescheduling_requested',
      customer: customerId,
      professional: professionalId,
      rescheduleRequest: pendingRequest(),
      dispute: { type: 'reschedule', raisedAt: new Date(), raisedBy: customerId, resolvedAt: null },
    };
    for (const action of ['accept', 'decline']) {
      const response = res();
      await respondToBookingReschedule(
        { params: { bookingId: String(mocks.booking._id) }, body: { action }, user: { _id: String(customerId) } } as any,
        response as any,
      );
      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json.mock.calls[0][0].error.code).toBe('RESCHEDULE_DISPUTED');
    }
  });

  it('records the live subdoc, history and response consistently as disputed', async () => {
    const save = vi.fn(async () => mocks.booking);
    mocks.booking = {
      _id: new Types.ObjectId(),
      status: 'rescheduling_requested',
      customer: customerId,
      professional: professionalId,
      rescheduleRequest: pendingRequest(),
      statusHistory: [],
      rescheduleHistory: [],
      save,
    };
    const response = res();
    await respondToBookingReschedule(
      {
        params: { bookingId: String(mocks.booking._id) },
        body: { action: 'dispute', reason: 'Date changed' },
        user: { _id: String(customerId) },
      } as any,
      response as any,
    );
    expect(response.json.mock.calls[0][0].success).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    const savedHistory = mocks.booking.rescheduleHistory;
    expect(savedHistory).toHaveLength(1);
    // Review should-fix #1: live subdoc, history entry and response DTO must
    // agree on the 'disputed' terminal state — never 'declined'.
    expect(savedHistory[0]).toMatchObject({ status: 'disputed' });
    expect(savedHistory[0].status).not.toBe('declined');
    expect(mocks.booking.status).toBe('dispute');
    expect(mocks.booking.dispute).toMatchObject({ type: 'reschedule', reason: 'Date changed' });
    // The live subdoc is cleared on save, so no stale 'declined' leaks anywhere.
    expect(mocks.booking.rescheduleRequest).toBeUndefined();
  });
});
