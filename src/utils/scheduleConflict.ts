import { Types } from "mongoose";
import Booking from "../models/booking";
import { bookingCalendarOccupancies, type BookingCalendarSchedule } from "./support/bookingCalendar";
import { findSharedCalendarConflicts } from "./support/calendarBusy";

export interface TeamConflict {
  bookingId: string;
  bookingNumber?: string;
  teamMemberIds: string[];
  overlapStart: Date;
  overlapEnd: Date;
  otherStart?: Date;
  otherEnd?: Date;
  /** Where the conflict comes from; bookings are the historical default. */
  source?: "booking" | "support" | "meeting" | "meeting_request";
}

const ACTIVE_STATUSES = ["booked", "in_progress", "rescheduling_requested"];

const toIdString = (val: any): string => {
  if (!val) return "";
  if (val instanceof Types.ObjectId) return val.toString();
  if (typeof val === "string") return val;
  if (val._id) return val._id.toString();
  return String(val);
};

export const findTeamConflicts = async (
  excludeBookingId: string,
  teamMemberIds: Types.ObjectId[] | string[],
  proposedStart: Date,
  proposedEnd: Date,
  resourcePlan?: BookingCalendarSchedule["resourcePlan"],
): Promise<TeamConflict[]> => {
  if (!Array.isArray(teamMemberIds) || teamMemberIds.length === 0) {
    return [];
  }
  if (!(proposedStart instanceof Date) || !(proposedEnd instanceof Date)) {
    return [];
  }

  const memberIdStrings: string[] = teamMemberIds.map((id) => toIdString(id)).filter(Boolean);
  if (memberIdStrings.length === 0) return [];

  const occupancies = bookingCalendarOccupancies({
    _id: excludeBookingId, assignedTeamMembers: memberIdStrings, resourcePlan,
    scheduledStartDate: proposedStart, scheduledExecutionEndDate: proposedEnd,
  });
  if (occupancies.length === 0) return [];
  const windowStart = new Date(Math.min(...occupancies.map(o => o.startAt.getTime())));
  const windowEnd = new Date(Math.max(...occupancies.map(o => o.endAt.getTime())));
  const memberObjectIds = Array.from(new Set(occupancies.map(o => o.userId)))
    .map((id) => new Types.ObjectId(id));
  const conflicts = await Booking.find({
    _id: { $ne: new Types.ObjectId(excludeBookingId) },
    status: { $in: ACTIVE_STATUSES },
    scheduledStartDate: { $lt: windowEnd },
    $and: [
      {
        $or: [
          { assignedTeamMembers: { $in: memberObjectIds } },
          { professional: { $in: memberObjectIds } },
          { 'resourcePlan.resourceId': { $in: memberObjectIds } },
        ],
      },
      {
        $or: [
          { scheduledBufferEndDate: { $gt: windowStart } },
          { scheduledExecutionEndDate: { $gt: windowStart } },
        ],
      },
    ],
  })
    .select("bookingNumber assignedTeamMembers professional scheduledStartDate scheduledExecutionEndDate scheduledBufferEndDate resourcePlan")
    .lean();

  const result: TeamConflict[] = [];
  for (const booking of conflicts as any[]) {
    // Preserve the historical owner-inclusive probe for two whole-window
    // schedules. Planned schedules use only their actual attending resources.
    const legacyWindow = !resourcePlan?.some(entry => entry.days?.length)
      && !booking.resourcePlan?.some((entry: any) => entry.days?.length);
    const otherSchedule = legacyWindow
      ? { ...booking, assignedTeamMembers: [...(booking.assignedTeamMembers || []), booking.professional].filter(Boolean) }
      : booking;
    for (const other of bookingCalendarOccupancies(otherSchedule)) {
      for (const proposed of occupancies) {
        if (other.userId !== proposed.userId) continue;
        const overlapStart = new Date(Math.max(other.startAt.getTime(), proposed.startAt.getTime()));
        const overlapEnd = new Date(Math.min(other.endAt.getTime(), proposed.endAt.getTime()));
        if (overlapEnd <= overlapStart) continue;
        result.push({
          bookingId: String(booking._id), bookingNumber: booking.bookingNumber,
          teamMemberIds: [other.userId], overlapStart, overlapEnd,
          otherStart: other.startAt, otherEnd: other.endAt, source: 'booking',
        });
      }
    }
  }

  // Shared sources must be probed against the same exact person/day windows.
  for (const proposed of occupancies) {
    const shared = await findSharedCalendarConflicts([proposed.userId], proposed.startAt, proposed.endAt);
    for (const source of shared) {
      result.push({
        bookingId: source.id, teamMemberIds: [source.userId],
        overlapStart: new Date(Math.max(source.start, proposed.startAt.getTime())),
        overlapEnd: new Date(Math.min(source.end, proposed.endAt.getTime())),
        otherStart: new Date(source.start), otherEnd: new Date(source.end), source: source.source,
      });
    }
  }

  const grouped = new Map<string, TeamConflict>();
  for (const conflict of result) {
    const key = [conflict.source, conflict.bookingId, conflict.overlapStart.toISOString(), conflict.overlapEnd.toISOString(), conflict.source === 'booking' ? '' : conflict.teamMemberIds.join(',')].join(':');
    const existing = grouped.get(key);
    if (existing) existing.teamMemberIds = Array.from(new Set([...existing.teamMemberIds, ...conflict.teamMemberIds]));
    else grouped.set(key, conflict);
  }
  return Array.from(grouped.values());
};
