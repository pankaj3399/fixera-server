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

const isWeekend = (date: Date): boolean => {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
};

const isDayAvailableForPrepTime = (
  date: Date,
  teamMembers: IUser[]
): boolean => {
  // Weekend days are not available for prep time
  if (isWeekend(date)) {
    return false;
  }

  if (teamMembers.length === 0) {
    return true;
  }

  const allMembersHaveHoliday = teamMembers.every((member) => {
    const companyBlockedDates = member.companyBlockedDates || [];
    return companyBlockedDates.some(
      (b) => isSameDay(b.date, date) && b.isHoliday === true
    );
  });

  if (allMembersHaveHoliday) {
    return false;
  }

  // Also check company blocked ranges that are holidays
  const allMembersHaveHolidayRange = teamMembers.every((member) => {
    const companyBlockedRanges = member.companyBlockedRanges || [];
    return companyBlockedRanges.some(
      (r) => dayOverlapsRange(date, r.startDate, r.endDate) && r.isHoliday === true
    );
  });

  if (allMembersHaveHolidayRange) {
    return false;
  }

  return true;
};

/**
 * Check if a day is blocked by an existing booking for the project.
 * This is used during prep time calculation and availability checks.
 */
const PARTIAL_BLOCK_THRESHOLD_HOURS = 4;

const isDayBlockedByBooking = (
  day: Date,
  existingBookings: Array<{
    scheduledStartDate?: Date;
    scheduledEndDate?: Date;
    rfqData?: {
      preferredStartDate?: Date;
      preferredStartTime?: string;
    };
    selectedSubprojectIndex?: number;
  }> | null | undefined,
  project: IProject,
  mode: "hours" | "days"
): boolean => {
  // Handle case when no bookings exist
  if (!existingBookings || !Array.isArray(existingBookings) || existingBookings.length === 0) {
    return false;
  }

  const dayStart = startOfDay(day);
  const dayEnd = addDuration(dayStart, 1, "days");

  // For hours mode, calculate total booked hours on this day
  if (mode === 'hours') {
    let totalBookedHours = 0;

    for (const booking of existingBookings) {
      // Check scheduled dates first
      if (booking.scheduledStartDate && booking.scheduledEndDate) {
        const bookingStart = new Date(booking.scheduledStartDate);
        const bookingEnd = new Date(booking.scheduledEndDate);

        // Check if booking overlaps with this day
        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          // Calculate hours booked on this specific day
          const overlapStart = bookingStart > dayStart ? bookingStart : dayStart;
          const overlapEnd = bookingEnd < dayEnd ? bookingEnd : dayEnd;
          const hoursOnThisDay = (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60);
          totalBookedHours += hoursOnThisDay;
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

      if (booking.rfqData.preferredStartTime) {
        const bookingStart = new Date(booking.rfqData.preferredStartDate);
        const [hours, minutes] = booking.rfqData.preferredStartTime.split(':').map(Number);
        bookingStart.setHours(hours, minutes, 0, 0);

        const bookingEnd = new Date(bookingStart);
        bookingEnd.setHours(bookingEnd.getHours() + bookingExecutionHours);

        // Check if booking overlaps with this day
        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          const overlapStart = bookingStart > dayStart ? bookingStart : dayStart;
          const overlapEnd = bookingEnd < dayEnd ? bookingEnd : dayEnd;
          const hoursOnThisDay = (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60);
          totalBookedHours += hoursOnThisDay;
        }
      }
    }

    // Only block day if total booked hours exceed threshold
    return totalBookedHours > PARTIAL_BLOCK_THRESHOLD_HOURS;
  }

  // For days mode, block if any booking overlaps with this day
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

    const bookingStart = new Date(booking.rfqData.preferredStartDate);
    bookingStart.setHours(0, 0, 0, 0);

    const durationDays = Math.ceil(bookingExecutionHours / 24);
    const bookingEnd = new Date(bookingStart);
    bookingEnd.setDate(bookingEnd.getDate() + durationDays);

    if (dayStart < bookingEnd && dayEnd > bookingStart) {
      return true;
    }
  }

  return false;
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

export const getEarliestBookableDate = async (project: IProject, options?: ScheduleOptions): Promise<Date> => {
  const now = new Date();
  const mode: "hours" | "days" = project.timeMode || project.executionDuration?.unit || "days";

  const executionContext = getExecutionContext(project, options);
  const prepValue = executionContext.preparation.value;
  const prepUnit = executionContext.preparation.unit;
  const executionHours = executionContext.executionDuration
    ? toHours(executionContext.executionDuration.value, executionContext.executionDuration.unit)
    : 0;

  // Fetch existing bookings to check during prep calculation
  const existingBookings = await Booking.find({
    project: project._id,
    status: { $in: ['rfq', 'quoted', 'quote_accepted', 'payment_pending', 'booked', 'in_progress'] }
  }).select('rfqData selectedSubprojectIndex scheduledStartDate scheduledEndDate');

  console.log(`[getEarliestBookableDate] Found ${existingBookings.length} existing bookings for project ${project._id}`);

  // Get team members to determine working days
  const resourceIds: string[] = Array.isArray(project.resources)
    ? project.resources.map((r) => r.toString())
    : [];

  if (!resourceIds.length && project.professionalId) {
    resourceIds.push(project.professionalId.toString());
  }

  const teamMembers: IUser[] = resourceIds.length
    ? await User.find({ _id: { $in: resourceIds } })
    : [];

  // Helper to calculate total blocked hours from ranges on a specific day
  const calculateBlockedHoursFromRanges = (date: Date, ranges: Array<{ startDate: Date; endDate: Date }>): number => {
    const dayStart = startOfDay(date);
    const dayEnd = addDuration(dayStart, 1, "days");
    let totalBlockedHours = 0;

    for (const range of ranges) {
      const rangeStart = new Date(range.startDate);
      const rangeEnd = new Date(range.endDate);

      // Check if range overlaps with this day
      if (rangeStart < dayEnd && rangeEnd > dayStart) {
        const overlapStart = rangeStart > dayStart ? rangeStart : dayStart;
        const overlapEnd = rangeEnd < dayEnd ? rangeEnd : dayEnd;
        const hoursOnThisDay = (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60);
        totalBlockedHours += hoursOnThisDay;
      }
    }

    return totalBlockedHours;
  };

  // Helper to check if a day is available (team + not blocked by booking)
  const isDayAvailable = (date: Date): boolean => {
    // Check if blocked by existing booking
    if (isDayBlockedByBooking(date, existingBookings, project, mode)) {
      return false;
    }

    // If no team members, day is available
    if (!teamMembers.length) {
      return true;
    }

    // Check if at least one team member is available
    const availableMembers = teamMembers.filter((member) => {
      const dayKey = getWeekdayKey(date);
      const availability = member.availability || undefined;
      const dayAvailability = availability?.[dayKey];

      if (!dayAvailability || !dayAvailability.available) {
        return false;
      }

      const hasBlockedDate =
        (member.blockedDates || []).some((b) => isSameDay(b.date, date)) ||
        (member.companyBlockedDates || []).some((b) => isSameDay(b.date, date));

      if (hasBlockedDate) {
        return false;
      }

      const allRanges = [
        ...(member.blockedRanges || []),
        ...(member.companyBlockedRanges || []),
      ];

      // For hours mode, apply the 4-hour threshold
      if (mode === 'hours') {
        const totalBlockedHours = calculateBlockedHoursFromRanges(date, allRanges);
        return totalBlockedHours <= PARTIAL_BLOCK_THRESHOLD_HOURS;
      }

      // For days mode, any overlap blocks the day
      const hasBlockedRange = allRanges.some((r) =>
        dayOverlapsRange(date, r.startDate, r.endDate)
      );

      return !hasBlockedRange;
    });

    return availableMembers.length > 0;
  };

  // If no preparation time, find first available day from now
  if (prepValue === 0) {
    console.log(`[getEarliestBookableDate] No preparation time, finding first available date`);
    let currentDate = startOfDay(now);
    const maxSearchDays = 120;

    for (let i = 0; i < maxSearchDays; i++) {
      currentDate = addDuration(startOfDay(now), i, 'days');

      if (!isDayAvailable(currentDate)) {
        continue;
      }

      // For hours mode, also check time slots
      if (mode === 'hours') {
        const hasSlots = await hasAvailableTimeSlots(project, currentDate, teamMembers, executionHours);
        if (!hasSlots) {
          continue;
        }
      }

      console.log(`[getEarliestBookableDate] ✅ First available date (no prep): ${currentDate.toISOString()}`);
      return currentDate;
    }

    // Fallback to tomorrow if nothing found
    return addDuration(now, 1, 'days');
  }

  // If preparation is in hours, add hours then find first available day
  if (prepUnit === 'hours') {
    const afterPrepTime = addDuration(now, prepValue, 'hours');
    let currentDate = startOfDay(afterPrepTime);
    const maxSearchDays = 120;

    for (let i = 0; i < maxSearchDays; i++) {
      if (!isDayAvailable(currentDate)) {
        currentDate = addDuration(currentDate, 1, 'days');
        continue;
      }

      // For hours mode, also check time slots
      if (mode === 'hours') {
        const hasSlots = await hasAvailableTimeSlots(project, currentDate, teamMembers, executionHours);
        if (!hasSlots) {
          currentDate = addDuration(currentDate, 1, 'days');
          continue;
        }
      }

      console.log(`[getEarliestBookableDate] ✅ First available date (after ${prepValue}h prep): ${currentDate.toISOString()}`);
      return currentDate;
    }

    return afterPrepTime;
  }

  // For days-based preparation, count only working days (not blocked by bookings or team)
  let workingDaysCount = 0;
  let currentDate = startOfDay(now);
  const maxIterations = prepValue * 5; // Safety limit
  let iterations = 0;

  console.log(`[getEarliestBookableDate] Counting ${prepValue} working days for preparation...`);

  while (workingDaysCount < prepValue && iterations < maxIterations) {
    iterations++;
    currentDate = addDuration(currentDate, 1, 'days');

    if (isDayAvailableForPrepTime(currentDate, teamMembers)) {
      workingDaysCount++;
      console.log(`[getEarliestBookableDate] ${currentDate.toISOString().split('T')[0]} - Working day ${workingDaysCount}/${prepValue}`);
    } else {
      console.log(`[getEarliestBookableDate] ${currentDate.toISOString().split('T')[0]} - Blocked/unavailable, skipping`);
    }
  }

  console.log(`[getEarliestBookableDate] After ${prepValue} working days prep: ${currentDate.toISOString()}`);

  // After prep time, find the first available day for actual work
  const maxSearchDays = 120;
  let searchIterations = 0;

  while (searchIterations < maxSearchDays) {
    if (!isDayAvailable(currentDate)) {
      currentDate = addDuration(currentDate, 1, 'days');
      searchIterations++;
      continue;
    }

    // For hours mode, also check time slots
    if (mode === 'hours') {
      const hasSlots = await hasAvailableTimeSlots(project, currentDate, teamMembers, executionHours);
      if (!hasSlots) {
        console.log(`[getEarliestBookableDate] ${currentDate.toISOString().split('T')[0]} - No time slots available`);
        currentDate = addDuration(currentDate, 1, 'days');
        searchIterations++;
        continue;
      }

      // For hours mode, set the actual start time based on professional's working hours
      const dayKey = getWeekdayKey(currentDate);
      let earliestStartTime = "09:00"; // Default

      for (const member of teamMembers) {
        const dayAvailability = member.availability?.[dayKey];
        if (dayAvailability?.available && dayAvailability.startTime) {
          if (dayAvailability.startTime < earliestStartTime) {
            earliestStartTime = dayAvailability.startTime;
          }
        }
      }

      const [startHour, startMin] = earliestStartTime.split(':').map(Number);
      currentDate.setHours(startHour, startMin, 0, 0);

      console.log(`[getEarliestBookableDate] ✅ First available date/time: ${currentDate.toISOString()}`);
      return currentDate;
    }

    console.log(`[getEarliestBookableDate] ✅ First available date: ${currentDate.toISOString()}`);
    return currentDate;
  }

  console.warn(`[getEarliestBookableDate] ⚠️ No available date found in ${maxSearchDays} days after prep`);
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

    // Get schedule proposals which include throughput-constrained suggestions
    const proposals = await getScheduleProposalsForProject(
      (project._id as any).toString()
    );

    if (!proposals) {
      console.warn(`[calculateFirstAvailableDate] ⚠️ Could not get schedule proposals for project ${project._id}`);
      // Fallback to basic earliest bookable date
      const earliestBookableDate = await getEarliestBookableDate(project);
      return earliestBookableDate?.toISOString() || null;
    }

    // Use earliestProposal.start if available (this respects throughput limits)
    if (proposals.earliestProposal?.start) {
      const isoDate = proposals.earliestProposal.start.toISOString();
      console.log(`[calculateFirstAvailableDate] ✅ Using earliestProposal.start: ${isoDate}`);
      return isoDate;
    }

    // Fallback to earliestBookableDate if no proposal found
    if (proposals.earliestBookableDate) {
      const isoDate = proposals.earliestBookableDate.toISOString();
      console.log(`[calculateFirstAvailableDate] ✅ Fallback to earliestBookableDate: ${isoDate}`);
      return isoDate;
    }

    console.warn(`[calculateFirstAvailableDate] ⚠️ No available date found for project ${project._id}`);
    return null;
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
  // For hours mode, uses 4-hour threshold (day is blocked only if >4 hours are booked)
  const isDayBlockedByBookingLocal = (day: Date): boolean => {
    const dayStart = startOfDay(day);
    const dayEnd = addDuration(dayStart, 1, 'days');

    // For hours mode, calculate total booked hours on this day
    if (mode === 'hours') {
      let totalBookedHours = 0;

      for (const booking of existingBookings) {
        // Check scheduled dates first
        if (booking.scheduledStartDate && booking.scheduledEndDate) {
          const bookingStart = new Date(booking.scheduledStartDate);
          const bookingEnd = new Date(booking.scheduledEndDate);

          // Check if booking overlaps with this day
          if (dayStart < bookingEnd && dayEnd > bookingStart) {
            const overlapStart = bookingStart > dayStart ? bookingStart : dayStart;
            const overlapEnd = bookingEnd < dayEnd ? bookingEnd : dayEnd;
            const hoursOnThisDay = (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60);
            totalBookedHours += hoursOnThisDay;
          }
          continue;
        }

        // Fall back to rfqData
        if (!booking.rfqData?.preferredStartDate || !booking.rfqData.preferredStartTime) continue;

        // Get execution duration
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

        const bookingStart = new Date(booking.rfqData.preferredStartDate);
        const [hours, minutes] = booking.rfqData.preferredStartTime.split(':').map(Number);
        bookingStart.setHours(hours, minutes, 0, 0);

        const bookingEnd = new Date(bookingStart);
        bookingEnd.setHours(bookingEnd.getHours() + bookingExecutionHours);

        // Check if booking overlaps with this day
        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          const overlapStart = bookingStart > dayStart ? bookingStart : dayStart;
          const overlapEnd = bookingEnd < dayEnd ? bookingEnd : dayEnd;
          const hoursOnThisDay = (overlapEnd.getTime() - overlapStart.getTime()) / (1000 * 60 * 60);
          totalBookedHours += hoursOnThisDay;
        }
      }

      // Only block day if total booked hours exceed threshold (4 hours)
      return totalBookedHours > PARTIAL_BLOCK_THRESHOLD_HOURS;
    }

    // For days mode, block if any booking overlaps with this day
    for (const booking of existingBookings) {
      if (booking.scheduledStartDate && booking.scheduledEndDate) {
        const bookingStart = new Date(booking.scheduledStartDate);
        const bookingEnd = new Date(booking.scheduledEndDate);
        if (dayStart < bookingEnd && dayEnd > bookingStart) {
          return true;
        }
        continue;
      }

      if (!booking.rfqData?.preferredStartDate) continue;

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

      const bookingStart = new Date(booking.rfqData.preferredStartDate);
      bookingStart.setHours(0, 0, 0, 0);

      const durationDays = Math.ceil(bookingExecutionHours / 24);
      const bookingEnd = new Date(bookingStart);
      bookingEnd.setDate(bookingEnd.getDate() + durationDays);

      if (dayStart < bookingEnd && dayEnd > bookingStart) {
        return true;
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
    const isBlockedByBooking = isDayBlockedByBookingLocal(day);
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

      // For hours mode, set the start time to the professional's working hours start time
      const startDate = new Date(windowDays[0].date);
      const dayKey = getWeekdayKey(startDate);

      // Get the earliest start time from available members
      let earliestStartTime = "09:00"; // Default
      for (const member of availableAcrossAllDays) {
        const dayAvailability = member.availability?.[dayKey];
        if (dayAvailability?.available && dayAvailability.startTime) {
          // Use the earliest start time among available members
          if (dayAvailability.startTime < earliestStartTime) {
            earliestStartTime = dayAvailability.startTime;
          }
        }
      }

      // Set the actual start time
      const [startHour, startMin] = earliestStartTime.split(':').map(Number);
      startDate.setHours(startHour, startMin, 0, 0);

      const end = addDuration(startDate, requiredDurationHours, "hours");
      earliestWindow = { start: startDate, end };
      console.log(
        `[getScheduleProposals] Hours mode window: start=${startDate.toISOString()}, end=${end.toISOString()}, durationHours=${requiredDurationHours}`
      );
      break;
    }

    if (!earliestWindow) {
      console.log(
        "[getScheduleProposals] Hours mode: no continuous window found for required resources"
      );
    }

    return {
      mode,
      earliestBookableDate,
      earliestProposal: earliestWindow,
      // Hours mode requires continuous work, so earliest == shortest throughput.
      shortestThroughputProposal: earliestWindow,
    };
  }

  // Days mode: compute duration and throughput limits.
  // Throughput = calendar days from start to completion (including gaps)
  // Earliest: max throughput = execution × 2 (100% flexibility)
  // Shortest: max throughput = execution × 1.2 (20% flexibility)
  const totalDays = Math.max(1, Math.ceil(totalHours / HOURS_PER_DAY));
  const maxThroughputEarliest = executionDays * 2; // execution × 2
  const maxThroughputShortest = Math.max(
    executionDays,
    Math.floor(executionDays * 1.2)
  ); // execution × 1.2

  console.log(`[getScheduleProposals] Days mode parameters:`, {
    executionDays,
    bufferDays,
    totalDays,
    maxThroughputEarliest,
    maxThroughputShortest,
    minResources,
    teamMembersCount: teamMembers.length,
  });

  let earliestProposal: TimeWindow | undefined;
  let shortestThroughputProposal: TimeWindow | undefined;

  // Helper to calculate completion date and throughput for a given start date
  // Returns { completionDate, throughput } where throughput is calendar days
  const calculateCompletionForStart = (
    startIndex: number,
    requiredWorkingDays: number
  ): { completionDate: Date; throughput: number } | null => {
    let workingDaysCount = 0;
    let currentIndex = startIndex;

    // First, check if start day is available and count it
    if (availabilityByDay[currentIndex]?.availableMembers.length >= minResources) {
      workingDaysCount = 1;
    } else {
      // Start day must be available
      return null;
    }

    // Count remaining working days
    while (workingDaysCount < requiredWorkingDays && currentIndex < availabilityByDay.length - 1) {
      currentIndex++;
      if (availabilityByDay[currentIndex]?.availableMembers.length >= minResources) {
        workingDaysCount++;
      }
    }

    if (workingDaysCount < requiredWorkingDays) {
      return null;
    }

    const startDate = availabilityByDay[startIndex].date;
    const completionDate = availabilityByDay[currentIndex].date;
    const throughput = Math.round(
      (completionDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
    ) + 1; // +1 because both start and end are included

    return { completionDate, throughput };
  };

  // EARLIEST POSSIBLE: Find earliest start date where throughput ≤ execution × 2
  if (minResources === 1) {
    // Single resource - simple case
    for (let i = 0; i < availabilityByDay.length; i++) {
      // Skip if this day is not available
      if (availabilityByDay[i].availableMembers.length < 1) continue;

      const result = calculateCompletionForStart(i, executionDays);
      if (!result) continue;

      // Check if throughput is within limit
      if (result.throughput <= maxThroughputEarliest) {
        const start = availabilityByDay[i].date;
        // End date is completion + buffer days (add 1 for exclusive end)
        const end = addDuration(result.completionDate, bufferDays + 1, "days");
        earliestProposal = { start, end };
        console.log(`[getScheduleProposals] Found earliestProposal: start=${start.toISOString().split('T')[0]}, throughput=${result.throughput}, max=${maxThroughputEarliest}`);
        break;
      } else {
        console.log(`[getScheduleProposals] Skipping ${availabilityByDay[i].date.toISOString().split('T')[0]}: throughput=${result.throughput} > max=${maxThroughputEarliest}`);
      }
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

      // Search for earliest start where throughput ≤ maxThroughputEarliest
      for (let i = 0; i < availabilityByDay.length; i++) {
        // Skip if not enough resources on this day
        if (availabilityByDay[i].availableMembers.length < minResources) continue;

        const result = calculateCompletionForStart(i, executionDays);
        if (!result) continue;

        // Check throughput limit
        if (result.throughput > maxThroughputEarliest) continue;

        // Get the window for overlap checking
        const windowEnd = Math.min(
          i + result.throughput,
          availabilityByDay.length
        );
        const windowDays = availabilityByDay.slice(i, windowEnd);
        const windowDates = windowDays.map((d) => d.date);

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

        const start = availabilityByDay[i].date;
        const end = addDuration(result.completionDate, bufferDays + 1, "days");
        earliestProposal = { start, end };
        console.log(`[getScheduleProposals] Found earliestProposal (multi): start=${start.toISOString().split('T')[0]}, throughput=${result.throughput}`);
        break;
      }
    }
  }

  // SHORTEST THROUGHPUT: Find start date with the minimum possible throughput
  // Prefer dates where throughput ≤ execution × 1.2, but if none exist, find the absolute minimum
  if (minResources === 1) {
    // Single resource - simple case
    let bestThroughput = Infinity;
    let bestStart: Date | undefined;
    let bestEnd: Date | undefined;

    for (let i = 0; i < availabilityByDay.length; i++) {
      // Skip if this day is not available
      if (availabilityByDay[i].availableMembers.length < 1) continue;

      const result = calculateCompletionForStart(i, executionDays);
      if (!result) continue;

      // Track the shortest throughput found (regardless of limit)
      if (result.throughput < bestThroughput) {
        bestThroughput = result.throughput;
        bestStart = availabilityByDay[i].date;
        bestEnd = addDuration(result.completionDate, bufferDays + 1, "days");
        console.log(`[getScheduleProposals] Found candidate shortestThroughput: start=${bestStart.toISOString().split('T')[0]}, throughput=${result.throughput}, max=${maxThroughputShortest}`);

        // If we found a perfect match (throughput = execution), no need to search further
        if (result.throughput === executionDays) {
          break;
        }
      }
    }

    if (bestStart && bestEnd) {
      shortestThroughputProposal = { start: bestStart, end: bestEnd };
      console.log(`[getScheduleProposals] Final shortestThroughputProposal: start=${bestStart.toISOString().split('T')[0]}, throughput=${bestThroughput}, withinLimit=${bestThroughput <= maxThroughputShortest}`);
    } else {
      console.log(`[getScheduleProposals] No shortestThroughputProposal found. executionDays=${executionDays}`);
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

      // Search for shortest throughput where throughput ≤ maxThroughputShortest.
      // If no option fits under that ceiling, fall back to the absolute best throughput window.
      let bestWithinLimit:
        | { throughput: number; start: Date; end: Date }
        | undefined;
      let bestOverall:
        | { throughput: number; start: Date; end: Date }
        | undefined;

      for (let i = 0; i < availabilityByDay.length; i++) {
        // Skip if not enough resources on this day
        if (availabilityByDay[i].availableMembers.length < minResources) continue;

        const result = calculateCompletionForStart(i, executionDays);
        if (!result) continue;

        const candidate = {
          throughput: result.throughput,
          start: availabilityByDay[i].date,
          end: addDuration(result.completionDate, bufferDays + 1, "days"),
        };
        const exceedsLimit = candidate.throughput > maxThroughputShortest;
        const worseThanBestWithinLimit =
          !exceedsLimit &&
          bestWithinLimit &&
          candidate.throughput >= bestWithinLimit.throughput;

        if (worseThanBestWithinLimit) {
          continue;
        }

        // Get the window for overlap checking
        const windowEnd = Math.min(
          i + result.throughput,
          availabilityByDay.length
        );
        const windowDays = availabilityByDay.slice(i, windowEnd);
        const windowDates = windowDays.map((d) => d.date);

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

        if (!bestOverall || candidate.throughput < bestOverall.throughput) {
          bestOverall = candidate;
        }

        if (!exceedsLimit) {
          if (
            !bestWithinLimit ||
            candidate.throughput < bestWithinLimit.throughput
          ) {
            bestWithinLimit = candidate;
          }
        }

        // If we found a perfect match (throughput = execution), no need to search further
        if (candidate.throughput === executionDays) {
          break;
        }
      }

      const chosenCandidate = bestWithinLimit || bestOverall;

      if (chosenCandidate) {
        shortestThroughputProposal = {
          start: chosenCandidate.start,
          end: chosenCandidate.end,
        };
        console.log(
          `[getScheduleProposals] Final shortestThroughputProposal (multi): start=${chosenCandidate.start
            .toISOString()
            .split("T")[0]}, throughput=${chosenCandidate.throughput}, withinLimit=${
            chosenCandidate.throughput <= maxThroughputShortest
          }`
        );
      } else {
        console.log(
          `[getScheduleProposals] No shortestThroughputProposal found (multi). maxThroughputShortest=${maxThroughputShortest}, executionDays=${executionDays}`
        );
      }
    }
  }

  console.log(`[getScheduleProposals] Returning proposals:`, {
    mode,
    earliestBookableDate: earliestBookableDate?.toISOString().split('T')[0],
    earliestProposal: earliestProposal ? `${earliestProposal.start.toISOString().split('T')[0]} -> ${earliestProposal.end.toISOString().split('T')[0]}` : null,
    shortestThroughputProposal: shortestThroughputProposal ? `${shortestThroughputProposal.start.toISOString().split('T')[0]} -> ${shortestThroughputProposal.end.toISOString().split('T')[0]}` : null,
  });

  return {
    mode,
    earliestBookableDate,
    earliestProposal,
    shortestThroughputProposal,
  };
};

