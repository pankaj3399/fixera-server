/**
 * FT1 6A/6B: hour-based quantities longer than one working day.
 *
 * A customer-hours package (hour-unit unit pricing) books the customer's
 * hours as its execution. When those hours exceed the professional's longest
 * working day there is no same-day slot, so the engine plans the booking in
 * DAY mode (ceil(hours / longest day) working days) and the proposal, the
 * validation and the booked window must all agree on that mode.
 */
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  project: null as any,
  professional: null as any,
  members: [] as any[],
  bookings: [] as any[],
}));

vi.mock('../../models/platformSettings', () => ({ default: { getCurrentConfig: async () => ({ commissionPercent: 10 }) } }));
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
  buildProjectScheduleProposals,
  buildProjectScheduleWindow,
  getProjectAvailableSlotsForDate,
  validateProjectScheduleSelection,
} from '../../utils/scheduleEngine';

const TIME_ZONE = 'Europe/Brussels';
const proId = new Types.ObjectId('507f1f77bcf86cd799439012');
const projectId = new Types.ObjectId('507f1f77bcf86cd799439020');

const seed = (pricing: Record<string, unknown> = { durationBasis: 'per_unit' }) => {
  mocks.project = {
    _id: projectId,
    status: 'published',
    professionalId: proId,
    resources: [proId.toString()],
    minResources: 1,
    subprojects: [{
      name: 'Hourly help',
      pricing: { type: 'unit', unit: 'hour', amount: 50, ...pricing },
      executionDuration: { unit: 'hours' },
    }],
  };
  mocks.professional = {
    _id: proId,
    // Mon–Fri 09:00–17:00: the longest working day is 8 hours.
    companyAvailability: {
      monday: { available: true, startTime: '09:00', endTime: '17:00' },
      tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
      wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
      thursday: { available: true, startTime: '09:00', endTime: '17:00' },
      friday: { available: true, startTime: '09:00', endTime: '17:00' },
    },
    companyBlockedDates: [],
    companyBlockedRanges: [],
    businessInfo: { timezone: TIME_ZONE, country: 'Belgium' },
  };
  mocks.members = [{ _id: proId, blockedDates: [], blockedRanges: [] }];
  mocks.bookings = [];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Sunday 1 Nov 2026; Thu 5 Nov is a working day.
  vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
  seed();
});
afterEach(() => vi.useRealTimers());

const id = () => String(projectId);

describe('FT1 6B: customer hours longer than a working day are booked in day mode', () => {
  it('proposes 16 customer hours with an 8 hour day in day mode', async () => {
    const proposals = await buildProjectScheduleProposals(id(), 0, undefined, undefined, 16);
    expect(proposals?.mode).toBe('days');
    expect(proposals?.earliestProposal).toBeDefined();
  });

  it('accepts a start date without a start time and books two working days', async () => {
    const validation = await validateProjectScheduleSelection({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 16 });
    expect(validation).toEqual({ valid: true });

    const window = await buildProjectScheduleWindow({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 16 });
    expect(window).not.toBeNull();
    // Thu 5 Nov 00:00 Brussels → end of Fri 6 Nov (17:00 Brussels = 16:00Z).
    expect(window!.scheduledStartDate.toISOString()).toBe('2026-11-04T23:00:00.000Z');
    expect(window!.scheduledExecutionEndDate.toISOString()).toBe('2026-11-06T16:00:00.000Z');
    expect(window!.scheduledStartTime).toBeUndefined();
    expect(window!.throughputDays).toBe(2);
  });

  it('skips the weekend: 17 hours from a Friday end on the following Tuesday', async () => {
    const window = await buildProjectScheduleWindow({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-06', quantity: 17 });
    expect(window!.scheduledExecutionEndDate.toISOString()).toBe('2026-11-10T16:00:00.000Z');
  });

  it('reports day mode from the slot endpoint so the form asks for a date only', async () => {
    const result = await getProjectAvailableSlotsForDate({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 16 });
    expect(result).toEqual({ slots: [], mode: 'days' });
  });

  it('keeps 4 customer hours in hour mode with a start time', async () => {
    const proposals = await buildProjectScheduleProposals(id(), 0, undefined, undefined, 4);
    expect(proposals?.mode).toBe('hours');
    const withoutTime = await validateProjectScheduleSelection({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 4 });
    expect(withoutTime).toEqual({ valid: false, reason: 'Start time required for hours mode' });
    const withTime = await validateProjectScheduleSelection({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', startTime: '10:00', quantity: 4 });
    expect(withTime).toEqual({ valid: true });
    const window = await buildProjectScheduleWindow({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', startTime: '10:00', quantity: 4 });
    expect(window!.scheduledStartTime).toBe('10:00');
    expect(window!.scheduledEndTime).toBe('14:00');
    const slots = await getProjectAvailableSlotsForDate({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 4 });
    expect(slots?.mode).toBe('hours');
    expect(slots?.slots).toContain('10:00');
  });

  it('treats a legacy hour package without a duration basis as customer hours', async () => {
    seed({});
    mocks.project.subprojects[0].executionDuration = { value: 1, unit: 'hours' };
    const window = await buildProjectScheduleWindow({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', startTime: '09:00', quantity: 6 });
    expect(window!.scheduledEndTime).toBe('15:00');
    const long = await validateProjectScheduleSelection({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 12 });
    expect(long).toEqual({ valid: true });
  });

  it('rejects a blocked start date in day mode', async () => {
    mocks.professional.companyBlockedDates = [{ date: new Date('2026-11-05T00:00:00Z'), reason: 'Closed' }];
    const validation = await validateProjectScheduleSelection({ projectId: id(), subprojectIndex: 0, startDate: '2026-11-05', quantity: 16 });
    expect(validation.valid).toBe(false);
  });
});
