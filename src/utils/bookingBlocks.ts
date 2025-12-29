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
          { scheduledEndDate: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  const bookings = await Booking.find(bookingFilter).select(
    "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate"
  );

  const ranges: BookingBlockedRange[] = [];

  bookings.forEach((booking) => {
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
      const bufferStart = new Date(scheduledBufferStartDate).getTime();
      const execEnd = new Date(scheduledExecutionEndDate).getTime();
      const scheduledBufferUnit =
        booking.scheduledBufferUnit || (booking as any).scheduledBufferUnit;
      const isHoursBuffer =
        scheduledBufferUnit === "hours"
          ? true
          : scheduledBufferUnit === "days"
          ? false
          : bufferStart === execEnd;

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
