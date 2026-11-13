/**
 * Booking & Quotation page phase 2: append-only status archive.
 *
 * REAL MongoDB (own throwaway database per run). Proves that every
 * statusHistory append (save and atomic $push) is archived with the
 * executioner and context, that earlier context survives later overwrites,
 * that a rolled-back transaction leaves no archive row, and that the activity
 * timeline merges the archive with role-appropriate visibility.
 *
 * Run only with FIXERA_TEST_MONGODB_URI pointing at a disposable local DB.
 */
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Booking from '../../models/booking';
import BookingEvent from '../../models/bookingEvent';
import User from '../../models/user';
import { runWithRequestActor } from '../../utils/requestActor';
import { buildDetailsForBookingDocument } from '../../handlers/Booking/details';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

const mkUser = (role: string, extra: Record<string, unknown> = {}) =>
  User.create({
    name: `Archive ${role}`,
    email: `${role}-${new Types.ObjectId().toHexString()}@archive-it.example`,
    phone: `+3247${Math.floor(Math.random() * 1e7)}`,
    password: 'not-used-hash',
    role,
    isEmailVerified: true,
    accountStatus: 'active',
    ...extra,
  });

describeDb('booking event archive (disposable MongoDB)', () => {
  let customer: any;
  let professional: any;
  let admin: any;

  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_booking_archive_it_${process.pid}_${Date.now()}` });
    await BookingEvent.init();
    customer = await mkUser('customer');
    professional = await mkUser('professional');
    admin = await mkUser('admin', { adminRole: 'super' });
  });
  afterAll(async () => {
    await mongoose.connection.db?.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Booking.collection.deleteMany({});
    await BookingEvent.collection.deleteMany({});
  });

  const newBooking = async () => {
    const booking = new Booking({
      customer: customer._id,
      professional: professional._id,
      bookingType: 'professional',
      status: 'booked',
      bookingNumber: `BK-ARCH-${new Types.ObjectId().toHexString().slice(-8)}`,
      statusHistory: [{ status: 'booked', timestamp: new Date(Date.now() - 60_000), updatedBy: customer._id }],
    });
    await booking.save({ validateBeforeSave: false });
    return booking;
  };

  it('archives the creating entry and later saves, stamping the request actor when updatedBy is missing', async () => {
    const booking = await newBooking();
    await runWithRequestActor(professional, async () => {
      const loaded: any = await Booking.findById(booking._id);
      loaded.status = 'in_progress';
      loaded.statusHistory.push({ status: 'in_progress', timestamp: new Date(), note: 'Started on site' });
      await loaded.save({ validateBeforeSave: false });
    });

    const rows = await BookingEvent.find({ booking: booking._id }).sort({ at: 1 }).lean();
    expect(rows.map((row) => [row.statusFrom, row.statusTo, row.actorRole])).toEqual([
      [null, 'booked', 'customer'],
      ['booked', 'in_progress', 'professional'],
    ]);
    expect(String(rows[1].actor)).toBe(String(professional._id));
    expect(rows[1].actorFromEntry).toBe(false);
    expect(rows[1].note).toBe('Started on site');
    // The live statusHistory entry now records who did it as well.
    const stored: any = await Booking.findById(booking._id).lean();
    expect(String(stored.statusHistory[1].updatedBy)).toBe(String(professional._id));
  });

  it('archives atomic $push updates with the previous status, and a cron (no actor) as system', async () => {
    const booking = await newBooking();
    await Booking.findOneAndUpdate(
      { _id: booking._id },
      { $set: { status: 'completed' }, $push: { statusHistory: { status: 'completed', timestamp: new Date(), note: 'Auto-completed' } } },
      { new: true },
    );
    const rows = await BookingEvent.find({ booking: booking._id, statusTo: 'completed' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ statusFrom: 'booked', actorRole: 'system', actor: null, note: 'Auto-completed' });

    // An update that matches nothing archives nothing.
    await Booking.updateOne(
      { _id: booking._id, status: 'rfq' },
      { $push: { statusHistory: { status: 'cancelled', timestamp: new Date() } } },
    );
    expect(await BookingEvent.countDocuments({ booking: booking._id, statusTo: 'cancelled' })).toBe(0);
  });

  it('keeps the first dispute context after a second dispute overwrites booking.dispute, admin-only in the timeline', async () => {
    const booking = await newBooking();
    const dispute = async (reason: string, attachment: string, at: Date) =>
      runWithRequestActor(customer, async () => {
        const loaded: any = await Booking.findById(booking._id);
        loaded.dispute = { raisedBy: customer._id, reason, description: `${reason} details`, raisedAt: at, type: 'extra_costs', attachments: [attachment] };
        loaded.status = 'dispute';
        loaded.statusHistory.push({ status: 'dispute', timestamp: at, updatedBy: customer._id, note: `Dispute: ${reason}` });
        await loaded.save({ validateBeforeSave: false });
      });
    const firstAt = new Date(Date.now() - 30_000);
    await dispute('Wrong amount', 'https://fixera-test-bucket.s3.eu-west-1.amazonaws.com/dispute-attachments/a.jpg', firstAt);
    await runWithRequestActor(admin, async () => {
      const loaded: any = await Booking.findById(booking._id);
      loaded.status = 'booked';
      loaded.statusHistory.push({ status: 'booked', timestamp: new Date(Date.now() - 20_000), note: 'Resolved by admin' });
      await loaded.save({ validateBeforeSave: false });
    });
    await dispute('Damage', 'https://fixera-test-bucket.s3.eu-west-1.amazonaws.com/dispute-attachments/b.jpg', new Date(Date.now() - 10_000));

    const disputes = await BookingEvent.find({ booking: booking._id, statusTo: 'dispute' }).sort({ at: 1 }).lean();
    expect(disputes.map((row: any) => row.context?.dispute?.reason)).toEqual(['Wrong amount', 'Damage']);
    expect(disputes[0].attachments).toEqual(['https://fixera-test-bucket.s3.eu-west-1.amazonaws.com/dispute-attachments/a.jpg']);
    const resolved = await BookingEvent.findOne({ booking: booking._id, statusFrom: 'dispute', statusTo: 'booked' }).lean();
    expect(resolved).toMatchObject({ actorRole: 'admin', note: 'Resolved by admin' });

    const stored = await Booking.findById(booking._id).lean();
    const adminDetails: any = await buildDetailsForBookingDocument({ booking: stored, viewerRole: 'admin', user: admin });
    const adminItems = adminDetails.activity.items.filter((item: any) => item.metadata?.archived);
    const reasons = adminItems.map((item: any) => item.metadata?.archivedContext?.dispute?.reason).filter(Boolean);
    expect(reasons).toEqual(expect.arrayContaining(['Wrong amount', 'Damage']));
    expect(adminDetails.activity.coverage).toEqual({ status: 'complete', source: 'append_only_archive', appendOnlyArchive: true });
    const adminResolution = adminDetails.activity.items.find((item: any) => item.statusFrom === 'dispute' && item.statusTo === 'booked');
    expect(adminResolution?.actor?.role).toBe('admin');

    const customerDetails: any = await buildDetailsForBookingDocument({ booking: stored, viewerRole: 'customer', user: customer });
    const customerJson = JSON.stringify(customerDetails.activity);
    expect(customerJson).not.toContain('Wrong amount details');
    expect(customerJson).not.toContain('archivedContext":{"dispute');
    // The admin's own note stays admin-only for participants.
    expect(customerJson).not.toContain('Resolved by admin');
  });

  it('a rolled-back transaction leaves no archive row', async () => {
    const booking = await newBooking();
    const session = await mongoose.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          const loaded: any = await Booking.findById(booking._id).session(session);
          loaded.status = 'cancelled';
          loaded.statusHistory.push({ status: 'cancelled', timestamp: new Date(), updatedBy: customer._id });
          await loaded.save({ session, validateBeforeSave: false });
          throw new Error('abort on purpose');
        }),
      ).rejects.toThrow('abort on purpose');
    } finally {
      await session.endSession();
    }
    expect(await BookingEvent.countDocuments({ booking: booking._id, statusTo: 'cancelled' })).toBe(0);
    expect(await BookingEvent.countDocuments({ booking: booking._id })).toBe(1);
  });

  it('legacy bookings without archive rows keep coverage "unknown"', async () => {
    const booking = await newBooking();
    await BookingEvent.deleteMany({ booking: booking._id });
    const stored = await Booking.findById(booking._id).lean();
    const details: any = await buildDetailsForBookingDocument({ booking: stored, viewerRole: 'admin', user: admin });
    expect(details.activity.coverage).toEqual({ status: 'unknown', source: 'surviving_records', appendOnlyArchive: false });
  });
});
