import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri && /test/i.test(testUri) ? describe : describe.skip;
vi.mock('../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import Booking from '../../models/booking';
import CalendarReservation from '../../models/calendarReservation';
import { buildProjectScheduleWindow, buildPerMemberBlockedData, buildPerResourceBlockedDays } from '../../utils/scheduleEngine';
import { buildScheduleUpdatePayload, requestBookingReschedule, respondToBookingReschedule } from '../../handlers/Booking/payment-integration';
import { bookingCalendarOccupancies, reserveBookingCalendar, releaseBookingCalendar } from '../../utils/support/bookingCalendar';
import { findTeamConflicts } from '../../utils/scheduleConflict';
import User from '../../models/user';
import Project from '../../models/project';
import { createBooking } from '../../handlers/Booking';


const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const day = (key: string) => new Date(`${key}T00:00:00Z`);
const planSummary = (plan: any[]) => plan?.map(entry => ({ resourceId: String(entry.resourceId), days: entry.days.map((d: any) => new Date(d).toISOString().slice(0, 10)) }));

describeDb('per-day substitutions survive booking and reschedule contracts', () => {
  const professional = new Types.ObjectId();
  const employee = new Types.ObjectId();
  const customer = new Types.ObjectId();
  const project = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const expected = [
    { resourceId: String(professional), days: ['2027-01-11'] },
    { resourceId: String(employee), days: ['2027-01-12'] },
  ];
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T09:00:00Z'));
    await mongoose.connect(testUri!, { dbName: `ft3_substitution_${process.pid}_${Date.now().toString(36)}`, autoCreate: false, autoIndex: false });
    const availability = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(key => [key, { available: true, startTime: '09:00', endTime: '17:00' }]));
    await mongoose.connection.collection('users').insertMany([
      { _id: professional, name: 'Plan Pro', email: 'plan-pro@test.example', role: 'professional', professionalStatus: 'approved', businessInfo: { timezone: 'UTC' }, companyAvailability: availability },
      { _id: employee, name: 'Plan Employee', email: 'plan-emp@test.example', role: 'employee', employee: { companyId: String(professional), isActive: true } },
      { _id: customer, name: 'Plan Customer', email: 'plan-customer@test.example', role: 'customer', location: { type: 'Point', coordinates: [4, 50], country: 'BE' } },
    ]);
    await mongoose.connection.collection('projects').insertOne({ _id: project, professionalId: professional, title: 'Substitution schedule regression', status: 'published', resources: [String(professional), String(employee)], minResources: 1, minOverlapPercentage: 100, executionDuration: { value: 2, unit: 'days' }, timeMode: 'days', subprojects: [{ name: 'Package', pricing: { type: 'fixed', amount: 100 }, executionDuration: { value: 2, unit: 'days' } }] });
    await mongoose.connection.collection('bookings').insertMany([
      { _id: bookingId, bookingNumber: 'PLAN-TARGET', customer, professional, project, bookingType: 'project', status: 'booked', location: { type: 'Point', coordinates: [4, 50] }, rfqData: { serviceType: 'Plumbing', description: 'Test schedule' }, vatDecision: { action: 'standard_rate', appliedRate: 21, standardRate: 21 }, quote: { amount: 100 }, assignedTeamMembers: [professional], scheduledStartDate: day('2027-01-04'), scheduledExecutionEndDate: new Date('2027-01-05T17:00Z') },
      ...[[professional, '2027-01-12'], [employee, '2027-01-11']].map(([member, key], index) => ({ _id: new Types.ObjectId(), bookingNumber: `PLAN-BLOCKER-${index}`, customer, professional, project, bookingType: 'project', status: 'booked', assignedTeamMembers: [member], scheduledStartDate: day(String(key)), scheduledExecutionEndDate: new Date(`${key}T17:00Z`) })),
    ]);
    await CalendarReservation.createCollection();
    await CalendarReservation.createIndexes();
    await mongoose.connection.createCollection('counters');
    const blockers = await Booking.find({ bookingNumber: /^PLAN-BLOCKER-/ });
    for (const blocker of blockers) await reserveBookingCalendar(blocker as any);
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); vi.useRealTimers(); });

  it('returns the exact covering assignment and reserves only those person-days', async () => {
    const window = await buildProjectScheduleWindow({ projectId: String(project), startDate: '2027-01-11', excludeBookingId: String(bookingId) });
    expect(window).toBeTruthy();
    expect(planSummary((window as any).resourcePlan)).toEqual(expected);
    const candidate = { _id: bookingId, professional, ...window! };
    expect(bookingCalendarOccupancies(candidate).map(o => [o.userId, o.startAt.toISOString().slice(0, 10)])).toEqual(expected.map(e => [e.resourceId, e.days[0]]));
    await reserveBookingCalendar(candidate);
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(192);
    // The inverse assignment is already occupied, but is irrelevant to this plan.
    expect(await findTeamConflicts(String(bookingId), [professional, employee], window!.scheduledStartDate, window!.scheduledExecutionEndDate, (window as any).resourcePlan)).toEqual([]);
    await releaseBookingCalendar(bookingId);
  });

  it('persists the covering plan through normal booking creation', async () => {
    const res = response();
    await createBooking({ user: { _id: String(customer) }, body: {
      bookingType: 'project', projectId: String(project), selectedSubprojectIndex: 0,
      preferredStartDate: '2027-01-11',
      rfqData: { serviceType: 'Plumbing', description: 'Book a substituting team' },
    } } as any, res as any, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    const created = await Booking.findOne({ customer, 'rfqData.description': 'Book a substituting team' });
    try {
      expect(planSummary(created?.resourcePlan as any)).toEqual(expected);
      expect(await CalendarReservation.countDocuments({ sourceId: created!._id })).toBe(192);
    } finally {
      if (created) { await releaseBookingCalendar(created._id); await Booking.deleteOne({ _id: created._id }); }
    }
  });

  it('persists the proposed plan, checks it on acceptance, and never inflates the union into extra work', async () => {
    const booking = await Booking.findById(bookingId);
    const payload = await buildScheduleUpdatePayload({ booking, scheduledStartDate: '2027-01-11' });
    expect(payload.success).toBe(true);
    expect(planSummary(payload.success ? payload.data.resourcePlan : [])).toEqual(expected);
    const requested = response();
    await requestBookingReschedule({ params: { bookingId: String(bookingId) }, body: { scheduledStartDate: '2027-01-11', reason: 'Move work' }, user: { _id: String(professional) } } as any, requested as any);
    expect(requested.json.mock.calls[0]?.[0]).toMatchObject({ success: true });
    const pending = await Booking.findById(bookingId);
    expect(planSummary((pending as any).rescheduleRequest.proposedSchedule.resourcePlan)).toEqual(expected);
    const accepted = response();
    await respondToBookingReschedule({ params: { bookingId: String(bookingId) }, body: { action: 'accept' }, user: { _id: String(customer) } } as any, accepted as any);
    expect(accepted.json.mock.calls[0]?.[0]).toMatchObject({ success: true });
    const saved = await Booking.findById(bookingId);
    expect(planSummary((saved as any).resourcePlan)).toEqual(expected);
    expect(saved?.scheduledExecutionEndDate?.toISOString().slice(0, 10)).toBe('2027-01-12');
    // Future availability must also consume the plan rather than its union.
    const pro = await User.findById(professional);
    const blocks = await buildPerResourceBlockedDays({ _id: project } as any, pro, [String(professional), String(employee)], day('2027-01-11'), day('2027-01-13'), 'UTC');
    expect(blocks.get(String(professional))?.has('2027-01-11')).toBe(true);
  });
  it('keeps a constant team on the existing whole-window reservation contract', async () => {
    const window = await buildProjectScheduleWindow({ projectId: String(project), startDate: '2027-01-25' });
    expect(window?.resourcePlan).toBeUndefined();
    expect(window?.assignedTeamMembers.map(String)).toEqual([String(professional)]);
    expect(bookingCalendarOccupancies({ _id: new Types.ObjectId(), professional, ...window! })).toEqual([
      { userId: String(professional), startAt: day('2027-01-25'), endAt: new Date('2027-01-26T17:00Z') },
    ]);
  });

  it('checks existing plans and future availability by person/day rather than attendee union', async () => {
    const id = new Types.ObjectId();
    const resourcePlan = [
      { resourceId: professional, days: [day('2027-01-18')] },
      { resourceId: employee, days: [day('2027-01-19')] },
    ];
    await mongoose.connection.collection('bookings').insertOne({
      _id: id, customer, professional, project, bookingType: 'project', status: 'booked',
      assignedTeamMembers: [professional, employee], resourcePlan,
      scheduledStartDate: day('2027-01-18'), scheduledExecutionEndDate: new Date('2027-01-19T17:00Z'),
    });
    expect(await findTeamConflicts(String(bookingId), [employee], day('2027-01-18'), new Date('2027-01-18T17:00Z'))).toEqual([]);
    expect(await findTeamConflicts(String(bookingId), [professional], day('2027-01-18'), new Date('2027-01-18T17:00Z'))).toHaveLength(1);
    const pro = await User.findById(professional);
    const projectDoc = await Project.findById(project);
    const blocks = await buildPerResourceBlockedDays(projectDoc, pro, [String(professional), String(employee)], day('2027-01-18'), day('2027-01-20'), 'UTC');
    expect(blocks.get(String(professional))?.has('2027-01-18')).toBe(true);
    expect(blocks.get(String(professional))?.has('2027-01-19')).toBe(false);
    expect(blocks.get(String(employee))?.has('2027-01-18')).toBe(false);
    const memberBlocks = await buildPerMemberBlockedData(projectDoc, pro, 'UTC');
    const own = memberBlocks.get(String(professional))!.blockedRanges.filter(r => r.start >= day('2027-01-18'));
    expect(own.map(r => r.start.toISOString().slice(0, 10))).toEqual(['2027-01-18']);
  });

});
