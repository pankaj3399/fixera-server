const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_REMINDER_COUNT = 5;

export function daysAgo(n: number, nowMs = Date.now()): Date {
  return new Date(nowMs - n * DAY_MS);
}

/**
 * Whether a reminder should fire given last send time, count, and interval.
 */
export function shouldSendReminder(
  lastSentAt: Date | undefined | null,
  count: number | undefined | null,
  intervalDays: number,
  maxCount = MAX_REMINDER_COUNT,
  nowMs = Date.now(),
): boolean {
  if ((count ?? 0) >= maxCount) return false;
  if (!lastSentAt) return true;
  return lastSentAt.getTime() <= nowMs - intervalDays * DAY_MS;
}

export function hasUnpaidExtras(booking: {
  extraCostTotal?: number | null;
  extraCostStatus?: string | null;
}): boolean {
  const total = Number(booking.extraCostTotal || 0);
  if (total <= 0) return false;
  const status = booking.extraCostStatus;
  return status === 'pending' || status === 'accepted' || !status;
}
