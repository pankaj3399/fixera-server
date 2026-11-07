import { Types, type ClientSession } from "mongoose";
import CalendarReservation from "../../models/calendarReservation";
import { findSharedCalendarConflicts, type SharedCalendarBusySource } from "./calendarBusy";
import {
  buildCalendarReservationKeysForInterval,
  releaseCalendarReservations,
  reserveCalendarKeys,
  type CalendarReservationKey,
} from "./calendarReservations";

export interface BookingCalendarSchedule {
  _id: Types.ObjectId | string;
  professional?: Types.ObjectId | string | null;
  assignedTeamMembers?: Array<Types.ObjectId | string | null> | null;
  resourcePlan?: Array<{
    resourceId?: Types.ObjectId | string | null;
    days?: Array<Date | string> | null;
  }> | null;
  scheduledStartDate?: Date | string | null;
  scheduledExecutionEndDate?: Date | string | null;
  scheduledBufferEndDate?: Date | string | null;
}

export interface BookingCalendarOccupancy {
  userId: string;
  startAt: Date;
  endAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BookingCalendarConflict {
  source: SharedCalendarBusySource["source"] | "booking";
  id: string;
  userId: string;
  start: Date;
  end: Date;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Only members the booking actually assigns: assigned team + planned resources.
 * Client bug list #24b (hour mode): a booking must block only the resources
 * that need to attend (the minimum required, chosen from available
 * resources). The professional field alone must not block, otherwise an
 * uninvolved resource collects a double booking on its personal calendar.
 * Legacy rows without explicit attendees predate attendance tracking, so the
 * professional stays blocked as the fallback.
 */
export function bookingCalendarMemberIds(booking: BookingCalendarSchedule): string[] {
  const ids = new Set<string>();
  for (const member of booking.assignedTeamMembers || []) {
    if (member) ids.add(String(member));
  }
  for (const entry of booking.resourcePlan || []) {
    if (entry?.resourceId) ids.add(String(entry.resourceId));
  }
  if (ids.size === 0 && booking.professional) {
    ids.add(String(booking.professional));
  }
  return Array.from(ids).filter((id) => Types.ObjectId.isValid(id));
}

/** The whole window a booking holds for its members (execution through buffer). */
export function bookingCalendarInterval(
  booking: BookingCalendarSchedule,
): { startAt: Date; endAt: Date } | null {
  const startAt = toDate(booking.scheduledStartDate);
  const endAt = toDate(booking.scheduledBufferEndDate) || toDate(booking.scheduledExecutionEndDate);
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return null;
  return { startAt, endAt };
}

function plannedBookingDays(booking: BookingCalendarSchedule): Map<string, Date[]> {
  const planned = new Map<string, Date[]>();
  for (const entry of booking.resourcePlan || []) {
    const resourceId = entry?.resourceId ? String(entry.resourceId) : "";
    if (!Types.ObjectId.isValid(resourceId)) continue;
    const days: Date[] = [];
    const seen = new Set<number>();
    for (const raw of entry.days || []) {
      const day = toDate(raw);
      if (!day) continue;
      // resourcePlan days are stored as UTC calendar days (the planning board
      // keeps one entry per YYYY-MM-DD). Availability in bookingBlocks uses the
      // same UTC day, so the reservation authority blocks exactly those days.
      const dayStart = new Date(Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        0,
        0,
        0,
        0,
      ));
      const key = dayStart.getTime();
      if (seen.has(key)) continue;
      seen.add(key);
      days.push(dayStart);
    }
    if (days.length > 0) planned.set(resourceId, days);
  }
  return planned;
}

/**
 * The exact per-person windows a booking occupies.
 *
 * With a resource plan, only planned member days are occupied; unplanned days
 * and unplanned members stay free, matching buildBookingBlockedRanges and the
 * planning board. Without a plan (or with a stale plan that no longer overlaps
 * the booking window) every assigned member is occupied for the whole
 * execution/buffer window, which preserves the pre-plan fallback behaviour.
 */
export function bookingCalendarOccupancies(
  booking: BookingCalendarSchedule,
): BookingCalendarOccupancy[] {
  const interval = bookingCalendarInterval(booking);
  if (!interval) return [];
  const members = bookingCalendarMemberIds(booking);
  const planned = plannedBookingDays(booking);

  if (planned.size === 0) {
    return members.map((userId) => ({ userId, ...interval }));
  }

  const planTouchesWindow = Array.from(planned.values()).some((days) =>
    days.some((dayStart) =>
      dayStart.getTime() < interval.endAt.getTime()
      && dayStart.getTime() + DAY_MS > interval.startAt.getTime(),
    ),
  );
  if (!planTouchesWindow) {
    // A reschedule moved the booking away from every planned day. The old plan
    // is stale; conservatively protect the current window instead of leaving it
    // unbookable-free while the plan still points at another date.
    return members.map((userId) => ({ userId, ...interval }));
  }

  const occupancies: BookingCalendarOccupancy[] = [];
  for (const [userId, days] of planned.entries()) {
    for (const dayStart of days) {
      occupancies.push({
        userId,
        startAt: dayStart,
        endAt: new Date(dayStart.getTime() + DAY_MS),
      });
    }
  }
  return occupancies;
}

export function buildBookingCalendarKeys(
  booking: BookingCalendarSchedule,
): CalendarReservationKey[] {
  const keys: CalendarReservationKey[] = [];
  for (const occupancy of bookingCalendarOccupancies(booking)) {
    keys.push(
      ...buildCalendarReservationKeysForInterval({
        role: "professional",
        userId: occupancy.userId,
        startAt: occupancy.startAt,
        endAt: occupancy.endAt,
      }),
    );
  }
  return keys;
}

export async function reserveBookingCalendar(
  booking: BookingCalendarSchedule,
  session?: ClientSession,
): Promise<void> {
  if (!Types.ObjectId.isValid(String(booking._id))) return;
  const keys = buildBookingCalendarKeys(booking);
  if (keys.length === 0) return;
  await reserveCalendarKeys(
    { sourceType: "booking", sourceId: booking._id, keys },
    session,
  );
}

export async function releaseBookingCalendar(
  bookingId: Types.ObjectId | string,
  session?: ClientSession,
): Promise<void> {
  if (!Types.ObjectId.isValid(String(bookingId))) return;
  await releaseCalendarReservations("booking", bookingId, session);
}

/**
 * Atomically move a booking's reservation keys. Must run inside the same
 * transaction as the booking schedule write so a failed reservation rolls the
 * schedule change back.
 */
export async function replaceBookingCalendar(
  booking: BookingCalendarSchedule,
  session?: ClientSession,
): Promise<void> {
  await releaseBookingCalendar(booking._id, session);
  await reserveBookingCalendar(booking, session);
}

function overlaps(start: number, end: number, otherStart: number, otherEnd: number): boolean {
  return start < otherEnd && end > otherStart;
}

/**
 * Full conflict view for a proposed booking window: support meetings, project
 * Meetings, legacy MeetingRequests, and reservation rows written by any
 * calendar source. Bookings themselves are checked by findTeamConflicts.
 */
export async function findBookingCalendarConflicts(params: {
  bookingId?: Types.ObjectId | string;
  members: Array<Types.ObjectId | string>;
  startAt: Date;
  endAt: Date;
}): Promise<BookingCalendarConflict[]> {
  const members = Array.from(new Set(params.members.map((id) => String(id))))
    .filter((id) => Types.ObjectId.isValid(id));
  if (members.length === 0) return [];
  const startMs = params.startAt.getTime();
  const endMs = params.endAt.getTime();
  if (!(endMs > startMs)) return [];

  const shared = await findSharedCalendarConflicts(members, params.startAt, params.endAt);
  const conflicts: BookingCalendarConflict[] = shared.map((source) => ({
    source: source.source,
    id: source.id,
    userId: source.userId,
    start: new Date(source.start),
    end: new Date(source.end),
  }));

  const reservationFilter: Record<string, unknown> = {
    userId: { $in: members.map((id) => new Types.ObjectId(id)) },
    startAt: { $lt: params.endAt },
    endAt: { $gt: params.startAt },
  };
  if (params.bookingId) {
    reservationFilter.$nor = [
      {
        sourceType: "booking",
        sourceId: new Types.ObjectId(String(params.bookingId)),
      },
    ];
  }
  const reservations = await CalendarReservation.find(reservationFilter)
    .select("sourceType sourceId userId startAt endAt")
    .lean();
  for (const reservation of reservations as Array<{
    sourceType: string;
    sourceId: unknown;
    userId: unknown;
    startAt: Date;
    endAt: Date;
  }>) {
    const id = String(reservation.sourceId);
    if (conflicts.some((conflict) => conflict.id === id && conflict.source === reservation.sourceType)) {
      continue;
    }
    const reservationStart = new Date(reservation.startAt).getTime();
    const reservationEnd = new Date(reservation.endAt).getTime();
    if (!overlaps(startMs, endMs, reservationStart, reservationEnd)) continue;
    conflicts.push({
      source: reservation.sourceType as BookingCalendarConflict["source"],
      id,
      userId: String(reservation.userId),
      start: new Date(reservationStart),
      end: new Date(reservationEnd),
    });
  }

  return conflicts;
}

/**
 * Conflict check for the exact per-person windows a booking will occupy.
 * Unlike a single whole-window probe, unplanned days and unplanned members are
 * not falsely blocked; a stale plan still falls back to the whole window in
 * bookingCalendarOccupancies.
 */
export async function findBookingCalendarConflictsForSchedule(params: {
  bookingId?: Types.ObjectId | string;
  booking: BookingCalendarSchedule;
}): Promise<BookingCalendarConflict[]> {
  const byUser = new Map<string, BookingCalendarOccupancy[]>();
  for (const occupancy of bookingCalendarOccupancies(params.booking)) {
    const current = byUser.get(occupancy.userId) || [];
    current.push(occupancy);
    byUser.set(occupancy.userId, current);
  }

  const conflicts: BookingCalendarConflict[] = [];
  const seen = new Set<string>();
  for (const [userId, occupancies] of byUser.entries()) {
    const startAt = new Date(Math.min(...occupancies.map((entry) => entry.startAt.getTime())));
    const endAt = new Date(Math.max(...occupancies.map((entry) => entry.endAt.getTime())));
    const found = await findBookingCalendarConflicts({
      bookingId: params.bookingId,
      members: [userId],
      startAt,
      endAt,
    });
    for (const conflict of found) {
      const overlapsAnOccupancy = occupancies.some((occupancy) =>
        occupancy.startAt.getTime() < conflict.end.getTime()
        && occupancy.endAt.getTime() > conflict.start.getTime(),
      );
      if (!overlapsAnOccupancy) continue;
      const key = [
        conflict.source,
        conflict.id,
        conflict.userId,
        conflict.start.toISOString(),
        conflict.end.toISOString(),
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push(conflict);
    }
  }
  return conflicts;
}
