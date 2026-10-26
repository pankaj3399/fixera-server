import { Request, Response } from "express";
import mongoose from "mongoose";
import SupportTicket, { SUPPORT_TICKET_STATUSES, SupportTicketStatus } from "../../models/supportTicket";
import MeetingRequest, {
  MEETING_REQUEST_STATUSES,
  MeetingRequestStatus,
} from "../../models/meetingRequest";
import connectDB from "../../config/db";
import { IUser } from "../../models/user";
import User from "../../models/user";
import { params } from "../../utils/requestParams";
import { isAdminAvailableForMeeting } from "../User/adminAvailability";
import { sendSupportReplyEmail } from "../../utils/support/emails";
import { UserFacingError } from "../../utils/appErrors";
import {
  professionalHasBusyConflict,
  resolveStoredCalendarTimeZone,
} from "../../utils/support/availability";
import {
  isAnonymizedAccount,
  maskAnonymizedUser,
} from "../../utils/accountAnonymity";
import {
  buildCalendarReservationKeysForInterval,
  releaseCalendarReservations,
  reserveCalendarKeys,
} from "../../utils/support/calendarReservations";

const isValidObjectId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

/**
 * Optimistic-concurrency filter for the legacy schedule update. The document
 * is loaded before the reservation/schedule transaction; if a delete or another
 * writer changed it first, the update must match nothing and abort the
 * transaction instead of committing orphan reservation keys.
 */
const meetingRequestVersionFilter = (doc: { __v?: number }): Record<string, unknown> => {
  const version = Number(doc.__v || 0);
  return version === 0
    ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] }
    : { __v: version };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const parsePagination = (req: Request): { page: number; limit: number; skip: number } => {
  const rawPage = Number(req.query.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const rawLimit = Number(req.query.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.trunc(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
};

export const adminListTickets = async (req: Request, res: Response) => {
  try {
    const statusQuery = typeof req.query.status === "string" ? req.query.status : undefined;
    const filter: Record<string, unknown> = {};
    if (statusQuery !== undefined) {
      if (!SUPPORT_TICKET_STATUSES.includes(statusQuery as SupportTicketStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${statusQuery}` });
      }
      filter.status = statusQuery;
    }

    const { page, limit, skip } = parsePagination(req);

    await connectDB();
    const [items, total] = await Promise.all([
      SupportTicket.find(filter)
        .populate("userId", "name email role isAnonymized deletedAt")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("Admin list tickets error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load tickets" });
  }
};

export const adminUpdateTicket = async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { admin?: IUser }).admin;
    if (!admin) return res.status(401).json({ success: false, msg: "Unauthorized" });

    const { id } = params(req.params);
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, msg: "Invalid ticket ID" });

    await connectDB();
    const ticket = await SupportTicket.findById(id);
    if (!ticket) return res.status(404).json({ success: false, msg: "Ticket not found" });

    let nextStatus: SupportTicketStatus | undefined;
    if (req.body?.status !== undefined) {
      if (typeof req.body.status !== "string" || !SUPPORT_TICKET_STATUSES.includes(req.body.status as SupportTicketStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${req.body.status}` });
      }
      nextStatus = req.body.status as SupportTicketStatus;
    }

    const hasReply = typeof req.body?.reply === "string" && req.body.reply.trim();

    if (hasReply && ticket.status === "closed" && (nextStatus ?? ticket.status) === "closed") {
      return res.status(400).json({
        success: false,
        msg: "Cannot reply on a closed ticket. Reopen it by setting a non-closed status first.",
      });
    }

    if (
      nextStatus === "closed" &&
      ticket.kind === "meeting" &&
      ticket.meeting &&
      ["pending", "scheduled"].includes(ticket.meeting.status)
    ) {
      return res.status(409).json({
        success: false,
        msg: "Cancel or complete the meeting before closing this request.",
      });
    }

    if (nextStatus) ticket.status = nextStatus;

    let replyBody: string | undefined;
    if (hasReply) {
      const body = req.body.reply.trim().slice(0, 5000);
      replyBody = body;
      ticket.replies.push({
        authorId: admin._id,
        authorRole: "admin",
        body,
        createdAt: new Date(),
      });
    }

    await ticket.save();
    let emailSent: boolean | undefined;
    if (replyBody) {
      try {
        await ticket.populate("userId", "name email isEmailVerified deletedAt isAnonymized");
        emailSent = await sendSupportReplyEmail(
          ticket.userId as unknown as { name?: string; email?: string; isEmailVerified?: boolean },
          ticket as unknown as never,
          replyBody,
        );
      } catch (error) {
        console.error("Support reply email failed:", error);
        emailSent = false;
      }
    }
    return res.status(200).json({
      success: true,
      data: ticket,
      ...(emailSent !== undefined ? { emailSent } : {}),
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "VersionError") {
      return res.status(409).json({
        success: false,
        msg: "This ticket changed while you were editing it. Refresh and try again.",
        code: "CONFLICT",
      });
    }
    console.error("Admin update ticket error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update ticket" });
  }
};

export const adminListMeetingRequests = async (req: Request, res: Response) => {
  try {
    const statusQuery = typeof req.query.status === "string" ? req.query.status : undefined;
    const filter: Record<string, unknown> = {};
    if (statusQuery !== undefined) {
      if (!MEETING_REQUEST_STATUSES.includes(statusQuery as MeetingRequestStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${statusQuery}` });
      }
      filter.status = statusQuery;
    }

    const { page, limit, skip } = parsePagination(req);

    await connectDB();
    const [items, total] = await Promise.all([
      MeetingRequest.find(filter)
        .populate("userId", "name email role isAnonymized deletedAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MeetingRequest.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        items: items.map((item: any) => {
          const requesterAnonymized = isAnonymizedAccount(item.userId);
          return {
            ...item,
            userId: maskAnonymizedUser(item.userId),
            ...(requesterAnonymized
              ? { topic: "[deleted]", preferredTimes: "[deleted]" }
              : {}),
          };
        }),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("Admin list meeting requests error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load meeting requests" });
  }
};

export const adminUpdateMeetingRequest = async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { admin?: IUser }).admin;
    if (!admin) return res.status(401).json({ success: false, msg: "Unauthorized" });
    const { id } = params(req.params);
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, msg: "Invalid request ID" });

    await connectDB();
    const doc = await MeetingRequest.findById(id);
    if (!doc) return res.status(404).json({ success: false, msg: "Request not found" });

    let nextStatus: MeetingRequestStatus | undefined;
    if (req.body?.status !== undefined) {
      if (typeof req.body.status !== "string" || !MEETING_REQUEST_STATUSES.includes(req.body.status as MeetingRequestStatus)) {
        return res.status(400).json({ success: false, msg: `Invalid status: ${req.body.status}` });
      }
      nextStatus = req.body.status as MeetingRequestStatus;
    }

    let parsedScheduledAt: Date | undefined;
    const clearScheduledAt = req.body?.scheduledAt === null || req.body?.scheduledAt === "";
    if (!clearScheduledAt && req.body?.scheduledAt !== undefined) {
      if (typeof req.body.scheduledAt !== "string" || !req.body.scheduledAt.trim()) {
        return res.status(400).json({ success: false, msg: "Invalid scheduledAt date" });
      }
      const when = new Date(req.body.scheduledAt);
      if (Number.isNaN(when.getTime())) {
        return res.status(400).json({ success: false, msg: "Invalid scheduledAt date" });
      }
      parsedScheduledAt = when;
    }

    const willBeScheduled = (nextStatus ?? doc.status) === "scheduled";
    const effectiveScheduledAt = parsedScheduledAt ?? (clearScheduledAt ? undefined : doc.scheduledAt);
    if (willBeScheduled && !effectiveScheduledAt) {
      return res.status(400).json({
        success: false,
        msg: "scheduledAt is required when status is 'scheduled'",
      });
    }

    if (willBeScheduled && effectiveScheduledAt) {
      if (effectiveScheduledAt.getTime() <= Date.now()) {
        return res.status(400).json({ success: false, msg: "A support meeting must be scheduled in the future" });
      }
      if (!isAdminAvailableForMeeting(admin, effectiveScheduledAt, doc.durationMinutes)) {
        return res.status(409).json({ success: false, msg: "The selected time is outside your availability or is blocked" });
      }

      const professional = await User.findById(doc.userId).select(
        "name email timeZone businessInfo role deletedAt",
      );
      if (!professional || professional.deletedAt) {
        return res.status(404).json({ success: false, msg: "Meeting requester not found" });
      }
      const professionalTimeZone = resolveStoredCalendarTimeZone(professional);
      if (
        await professionalHasBusyConflict(
          doc.userId,
          professionalTimeZone,
          effectiveScheduledAt,
          doc.durationMinutes,
          undefined,
          {
            calendarTimeZone: professionalTimeZone,
            excludeMeetingRequestId: String(doc._id),
          },
        )
      ) {
        return res.status(409).json({
          success: false,
          msg: "The selected time overlaps a booking, meeting, or support reservation on the professional's calendar",
        });
      }

      const windowEnd = new Date(effectiveScheduledAt.getTime() + doc.durationMinutes * 60 * 1000);
      const maxDurationMinutes = 240;
      const updateFields: Record<string, unknown> = {};
      if (nextStatus) updateFields.status = nextStatus;
      if (parsedScheduledAt) updateFields.scheduledAt = parsedScheduledAt;
      else if (clearScheduledAt) updateFields.scheduledAt = undefined;
      if (typeof req.body?.adminResponse === "string") {
        updateFields.adminResponse = req.body.adminResponse.trim().slice(0, 2000);
      }

      const session = await mongoose.startSession();
      let scheduleConflict = false;
      let reservationError: unknown;
      try {
        await session.withTransaction(async () => {
          const nearbyRequests = await MeetingRequest.find({
            _id: { $ne: doc._id },
            status: 'scheduled',
            scheduledAt: {
              $lt: windowEnd,
              $gte: new Date(effectiveScheduledAt.getTime() - maxDurationMinutes * 60 * 1000),
            },
          }).select('scheduledAt durationMinutes').session(session);
          const hasConflict = nearbyRequests.some((request) => {
            if (!request.scheduledAt) return false;
            const requestEnd = new Date(request.scheduledAt.getTime() + request.durationMinutes * 60 * 1000);
            return request.scheduledAt < windowEnd && requestEnd > effectiveScheduledAt;
          });
          if (hasConflict) {
            scheduleConflict = true;
            return;
          }

          // Reserve the same shared calendar keys as support meetings and
          // project meetings so the three writers cannot double-book.
          await releaseCalendarReservations('meeting_request', doc._id, session);
          await reserveCalendarKeys(
            {
              sourceType: 'meeting_request',
              sourceId: doc._id,
              keys: [
                ...buildCalendarReservationKeysForInterval({
                  role: 'admin',
                  userId: admin._id,
                  startAt: effectiveScheduledAt,
                  endAt: windowEnd,
                }),
                ...buildCalendarReservationKeysForInterval({
                  role: 'professional',
                  userId: doc.userId,
                  startAt: effectiveScheduledAt,
                  endAt: windowEnd,
                }),
              ],
            },
            session,
          );
          const updated = await MeetingRequest.updateOne(
            { _id: doc._id, ...meetingRequestVersionFilter(doc) },
            { $set: updateFields, $inc: { __v: 1 } },
            { session },
          );
          if (updated.matchedCount === 0) {
            throw new UserFacingError(
              409,
              "This meeting request changed concurrently. Refresh and try again.",
              "CONFLICT",
            );
          }
        });
      } catch (error) {
        reservationError = error;
      } finally {
        await session.endSession();
      }

      if (scheduleConflict) {
        return res.status(409).json({ success: false, msg: "The selected time overlaps another scheduled support meeting" });
      }
      if (reservationError) {
        if (reservationError instanceof UserFacingError) {
          return res.status(reservationError.status).json({
            success: false,
            msg: reservationError.message,
            code: reservationError.code,
          });
        }
        throw reservationError;
      }

      const refreshed = await MeetingRequest.findById(doc._id);
      return res.status(200).json({ success: true, data: refreshed ?? doc });
    }

    if (nextStatus) doc.status = nextStatus;
    if (parsedScheduledAt) doc.scheduledAt = parsedScheduledAt;
    else if (clearScheduledAt) doc.scheduledAt = undefined;
    if (typeof req.body?.adminResponse === "string") {
      doc.adminResponse = req.body.adminResponse.trim().slice(0, 2000);
    }

    await doc.save();
    if (doc.status !== 'scheduled') {
      await releaseCalendarReservations('meeting_request', doc._id);
    }
    return res.status(200).json({ success: true, data: doc });
  } catch (error) {
    console.error("Admin update meeting request error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update request" });
  }
};
