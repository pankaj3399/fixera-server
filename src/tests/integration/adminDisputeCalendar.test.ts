import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dispute_calendar';
});

const { refundMock, notifyMock, auditMock, retrieveMock, cancelMock } = vi.hoisted(() => ({
  refundMock: vi.fn(),
  retrieveMock: vi.fn(),
  cancelMock: vi.fn(),
  notifyMock: vi.fn(async () => undefined),
  auditMock: vi.fn(async () => undefined),
}));

const calendarGate = vi.hoisted(() => ({
  active: null as null | { reached: () => void; wait: Promise<void> },
}));

vi.mock('../../utils/support/calendarReservations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/support/calendarReservations')>();
  return {
    ...actual,
    withCalendarTransactionIfConnected: async (fn: any) => {
      const gate = calendarGate.active;
      if (gate) {
        calendarGate.active = null;
        gate.reached();
        await gate.wait;
      }
      return actual.withCalendarTransactionIfConnected(fn);
    },
  };
});

vi.mock('../../handlers/Stripe/payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/Stripe/payment')>();
  return {
    ...actual,
    executeRefund: refundMock,
    captureAndTransferPayment: vi.fn(async () => ({ success: true })),
  };
});
vi.mock('../../services/stripe', () => ({
  stripe: { paymentIntents: { retrieve: retrieveMock, cancel: cancelMock } },
  STRIPE_CONFIG: { environment: 'test', defaultCurrency: 'EUR', supportedCurrencies: ['EUR'] },
}));
vi.mock('../../utils/notifications/notifyBookingCancelledAndRefunded', () => ({
  notifyBookingCancelledAndRefunded: vi.fn(),
}));
vi.mock('../../utils/notifications/notify', () => ({ notify: notifyMock }));
vi.mock('../../utils/auditLogger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/auditLogger')>();
  return { ...actual, auditLog: auditMock };
});

import Referral from '../../models/referral';
import CancellationRequest from '../../models/cancellationRequest';
import { approveCancellationRequest } from '../../handlers/Admin/cancellationRequests';
import Booking from '../../models/booking';
import CalendarReservation from '../../models/calendarReservation';
import Conversation from '../../models/conversation';
import User from '../../models/user';
import Project from '../../models/project';
import { resolveDispute } from '../../handlers/Admin/disputeManagement';
import { buildCalendarReservationKeysForInterval, reserveCalendarKeys } from '../../utils/support/calendarReservations';

const customerId = new Types.ObjectId('507f1f77bcf86cd799439071');
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439072');
const adminId = new Types.ObjectId('507f1f77bcf86cd799439073');
const projectId = new Types.ObjectId('507f1f77bcf86cd799439074');
const oldStart = new Date('2030-11-04T09:00:00.000Z');
const oldEnd = new Date('2030-11-04T10:00:00.000Z');

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

const seedUsersAndProject = async () => {
  await User.collection.insertMany([
    {
      _id: customerId,
      name: 'Customer',
      email: 'customer@example.com',
      role: 'customer',
      isEmailVerified: true,
      deletedAt: null,
    },
    {
      _id: professionalId,
      name: 'Professional',
      email: 'professional@example.com',
      role: 'professional',
      timeZone: 'Europe/Brussels',
      businessInfo: { timezone: 'Europe/Brussels' },
      isEmailVerified: true,
      deletedAt: null,
    },
  ] as any[]);
  await Project.collection.insertOne({
    _id: projectId,
    professionalId,
    status: 'published',
    title: 'Dispute project',
    category: 'Renovation',
    resources: [professionalId.toString()],
    minResources: 1,
    executionDuration: { value: 1, unit: 'hours' },
  });
};

const seedDisputeBooking = async (overrides: Record<string, any> = {}) => {
  const bookingId = new Types.ObjectId();
  await Booking.collection.insertOne({
    _id: bookingId,
    bookingNumber: `BK-2030-${String(bookingId).slice(-6)}`,
    bookingType: 'project',
    customer: customerId,
    professional: professionalId,
    project: projectId,
    status: 'dispute',
    statusBeforeDispute: 'booked',
    dispute: {
      raisedAt: new Date('2030-10-01T09:00:00.000Z'),
      raisedBy: customerId,
      type: 'reschedule',
      reason: 'Need another date',
      description: 'Customer requested a different date',
    },
    scheduledStartDate: oldStart,
    scheduledExecutionEndDate: oldEnd,
    scheduledBufferEndDate: oldEnd,
    assignedTeamMembers: [professionalId],
    location: { type: 'Point', coordinates: [0, 0] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  await reserveCalendarKeys({
    sourceType: 'booking',
    sourceId: bookingId,
    keys: buildCalendarReservationKeysForInterval({
      role: 'professional',
      userId: professionalId,
      startAt: oldStart,
      endAt: oldEnd,
    }),
  });
  return bookingId;
};

const resolveRequest = (bookingId: Types.ObjectId, body: Record<string, any>) => ({
  params: { bookingId: String(bookingId) },
  body: { action: 'accept_professional', resolution: 'Admin resolved the dispute', ...body },
  user: { _id: adminId },
} as any);

const settleBackgroundWork = async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
};

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describeDb('admin dispute resolution keeps the booking calendar boundary', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_dispute_it_${Date.now()}` });
    await Promise.all([
      Booking.createIndexes(),
      Referral.createIndexes(),
      CancellationRequest.createIndexes(),
      CalendarReservation.createIndexes(),
      Conversation.createIndexes(),
      Project.createIndexes(),
      User.createIndexes(),
    ]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    refundMock.mockReset();
    await Promise.all([
      Booking.deleteMany({}),
      Referral.deleteMany({}),
      CancellationRequest.deleteMany({}),
      CalendarReservation.deleteMany({}),
      Conversation.deleteMany({}),
      Project.deleteMany({}),
      User.deleteMany({}),
    ]);
    await seedUsersAndProject();
  });

  afterAll(async () => {
    await settleBackgroundWork();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it.each(['retrieve', 'cancel'])('approves cancellation and frees the calendar despite a Stripe %s failure', async operation => {
    const bookingId = await seedDisputeBooking({
      status: 'quote_accepted',
      rfqData: { serviceType: 'Renovation', description: 'Cancellation regression' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, answers: [] },
      statusHistory: [],
      payment: { status: 'pending', stripePaymentIntentId: 'pi_pending', discount: { referralReservationToken: 'pi_pending' } },
    });
    const referral = await Referral.create({
      referrer: professionalId, referredUser: customerId, referralCode: 'TEST',
      discountBooking: bookingId, discountReservationToken: 'pi_pending',
      expiresAt: new Date('2031-01-01'),
    });
    const request = await CancellationRequest.create({
      booking: bookingId, requestedBy: customerId, requestedRole: 'customer', reason: 'No longer needed',
    });
    retrieveMock.mockResolvedValue({ status: 'requires_payment_method' });
    cancelMock.mockResolvedValue({ status: 'canceled' });
    (operation === 'retrieve' ? retrieveMock : cancelMock).mockRejectedValueOnce(new Error('Stripe unavailable'));
    const res = mockRes();
    await approveCancellationRequest({ params: { id: String(request._id) }, body: {}, user: { _id: adminId } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect((await CancellationRequest.findById(request._id).lean())?.status).toBe('approved');
    expect((await Booking.findById(bookingId).lean())?.status).toBe('cancelled');
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(0);
    expect(await Referral.findById(referral._id).lean()).toMatchObject({ discountBooking: bookingId, discountReservationToken: 'pi_pending', referredUserDiscountApplied: false });
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('force-cancels a disputed booking and releases its shared reservations', async () => {
    const bookingId = await seedDisputeBooking();
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(4);

    const res = mockRes();
    await resolveDispute(resolveRequest(bookingId, { forceStatus: 'cancelled' }), res as any);
    await settleBackgroundWork();

    expect(res.statusCode).toBe(200);
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('cancelled');
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(0);
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('force-reschedules atomically and leaves the old window free', async () => {
    const bookingId = await seedDisputeBooking();
    const res = mockRes();
    await resolveDispute(
      resolveRequest(bookingId, { forcedStartDate: '2030-11-11', forcedStartTime: '09:00' }),
      res as any,
    );
    await settleBackgroundWork();

    expect(res.statusCode).toBe(200);
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('booked');
    expect(stored?.scheduledStartDate?.getTime()).not.toBe(oldStart.getTime());

    const keys = await CalendarReservation.find({ sourceId: bookingId }).lean();
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys.map((entry: any) => entry.startAt.toISOString().slice(0, 10)))).toEqual(
      new Set(['2030-11-11']),
    );

    await expect(reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: oldStart,
        endAt: oldEnd,
      }),
    })).resolves.toBeUndefined();
  });

  it('force-reschedules day planning with the same reset and minimum-duration logic as participant rescheduling', async () => {
    await Project.collection.updateOne({ _id: projectId }, { $set: { executionDuration: { value: 2, unit: 'days' } } });
    const oldDay = new Date('2030-11-04T00:00:00Z');
    const keptDay = new Date('2030-11-14T00:00:00Z');
    const bookingId = await seedDisputeBooking({ resourcePlan: [{ resourceId: professionalId, days: [oldDay, keptDay] }] });
    const res = mockRes();
    await resolveDispute(resolveRequest(bookingId, { forcedStartDate: '2030-11-11' }), res as any);
    expect(res.statusCode).toBe(200);
    const stored = await Booking.findById(bookingId).lean();
    const days = stored!.resourcePlan!.flatMap((entry) => entry.days.map((day) => day.toISOString().slice(0, 10)));
    expect(days).not.toContain('2030-11-04');
    expect(days).toContain('2030-11-14');
    expect(days).toEqual(expect.arrayContaining(['2030-11-11', '2030-11-12', '2030-11-14']));
    expect(days.every((day) => day >= '2030-11-11')).toBe(true);
    const reservations = await CalendarReservation.find({ sourceId: bookingId }).lean();
    expect(new Set(reservations.map((row) => row.startAt.toISOString().slice(0, 10)))).toEqual(new Set(days));
  }, 30000);

  it('returns an actionable 409 without a partial update when the new window is already reserved', async () => {
    const bookingId = await seedDisputeBooking();
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-11T08:00:00.000Z'),
        endAt: new Date('2030-11-11T09:00:00.000Z'),
      }),
    });
    const originalKeys = await CalendarReservation.find({ sourceId: bookingId }).lean();

    const res = mockRes();
    await resolveDispute(
      resolveRequest(bookingId, { forcedStartDate: '2030-11-11', forcedStartTime: '09:00' }),
      res as any,
    );
    await settleBackgroundWork();

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('TEAM_CONFLICT');
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('dispute');
    expect(stored?.scheduledStartDate?.getTime()).toBe(oldStart.getTime());
    const keysNow = await CalendarReservation.find({ sourceId: bookingId }).lean();
    expect(keysNow.map((entry: any) => entry.key).sort()).toEqual(
      originalKeys.map((entry: any) => entry.key).sort(),
    );
  });

  it('keeps the original booking/reservations when a refund fails and reopens the dispute', async () => {
    const bookingId = await seedDisputeBooking();
    refundMock.mockRejectedValueOnce(new Error('Stripe refund unavailable'));
    const res = mockRes();
    await resolveDispute(resolveRequest(bookingId, { forceStatus: 'refunded' }), res as any);

    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('REFUND_FAILED');
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('dispute');
    expect(stored?.scheduledStartDate?.getTime()).toBe(oldStart.getTime());
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(4);
    expect(refundMock).toHaveBeenCalledTimes(1);
  });

  it('returns a 409 when another writer takes the slot after the pre-check', async () => {
    const bookingId = await seedDisputeBooking();
    const reached = deferred();
    const release = deferred();
    calendarGate.active = { reached: reached.resolve, wait: release.promise };

    const res = mockRes();
    const resolving = resolveDispute(
      resolveRequest(bookingId, { forcedStartDate: '2030-11-11', forcedStartTime: '09:00' }),
      res as any,
    );
    await reached.promise;

    // The pre-check already passed; a support hold takes the new window before
    // the booking transaction inserts its keys.
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-11T08:00:00.000Z'),
        endAt: new Date('2030-11-11T08:30:00.000Z'),
      }),
    });
    release.resolve();
    await resolving;
    await settleBackgroundWork();

    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('dispute');
    expect(stored?.scheduledStartDate?.getTime()).toBe(oldStart.getTime());
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(4);
  });
});
