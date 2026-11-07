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
  title?: string | null;
  customerName?: string;
  location?: {
    address?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
};

export const buildBookingBlockedRanges = async (
  userId: Types.ObjectId | string
): Promise<BookingBlockedRange[]> => {
  // Convert to both ObjectId and string for matching (handles mixed storage)
  const userIdString = userId.toString();
  let userIdObjectId: Types.ObjectId;
  try {
    userIdObjectId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  } catch (error) {
    throw new Error(`Invalid userId format: ${userId}`);
  }

  const bookingFilter: any = {
    status: { $nin: ["completed", "cancelled", "refunded"] },
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [
      { professional: userIdObjectId },
      { professional: userIdString },
      { assignedTeamMembers: userIdObjectId },
      { assignedTeamMembers: userIdString },
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

  const bookings = await Booking.find(bookingFilter)
    .select(
      "status scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate location bookingNumber customer rfqData.serviceType resourcePlan assignedTeamMembers"
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

    if (hasPlan) {
      const entry = plan.find(
        (e: any) => ((e?.resourceId?._id || e?.resourceId)?.toString?.()) === userIdString
      );
      const plannedDays: any[] = entry && Array.isArray(entry.days) ? entry.days : [];

      if (plannedDays.length === 0) {
        return;
      }

      const DAY_MS = 24 * 60 * 60 * 1000;
      for (const day of plannedDays) {
        const dayDate = new Date(day);
        if (Number.isNaN(dayDate.getTime())) continue;
        const dayStart = new Date(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), 0, 0, 0, 0));
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
            status: bookingStatus,
            title: bookingTitle,
            customerName,
            location: booking.location,
          });
        }
      }

      return;
    }

    if (booking.scheduledStartDate && scheduledExecutionEndDate) {
      const startDateISO = toISOString(booking.scheduledStartDate);
      const endDateISO = toISOString(scheduledExecutionEndDate);

      // Validate dates before creating range
      if (startDateISO && endDateISO) {
        ranges.push({
          startDate: startDateISO,
          endDate: endDateISO,
          reason: "booking",
          bookingId: String(booking._id),
          bookingNumber: booking.bookingNumber,
          status: bookingStatus,
          title: bookingTitle,
          customerName,
          location: booking.location,
        });
      } else {
        console.warn(`[buildBookingBlockedRanges] Invalid dates for booking ${String(booking._id)} - start: ${booking.scheduledStartDate}, end: ${scheduledExecutionEndDate}`);
      }
    }

    if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
      const bufferStartISO = toISOString(scheduledBufferStartDate);
      const bufferEndISO = toISOString(scheduledBufferEndDate);

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
          status: bookingStatus,
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
