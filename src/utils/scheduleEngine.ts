import mongoose from "mongoose";
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

// Multi-resource availability types
type MemberBlockedData = {
  blockedDates: Set<string>;
  blockedRanges: Array<{ start: Date; end: Date; reason?: string }>;
};

type PerMemberBlockedData = Map<string, MemberBlockedData>;

type ResourcePolicy = {
  minResources: number;
  minOverlapPercentage: number;
  totalResources: number;
};

const DEFAULT_MIN_OVERLAP_PERCENTAGE = 90;

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

const isExactMidnightUtc = (date: Date) =>
  date.getUTCHours() === 0 &&
  date.getUTCMinutes() === 0 &&
  date.getUTCSeconds() === 0 &&
  date.getUTCMilliseconds() === 0;

const normalizeRangeEndInclusive = (rangeEnd: Date, timeZone: string) => {
  if (!isExactMidnightUtc(rangeEnd)) return rangeEnd;
  const endZoned = toZonedTime(rangeEnd, timeZone);
  const endDayStart = startOfDayZoned(endZoned);
  const endDayNextStart = addDaysZoned(endDayStart, 1);
  return fromZonedTime(endDayNextStart, timeZone);
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

    return holidayRanges.some((range) => {
      const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
      return rangeEnd > dayStartUtc && range.start < dayEndUtc;
    });
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
    // Convert string IDs to ObjectIds for proper MongoDB matching
    const teamMemberObjectIds = teamMemberIds.map(
      (id: string) => new mongoose.Types.ObjectId(id)
    );
    bookingFilter.$or.push(
      { assignedTeamMembers: { $in: teamMemberObjectIds } },
      { professional: { $in: teamMemberObjectIds } }
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

/**
 * Build blocked data per individual team member for multi-resource availability.
 * Returns a Map keyed by member ID with each member's blocked dates and ranges.
 */
const buildPerMemberBlockedData = async (
  project: any,
  professional: any,
  timeZone: string,
  customerBlocks?: CustomerBlocks
): Promise<PerMemberBlockedData> => {
  const perMemberData: PerMemberBlockedData = new Map();
  const teamMemberIds: string[] = project.resources || [];

  // Include professional in the team if not already included
  const professionalId = project.professionalId?.toString() || professional?._id?.toString();
  if (professionalId && !teamMemberIds.includes(professionalId)) {
    teamMemberIds.unshift(professionalId);
  }

  // Initialize each member with company blocks (shared by all)
  const companyBlockedDates = new Set<string>();
  const companyBlockedRanges: Array<{ start: Date; end: Date; reason?: string }> = [];

  professional?.companyBlockedDates?.forEach((blocked: any) => {
    if (!blocked?.date) return;
    const zoned = toZonedTime(new Date(blocked.date), timeZone);
    companyBlockedDates.add(formatDateKey(zoned));
  });

  professional?.companyBlockedRanges?.forEach((range: any) => {
    if (!range?.startDate || !range?.endDate) return;
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    companyBlockedRanges.push({ start, end, reason: range.reason });
  });

  // Add customer blocks to company blocks (applies to all members)
  if (customerBlocks?.dates) {
    customerBlocks.dates.forEach((blocked) => {
      if (!blocked?.date) return;
      const zoned = toZonedTime(new Date(blocked.date), timeZone);
      companyBlockedDates.add(formatDateKey(zoned));
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
      companyBlockedRanges.push({
        start: fromZonedTime(startZoned, timeZone),
        end: fromZonedTime(endZoned, timeZone),
        reason: "customer-block",
      });
    });
  }

  // Fetch all team members' personal blocks
  const teamMembers =
    teamMemberIds.length > 0
      ? await User.find({ _id: { $in: teamMemberIds } }).select(
          "blockedDates blockedRanges"
        )
      : [];

  const memberBlocksMap = new Map<string, MemberBlockedData>();
  teamMembers.forEach((member: any) => {
    const memberId = member._id.toString();
    const blockedDates = new Set<string>(companyBlockedDates);
    const blockedRanges = [...companyBlockedRanges];

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

    memberBlocksMap.set(memberId, { blockedDates, blockedRanges });
  });

  // Fetch bookings for each team member individually
  // Convert string IDs to ObjectIds for proper MongoDB matching
  const teamMemberObjectIds = teamMemberIds.map(
    (id: string) => new mongoose.Types.ObjectId(id)
  );
  const bookingFilter: any = {
    status: { $nin: ["completed", "cancelled", "refunded"] },
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [
      { project: project._id },
      { assignedTeamMembers: { $in: teamMemberObjectIds } },
      { professional: { $in: teamMemberObjectIds } },
    ],
    $and: [
      {
        $or: [
          { scheduledBufferEndDate: { $exists: true, $ne: null } },
          { scheduledExecutionEndDate: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  const bookings = await Booking.find(bookingFilter).select(
    "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate assignedTeamMembers professional status"
  );

  bookings.forEach((booking) => {
    const scheduledExecutionEndDate =
      booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
    const scheduledBufferStartDate =
      booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
    const scheduledBufferEndDate =
      booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

    // Determine which team members are affected by this booking
    const affectedMembers = new Set<string>();

    // If booking has assignedTeamMembers, use those
    if (booking.assignedTeamMembers && booking.assignedTeamMembers.length > 0) {
      booking.assignedTeamMembers.forEach((memberId: any) => {
        const id = memberId.toString();
        if (teamMemberIds.includes(id)) {
          affectedMembers.add(id);
        }
      });
    }

    // Also check if professional is in our team
    if (booking.professional) {
      const profId = booking.professional.toString();
      if (teamMemberIds.includes(profId)) {
        affectedMembers.add(profId);
      }
    }

    // If booking is for this project, all team members are affected
    if (booking.project?.toString() === project._id?.toString()) {
      teamMemberIds.forEach((id) => affectedMembers.add(id));
    }

    // Add blocks only to affected members
    affectedMembers.forEach((memberId) => {
      let memberData = memberBlocksMap.get(memberId);
      if (!memberData) {
        memberData = {
          blockedDates: new Set<string>(companyBlockedDates),
          blockedRanges: [...companyBlockedRanges],
        };
        memberBlocksMap.set(memberId, memberData);
      }

      if (booking.scheduledStartDate && scheduledExecutionEndDate) {
        memberData.blockedRanges.push({
          start: new Date(booking.scheduledStartDate),
          end: new Date(scheduledExecutionEndDate),
          reason: "booking",
        });
      }

      if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
        memberData.blockedRanges.push({
          start: new Date(scheduledBufferStartDate),
          end: new Date(scheduledBufferEndDate),
          reason: "booking-buffer",
        });
      }
    });
  });

  // Ensure all team members have entries
  teamMemberIds.forEach((memberId) => {
    if (!memberBlocksMap.has(memberId)) {
      memberBlocksMap.set(memberId, {
        blockedDates: new Set<string>(companyBlockedDates),
        blockedRanges: [...companyBlockedRanges],
      });
    }
    perMemberData.set(memberId, memberBlocksMap.get(memberId)!);
  });

  return perMemberData;
};

/**
 * Check if a specific member is blocked on a given day.
 */
const isMemberDayBlocked = (
  memberData: MemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string
): boolean => {
  const dateKey = formatDateKey(zonedDate);
  if (memberData.blockedDates.has(dateKey)) return true;
  if (!isWorkingDay(availability, zonedDate)) return true;

  const workingRange = buildWorkingRangeUtc(availability, zonedDate, timeZone);
  if (!workingRange) return true;

  const dayStartUtc = fromZonedTime(startOfDayZoned(zonedDate), timeZone);
  const dayEndUtc = fromZonedTime(addDaysZoned(startOfDayZoned(zonedDate), 1), timeZone);

  const intervals = memberData.blockedRanges
    .map((range) => {
      const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
      if (rangeEnd <= dayStartUtc || range.start >= dayEndUtc) {
        return null;
      }
      const start = range.start > dayStartUtc ? range.start : dayStartUtc;
      const end = rangeEnd < dayEndUtc ? rangeEnd : dayEndUtc;
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
  return totalMinutes / 60 >= PARTIAL_BLOCK_THRESHOLD_HOURS;
};

/**
 * Count how many resources are available for a given day.
 */
const countAvailableResourcesForDay = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  timeZone: string
): number => {
  let count = 0;
  perMemberBlocked.forEach((memberData) => {
    if (!isMemberDayBlocked(memberData, availability, zonedDate, timeZone)) {
      count++;
    }
  });
  return count;
};

/**
 * Check if a time range overlaps with any blocked ranges for a member.
 */
const memberTimeOverlapsRanges = (
  memberData: MemberBlockedData,
  startUtc: Date,
  endUtc: Date,
  timeZone: string
): boolean => {
  return memberData.blockedRanges.some((range) => {
    const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
    return startUtc < rangeEnd && endUtc > range.start;
  });
};

/**
 * Count how many resources are available during a specific time window (hours mode).
 */
const countAvailableResourcesForWindow = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startUtc: Date,
  endUtc: Date,
  timeZone: string
): number => {
  let count = 0;
  const startZoned = toZonedTime(startUtc, timeZone);

  perMemberBlocked.forEach((memberData) => {
    // Check if it's a working day
    if (!isWorkingDay(availability, startZoned)) return;

    // Check if date is blocked
    const dateKey = formatDateKey(startZoned);
    if (memberData.blockedDates.has(dateKey)) return;

    // Check if window overlaps with blocked ranges
    if (!memberTimeOverlapsRanges(memberData, startUtc, endUtc, timeZone)) {
      count++;
    }
  });

  return count;
};

/**
 * Compute overlap percentage for days mode.
 * Returns the percentage of execution days where at least minResources are available.
 */
const computeDaysOverlapPercentage = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startZoned: Date,
  executionDays: number,
  minResources: number,
  timeZone: string
): number => {
  if (executionDays <= 0) return 100;

  let availableDays = 0;
  let cursor = startZoned;
  let daysCounted = 0;

  while (daysCounted < executionDays) {
    // Only count working days
    if (isWorkingDay(availability, cursor)) {
      const availableCount = countAvailableResourcesForDay(
        perMemberBlocked,
        availability,
        cursor,
        timeZone
      );
      if (availableCount >= minResources) {
        availableDays++;
      }
      daysCounted++;
    }
    cursor = addDaysZoned(cursor, 1);
  }

  return (availableDays / executionDays) * 100;
};

/**
 * Compute overlap percentage for hours mode.
 * Returns the percentage of execution time where at least minResources are available.
 * Samples at 30-minute intervals for efficiency.
 */
const computeHoursOverlapPercentage = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  startUtc: Date,
  endUtc: Date,
  minResources: number,
  timeZone: string
): number => {
  const totalMinutes = (endUtc.getTime() - startUtc.getTime()) / (1000 * 60);
  if (totalMinutes <= 0) return 100;

  const sampleInterval = 30; // Sample every 30 minutes
  const totalSamples = Math.max(1, Math.ceil(totalMinutes / sampleInterval));
  let availableSamples = 0;

  for (let i = 0; i < totalSamples; i++) {
    const sampleTime = new Date(startUtc.getTime() + i * sampleInterval * 60 * 1000);
    const sampleEnd = new Date(sampleTime.getTime() + sampleInterval * 60 * 1000);

    const availableCount = countAvailableResourcesForWindow(
      perMemberBlocked,
      availability,
      sampleTime,
      sampleEnd,
      timeZone
    );

    if (availableCount >= minResources) {
      availableSamples++;
    }
  }

  return (availableSamples / totalSamples) * 100;
};

/**
 * Get resource policy from project with defaults applied.
 */
const getResourcePolicy = (project: any): ResourcePolicy => {
  const totalResources = project.resources?.length || 1;
  const minResources = Math.min(
    Math.max(project.minResources || 1, 1),
    totalResources
  );
  const minOverlapPercentage = Math.min(
    Math.max(project.minOverlapPercentage ?? DEFAULT_MIN_OVERLAP_PERCENTAGE, 10),
    100
  );

  return { minResources, minOverlapPercentage, totalResources };
};

/**
 * Check if multi-resource mode is active (minResources > 1).
 */
const isMultiResourceMode = (project: any): boolean => {
  const { minResources, totalResources } = getResourcePolicy(project);
  return minResources > 1 && totalResources > 1;
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

/**
 * Check if a day is blocked (strict intersection mode - all resources must be free).
 * This is the original behavior when minResources <= 1.
 */
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
      const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
      if (rangeEnd <= dayStartUtc || range.start >= dayEndUtc) {
        return null;
      }
      const start = range.start > dayStartUtc ? range.start : dayStartUtc;
      const end = rangeEnd < dayEndUtc ? rangeEnd : dayEndUtc;
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

  return totalMinutes / 60 >= PARTIAL_BLOCK_THRESHOLD_HOURS;
};

/**
 * Check if a day is blocked in multi-resource mode.
 * A day is blocked if fewer than minResources are available.
 */
const isDayBlockedMultiResource = (
  perMemberBlocked: PerMemberBlockedData,
  availability: Record<string, any>,
  zonedDate: Date,
  minResources: number,
  timeZone: string
): boolean => {
  if (!isWorkingDay(availability, zonedDate)) return true;

  const availableCount = countAvailableResourcesForDay(
    perMemberBlocked,
    availability,
    zonedDate,
    timeZone
  );

  return availableCount < minResources;
};

/**
 * Unified day blocked check that uses multi-resource mode when applicable.
 */
const isDayBlockedWithPolicy = (
  availability: Record<string, any>,
  zonedDate: Date,
  blockedDates: Set<string>,
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string,
  perMemberBlocked?: PerMemberBlockedData,
  resourcePolicy?: ResourcePolicy
): boolean => {
  // Use multi-resource mode if applicable
  if (
    perMemberBlocked &&
    resourcePolicy &&
    resourcePolicy.minResources > 1 &&
    resourcePolicy.totalResources > 1
  ) {
    return isDayBlockedMultiResource(
      perMemberBlocked,
      availability,
      zonedDate,
      resourcePolicy.minResources,
      timeZone
    );
  }

  // Fall back to strict intersection mode
  return isDayBlocked(availability, zonedDate, blockedDates, blockedRanges, timeZone);
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
  buffer?: Duration | null,
  perMemberBlocked?: PerMemberBlockedData,
  resourcePolicy?: ResourcePolicy
) => {
  const dateKey = formatDateKey(zonedDate);
  const isMultiResource =
    perMemberBlocked &&
    resourcePolicy &&
    resourcePolicy.minResources > 1 &&
    resourcePolicy.totalResources > 1;

  // In strict mode, check if date is fully blocked
  if (!isMultiResource && blockedDates.has(dateKey)) return [];

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

    if (isMultiResource) {
      // Multi-resource mode: check overlap percentage
      const overlapPercentage = computeHoursOverlapPercentage(
        perMemberBlocked!,
        availability,
        slotStartUtc,
        slotEndUtc,
        resourcePolicy!.minResources,
        timeZone
      );

      if (overlapPercentage < resourcePolicy!.minOverlapPercentage) {
        continue;
      }
    } else {
      // Strict intersection mode: check if window overlaps any blocked ranges
      const overlaps = windowOverlapsRanges(
        slotStartUtc,
        slotEndUtc,
        blockedRanges,
        timeZone
      );

      if (overlaps) {
        continue;
      }
    }

    // Buffer check (same for both modes - uses merged blocked data)
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
        if (
          windowOverlapsRanges(bufferStartUtc, bufferEndUtc, blockedRanges, timeZone)
        ) {
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
  blockedRanges: Array<{ start: Date; end: Date }>,
  timeZone: string
) => blockedRanges.some((range) => {
  const rangeEnd = normalizeRangeEndInclusive(range.end, timeZone);
  return windowStartUtc < rangeEnd && windowEndUtc > range.start;
});

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
 * Supports multi-resource mode when project.minResources > 1.
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

  // Get resource policy and determine if multi-resource mode is active
  const resourcePolicy = getResourcePolicy(project);
  const useMultiResource = isMultiResourceMode(project);

  // Build blocked data (merged for strict mode, per-member for multi-resource)
  const { blockedDates, blockedRanges } = await buildBlockedData(
    project,
    professional,
    timeZone
  );

  // Build per-member blocked data if in multi-resource mode
  let perMemberBlocked: PerMemberBlockedData | undefined;
  if (useMultiResource) {
    perMemberBlocked = await buildPerMemberBlockedData(
      project,
      professional,
      timeZone
    );
  }

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
      // Pass multi-resource params to getAvailableSlotsForDate
      const slots = getAvailableSlotsForDate(
        currentDay,
        execution.value,
        availability,
        blockedDates,
        blockedRanges,
        timeZone,
        prepEnd,
        durations.buffer,
        perMemberBlocked,
        useMultiResource ? resourcePolicy : undefined
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
      // Days mode: use policy-aware day blocked check
      const dayIsBlocked = isDayBlockedWithPolicy(
        availability,
        currentDay,
        blockedDates,
        blockedRanges,
        timeZone,
        perMemberBlocked,
        useMultiResource ? resourcePolicy : undefined
      );

      if (dayIsBlocked) {
        continue;
      }

      if (!earliestBookableDate) {
        earliestBookableDate = startOfDayZoned(currentDay);
      }

      const executionDays = Math.max(1, Math.ceil(execution.value));

      // For multi-resource days mode, check overlap percentage across execution window
      if (useMultiResource && perMemberBlocked) {
        const overlapPercentage = computeDaysOverlapPercentage(
          perMemberBlocked,
          availability,
          currentDay,
          executionDays,
          resourcePolicy.minResources,
          timeZone
        );

        if (overlapPercentage < resourcePolicy.minOverlapPercentage) {
          continue;
        }
      }

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

  // Get resource policy and build per-member data if multi-resource mode
  const resourcePolicy = getResourcePolicy(project);
  const useMultiResource = isMultiResourceMode(project);
  let perMemberBlocked: PerMemberBlockedData | undefined;
  if (useMultiResource) {
    perMemberBlocked = await buildPerMemberBlockedData(
      project,
      professional,
      timeZone,
      customerBlocks
    );
  }

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

    // Pass multi-resource params to getAvailableSlotsForDate
    const slots = getAvailableSlotsForDate(
      selectedZoned,
      durations.execution.value,
      availability,
      blockedDates,
      blockedRanges,
      timeZone,
      prepEnd,
      durations.buffer,
      perMemberBlocked,
      useMultiResource ? resourcePolicy : undefined
    );

    const matchingSlot = slots.find((slot) => slot.startTime === startTime);
    if (!matchingSlot) {
      if (useMultiResource) {
        return { valid: false, reason: "Selected time does not meet team availability requirements" };
      }
      return { valid: false, reason: "Selected time is not available" };
    }
    return { valid: true };
  }

  // Days mode
  if (startOfDayZoned(selectedZoned) < startOfDayZoned(prepEnd)) {
    return { valid: false, reason: "Selected date is before prep window" };
  }

  // Use policy-aware day blocked check
  const dayIsBlocked = isDayBlockedWithPolicy(
    availability,
    selectedZoned,
    blockedDates,
    blockedRanges,
    timeZone,
    perMemberBlocked,
    useMultiResource ? resourcePolicy : undefined
  );

  if (dayIsBlocked) {
    if (useMultiResource) {
      return { valid: false, reason: "Selected date does not have enough team members available" };
    }
    return { valid: false, reason: "Selected date is blocked" };
  }

  // For multi-resource days mode, also check overlap percentage across execution window
  if (useMultiResource && perMemberBlocked) {
    const executionDays = Math.max(1, Math.ceil(durations.execution.value));
    const overlapPercentage = computeDaysOverlapPercentage(
      perMemberBlocked,
      availability,
      selectedZoned,
      executionDays,
      resourcePolicy.minResources,
      timeZone
    );

    if (overlapPercentage < resourcePolicy.minOverlapPercentage) {
      return {
        valid: false,
        reason: `Team availability (${Math.round(overlapPercentage)}%) is below required ${resourcePolicy.minOverlapPercentage}%`
      };
    }
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

    // Include assignedTeamMembers (all project resources)
    const assignedTeamMembers = project.resources || [];

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
      assignedTeamMembers,
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

  // Include assignedTeamMembers (all project resources)
  const assignedTeamMembers = project.resources || [];

  return {
    scheduledStartDate: fromZonedTime(selectedZoned, timeZone),
    scheduledExecutionEndDate: fromZonedTime(executionEndZoned, timeZone),
    scheduledBufferStartDate: bufferStartZoned
      ? fromZonedTime(bufferStartZoned, timeZone)
      : null,
    scheduledBufferEndDate: fromZonedTime(bufferEndZoned, timeZone),
    scheduledBufferUnit: durations.buffer?.unit,
    assignedTeamMembers,
  };
};
