import { expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
const mocks = vi.hoisted(() => ({ project: { executionDuration: { value: 2, unit: 'days' }, minResources: 2, minOverlapPercentage: 50, resources: [] as string[] } }));
vi.mock('../../models/user', () => ({ default: { findById: () => ({ select: async () => ({ businessInfo: { timezone: 'UTC' } }) }) } }));
vi.mock('../../models/project', () => ({ default: { findById: () => ({ select: async () => mocks.project }) } }));
vi.mock('../../utils/bookingHelpers', () => ({ getProfessionalId: async (booking: any) => booking.professional }));
vi.mock('../../utils/scheduleEngine', async original => ({
  ...await original<any>(), buildPerResourceBlockedDays: async () => new Map(),
}));
import { applyReschedulePlanReset } from '../../utils/applyReschedulePlanReset';

it('keeps a validated substitution plan with allowed solo days without multiplying its attendee union', async () => {
  const [a, b, c] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
  mocks.project.resources = [String(a), String(b), String(c)];
  const covering = [
    { resourceId: a, days: [new Date('2027-01-11')] },
    { resourceId: b, days: [new Date('2027-01-11')] },
    { resourceId: c, days: [new Date('2027-01-12')] },
  ];
  const previous = [{ resourceId: a, days: [new Date('2027-01-04'), new Date('2027-01-20')] }];
  const booking: any = {
    _id: new Types.ObjectId(), professional: a, project: new Types.ObjectId(),
    assignedTeamMembers: [a, b, c], resourcePlan: covering,
    scheduledStartDate: new Date('2027-01-11'), scheduledExecutionEndDate: new Date('2027-01-12T17:00Z'),
  };
  await applyReschedulePlanReset(booking, a, covering, previous);
  expect(booking.resourcePlan.map((entry: any) => ({ resourceId: String(entry.resourceId), days: entry.days.map((day: Date) => day.toISOString().slice(0, 10)) }))).toEqual([
    { resourceId: String(a), days: ['2027-01-11', '2027-01-20'] },
    { resourceId: String(b), days: ['2027-01-11'] },
    { resourceId: String(c), days: ['2027-01-12'] },
  ]);
});
