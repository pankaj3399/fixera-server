import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Real-Mongo coverage for dashboard list filters whose correctness depends
 * on the database query itself: the warranty-claim service and
 * booking-number filters (joined and paginated server-side) and the
 * professional payments "completed" filter (settled transfers only). Rows
 * are inserted raw so each case controls exactly the stored shape.
 */

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

import WarrantyClaim from '../../models/warrantyClaim';
import Booking from '../../models/booking';
import Project from '../../models/project';
import Payment from '../../models/payment';
import User from '../../models/user';
import { listMyWarrantyClaims } from '../../handlers/WarrantyClaim';
import { getPaymentStats, getTransactions } from '../../handlers/Professional/payments';
import { getMyPayments } from '../../handlers/Booking';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res as Response & { statusCode: number; body: any };
};

const PRO = new Types.ObjectId();
const OTHER_PRO = new Types.ObjectId();
const CUSTOMER = new Types.ObjectId();
const OTHER_CUSTOMER = new Types.ObjectId();

const claimsRequest = (user: { _id: Types.ObjectId; role: string }, query: Record<string, string>) =>
  ({ user: { _id: user._id.toHexString(), role: user.role }, query }) as unknown as Request;

describeDb('dashboard list filters (real Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: 'fixera_dashboard_list_filters_test' });
    // Let the background index builds finish first, so none of them
    // recreates a collection after the final drop.
    await Promise.all([WarrantyClaim, Booking, Project, Payment, User].map((model) => model.init()));
    await mongoose.connection.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  describe('warranty claims: service filter and booking-number search', () => {
    const ids = {
      projMutated: new Types.ObjectId(),
      projLegacy: new Types.ObjectId(),
      projCleaning: new Types.ObjectId(),
      projOther: new Types.ObjectId(),
      bSnapshot: new Types.ObjectId(),
      bLegacy: new Types.ObjectId(),
      bCleaning: new Types.ObjectId(),
      bRfq: new Types.ObjectId(),
      bOwnedProjectOnly: new Types.ObjectId(),
      bOutOfScope: new Types.ObjectId(),
      bOtherPro: new Types.ObjectId(),
    };
    let claimSeq = 0;
    const base = new Date('2026-10-01T00:00:00.000Z').getTime();
    const claim = (booking: Types.ObjectId, overrides: Record<string, unknown> = {}) => {
      claimSeq += 1;
      return {
        _id: new Types.ObjectId(),
        claimNumber: `WC-2026-${String(claimSeq).padStart(6, '0')}`,
        booking,
        customer: CUSTOMER,
        professional: PRO,
        status: 'open',
        reason: 'defect',
        description: 'Leaking joint after the repair',
        evidence: [],
        createdAt: new Date(base + claimSeq * 60_000),
        updatedAt: new Date(base + claimSeq * 60_000),
        ...overrides,
      };
    };

    beforeEach(async () => {
      claimSeq = 0;
      await Promise.all([
        WarrantyClaim.collection.deleteMany({}),
        Booking.collection.deleteMany({}),
        Project.collection.deleteMany({}),
        User.collection.deleteMany({}),
      ]);
      await User.collection.insertMany([
        { _id: PRO, name: 'Pro', email: 'pro@example.test', role: 'professional' },
        { _id: OTHER_PRO, name: 'Other pro', email: 'other-pro@example.test', role: 'professional' },
        { _id: CUSTOMER, name: 'Customer', email: 'customer@example.test', role: 'customer' },
        { _id: OTHER_CUSTOMER, name: 'Other customer', email: 'other@example.test', role: 'customer' },
      ]);
      await Project.collection.insertMany([
        // Live service was edited after booking: Plumbing -> Painting.
        { _id: ids.projMutated, professionalId: String(PRO), service: 'Painting', title: 'Mutated' },
        { _id: ids.projLegacy, professionalId: String(PRO), service: 'Plumbing', title: 'Legacy' },
        { _id: ids.projCleaning, professionalId: String(PRO), service: 'Cleaning', title: 'Cleaning' },
        { _id: ids.projOther, professionalId: String(OTHER_PRO), service: 'Plumbing', title: 'Other' },
      ]);
      await Booking.collection.insertMany([
        {
          _id: ids.bSnapshot, bookingNumber: 'BK-2026-000101', customer: CUSTOMER, professional: PRO,
          project: ids.projMutated, bookingSnapshot: { project: { service: 'Plumbing' } },
        },
        // Legacy booking without a snapshot: only the live project service is known.
        { _id: ids.bLegacy, bookingNumber: 'BK-2026-000102', customer: CUSTOMER, professional: PRO, project: ids.projLegacy },
        {
          _id: ids.bCleaning, bookingNumber: 'BK-2026-000103', customer: CUSTOMER, professional: PRO,
          project: ids.projCleaning, bookingSnapshot: { project: { service: 'Cleaning' } },
        },
        { _id: ids.bRfq, bookingNumber: 'BK-2026-000104', customer: CUSTOMER, professional: PRO, rfqData: { serviceType: 'Plumbing' } },
        // Booking that identifies the professional only through an owned project.
        { _id: ids.bOwnedProjectOnly, bookingNumber: 'BK-2026-000105', customer: CUSTOMER, project: ids.projLegacy },
        // Inconsistent row: the claim names PRO but the booking is outside PRO's booking scope.
        { _id: ids.bOutOfScope, bookingNumber: 'BK-2026-000106', customer: OTHER_CUSTOMER, professional: OTHER_PRO, project: ids.projOther },
        {
          _id: ids.bOtherPro, bookingNumber: 'BK-2026-000107', customer: OTHER_CUSTOMER, professional: OTHER_PRO,
          project: ids.projOther, bookingSnapshot: { project: { service: 'Plumbing' } },
        },
      ]);
    });

    it('filters by the captured booking service and paginates in the database', async () => {
      const rows = [
        claim(ids.bSnapshot),
        claim(ids.bCleaning),
        claim(ids.bRfq, { status: 'resolved' }),
        ...Array.from({ length: 12 }, () => claim(ids.bLegacy)),
        claim(ids.bOtherPro, { customer: OTHER_CUSTOMER, professional: OTHER_PRO }),
      ];
      await WarrantyClaim.collection.insertMany(rows);
      const distinctSpy = vi.spyOn(WarrantyClaim, 'distinct');
      const bookingFindSpy = vi.spyOn(Booking, 'find');
      const projectFindSpy = vi.spyOn(Project, 'find');
      try {
        const page1 = response();
        await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, { service: 'Plumbing', limit: '10' }), page1);
        expect(page1.statusCode).toBe(200);
        // Snapshot (1) + legacy live project (12) + RFQ service (1); not Cleaning, not the other pro.
        expect(page1.body.data.pagination).toEqual({ total: 14, page: 1, limit: 10, totalPages: 2 });
        expect(page1.body.data.claims).toHaveLength(10);

        const page2 = response();
        await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, { service: 'Plumbing', limit: '10', page: '2' }), page2);
        expect(page2.body.data.pagination.total).toBe(14);
        const allNumbers = [...page1.body.data.claims, ...page2.body.data.claims].map((c: any) => c.claimNumber);
        expect(new Set(allNumbers).size).toBe(14);
        // Newest first across pages, populated like the plain list.
        expect(allNumbers).toEqual([...allNumbers].sort().reverse());
        expect(page2.body.data.claims.at(-1).claimNumber).toBe(rows[0].claimNumber);
        expect(page2.body.data.claims.at(-1).booking.bookingNumber).toBe('BK-2026-000101');
        expect(page2.body.data.claims.at(-1).customer.name).toBe('Customer');

        // The live project now says Painting, but the booking captured Plumbing.
        const painting = response();
        await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, { service: 'Painting' }), painting);
        expect(painting.body.data.pagination.total).toBe(0);

        const resolvedPlumbing = response();
        await listMyWarrantyClaims(
          claimsRequest({ _id: PRO, role: 'professional' }, { service: 'Plumbing', status: 'resolved' }),
          resolvedPlumbing,
        );
        expect(resolvedPlumbing.body.data.claims.map((c: any) => c.claimNumber)).toEqual([rows[2].claimNumber]);

        const forBooking = response();
        await listMyWarrantyClaims(
          claimsRequest({ _id: CUSTOMER, role: 'customer' }, { service: 'Cleaning', bookingId: ids.bCleaning.toHexString() }),
          forBooking,
        );
        expect(forBooking.body.data.claims.map((c: any) => c.claimNumber)).toEqual([rows[1].claimNumber]);

        // No candidate id lists are built in the handler: the only booking
        // reads are the populate of one page of claims.
        expect(distinctSpy).not.toHaveBeenCalled();
        expect(projectFindSpy).not.toHaveBeenCalled();
        for (const [filter] of bookingFindSpy.mock.calls as any[]) {
          expect(Object.keys(filter)).toEqual(['_id']);
          expect(filter._id.$in.length).toBeLessThanOrEqual(10);
        }
      } finally {
        distinctSpy.mockRestore();
        bookingFindSpy.mockRestore();
        projectFindSpy.mockRestore();
      }
    });

    it('returns status and service counts for the claim filters (FT2 #10a)', async () => {
      await WarrantyClaim.collection.insertMany([
        claim(ids.bSnapshot),
        claim(ids.bCleaning),
        claim(ids.bRfq, { status: 'resolved' }),
        claim(ids.bLegacy),
        claim(ids.bLegacy, { status: 'escalated' }),
        claim(ids.bOtherPro, { customer: OTHER_CUSTOMER, professional: OTHER_PRO }),
      ]);
      const list = async (query: Record<string, string>) => {
        const res = response();
        await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, query), res);
        expect(res.statusCode).toBe(200);
        return res.body.data;
      };
      const all = await list({});
      // Snapshot service wins over the edited live project (Painting).
      expect(all.serviceCounts).toEqual({ Plumbing: 4, Cleaning: 1 });
      expect(all.statusCounts).toEqual({ open: 3, resolved: 1, escalated: 1 });
      // Each facet honours the other selection, and its counts match the list.
      const plumbing = await list({ service: 'Plumbing' });
      expect(plumbing.statusCounts).toEqual({ open: 2, resolved: 1, escalated: 1 });
      const open = await list({ status: 'open' });
      expect(open.serviceCounts).toEqual({ Plumbing: 2, Cleaning: 1 });
      for (const [service, count] of Object.entries(open.serviceCounts as Record<string, number>)) {
        expect((await list({ status: 'open', service })).pagination.total).toBe(count);
      }
    });

    it('keeps the role scope for the service filter', async () => {
      await WarrantyClaim.collection.insertMany([
        claim(ids.bSnapshot),
        claim(ids.bOtherPro, { customer: OTHER_CUSTOMER, professional: OTHER_PRO }),
      ]);
      const otherCustomer = response();
      await listMyWarrantyClaims(claimsRequest({ _id: OTHER_CUSTOMER, role: 'customer' }, { service: 'Plumbing' }), otherCustomer);
      expect(otherCustomer.body.data.claims.map((c: any) => String(c.booking._id))).toEqual([ids.bOtherPro.toHexString()]);
      const otherPro = response();
      await listMyWarrantyClaims(claimsRequest({ _id: OTHER_PRO, role: 'professional' }, { service: 'Plumbing' }), otherPro);
      expect(otherPro.body.data.pagination.total).toBe(1);
    });

    it('rejects non-participant roles before any claim query, even with stored claims', async () => {
      await WarrantyClaim.collection.insertMany([
        claim(ids.bSnapshot),
        claim(ids.bOtherPro, { customer: OTHER_CUSTOMER, professional: OTHER_PRO }),
      ]);
      const findSpy = vi.spyOn(WarrantyClaim, 'find');
      const countSpy = vi.spyOn(WarrantyClaim, 'countDocuments');
      const aggregateSpy = vi.spyOn(WarrantyClaim, 'aggregate');
      try {
        for (const role of ['admin', 'employee', 'visitor', 'unknown-role']) {
          for (const query of [{}, { service: 'Plumbing' }, { q: 'BK-2026' }]) {
            const res = response();
            await listMyWarrantyClaims(claimsRequest({ _id: new Types.ObjectId(), role }, query), res);
            expect(res.statusCode).toBe(403);
            expect(res.body.data).toBeUndefined();
          }
        }
        expect(findSpy).not.toHaveBeenCalled();
        expect(countSpy).not.toHaveBeenCalled();
        expect(aggregateSpy).not.toHaveBeenCalled();
      } finally {
        findSpy.mockRestore();
        countSpy.mockRestore();
        aggregateSpy.mockRestore();
      }
      // Participants still see exactly their own claim (plain path).
      const own = response();
      await listMyWarrantyClaims(claimsRequest({ _id: CUSTOMER, role: 'customer' }, {}), own);
      expect(own.body.data.claims.map((c: any) => String(c.booking._id))).toEqual([ids.bSnapshot.toHexString()]);
      const ownPro = response();
      await listMyWarrantyClaims(claimsRequest({ _id: OTHER_PRO, role: 'professional' }, {}), ownPro);
      expect(ownPro.body.data.claims.map((c: any) => String(c.booking._id))).toEqual([ids.bOtherPro.toHexString()]);
    });

    it('resolves booking-number text through the viewer booking scope, with escaped literal matching', async () => {
      const rows = [
        claim(ids.bSnapshot),
        claim(ids.bOwnedProjectOnly),
        claim(ids.bOutOfScope),
        claim(ids.bOtherPro, { customer: OTHER_CUSTOMER, professional: OTHER_PRO }),
      ];
      await WarrantyClaim.collection.insertMany(rows);

      const pro = response();
      await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, { q: 'BK-2026-0001' }), pro);
      // Own booking plus the booking of an owned project; the out-of-scope booking stays hidden.
      expect(pro.body.data.claims.map((c: any) => c.claimNumber).sort()).toEqual([rows[0].claimNumber, rows[1].claimNumber]);
      expect(pro.body.data.pagination.total).toBe(2);

      const customer = response();
      await listMyWarrantyClaims(claimsRequest({ _id: CUSTOMER, role: 'customer' }, { q: '000105' }), customer);
      expect(customer.body.data.claims.map((c: any) => c.claimNumber)).toEqual([rows[1].claimNumber]);

      // Another customer's search text never reaches someone else's claims.
      const other = response();
      await listMyWarrantyClaims(claimsRequest({ _id: OTHER_CUSTOMER, role: 'customer' }, { q: '000101' }), other);
      expect(other.body.data.pagination.total).toBe(0);

      // Regex metacharacters are literal.
      const literal = response();
      await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, { q: 'BK-2026-.*' }), literal);
      expect(literal.body.data.pagination.total).toBe(0);

      // Claim-number text still matches, combined with service.
      const byClaimNumber = response();
      await listMyWarrantyClaims(
        claimsRequest({ _id: PRO, role: 'professional' }, { q: rows[0].claimNumber, service: 'Plumbing' }),
        byClaimNumber,
      );
      expect(byClaimNumber.body.data.claims.map((c: any) => c.claimNumber)).toEqual([rows[0].claimNumber]);

      // Exact booking id stays an id lookup inside the role scope.
      const byId = response();
      await listMyWarrantyClaims(claimsRequest({ _id: PRO, role: 'professional' }, { q: ids.bOwnedProjectOnly.toHexString() }), byId);
      expect(byId.body.data.claims.map((c: any) => c.claimNumber)).toEqual([rows[1].claimNumber]);
    });
  });

  describe('professional payments: completed filter', () => {
    beforeEach(async () => {
      await Promise.all([
        Payment.collection.deleteMany({}),
        Booking.collection.deleteMany({}),
        Project.collection.deleteMany({}),
      ]);
      const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 0, minutes));
      const row = (bookingNumber: string, minutes: number, fields: Record<string, unknown>) => ({
        _id: new Types.ObjectId(),
        professional: PRO,
        booking: new Types.ObjectId(),
        bookingNumber,
        currency: 'EUR',
        professionalPayout: 100,
        createdAt: at(minutes),
        ...fields,
      });
      await Payment.collection.insertMany([
        row('BK-SETTLED', 1, { status: 'completed', transferStatus: 'succeeded', stripeTransferId: 'tr_1', transferredAt: at(2) }),
        row('BK-LEGACY-SETTLED', 2, { status: 'completed', stripeTransferId: 'tr_2', transferredAt: at(3) }),
        row('BK-PENDING', 3, { status: 'completed', transferStatus: 'pending' }),
        row('BK-FAILED', 4, { status: 'completed', transferStatus: 'failed' }),
        row('BK-LEGACY-FAILED', 5, { status: 'completed', metadata: { transferFailed: true } }),
        row('BK-LEGACY-NONE', 6, { status: 'completed' }),
        row('BK-AUTHORIZED', 7, { status: 'authorized' }),
        row('BK-OTHER-PRO', 8, { status: 'completed', transferStatus: 'succeeded', professional: OTHER_PRO }),
      ]);
    });

    const transactions = async (query: Record<string, string>) => {
      const res = response();
      await getTransactions({ user: { _id: PRO }, query } as unknown as Request, res);
      expect(res.statusCode).toBe(200);
      return res.body;
    };

    it('counts distinct booking lifecycles, including unpaid and project-owned bookings', async () => {
      const projectId = new Types.ObjectId();
      const completedId = new Types.ObjectId();
      await Project.collection.insertOne({ _id: projectId, professionalId: PRO });
      await Booking.collection.insertMany([
        { _id: completedId, professional: PRO, status: 'completed', quote: { currency: 'EUR' } },
        { _id: new Types.ObjectId(), professional: PRO, status: 'payment_pending', quote: { currency: 'EUR' } },
        { _id: new Types.ObjectId(), project: projectId, status: 'booked', quote: { currency: 'EUR' } },
        { _id: new Types.ObjectId(), professional: PRO, status: 'quoted', quote: { currency: 'EUR' } },
        { _id: new Types.ObjectId(), professional: OTHER_PRO, status: 'completed' },
      ]);
      await Payment.collection.insertMany([1, 2].map(n => ({ _id: new Types.ObjectId(), booking: completedId, professional: PRO, status: 'completed', transferStatus: 'succeeded', professionalPayout: 25, currency: 'EUR' })));
      const res = response();
      await getPaymentStats({ user: { _id: PRO } } as any, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.completedBookings).toBe(1);
      expect(res.body.data.pendingBookings).toBe(2);
    }, 30000);

    it('returns only settled transfers for "completed", matching the stats bucket and row labels', async () => {
      const completed = await transactions({ status: 'completed' });
      expect(completed.data.map((r: any) => r.bookingNumber).sort()).toEqual(['BK-LEGACY-SETTLED', 'BK-SETTLED']);
      expect(completed.data.every((r: any) => r.status === 'completed')).toBe(true);
      expect(completed.pagination.total).toBe(2);

      const statsRes = response();
      await getPaymentStats({ user: { _id: PRO } } as unknown as Request, statsRes);
      expect(statsRes.body.data.totalEarnings).toBe(200);
      // No Booking records were inserted: transaction counts are not booking counts.
      expect(statsRes.body.data.completedBookings).toBe(0);

      const pending = await transactions({ status: 'transfer_pending' });
      expect(pending.data.map((r: any) => r.bookingNumber).sort()).toEqual(['BK-LEGACY-NONE', 'BK-PENDING']);
      expect(pending.data.every((r: any) => r.status === 'transfer_pending')).toBe(true);
      const failed = await transactions({ status: 'transfer_failed' });
      expect(failed.data.map((r: any) => r.bookingNumber).sort()).toEqual(['BK-FAILED', 'BK-LEGACY-FAILED']);
      const authorized = await transactions({ status: 'authorized' });
      expect(authorized.data.map((r: any) => r.bookingNumber)).toEqual(['BK-AUTHORIZED']);

      // The completed filter composes with search and stays owner-scoped.
      const searched = await transactions({ status: 'completed', q: 'LEGACY' });
      expect(searched.data.map((r: any) => r.bookingNumber)).toEqual(['BK-LEGACY-SETTLED']);
      const all = await transactions({ status: 'all' });
      expect(all.pagination.total).toBe(7);
    });

    it('resolves a booking-only number for a project-owned booking without Booking.professional', async () => {
      const ownedProject = new Types.ObjectId();
      const otherProject = new Types.ObjectId();
      const projectBooking = new Types.ObjectId();
      const otherProjectBooking = new Types.ObjectId();
      await Project.collection.insertMany([
        // Stored as the schema's ObjectId type.
        { _id: ownedProject, professionalId: PRO, title: 'Owned' },
        { _id: otherProject, professionalId: OTHER_PRO, title: 'Other' },
      ]);
      // Project bookings may carry no Booking.professional; the owner is the project's.
      await Booking.collection.insertMany([
        { _id: projectBooking, bookingNumber: 'BK-PROJ-000201', bookingType: 'project', customer: CUSTOMER, project: ownedProject },
        { _id: otherProjectBooking, bookingNumber: 'BK-PROJ-000202', bookingType: 'project', customer: CUSTOMER, project: otherProject },
      ]);
      // Payment rows without their own bookingNumber (the field is optional).
      await Payment.collection.insertMany([
        { _id: new Types.ObjectId(), professional: PRO, booking: projectBooking, status: 'authorized', currency: 'EUR', professionalPayout: 50, createdAt: new Date() },
        // A row mislinked to another pro's project booking stays invisible to its number.
        { _id: new Types.ObjectId(), professional: PRO, booking: otherProjectBooking, status: 'authorized', currency: 'EUR', professionalPayout: 60, createdAt: new Date() },
      ]);

      const found = await transactions({ q: 'proj-000201' });
      expect(found.pagination.total).toBe(1);
      expect(found.data).toHaveLength(1);
      expect(found.data[0]).toMatchObject({ bookingNumber: 'BK-PROJ-000201', amount: 50 });
      expect(String(found.data[0].bookingId)).toBe(String(projectBooking));

      // Another professional's project booking number never resolves for PRO.
      const foreign = await transactions({ q: 'BK-PROJ-000202' });
      expect(foreign.pagination.total).toBe(0);
      // Search still composes with the status filter.
      expect((await transactions({ q: 'BK-PROJ-000201', status: 'completed' })).pagination.total).toBe(0);
    });
  });

  describe('payment lists: facet counts and the professional service filter (FT2 #10a/#10b)', () => {
    const projPlumbing = new Types.ObjectId();
    const projPainting = new Types.ObjectId();
    const projOther = new Types.ObjectId();
    const bPlumbing1 = new Types.ObjectId();
    const bPlumbing2 = new Types.ObjectId();
    const bPainting = new Types.ObjectId();
    const bRfqTiling = new Types.ObjectId();
    const bOther = new Types.ObjectId();

    beforeEach(async () => {
      await Promise.all([Booking, Project, Payment, User].map((model) => model.collection.deleteMany({})));
      await User.collection.insertMany([
        { _id: PRO, name: 'Pro', email: 'pro@example.test', role: 'professional' },
        { _id: OTHER_PRO, name: 'Other pro', email: 'other-pro@example.test', role: 'professional' },
        { _id: CUSTOMER, name: 'Customer', email: 'customer@example.test', role: 'customer' },
      ]);
      await Project.collection.insertMany([
        { _id: projPlumbing, professionalId: PRO, service: 'Plumbing', title: 'Plumbing' },
        { _id: projPainting, professionalId: PRO, service: 'Painting', title: 'Painting' },
        { _id: projOther, professionalId: OTHER_PRO, service: 'Plumbing', title: 'Other' },
      ]);
      await Booking.collection.insertMany([
        { _id: bPlumbing1, bookingNumber: 'BK-F-1', customer: CUSTOMER, project: projPlumbing },
        { _id: bPlumbing2, bookingNumber: 'BK-F-2', customer: CUSTOMER, project: projPlumbing },
        { _id: bPainting, bookingNumber: 'BK-F-3', customer: CUSTOMER, project: projPainting },
        { _id: bRfqTiling, bookingNumber: 'BK-F-4', customer: CUSTOMER, professional: PRO, rfqData: { serviceType: 'Tiling' } },
        { _id: bOther, bookingNumber: 'BK-F-5', customer: CUSTOMER, professional: OTHER_PRO, project: projOther },
      ]);
      const pay = (booking: Types.ObjectId, professional: Types.ObjectId, fields: Record<string, unknown>) => ({
        _id: new Types.ObjectId(), booking, customer: CUSTOMER, professional, currency: 'EUR',
        professionalPayout: 100, totalWithVat: 121, createdAt: new Date(), ...fields,
      });
      await Payment.collection.insertMany([
        pay(bPlumbing1, PRO, { status: 'completed', transferStatus: 'succeeded', stripeTransferId: 'tr_a', transferredAt: new Date() }),
        pay(bPlumbing2, PRO, { status: 'completed', transferStatus: 'pending' }),
        pay(bPainting, PRO, { status: 'authorized' }),
        pay(bRfqTiling, PRO, { status: 'refunded' }),
        pay(bOther, OTHER_PRO, { status: 'completed', transferStatus: 'succeeded', stripeTransferId: 'tr_b' }),
      ]);
    });

    const proList = async (query: Record<string, string>) => {
      const res = response();
      await getTransactions({ user: { _id: PRO }, query } as unknown as Request, res);
      expect(res.statusCode).toBe(200);
      return res.body;
    };

    it('filters professional payouts by service through the booking, own scope only', async () => {
      const plumbing = await proList({ service: 'Plumbing' });
      expect(plumbing.data.map((r: any) => r.bookingNumber).sort()).toEqual(['BK-F-1', 'BK-F-2']);
      expect(plumbing.pagination.total).toBe(2);
      const tiling = await proList({ service: 'Tiling' });
      expect(tiling.data.map((r: any) => r.bookingNumber)).toEqual(['BK-F-4']);
      // Service composes with the derived transfer status.
      const pendingPlumbing = await proList({ service: 'Plumbing', status: 'transfer_pending' });
      expect(pendingPlumbing.data.map((r: any) => r.bookingNumber)).toEqual(['BK-F-2']);
      expect(await proList({ service: 'Gardening' })).toMatchObject({ pagination: { total: 0 } });
    });

    it('returns professional status and service counts that match what each option lists', async () => {
      const all = await proList({});
      expect(all.services).toEqual(['Painting', 'Plumbing', 'Tiling']);
      expect(all.serviceCounts).toEqual({ Plumbing: 2, Painting: 1, Tiling: 1 });
      expect(all.statusCounts).toMatchObject({
        completed: 1, transfer_pending: 1, authorized: 1, refunded: 1, transfer_failed: 0, pending: 0, failed: 0,
      });
      for (const [status, count] of Object.entries(all.statusCounts as Record<string, number>)) {
        expect((await proList({ status })).pagination.total).toBe(count);
      }
      // Each facet ignores its own selection but honours the other one.
      const plumbing = await proList({ service: 'Plumbing' });
      expect(plumbing.statusCounts).toMatchObject({ completed: 1, transfer_pending: 1, authorized: 0 });
      expect(plumbing.serviceCounts).toEqual({ Plumbing: 2, Painting: 1, Tiling: 1 });
      const authorized = await proList({ status: 'authorized' });
      expect(authorized.serviceCounts).toEqual({ Painting: 1 });
    });

    it('returns customer payment status and service counts honouring the sibling facet', async () => {
      const customerList = async (query: Record<string, string>) => {
        const res = response();
        await getMyPayments({ user: { _id: CUSTOMER }, query } as unknown as Request, res, vi.fn());
        expect(res.statusCode).toBe(200);
        return res.body.data;
      };
      const all = await customerList({});
      expect(all.statusCounts).toEqual({ completed: 3, authorized: 1, refunded: 1 });
      expect(all.serviceCounts).toEqual({ Plumbing: 3, Painting: 1, Tiling: 1 });
      const plumbing = await customerList({ service: 'Plumbing' });
      expect(plumbing.pagination.total).toBe(3);
      expect(plumbing.statusCounts).toEqual({ completed: 3 });
      const completed = await customerList({ status: 'completed' });
      expect(completed.serviceCounts).toEqual({ Plumbing: 3 });
      expect(completed.pagination.total).toBe(3);
    });
  });
});
