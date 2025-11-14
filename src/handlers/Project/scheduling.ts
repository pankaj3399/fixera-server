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
const getAvailableMembersForDay = (members: IUser[], day: Date): string[] => {
  const dayKey = getWeekdayKey(day);

  return members
    .filter((member) => {
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
    })
    .map((m) => (m._id as any).toString());
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
    availableMemberIds: string[];
  }[] = [];

  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const day = addDuration(searchStart, i, "days");
    const availableMembers = getAvailableMembersForDay(teamMembers, day);
    availabilityByDay.push({
      date: day,
      availableMemberIds: availableMembers,
    });
  }

  if (mode === "hours") {
    // Hours mode: we look for the earliest day where at least minResources members
    // are available and treat the whole continuous duration starting at that day.
    const requiredDurationHours = totalHours;
    const requiredDays = Math.max(
      1,
      Math.ceil(requiredDurationHours / HOURS_PER_DAY)
    );

    let earliestWindow: TimeWindow | undefined;

    for (let i = 0; i <= MAX_SEARCH_DAYS - requiredDays; i++) {
      const windowDays = availabilityByDay.slice(i, i + requiredDays);
      const allDaysHaveEnoughResources = windowDays.every(
        (d) => d.availableMemberIds.length >= minResources
      );

      if (!allDaysHaveEnoughResources) continue;

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
  const totalDays = Math.max(1, Math.ceil(totalHours / HOURS_PER_DAY));
  const maxThroughputEarliest = totalDays * 2; // +100%
  const maxThroughputShortest = Math.max(totalDays, Math.floor(totalDays * 1.2)); // +20%

  let earliestProposal: TimeWindow | undefined;
  let shortestThroughputProposal: TimeWindow | undefined;

  // Earliest possible: earliest contiguous block of `totalDays` where each day
  // has at least minResources available.
  for (let i = 0; i <= MAX_SEARCH_DAYS - totalDays; i++) {
    const windowDays = availabilityByDay.slice(i, i + totalDays);

    const allDaysHaveEnoughResources = windowDays.every(
      (d) => d.availableMemberIds.length >= minResources
    );

    if (!allDaysHaveEnoughResources) continue;

    const start = windowDays[0].date;
    const end = addDuration(start, totalDays, "days");
    earliestProposal = { start, end };
    break;
  }

  // Shortest throughput: pick the earliest window with minimal days length
  // up to maxThroughputShortest where all days have enough resources.
  for (let length = totalDays; length <= maxThroughputShortest; length++) {
    let found = false;
    for (let i = 0; i <= MAX_SEARCH_DAYS - length; i++) {
      const windowDays = availabilityByDay.slice(i, i + length);
      const allDaysHaveEnoughResources = windowDays.every(
        (d) => d.availableMemberIds.length >= minResources
      );

      if (!allDaysHaveEnoughResources) continue;

      const start = windowDays[0].date;
      const end = addDuration(start, length, "days");
      shortestThroughputProposal = { start, end };
      found = true;
      break;
    }
    if (found) break;
  }

  return {
    mode,
    earliestBookableDate,
    earliestProposal,
    shortestThroughputProposal,
  };
};
