import { describe, expect, it } from 'vitest';
import {
  computeShiftedSchedule,
  computeWallMismatch,
  isLegacyHourScheduleCandidate,
  parseWallMinutes,
  primaryTimeZoneForCountry,
  renderWallMinutes,
  resolveProfessionalBackfillZone,
} from '../../utils/hourScheduleRepair';

const BRUSSELS = 'Europe/Brussels';

describe('hour schedule repair helpers (client bug list #23b/c, blocker 2)', () => {
  it('parses wall times strictly', () => {
    expect(parseWallMinutes('14:00')).toBe(840);
    expect(parseWallMinutes('9:05')).toBe(545);
    expect(parseWallMinutes('24:00')).toBeNull();
    expect(parseWallMinutes('14:60')).toBeNull();
    expect(parseWallMinutes('')).toBeNull();
    expect(parseWallMinutes(undefined)).toBeNull();
    expect(parseWallMinutes('14:00:00')).toBeNull();
  });

  it('renders wall minutes in the professional zone', () => {
    // Winter (CET): 14:00Z renders 15:00 Brussels.
    expect(renderWallMinutes(new Date('2026-11-05T14:00:00.000Z'), BRUSSELS)).toBe(900);
    // Summer (CEST): 14:00Z renders 16:00 Brussels.
    expect(renderWallMinutes(new Date('2026-07-02T14:00:00.000Z'), BRUSSELS)).toBe(960);
    expect(renderWallMinutes(new Date('2026-11-05T13:00:00.000Z'), BRUSSELS)).toBe(840);
  });

  it('detects the legacy wall-as-UTC mismatch with a DST-aware delta (winter)', () => {
    const mismatch = computeWallMismatch({
      instant: new Date('2026-11-05T14:00:00.000Z'),
      wantTime: '14:00',
      timeZone: BRUSSELS,
    });
    expect(mismatch.match).toBe(false);
    expect(mismatch.deltaMs).toBe(-3600000);
  });

  it('detects the legacy wall-as-UTC mismatch with a DST-aware delta (summer)', () => {
    const mismatch = computeWallMismatch({
      instant: new Date('2026-07-02T14:00:00.000Z'),
      wantTime: '14:00',
      timeZone: BRUSSELS,
    });
    expect(mismatch.match).toBe(false);
    expect(mismatch.deltaMs).toBe(-7200000);
  });

  it('matches already-correct rows and is idempotent on re-run', () => {
    const correct = computeWallMismatch({
      instant: new Date('2026-11-05T13:00:00.000Z'),
      wantTime: '14:00',
      timeZone: BRUSSELS,
    });
    expect(correct).toMatchObject({ match: true, deltaMs: 0 });

    // Simulate one migration shift, then re-check: still a match.
    const shifted = new Date(new Date('2026-11-05T14:00:00.000Z').getTime() - 3600000);
    expect(
      computeWallMismatch({ instant: shifted, wantTime: '14:00', timeZone: BRUSSELS })
    ).toMatchObject({ match: true, deltaMs: 0 });
  });

  it('shifts every defined instant by the same delta (duration-preserving)', () => {
    const shifted = computeShiftedSchedule(
      {
        scheduledStartDate: new Date('2026-11-05T14:00:00.000Z'),
        scheduledExecutionEndDate: new Date('2026-11-05T16:00:00.000Z'),
        scheduledBufferStartDate: new Date('2026-11-05T16:00:00.000Z'),
        scheduledBufferEndDate: new Date('2026-11-05T16:00:00.000Z'),
      },
      -3600000
    );
    expect(shifted.scheduledStartDate.toISOString()).toBe('2026-11-05T13:00:00.000Z');
    expect(shifted.scheduledExecutionEndDate.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(shifted.scheduledBufferStartDate!.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(shifted.scheduledBufferEndDate!.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    // Duration preserved.
    expect(
      shifted.scheduledExecutionEndDate.getTime() - shifted.scheduledStartDate.getTime()
    ).toBe(2 * 3600000);
    // Shifted end renders the recorded end time.
    expect(renderWallMinutes(shifted.scheduledExecutionEndDate, BRUSSELS)).toBe(
      parseWallMinutes('16:00')
    );
  });

  it('identifies legacy hour-mode candidates only', () => {
    const hourLegacy = {
      scheduledStartTime: '14:00',
      scheduledEndTime: '16:00',
      scheduledStartDate: new Date('2026-11-05T14:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2026-11-05T16:00:00.000Z'),
      scheduleTimeZone: null,
    };
    expect(isLegacyHourScheduleCandidate(hourLegacy)).toBe(true);
    expect(isLegacyHourScheduleCandidate({ ...hourLegacy, scheduleTimeZone: 'UTC' })).toBe(true);
    // Correct new rows carry a real zone.
    expect(isLegacyHourScheduleCandidate({ ...hourLegacy, scheduleTimeZone: BRUSSELS })).toBe(false);
    // Day-mode rows record no wall times.
    expect(
      isLegacyHourScheduleCandidate({
        scheduledStartDate: new Date('2026-11-05T13:00:00.000Z'),
        scheduledExecutionEndDate: new Date('2026-11-06T13:00:00.000Z'),
        scheduleTimeZone: null,
      })
    ).toBe(false);
    // RFQ date-only rows set no end time.
    expect(
      isLegacyHourScheduleCandidate({
        ...hourLegacy,
        scheduledEndTime: undefined,
      })
    ).toBe(false);
    // Missing instants are not shiftable.
    expect(
      isLegacyHourScheduleCandidate({ ...hourLegacy, scheduledExecutionEndDate: null })
    ).toBe(false);
  });

  it('maps business countries to primary zones', () => {
    expect(primaryTimeZoneForCountry('Belgium')).toBe('Europe/Brussels');
    expect(primaryTimeZoneForCountry('BE')).toBe('Europe/Brussels');
    expect(primaryTimeZoneForCountry('FR')).toBe('Europe/Paris');
    expect(primaryTimeZoneForCountry('XX')).toBeNull();
    expect(primaryTimeZoneForCountry('')).toBeNull();
    expect(primaryTimeZoneForCountry(undefined)).toBeNull();
  });

  it('resolves a professional backfill zone without touching real zones', () => {
    expect(resolveProfessionalBackfillZone({ timezone: 'UTC', country: 'BE' })).toBe(
      'Europe/Brussels'
    );
    expect(resolveProfessionalBackfillZone({ country: 'Belgium' })).toBe('Europe/Brussels');
    expect(resolveProfessionalBackfillZone({ timezone: 'Europe/Paris', country: 'BE' })).toBe(
      'Europe/Paris'
    );
    expect(resolveProfessionalBackfillZone({ timezone: 'UTC', country: 'XX' })).toBeNull();
    expect(resolveProfessionalBackfillZone(null)).toBeNull();
  });
});
