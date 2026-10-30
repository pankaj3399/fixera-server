/**
 * Hour-mode legacy schedule repair helpers (client bug list #23b/c, blocker 2).
 *
 * Legacy hour-mode bookings were stored wall-as-UTC (14:00 Brussels stored as
 * `14:00Z`) because the professional's business timezone was missing (the
 * schema default `'UTC'`). Those rows render +offset (15:00 in Brussels).
 *
 * All helpers below are pure (no database access) so they are unit-testable.
 * This module stays light (luxon + geocoding only): the schedule engine
 * imports the country mapping from here, never the reverse. The migration
 * script `migrateHourModeScheduleTimeZones.ts` performs the IO: it detects
 * candidate rows, shifts the stored instants by the DST-aware wall mismatch,
 * and rebuilds calendar reservations idempotently.
 *
 * Field rules (do not shift anything else):
 * - SHIFT (UTC instants that encode the wall time): scheduledStartDate,
 *   scheduledExecutionEndDate, scheduledBufferStartDate,
 *   scheduledBufferEndDate, and a pending rescheduleRequest.proposedSchedule's
 *   scheduled*Date fields (they become live on accept).
 * - NEVER SHIFT: scheduledStartTime/scheduledEndTime strings (the wall-clock
 *   intent), resourcePlan day entries (UTC-midnight day granularity), previous
 *   schedules/history (immutable records), or any day-mode row (no wall
 *   times recorded).
 */
import { DateTime } from 'luxon';
import { getCountryCode } from './geocoding';

export const BUSINESS_COUNTRY_PRIMARY_TIMEZONES: Record<string, string> = {
  BE: 'Europe/Brussels',
  NL: 'Europe/Amsterdam',
  LU: 'Europe/Luxembourg',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
};

/**
 * Primary IANA zone for a business country (ISO code or English name).
 * Returns null when the country is unknown or unmapped.
 */
export const primaryTimeZoneForCountry = (country: unknown): string | null => {
  const raw = String(country || '').trim();
  if (!raw) return null;
  const code = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : getCountryCode(raw);
  return (code && BUSINESS_COUNTRY_PRIMARY_TIMEZONES[code]) || null;
};

export const HOUR_WALL_TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "14:00" -> minutes since midnight, or null when not a wall time. */
export const parseWallMinutes = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(HOUR_WALL_TIME_RE);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Minutes since midnight rendered in `timeZone`, or null for invalid input. */
export const renderWallMinutes = (instant: Date, timeZone: string): number | null => {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;
  const dt = DateTime.fromJSDate(instant, { zone: 'utc' }).setZone(timeZone);
  return dt.isValid ? dt.hour * 60 + dt.minute : null;
};

export interface WallMismatch {
  match: boolean;
  /** DST-aware shift to apply (want - rendered), in milliseconds. */
  deltaMs: number;
  renderedMinutes: number | null;
}

/**
 * Compare the rendered wall time of a stored instant against the intended
 * wall time. The delta is computed for the instant's own date in the zone,
 * so DST transitions are handled per row.
 */
export const computeWallMismatch = (params: {
  instant: Date;
  wantTime: unknown;
  timeZone: string;
}): WallMismatch => {
  const want = parseWallMinutes(params.wantTime);
  const rendered = renderWallMinutes(params.instant, params.timeZone);
  if (want == null || rendered == null) {
    return { match: false, deltaMs: 0, renderedMinutes: rendered };
  }
  return { match: want === rendered, deltaMs: (want - rendered) * 60 * 1000, renderedMinutes: rendered };
};

/**
 * A row is a legacy wall-as-UTC suspect only when it records hour-mode wall
 * times (BOTH start and end — RFQ date-only rows set no end time) and its
 * recorded zone is missing or the untouched 'UTC' default. Correct new rows
 * carry a real zone and are never candidates.
 */
export const isLegacyHourScheduleCandidate = (booking: {
  scheduledStartTime?: unknown;
  scheduledEndTime?: unknown;
  scheduledStartDate?: unknown;
  scheduledExecutionEndDate?: unknown;
  scheduleTimeZone?: unknown;
}): boolean => {
  if (parseWallMinutes(booking?.scheduledStartTime) == null) return false;
  if (parseWallMinutes(booking?.scheduledEndTime) == null) return false;
  const start = booking?.scheduledStartDate;
  const end = booking?.scheduledExecutionEndDate;
  const startMs = start instanceof Date ? start.getTime() : NaN;
  const endMs = end instanceof Date ? end.getTime() : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  const zone = booking?.scheduleTimeZone;
  return zone == null || String(zone).trim().toUpperCase() === 'UTC';
};

export const shiftInstant = (value: Date, deltaMs: number): Date =>
  new Date(value.getTime() + deltaMs);

export interface ShiftableSchedule {
  scheduledStartDate: Date;
  scheduledExecutionEndDate: Date;
  scheduledBufferStartDate?: Date | null;
  scheduledBufferEndDate?: Date | null;
}

/** Shift every defined instant by the wall-mismatch delta (duration-preserving). */
export const computeShiftedSchedule = (
  schedule: ShiftableSchedule,
  deltaMs: number
): ShiftableSchedule => ({
  scheduledStartDate: shiftInstant(schedule.scheduledStartDate, deltaMs),
  scheduledExecutionEndDate: shiftInstant(schedule.scheduledExecutionEndDate, deltaMs),
  ...(schedule.scheduledBufferStartDate
    ? { scheduledBufferStartDate: shiftInstant(schedule.scheduledBufferStartDate, deltaMs) }
    : {}),
  ...(schedule.scheduledBufferEndDate
    ? { scheduledBufferEndDate: shiftInstant(schedule.scheduledBufferEndDate, deltaMs) }
    : {}),
});

/** Backfill zone for a professional with a 'UTC'/missing stored zone. */
export const resolveProfessionalBackfillZone = (businessInfo: {
  timezone?: unknown;
  country?: unknown;
} | null | undefined): string | null => {
  const stored = businessInfo?.timezone;
  if (typeof stored === 'string' && stored.trim() && stored.trim().toUpperCase() !== 'UTC') {
    return stored.trim();
  }
  return primaryTimeZoneForCountry(businessInfo?.country);
};
