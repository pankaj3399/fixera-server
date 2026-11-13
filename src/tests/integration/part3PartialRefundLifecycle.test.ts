import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ refund: vi.fn(), refundList: vi.fn(), invoices: vi.fn(), credits: vi.fn(), notify: vi.fn() }));
vi.mock('../../services/stripe', () => ({ stripe: {
  refunds: { create: mocks.refund, list: mocks.refundList }, transfers: { createReversal: vi.fn() },
}, STRIPE_CONFIG: { supportedCurrencies: ['EUR'], defaultCurrency: 'EUR', environment: 'test' } }));
vi.mock('../../services/invoiceArtifacts', () => ({
  CREDIT_GENERATION_CLAIM_TTL_MS: 900000,
  ensurePartialRefundCreditArtifacts: mocks.credits, ensureBookingInvoiceArtifacts: mocks.invoices,
}));
vi.mock('../../utils/notifications/notify', () => ({ notify: mocks.notify }));
vi.mock('../../utils/auditLogger', () => ({ auditLog: vi.fn(async () => undefined) }));
import Booking from '../../models/booking';
import User from '../../models/user';
import CalendarReservation from '../../models/calendarReservation';
import Payment from '../../models/payment';
import CancellationRequest from '../../models/cancellationRequest';
import { customerRespondToCounterOffer } from '../../handlers/Booking/refundNegotiation';
import { approveCancellationRequest } from '../../handlers/Admin/cancellationRequests';
import * as refundFinalization from '../../utils/refundFinalization';
import AccountDataGuard from '../../models/accountDataGuard';
import { refundPayment, executeRefund } from '../../handlers/Stripe/payment';
import { resolveDispute } from '../../handlers/Admin/disputeManagement';
import { replaceBookingCalendar } from '../../utils/support/bookingCalendar';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;
const proId = new Types.ObjectId(), customerId = new Types.ObjectId(), adminId = new Types.ObjectId();
const utcDay = (offset: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
};
const response = () => {
  const res = { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } };
  return res;
};

describeDb('Part 3 partial refund lifecycle with isolated Mongo and provider fakes', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `ft3_refund_${process.pid}_${Date.now().toString(36)}` });
    await CalendarReservation.createIndexes();
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await Promise.all([Booking.collection.deleteMany({}), User.collection.deleteMany({}),
      CalendarReservation.collection.deleteMany({}), Payment.collection.deleteMany({}), CancellationRequest.collection.deleteMany({}), AccountDataGuard.collection.deleteMany({})]);
    await User.collection.insertMany([
      { _id: proId, role: 'professional', name: 'Professional', email: 'pro@ft3.test' },
      { _id: customerId, role: 'customer', name: 'Customer', email: 'customer@ft3.test' },
      { _id: adminId, role: 'admin', name: 'Admin', email: 'admin@ft3.test' },
    ] as any[]);
    mocks.refundList.mockResolvedValue({ data: [], has_more: false });
    mocks.refund.mockResolvedValue({ id: 're_ft3_partial', status: 'succeeded', created: Math.floor(Date.now() / 1000) });
    mocks.credits.mockResolvedValue('generate');
    // Actual routing is exercised; actual PDF/UBL builders have their own
    // finance suites. These artifact writes never contact Odoo or S3.
    mocks.invoices.mockImplementation(async (id: string) => Booking.updateOne({ _id: id }, { $set: {
      'payment.invoiceNumber': 'FIX-FT3-TEST', 'payment.supplierInvoiceNumber': 'SUP-FT3-TEST',
    } }));
  });


  const seedRefund = async (status = 'in_progress', payment: Record<string, any> = {}) => {
    const id = new Types.ObjectId();
    const booking = { _id: id, bookingNumber: `BK-FT3-${id}`, bookingType: 'professional',
          professional: proId, customer: customerId, status,
          statusBeforeDispute: 'in_progress', scheduleTimeZone: 'UTC',
          location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
          vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, reverseCharge: false },
          rfqData: { serviceType: 'Plumbing', description: 'Partial refund regression fixture' },
          dispute: { type: 'refund_request', raisedAt: new Date(), raisedBy: customerId, reason: 'Cancelled after work began' },
          scheduledStartDate: utcDay(-2), scheduledExecutionEndDate: utcDay(3),
          assignedTeamMembers: [proId], resourcePlan: [{ resourceId: proId, days: [utcDay(-1), utcDay(1)] }], quote: { amount: 100, currency: 'EUR' },
          payment: { status: 'completed', stripePaymentIntentId: 'pi_ft3_partial', currency: 'EUR',
            amount: 100, netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121 } };

    Object.assign(booking.payment, payment);
    await Booking.collection.insertOne(booking as any);
    await replaceBookingCalendar(booking);
    return booking;
  };

  for (const path of ['direct', 'dispute', 'negotiated'] as const) {
    for (const hasPast of [true, false]) {
      it(`${path}: cancels a partial refund, keeps ${hasPast ? 'past days' : 'no phantom window'}, and issues both artifacts`, async () => {
        const id = new Types.ObjectId();
        const plan = [{ resourceId: proId, days: [...(hasPast ? [utcDay(-1)] : []), utcDay(1)] }];
        const booking = { _id: id, bookingNumber: `BK-FT3-${id}`, bookingType: 'professional',
          professional: proId, customer: customerId, status: path === 'dispute' ? 'dispute' : 'in_progress',
          statusBeforeDispute: 'in_progress', scheduleTimeZone: 'UTC',
          location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
          vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, reverseCharge: false },
          rfqData: { serviceType: 'Plumbing', description: 'Partial refund regression fixture' },
          dispute: { type: 'refund_request', raisedAt: new Date(), raisedBy: customerId, reason: 'Cancelled after work began' },
          scheduledStartDate: utcDay(-2), scheduledExecutionEndDate: utcDay(3),
          assignedTeamMembers: [proId], resourcePlan: plan, quote: { amount: 100, currency: 'EUR' },
          payment: { status: 'completed', stripePaymentIntentId: 'pi_ft3_partial', currency: 'EUR',
            amount: 100, netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121 } };
        await Booking.collection.insertOne(booking as any);
        await replaceBookingCalendar(booking);
        const res = response();
        if (path === 'direct') await refundPayment({ user: { _id: adminId }, body: { bookingId: String(id), amount: 50, reason: 'Partial cancellation' } } as any, res as any);
        else if (path === 'dispute') await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(id) },
          body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Partial cancellation' } } as any, res as any);
        else {
          await CancellationRequest.create({ booking: id, requestedBy: customerId, requestedRole: 'customer',
            status: 'negotiating', reason: 'Partial cancellation', counterOfferAmount: 50 });
          await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(id) },
            body: { decision: 'accept' } } as any, res as any);
        }
        expect(res.statusCode).toBe(200);
        expect(mocks.refund).toHaveBeenCalledWith(expect.objectContaining({ amount: 5000 }), expect.anything());
        await vi.waitFor(async () => {
          const current = await Booking.findById(id).lean();
          expect(current?.payment?.invoiceNumber).toBe('FIX-FT3-TEST');
          expect(current?.payment?.supplierInvoiceNumber).toBe('SUP-FT3-TEST');
        }, { timeout: 10000 });
        const current = await Booking.findById(id);
        expect(current?.status).toBe('cancelled');
        expect(current?.payment?.status).toBe('partially_refunded');
        expect(current?.resourcePlan?.[0]?.days.map(day => day.toISOString())).toEqual(hasPast ? [utcDay(-1).toISOString()] : []);
        if (path === 'dispute') expect(res.body.data.booking.status).toBe('cancelled');
        const initialReservations = await CalendarReservation.find({ sourceType: 'booking', sourceId: id }).lean();
        expect(initialReservations.length > 0).toBe(hasPast);
        expect(initialReservations.every((row: any) => new Date(row.startAt) < utcDay(0))).toBe(true);
        // A later save used to release the retained historical reservations.
        await current!.save();
        const reservations = await CalendarReservation.find({ sourceType: 'booking', sourceId: id }).lean();
        expect(reservations.length > 0).toBe(hasPast);
        expect(reservations.every((row: any) => new Date(row.startAt) < utcDay(0))).toBe(true);
        expect(mocks.credits).toHaveBeenCalledWith(String(id));
        const refunds = await Payment.findOne({ booking: id }).lean();
        expect(refunds?.refunds?.[0]?.amount).toBe(50);
      }, 30000);
    }
  }

  // FT3 #5: a started booking WITHOUT a resource plan used to be fully
  // released by a partial refund. The past part of its scheduled window must
  // stay blocked and visible for the assigned resources; future days free.
  it.each(['direct', 'dispute', 'negotiated', 'admin'] as const)('%s: retains the past window of a started booking without a resource plan', async path => {
    const booking = await seedRefund(path === 'dispute' ? 'dispute' : 'in_progress');
    await Booking.collection.updateOne({ _id: booking._id }, { $unset: { resourcePlan: '' } });
    const res = response();
    if (path === 'direct') await refundPayment({ user: { _id: adminId }, body: { bookingId: String(booking._id), amount: 50, reason: 'Partial cancellation' } } as any, res as any);
    else if (path === 'dispute') await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Partial cancellation' } } as any, res as any);
    else {
      const request = await CancellationRequest.create({ booking: booking._id, requestedBy: customerId, requestedRole: 'customer',
        status: path === 'admin' ? 'pending' : 'negotiating', reason: 'Partial cancellation', counterOfferAmount: 50 });
      if (path === 'admin') await approveCancellationRequest({ user: { _id: adminId }, params: { id: String(request._id) }, body: { amount: 50 } } as any, res as any);
      else await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(booking._id) }, body: { decision: 'accept' } } as any, res as any);
    }
    expect(res.statusCode).toBe(200);
    const pastDays = [utcDay(-2).toISOString(), utcDay(-1).toISOString()];
    await vi.waitFor(async () => {
      const current = await Booking.findById(booking._id).lean();
      expect(current?.status).toBe('cancelled');
      expect(current?.payment?.status).toBe('partially_refunded');
      expect(current?.refundPreservesPastPlanning).toBe(true);
      expect(current?.resourcePlan?.map((entry: any) => [String(entry.resourceId), entry.days.map((d: Date) => d.toISOString())]))
        .toEqual([[String(proId), pastDays]]);
      const reservations = await CalendarReservation.find({ sourceType: 'booking', sourceId: booking._id }).lean();
      expect(reservations.length).toBeGreaterThan(0);
      expect(reservations.every((row: any) => new Date(row.startAt) < utcDay(0) && new Date(row.startAt) >= utcDay(-2))).toBe(true);
    }, { timeout: 10000 });
    const { buildBookingBlockedRanges } = await import('../../utils/bookingBlocks');
    const ranges = (await buildBookingBlockedRanges(proId)).filter(range => range.bookingId === String(booking._id));
    expect(ranges.map(range => range.startDate)).toEqual(pastDays);
    expect(ranges.every(range => range.retainedAfterRefund === true && range.status === 'cancelled')).toBe(true);
  }, 30000);

  it('shows completed bookings only to display consumers and never past their actual end', async () => {
    const booking = await seedRefund('completed');
    await Booking.collection.updateOne({ _id: booking._id }, { $set: { actualEndDate: utcDay(-1), resourcePlan: [] } });
    const { buildBookingBlockedRanges } = await import('../../utils/bookingBlocks');
    const blocking = await buildBookingBlockedRanges(proId);
    expect(blocking.some(range => range.bookingId === String(booking._id))).toBe(false);
    const display = (await buildBookingBlockedRanges(proId, { includeCompleted: true }))
      .filter(range => range.bookingId === String(booking._id));
    expect(display).toEqual([expect.objectContaining({ status: 'completed', reason: 'booking',
      startDate: utcDay(-2).toISOString(), endDate: utcDay(-1).toISOString() })]);
  });

  it.each(['admin', 'dispute', 'negotiated'])('%s releases the calendar and skips partial invoices after a cumulative full refund', async path => {
    const booking = await seedRefund(path === 'dispute' ? 'dispute' : 'in_progress', { status: 'partially_refunded', refundAmount: 71 });
    const res = response();
    if (path === 'dispute') {
      await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(booking._id) },
        body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Final refund' } } as any, res as any);
    } else {
      const request = await CancellationRequest.create({ booking: booking._id, requestedBy: customerId,
        requestedRole: 'customer', status: path === 'admin' ? 'pending' : 'negotiating', reason: 'Final refund', counterOfferAmount: 50 });
      if (path === 'admin') await approveCancellationRequest({ user: { _id: adminId }, params: { id: String(request._id) }, body: { amount: 50 } } as any, res as any);
      else await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(booking._id) }, body: { decision: 'accept' } } as any, res as any);
    }
    expect(res.statusCode).toBe(200);
    const current = await Booking.findById(booking._id);
    expect(current?.payment).toMatchObject({ status: 'refunded', refundAmount: 121 });
    expect(await CalendarReservation.countDocuments({ sourceId: booking._id })).toBe(0);
    expect(mocks.credits).not.toHaveBeenCalled();
    expect(mocks.invoices).not.toHaveBeenCalled();
  });

  it.each(['completed', 'dispute', 'refunded'])('partial refund preserves %s status owned by another flow', async status => {
    const booking = await seedRefund(status);
    await executeRefund(String(booking._id), { amount: 50 });
    expect((await Booking.findById(booking._id))?.status).toBe(status);
  });

  it('records the persisted completed status in negotiated refund history', async () => {
    const booking = await seedRefund('completed');
    await CancellationRequest.create({ booking: booking._id, requestedBy: customerId, requestedRole: 'customer',
      status: 'negotiating', reason: 'After completion', counterOfferAmount: 50 });
    const res = response();
    await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(booking._id) }, body: { decision: 'accept' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    const current = await Booking.findById(booking._id);
    expect(current?.status).toBe('completed');
    expect(current?.statusHistory.at(-1)?.status).toBe('completed');
  });

  it('triggers partial refund invoices even if retention fails and the account is fenced', async () => {
    const booking = await seedRefund();
    await AccountDataGuard.create({ _id: customerId, state: 'anonymizing', startedAt: new Date() });
    vi.spyOn(refundFinalization, 'retainPastBookingCalendar').mockRejectedValueOnce(new Error('calendar unavailable'));
    await CancellationRequest.create({ booking: booking._id, requestedBy: customerId, requestedRole: 'customer',
      status: 'negotiating', reason: 'Partial refund', counterOfferAmount: 50 });
    const res = response();
    await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(booking._id) }, body: { decision: 'accept' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(mocks.credits).toHaveBeenCalledWith(String(booking._id));
  });


  it('persists busy-credit retries and drains them without generating another invoice', async () => {
    const booking = await seedRefund('cancelled', { status: 'partially_refunded', refundAmount: 50 });
    mocks.credits.mockResolvedValueOnce('busy');
    await refundFinalization.ensureRefundInvoices(String(booking._id));
    const queued = await Booking.collection.findOne({ _id: booking._id });
    expect(queued?.payment.refundInvoiceRetryAt).toBeInstanceOf(Date);
    expect(queued?.payment.refundInvoiceRetryAt.getTime()).toBeGreaterThan(Date.now() + 899000);
    expect(mocks.invoices).not.toHaveBeenCalled();
    await Booking.updateOne({ _id: booking._id }, { $set: { 'payment.refundInvoiceRetryAt': new Date(Date.now() - 1000) } });
    mocks.credits.mockResolvedValue('credited');
    await refundFinalization.retryPendingRefundInvoices();
    const drained = await Booking.collection.findOne({ _id: booking._id });
    expect(drained?.payment.refundInvoiceRetryAt).toBeUndefined();
    expect(mocks.credits).toHaveBeenCalledTimes(2);
    expect(mocks.invoices).not.toHaveBeenCalled();
  });

  it('keeps a legacy amount-only partial dispute billable with its past reservations', async () => {
    const booking = await seedRefund('dispute', { totalWithVat: null });
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Legacy partial' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(mocks.credits).toHaveBeenCalledWith(String(booking._id)));
    const reservations = await CalendarReservation.find({ sourceId: booking._id }).lean();
    expect(reservations.length).toBeGreaterThan(0);
    expect(reservations.every(row => row.startAt < utcDay(0))).toBe(true);
  });

  it.each(['refresh', 'cancellation'])('keeps a successful refund closed after %s persistence fails, and reconciles on retry', async failure => {
    const booking = await seedRefund('dispute');
    const originalUpdate = Booking.updateOne.bind(Booking);
    const originalRefresh = Booking.findOneAndUpdate.bind(Booking);
    if (failure === 'refresh') vi.spyOn(Booking, 'findOneAndUpdate').mockImplementation(((filter: any, ...args: any[]) => {
      if (filter['payment.status'] === 'partially_refunded') return Promise.reject(new Error('post-refund read failed'));
      return (originalRefresh as any)(filter, ...args);
    }) as any);
    else vi.spyOn(Booking, 'updateOne').mockImplementation(((filter: any, update: any, ...args: any[]) => {
      if (update.$set?.['cancellation.refundAmount']) return Promise.reject(new Error('post-refund write failed'));
      return (originalUpdate as any)(filter, update, ...args);
    }) as any);
    const req = { user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Partial refund' } };
    const first = response(); await resolveDispute(req as any, first as any);
    expect(first.statusCode).toBe(200); expect(first.body.success).toBe(true);
    const afterFailure = await Booking.findById(booking._id);
    expect(afterFailure?.dispute?.resolvedAt).toBeTruthy(); expect(afterFailure?.dispute?.refundPending).toBe(true);
    expect(afterFailure?.payment?.refundAmount).toBe(50);
    vi.restoreAllMocks();
    const retry = response(); await resolveDispute(req as any, retry as any);
    expect(retry.statusCode).toBe(200); expect(mocks.refund).toHaveBeenCalledOnce();
    const current = await Booking.findById(booking._id);
    expect(current?.payment?.refundAmount).toBe(50); expect(current?.dispute?.refundPending).toBeUndefined();
    expect((await Payment.findOne({ booking: booking._id }))?.refunds).toHaveLength(1);
  });

  it.each(['booking', 'ledger'])('does not reopen after Stripe succeeds but the %s refund record fails', async failure => {
    const booking = await seedRefund('dispute');
    if (failure === 'booking') vi.spyOn(Booking.prototype, 'save').mockRejectedValueOnce(new Error('booking unavailable'));
    else vi.spyOn(Payment, 'findOneAndUpdate').mockRejectedValueOnce(new Error('ledger unavailable'));
    const req = { user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Partial refund' } };
    const first = response(); await resolveDispute(req as any, first as any);
    expect(first.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
    expect((await Booking.findById(booking._id))?.dispute?.resolvedAt).toBeTruthy();
    const operationKey = mocks.refund.mock.calls[0][0].metadata.operationKey;
    mocks.refundList.mockResolvedValue({ data: [{ id: 're_ft3_partial', amount: 5000, status: 'succeeded',
      created: Math.floor(Date.now() / 1000), metadata: { operationKey } }], has_more: false });
    vi.restoreAllMocks();
    const retry = response(); await resolveDispute(req as any, retry as any);
    expect(retry.statusCode).toBe(200); expect(mocks.refund).toHaveBeenCalledOnce();
    expect((await Booking.findById(booking._id))?.payment?.refundAmount).toBe(50);
    expect((await Payment.findOne({ booking: booking._id }))?.refunds).toHaveLength(1);
  });

  it('reconciles a fully refunded booking after a ledger write failure', async () => {
    const booking = await seedRefund('dispute');
    vi.spyOn(Payment, 'findOneAndUpdate').mockRejectedValueOnce(new Error('ledger unavailable'));
    const req = { user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'accept_professional', resolution: 'Full refund' } };
    const first = response(); await resolveDispute(req as any, first as any);
    expect(first.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
    const operationKey = mocks.refund.mock.calls[0][0].metadata.operationKey;
    mocks.refundList.mockResolvedValue({ data: [{ id: 're_ft3_partial', amount: 12100, status: 'succeeded',
      created: Math.floor(Date.now() / 1000), metadata: { operationKey } }], has_more: false });
    vi.restoreAllMocks();
    const retry = response(); await resolveDispute(req as any, retry as any);
    expect(retry.statusCode).toBe(200); expect(mocks.refund).toHaveBeenCalledOnce();
    expect((await Booking.findById(booking._id))?.payment?.refundAmount).toBe(121);
    expect((await Payment.findOne({ booking: booking._id }))?.refunds).toHaveLength(1);
  });

  it('recognizes a recorded legacy dispute refund before issuing an operation-key refund', async () => {
    const reason = 'Dispute resolution (refund_request): Already paid';
    const booking = await seedRefund('dispute', { status: 'partially_refunded', refundAmount: 50, refundReason: reason });
    await Payment.collection.insertOne({ booking: booking._id, stripePaymentIntentId: 'pi_ft3_partial',
      refunds: [{ refundId: 're_legacy', amount: 50, reason, source: 'platform', status: 'succeeded', refundedAt: new Date() }] } as any);
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Retry with revised notes' } } as any, res as any);
    expect(res.statusCode).toBe(200); expect(mocks.refund).not.toHaveBeenCalled(); expect(mocks.refundList).not.toHaveBeenCalled();
    expect((await Booking.findById(booking._id))?.payment?.refundAmount).toBe(50);
  });

  it('walks provider refund cursors before resuming a missing local record', async () => {
    const booking = await seedRefund('dispute');
    const operationKey = `dispute-${booking._id}-${booking.dispute.raisedAt.getTime()}`;
    mocks.refundList.mockResolvedValueOnce({ data: [{ id: 're_other', metadata: {} }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: 're_existing', amount: 5000, status: 'succeeded',
        created: Math.floor(Date.now() / 1000), metadata: { operationKey } }], has_more: false });
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Recover' } } as any, res as any);
    expect(res.statusCode).toBe(200); expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.refundList.mock.calls[1][0].starting_after).toBe('re_other');
    expect((await Booking.findById(booking._id))?.payment?.refundAmount).toBe(50);
  });

  it('blocks ambiguous legacy dispute aggregates without issuing another refund', async () => {
    const booking = await seedRefund('dispute', { status: 'partially_refunded', refundAmount: 50,
      refundReason: 'Dispute resolution (refund_request): Previously accepted', refundedAt: new Date() });
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(booking._id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Retry' } } as any, res as any);
    expect(res.body.error.code).toBe('REFUND_RECONCILIATION_REQUIRED');
    expect(mocks.refund).not.toHaveBeenCalled(); expect(mocks.refundList).not.toHaveBeenCalled();
    expect((await Booking.findById(booking._id))?.dispute?.resolvedAt).toBeTruthy();
  });

});
