import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Final Touches Part 3 #7: only recorded booking disputes join the overview.
// Warranty and refund requests are separate queues; no dashboards are reset.
vi.mock('../../handlers/Stripe/payment', () => ({
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));
vi.mock('../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: vi.fn() }));
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import Booking from '../../models/booking';
import WarrantyClaim from '../../models/warrantyClaim';
import CancellationRequest from '../../models/cancellationRequest';
import { getDisputeAnalytics, getDisputes } from '../../handlers/Admin/disputeManagement';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9));
const recordedDispute = (day: number, extra: Record<string, unknown> = {}) => ({
  raisedBy: new Types.ObjectId(),
  reason: 'Extra costs too high',
  description: 'customer disagrees with the extra costs',
  raisedAt: at(day),
  type: 'extra_costs',
  ...extra,
});
// Legacy schema-default sub-document: timestamp and type, no actor/content.
const phantomDispute = { type: 'extra_costs', attachments: [], resolutionAttachments: [], raisedAt: at(1) };

const call = async (handler: typeof getDisputes, query: Record<string, string> = {}) => {
  let statusCode = 200;
  let body: any;
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(payload: unknown) { body = payload; return res; },
  };
  await handler({ query } as any, res);
  expect(statusCode).toBe(200);
  expect(body?.success).toBe(true);
  return body.data;
};

const list = (query: Record<string, string> = {}) => call(getDisputes, query);
const analytics = () => call(getDisputeAnalytics);

describeDb('admin dispute dashboard read models (disposable MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft3_queues_${process.pid}_${Date.now().toString(36)}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all([
      Booking.collection.deleteMany({}),
      WarrantyClaim.collection.deleteMany({}),
      CancellationRequest.collection.deleteMany({}),
    ]);
  });

  it('zero records: zero metrics, zero separate-queue counts and an empty list', async () => {
    const a = await analytics();
    expect(a).toMatchObject({ totalOpen: 0, totalResolved: 0, totalDisputes: 0 });
    expect(a.separateQueues).toMatchObject({ activeWarrantyClaims: 0, escalatedRefundRequests: 0 });

    for (const status of [undefined, 'open', 'resolved']) {
      const data = await list(status ? { status } : {});
      expect(data.disputes).toEqual([]);
      expect(data.externalDisputes).toEqual([]);
      expect(data.pagination).toMatchObject({ total: 0, pages: 0 });
    }
  });

  it('counts and lists one recorded dispute once; phantom and normal extra-cost completions stay out', async () => {
    const disputed = new Types.ObjectId();
    await Booking.collection.insertMany([
      { _id: disputed, bookingNumber: 'BK-DISPUTE', status: 'dispute', dispute: recordedDispute(20) },
      // Phantom defaults on an ordinary booking and on an inconsistent legacy row.
      { _id: new Types.ObjectId(), bookingNumber: 'BK-PHANTOM', status: 'booked', dispute: phantomDispute },
      { _id: new Types.ObjectId(), bookingNumber: 'BK-PHANTOM-D', status: 'dispute', dispute: phantomDispute },
      // Normal extra-cost completion: extra costs submitted, never disputed.
      {
        _id: new Types.ObjectId(),
        bookingNumber: 'BK-EXTRA',
        status: 'professional_completed',
        extraCosts: [{ type: 'other', name: 'Extra material', unit: 'piece', quantity: 1, unitPrice: 40, total: 40 }],
        extraCostTotal: 40,
        extraCostStatus: 'pending',
      },
      // Accepted extra costs, completed, no dispute.
      { _id: new Types.ObjectId(), bookingNumber: 'BK-EXTRA-DONE', status: 'completed', extraCostTotal: 25, extraCostStatus: 'accepted' },
    ] as any[]);

    const a = await analytics();
    expect(a).toMatchObject({ totalOpen: 1, totalResolved: 0, totalDisputes: 1 });

    for (const status of [undefined, 'open']) {
      const data = await list(status ? { status } : {});
      expect(data.disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-DISPUTE']);
      expect(data.pagination.total).toBe(1);
    }
    expect((await list({ status: 'resolved' })).disputes).toEqual([]);
  });

  it('warranty and refund work keeps its own rows, labels, links and counts without touching booking totals', async () => {
    const disputedBooking = new Types.ObjectId();
    const warrantyBooking = new Types.ObjectId();
    const refundBooking = new Types.ObjectId();
    await Booking.collection.insertMany([
      { _id: disputedBooking, bookingNumber: 'BK-DISPUTE', status: 'dispute', dispute: recordedDispute(20) },
      { _id: warrantyBooking, bookingNumber: 'BK-WARRANTY', status: 'completed' },
      { _id: refundBooking, bookingNumber: 'BK-REFUND', status: 'booked' },
    ] as any[]);
    const customer = new Types.ObjectId();
    const professional = new Types.ObjectId();
    await WarrantyClaim.collection.insertMany([
      { claimNumber: 'WC-OPEN', booking: warrantyBooking, customer, professional, status: 'open', reason: 'defect', description: 'tap leaks', openedAt: at(21) },
      { claimNumber: 'WC-ESC', booking: warrantyBooking, customer, professional, status: 'escalated', reason: 'defect', description: 'still leaks', openedAt: at(22) },
      // Finished warranty work is not active.
      { claimNumber: 'WC-CLOSED', booking: warrantyBooking, customer, professional, status: 'closed', reason: 'defect', description: 'fixed', openedAt: at(10) },
      { claimNumber: 'WC-RESOLVED', booking: warrantyBooking, customer, professional, status: 'resolved', reason: 'defect', description: 'fixed', openedAt: at(11) },
    ] as any[]);
    await CancellationRequest.collection.insertMany([
      { booking: refundBooking, requestedBy: customer, requestedRole: 'customer', status: 'escalated', reason: 'no show', createdAt: at(23), escalatedAt: at(23) },
      // Not escalated, or not a customer request: not dispute-page work.
      { booking: new Types.ObjectId(), requestedBy: customer, requestedRole: 'customer', status: 'pending', reason: 'changed mind', createdAt: at(12) },
      { booking: new Types.ObjectId(), requestedBy: professional, requestedRole: 'professional', status: 'escalated', reason: 'sick', createdAt: at(13) },
    ] as any[]);

    const a = await analytics();
    // Booking-dispute totals are unchanged by the other queues...
    expect(a).toMatchObject({ totalOpen: 1, totalResolved: 0, totalDisputes: 1 });
    // ...which are reported under their own names.
    expect(a.separateQueues).toEqual({
      activeWarrantyClaims: 2,
      escalatedRefundRequests: 1,
      warrantyClaimsHref: '/admin/warranty-claims',
      refundRequestsHref: '/admin/cancellation-requests?status=escalated',
    });

    for (const status of [undefined, 'open']) {
      const data = await list(status ? { status } : {});
      expect(data.disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-DISPUTE']);
      expect(data.pagination).toMatchObject({ total: 1, pages: 1 });

      const external = data.externalDisputes;
      expect(external).toHaveLength(3);
      const warranty = external.filter((row: any) => row.source === 'warranty');
      const refund = external.filter((row: any) => row.source === 'refund');
      expect(warranty.map((row: any) => row.claimNumber).sort()).toEqual(['WC-ESC', 'WC-OPEN']);
      for (const row of warranty) {
        expect(row).toMatchObject({ readOnly: true, resolveHref: '/admin/warranty-claims', bookingId: String(warrantyBooking) });
        expect(row._id).toMatch(/^warranty:/);
        expect(row.dispute.type).toBe('warranty_claim');
      }
      expect(refund).toHaveLength(1);
      expect(refund[0]).toMatchObject({
        readOnly: true,
        resolveHref: '/admin/cancellation-requests?status=escalated',
        bookingId: String(refundBooking),
        bookingNumber: 'BK-REFUND',
      });
      expect(refund[0]._id).toMatch(/^refund:/);
      expect(refund[0].dispute.type).toBe('refund_request');
      // No external row is inside the booking-dispute list.
      expect(data.disputes.some((d: any) => d.source)).toBe(false);
    }

    // Resolved history is booking-dispute history only.
    const resolved = await list({ status: 'resolved' });
    expect(resolved.externalDisputes).toEqual([]);
  });

  it('pagination counts booking disputes only; the separate preview is on page 1 and never shifts pages', async () => {
    const warrantyBooking = new Types.ObjectId();
    await Booking.collection.insertMany([
      { _id: new Types.ObjectId(), bookingNumber: 'BK-D1', status: 'dispute', dispute: recordedDispute(20) },
      { _id: new Types.ObjectId(), bookingNumber: 'BK-D2', status: 'dispute', dispute: recordedDispute(19) },
      { _id: new Types.ObjectId(), bookingNumber: 'BK-D3', status: 'dispute', dispute: recordedDispute(18) },
      { _id: warrantyBooking, bookingNumber: 'BK-W', status: 'completed' },
    ] as any[]);
    await WarrantyClaim.collection.insertOne({
      claimNumber: 'WC-1', booking: warrantyBooking, customer: new Types.ObjectId(), professional: new Types.ObjectId(),
      status: 'open', reason: 'defect', description: 'd', openedAt: at(21),
    } as any);

    const page1 = await list({ page: '1', limit: '2' });
    const page2 = await list({ page: '2', limit: '2' });
    expect(page1.pagination).toMatchObject({ page: 1, total: 3, pages: 2 });
    expect(page2.pagination).toMatchObject({ page: 2, total: 3, pages: 2 });
    expect(page1.disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-D1', 'BK-D2']);
    expect(page2.disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-D3']);
    expect(page1.externalDisputes.map((row: any) => row.claimNumber)).toEqual(['WC-1']);
    expect(page2.externalDisputes).toEqual([]);

    const a = await analytics();
    expect(a.totalDisputes).toBe(3);
    expect(a.separateQueues.activeWarrantyClaims).toBe(1);
  });

  it('resolved history is available only through the resolved view', async () => {
    await Booking.collection.insertMany([
      { _id: new Types.ObjectId(), bookingNumber: 'BK-OPEN', status: 'dispute', dispute: recordedDispute(20) },
      // Settled dispute: booking moved on to completed, history kept.
      { _id: new Types.ObjectId(), bookingNumber: 'BK-SETTLED', status: 'completed', dispute: recordedDispute(5, { resolvedAt: at(6), resolution: 'adjusted' }) },
    ] as any[]);

    const a = await analytics();
    expect(a).toMatchObject({ totalOpen: 1, totalResolved: 1, totalDisputes: 1 });
    expect((await list()).disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-OPEN']);
    expect((await list({ status: 'open' })).disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-OPEN']);
    const resolved = await list({ status: 'resolved' });
    expect(resolved.disputes.map((d: any) => d.bookingNumber)).toEqual(['BK-SETTLED']);
    expect(resolved.pagination.total).toBe(a.totalResolved);
  });
});
