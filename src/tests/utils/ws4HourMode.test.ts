/**
 * WS4 (final touches part 3) — hour-mode scheduling.
 *
 * Covers, without any database:
 * - 23a: the backend exposes scheduled start/end times (snapshot capture and
 *   timeline schedule metadata).
 * - 23b/c: a 14:00 wall time converts to the correct UTC instant in the
 *   professional's effective zone (no double conversion); rescheduling to
 *   12:00 uses the same conversion. A professional without a usable business
 *   timezone falls back to the business-country zone instead of silently
 *   using UTC (which rendered 14:00 as 15:00 in Brussels).
 * - 24a: hour-mode multi-resource scheduling picks the available resources
 *   when the professional is busy but employees are free.
 * - 24b: calendar occupancy only blocks attending resources
 *   (covered in bookingCalendar.test.ts).
 */
import { Types } from 'mongoose';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  project: null as any,
  professional: null as any,
  members: [] as any[],
  bookings: [] as any[],
}));

vi.mock('../../models/project', () => ({
  default: { findOne: () => ({ lean: async () => mocks.project }) },
}));
vi.mock('../../models/user', () => ({
  default: {
    findById: () => ({ select: () => ({ lean: async () => mocks.professional }) }),
    find: () => ({ select: async () => mocks.members }),
  },
}));
vi.mock('../../models/booking', () => ({
  default: { find: () => ({ select: async () => mocks.bookings }) },
}));
vi.mock('../../utils/support/calendarBusy', () => ({
  loadSharedCalendarBusy: async () => ({ byUser: new Map(), sources: [] }),
}));

import {
  buildProjectScheduleWindow,
  isMemberAvailableForWindow,
  resolveEffectiveScheduleTimeZone,
} from '../../utils/scheduleEngine';
import { resolveAvailability } from '../../utils/availabilityHelpers';
import { buildBookingSnapshot } from '../../utils/bookingDetails/snapshot';
import { buildBookingActivity } from '../../utils/bookingDetails/timeline';
import { buildBookingDetails } from '../../utils/bookingDetails/projection';

const TIME_ZONE = 'Europe/Brussels';

const proId = new Types.ObjectId('507f1f77bcf86cd799439012');
const empId = new Types.ObjectId('507f1f77bcf86cd799439013');
const emp2Id = new Types.ObjectId('507f1f77bcf86cd799439014');

const fullWeekAvailability = () => ({
  monday: { available: true, startTime: '09:00', endTime: '17:00' },
  tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
  wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
  thursday: { available: true, startTime: '09:00', endTime: '17:00' },
  friday: { available: true, startTime: '09:00', endTime: '17:00' },
});

const seedHourProject = (overrides: Record<string, any> = {}) => {
  mocks.project = {
    _id: new Types.ObjectId('507f1f77bcf86cd799439020'),
    status: 'published',
    professionalId: proId,
    executionDuration: { value: 2, unit: 'hours' },
    resources: [proId.toString(), empId.toString()],
    minResources: 1,
    minOverlapPercentage: 90,
    subprojects: [],
    ...overrides,
  };
  mocks.professional = {
    _id: proId,
    companyAvailability: fullWeekAvailability(),
    companyBlockedDates: [],
    companyBlockedRanges: [],
    businessInfo: { timezone: TIME_ZONE, country: 'Belgium' },
  };
  mocks.members = [
    { _id: proId, blockedDates: [], blockedRanges: [] },
    { _id: empId, blockedDates: [], blockedRanges: [] },
  ];
  mocks.bookings = [];
};

const blockPro = (startIso: string, endIso: string) => {
  mocks.bookings = [
    {
      _id: new Types.ObjectId(),
      status: 'booked',
      project: mocks.project._id,
      professional: proId,
      assignedTeamMembers: [proId],
      scheduledStartDate: new Date(startIso),
      scheduledExecutionEndDate: new Date(endIso),
      scheduledBufferStartDate: new Date(endIso),
      scheduledBufferEndDate: new Date(endIso),
    },
  ];
};

beforeEach(() => {
  seedHourProject();
});

describe('effective scheduling timezone (client bug list #23b/c)', () => {
  it('prefers the stored professional zone', () => {
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: TIME_ZONE } }, undefined)
    ).toBe(TIME_ZONE);
  });

  it('falls back to the business-country zone instead of silently using UTC', () => {
    expect(resolveEffectiveScheduleTimeZone({ businessInfo: { country: 'BE' } }, undefined)).toBe(
      'Europe/Brussels'
    );
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { country: 'Belgium' } }, undefined)
    ).toBe('Europe/Brussels');
    expect(resolveEffectiveScheduleTimeZone({ businessInfo: {} }, 'Europe/Paris')).toBe(
      'Europe/Paris'
    );
    expect(resolveEffectiveScheduleTimeZone(undefined, undefined)).toBe('UTC');
    expect(resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'Mars/Olympus' } }, undefined)).toBe(
      'UTC'
    );
    expect(resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'UTC' } }, undefined)).toBe(
      'UTC'
    );
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'UTC', country: 'XX' } }, undefined)
    ).toBe('UTC');
  });

  it('treats a stored schema-default UTC as unset (real legacy rows)', () => {
    // Mongoose persists timezone:'UTC' on every row because nothing in the
    // product writes the field. That literal must not win over the request
    // zone or the business country.
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'UTC', country: 'BE' } }, undefined)
    ).toBe('Europe/Brussels');
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'UTC', country: 'Belgium' } }, undefined)
    ).toBe('Europe/Brussels');
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'utc', country: 'BE' } }, undefined)
    ).toBe('Europe/Brussels');
    expect(
      resolveEffectiveScheduleTimeZone({ businessInfo: { timezone: 'UTC', country: 'BE' } }, 'Europe/Paris')
    ).toBe('Europe/Paris');
  });

  it('keeps a real stored zone ahead of request zone and country', () => {
    expect(
      resolveEffectiveScheduleTimeZone(
        { businessInfo: { timezone: 'Europe/Brussels', country: 'BE' } },
        'Europe/Paris'
      )
    ).toBe('Europe/Brussels');
  });
});

describe('hour-mode window conversion (client bug list #23b/c)', () => {
  it('stores 14:00 Brussels as 13:00Z with matching wall-time fields (no double conversion)', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(mocks.project._id),
      startDate: '2026-11-05',
      startTime: '14:00',
    });
    expect(window).not.toBeNull();
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-05T13:00:00.000Z');
    expect(window!.scheduledExecutionEndDate.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(window!.scheduledStartTime).toBe('14:00');
    expect(window!.scheduledEndTime).toBe('16:00');
    expect(window!.assignedTeamMembers.map(String)).toEqual([proId.toString()]);
  });

  it('reschedules to 12:00 with the same conversion (11:00Z)', async () => {
    const window = await buildProjectScheduleWindow({
      projectId: String(mocks.project._id),
      startDate: '2026-11-05',
      startTime: '12:00',
      excludeBookingId: new Types.ObjectId().toString(),
    });
    expect(window).not.toBeNull();
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-05T11:00:00.000Z');
    expect(window!.scheduledStartTime).toBe('12:00');
    expect(window!.scheduledEndTime).toBe('14:00');
  });

  it('uses the business-country zone when the professional has no usable zone (23b fix)', async () => {
    mocks.professional.businessInfo = { country: 'BE' };
    const window = await buildProjectScheduleWindow({
      projectId: String(mocks.project._id),
      startDate: '2026-11-05',
      startTime: '14:00',
    });
    expect(window).not.toBeNull();
    // Wall-as-UTC would store 14:00Z and render 15:00 in Brussels.
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-05T13:00:00.000Z');
  });
});

describe('hour-mode multi-resource scheduling (client bug list #24a)', () => {
  it('schedules the free employee when the professional is busy', async () => {
    blockPro('2026-11-05T13:00:00.000Z', '2026-11-05T15:00:00.000Z');
    const window = await buildProjectScheduleWindow({
      projectId: String(mocks.project._id),
      startDate: '2026-11-05',
      startTime: '14:00',
    });
    expect(window).not.toBeNull();
    expect(window!.assignedTeamMembers.map(String)).toEqual([empId.toString()]);
  });

  it('picks the available pair when minResources is 2 and the professional is busy', async () => {
    seedHourProject({
      resources: [proId.toString(), empId.toString(), emp2Id.toString()],
      minResources: 2,
    });
    mocks.members.push({ _id: emp2Id, blockedDates: [], blockedRanges: [] });
    blockPro('2026-11-05T13:00:00.000Z', '2026-11-05T15:00:00.000Z');
    const window = await buildProjectScheduleWindow({
      projectId: String(mocks.project._id),
      startDate: '2026-11-05',
      startTime: '14:00',
    });
    expect(window).not.toBeNull();
    expect(window!.assignedTeamMembers.map(String).sort()).toEqual(
      [empId.toString(), emp2Id.toString()].sort()
    );
  });

  it('reports unavailable when nobody is free', async () => {
    mocks.bookings = [
      {
        _id: new Types.ObjectId(),
        status: 'booked',
        project: mocks.project._id,
        professional: proId,
        assignedTeamMembers: [proId, empId],
        scheduledStartDate: new Date('2026-11-05T13:00:00.000Z'),
        scheduledExecutionEndDate: new Date('2026-11-05T15:00:00.000Z'),
        scheduledBufferStartDate: new Date('2026-11-05T15:00:00.000Z'),
        scheduledBufferEndDate: new Date('2026-11-05T15:00:00.000Z'),
      },
    ];
    const window = await buildProjectScheduleWindow({
      projectId: String(mocks.project._id),
      startDate: '2026-11-05',
      startTime: '14:00',
    });
    expect(window).toBeNull();
  });

  it('checks a member against the exact window, not the day', () => {
    const availability = resolveAvailability(fullWeekAvailability());
    const start = new Date('2026-11-05T13:00:00.000Z');
    const end = new Date('2026-11-05T15:00:00.000Z');
    const busy = new Map([
      [
        proId.toString(),
        { blockedDates: new Set<string>(), blockedRanges: [{ start, end }] },
      ],
      [empId.toString(), { blockedDates: new Set<string>(), blockedRanges: [] }],
    ]);
    expect(isMemberAvailableForWindow(busy.get(proId.toString()), availability, start, end, TIME_ZONE)).toBe(
      false
    );
    expect(isMemberAvailableForWindow(busy.get(empId.toString()), availability, start, end, TIME_ZONE)).toBe(
      true
    );
  });
});

describe('hour-mode schedule facts in booking info (client bug list #23a)', () => {
  it('captures the scheduled end time in the booking snapshot', () => {
    const snapshot = buildBookingSnapshot({
      booking: {
        scheduledStartDate: new Date('2026-11-05T13:00:00.000Z'),
        scheduledStartTime: '14:00',
        scheduledEndTime: '16:00',
        scheduledExecutionEndDate: new Date('2026-11-05T15:00:00.000Z'),
      },
      project: null,
      customer: null,
      professional: null,
      source: 'booking_creation',
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.schedule).toMatchObject({
      scheduledStartDate: '2026-11-05',
      scheduledStartTime: '14:00',
      scheduledEndTime: '16:00',
      scheduledExecutionEndDate: '2026-11-05',
    });
  });

  it('attaches start/end times to schedule timeline events', async () => {
    const activity = await buildBookingActivity({
      booking: {
        scheduledStartDate: new Date('2026-11-05T13:00:00.000Z'),
        scheduledStartTime: '14:00',
        scheduledEndTime: '16:00',
        scheduledExecutionEndDate: new Date('2026-11-05T15:00:00.000Z'),
        scheduleTimeZone: TIME_ZONE,
        statusHistory: [
          {
            status: 'booked',
            timestamp: new Date('2026-10-30T10:00:00.000Z'),
            updatedBy: new Types.ObjectId('507f1f77bcf86cd799439011'),
            note: 'Schedule selected',
          },
        ],
      },
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors: new Map(),
      viewerRole: 'customer',
      customerId: '507f1f77bcf86cd799439011',
      professionalId: proId.toString(),
    });
    const selected = activity.items.find((item) => item.type === 'schedule_selected');
    expect(selected).toBeDefined();
    expect(selected!.metadata).toMatchObject({
      schedule: {
        startDate: '2026-11-05T13:00:00.000Z',
        startTime: '14:00',
        endTime: '16:00',
        executionEndDate: '2026-11-05T15:00:00.000Z',
        timeZone: TIME_ZONE,
      },
    });
  });

  it('exposes the scheduled end time in the wizard schedule selection', async () => {
    const liveBooking: any = {
      _id: new Types.ObjectId(),
      bookingNumber: 'WS4T-1',
      bookingType: 'project',
      status: 'booked',
      customer: new Types.ObjectId('507f1f77bcf86cd799439011'),
      professional: proId,
      project: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      scheduledStartDate: new Date('2026-11-05T13:00:00.000Z'),
      scheduledStartTime: '14:00',
      scheduledEndTime: '16:00',
      scheduledExecutionEndDate: new Date('2026-11-05T15:00:00.000Z'),
      scheduleTimeZone: TIME_ZONE,
      location: {},
      statusHistory: [],
    };
    liveBooking.bookingSnapshot = buildBookingSnapshot({
      booking: liveBooking,
      project: null,
      customer: null,
      professional: null,
      source: 'booking_creation',
    });
    const details = await buildBookingDetails({
      booking: liveBooking,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors: new Map(),
      viewerRole: 'customer',
      customerId: '507f1f77bcf86cd799439011',
      professionalId: proId.toString(),
    });
    expect(details.booking.schedule.scheduledStartTime).toBe('14:00');
    expect(details.booking.schedule.scheduledEndTime).toBe('16:00');
    expect(details.wizard.scheduleSelection).toMatchObject({
      startDate: '2026-11-05',
      startTime: '14:00',
      endTime: '16:00',
      executionEndDate: '2026-11-05',
    });
    expect(details.bookingSnapshot.schedule).toMatchObject({
      scheduledStartDate: '2026-11-05',
      scheduledStartTime: '14:00',
      scheduledEndTime: '16:00',
    });
  });
});
