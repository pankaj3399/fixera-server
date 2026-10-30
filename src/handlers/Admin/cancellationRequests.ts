import { Request, Response } from "express";
import mongoose from "mongoose";
import CancellationRequest from "../../models/cancellationRequest";
import Booking from "../../models/booking";
import Payment from "../../models/payment";
import User from "../../models/user";
import { executeRefund, RefundError } from "../Stripe/payment";
import { releaseScheduleSlots } from "../../utils/scheduleRelease";
import { releaseBookingCalendar } from "../../utils/support/bookingCalendar";
import { notifyBookingCancelledAndRefunded } from "../../utils/notifications/notifyBookingCancelledAndRefunded";
import { auditLog } from "../../utils/auditLogger";
import { param, params } from "../../utils/requestParams";
import { notify } from '../../utils/notifications/notify';
import { maskCancellationRequestForAnonymizedParties } from '../../utils/accountAnonymity';
import {
  ensureRefundInvoices,
  isBookingStarted,
  leavesBillableRemainder,
  pruneFutureResourcePlanDays,
  retainPastBookingCalendar,
} from "../../utils/refundFinalization";

const VALID_STATUSES = ["pending", "processing", "negotiating", "escalated", "approved", "denied"] as const;
const ADMIN_ACTIONABLE_STATUSES = ["pending", "escalated"];

const parsePagination = (query: any) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  return { page, limit, skip: (page - 1) * limit };
};

export const listCancellationRequests = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const filter: any = {};
    if (typeof status === "string" && (VALID_STATUSES as readonly string[]).includes(status)) {
      filter.status = status;
    }

    const [items, total] = await Promise.all([
      CancellationRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: "booking",
          select: "bookingNumber status customer professional payment scheduledStartDate",
          populate: [
            { path: "customer", select: "name email isAnonymized deletedAt" },
            { path: "professional", select: "name email isAnonymized deletedAt" },
          ],
        })
        .populate("requestedBy", "name email isAnonymized deletedAt")
        .populate("resolvedBy", "name email isAnonymized deletedAt")
        .lean(),
      CancellationRequest.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        items: items.map((item) => maskCancellationRequestForAnonymizedParties(item)),
        total,
        page,
        limit,
      },
    });
  } catch (error: any) {
    console.error("List cancellation requests error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load cancellation requests" });
  }
};

export const getCancellationRequest = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const item = await CancellationRequest.findById(id)
      .populate({
        path: "booking",
        populate: [
          { path: "customer", select: "name email isAnonymized deletedAt" },
          { path: "professional", select: "name email isAnonymized deletedAt" },
        ],
      })
      .populate("requestedBy", "name email isAnonymized deletedAt")
      .populate("resolvedBy", "name email isAnonymized deletedAt")
      .lean();
    if (!item) {
      return res.status(404).json({ success: false, msg: "Not found" });
    }
    return res.json({
      success: true,
      data: maskCancellationRequestForAnonymizedParties(item),
    });
  } catch (error: any) {
    console.error("Get cancellation request error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load cancellation request" });
  }
};

export const approveCancellationRequest = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }

    const { amount: rawAmount, note: rawNote, resolutionNote: rawResolutionNote } = req.body || {};
    let customAmount: number | undefined;
    if (rawAmount !== undefined && rawAmount !== null && rawAmount !== "") {
      const parsedAmount = typeof rawAmount === "string" ? Number.parseFloat(rawAmount) : Number(rawAmount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ success: false, msg: "amount must be a number greater than 0" });
      }
      customAmount = parsedAmount;
    }

    const rawResolutionNoteValue = rawResolutionNote ?? rawNote;
    let resolutionNote: string | undefined;
    if (rawResolutionNoteValue !== undefined && rawResolutionNoteValue !== null && rawResolutionNoteValue !== "") {
      if (typeof rawResolutionNoteValue !== "string") {
        return res.status(400).json({ success: false, msg: "note must be a string" });
      }
      const trimmedNote = rawResolutionNoteValue.trim();
      if (trimmedNote.length > 500) {
        return res.status(400).json({ success: false, msg: "note cannot exceed 500 characters" });
      }
      if (trimmedNote) resolutionNote = trimmedNote;
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const priorDoc = await CancellationRequest.findById(id).select("status").lean();
    if (!priorDoc) {
      return res.status(404).json({ success: false, msg: "Cancellation request not found" });
    }
    const priorStatus = priorDoc.status;
    if (!ADMIN_ACTIONABLE_STATUSES.includes(priorStatus)) {
      return res.status(409).json({ success: false, msg: `Request is already ${priorStatus}` });
    }
    const cancellation = await CancellationRequest.findOneAndUpdate(
      { _id: id, status: priorStatus },
      { $set: { status: "processing", resolvedBy: adminObjectId, resolvedAt: new Date() } },
      { new: true }
    );
    if (!cancellation) {
      const existing = await CancellationRequest.findById(id).lean();
      if (!existing) {
        return res.status(404).json({ success: false, msg: "Cancellation request not found" });
      }
      return res.status(409).json({ success: false, msg: `Request is already ${existing.status}` });
    }

    const booking = await Booking.findById(cancellation.booking);
    if (!booking) {
      await CancellationRequest.updateOne(
        { _id: cancellation._id, status: "processing" },
        { $set: { status: priorStatus }, $unset: { resolvedBy: "", resolvedAt: "" } }
      );
      return res.status(404).json({ success: false, msg: "Linked booking not found" });
    }

    const resolvedReason = cancellation.reason;
    const adminResolutionNote = resolutionNote?.trim() || undefined;

    let refundAmount = 0;
    let refundedAt: Date | undefined;
    const totalWithVat = booking.payment?.totalWithVat ?? 0;
    const hasPayment = !!booking.payment?.stripePaymentIntentId;
    const refundableStatuses = ["authorized", "completed", "partially_refunded"];

    if (customAmount !== undefined && totalWithVat > 0 && customAmount > totalWithVat) {
      await CancellationRequest.updateOne(
        { _id: cancellation._id, status: "processing" },
        { $set: { status: priorStatus }, $unset: { resolvedBy: "", resolvedAt: "" } }
      );
      return res.status(400).json({
        success: false,
        msg: `amount cannot exceed the payment total of ${totalWithVat}`,
      });
    }

    if (hasPayment && booking.payment && refundableStatuses.includes(booking.payment.status)) {
      try {
        const result = await executeRefund(String(booking._id), {
          reason: adminResolutionNote || 'Cancellation approved by admin',
          ...(customAmount !== undefined ? { amount: customAmount } : {}),
          actorId: adminObjectId,
        });
        refundAmount = result.amount;
        refundedAt = new Date();
      } catch (error: any) {
        await CancellationRequest.updateOne(
          { _id: cancellation._id, status: "processing" },
          { $set: { status: priorStatus }, $unset: { resolvedBy: "", resolvedAt: "" } }
        );
        if (error instanceof RefundError) {
          return res.status(error.httpStatus).json({
            success: false,
            msg: `Refund failed: ${error.message}`,
            code: error.code,
          });
        }
        throw error;
      }
    }

    const freshBooking = await Booking.findById(cancellation.booking);
    if (!freshBooking) {
      return res.status(404).json({ success: false, msg: "Booking disappeared during refund" });
    }

    freshBooking.cancellation = {
      cancelledBy: cancellation.requestedBy,
      reason: resolvedReason.slice(0, 500),
      cancelledAt: new Date(),
      refundAmount: refundAmount || undefined,
      ...(adminResolutionNote ? { adminResolutionNote } : {}),
    } as any;

    const adminStatusNote = (adminResolutionNote
      ? `Cancellation approved by admin: ${adminResolutionNote}`
      : 'Cancellation approved by admin').slice(0, 500);

    if (freshBooking.status !== "cancelled" && freshBooking.status !== "refunded") {
      await (freshBooking as any).updateStatus(
        "cancelled",
        adminId,
        adminStatusNote
      );
    } else {
      freshBooking.statusHistory = freshBooking.statusHistory || [];
      freshBooking.statusHistory.push({
        status: freshBooking.status,
        timestamp: new Date(),
        updatedBy: adminId,
        note: adminStatusNote,
      } as any);
    }

    releaseScheduleSlots(freshBooking, adminId);
    // A partial refund on a started booking keeps past planned days blocked
    // and unplans only future days; anything else releases the whole calendar.
    const partialRefundRemainder = leavesBillableRemainder(totalWithVat, refundAmount);
    if (partialRefundRemainder && isBookingStarted(freshBooking)) {
      pruneFutureResourcePlanDays(freshBooking);
    }
    await freshBooking.save();
    try {
      if (partialRefundRemainder && isBookingStarted(freshBooking)) {
        await retainPastBookingCalendar(freshBooking);
      } else {
        await releaseBookingCalendar(freshBooking._id);
      }
    } catch (calendarError) {
      // The cancellation is already effective; a failed calendar update must
      // not leave the request stuck in `processing`. The booking post-save hook
      // records `calendarReleasePending` for the scheduled retry.
      console.error(
        "Calendar update failed after approving cancellation; retry queued",
        calendarError instanceof Error ? calendarError.name : typeof calendarError,
      );
    }
    if (partialRefundRemainder) {
      void ensureRefundInvoices(String(freshBooking._id));
    }

    cancellation.status = "approved";
    cancellation.resolvedAt = new Date();
    cancellation.resolvedBy = new mongoose.Types.ObjectId(adminId);
    cancellation.refundAmount = refundAmount || undefined;
    cancellation.refundedAt = refundedAt;
    cancellation.adminResolutionNote = adminResolutionNote;
    await cancellation.save();

    try {
      const [customerUser, professionalUser] = await Promise.all([
        freshBooking.customer ? User.findById(freshBooking.customer).select("_id name").lean() : null,
        freshBooking.professional ? User.findById(freshBooking.professional).select("_id name businessInfo username").lean() : null,
      ]);

      notifyBookingCancelledAndRefunded({
        bookingId: String(freshBooking._id),
        reason: cancellation.reason,
        cancelledBy: 'admin',
        customerUser,
        professionalUser,
        refundAmount,
        currency: freshBooking.payment?.currency || 'EUR',
        isPartialRefund: refundAmount < totalWithVat,
      });
    } catch (notifyError: any) {
      console.error("Approve cancellation notify error:", notifyError?.message || notifyError);
    }

    await auditLog({
      req,
      action: 'admin.cancellation_requests.approve',
      targetType: 'Booking',
      targetId: freshBooking._id,
      details: {
        cancellationRequestId: cancellation._id,
        reason: cancellation.reason,
        refundAmount,
        totalWithVat,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.json({
      success: true,
      data: { cancellationRequest: cancellation, refundAmount },
    });
  } catch (error: any) {
    console.error("Approve cancellation request error:", error);
    await auditLog({
      req,
      action: 'admin.cancellation_requests.approve',
      targetType: 'CancellationRequest',
      targetId: param(req.params.id),
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: "Failed to approve cancellation" });
  }
};

export const denyCancellationRequest = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { denyReason } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    if (typeof denyReason !== "string" || !denyReason.trim() || denyReason.trim().length > 500) {
      return res.status(400).json({ success: false, msg: "denyReason is required (max 500 chars)" });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);

    let cancellation: any = null;
    let notActionable: { code: number; msg: string } | null = null;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      cancellation = await CancellationRequest.findOneAndUpdate(
        { _id: id, status: { $in: ADMIN_ACTIONABLE_STATUSES } },
        {
          $set: {
            status: "denied",
            denyReason: denyReason.trim(),
            resolvedAt: new Date(),
            resolvedBy: adminObjectId,
          },
        },
        { new: true, session }
      );
      if (!cancellation) {
        const existing = await CancellationRequest.findById(id).session(session).lean();
        notActionable = existing
          ? { code: 409, msg: `Request is already ${existing.status}` }
          : { code: 404, msg: "Cancellation request not found" };
        await session.abortTransaction();
      } else {
        const booking = await Booking.findById(cancellation.booking).session(session);
        if (booking && booking.status === "dispute") {
          const restored = (booking.statusBeforeDispute as any) ||
            (booking.actualStartDate ? "in_progress" : "booked");
          booking.status = restored;
          booking.statusBeforeDispute = undefined;
          booking.statusHistory = booking.statusHistory || [];
          booking.statusHistory.push({
            status: restored,
            timestamp: new Date(),
            updatedBy: adminObjectId,
            note: "Refund request denied; booking restored from dispute",
          } as any);
          await booking.save({ session });
        }
        await session.commitTransaction();
      }
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      session.endSession();
    }

    if (notActionable) {
      return res.status(notActionable.code).json({ success: false, msg: notActionable.msg });
    }

    await cancellation.populate("requestedBy", "email name businessInfo username isAnonymized deletedAt");

    try {
      const requester: any = cancellation.requestedBy;
      if (requester?._id) {
        const eventKey =
          cancellation.requestedRole === "professional"
            ? "professional.refund_denied"
            : "customer.refund_denied";
        await notify({
          userId: requester._id.toString(),
          eventKey,
          entityType: "booking",
          entityId: String(cancellation.booking),
          context: {
            bookingId: String(cancellation.booking),
            reason: cancellation.denyReason || denyReason.trim(),
          },
        });
      }
    } catch (emailError: any) {
      console.error("Deny cancellation notify error:", emailError?.message || emailError);
    }

    await auditLog({
      req,
      action: 'admin.cancellation_requests.deny',
      targetType: 'CancellationRequest',
      targetId: cancellation._id,
      details: {
        bookingId: String(cancellation.booking),
        denyReason: denyReason.trim(),
      },
      status: 'success',
      statusCode: 200,
    });

    return res.json({ success: true, data: { cancellationRequest: cancellation } });
  } catch (error: any) {
    console.error("Deny cancellation request error:", error);
    await auditLog({
      req,
      action: 'admin.cancellation_requests.deny',
      targetType: 'CancellationRequest',
      targetId: param(req.params.id),
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: "Failed to deny cancellation" });
  }
};
