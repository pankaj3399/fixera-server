import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Integration of feat/final-touches-4's admin dispute overview rule (only
// bookings in 'dispute' status, client bug #7) with the Booking Page phantom
// activity fix (only disputes with recorded actor evidence). Both must hold.
vi.mock('../../handlers/Stripe/payment', () => ({
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));
vi.mock('../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: vi.fn() }));
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import Booking from '../../models/booking';
import { buildDisputeFilter } from '../../handlers/Admin/disputeManagement';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const at = new Date('2026-10-20T09:00:00.000Z');
const recordedDispute = (extra: Record<string, unknown> = {}) => ({
  raisedBy: new Types.ObjectId(),
  reason: 'Extra costs too high',
  description: 'd',
  raisedAt: at,
  type: 'extra_costs',
  ...extra,
});
// Legacy schema-default sub-document: timestamp and type but no actor/content.
const phantomDispute = { type: 'extra_costs', attachments: [], resolutionAttachments: [], raisedAt: at };

describe('buildDisputeFilter keeps both rules', () => {
  it('default and open views require dispute status and a recorded raiser', () => {
    for (const view of [undefined, 'open']) {
      const filter = buildDisputeFilter(view) as Record<string, unknown>;
      expect(filter.status).toBe('dispute');
      expect(filter['dispute.raisedAt']).toEqual({ $exists: true });
      expect(filter['dispute.raisedBy']).toEqual({ $exists: true, $ne: null });
    }
    expect((buildDisputeFilter('open') as any)['dispute.resolvedAt']).toBeNull();
  });

  it('resolved view keeps settled history but still requires recorded evidence', () => {
    const filter = buildDisputeFilter('resolved') as Record<string, unknown>;
    expect(filter.status).toBeUndefined();
    expect(filter['dispute.raisedBy']).toEqual({ $exists: true, $ne: null });
    expect(filter['dispute.resolvedAt']).toEqual({ $ne: null });
  });
});

describeDb('admin dispute overview query (disposable MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft3_overview_${process.pid}_${Date.now().toString(36)}` });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Booking.collection.deleteMany({});
  });

  it('lists only recorded disputes of bookings in dispute status', async () => {
    const open = new Types.ObjectId();
    const resolvedStillInDispute = new Types.ObjectId();
    const settled = new Types.ObjectId();
    await Booking.collection.insertMany([
      { _id: open, status: 'dispute', dispute: recordedDispute() },
      { _id: resolvedStillInDispute, status: 'dispute', dispute: recordedDispute({ resolvedAt: at }) },
      // Normal extra-cost completion that was resolved: not in the overview.
      { _id: settled, status: 'completed', dispute: recordedDispute({ resolvedAt: at }) },
      // Phantom dispute on a booking in dispute status (inconsistent legacy row).
      { _id: new Types.ObjectId(), status: 'dispute', dispute: phantomDispute },
      // Phantom dispute on an ordinary booking.
      { _id: new Types.ObjectId(), status: 'booked', dispute: phantomDispute },
      { _id: new Types.ObjectId(), status: 'professional_completed' },
    ] as any[]);

    const ids = async (view?: string) =>
      (await Booking.find(buildDisputeFilter(view)).select('_id').lean())
        .map((row) => String(row._id))
        .sort();

    expect(await ids()).toEqual([String(open), String(resolvedStillInDispute)].sort());
    expect(await ids('open')).toEqual([String(open)]);
    expect(await ids('resolved')).toEqual([String(resolvedStillInDispute), String(settled)].sort());
  });
});
