import { Request, Response } from "express";
import mongoose from "mongoose";
import Booking from "../../models/booking";
import User from "../../models/user";
import Payment from "../../models/payment";
import CancellationRequest from "../../models/cancellationRequest";
import { auditLog } from "../../utils/auditLogger";
import { params } from "../../utils/requestParams";
import { buildDetailsForBookingDocument } from "../Booking/details";
import {
  filterRawBookingForAdminArea,
  resolveBookingAdminAccess,
} from "../../utils/bookingDetails/adminAccess";
import {
  maskAnonymizedUser,
  maskBookingForAnonymizedParties,
  maskCancellationRequestForAnonymizedParties,
} from "../../utils/accountAnonymity";

export const ADMIN_FORCEABLE_STATUSES = [
  "payment_pending",
  "booked",
  "in_progress",
  "professional_completed",
  "completed",
  "dispute",
];

export const getAdminBookingDetail = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }

    const booking = await Booking.findById(id)
      .populate("customer", "name username email phone role customerType location vatNumber totalSpent timeZone businessName isAnonymized deletedAt")
      .populate("professional", "name username email phone role businessInfo vatNumber timeZone isAnonymized deletedAt")
      .populate("project", "title description pricing category service areaOfWork timeMode priceModel media rfqQuestions postBookingQuestions professionalId extraOptions termsConditions subprojects minResources minOverlapPercentage executionDuration services customConfirmationMessage resources")
      .populate("rescheduleHistory.requestedBy", "name email isAnonymized deletedAt")
      .populate("rescheduleHistory.respondedBy", "name email isAnonymized deletedAt")
      .populate("dispute.raisedBy", "name email isAnonymized deletedAt")
      .populate("dispute.resolvedBy", "name email isAnonymized deletedAt")
      .lean();

    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const adminUser = (req as any).admin || (req as any).user;
    const adminAccess = await resolveBookingAdminAccess(adminUser);
    if (!adminAccess.bookings) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to view this booking",
        code: "ADMIN_PERMISSION_DENIED",
      });
    }

    const [payment, cancellationRequests] = await Promise.all([
      adminAccess.payments
        ? Payment.findOne({ booking: id })
            .populate("customer", "name email isAnonymized deletedAt")
            .populate("professional", "name email isAnonymized deletedAt")
            .lean()
        : Promise.resolve(null),
      adminAccess.cancellations
        ? CancellationRequest.find({ booking: id })
            .sort({ createdAt: -1 })
            .populate("requestedBy", "name email isAnonymized deletedAt")
            .populate("resolvedBy", "name email isAnonymized deletedAt")
            .lean()
        : Promise.resolve([]),
    ]);

    const details = await buildDetailsForBookingDocument({
      booking,
      viewerRole: "admin",
      user: adminUser,
      adminAccess,
    });

    const projectProfessionalId = String((booking as any).project?.professionalId || "");
    let projectProfessionalAnonymized = false;
    if (projectProfessionalId && !(booking as any).professional) {
      const projectProfessional = await User.findById(projectProfessionalId)
        .select("isAnonymized deletedAt")
        .lean();
      projectProfessionalAnonymized = Boolean(
        projectProfessional?.isAnonymized || projectProfessional?.deletedAt,
      );
    }
    const maskingFlags = projectProfessionalAnonymized
      ? { professional: true, professionalId: projectProfessionalId }
      : {};

    return res.json({
      success: true,
      data: {
        booking: maskBookingForAnonymizedParties(
          filterRawBookingForAdminArea(booking, adminAccess),
          maskingFlags,
        ),
        payment: payment
          ? {
              ...payment,
              customer: maskAnonymizedUser(payment.customer),
              professional: maskAnonymizedUser(payment.professional),
            }
          : null,
        cancellationRequests: cancellationRequests.map((request) =>
          maskCancellationRequestForAnonymizedParties(request, {
            customerId: String((booking as any).customer?._id || (booking as any).customer || ""),
            professionalId: String((booking as any).professional?._id || (booking as any).professional || ""),
            customerAnonymized: Boolean((booking as any).customer?.isAnonymized || (booking as any).customer?.deletedAt),
            professionalAnonymized: Boolean((booking as any).professional?.isAnonymized || (booking as any).professional?.deletedAt),
          }),
        ),
        details,
      },
    });
  } catch (error: any) {
    console.error("Admin booking detail error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load booking detail" });
  }
};

export const forceBookingStatus = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    const { status, note } = req.body || {};
    const adminUser = (req as any).user || (req as any).admin;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    if (typeof status !== "string" || !ADMIN_FORCEABLE_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        msg: `status must be one of: ${ADMIN_FORCEABLE_STATUSES.join(", ")}`,
      });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const previousStatus = booking.status;
    if (previousStatus === status) {
      return res.status(400).json({ success: false, msg: `Booking is already "${status}"` });
    }

    const trimmedNote = typeof note === "string" ? note.trim().slice(0, 500) : "";
    booking.status = status as any;
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push({
      status: status as any,
      timestamp: new Date(),
      updatedBy: adminUser?._id,
      note: trimmedNote || `Status force-set by admin (was ${previousStatus})`,
    } as any);
    await booking.save();

    try {
      await auditLog({
        req,
        action: "admin.bookings.force_status",
        targetType: "Booking",
        targetId: id,
        details: { from: previousStatus, to: status, note: trimmedNote || undefined },
        status: "success",
        statusCode: 200,
      });
    } catch (auditError) {
      console.error("Audit log failed for force booking status:", auditError);
    }

    return res.json({ success: true, data: { status: booking.status, previousStatus } });
  } catch (error: any) {
    console.error("Force booking status error:", error);
    return res.status(500).json({ success: false, msg: "Failed to force booking status" });
  }
};
