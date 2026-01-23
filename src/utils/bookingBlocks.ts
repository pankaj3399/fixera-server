import Booking from "../models/booking";
import { Types } from "mongoose";

type BookingBlockedRange = { startDate: string; endDate: string; reason?: string };

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

  const bookings = await Booking.find(bookingFilter).select(
    "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate"
  );

  const ranges: BookingBlockedRange[] = [];

  bookings.forEach((booking) => {
    // Legacy field fallbacks are kept for older bookings until data is normalized.
    const scheduledExecutionEndDate =
      booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
    const scheduledBufferStartDate =
      booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
    const scheduledBufferEndDate =
      booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

    if (booking.scheduledStartDate && scheduledExecutionEndDate) {
      const startDate = new Date(booking.scheduledStartDate);
      const endDate = new Date(scheduledExecutionEndDate);

      // Validate dates before creating range
      if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
        ranges.push({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          reason: "booking",
        });
      } else {
        console.warn(`[buildBookingBlockedRanges] Invalid dates for booking ${booking._id} - start: ${booking.scheduledStartDate}, end: ${scheduledExecutionEndDate}`);
      }
    }

    if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
      const bufferStart = new Date(scheduledBufferStartDate);
      const bufferEnd = new Date(scheduledBufferEndDate);

      // Validate buffer dates before creating range
      if (!Number.isNaN(bufferStart.getTime()) && !Number.isNaN(bufferEnd.getTime())) {
        // Don't extend buffer end date - use the actual scheduled end
        // Extending to UTC 23:59:59 causes timezone issues (bleeds into next day in other timezones)
        ranges.push({
          startDate: bufferStart.toISOString(),
          endDate: bufferEnd.toISOString(),
          reason: "booking-buffer",
        });
      } else {
        console.warn(`[buildBookingBlockedRanges] Invalid buffer dates for booking ${booking._id} - start: ${scheduledBufferStartDate}, end: ${scheduledBufferEndDate}`);
      }
    }
  });

  return ranges;
};
