const SHORT_BOOKING_THRESHOLD_HOURS = 4;

const toDate = (value?: Date): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

type BlockedRangeLike = {
  startDate?: Date;
  endDate?: Date;
  reason?: string;
  executionEndDate?: Date;
};

export const normalizeBlockedRangesForShortBookings = <T extends BlockedRangeLike>(
  ranges?: T[]
): T[] | undefined => {
  if (!ranges || !Array.isArray(ranges)) {
    return ranges;
  }

  return ranges.map((range) => {
    if (!range || typeof range !== "object") {
      return range;
    }

    if (
      typeof range.reason !== "string" ||
      !range.reason.startsWith("project-booking:")
    ) {
      return range;
    }

    const start = toDate(range.startDate);
    const executionEnd = toDate(range.executionEndDate);
    if (!start || !executionEnd) {
      return range;
    }

    const executionHours =
      (executionEnd.getTime() - start.getTime()) / (1000 * 60 * 60);

    if (executionHours <= SHORT_BOOKING_THRESHOLD_HOURS) {
      return {
        ...range,
        endDate: executionEnd,
      } as T;
    }

    return range;
  });
};
