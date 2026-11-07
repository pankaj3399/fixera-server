import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  bookingCalendarInterval,
  bookingCalendarMemberIds,
  bookingCalendarOccupancies,
  buildBookingCalendarKeys,
} from '../../../utils/support/bookingCalendar';

const professionalId = '507f1f77bcf86cd799439012';
const employeeId = '507f1f77bcf86cd799439013';
const unrelatedId = '507f1f77bcf86cd799439099';

const baseBooking = {
  _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
  professional: new Types.ObjectId(professionalId),
  assignedTeamMembers: [new Types.ObjectId(employeeId)],
  scheduledStartDate: new Date('2026-11-04T08:00:00.000Z'),
  scheduledExecutionEndDate: new Date('2026-11-04T09:00:00.000Z'),
  scheduledBufferEndDate: new Date('2026-11-04T09:30:00.000Z'),
};

describe('booking calendar reservation keys', () => {
  it('reserves only the attending resources, never uninvolved users (client bug list #24b)', () => {
    // assignedTeamMembers=[employee] with no plan: only the employee attends,
    // so the professional must not be blocked (no double booking).
    expect(bookingCalendarMemberIds(baseBooking).sort()).toEqual([employeeId]);
    expect(bookingCalendarMemberIds(baseBooking)).not.toContain(unrelatedId);

    const keys = buildBookingCalendarKeys(baseBooking);
    expect(new Set(keys.map((key) => key.userId.toString()))).toEqual(
      new Set([employeeId]),
    );
    // 08:00-09:30 covers six 15-minute buckets for the single attendee.
    expect(keys).toHaveLength(6);
    expect(keys.map((key) => key.key)).toContain(
      `professional:${employeeId}:2026-11-04T08:00:00.000Z`,
    );
  });

  it('falls back to the professional for legacy rows without attendees', () => {
    const legacy = {
      _id: baseBooking._id,
      professional: new Types.ObjectId(professionalId),
      scheduledStartDate: baseBooking.scheduledStartDate,
      scheduledExecutionEndDate: baseBooking.scheduledExecutionEndDate,
      scheduledBufferEndDate: baseBooking.scheduledBufferEndDate,
    };
    expect(bookingCalendarMemberIds(legacy)).toEqual([professionalId]);
  });

  it('uses the buffer end as the occupied interval and ignores incomplete schedules', () => {
    expect(bookingCalendarInterval(baseBooking)).toEqual({
      startAt: baseBooking.scheduledStartDate,
      endAt: baseBooking.scheduledBufferEndDate,
    });
    expect(bookingCalendarInterval({ ...baseBooking, scheduledBufferEndDate: null })).toEqual({
      startAt: baseBooking.scheduledStartDate,
      endAt: baseBooking.scheduledExecutionEndDate,
    });
    expect(bookingCalendarInterval({ ...baseBooking, scheduledExecutionEndDate: null, scheduledBufferEndDate: null })).toBeNull();
    expect(buildBookingCalendarKeys({ ...baseBooking, scheduledExecutionEndDate: null, scheduledBufferEndDate: null })).toEqual([]);
  });

  it('reserves only a planned day instead of the whole four-day project window', () => {
    const fourDay = {
      ...baseBooking,
      scheduledStartDate: new Date('2026-11-04T08:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2026-11-07T17:00:00.000Z'),
      scheduledBufferEndDate: new Date('2026-11-07T17:00:00.000Z'),
      resourcePlan: [
        { resourceId: new Types.ObjectId(professionalId), days: [new Date('2026-11-04T00:00:00.000Z')] },
        { resourceId: new Types.ObjectId(employeeId), days: [new Date('2026-11-04T00:00:00.000Z')] },
      ],
    };
    const keys = buildBookingCalendarKeys(fourDay);
    // One UTC day = 96 quarter-hour buckets per member.
    expect(keys).toHaveLength(192);
    const days = new Set(keys.map((key) => key.startAt.toISOString().slice(0, 10)));
    expect(Array.from(days)).toEqual(['2026-11-04']);
    expect(new Set(keys.map((key) => key.userId.toString()))).toEqual(
      new Set([professionalId, employeeId]),
    );
  });

  it('keeps disjoint planned members/days separate and leaves unplanned members free', () => {
    const disjoint = {
      ...baseBooking,
      scheduledStartDate: new Date('2026-11-04T08:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2026-11-07T17:00:00.000Z'),
      scheduledBufferEndDate: new Date('2026-11-07T17:00:00.000Z'),
      assignedTeamMembers: [
        new Types.ObjectId(employeeId),
        new Types.ObjectId(unrelatedId),
      ],
      resourcePlan: [
        { resourceId: new Types.ObjectId(professionalId), days: [new Date('2026-11-04T00:00:00.000Z')] },
        { resourceId: new Types.ObjectId(employeeId), days: [new Date('2026-11-06T00:00:00.000Z')] },
      ],
    };
    const keys = buildBookingCalendarKeys(disjoint);
    expect(keys).toHaveLength(192);
    const professionalDays = new Set(
      keys.filter((key) => key.userId.toString() === professionalId)
        .map((key) => key.startAt.toISOString().slice(0, 10)),
    );
    const employeeDays = new Set(
      keys.filter((key) => key.userId.toString() === employeeId)
        .map((key) => key.startAt.toISOString().slice(0, 10)),
    );
    expect(Array.from(professionalDays)).toEqual(['2026-11-04']);
    expect(Array.from(employeeDays)).toEqual(['2026-11-06']);
    expect(keys.some((key) => key.userId.toString() === unrelatedId)).toBe(false);
  });

  it('falls back to the whole window only when the plan no longer touches it', () => {
    const stalePlan = {
      ...baseBooking,
      scheduledStartDate: new Date('2026-12-01T08:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2026-12-01T12:00:00.000Z'),
      scheduledBufferEndDate: new Date('2026-12-01T12:00:00.000Z'),
      resourcePlan: [
        { resourceId: new Types.ObjectId(professionalId), days: [new Date('2026-11-04T00:00:00.000Z')] },
      ],
    };
    const occupancies = bookingCalendarOccupancies(stalePlan);
    expect(occupancies).toHaveLength(2);
    expect(occupancies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: professionalId,
        startAt: stalePlan.scheduledStartDate,
        endAt: stalePlan.scheduledBufferEndDate,
      }),
      expect.objectContaining({
        userId: employeeId,
        startAt: stalePlan.scheduledStartDate,
        endAt: stalePlan.scheduledBufferEndDate,
      }),
    ]));
  });
});
