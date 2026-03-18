/**
 * Working Days Utility
 * Calculates working days (Mon-Fri) for RFQ deadline tracking
 */

export function isWorkingDay(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6; // 0 = Sunday, 6 = Saturday
}

export function addWorkingDays(startDate: Date, days: number): Date {
  if (days < 0) {
    throw new RangeError('days must be a positive number');
  }
  if (days === 0) {
    return new Date(startDate);
  }

  const result = new Date(startDate);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (isWorkingDay(result)) {
      added++;
    }
  }

  return result;
}

export function getWorkingDaysBetween(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);

  while (current < end) {
    current.setDate(current.getDate() + 1);
    if (isWorkingDay(current)) {
      count++;
    }
  }

  return count;
}
