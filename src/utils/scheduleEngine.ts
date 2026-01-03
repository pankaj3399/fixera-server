import Booking from "../models/booking";
import Project from "../models/project";
import User from "../models/user";
import { DEFAULT_AVAILABILITY, resolveAvailability } from "./availabilityHelpers";

type DurationUnit = "hours" | "days";

type Duration = {
  value: number;
  unit: DurationUnit;
};

type ProposalWindow = {
  start: string;
  end: string;
  executionEnd: string;
};

export type ScheduleProposals = {
  mode: DurationUnit;
  earliestBookableDate: string;
  earliestProposal?: ProposalWindow;
  shortestThroughputProposal?: ProposalWindow;
};

type CustomerBlocks = {
  dates?: Array<{ date: string | Date; reason?: string }>;
  windows?: Array<{
    date: string | Date;
    startTime: string;
    endTime: string;
    reason?: string;
  }>;
};

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const PARTIAL_BLOCK_THRESHOLD_HOURS = 4;

const getTimeZoneOffsetMinutes = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const partLookup: Record<string, string> = {};
  parts.forEach((part) => {
    partLookup[part.type] = part.value;
  });

  const utcTime = Date.UTC(
    Number(partLookup.year),
    Number(partLookup.month) - 1,
    Number(partLookup.day),
    Number(partLookup.hour),
    Number(partLookup.minute),
    Number(partLookup.second)
  );

  return (utcTime - date.getTime()) / 60000;
};

const toZonedTime = (date: Date, timeZone: string) => {
  const offsetMinutes = getTimeZoneOffsetMinutes(date, timeZone);
  return new Date(date.getTime() + offsetMinutes * 60000);
};

const fromZonedTime = (zonedDate: Date, timeZone: string) => {
  const offsetMinutes = getTimeZoneOffsetMinutes(zonedDate, timeZone);
  return new Date(zonedDate.getTime() - offsetMinutes * 60000);
};

const startOfDayZoned = (zonedDate: Date) =>
  new Date(
    Date.UTC(
      zonedDate.getUTCFullYear(),
      zonedDate.getUTCMonth(),
      zonedDate.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );

const addDaysZoned = (zonedDate: Date, days: number) => {
  const next = new Date(zonedDate.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const formatDateKey = (zonedDate: Date) => {
  const year = zonedDate.getUTCFullYear();
  const month = String(zonedDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(zonedDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseTimeToMinutes = (value?: string) => {
  if (!value) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const formatMinutesToTime = (minutesFromMidnight: number) => {
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const buildZonedTime = (zonedDate: Date, minutesFromMidnight: number) => {
  const base = startOfDayZoned(zonedDate);
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  base.setUTCHours(hours, minutes, 0, 0);
  return base;
};

const getWorkingHoursForDate = (
  availability: Record<string, any>,
  zonedDate: Date
) => {
  const dayKey = DAY_KEYS[zonedDate.getUTCDay()];
  const dayAvailability = availability?.[dayKey];
  if (!dayAvailability || dayAvailability.available === false) {
    return {
      available: false,
      startMinutes: null,
      endMinutes: null,
      startTime: null,
      endTime: null,
    };
  }

  const defaultDay = DEFAULT_AVAILABILITY[dayKey];
  const startTime = dayAvailability.startTime || defaultDay.startTime || "09:00";
  const endTime = dayAvailability.endTime || defaultDay.endTime || "17:00";
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);

  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return {
      available: false,
      startMinutes: null,
      endMinutes: null,
      startTime: null,
      endTime: null,
    };
  }

  return {
    available: true,
    startMinutes,
    endMinutes,
    startTime,
    endTime,
  };
};

const getPrepHoursForDate = (
  availability: Record<string, any>,
  zonedDate: Date
) => {
  const dayKey = DAY_KEYS[zonedDate.getUTCDay()];
  const dayAvailability = availability?.[dayKey] || {};
  const defaultDay = DEFAULT_AVAILABILITY[dayKey];
  const startTime = dayAvailability.startTime || defaultDay.startTime || "09:00";
  const endTime = dayAvailability.endTime || defaultDay.endTime || "17:00";
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);

  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    return {
      startMinutes: null,
      endMinutes: null,
      startTime: null,
      endTime: null,
    };
  }

  return {
    startMinutes,
    endMinutes,
    startTime,
    endTime,
  };
};

const getProjectDurations = (project: any, subprojectIndex?: number) => {
  const subproject =
    typeof subprojectIndex === "number" &&
    Array.isArray(project.subprojects) &&
    project.subprojects[subprojectIndex]
      ? project.subprojects[subprojectIndex]
      : null;

  const execution = subproject?.executionDuration || project.executionDuration;
  if (!execution || typeof execution.value !== "number") {
    return null;
  }

  const buffer = subproject?.buffer || project.bufferDuration || null;

  const prepValue = subproject?.preparationDuration?.value;
  const prepUnit =
    subproject?.preparationDuration?.unit || execution.unit || "days";

  const preparation =
    typeof prepValue === "number"
      ? ({ value: prepValue, unit: prepUnit } as Duration)
      : null;

  return {
    execution: { value: execution.value, unit: execution.unit } as Duration,
    buffer: buffer
      ? ({ value: buffer.value, unit: buffer.unit } as Duration)
      : null,
    preparation,
  };
};

const buildHolidayChecker = (professional: any, timeZone: string) => {
  const holidayDates = new Set<string>();
  const holidayRanges: Array<{ start: Date; end: Date }> = [];

  professional?.companyBlockedDates?.forEach((blocked: any) => {
    if (!blocked?.isHoliday || !blocked?.date) return;
    const zoned = toZonedTime(new Date(blocked.date), timeZone);
    holidayDates.add(formatDateKey(zoned));
  });

  professional?.companyBlockedRanges?.forEach((range: any) => {
    if (!range?.isHoliday || !range.startDate || !range.endDate) return;
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    holidayRanges.push({ start, end });
  });

  const isHoliday = (zonedDate: Date) => {
    const key = formatDateKey(zonedDate);
    if (holidayDates.has(key)) return true;

    if (holidayRanges.length === 0) return false;
    const dayStartUtc = fromZonedTime(startOfDayZoned(zonedDate), timeZone);
    const dayEndUtc = fromZonedTime(addDaysZoned(startOfDayZoned(zonedDate), 1), timeZone);

    return holidayRanges.some(
      (range) => range.end > dayStartUtc && range.start < dayEndUtc
    );
  };

  return { isHoliday };
};

const buildBlockedData = async (
  project: any,
  professional: any,
  timeZone: string,
  customerBlocks?: CustomerBlocks
) => {
  const blockedDates = new Set<string>();
  const blockedRanges: Array<{ start: Date; end: Date; reason?: string }> = [];

  professional?.companyBlockedDates?.forEach((blocked: any) => {
    if (!blocked?.date) return;
    const zoned = toZonedTime(new Date(blocked.date), timeZone);
    blockedDates.add(formatDateKey(zoned));
  });

  professional?.companyBlockedRanges?.forEach((range: any) => {
    if (!range?.startDate || !range?.endDate) return;
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    blockedRanges.push({ start, end, reason: range.reason });
  });

  const teamMemberIds = project.resources || [];
  if (teamMemberIds.length > 0) {
    const teamMembers = await User.find({
      _id: { $in: teamMemberIds },
    }).select("blockedDates blockedRanges");

    teamMembers.forEach((member) => {
      member.blockedDates?.forEach((blocked: any) => {
        if (!blocked?.date) return;
        const zoned = toZonedTime(new Date(blocked.date), timeZone);
        blockedDates.add(formatDateKey(zoned));
      });

      member.blockedRanges?.forEach((range: any) => {
        if (!range?.startDate || !range?.endDate) return;
        const start = new Date(range.startDate);
        const end = new Date(range.endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
        blockedRanges.push({ start, end, reason: range.reason });
      });
    });
  }

  const bookingFilter: any = {
    status: { $nin: ["completed", "cancelled", "refunded"] },
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [{ project: project._id }],
    $and: [
      {
        $or: [
          { scheduledBufferEndDate: { $exists: true, $ne: null } },
          { scheduledExecutionEndDate: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  if (teamMemberIds.length > 0) {
    bookingFilter.$or.push(
      { assignedTeamMembers: { $in: teamMemberIds } },
      { professional: { $in: teamMemberIds } }
    );
  }

  const bookings = await Booking.find(bookingFilter).select(
    "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate status"
  );

  bookings.forEach((booking) => {
    // Block the execution period
    // Legacy field fallbacks are kept for older bookings until data is normalized.
    const scheduledExecutionEndDate =
      booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
    const scheduledBufferStartDate =
      booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
    const scheduledBufferEndDate =
      booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

    if (booking.scheduledStartDate && scheduledExecutionEndDate) {
      blockedRanges.push({
        start: new Date(booking.scheduledStartDate),
        end: new Date(scheduledExecutionEndDate),
        reason: "booking",
      });
    }
    // Block the buffer period (if exists)
    if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
      // Don't extend buffer end date - use the actual scheduled end
      // Extending to UTC 23:59:59 causes timezone issues (bleeds into next day in other timezones)
      blockedRanges.push({
        start: new Date(scheduledBufferStartDate),
        end: new Date(scheduledBufferEndDate),
        reason: "booking-buffer",
      });
    }
  });

  if (customerBlocks?.dates) {
    customerBlocks.dates.forEach((blocked) => {
      if (!blocked?.date) return;
      const zoned = toZonedTime(new Date(blocked.date), timeZone);
      blockedDates.add(formatDateKey(zoned));
    });
  }

  if (customerBlocks?.windows) {
    customerBlocks.windows.forEach((window) => {
      if (!window?.date) return;
      const startMinutes = parseTimeToMinutes(window.startTime);
      const endMinutes = parseTimeToMinutes(window.endTime);
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        return;
      }

      const zonedDay = toZonedTime(new Date(window.date), timeZone);
      const dayStart = startOfDayZoned(zonedDay);
      const startZoned = buildZonedTime(dayStart, startMinutes);
      const endZoned = buildZonedTime(dayStart, endMinutes);
      blockedRanges.push({
        start: fromZonedTime(startZoned, timeZone),
        end: fromZonedTime(endZoned, timeZone),
        reason: "customer-block",
      });
    });
  }

  return { blockedDates, blockedRanges };
};

const loadProjectAndProfessional = async (projectId: string) => {
  const project = await Project.findOne({
    _id: projectId,
    status: "published",
  }).lean();

  if (!project) {
    return { project: null, professional: null };
  }

  const professional = await User.findById(project.professionalId).select(
    "companyAvailability availability companyBlockedDates companyBlockedRanges businessInfo.timezone"
  );

  return { project, professional: professional || null };
};

const buildWorkingRangeUtc = (
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string
) => {
  const hours = getWorkingHoursForDate(availability, zonedDate);
  if (!hours.available || hours.startMinutes === null || hours.endMinutes === null) {
    return null;
  }

  const startZoned = buildZonedTime(zonedDate, hours.startMinutes);
  const endZoned = buildZonedTime(zonedDate, hours.endMinutes);
  const startUtc = fromZonedTime(startZoned, timeZone);
  const endUtc = fromZonedTime(endZoned, timeZone);
  if (endUtc <= startUtc) return null;
  return { startUtc, endUtc };
};

const isWorkingDay = (availability: Record<string, any>, zonedDate: Date) => {
  const hours = getWorkingHoursForDate(availability, zonedDate);
  return hours.available;
};

const isDayBlocked = (
  availability: Record<string, any>,
  zonedDate: Date,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  const dateKey = formatDateKey(zonedDate);
  if (blockedDates.has(dateKey)) return true;
  if (!isWorkingDay(availability, zonedDate)) return true;

  const workingRange = buildWorkingRangeUtc(availability, zonedDate, timeZone);
  if (!workingRange) return true;

  const dayStartUtc = fromZonedTime(startOfDayZoned(zonedDate), timeZone);
  const dayEndUtc = fromZonedTime(addDaysZoned(startOfDayZoned(zonedDate), 1), timeZone);

  const intervals = blockedRanges
    .map((range) => {
      if (range.end <= dayStartUtc || range.start >= dayEndUtc) {
        return null;
      }
      const start = range.start > dayStartUtc ? range.start : dayStartUtc;
      const end = range.end < dayEndUtc ? range.end : dayEndUtc;
      return { start, end };
    })
    .filter(Boolean) as Array<{ start: Date; end: Date }>;

  if (intervals.length === 0) return false;

  const clamped = intervals
    .map((interval) => {
      const start = Math.max(interval.start.getTime(), workingRange.startUtc.getTime());
      const end = Math.min(interval.end.getTime(), workingRange.endUtc.getTime());
      return { start, end };
    })
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  if (clamped.length === 0) return false;

  let totalMinutes = 0;
  let currentStart = clamped[0].start;
  let currentEnd = clamped[0].end;

  for (let i = 1; i < clamped.length; i++) {
    const interval = clamped[i];
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      totalMinutes += (currentEnd - currentStart) / (1000 * 60);
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }

  totalMinutes += (currentEnd - currentStart) / (1000 * 60);

  return totalMinutes / 60 > PARTIAL_BLOCK_THRESHOLD_HOURS;
};

const advanceWorkingDays = (
  startDate: Date,
  workingDays: number,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  if (workingDays <= 0) {
    return startDate;
  }

  let cursor = startDate;
  let counted = 0;

  while (counted < workingDays) {
    if (!isDayBlocked(availability, cursor, blockedDates, blockedRanges, timeZone)) {
      counted += 1;
      if (counted >= workingDays) {
        return cursor;
      }
    }
    cursor = addDaysZoned(cursor, 1);
  }

  return cursor;
};

const calculatePrepEnd = (
  preparation: Duration | null,
  availability: Record<string, any>,
  timeZone: string,
  isHoliday: (date: Date) => boolean
) => {
  const zonedNow = toZonedTime(new Date(), timeZone);

  if (!preparation || !preparation.value || preparation.value <= 0) {
    return zonedNow;
  }

  const isWeekend = (date: Date) => {
    const day = date.getUTCDay();
    return day === 0 || day === 6;
  };

  const isPrepWorkingDay = (date: Date) => {
    if (isWeekend(date)) return false;
    if (isHoliday(date)) return false;
    return true;
  };

  if (preparation.unit === "days") {
    let cursor = startOfDayZoned(zonedNow);
    let nowMinutes = zonedNow.getUTCHours() * 60 + zonedNow.getUTCMinutes();
    const todayHours = getPrepHoursForDate(availability, cursor);

    if (!isPrepWorkingDay(cursor)) {
      cursor = addDaysZoned(cursor, 1);
      nowMinutes = 0;
    } else if (todayHours.endMinutes === null) {
      cursor = addDaysZoned(cursor, 1);
      nowMinutes = 0;
    } else if (nowMinutes >= todayHours.endMinutes) {
      cursor = addDaysZoned(cursor, 1);
      nowMinutes = 0;
    }

    let counted = 0;
    let lastPrepDay = cursor;
    const maxIterations = 366 * 2; // Guard against infinite loops (2 years of days)
    let iterations = 0;

    while (counted < preparation.value && iterations < maxIterations) {
      iterations += 1;
      if (isPrepWorkingDay(cursor)) {
        counted += 1;
        lastPrepDay = cursor;
      }
      cursor = addDaysZoned(cursor, 1);
    }

    return addDaysZoned(startOfDayZoned(lastPrepDay), 1);
  }

  let remainingMinutes = preparation.value * 60;
  let cursor = zonedNow;
  const maxIterations = 366 * 2; // Guard against infinite loops
  let iterations = 0;

  while (remainingMinutes > 0 && iterations < maxIterations) {
    iterations += 1;
    const dayStart = startOfDayZoned(cursor);
    if (!isPrepWorkingDay(dayStart)) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const hours = getPrepHoursForDate(availability, dayStart);
    if (hours.startMinutes === null || hours.endMinutes === null) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    let currentMinutes =
      cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
    if (currentMinutes < hours.startMinutes) {
      currentMinutes = hours.startMinutes;
    }
    if (currentMinutes >= hours.endMinutes) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const availableMinutes = hours.endMinutes - currentMinutes;
    if (remainingMinutes <= availableMinutes) {
      return buildZonedTime(dayStart, currentMinutes + remainingMinutes);
    }

    remainingMinutes -= availableMinutes;
    cursor = addDaysZoned(dayStart, 1);
  }

  return cursor;
};

const getAvailableSlotsForDate = (
  zonedDate: Date,
  executionHours: number,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string,
  notBefore?: Date,
  buffer?: Duration | null
) => {
  const dateKey = formatDateKey(zonedDate);
  if (blockedDates.has(dateKey)) return [];

  const hours = getWorkingHoursForDate(availability, zonedDate);
  if (!hours.available || hours.startMinutes === null || hours.endMinutes === null) {
    return [];
  }

  const executionMinutes = executionHours * 60;
  const lastSlotStart = hours.endMinutes - executionMinutes;
  if (lastSlotStart < hours.startMinutes) {
    return [];
  }

  const zonedNow = toZonedTime(new Date(), timeZone);
  const isToday = formatDateKey(zonedNow) === dateKey;
  const nowMinutes =
    zonedNow.getUTCHours() * 60 + zonedNow.getUTCMinutes();

  const notBeforeMinutes =
    notBefore && formatDateKey(notBefore) === dateKey
      ? notBefore.getUTCHours() * 60 + notBefore.getUTCMinutes()
      : null;

  let currentStart = hours.startMinutes;
  if (isToday) {
    currentStart = Math.max(currentStart, nowMinutes);
  }
  if (notBeforeMinutes !== null) {
    currentStart = Math.max(currentStart, notBeforeMinutes);
  }

  const roundToSlot = (minutes: number) => Math.ceil(minutes / 30) * 30;
  currentStart = roundToSlot(currentStart);

  const dayStart = startOfDayZoned(zonedDate);
  const slots: Array<{ startZoned: Date; startTime: string }> = [];

  for (let startMinutes = currentStart; startMinutes <= lastSlotStart; startMinutes += 30) {
    const slotStartZoned = buildZonedTime(dayStart, startMinutes);
    const slotStartUtc = fromZonedTime(slotStartZoned, timeZone);
    const slotEndUtc = new Date(slotStartUtc.getTime() + executionMinutes * 60000);

    const overlaps = windowOverlapsRanges(slotStartUtc, slotEndUtc, blockedRanges);

    if (overlaps) {
      continue;
    }

    if (buffer && buffer.value > 0) {
      const executionEndZoned = new Date(
        slotStartZoned.getTime() + executionMinutes * 60000
      );
      const bufferStartZoned = getBufferStartZoned(
        executionEndZoned,
        "hours",
        buffer
      );
      const bufferEndZoned = calculateBufferEnd(
        executionEndZoned,
        buffer,
        "hours",
        availability,
        blockedDates,
        blockedRanges,
        timeZone
      );

      if (bufferStartZoned && bufferEndZoned > bufferStartZoned) {
        const bufferStartUtc = fromZonedTime(bufferStartZoned, timeZone);
        const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
        if (windowOverlapsRanges(bufferStartUtc, bufferEndUtc, blockedRanges)) {
          continue;
        }
      }
    }

    const timeLabel = formatMinutesToTime(startMinutes);
    slots.push({ startZoned: slotStartZoned, startTime: timeLabel });
  }

  return slots;
};

const getBufferStartZoned = (
  executionEndZoned: Date,
  executionMode: DurationUnit,
  buffer: Duration | null
) => {
  if (!buffer || !buffer.value || buffer.value <= 0) {
    return null;
  }

  if (executionMode === "hours" && buffer.unit === "hours") {
    return executionEndZoned;
  }

  return addDaysZoned(startOfDayZoned(executionEndZoned), 1);
};

const addWorkingHours = (
  startZoned: Date,
  hoursToAdd: number,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  let remainingMinutes = hoursToAdd * 60;
  let cursor = startZoned;
  const maxIterations = 366 * 3;
  let iterations = 0;

  while (remainingMinutes > 0 && iterations < maxIterations) {
    iterations += 1;
    const dayStart = startOfDayZoned(cursor);
    if (isDayBlocked(availability, dayStart, blockedDates, blockedRanges, timeZone)) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const hours = getWorkingHoursForDate(availability, dayStart);
    if (!hours.available || hours.startMinutes === null || hours.endMinutes === null) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    let currentMinutes = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
    if (currentMinutes < hours.startMinutes) {
      currentMinutes = hours.startMinutes;
    }
    if (currentMinutes >= hours.endMinutes) {
      cursor = addDaysZoned(dayStart, 1);
      continue;
    }

    const availableMinutes = hours.endMinutes - currentMinutes;
    if (remainingMinutes <= availableMinutes) {
      return buildZonedTime(dayStart, currentMinutes + remainingMinutes);
    }

    remainingMinutes -= availableMinutes;
    cursor = addDaysZoned(dayStart, 1);
  }

  return cursor;
};

const windowOverlapsRanges = (
  windowStartUtc: Date,
  windowEndUtc: Date,
  blockedRanges: Array<{ start: Date; end: Date }>
) => blockedRanges.some(
  (range) => windowStartUtc < range.end && windowEndUtc > range.start
);

const calculateBufferEnd = (
  executionEndZoned: Date,
  buffer: Duration | null,
  executionMode: DurationUnit,
  availability: Record<string, any>,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => {
  if (!buffer || !buffer.value || buffer.value <= 0) {
    return executionEndZoned;
  }

  if (buffer.unit === "hours") {
    const bufferStart = getBufferStartZoned(
      executionEndZoned,
      executionMode,
      buffer
    );
    if (!bufferStart) {
      return executionEndZoned;
    }
    return addWorkingHours(
      bufferStart,
      buffer.value,
      availability,
      blockedDates,
      blockedRanges,
      timeZone
    );
  }

  const bufferStart = getBufferStartZoned(executionEndZoned, executionMode, buffer);
  if (!bufferStart) {
    return executionEndZoned;
  }

  let bufferDays = buffer.value;
  const bufferEndDay = advanceWorkingDays(
    bufferStart,
    Math.ceil(bufferDays),
    availability,
    blockedDates,
    blockedRanges,
    timeZone
  );
  const workingHours = getWorkingHoursForDate(availability, bufferEndDay);
  const endMinutes =
    workingHours.endMinutes ??
    parseTimeToMinutes(DEFAULT_AVAILABILITY.monday.endTime) ??
    1020;
  return buildZonedTime(bufferEndDay, endMinutes);
};

/**
 * Build schedule proposals using pre-loaded project and professional data.
 * This avoids N+1 queries when called in bulk.
 */
export const buildProjectScheduleProposalsWithData = async (
  project: any,
  professional: any,
  subprojectIndex?: number
): Promise<ScheduleProposals | null> => {
  if (!project || !professional) {
    return null;
  }

  const durations = getProjectDurations(project, subprojectIndex);
  if (!durations || !durations.execution?.value) {
    return null;
  }

  const availability = resolveAvailability(
    professional.companyAvailability
  );
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);
  const { blockedDates, blockedRanges } = await buildBlockedData(
    project,
    professional,
    timeZone
  );

  const prepEnd = calculatePrepEnd(
    durations.preparation,
    availability,
    timeZone,
    isHoliday
  );

  const execution = durations.execution;
  const executionMode = execution.unit;
  const searchStart =
    executionMode === "hours" ? prepEnd : startOfDayZoned(prepEnd);
  const maxDays = 180;

  let earliestBookableDate: Date | null = null;
  let earliestProposal: ProposalWindow | undefined;
  let shortestProposal: ProposalWindow | undefined;
  let shortestThroughput: number | null = null;

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const currentDay = addDaysZoned(searchStart, dayOffset);

    if (executionMode === "hours") {
      const slots = getAvailableSlotsForDate(
        currentDay,
        execution.value,
        availability,
        blockedDates,
        blockedRanges,
        timeZone,
        prepEnd,
        durations.buffer
      );

      if (slots.length === 0) {
        continue;
      }

      if (!earliestBookableDate) {
        earliestBookableDate = startOfDayZoned(currentDay);
      }

      if (!earliestProposal) {
        const slot = slots[0];
        const startUtc = fromZonedTime(slot.startZoned, timeZone);
        const executionEndZoned = new Date(
          slot.startZoned.getTime() + execution.value * 60 * 60000
        );
        const executionEndUtc = fromZonedTime(executionEndZoned, timeZone);
        const bufferEndZoned = calculateBufferEnd(
          executionEndZoned,
          durations.buffer,
          executionMode,
          availability,
          blockedDates,
          blockedRanges,
          timeZone
        );
        const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
        earliestProposal = {
          start: startUtc.toISOString(),
          end: bufferEndUtc.toISOString(),
          executionEnd: executionEndUtc.toISOString(),
        };
        shortestProposal = earliestProposal;
        break;
      }
    } else {
      if (isDayBlocked(availability, currentDay, blockedDates, blockedRanges, timeZone)) {
        continue;
      }

      if (!earliestBookableDate) {
        earliestBookableDate = startOfDayZoned(currentDay);
      }

      const executionDays = Math.max(1, Math.ceil(execution.value));
      const executionEndDay = advanceWorkingDays(
        currentDay,
        executionDays,
        availability,
        blockedDates,
        blockedRanges,
        timeZone
      );
      const throughputDays =
        Math.floor(
          (executionEndDay.getTime() - currentDay.getTime()) / (1000 * 60 * 60 * 24)
        ) + 1;

      if (!earliestProposal && throughputDays <= executionDays * 2) {
        const executionEndUtc = fromZonedTime(executionEndDay, timeZone);
        const bufferEndZoned = calculateBufferEnd(
          executionEndDay,
          durations.buffer,
          executionMode,
          availability,
          blockedDates,
          blockedRanges,
          timeZone
        );
        const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
        earliestProposal = {
          start: fromZonedTime(currentDay, timeZone).toISOString(),
          end: bufferEndUtc.toISOString(),
          executionEnd: executionEndUtc.toISOString(),
        };
      }

      if (throughputDays <= executionDays * 1.2) {
        if (shortestThroughput === null || throughputDays < shortestThroughput) {
          shortestThroughput = throughputDays;
          const executionEndUtc = fromZonedTime(executionEndDay, timeZone);
          const bufferEndZoned = calculateBufferEnd(
            executionEndDay,
            durations.buffer,
            executionMode,
            availability,
            blockedDates,
            blockedRanges,
            timeZone
          );
          const bufferEndUtc = fromZonedTime(bufferEndZoned, timeZone);
          shortestProposal = {
            start: fromZonedTime(currentDay, timeZone).toISOString(),
            end: bufferEndUtc.toISOString(),
            executionEnd: executionEndUtc.toISOString(),
          };
        }
      }

      if (earliestProposal && shortestProposal) {
        break;
      }
    }
  }

  const fallbackDate = earliestBookableDate || startOfDayZoned(prepEnd);

  return {
    mode: executionMode,
    earliestBookableDate: fromZonedTime(fallbackDate, timeZone).toISOString(),
    earliestProposal,
    shortestThroughputProposal: shortestProposal,
  };
};

/**
 * Build schedule proposals by loading project and professional data from the database.
 * This is a convenience wrapper around buildProjectScheduleProposalsWithData.
 */
export const buildProjectScheduleProposals = async (
  projectId: string,
  subprojectIndex?: number
): Promise<ScheduleProposals | null> => {
  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project || !professional) {
    return null;
  }

  return buildProjectScheduleProposalsWithData(project, professional, subprojectIndex);
};

export const validateProjectScheduleSelection = async ({
  projectId,
  subprojectIndex,
  startDate,
  startTime,
  customerBlocks,
}: {
  projectId: string;
  subprojectIndex?: number;
  startDate?: string;
  startTime?: string;
  customerBlocks?: CustomerBlocks;
}) => {
  if (!startDate) {
    return { valid: true };
  }

  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project) {
    return { valid: false, reason: "Project not found" };
  }
  if (!professional) {
    return { valid: false, reason: "Professional not found" };
  }

  const durations = getProjectDurations(project, subprojectIndex);
  if (!durations || !durations.execution?.value) {
    return { valid: false, reason: "Missing execution duration" };
  }

  const availability = resolveAvailability(
    professional.companyAvailability
  );
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);
  const baseBlockedData = await buildBlockedData(
    project,
    professional,
    timeZone,
    customerBlocks
  );
  const { blockedDates, blockedRanges } = baseBlockedData;

  const prepEnd = calculatePrepEnd(
    durations.preparation,
    availability,
    timeZone,
    isHoliday
  );

  const dateParts = startDate.split("-").map(Number);
  if (dateParts.length < 3) {
    return { valid: false, reason: "Invalid start date" };
  }
  const [year, month, day] = dateParts;
  let selectedZoned = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  if (durations.execution.unit === "hours") {
    if (!startTime) {
      return { valid: false, reason: "Start time required for hours mode" };
    }
    const minutes = parseTimeToMinutes(startTime);
    if (minutes === null) {
      return { valid: false, reason: "Invalid start time" };
    }
    selectedZoned = buildZonedTime(selectedZoned, minutes);
    if (selectedZoned < prepEnd) {
      return { valid: false, reason: "Selected time is before prep window" };
    }

    const slots = getAvailableSlotsForDate(
      selectedZoned,
      durations.execution.value,
      availability,
      blockedDates,
      blockedRanges,
      timeZone,
      prepEnd,
      durations.buffer
    );

    const matchingSlot = slots.find((slot) => slot.startTime === startTime);
    if (!matchingSlot) {
      return { valid: false, reason: "Selected time is not available" };
    }
    return { valid: true };
  }

  if (startOfDayZoned(selectedZoned) < startOfDayZoned(prepEnd)) {
    return { valid: false, reason: "Selected date is before prep window" };
  }

  if (isDayBlocked(availability, selectedZoned, blockedDates, blockedRanges, timeZone)) {
    return { valid: false, reason: "Selected date is blocked" };
  }

  return { valid: true };
};

export const buildProjectScheduleWindow = async ({
  projectId,
  subprojectIndex,
  startDate,
  startTime,
  customerBlocks,
}: {
  projectId: string;
  subprojectIndex?: number;
  startDate?: string;
  startTime?: string;
  customerBlocks?: CustomerBlocks;
}) => {
  if (!startDate) {
    return null;
  }

  const { project, professional } = await loadProjectAndProfessional(projectId);
  if (!project || !professional) {
    return null;
  }

  const durations = getProjectDurations(project, subprojectIndex);
  if (!durations || !durations.execution?.value) {
    return null;
  }

  const availability = resolveAvailability(
    professional.companyAvailability
  );
  const timeZone = professional.businessInfo?.timezone || "UTC";
  const { isHoliday } = buildHolidayChecker(professional, timeZone);
  const baseBlockedData = await buildBlockedData(
    project,
    professional,
    timeZone,
    customerBlocks
  );
  const { blockedDates, blockedRanges } = baseBlockedData;
  const bufferBlockedData = customerBlocks
    ? await buildBlockedData(project, professional, timeZone)
    : baseBlockedData;

  const prepEnd = calculatePrepEnd(
    durations.preparation,
    availability,
    timeZone,
    isHoliday
  );

  const dateParts = startDate.split("-").map(Number);
  if (dateParts.length < 3) {
    return null;
  }
  const [year, month, day] = dateParts;
  let selectedZoned = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  if (durations.execution.unit === "hours") {
    if (!startTime) {
      return null;
    }
    const minutes = parseTimeToMinutes(startTime);
    if (minutes === null) {
      return null;
    }
    selectedZoned = buildZonedTime(selectedZoned, minutes);
    if (selectedZoned < prepEnd) {
      return null;
    }

    const executionEndZoned = new Date(
      selectedZoned.getTime() + durations.execution.value * 60 * 60000
    );
    const bufferStartZoned = getBufferStartZoned(
      executionEndZoned,
      durations.execution.unit,
      durations.buffer
    );
    const bufferEndZoned = calculateBufferEnd(
      executionEndZoned,
      durations.buffer,
      durations.execution.unit,
      availability,
      bufferBlockedData.blockedDates,
      bufferBlockedData.blockedRanges,
      timeZone
    );

    return {
      scheduledStartDate: fromZonedTime(selectedZoned, timeZone),
      scheduledExecutionEndDate: fromZonedTime(executionEndZoned, timeZone),
      scheduledBufferStartDate: bufferStartZoned
        ? fromZonedTime(bufferStartZoned, timeZone)
        : null,
      scheduledBufferEndDate: fromZonedTime(bufferEndZoned, timeZone),
      scheduledBufferUnit: durations.buffer?.unit,
      scheduledStartTime: formatMinutesToTime(minutes),
      scheduledEndTime: formatMinutesToTime(
        minutes + Math.round(durations.execution.value * 60)
      ),
    };
  }

  const prepStartDay = startOfDayZoned(prepEnd);
  selectedZoned = startOfDayZoned(selectedZoned);
  if (selectedZoned < prepStartDay) {
    return null;
  }
  if (isDayBlocked(availability, selectedZoned, blockedDates, blockedRanges, timeZone)) {
    return null;
  }

  const executionDays = Math.max(1, Math.ceil(durations.execution.value));
  const executionEndDay = advanceWorkingDays(
    selectedZoned,
    executionDays,
    availability,
    blockedDates,
    blockedRanges,
    timeZone
  );

  const executionHours = getWorkingHoursForDate(availability, executionEndDay);
  const executionEndMinutes =
    executionHours.endMinutes ??
    parseTimeToMinutes(DEFAULT_AVAILABILITY.monday.endTime) ??
    1020;
  const executionEndZoned = buildZonedTime(executionEndDay, executionEndMinutes);
  const bufferStartZoned = getBufferStartZoned(
    executionEndZoned,
    durations.execution.unit,
    durations.buffer
  );
  const bufferEndZoned = calculateBufferEnd(
    executionEndDay,
    durations.buffer,
    durations.execution.unit,
    availability,
    bufferBlockedData.blockedDates,
    bufferBlockedData.blockedRanges,
    timeZone
  );

  return {
    scheduledStartDate: fromZonedTime(selectedZoned, timeZone),
    scheduledExecutionEndDate: fromZonedTime(executionEndZoned, timeZone),
    scheduledBufferStartDate: bufferStartZoned
      ? fromZonedTime(bufferStartZoned, timeZone)
      : null,
    scheduledBufferEndDate: fromZonedTime(bufferEndZoned, timeZone),
    scheduledBufferUnit: durations.buffer?.unit,
  };
};
