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

const getEarliestBookableDate = (project: IProject): Date => {
  const now = new Date();
  if (!project.preparationDuration) {
    return now;
  }
  return addDuration(now, project.preparationDuration.value, project.preparationDuration.unit);
};

/**
 * Determine which team members are considered "available" on a given day,
 * ignoring blocks shorter than or equal to 4 hours (conservative: any block
 * that overlaps the day is treated as > 4h and makes the day unavailable).
 */
const getAvailableMembersForDay = (members: IUser[], day: Date): string[] => {
  const dayKey = getWeekdayKey(day);

  return members
    .filter((member) => {
      // Use personal availability only for now.
      const availability = member.availability || undefined;
      const dayAvailability = availability?.[dayKey];

      if (!dayAvailability || !dayAvailability.available) {
        return false;
      }

      // If the professional or company has a blocked date on this day, treat as fully blocked.
      const hasBlockedDate =
        (member.blockedDates || []).some((b) => isSameDay(b.date, day)) ||
        (member.companyBlockedDates || []).some((b) => isSameDay(b.date, day));

      if (hasBlockedDate) {
        return false;
      }

      // If there is any blocked range overlapping this day, treat as fully blocked
      // (conservative >= 4h block).
      const allRanges = [
        ...(member.blockedRanges || []),
        ...(member.companyBlockedRanges || []),
      ];

      const hasBlockedRange = allRanges.some((r) =>
        dayOverlapsRange(day, r.startDate, r.endDate)
      );

      if (hasBlockedRange) {
        return false;
      }

      return true;
    })
    .map((m) => m._id.toString());
};

export const getScheduleProposalsForProject = async (
  projectId: string
): Promise<ScheduleProposals | null> => {
  const project = await Project.findById(projectId);
  if (!project) return null;

  const mode: "hours" | "days" =
    project.timeMode || project.executionDuration?.unit || "days";

  const earliestBookableDate = getEarliestBookableDate(project);

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
