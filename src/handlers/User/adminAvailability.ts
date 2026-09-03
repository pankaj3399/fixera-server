import { Request, Response } from 'express';
import { DateTime } from 'luxon';
import User, { type IUser } from '../../models/user';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
type Day = (typeof DAYS)[number];

/** Accept HH:mm, H:mm, and browser time values that include seconds. */
export function parseClockTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?$/);
  if (!match) return undefined;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function dayLabel(day: Day): string {
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}`;
}

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeAvailability(
  input: unknown,
): { availability: IUser['availability'] } | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'Availability and blocked dates/ranges are invalid' };
  }
  const result: NonNullable<IUser['availability']> = {};
  for (const day of DAYS) {
    const raw = (input as Record<string, any>)[day] || {};
    const available = raw.available === true;
    const startTime = parseClockTime(raw.startTime);
    const endTime = parseClockTime(raw.endTime);
    if (available) {
      if (!startTime || !endTime) {
        return { error: `${dayLabel(day)} needs a start and end time` };
      }
      if (endTime <= startTime) {
        return { error: `${dayLabel(day)} end time must be after start time` };
      }
    }
    result[day] = {
      available,
      startTime: available ? startTime : undefined,
      endTime: available ? endTime : undefined,
    };
  }
  return { availability: result };
}

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_BLOCKED_DATES = 366;
const MAX_BLOCKED_RANGES = 200;

function parseDateInTimeZone(value: unknown, timeZone: string): Date | null {
  if (typeof value !== 'string' || !DATE_INPUT_PATTERN.test(value.trim())) return null;
  const trimmed = value.trim();
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed);
  const parsed = DateTime.fromISO(trimmed, hasExplicitOffset ? { setZone: true } : { zone: timeZone });
  return parsed.isValid ? parsed.toUTC().toJSDate() : null;
}

function normalizeBlockedDates(input: unknown, timeZone: string) {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_BLOCKED_DATES) return null;
  const result = [];
  for (const item of input) {
    const value = typeof item === 'string' ? item : item?.date;
    const date = parseDateInTimeZone(value, timeZone);
    if (!date) return null;
    result.push({ date, reason: typeof item?.reason === 'string' ? item.reason.trim().slice(0, 200) : undefined });
  }
  return result;
}

function normalizeBlockedRanges(input: unknown, timeZone: string) {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_BLOCKED_RANGES) return null;
  const result = [];
  for (const item of input) {
    const startDate = parseDateInTimeZone(item?.startDate, timeZone);
    const endDate = parseDateInTimeZone(item?.endDate, timeZone);
    if (!startDate || !endDate || endDate < startDate) return null;
    result.push({
      startDate,
      endDate,
      reason: typeof item?.reason === 'string' ? item.reason.trim().slice(0, 200) : undefined,
      createdAt: new Date(),
    });
  }
  return result;
}

function minutesSinceMidnight(value: string | undefined): number | null {
  const clock = parseClockTime(value);
  if (!clock) return null;
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Check a scheduled support meeting against the logged-in admin's schedule and blocks. */
export function isAdminAvailableForMeeting(
  admin: Pick<IUser, 'availability' | 'blockedDates' | 'blockedRanges' | 'timeZone' | 'adminAvailabilityConfigured'>,
  start: Date,
  durationMinutes: number,
): boolean {
  const timeZone = admin.timeZone || 'UTC';
  const startZoned = DateTime.fromJSDate(start, { zone: 'utc' }).setZone(timeZone);
  const endZoned = startZoned.plus({ minutes: durationMinutes });
  if (!startZoned.isValid || !endZoned.isValid) return false;

  let dayCursor = startZoned.startOf('day');
  const endDay = endZoned.startOf('day');
  while (dayCursor <= endDay) {
    const blockedDate = dayCursor.toISODate();
    if (
      admin.blockedDates?.some(
        (item: any) =>
          DateTime.fromJSDate(new Date(item.date), { zone: 'utc' }).setZone(timeZone).toISODate() === blockedDate,
      )
    ) {
      return false;
    }
    dayCursor = dayCursor.plus({ days: 1 });
  }

  if (admin.blockedRanges?.some((range: any) => {
    const rangeStart = new Date(range.startDate).getTime();
    const rangeEnd = new Date(range.endDate).getTime();
    return Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeStart < endZoned.toMillis() && rangeEnd > start.getTime();
  })) {
    return false;
  }

  const availability = admin.availability as Record<string, any> | undefined;
  const hasConfiguredSchedule = Boolean(
    admin.adminAvailabilityConfigured ||
      (availability && Object.values(availability).some((day) => day && typeof day === 'object' && (day.startTime || day.endTime))),
  );
  if (!hasConfiguredSchedule) return true;

  if (startZoned.toISODate() !== endZoned.toISODate()) return false;

  const dayKey = startZoned.toFormat('cccc').toLowerCase();
  const day = availability?.[dayKey];
  const scheduleStart = minutesSinceMidnight(day?.startTime);
  const scheduleEnd = minutesSinceMidnight(day?.endTime);
  const meetingStart = startZoned.hour * 60 + startZoned.minute;
  const meetingEnd = endZoned.hour * 60 + endZoned.minute;
  return day?.available === true && scheduleStart !== null && scheduleEnd !== null && meetingStart >= scheduleStart && meetingEnd <= scheduleEnd;
}

function serialize(user: IUser) {
  return {
    availability: user.availability || {},
    blockedDates: user.blockedDates || [],
    blockedRanges: user.blockedRanges || [],
    timeZone: user.timeZone || 'UTC',
  };
}

export const getAdminAvailability = async (req: Request, res: Response) => {
  const user = req.user as IUser | undefined;
  if (!user || user.role !== 'admin') return res.status(403).json({ success: false, msg: 'Admin access required' });
  return res.json({ success: true, data: serialize(user) });
};

export const updateAdminAvailability = async (req: Request, res: Response) => {
  const user = req.user as IUser | undefined;
  if (!user || user.role !== 'admin') return res.status(403).json({ success: false, msg: 'Admin access required' });

  const timeZone = req.body?.timeZone;
  if (!isValidTimeZone(timeZone)) {
    return res.status(400).json({ success: false, msg: 'A valid IANA time zone is required' });
  }
  const availability = normalizeAvailability(req.body?.availability);
  const blockedDates = normalizeBlockedDates(req.body?.blockedDates, timeZone);
  const blockedRanges = normalizeBlockedRanges(req.body?.blockedRanges, timeZone);
  if ('error' in availability) {
    return res.status(400).json({ success: false, msg: availability.error });
  }
  if (!blockedDates || !blockedRanges) {
    return res.status(400).json({ success: false, msg: 'Availability and blocked dates/ranges are invalid' });
  }

  user.availability = availability.availability;
  user.blockedDates = blockedDates;
  user.blockedRanges = blockedRanges;
  user.timeZone = timeZone.trim();
  user.adminAvailabilityConfigured = true;
  await user.save();
  return res.json({ success: true, data: serialize(user) });
};
