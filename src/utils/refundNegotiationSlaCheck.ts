import CancellationRequest from "../models/cancellationRequest";
import Booking from "../models/booking";
import { SYSTEM_USER_ID } from "../constants/system";
import { notifyAsync } from "./notifications/notify";

export interface RefundSlaCheckResult {
  scanned: number;
  escalated: number;
  errors: number;
}

/**
 * Escalates customer refund requests the professional did not respond to within
 * the response deadline (5 business days). Invoked on demand via the admin endpoint.
 */
export const runRefundNegotiationSlaCheck = async (): Promise<RefundSlaCheckResult> => {
  const now = new Date();
  const stats: RefundSlaCheckResult = { scanned: 0, escalated: 0, errors: 0 };

  const overdue = await CancellationRequest.find({
    requestedRole: "customer",
    status: "pending",
    responseDeadline: { $lte: now },
  }).select("_id booking");

  stats.scanned = overdue.length;

  for (const request of overdue) {
    try {
      const updateResult = await CancellationRequest.updateOne(
        { _id: request._id, status: "pending", responseDeadline: { $lte: now } },
        { $set: { status: "escalated", escalatedAt: new Date(), escalationReason: "no_response" } }
      );
      if (updateResult.modifiedCount === 0) continue;
      stats.escalated++;

      try {
        const disputedBooking = await Booking.findById(request.booking);
        if (disputedBooking && (disputedBooking.status === "booked" || disputedBooking.status === "in_progress")) {
          disputedBooking.statusBeforeDispute = disputedBooking.status;
          disputedBooking.status = "dispute";
          disputedBooking.statusHistory = disputedBooking.statusHistory || [];
          disputedBooking.statusHistory.push({
            status: "dispute",
            timestamp: new Date(),
            updatedBy: SYSTEM_USER_ID,
            note: "Refund dispute escalated (no_response)",
          } as any);
          await disputedBooking.save();
        }
      } catch (statusError: any) {
        console.error(`[refundSla] Failed to set booking status to dispute for ${request._id}:`, statusError?.message || statusError);
      }

      try {
        const booking = await Booking.findById(request.booking).select("customer professional").lean();
        const customerId = booking?.customer?.toString();
        const professionalId = booking?.professional?.toString();
        if (customerId) {
          notifyAsync({
            userId: customerId,
            eventKey: "customer.refund_escalated",
            entityType: "booking",
            entityId: String(request.booking),
            context: {
              bookingId: String(request.booking),
              escalationReason: "no_response",
            },
          });
        }
        if (professionalId) {
          notifyAsync({
            userId: professionalId,
            eventKey: "professional.refund_escalated",
            entityType: "booking",
            entityId: String(request.booking),
            context: {
              bookingId: String(request.booking),
              escalationReason: "no_response",
            },
          });
        }
      } catch (emailError: any) {
        console.error(`[refundSla] escalation notify failed for ${request._id}:`, emailError?.message || emailError);
      }
    } catch (error: any) {
      console.error(`[refundSla] Failed to escalate request ${request._id}:`, error?.message || error);
      stats.errors++;
    }
  }

  return stats;
};
