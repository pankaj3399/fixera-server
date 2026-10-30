/**
 * WS4 (final touches part 3) disposable-DB tests.
 *
 * Run only when FIXERA_TEST_MONGODB_URI points at a disposable LOCAL
 * database (repo convention: skipped otherwise). Never point it at Atlas.
 * The calendar/planning writes use multi-document transactions, so the
 * disposable database must be a replica set (single-node rs is enough).
 *
 * Covers, against a real MongoDB engine:
 * - 23b/23c: 14:00 and rescheduled 12:00 wall times convert to the correct
 *   UTC instant in the professional's zone and render back at the same local
 *   time; a professional without a usable business timezone resolves to the
 *   business-country zone instead of silently using UTC.
 * - 24a: an hour-mode booking is scheduled onto the free employee when the
 *   professional is busy.
 * - 24b: calendar blocks only cover attending resources (no double booking
 *   on the busy professional's personal calendar).
 * - planning board: hour-mode payload carries start/end times and per-resource
 *   window availability; saving attendance keeps the instants intact.
 */
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ws4-test-jwt-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_ws4-disposable';
});

import Booking from '../../models/booking';
import CalendarReservation from '../../models/calendarReservation';
import { buildProjectScheduleWindow } from '../../utils/scheduleEngine';
import { bookingCalendarOccupancies } from '../../utils/support/bookingCalendar';
import { buildBookingBlockedRanges } from '../../utils/bookingBlocks';
import { updateBookingPlanning } from '../../handlers/Booking/planning';

const TZ = 'Europe/Brussels';
const DAY = '2026-11-05'; // Thursday
const PLAN_DAY = '2026-11-09'; // Monday

const localToUtc = (date: string, time: string) =>
  DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toJSDate();
const renderLocal = (d: Date) => DateTime.fromJSDate(d, { zone: 'utc' }).setZone(TZ).toFormat('HH:mm');

describeDb('WS4 hour mode (disposable local MongoDB)', () => {
  const proId = new Types.ObjectId();
  const empId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const noTzProId = new Types.ObjectId();
  const noTzProjectId = new Types.ObjectId();
  const planningBookingId = new Types.ObjectId();

  const weekAvailability = () => ({
    monday: { available: true, startTime: '09:00', endTime: '17:00' },
    tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
    wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
    thursday: { available: true, startTime: '09:00', endTime: '17:00' },
    friday: { available: true, startTime: '09:00', endTime: '17:00' },
  });

  beforeAll(async () => {
    await mongoose.connect(testUri!);
    const users = mongoose.connection.collection('users');
    const projects = mongoose.connection.collection('projects');
    const bookings = mongoose.connection.collection('bookings');
    await users.deleteMany({ email: /ws4-test\.example$/ });
    await projects.deleteMany({ title: /WS4 hour/ });
    await bookings.deleteMany({ bookingNumber: /WS4T/ });
    await CalendarReservation.deleteMany({});

    await users.insertMany([
      {
        _id: proId,
        role: 'professional',
        professionalStatus: 'approved',
        name: 'WS4 Pro',
        email: 'pro-ws4-test.example',
        password: 'x',
        phone: '+3210',
        businessInfo: { timezone: TZ, country: 'Belgium' },
        companyAvailability: weekAvailability(),
        companyBlockedDates: [],
        companyBlockedRanges: [],
      },
      {
        _id: empId,
        role: 'employee',
        name: 'WS4 Emp',
        email: 'emp-ws4-test.example',
        password: 'x',
        phone: '+3211',
        employee: { companyId: proId.toString(), isActive: true },
        blockedDates: [],
        blockedRanges: [],
      },
      {
        _id: customerId,
        role: 'customer',
        name: 'WS4 Customer',
        email: 'cus-ws4-test.example',
        password: 'x',
        phone: '+3212',
      },
      {
        _id: noTzProId,
        role: 'professional',
        professionalStatus: 'approved',
        name: 'WS4 NoTz Pro',
        email: 'notz-ws4-test.example',
        password: 'x',
        phone: '+3213',
        // Real legacy shape: nothing in the product writes businessInfo.timezone,
        // so rows persist the schema default 'UTC'. The country must still
        // resolve to Europe/Brussels (client bug list #23b).
        businessInfo: { timezone: 'UTC', country: 'Belgium' },
        companyAvailability: weekAvailability(),
        companyBlockedDates: [],
        companyBlockedRanges: [],
      },
    ]);

    await projects.insertMany([
      {
        _id: projectId,
        title: 'WS4 hour project with a sufficiently long title',
        status: 'published',
        professionalId: proId,
        timeMode: 'hours',
        executionDuration: { value: 2, unit: 'hours' },
        resources: [proId.toString(), empId.toString()],
        minResources: 1,
        minOverlapPercentage: 90,
        subprojects: [],
      },
      {
        _id: noTzProjectId,
        title: 'WS4 hour project without timezone with long title',
        status: 'published',
        professionalId: noTzProId,
        timeMode: 'hours',
        executionDuration: { value: 2, unit: 'hours' },
        resources: [noTzProId.toString(), empId.toString()],
        minResources: 1,
        minOverlapPercentage: 90,
        subprojects: [],
      },
    ]);

    // Existing booking occupying the professional 14:00-16:00 on DAY.
    await bookings.insertOne({
      _id: new Types.ObjectId(),
      bookingNumber: 'WS4T-BLOCKER',
      customer: customerId,
      professional: proId,
      project: projectId,
      status: 'booked',
      bookingType: 'project',
      assignedTeamMembers: [proId],
      scheduledStartDate: localToUtc(DAY, '14:00'),
      scheduledExecutionEndDate: localToUtc(DAY, '16:00'),
      scheduledBufferStartDate: localToUtc(DAY, '16:00'),
      scheduledBufferEndDate: localToUtc(DAY, '16:00'),
      scheduledStartTime: '14:00',
      scheduledEndTime: '16:00',
      rfqData: { serviceType: 'Plumbing', description: 'WS4 blocker' },
      quote: { amount: 100, currency: 'EUR' },
    });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      const users = mongoose.connection.collection('users');
      const projects = mongoose.connection.collection('projects');
      const bookings = mongoose.connection.collection('bookings');
      await users.deleteMany({ email: /ws4-test\.example$/ });
      await projects.deleteMany({ title: /WS4 hour/ });
      await bookings.deleteMany({ bookingNumber: /WS4T/ });
      await CalendarReservation.deleteMany({});
      await mongoose.disconnect();
    }
  });

  it('23b: a 14:00 start stores the correct instant and renders 14:00', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(projectId),
      startDate: DAY,
      startTime: '14:00',
      excludeBookingId: new Types.ObjectId().toString(),
    });
    expect(window).not.toBeNull();
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-05T13:00:00.000Z');
    expect(window!.scheduledStartTime).toBe('14:00');
    expect(window!.scheduledEndTime).toBe('16:00');
    expect(renderLocal(window!.scheduledStartDate)).toBe('14:00');
  });

  it('23b fix: a professional without a usable zone resolves Belgium to Brussels, not UTC', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(noTzProjectId),
      startDate: DAY,
      startTime: '14:00',
    });
    expect(window).not.toBeNull();
    // Wall-as-UTC would store 14:00Z and render 15:00 in Brussels.
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-05T13:00:00.000Z');
    expect(renderLocal(window!.scheduledStartDate)).toBe('14:00');
  });

  it('23c: rescheduling to 12:00 uses the same conversion', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(projectId),
      startDate: DAY,
      startTime: '12:00',
      excludeBookingId: new Types.ObjectId().toString(),
    });
    expect(window).not.toBeNull();
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-05T11:00:00.000Z');
    expect(renderLocal(window!.scheduledStartDate)).toBe('12:00');
  });

  it('24a: schedules the free employee when the professional is busy', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(projectId),
      startDate: DAY,
      startTime: '14:00',
    });
    expect(window).not.toBeNull();
    expect(window!.assignedTeamMembers.map(String)).toEqual([empId.toString()]);
  });

  it('24b: calendar blocks only cover attending resources', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(projectId),
      startDate: DAY,
      startTime: '14:00',
    });
    expect(window).not.toBeNull();

    // Persist the emp-attended booking, then check both personal calendars.
    const bookingId = new Types.ObjectId();
    await mongoose.connection.collection('bookings').insertOne({
      _id: bookingId,
      bookingNumber: 'WS4T-ATTEND',
      customer: customerId,
      professional: proId,
      project: projectId,
      status: 'booked',
      bookingType: 'project',
      assignedTeamMembers: window!.assignedTeamMembers,
      scheduledStartDate: window!.scheduledStartDate,
      scheduledExecutionEndDate: window!.scheduledExecutionEndDate,
      scheduledBufferStartDate: window!.scheduledBufferStartDate,
      scheduledBufferEndDate: window!.scheduledBufferEndDate,
      scheduledStartTime: window!.scheduledStartTime,
      scheduledEndTime: window!.scheduledEndTime,
      rfqData: { serviceType: 'Plumbing', description: 'WS4 attend' },
      quote: { amount: 100, currency: 'EUR' },
    });

    const proRanges = await buildBookingBlockedRanges(proId);
    const empRanges = await buildBookingBlockedRanges(empId);
    const attendStart = window!.scheduledStartDate.toISOString();
    // The professional is busy 14:00-16:00 on its own booking, but the new
    // emp-attended booking must not double-book the professional.
    expect(proRanges.filter((r) => r.startDate === attendStart)).toHaveLength(1);
    expect(empRanges.filter((r) => r.startDate === attendStart)).toHaveLength(1);
    expect(renderLocal(new Date(empRanges.find((r) => r.startDate === attendStart)!.startDate))).toBe('14:00');

    // Reservation rows for the new booking cover only the employee.
    const stored: any = await Booking.findById(bookingId).lean();
    const occupancies = bookingCalendarOccupancies({
      _id: stored._id,
      professional: stored.professional,
      assignedTeamMembers: stored.assignedTeamMembers,
      resourcePlan: stored.resourcePlan,
      scheduledStartDate: stored.scheduledStartDate,
      scheduledExecutionEndDate: stored.scheduledExecutionEndDate,
      scheduledBufferEndDate: stored.scheduledBufferEndDate,
    });
    expect(occupancies.map((o) => o.userId).sort()).toEqual([empId.toString()]);
  });

  it('planning board: hour-mode payload carries times and window availability', async () => {
    await mongoose.connection.collection('bookings').insertOne({
      _id: planningBookingId,
      bookingNumber: 'WS4T-PLAN',
      customer: customerId,
      professional: proId,
      project: projectId,
      status: 'booked',
      bookingType: 'project',
      assignedTeamMembers: [proId, empId],
      scheduledStartDate: localToUtc(PLAN_DAY, '14:00'),
      scheduledExecutionEndDate: localToUtc(PLAN_DAY, '16:00'),
      scheduledBufferStartDate: localToUtc(PLAN_DAY, '16:00'),
      scheduledBufferEndDate: localToUtc(PLAN_DAY, '16:00'),
      scheduledStartTime: '14:00',
      scheduledEndTime: '16:00',
      statusHistory: [],
      rfqData: { serviceType: 'Plumbing', description: 'WS4 plan' },
      quote: { amount: 100, currency: 'EUR' },
    });

    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await updateBookingPlanning(
      {
        params: { bookingId: String(planningBookingId) },
        user: { _id: proId },
        body: { load: true },
      } as any,
      res as any
    );
    expect(res.json).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0].data;
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(payload.mode).toBe('hours');
    expect(payload.startTime).toBe('14:00');
    expect(payload.endTime).toBe('16:00');
    expect(payload.timeZone).toBe(TZ);
    const byId = new Map(payload.resources.map((r: any) => [r._id, r]));
    expect(byId.get(proId.toString()).attending).toBe(true);
    expect(byId.get(empId.toString()).attending).toBe(true);
  });

  it('planning board: saving attendance keeps the window instants intact (24a/24b)', async () => {
    // Blocker occupying the professional on the planning day.
    await mongoose.connection.collection('bookings').insertOne({
      _id: new Types.ObjectId(),
      bookingNumber: 'WS4T-PLANBLOCK',
      customer: customerId,
      professional: proId,
      project: projectId,
      status: 'booked',
      bookingType: 'project',
      assignedTeamMembers: [proId],
      scheduledStartDate: localToUtc(PLAN_DAY, '14:00'),
      scheduledExecutionEndDate: localToUtc(PLAN_DAY, '16:00'),
      scheduledBufferStartDate: localToUtc(PLAN_DAY, '16:00'),
      scheduledBufferEndDate: localToUtc(PLAN_DAY, '16:00'),
      rfqData: { serviceType: 'Plumbing', description: 'WS4 plan blocker' },
      quote: { amount: 100, currency: 'EUR' },
    });

    // The busy professional cannot stay attending...
    const busyRes: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await updateBookingPlanning(
      {
        params: { bookingId: String(planningBookingId) },
        user: { _id: proId },
        body: { resourcePlan: [{ resourceId: proId.toString(), days: [PLAN_DAY] }] },
      } as any,
      busyRes as any
    );
    expect(busyRes.status).toHaveBeenCalledWith(400);
    expect(busyRes.json.mock.calls[0][0].error.code).toBe('BLOCKED_WINDOW');

    // ...but the free employee can, and the window survives untouched.
    const okRes: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await updateBookingPlanning(
      {
        params: { bookingId: String(planningBookingId) },
        user: { _id: proId },
        body: { resourcePlan: [{ resourceId: empId.toString(), days: [PLAN_DAY] }] },
      } as any,
      okRes as any
    );
    expect(okRes.json).toHaveBeenCalled();
    expect(okRes.json.mock.calls[0][0].success).toBe(true);

    const stored: any = await Booking.findById(planningBookingId).lean();
    expect(stored.assignedTeamMembers.map(String)).toEqual([empId.toString()]);
    expect(stored.resourcePlan).toEqual([]);
    expect(new Date(stored.scheduledStartDate).toISOString()).toBe(
      localToUtc(PLAN_DAY, '14:00').toISOString()
    );
    expect(new Date(stored.scheduledExecutionEndDate).toISOString()).toBe(
      localToUtc(PLAN_DAY, '16:00').toISOString()
    );
    expect(stored.scheduledStartTime).toBe('14:00');
    expect(stored.scheduledEndTime).toBe('16:00');

    const rows = await CalendarReservation.find({ sourceId: planningBookingId }).lean();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r: any) => String(r.userId)))).toEqual(new Set([empId.toString()]));
  });
});
