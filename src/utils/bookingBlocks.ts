import Booking from "../models/booking";
import { Types } from "mongoose";
import { toISOString } from "./dateUtils";

type BookingBlockedRange = {
  startDate: string;
  endDate: string;
  reason?: string;
  bookingId?: string;
  bookingNumber?: string;
  // Frontend calendar colours booking ranges by status (pending/in-progress/
  // completed). Additive only; no private data is exposed here.
  status?: string;
  /**
   * FT3 #5: past planned days a started booking kept after a partial refund.
   * The booking itself is `cancelled`, but these days were worked and stay
   * blocked, so the calendar must still render them.
   */
  retainedAfterRefund?: boolean;
  title?: string | null;
  customerName?: string;
  location?: {
    address?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
};

export type BuildBookingBlockedRangesOptions = {
  /**
   * Include completed bookings (display consumers: the employee and team
   * calendars). Completed ranges are clipped to the moment the work actually
   * ended, so they never occupy time after completion.
   */
  includeCompleted?: boolean;
  /** Clock override for tests. */
  now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Completed bookings older than this are not loaded (calendar history window). */
export const COMPLETED_BOOKING_LOOKBACK_DAYS = 400;

/** True for a cancelled booking that kept its past planned days after a partial refund. */
export const isRetainedPartialRefundBooking = (booking: any): boolean =>
  String(booking?.status) === "cancelled"
  && booking?.refundPreservesPastPlanning === true
  && booking?.payment?.status === "partially_refunded";

const validTime = (value: unknown): number | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * The moment a completed booking stopped occupying its resources: the actual
 * end, else the latest completion status change, never later than `now`.
 */
export const completedBookingCutoff = (booking: any, now: Date): number => {
  const nowMs = now.getTime();
  let cutoff = validTime(booking?.actualEndDate);
  if (cutoff === null && Array.isArray(booking?.statusHistory)) {
    for (const entry of booking.statusHistory) {
      if (!["completed", "professional_completed"].includes(String(entry?.status))) continue;
      const ts = validTime(entry?.timestamp);
      if (ts !== null && (cutoff === null || ts > cutoff)) cutoff = ts;
    }
  }
  return cutoff === null ? nowMs : Math.min(cutoff, nowMs);
};

export const buildBookingBlockedRanges = async (
  userId: Types.ObjectId | string,
  options: BuildBookingBlockedRangesOptions = {},
): Promise<BookingBlockedRange[]> => {
  const now = options.now ?? new Date();
  // Convert to both ObjectId and string for matching (handles mixed storage)
  const userIdString = userId.toString();
  let userIdObjectId: Types.ObjectId;
  try {
    userIdObjectId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  } catch (error) {
    throw new Error(`Invalid userId format: ${userId}`);
  }

  // Active bookings block their window/plan. A cancelled booking that kept its
  // past planned days after a partial refund (started work) keeps those days.
  // Completed bookings are display-only and opt-in.
  const statusClauses: any[] = [
    { status: { $nin: ["completed", "cancelled", "refunded"] } },
    {
      status: "cancelled",
      refundPreservesPastPlanning: true,
      "payment.status": "partially_refunded",
    },
  ];
  if (options.includeCompleted) {
    statusClauses.push({
      status: "completed",
      scheduledStartDate: { $gte: new Date(now.getTime() - COMPLETED_BOOKING_LOOKBACK_DAYS * DAY_MS) },
    });
  }

  const bookingFilter: any = {
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [
      { professional: userIdObjectId },
      { professional: userIdString },
      { assignedTeamMembers: userIdObjectId },
      { assignedTeamMembers: userIdString },
    ],
    $and: [
      { $or: statusClauses },
      {
        $or: [
          { scheduledBufferEndDate: { $exists: true, $ne: null } },
          { scheduledExecutionEndDate: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  const bookings = await Booking.find(bookingFilter)
    .select(
      "status scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate location bookingNumber customer rfqData.serviceType resourcePlan assignedTeamMembers refundPreservesPastPlanning payment.status actualEndDate statusHistory.status statusHistory.timestamp"
    )
    .populate("customer", "name");

  const ranges: BookingBlockedRange[] = [];

  bookings.forEach((booking) => {
    const customerName = (booking.customer as any)?.name;
    // Additive display fields for the frontend calendar: booking lifecycle
    // status for tier/colour rendering plus a human-readable title. The title
    // falls back to the booked service type; no private data is added.
    const bookingStatus = (booking as any).status ? String((booking as any).status) : undefined;
    const bookingTitle = (booking as any).rfqData?.serviceType
      ? String((booking as any).rfqData.serviceType)
      : null;
    const retained = isRetainedPartialRefundBooking(booking);
    // Completed work never occupies time after it actually ended.
    const cutoffMs = bookingStatus === "completed"
      ? completedBookingCutoff(booking, now)
      : null;
    const statusFields = retained
      ? { status: bookingStatus, retainedAfterRefund: true }
      : { status: bookingStatus };
    // Legacy field fallbacks are kept for older bookings until data is normalized.
    const scheduledExecutionEndDate =
      booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
    const scheduledBufferStartDate =
      booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
    const scheduledBufferEndDate =
      booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

    const plan: any[] = Array.isArray((booking as any).resourcePlan) ? (booking as any).resourcePlan : [];
    const hasPlan = plan.some((e: any) => Array.isArray(e?.days) && e.days.length > 0);
    const assignedIds: string[] = Array.isArray((booking as any).assignedTeamMembers)
      ? (booking as any).assignedTeamMembers.map((m: any) => ((m?._id ?? m)?.toString?.() ?? String(m)))
      : [];

    // Client bug list #24b: a booking blocks only the resources that attend
    // it. When explicit attendees are recorded, the professional field alone
    // must not block (otherwise an uninvolved resource gets a double
    // booking). Legacy rows without attendees keep the professional fallback.
    const hasExplicitAttendees = assignedIds.length > 0 || hasPlan;
    if (hasExplicitAttendees && !assignedIds.includes(userIdString)) {
      const ownEntry = plan.find(
        (e: any) => ((e?.resourceId?._id || e?.resourceId)?.toString?.()) === userIdString
      );
      const ownDays: any[] = ownEntry && Array.isArray(ownEntry.days) ? ownEntry.days : [];
      if (ownDays.length === 0) {
        return;
      }
    }

    if (retained && !hasPlan) {
      // Nothing was retained (no past planned day): the refund released it all.
      return;
    }

    if (hasPlan) {
      const entry = plan.find(
        (e: any) => ((e?.resourceId?._id || e?.resourceId)?.toString?.()) === userIdString
      );
      const plannedDays: any[] = entry && Array.isArray(entry.days) ? entry.days : [];

      if (plannedDays.length === 0) {
        return;
      }

      for (const day of plannedDays) {
        const dayDate = new Date(day);
        if (Number.isNaN(dayDate.getTime())) continue;
        const dayStart = new Date(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), 0, 0, 0, 0));
        if (cutoffMs !== null && dayStart.getTime() >= cutoffMs) continue;
        const dayEnd = new Date(dayStart.getTime() + DAY_MS);
        const startISO = toISOString(dayStart);
        const endISO = toISOString(dayEnd);
        if (startISO && endISO) {
          ranges.push({
            startDate: startISO,
            endDate: endISO,
            reason: "booking",
            bookingId: String(booking._id),
            bookingNumber: booking.bookingNumber,
            ...statusFields,
            title: bookingTitle,
            customerName,
            location: booking.location,
          });
        }
      }

      return;
    }

    const clipEnd = (value: any): any => {
      if (cutoffMs === null) return value;
      const endMs = validTime(value);
      return endMs !== null && endMs > cutoffMs ? new Date(cutoffMs) : value;
    };
    const isEmptyAfterClip = (start: any, end: any): boolean => {
      if (cutoffMs === null) return false;
      const startMs = validTime(start);
      const endMs = validTime(end);
      return startMs === null || endMs === null || endMs <= startMs;
    };

    if (booking.scheduledStartDate && scheduledExecutionEndDate
      && !isEmptyAfterClip(booking.scheduledStartDate, clipEnd(scheduledExecutionEndDate))) {
      const startDateISO = toISOString(booking.scheduledStartDate);
      const endDateISO = toISOString(clipEnd(scheduledExecutionEndDate));

      // Validate dates before creating range
      if (startDateISO && endDateISO) {
        ranges.push({
          startDate: startDateISO,
          endDate: endDateISO,
          reason: "booking",
          bookingId: String(booking._id),
          bookingNumber: booking.bookingNumber,
          ...statusFields,
          title: bookingTitle,
          customerName,
          location: booking.location,
        });
      } else {
        console.warn(`[buildBookingBlockedRanges] Invalid dates for booking ${String(booking._id)} - start: ${booking.scheduledStartDate}, end: ${scheduledExecutionEndDate}`);
      }
    }

    if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate
      && !isEmptyAfterClip(scheduledBufferStartDate, clipEnd(scheduledBufferEndDate))) {
      const bufferStartISO = toISOString(scheduledBufferStartDate);
      const bufferEndISO = toISOString(clipEnd(scheduledBufferEndDate));

      // Validate buffer dates before creating range
      if (bufferStartISO && bufferEndISO) {
        // Don't extend buffer end date - use the actual scheduled end
        // Extending to UTC 23:59:59 causes timezone issues (bleeds into next day in other timezones)
        ranges.push({
          startDate: bufferStartISO,
          endDate: bufferEndISO,
          reason: "booking-buffer",
          bookingId: String(booking._id),
          bookingNumber: booking.bookingNumber,
          ...statusFields,
          title: bookingTitle,
          customerName,
          location: booking.location,
        });
      } else {
        console.warn(`[buildBookingBlockedRanges] Invalid buffer dates for booking ${String(booking._id)} - start: ${scheduledBufferStartDate}, end: ${scheduledBufferEndDate}`);
      }
    }
  });

  return ranges;
};
