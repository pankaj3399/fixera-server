import Project, { IProject } from "../../models/project";
import User, { IUser } from "../../models/user";
import Booking from "../../models/booking";

interface TimeWindow {
  start: Date;
  end: Date;
}

interface ScheduleProposals {
  mode: "hours" | "days";
  earliestBookableDate: Date;
  earliestProposal?: TimeWindow;
  shortestThroughputProposal?: TimeWindow;
}

interface ScheduleOptions {
  subprojectIndex?: number;
}

const HOURS_PER_DAY = 24;
const MAX_SEARCH_DAYS = 90;

const startOfDay = (date: Date): Date => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDuration = (start: Date, value: number, unit: "hours" | "days"): Date => {
  const result = new Date(start);
  if (unit === "hours") {
    result.setHours(result.getHours() + value);
  } else {
    result.setDate(result.getDate() + value);
  }
  return result;
};

const toHours = (value: number, unit: "hours" | "days"): number => {
  return unit === "hours" ? value : value * HOURS_PER_DAY;
};

const toDays = (value: number, unit: "hours" | "days"): number => {
  return unit === "days" ? value : value / HOURS_PER_DAY;
};

const getWeekdayKey = (date: Date): keyof NonNullable<IUser["availability"]> => {
  const day = date.getDay();
  switch (day) {
    case 0:
      return "sunday";
    case 1:
      return "monday";
    case 2:
      return "tuesday";
    case 3:
      return "wednesday";
    case 4:
      return "thursday";
    case 5:
      return "friday";
    case 6:
    default:
      return "saturday";
  }
};

const isSameDay = (a: Date, b: Date): boolean => {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
};

const dayOverlapsRange = (day: Date, start: Date, end: Date): boolean => {
  const dayStart = startOfDay(day);
  const dayEnd = addDuration(dayStart, 1, "days");
  return start < dayEnd && end > dayStart;
};

/**
 * Add a number of working days to a start date, considering team member availability
 * This is used for DAYS mode to correctly calculate completion dates
 */
export const addWorkingDays = async (
  startDate: Date,
  daysToAdd: number,
  teamMembers: IUser[]
): Promise<Date> => {
  if (daysToAdd === 0) return startDate;
  if (daysToAdd === 1) return startDate; 

  let workingDaysCount = 0;
  let currentDate = startOfDay(startDate);
  const maxIterations = daysToAdd * 5; // Safety limit (up to 5x expected for very sparse availability)
  let iterations = 0;

  // First, check if startDate itself is a working day and count it
  const startDayAvailable = getAvailableMembersForDay(teamMembers, currentDate, "days");
  if (startDayAvailable.length > 0) {
    workingDaysCount = 1; // Count the first day
  }

  // Now count remaining days (daysToAdd - 1 more working days needed)
  while (workingDaysCount < daysToAdd && iterations < maxIterations) {
    iterations++;
    currentDate = addDuration(currentDate, 1, 'days');

    // Check if at least one team member is available on this day (using days mode logic)
    const availableMembers = getAvailableMembersForDay(teamMembers, currentDate, "days");

    // If at least one team member is available, count it as a working day
    if (availableMembers.length > 0) {
      workingDaysCount++;
    }
  }

  return currentDate;
};


const hasAvailableTimeSlots = async (
  project: IProject,
  date: Date,
  teamMembers: IUser[],
  executionHours: number
): Promise<boolean> => {
  const dateStr = date.toISOString().split('T')[0];

  // Only check time slots for hours mode
  if (project.timeMode !== 'hours') {
    return true;
  }

  if (!executionHours || executionHours <= 0) {
    console.log(`[hasAvailableTimeSlots] ${dateStr} - No execution duration, returning true`);
    return true;
  }

  console.log(`[hasAvailableTimeSlots] ${dateStr} - Execution hours: ${executionHours}`);

  // Get working hours for the first available team member
  const dayKey = getWeekdayKey(date);
  const firstMember = teamMembers[0];
  if (!firstMember) {
    return false;
  }
  const dayAvailability = firstMember?.availability?.[dayKey];

  if (!dayAvailability) {
    return false;
  }

  const [startHour, startMin] = (dayAvailability.startTime || '09:00').split(':').map(Number);
  const [endHour, endMin] = (dayAvailability.endTime || '17:00').split(':').map(Number);

  const workingMinutes = (endHour * 60 + endMin) - (startHour * 60 + startMin);
  const executionMinutes = executionHours * 60;

  // If execution time doesn't fit in working hours, no slots available
  if (executionMinutes > workingMinutes) {
    return false;
  }

  // Get existing bookings for this project on this date
  const dayStart = startOfDay(date);
  const dayEnd = addDuration(dayStart, 1, 'days');

  const existingBookings = await Booking.find({
    project: project._id,
    status: { $in: ['rfq', 'quoted', 'quote_accepted', 'payment_pending', 'booked', 'in_progress'] },
    'rfqData.preferredStartDate': {
      $gte: dayStart,
      $lt: dayEnd
    }
  }).select('rfqData selectedSubprojectIndex');

  console.log(`[hasAvailableTimeSlots] ${dateStr} - Found ${existingBookings.length} existing bookings on this date`);

  // Check each potential time slot
  let currentMinutes = startHour * 60 + startMin;
  const lastSlotMinutes = (endHour * 60 + endMin) - executionMinutes;
  let checkedSlots = 0;
  let availableSlots = 0;

  while (currentMinutes <= lastSlotMinutes) {
    checkedSlots++;
    const slotHours = Math.floor(currentMinutes / 60);
    const slotMinutes = currentMinutes % 60;

    const slotStart = new Date(date);
    slotStart.setHours(slotHours, slotMinutes, 0, 0);

    const slotEnd = new Date(slotStart);
    slotEnd.setMinutes(slotEnd.getMinutes() + executionMinutes);

    // Check if this slot overlaps with any existing booking
    const hasOverlap = existingBookings.some(booking => {
      if (!booking.rfqData?.preferredStartTime || !booking.rfqData?.preferredStartDate) {
        return false;
      }

      const [bookingHours, bookingMinutes] = booking.rfqData.preferredStartTime.split(':').map(Number);
      const bookingStart = new Date(booking.rfqData.preferredStartDate);
      bookingStart.setHours(bookingHours, bookingMinutes, 0, 0);

      const bookingEnd = new Date(bookingStart);
      bookingEnd.setHours(bookingEnd.getHours() + executionHours);

      return slotStart < bookingEnd && slotEnd > bookingStart;
    });

    if (!hasOverlap) {
      availableSlots++;
      console.log(`[hasAvailableTimeSlots] ${dateStr} - Found available slot at ${slotHours}:${slotMinutes.toString().padStart(2, '0')}`);
      return true; // Found at least one available slot
    }

    currentMinutes += 30; // Check next 30-minute slot
  }

  console.log(`[hasAvailableTimeSlots] ${dateStr} - No available slots found (checked ${checkedSlots} slots)`);
  return false; // No available slots found
};

const getExecutionContext = (project: IProject, options?: ScheduleOptions) => {
  const subprojects = Array.isArray(project.subprojects) ? project.subprojects : [];
  const subproject =
    typeof options?.subprojectIndex === 'number' &&
    subprojects[options.subprojectIndex]
      ? subprojects[options.subprojectIndex]
      : undefined;

  const reduceDurations = <
    T extends { value: number; unit: 'hours' | 'days' } | undefined
  >(candidates: T[]): T | undefined => {
    return candidates.reduce<T | undefined>((longest, current) => {
      if (!current) {
        return longest;
      }
      if (!longest) {
        return current;
      }
      const longestHours = toHours(longest.value, longest.unit);
      const currentHours = toHours(current.value, current.unit);
      return currentHours > longestHours ? current : longest;
    }, undefined);
  };

  let executionDuration =
    subproject?.executionDuration ||
    project.executionDuration ||
    reduceDurations(subprojects.map((sp) => sp.executionDuration));

  let bufferDuration =
    subproject?.buffer ||
    project.bufferDuration ||
    reduceDurations(subprojects.map((sp) => sp.buffer));

  const resolvePreparation = () => {
    const getPreparationDuration = (candidate?: IProject['subprojects'][number]) => {
      if (!candidate) {
        return undefined;
      }
      if (typeof candidate.deliveryPreparation !== 'number' || candidate.deliveryPreparation <= 0) {
        return undefined;
      }
      const unit = (candidate.deliveryPreparationUnit || 'days') as 'hours' | 'days';
      return { value: candidate.deliveryPreparation, unit };
    };

    const directPreparation = getPreparationDuration(subproject);
    if (directPreparation) {
      console.log(`[getExecutionContext] Using deliveryPreparation from subproject index ${options?.subprojectIndex}`);
      return directPreparation;
    }

    const longestSubprojectPreparation = subprojects.reduce<
      { value: number; unit: 'hours' | 'days'; hours: number } | undefined
    >((longest, current) => {
      const prep = getPreparationDuration(current);
      if (!prep) {
        return longest;
      }
      const prepHours = toHours(prep.value, prep.unit);
      if (!longest || prepHours > longest.hours) {
        return { value: prep.value, unit: prep.unit, hours: prepHours };
      }
      return longest;
    }, undefined);

    if (longestSubprojectPreparation) {
      return { value: longestSubprojectPreparation.value, unit: longestSubprojectPreparation.unit };
    }

    if (project.preparationDuration && project.preparationDuration.value > 0) {
      return {
        value: project.preparationDuration.value,
        unit: (project.preparationDuration.unit || 'days') as 'hours' | 'days',
      };
    }

    return { value: 0, unit: 'days' as const };
  };

  return {
    executionDuration,
    bufferDuration,
    preparation: resolvePreparation(),
  };
};

const getEarliestBookableDate = async (project: IProject, options?: ScheduleOptions): Promise<Date> => {
  const now = new Date();

  const executionContext = getExecutionContext(project, options);
  const prepValue = executionContext.preparation.value;
  const prepUnit = executionContext.preparation.unit;
  const executionHours = executionContext.executionDuration
    ? toHours(executionContext.executionDuration.value, executionContext.executionDuration.unit)
    : 0;

  // If no preparation time at all, return now
  if (prepValue === 0) {
    console.log(`[getEarliestBookableDate] No preparation time, earliest date is now`);
    return now;
  }

  // If preparation is in hours, just add the hours (no working day logic for hourly)
  if (prepUnit === 'hours') {
    const result = addDuration(now, prepValue, 'hours');
    console.log(`[getEarliestBookableDate] Added ${prepValue} hours to now: ${result.toISOString()}`);
    return result;
  }

  // For days-based preparation, count only working days

  // Get team members to determine working days
  const resourceIds: string[] = Array.isArray(project.resources)
    ? project.resources.map((r) => r.toString())
    : [];

  if (!resourceIds.length && project.professionalId) {
    resourceIds.push(project.professionalId.toString());
  }

  if (!resourceIds.length) {
    // No team members defined, fallback to simple addition
    return addDuration(now, prepValue, 'days');
  }

  const teamMembers: IUser[] = await User.find({ _id: { $in: resourceIds } });

  if (!teamMembers.length) {
    // No team members found, fallback to simple addition
    return addDuration(now, prepValue, 'days');
  }

  // Count working days for preparation
  let workingDaysCount = 0;
  let currentDate = startOfDay(now);
  const maxIterations = prepValue * 3; // Safety limit (3x expected)
  let iterations = 0;

  while (workingDaysCount < prepValue && iterations < maxIterations) {
    iterations++;
    currentDate = addDuration(currentDate, 1, 'days');

    // Check if at least one team member is available on this day
    const availableMembers = teamMembers.filter((member) => {
      const dayKey = getWeekdayKey(currentDate);
      const availability = member.availability || undefined;
      const dayAvailability = availability?.[dayKey];

      // Not available on this weekday
      if (!dayAvailability || !dayAvailability.available) {
        return false;
      }

      // Check if blocked on this specific date
      const hasBlockedDate =
        (member.blockedDates || []).some((b) => isSameDay(b.date, currentDate)) ||
        (member.companyBlockedDates || []).some((b) => isSameDay(b.date, currentDate));

      if (hasBlockedDate) {
        return false;
      }

      // Check if any blocked range overlaps this day
      const allRanges = [
        ...(member.blockedRanges || []),
        ...(member.companyBlockedRanges || []),
      ];

      const hasBlockedRange = allRanges.some((r) =>
        dayOverlapsRange(currentDate, r.startDate, r.endDate)
      );

      if (hasBlockedRange) {
        return false;
      }

      return true;
    });

    // If at least one team member is available, count it as a working day
    if (availableMembers.length > 0) {
      workingDaysCount++;
    }
  }

  console.log(`[getEarliestBookableDate] After ${prepValue} working days preparation, earliest date: ${currentDate.toISOString()}`);

  // For hours mode, continue searching until we find a date with available time slots
  if (project.timeMode === 'hours') {
    console.log(`[getEarliestBookableDate] Hours mode - searching for date with available time slots`);
    console.log(`[getEarliestBookableDate] Starting search from: ${currentDate.toISOString()}`);

    const maxSearchDays = 120;
    let searchIterations = 0;

    while (searchIterations < maxSearchDays) {
      const availableMembers = teamMembers.filter((member) => {
        const dayKey = getWeekdayKey(currentDate);
        const availability = member.availability || undefined;
        const dayAvailability = availability?.[dayKey];

        if (!dayAvailability || !dayAvailability.available) {
          return false;
        }

        const hasBlockedDate =
          (member.blockedDates || []).some((b) => isSameDay(b.date, currentDate)) ||
          (member.companyBlockedDates || []).some((b) => isSameDay(b.date, currentDate));

        if (hasBlockedDate) {
          return false;
        }

        const allRanges = [
          ...(member.blockedRanges || []),
          ...(member.companyBlockedRanges || []),
        ];

        const hasBlockedRange = allRanges.some((r) =>
          dayOverlapsRange(currentDate, r.startDate, r.endDate)
        );

        return !hasBlockedRange;
      });

      console.log(`[getEarliestBookableDate] ${currentDate.toISOString().split('T')[0]} - Available members: ${availableMembers.length}`);

      if (availableMembers.length > 0) {
        // Check if there are available time slots
        const hasSlots = await hasAvailableTimeSlots(project, currentDate, teamMembers, executionHours);
        console.log(`[getEarliestBookableDate] ${currentDate.toISOString().split('T')[0]} - Has time slots: ${hasSlots}`);
        if (hasSlots) {
          console.log(`[getEarliestBookableDate] ✅ Found date with available slots: ${currentDate.toISOString()}`);
          return currentDate;
        }
      }

      currentDate = addDuration(currentDate, 1, 'days');
      searchIterations++;
    }

    console.warn(`[getEarliestBookableDate] ⚠️ No date with available time slots found in ${maxSearchDays} days`);
  }

  return currentDate;
};

const calculateBlockedHoursForDay = (member: IUser, day: Date): number => {
  const dayKey = getWeekdayKey(day);
  const availability = member.availability || undefined;
  const dayAvailability = availability?.[dayKey];

  // If not available on this weekday, return 0 (we'll handle this separately)
  if (!dayAvailability || !dayAvailability.available) {
    return 0;
  }

  // Parse working hours for the day
  const startTime = dayAvailability.startTime || "08:00";
  const endTime = dayAvailability.endTime || "17:00";
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);

  const dayStart = new Date(day);
  dayStart.setHours(startHour, startMin, 0, 0);

  const dayEnd = new Date(day);
  dayEnd.setHours(endHour, endMin, 0, 0);

  const totalWorkingHours = (dayEnd.getTime() - dayStart.getTime()) / (1000 * 60 * 60);

  // Check for full-day blocked dates
  const hasBlockedDate =
    (member.blockedDates || []).some((b) => isSameDay(b.date, day)) ||
    (member.companyBlockedDates || []).some((b) => isSameDay(b.date, day));

  if (hasBlockedDate) {
    return totalWorkingHours; // Entire working day is blocked
  }

  // Calculate blocked hours from ranges
  let blockedHours = 0;
  const allRanges = [
    ...(member.blockedRanges || []),
    ...(member.companyBlockedRanges || []),
  ];

  for (const range of allRanges) {
    if (!dayOverlapsRange(day, range.startDate, range.endDate)) {
      continue;
    }

    // Calculate overlap between range and this day's working hours
    const rangeStart = new Date(range.startDate);
    const rangeEnd = new Date(range.endDate);

    // Clamp range to this day's working hours
    const overlapStart = new Date(Math.max(dayStart.getTime(), rangeStart.getTime()));
    const overlapEnd = new Date(Math.min(dayEnd.getTime(), rangeEnd.getTime()));

    if (overlapEnd > overlapStart) {
      const hours = (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60);
      blockedHours += hours;
    }
  }

  return Math.min(blockedHours, totalWorkingHours);
};

/**
 * Determine which team members are considered "available" on a given day.
 * A day is considered unavailable if:
 * - Member is not scheduled to work that weekday, OR
 * - For DAYS mode: More than 4 hours are blocked on that day
 * - For HOURS mode: Check if there are any available hours at all
 */
const getAvailableMembersForDay = (members: IUser[], day: Date, mode?: "hours" | "days"): IUser[] => {
  const dayKey = getWeekdayKey(day);

  return members.filter((member) => {
    const availability = member.availability || undefined;
    const dayAvailability = availability?.[dayKey];

    // Not scheduled to work on this weekday at all
    if (!dayAvailability || !dayAvailability.available) {
      return false;
    }

    // Calculate blocked hours
    const blockedHours = calculateBlockedHoursForDay(member, day);

    // Parse working hours for the day to get total available hours
    const startTime = dayAvailability.startTime || "08:00";
    const endTime = dayAvailability.endTime || "17:00";
    const [startHour, startMin] = startTime.split(':').map(Number);
    const [endHour, endMin] = endTime.split(':').map(Number);
    const totalWorkingHours = ((endHour * 60 + endMin) - (startHour * 60 + startMin)) / 60;

    if (mode === "hours") {
      // Hours mode: Member is available if there are ANY unblocked hours on this day
      // Allow partial-day bookings
      return blockedHours < totalWorkingHours;
    } else {
      // Days mode: Apply 4-hour rule (if more than 4 hours blocked, day is unavailable)
      // This prevents fragmenting multi-day projects
      if (blockedHours >= 4) {
        return false;
      }
    }

    return true;
  });
};

/**
 * Find the earliest available day for each team member
 */
const findEarliestAvailabilityPerMember = (
  members: IUser[],
  searchStart: Date,
  maxDays: number,
  mode: "hours" | "days"
): Map<string, Date> => {
  const result = new Map<string, Date>();

  for (const member of members) {
    for (let i = 0; i < maxDays; i++) {
      const day = addDuration(searchStart, i, "days");
      const availableMembers = getAvailableMembersForDay([member], day, mode);

      if (availableMembers.length > 0) {
        result.set((member._id as any).toString(), day);
        break;
      }
    }
  }

  return result;
};

/**
 * Count total available days for a member within a date range
 */
const countAvailableDays = (
  member: IUser,
  startDate: Date,
  endDate: Date,
  mode: "hours" | "days"
): number => {
  let count = 0;
  let currentDate = startOfDay(startDate);
  const endDay = startOfDay(endDate);

  while (currentDate <= endDay) {
    const availableMembers = getAvailableMembersForDay([member], currentDate, mode);
    if (availableMembers.length > 0) {
      count++;
    }
    currentDate = addDuration(currentDate, 1, "days");
  }

  return count;
};

/**
 * Calculate overlap percentage between primary member's available days and other member's available days
 * within a specific window of days
 */
const calculateOverlapPercentage = (
  primaryMember: IUser,
  otherMember: IUser,
  windowDays: Date[],
  mode: "hours" | "days"
): number => {
  if (windowDays.length === 0) return 0;

  const primaryAvailableDays = windowDays.filter((day) => {
    const available = getAvailableMembersForDay([primaryMember], day, mode);
    return available.length > 0;
  });

  if (primaryAvailableDays.length === 0) return 0;

  const overlapDays = primaryAvailableDays.filter((day) => {
    const available = getAvailableMembersForDay([otherMember], day, mode);
    return available.length > 0;
  });

  return (overlapDays.length / primaryAvailableDays.length) * 100;
};

/**
 * Check if secondary resources meet the minimum overlap requirement with primary
 */
const meetsOverlapRequirement = (
  primaryMember: IUser,
  otherMembers: IUser[],
  windowDays: Date[],
  minOverlapPercentage: number,
  mode: "hours" | "days"
): boolean => {
  for (const otherMember of otherMembers) {
    const overlap = calculateOverlapPercentage(primaryMember, otherMember, windowDays, mode);
    if (overlap < minOverlapPercentage) {
      return false;
    }
  }
  return true;
};

/**
 * Calculate the first available date for a project.
 * This is a simplified calculation that returns the earliest date when work can start,
 * considering preparation time and team member availability.
 *
 * @param project - The project to calculate availability for
 * @returns The first available date as an ISO string, or null if cannot be determined
 */
export const calculateFirstAvailableDate = async (
  project: IProject
): Promise<string | null> => {
  try {
    console.log(`[calculateFirstAvailableDate] Starting for project ${project._id}`);
    console.log(`[calculateFirstAvailableDate] Time mode: ${project.timeMode}`);
    console.log(`[calculateFirstAvailableDate] Preparation duration:`, project.preparationDuration);

    const earliestBookableDate = await getEarliestBookableDate(project);

    if (!earliestBookableDate) {
      console.warn(`[calculateFirstAvailableDate] ⚠️ No earliest bookable date found for project ${project._id}`);
      return null;
    }

    const isoDate = earliestBookableDate.toISOString();
    console.log(`[calculateFirstAvailableDate] ✅ Earliest bookable date: ${isoDate}`);

    // Return the earliest bookable date as ISO string
    return isoDate;
  } catch (error) {
    console.error('Error calculating first available date for project:', error);
    return null;
  }
};

export const getScheduleProposalsForProject = async (
  projectId: string,
  options?: ScheduleOptions
): Promise<ScheduleProposals | null> => {
  const project = await Project.findById(projectId);
  if (!project) return null;

  const mode: "hours" | "days" =
    project.timeMode || project.executionDuration?.unit || "days";

  const executionContext = getExecutionContext(project, options);
  const earliestBookableDate = await getEarliestBookableDate(project, options);

  if (!executionContext.executionDuration) {
    return {
      mode,
      earliestBookableDate,
    };
  }

  const executionHours = toHours(
    executionContext.executionDuration.value,
    executionContext.executionDuration.unit
  );

  // Buffer duration is optional, default to 0 if not set
  const bufferHours = executionContext.bufferDuration
    ? toHours(executionContext.bufferDuration.value, executionContext.bufferDuration.unit)
    : 0;

  const totalHours = executionHours + bufferHours;

  // Separate execution and buffer for formula calculations
  const executionDays = Math.max(1, Math.ceil(executionHours / HOURS_PER_DAY));
  const bufferDays = Math.ceil(bufferHours / HOURS_PER_DAY);

  const minResources = project.minResources && project.minResources > 0
    ? project.minResources
    : 1;

  // Load team members based on project.resources; if none, fallback to professionalId.
  const resourceIds: string[] = Array.isArray(project.resources)
    ? project.resources.map((r) => r.toString())
    : [];

  if (!resourceIds.length && project.professionalId) {
    resourceIds.push(project.professionalId.toString());
  }

  const teamMembers: IUser[] = resourceIds.length
    ? await User.find({ _id: { $in: resourceIds } })
    : [];

  // Fetch existing bookings to block those dates from schedule proposals
  const existingBookings = await Booking.find({
    project: project._id,
    status: { $in: ['rfq', 'quoted', 'quote_accepted', 'payment_pending', 'booked', 'in_progress'] }
  }).select('rfqData selectedSubprojectIndex scheduledStartDate scheduledEndDate');

  // Helper to check if a day is blocked by an existing booking
  const isDayBlockedByBooking = (day: Date): boolean => {
    const dayStart = startOfDay(day);
    const dayEnd = addDuration(dayStart, 1, 'days');

    for (const booking of existingBookings) {
      // Check scheduled dates first
      if (booking.scheduledStartDate && booking.scheduledEndDate) {
        const bookingStart = new Date(booking.scheduledStartDate);
        const bookingEnd = new Date(booking.scheduledEndDate);
        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          return true;
        }
        continue;
      }

      // Fall back to rfqData
      if (!booking.rfqData?.preferredStartDate) continue;

      // Get execution duration from the selected subproject or project
      let bookingExecutionHours = 0;
      if (typeof booking.selectedSubprojectIndex === 'number' && project.subprojects?.[booking.selectedSubprojectIndex]) {
        const subproject = project.subprojects[booking.selectedSubprojectIndex];
        const execDuration = subproject.executionDuration;
        if (execDuration) {
          bookingExecutionHours = execDuration.unit === 'hours' ? (execDuration.value || 0) : (execDuration.value || 0) * 24;
        }
      } else if (project.executionDuration) {
        bookingExecutionHours = project.executionDuration.unit === 'hours'
          ? (project.executionDuration.value || 0)
          : (project.executionDuration.value || 0) * 24;
      }

      if (bookingExecutionHours <= 0) continue;

      // For days mode, check if the booking blocks this day
      if (mode === 'days') {
        const bookingStart = new Date(booking.rfqData.preferredStartDate);
        bookingStart.setHours(0, 0, 0, 0);

        const durationDays = Math.ceil(bookingExecutionHours / 24);
        const bookingEnd = new Date(bookingStart);
        bookingEnd.setDate(bookingEnd.getDate() + durationDays);

        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          return true;
        }
      }
      // For hours mode with specific start time
      else if (mode === 'hours' && booking.rfqData.preferredStartTime) {
        const bookingStart = new Date(booking.rfqData.preferredStartDate);
        const [hours, minutes] = booking.rfqData.preferredStartTime.split(':').map(Number);
        bookingStart.setHours(hours, minutes, 0, 0);

        const bookingEnd = new Date(bookingStart);
        bookingEnd.setHours(bookingEnd.getHours() + bookingExecutionHours);

        // For hours mode, only block if the entire day is taken
        // This is a conservative check - the slot-level check happens elsewhere
        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          // Check if the booking spans the entire working day
          const dayAvailabilityStart = new Date(day);
          dayAvailabilityStart.setHours(8, 0, 0, 0);
          const dayAvailabilityEnd = new Date(day);
          dayAvailabilityEnd.setHours(17, 0, 0, 0);

          if (bookingStart <= dayAvailabilityStart && bookingEnd >= dayAvailabilityEnd) {
            return true;
          }
        }
      }
    }
    return false;
  };

  if (!teamMembers.length) {
    // No team members with availability information; fall back to simple proposals.
    const fallbackStart = startOfDay(earliestBookableDate);
    if (mode === "hours") {
      return {
        mode,
        earliestBookableDate,
        earliestProposal: {
          start: fallbackStart,
          end: addDuration(fallbackStart, totalHours, "hours"),
        },
      };
    }

    const durationDays = Math.max(1, Math.ceil(totalHours / HOURS_PER_DAY));
    return {
      mode,
      earliestBookableDate,
      earliestProposal: {
        start: fallbackStart,
        end: addDuration(fallbackStart, durationDays, "days"),
      },
      shortestThroughputProposal: {
        start: fallbackStart,
        end: addDuration(fallbackStart, durationDays, "days"),
      },
    };
  }

  // Build day-by-day availability for a search horizon.
  const searchStart = startOfDay(earliestBookableDate);
  const availabilityByDay: {
    date: Date;
    availableMembers: IUser[];
  }[] = [];

  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const day = addDuration(searchStart, i, "days");
    // If this day is blocked by an existing booking, mark it as unavailable
    const isBlockedByBooking = isDayBlockedByBooking(day);
    const availableMembers = isBlockedByBooking
      ? []
      : getAvailableMembersForDay(teamMembers, day, mode);
    availabilityByDay.push({
      date: day,
      availableMembers: availableMembers,
    });
  }

  // Get the minimum overlap percentage from project settings (default 70%)
  const minOverlapPercentage = project.minOverlapPercentage || 70;

  if (mode === "hours") {
    // Hours mode: All resources must be available for the entire project duration.
    // We look for the earliest window where ALL minResources are continuously available.
    const requiredDurationHours = totalHours;
    const requiredDays = Math.max(
      1,
      Math.ceil(requiredDurationHours / HOURS_PER_DAY)
    );

    let earliestWindow: TimeWindow | undefined;

    for (let i = 0; i <= MAX_SEARCH_DAYS - requiredDays; i++) {
      const windowDays = availabilityByDay.slice(i, i + requiredDays);

      // Get all members available across ALL days in the window
      const availableAcrossAllDays = teamMembers.filter((member) => {
        return windowDays.every((dayInfo) => {
          return dayInfo.availableMembers.some(
            (m) => (m._id as any).toString() === (member._id as any).toString()
          );
        });
      });

      // Check if we have enough resources available for entire duration
      if (availableAcrossAllDays.length < minResources) continue;

      const start = windowDays[0].date;
      const end = addDuration(start, requiredDurationHours, "hours");
      earliestWindow = { start, end };
      break;
    }

    return {
      mode,
      earliestBookableDate,
      earliestProposal: earliestWindow,
    };
  }

  // Days mode: compute duration and throughput limits.
  // NEW FORMULA: (execution + X%) + buffer
  // Earliest: (execution + 100%) + buffer
  // Shortest: (execution + 20%) + buffer
  const totalDays = Math.max(1, Math.ceil(totalHours / HOURS_PER_DAY));
  const maxThroughputEarliest = (executionDays * 2) + bufferDays; // (execution + 100%) + buffer
  const maxThroughputShortest = Math.max(
    totalDays,
    Math.floor(executionDays * 1.2) + bufferDays
  ); // (execution + 20%) + buffer

  let earliestProposal: TimeWindow | undefined;
  let shortestThroughputProposal: TimeWindow | undefined;

  // EARLIEST POSSIBLE: Find earliest contiguous block where primary person (earliest availability)
  // and other resources meet overlap requirements
  if (minResources === 1) {
    // Single resource - simple case
    for (let i = 0; i <= MAX_SEARCH_DAYS - totalDays; i++) {
      const windowDays = availabilityByDay.slice(i, i + totalDays);
      const allDaysHaveResource = windowDays.every(
        (d) => d.availableMembers.length >= 1
      );

      if (!allDaysHaveResource) continue;

      const start = windowDays[0].date;
      const end = addDuration(start, totalDays, "days");
      earliestProposal = { start, end };
      break;
    }
  } else {
    // Multiple resources - need primary person selection and overlap calculation
    // Find earliest availability for each member
    const earliestAvailability = findEarliestAvailabilityPerMember(
      teamMembers,
      searchStart,
      MAX_SEARCH_DAYS,
      mode
    );

    // Select primary person: the one with earliest availability
    let primaryMember: IUser | undefined;
    let earliestDate: Date | undefined;

    for (const member of teamMembers) {
      const memberEarliestDate = earliestAvailability.get(
        (member._id as any).toString()
      );
      if (!memberEarliestDate) continue;

      if (!earliestDate || memberEarliestDate < earliestDate) {
        earliestDate = memberEarliestDate;
        primaryMember = member;
      }
    }

    if (primaryMember) {
      const otherMembers = teamMembers.filter(
        (m) => (m._id as any).toString() !== (primaryMember!._id as any).toString()
      );

      // Search for earliest window where primary + others meet overlap requirements
      for (let length = totalDays; length <= maxThroughputEarliest; length++) {
        let found = false;
        for (let i = 0; i <= MAX_SEARCH_DAYS - length; i++) {
          const windowDays = availabilityByDay.slice(i, i + length);
          const windowDates = windowDays.map((d) => d.date);

          // Check if primary member is available enough days
          const primaryAvailableDays = windowDays.filter((d) =>
            d.availableMembers.some(
              (m) => (m._id as any).toString() === (primaryMember!._id as any).toString()
            )
          );

          if (primaryAvailableDays.length < totalDays) continue;

          // Check if we have enough total resources per day
          const hasEnoughResources = windowDays.every((d) => {
            const count = d.availableMembers.filter((m) => {
              const mId = (m._id as any).toString();
              const primaryId = (primaryMember!._id as any).toString();
              return (
                mId === primaryId ||
                otherMembers.some((om) => (om._id as any).toString() === mId)
              );
            }).length;
            return count >= minResources;
          });

          if (!hasEnoughResources) continue;

          // Check overlap requirement with other members
          if (
            otherMembers.length > 0 &&
            !meetsOverlapRequirement(
              primaryMember!,
              otherMembers,
              windowDates,
              minOverlapPercentage,
              mode
            )
          ) {
            continue;
          }

          const start = windowDays[0].date;
          const end = addDuration(start, length, "days");
          earliestProposal = { start, end };
          found = true;
          break;
        }
        if (found) break;
      }
    }
  }

  if (minResources === 1) {
    // Single resource - simple case
    for (let length = totalDays; length <= maxThroughputShortest; length++) {
      let found = false;
      for (let i = 0; i <= MAX_SEARCH_DAYS - length; i++) {
        const windowDays = availabilityByDay.slice(i, i + length);
        const allDaysHaveResource = windowDays.every(
          (d) => d.availableMembers.length >= 1
        );

        if (!allDaysHaveResource) continue;

        const start = windowDays[0].date;
        const end = addDuration(start, length, "days");
        shortestThroughputProposal = { start, end };
        found = true;
        break;
      }
      if (found) break;
    }
  } else {
    // Multiple resources - select primary person with MOST availability
    const searchEnd = addDuration(searchStart, MAX_SEARCH_DAYS, "days");
    let primaryMember: IUser | undefined;
    let maxAvailableDays = 0;

    for (const member of teamMembers) {
      const availableDays = countAvailableDays(member, searchStart, searchEnd, mode);
      if (availableDays > maxAvailableDays) {
        maxAvailableDays = availableDays;
        primaryMember = member;
      }
    }

    if (primaryMember) {
      const otherMembers = teamMembers.filter(
        (m) => (m._id as any).toString() !== (primaryMember!._id as any).toString()
      );

      // Search for shortest window where primary + others meet overlap requirements
      for (let length = totalDays; length <= maxThroughputShortest; length++) {
        let found = false;
        for (let i = 0; i <= MAX_SEARCH_DAYS - length; i++) {
          const windowDays = availabilityByDay.slice(i, i + length);
          const windowDates = windowDays.map((d) => d.date);

          // Check if primary member is available enough days
          const primaryAvailableDays = windowDays.filter((d) =>
            d.availableMembers.some(
              (m) => (m._id as any).toString() === (primaryMember!._id as any).toString()
            )
          );

          if (primaryAvailableDays.length < totalDays) continue;

          // Check if we have enough total resources per day
          const hasEnoughResources = windowDays.every((d) => {
            const count = d.availableMembers.filter((m) => {
              const mId = (m._id as any).toString();
              const primaryId = (primaryMember!._id as any).toString();
              return (
                mId === primaryId ||
                otherMembers.some((om) => (om._id as any).toString() === mId)
              );
            }).length;
            return count >= minResources;
          });

          if (!hasEnoughResources) continue;

          // Check overlap requirement with other members
          if (
            otherMembers.length > 0 &&
            !meetsOverlapRequirement(
              primaryMember!,
              otherMembers,
              windowDates,
              minOverlapPercentage,
              mode
            )
          ) {
            continue;
          }

          const start = windowDays[0].date;
          const end = addDuration(start, length, "days");
          shortestThroughputProposal = { start, end };
          found = true;
          break;
        }
        if (found) break;
      }
    }
  }

  return {
    mode,
    earliestBookableDate,
    earliestProposal,
    shortestThroughputProposal,
  };
};

