import Project, { IProject } from "../../models/project";
import User, { IUser } from "../../models/user";

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


const getEarliestBookableDate = async (project: IProject): Promise<Date> => {
  const now = new Date();
  if (!project.preparationDuration || project.preparationDuration.value === 0) {
    return now;
  }

  // If preparation is in hours, just add the hours (no working day logic for hourly)
  if (project.preparationDuration.unit === 'hours') {
    return addDuration(now, project.preparationDuration.value, 'hours');
  }

  // For days-based preparation, count only working days
  const prepDays = project.preparationDuration.value;

  // Get team members to determine working days
  const resourceIds: string[] = Array.isArray(project.resources)
    ? project.resources.map((r) => r.toString())
    : [];

  if (!resourceIds.length && project.professionalId) {
    resourceIds.push(project.professionalId.toString());
  }

  if (!resourceIds.length) {
    // No team members defined, fallback to simple addition
    return addDuration(now, prepDays, 'days');
  }

  const teamMembers: IUser[] = await User.find({ _id: { $in: resourceIds } });

  if (!teamMembers.length) {
    // No team members found, fallback to simple addition
    return addDuration(now, prepDays, 'days');
  }

  // Count working days for preparation
  let workingDaysCount = 0;
  let currentDate = startOfDay(now);
  const maxIterations = prepDays * 3; // Safety limit (3x expected)
  let iterations = 0;

  while (workingDaysCount < prepDays && iterations < maxIterations) {
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
 * - More than 4 hours are blocked on that day
 */
const getAvailableMembersForDay = (members: IUser[], day: Date): IUser[] => {
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

    // Apply 4-hour rule: if more than 4 hours blocked, day is unavailable
    if (blockedHours > 4) {
      return false;
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
  maxDays: number
): Map<string, Date> => {
  const result = new Map<string, Date>();

  for (const member of members) {
    for (let i = 0; i < maxDays; i++) {
      const day = addDuration(searchStart, i, "days");
      const availableMembers = getAvailableMembersForDay([member], day);

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
  endDate: Date
): number => {
  let count = 0;
  let currentDate = startOfDay(startDate);
  const endDay = startOfDay(endDate);

  while (currentDate <= endDay) {
    const availableMembers = getAvailableMembersForDay([member], currentDate);
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
  windowDays: Date[]
): number => {
  if (windowDays.length === 0) return 0;

  const primaryAvailableDays = windowDays.filter((day) => {
    const available = getAvailableMembersForDay([primaryMember], day);
    return available.length > 0;
  });

  if (primaryAvailableDays.length === 0) return 0;

  const overlapDays = primaryAvailableDays.filter((day) => {
    const available = getAvailableMembersForDay([otherMember], day);
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
  minOverlapPercentage: number
): boolean => {
  for (const otherMember of otherMembers) {
    const overlap = calculateOverlapPercentage(primaryMember, otherMember, windowDays);
    if (overlap < minOverlapPercentage) {
      return false;
    }
  }
  return true;
};

export const getScheduleProposalsForProject = async (
  projectId: string
): Promise<ScheduleProposals | null> => {
  const project = await Project.findById(projectId);
  if (!project) return null;

  const mode: "hours" | "days" =
    project.timeMode || project.executionDuration?.unit || "days";

  const earliestBookableDate = await getEarliestBookableDate(project);

  if (!project.executionDuration || !project.bufferDuration) {
    return {
      mode,
      earliestBookableDate,
    };
  }

  const executionHours = toHours(
    project.executionDuration.value,
    project.executionDuration.unit
  );
  const bufferHours = toHours(
    project.bufferDuration.value,
    project.bufferDuration.unit
  );
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
    const availableMembers = getAvailableMembersForDay(teamMembers, day);
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
      MAX_SEARCH_DAYS
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
              minOverlapPercentage
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
      const availableDays = countAvailableDays(member, searchStart, searchEnd);
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
              minOverlapPercentage
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
