import Booking from "../models/booking";
import { Types } from "mongoose";
import { toISOString } from "./dateUtils";

type BookingBlockedRange = {
  startDate: string;
  endDate: string;
  reason?: string;
  bookingId?: string;
  bookingNumber?: string;
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
      "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate location bookingNumber customer"
    )
    .populate("customer", "name");

  const ranges: BookingBlockedRange[] = [];

  bookings.forEach((booking) => {
    const customerName = (booking.customer as any)?.name;
    // Legacy field fallbacks are kept for older bookings until data is normalized.
    const scheduledExecutionEndDate =
      booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
    const scheduledBufferStartDate =
      booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
    const scheduledBufferEndDate =
      booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

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
