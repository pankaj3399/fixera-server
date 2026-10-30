import { describe, expect, it } from 'vitest';
import {
  findCoveringAssignmentForDays,
  isDayBlockedByCoveredMinutes,
  MIN_FREE_HOURS_FOR_DAY_AVAILABILITY,
  type PerMemberBlockedData,
} from '../../utils/scheduleEngine';
import { resolveAvailability } from '../../utils/availabilityHelpers';

const TIME_ZONE = 'UTC';

// Monday 2026-11-02 00:00Z; engine "zoned" days equal UTC days for UTC.
const day = (year: number, month: number, date: number, hours = 0, minutes = 0): Date =>
  new Date(Date.UTC(year, month - 1, date, hours, minutes, 0, 0));

const fullWeek = (overrides: Record<string, any> = {}) =>
  resolveAvailability({
    monday: { available: true, startTime: '09:00', endTime: '17:00' },
    tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
    wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
    thursday: { available: true, startTime: '09:00', endTime: '17:00' },
    friday: { available: true, startTime: '09:00', endTime: '17:00' },
    saturday: { available: false },
    sunday: { available: false },
    ...overrides,
  });

const memberWithRanges = (ranges: Array<{ start: Date; end: Date }>, dates: string[] = []) =>
  new Map<string, { blockedDates: Set<string>; blockedRanges: Array<{ start: Date; end: Date }> }>([
    ['m1', { blockedDates: new Set(dates), blockedRanges: ranges }],
  ]) as PerMemberBlockedData;

const cover = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startZoned: Date,
  extra: Record<string, any> = {}
) =>
  findCoveringAssignmentForDays({
    perMemberBlocked,
    availability,
    startZoned,
    executionDays: 1,
    minResources: 1,
    minOverlapPercentage: 100,
    resourceIds: ['m1'],
    timeZone: TIME_ZONE,
    ...extra,
  });

describe('day-mode 3-hour free threshold (client bug list #2)', () => {
  it('exposes the 3-hour named threshold', () => {
    expect(MIN_FREE_HOURS_FOR_DAY_AVAILABILITY).toBe(3);
  });

  it('blocks a day with only 2 free hours, allows a day with 3 free hours', () => {
    // 8h schedule: 6h covered -> 2h free -> blocked.
    expect(isDayBlockedByCoveredMinutes(360, 480)).toBe(true);
    // 5h covered -> exactly 3h free -> available.
    expect(isDayBlockedByCoveredMinutes(300, 480)).toBe(false);
    // Nothing covered -> available; fully covered -> blocked.
    expect(isDayBlockedByCoveredMinutes(0, 480)).toBe(false);
    expect(isDayBlockedByCoveredMinutes(480, 480)).toBe(true);
    // No working schedule -> blocked.
    expect(isDayBlockedByCoveredMinutes(0, 0)).toBe(true);
  });

  it('skips a Monday with only 2 free hours and covers one with 3 free hours', () => {
    const availability = fullWeek();
    const monday = day(2026, 11, 2);

    const twoFree = memberWithRanges([{ start: day(2026, 11, 2, 10), end: day(2026, 11, 2, 16) }]);
    const skipped = cover(twoFree, availability, monday);
    // Monday is skipped; the single execution day lands on Tuesday.
    expect(skipped?.assignment[0].dayKey).toBe('2026-11-03');

    const threeFree = memberWithRanges([{ start: day(2026, 11, 2, 10), end: day(2026, 11, 2, 15) }]);
    const covered = cover(threeFree, availability, monday);
    expect(covered?.assignment[0].dayKey).toBe('2026-11-02');
    expect(covered?.endZonedDay.toISOString().slice(0, 10)).toBe('2026-11-02');
  });

  it('counts split blocks on the same day together', () => {
    const availability = fullWeek();
    const monday = day(2026, 11, 2);

    // 2.5h + 2.5h = 5h covered, 3h free -> available.
    const splitAvailable = memberWithRanges([
      { start: day(2026, 11, 2, 9), end: day(2026, 11, 2, 11, 30) },
      { start: day(2026, 11, 2, 13, 30), end: day(2026, 11, 2, 16) },
    ]);
    expect(cover(splitAvailable, availability, monday)?.assignment[0].dayKey).toBe('2026-11-02');

    // 3h + 3h = 6h covered, 2h free -> blocked even though each chunk is under 4h.
    const splitBlocked = memberWithRanges([
      { start: day(2026, 11, 2, 9), end: day(2026, 11, 2, 12) },
      { start: day(2026, 11, 2, 13), end: day(2026, 11, 2, 16) },
    ]);
    expect(cover(splitBlocked, availability, monday)?.assignment[0].dayKey).toBe('2026-11-03');
  });

  it('applies the free-hours rule relative to short working days', () => {
    const availability = fullWeek({
      wednesday: { available: true, startTime: '09:00', endTime: '13:00' },
    });
    const wednesday = day(2026, 11, 4);

    // 4h schedule, 2h blocked -> 2h free -> blocked.
    const shortBlocked = memberWithRanges([{ start: day(2026, 11, 4, 9), end: day(2026, 11, 4, 11) }]);
    expect(cover(shortBlocked, availability, wednesday)?.assignment[0].dayKey).toBe('2026-11-05');

    // 4h schedule, 1h blocked -> 3h free -> available.
    const shortAvailable = memberWithRanges([{ start: day(2026, 11, 4, 9), end: day(2026, 11, 4, 10) }]);
    expect(cover(shortAvailable, availability, wednesday)?.assignment[0].dayKey).toBe('2026-11-04');
  });
});

describe('per-day resource substitution (client bug list #22a)', () => {
  it('substitutes an available resource instead of prolonging the booking', () => {
    const availability = fullWeek();
    const monday = day(2026, 11, 2);
    const perMemberBlocked = new Map([
      ['m1', { blockedDates: new Set(['2026-11-02']), blockedRanges: [] }],
      ['m2', { blockedDates: new Set<string>(), blockedRanges: [] }],
      ['m3', { blockedDates: new Set<string>(), blockedRanges: [] }],
    ]) as PerMemberBlockedData;

    const covering = findCoveringAssignmentForDays({
      perMemberBlocked,
      availability,
      startZoned: monday,
      executionDays: 2,
      minResources: 2,
      minOverlapPercentage: 90,
      resourceIds: ['m1', 'm2', 'm3'],
      timeZone: TIME_ZONE,
    });

    // Michal-style substitution: Monday is covered by m2+m3, no prolongation.
    expect(covering?.assignment.map((entry) => entry.dayKey)).toEqual(['2026-11-02', '2026-11-03']);
    expect(covering?.assignment[0].resourceIds).toEqual(['m2', 'm3']);
    expect(covering?.endZonedDay.toISOString().slice(0, 10)).toBe('2026-11-03');
    expect(covering?.assignedResourceIds).toEqual(['m2', 'm3']);
  });

  it('returns null when no day can meet the minimum resources', () => {
    const availability = fullWeek();
    const perMemberBlocked = new Map([
      ['m1', { blockedDates: new Set(['2026-11-02']), blockedRanges: [] }],
      ['m2', { blockedDates: new Set(['2026-11-02']), blockedRanges: [] }],
    ]) as PerMemberBlockedData;

    const covering = findCoveringAssignmentForDays({
      perMemberBlocked,
      availability,
      startZoned: day(2026, 11, 2),
      executionDays: 1,
      minResources: 2,
      minOverlapPercentage: 100,
      resourceIds: ['m1', 'm2'],
      timeZone: TIME_ZONE,
      maxIterations: 1,
    });
    expect(covering).toBeNull();
  });

  it('honours the solo-day budget when overlap is below 100%', () => {
    const availability = fullWeek();
    const perMemberBlocked = new Map([
      ['m1', { blockedDates: new Set<string>(), blockedRanges: [] }],
      [
        'm2',
        {
          blockedDates: new Set<string>(),
          blockedRanges: [{ start: day(2026, 11, 2), end: day(2026, 11, 2, 23, 59) }],
        },
      ],
    ]) as PerMemberBlockedData;

    // 50% overlap on 2 days allows one solo day: Monday counts with only m1,
    // Tuesday is covered by the substituted pair.
    const covering = findCoveringAssignmentForDays({
      perMemberBlocked,
      availability,
      startZoned: day(2026, 11, 2),
      executionDays: 2,
      minResources: 2,
      minOverlapPercentage: 50,
      resourceIds: ['m1', 'm2'],
      timeZone: TIME_ZONE,
    });
    expect(covering?.assignment.map((entry) => entry.dayKey)).toEqual(['2026-11-02', '2026-11-03']);
    expect(covering?.assignment[0]).toMatchObject({ dayKey: '2026-11-02', resourceIds: ['m1'] });
    expect(covering?.assignment[1].resourceIds).toEqual(['m1', 'm2']);
  });
});
