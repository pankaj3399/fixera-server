import Booking from "../models/booking";
import { Types } from "mongoose";

type BookingBlockedRange = { startDate: string; endDate: string; reason?: string };

export const buildBookingBlockedRanges = async (
  userId: Types.ObjectId | string
): Promise<BookingBlockedRange[]> => {
  const bookingFilter: any = {
    status: { $nin: ["completed", "cancelled", "refunded"] },
    scheduledStartDate: { $exists: true, $ne: null },
    $or: [{ professional: userId }, { assignedTeamMembers: userId }],
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
      ranges.push({
        startDate: new Date(booking.scheduledStartDate).toISOString(),
        endDate: new Date(scheduledExecutionEndDate).toISOString(),
        reason: "booking",
      });
    }

    if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
      // Don't extend buffer end date - use the actual scheduled end
      // Extending to UTC 23:59:59 causes timezone issues (bleeds into next day in other timezones)
      ranges.push({
        startDate: new Date(scheduledBufferStartDate).toISOString(),
        endDate: new Date(scheduledBufferEndDate).toISOString(),
        reason: "booking-buffer",
      });
    }
  });

  return ranges;
};
