import { Request, Response } from "express";
import mongoose from "mongoose";
import connectDB from "../../config/db";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket, { type ISupportTicket } from "../../models/supportTicket";
import SupportTicketInternalNote from "../../models/supportTicketInternalNote";
import User, { type IUser } from "../../models/user";
import {
  SUPPORT_TICKET_STATUSES,
  isSupportKind,
  isSupportTicketStatus,
} from "../../constants/support";
import { UserFacingError } from "../../utils/appErrors";
import { sendHandlerError } from "../../utils/handlerErrors";
import { toDate } from "../../utils/dateUtils";
import {
  buildLegacyMeetingRequestFilter,
  buildSupportTicketFilter,
  findSupportMatchingUserIds,
  paginationMeta,
  parseSupportListQuery,
} from "../../utils/support/query";
import {
  serializeLegacyMeetingRequestAdmin,
  serializeSupportNote,
  serializeSupportTicketAdmin,
} from "../../utils/support/serializers";
import { sendSupportReplyEmail } from "../../utils/support/emails";
import {
  getSupportAvailabilityForAdmin,
  isValidIanaTimeZone,
  parseSupportAvailabilityRange,
  resolveStoredCalendarTimeZone,
  resolveSupportTimeZone,
} from "../../utils/support/availability";
import {
  cancelSupportMeeting,
  completeSupportMeeting,
  rescheduleSupportMeeting,
  setSupportMeetingLink,
} from "../../utils/support/meetingReservation";
import { listSupportCalendarEvents } from "../../utils/support/calendarEvents";

function adminUser(req: Request): IUser {
  const admin = (req as Request & { admin?: IUser }).admin;
  if (!admin) throw new UserFacingError(401, "Admin authentication required.", "AUTH_REQUIRED");
  return admin;
}

async function loadNotes(ticketIds: mongoose.Types.ObjectId[]) {
  if (ticketIds.length === 0) return new Map<string, any[]>();
  const notes = await SupportTicketInternalNote.find({ ticketId: { $in: ticketIds } })
    .populate("adminId", "name")
    .sort({ createdAt: 1 })
    .lean();
  const map = new Map<string, any[]>();
  for (const note of notes) {
    const key = String(note.ticketId);
    const current = map.get(key) || [];
    current.push(note);
    map.set(key, current);
  }
  return map;
}

export const adminListSupportItems = async (req: Request, res: Response) => {
  try {
    adminUser(req);
    await connectDB();
    const parsed = parseSupportListQuery(req.query as Record<string, unknown>);
    const matchedUserIds = await findSupportMatchingUserIds(parsed.q);
    const ticketFilter = buildSupportTicketFilter(parsed, matchedUserIds);
    const legacyFilter = buildLegacyMeetingRequestFilter(parsed, matchedUserIds);
    const fetchLimit = parsed.page * parsed.limit;

    const [tickets, legacyRequests, ticketTotal, legacyTotal] = await Promise.all([
      SupportTicket.find(ticketFilter)
        .populate("userId", "name email role isAnonymized deletedAt")
        .populate("meeting.adminId", "name email")
        .sort({ updatedAt: -1, _id: -1 })
        .limit(fetchLimit)
        .lean(),
      legacyFilter
        ? MeetingRequest.find(legacyFilter)
            .populate("userId", "name email role isAnonymized deletedAt")
            .sort({ updatedAt: -1, _id: -1 })
            .limit(fetchLimit)
            .lean()
        : Promise.resolve([]),
      SupportTicket.countDocuments(ticketFilter),
      legacyFilter ? MeetingRequest.countDocuments(legacyFilter) : Promise.resolve(0),
    ]);

    const allEntries = [
      ...tickets.map((doc) => ({ type: "ticket" as const, doc: doc as Record<string, any> })),
      ...legacyRequests.map((doc) => ({ type: "legacy" as const, doc: doc as Record<string, any> })),
    ].sort((a, b) => {
      const aTime = new Date(a.doc.updatedAt || 0).getTime();
      const bTime = new Date(b.doc.updatedAt || 0).getTime();
      if (aTime !== bTime) return bTime - aTime;
      return String(b.doc._id || "").localeCompare(String(a.doc._id || ""));
    });
    const pageEntries = allEntries.slice(parsed.skip, parsed.skip + parsed.limit);

    const notesMap = await loadNotes(
      pageEntries
        .filter((entry) => entry.type === "ticket")
        .map((entry) => (entry.doc as { _id: mongoose.Types.ObjectId })._id),
    );
    const items = await Promise.all(
      pageEntries.map(async (entry) => {
        if (entry.type === "ticket") {
          const ticket = entry.doc as unknown as ISupportTicket;
          return serializeSupportTicketAdmin(
            ticket,
            notesMap.get(String((ticket as unknown as { _id: unknown })._id)) || [],
          );
        }
        return serializeLegacyMeetingRequestAdmin(entry.doc as never);
      }),
    );
    const total = ticketTotal + legacyTotal;

    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: paginationMeta(parsed.page, parsed.limit, total),
      },
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load support requests. Please try again.");
  }
};

async function findAdminSupportTicket(kind: string, id: string) {
  if (!isSupportKind(kind)) {
    throw new UserFacingError(400, "Invalid support item type.", "VALIDATION", "kind");
  }
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new UserFacingError(404, "Support request not found.", "NOT_FOUND");
  }
  const query = kind === "ticket"
    ? { _id: id, kind: { $ne: "meeting" } }
    : { _id: id, kind: "meeting" };
  return SupportTicket.findOne(query)
    .populate("userId", "name email role isEmailVerified deletedAt isAnonymized")
    .populate("meeting.adminId", "name email");
}

async function findAdminLegacyMeeting(id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return MeetingRequest.findOne({ _id: id }).populate("userId", "name email role isAnonymized deletedAt");
}

export const adminGetSupportItem = async (req: Request, res: Response) => {
  try {
    adminUser(req);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const ticket = await findAdminSupportTicket(kind, id);
    if (ticket) {
      const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
        .populate("adminId", "name")
        .sort({ createdAt: 1 })
        .lean();
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketAdmin(ticket as ISupportTicket, notes),
      });
    }
    if (kind === "meeting") {
      const legacy = await findAdminLegacyMeeting(id);
      if (legacy) {
        return res.status(200).json({
          success: true,
          data: serializeLegacyMeetingRequestAdmin(legacy as never),
        });
      }
    }
    throw new UserFacingError(404, "Support request not found.", "NOT_FOUND");
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load this support request. Please try again.");
  }
};

export const adminListSupportNotes = async (req: Request, res: Response) => {
  try {
    adminUser(req);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const ticket = await findAdminSupportTicket(kind, id);
    if (!ticket) {
      if (kind === "meeting" && (await findAdminLegacyMeeting(id))) {
        throw new UserFacingError(
          409,
          "Historical meeting requests do not support internal notes.",
          "CONFLICT",
        );
      }
      throw new UserFacingError(404, "Support request not found.", "NOT_FOUND");
    }
    const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
      .populate("adminId", "name")
      .sort({ createdAt: 1 })
      .lean();
    return res.status(200).json({
      success: true,
      data: { items: notes.map(serializeSupportNote) },
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load internal notes. Please try again.");
  }
};

export const adminCreateSupportNote = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const ticket = await findAdminSupportTicket(kind, id);
    if (!ticket) {
      if (kind === "meeting" && (await findAdminLegacyMeeting(id))) {
        throw new UserFacingError(
          409,
          "Historical meeting requests do not support internal notes.",
          "CONFLICT",
        );
      }
      throw new UserFacingError(404, "Support request not found.", "NOT_FOUND");
    }
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) {
      throw new UserFacingError(400, "Internal note body is required.", "VALIDATION", "body");
    }
    if (body.length > 5000) {
      throw new UserFacingError(400, "Internal note must be 5000 characters or fewer.", "VALIDATION", "body");
    }
    const note = await SupportTicketInternalNote.create({
      ticketId: ticket._id,
      adminId: admin._id,
      body,
    });
    return res.status(201).json({
      success: true,
      data: serializeSupportNote({
        ...(note.toObject() as unknown as Record<string, unknown>),
        adminId: { _id: admin._id, name: admin.name },
      }),
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't save the internal note. Please try again.");
  }
};

function publicReplyValidation(body: unknown): string {
  const value = typeof body === "string" ? body.trim() : "";
  if (!value) throw new UserFacingError(400, "Reply body is required.", "VALIDATION", "body");
  if (value.length > 5000) {
    throw new UserFacingError(400, "Reply must be 5000 characters or fewer.", "VALIDATION", "body");
  }
  return value;
}

async function sendAdminReplyEmail(ticket: ISupportTicket, replyBody: string): Promise<boolean> {
  const owner = (ticket.userId as unknown as {
    _id?: unknown;
    name?: string;
    email?: string;
    isEmailVerified?: boolean;
  } | null) || {};
  try {
    return await sendSupportReplyEmail(owner, ticket, replyBody);
  } catch (error) {
    console.error("Support reply email failed:", error);
    return false;
  }
}

export const adminReplySupportItem = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const ticket = await findAdminSupportTicket(kind, id);
    if (!ticket) {
      throw new UserFacingError(404, "Support request not found.", "NOT_FOUND");
    }
    if (ticket.status === "closed") {
      throw new UserFacingError(
        400,
        "Cannot reply on a closed ticket. Reopen it by setting a non-closed status first.",
        "VALIDATION",
      );
    }
    const body = publicReplyValidation(req.body?.body);
    ticket.replies.push({
      authorId: admin._id,
      authorRole: "admin",
      body,
      createdAt: new Date(),
    });
    await ticket.save();
    const emailSent = await sendAdminReplyEmail(ticket as ISupportTicket, body);
    const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
      .populate("adminId", "name")
      .sort({ createdAt: 1 })
      .lean();
    return res.status(200).json({
      success: true,
      data: await serializeSupportTicketAdmin(ticket as ISupportTicket, notes),
      emailSent,
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't send the reply. Please try again.");
  }
};

export const adminUpdateSupportItem = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const ticket = await findAdminSupportTicket(kind, id);
    if (!ticket) {
      if (kind === "meeting" && (await findAdminLegacyMeeting(id))) {
        throw new UserFacingError(
          409,
          "Historical meeting requests are read-only in the unified inbox. Use the legacy meeting-requests endpoint.",
          "CONFLICT",
        );
      }
      throw new UserFacingError(404, "Support request not found.", "NOT_FOUND");
    }

    const hasStatus = req.body?.status !== undefined;
    const hasReply = typeof req.body?.reply === "string" && req.body.reply.trim().length > 0;
    const hasNote = typeof req.body?.internalNote === "string" && req.body.internalNote.trim().length > 0;
    if (!hasStatus && !hasReply && !hasNote) {
      throw new UserFacingError(
        400,
        "Provide a status, a public reply, or an internal note.",
        "VALIDATION",
      );
    }

    let nextStatus: string | undefined;
    if (hasStatus) {
      if (!isSupportTicketStatus(req.body.status)) {
        throw new UserFacingError(
          400,
          `Invalid status. Allowed: ${SUPPORT_TICKET_STATUSES.join(", ")}.`,
          "VALIDATION",
          "status",
        );
      }
      nextStatus = req.body.status;
    }

    if (nextStatus === "closed" && ticket.kind === "meeting" && ticket.meeting) {
      if (["pending", "scheduled"].includes(ticket.meeting.status)) {
        throw new UserFacingError(
          409,
          "Cancel or complete the meeting before closing this request.",
          "CONFLICT",
        );
      }
    }

    const replyBody = hasReply ? publicReplyValidation(req.body.reply) : null;
    if (replyBody && ticket.status === "closed" && nextStatus !== "open" && nextStatus !== "in_progress" && nextStatus !== "resolved") {
      throw new UserFacingError(
        400,
        "Cannot reply on a closed ticket. Reopen it by setting a non-closed status first.",
        "VALIDATION",
      );
    }
    let noteBody: string | undefined;
    if (hasNote) {
      const body = req.body.internalNote.trim();
      if (body.length > 5000) {
        throw new UserFacingError(
          400,
          "Internal note must be 5000 characters or fewer.",
          "VALIDATION",
          "internalNote",
        );
      }
      noteBody = body;
    }

    if (nextStatus) ticket.status = nextStatus as ISupportTicket["status"];
    if (replyBody) {
      ticket.replies.push({
        authorId: admin._id,
        authorRole: "admin",
        body: replyBody,
        createdAt: new Date(),
      });
    }
    if (nextStatus || replyBody) await ticket.save();
    const emailSent = replyBody ? await sendAdminReplyEmail(ticket as ISupportTicket, replyBody) : undefined;

    let note = null;
    if (noteBody) {
      note = await SupportTicketInternalNote.create({
        ticketId: ticket._id,
        adminId: admin._id,
        body: noteBody,
      });
    }

    const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
      .populate("adminId", "name")
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: await serializeSupportTicketAdmin(ticket as ISupportTicket, notes),
      ...(emailSent !== undefined ? { emailSent } : {}),
      ...(note ? { note: serializeSupportNote({ ...(note.toObject() as unknown as Record<string, unknown>), adminId: { _id: admin._id, name: admin.name } }) } : {}),
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't update this support request. Please try again.");
  }
};

export const adminUpdateSupportMeeting = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    const ticket = await findAdminSupportTicket(kind, id);
    if (!ticket || kind !== "meeting" || !ticket.meeting) {
      if (kind === "meeting" && (await findAdminLegacyMeeting(id))) {
        throw new UserFacingError(
          409,
          "Historical meeting requests are managed through the legacy meeting-requests endpoint.",
          "CONFLICT",
        );
      }
      throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
    }

    const ownerId = (ticket.userId as unknown as { _id?: unknown })?._id || ticket.userId;
    const loadOwner = async () => {
      if (!ownerId) return null;
      const owner = await User.findById(ownerId).select(
        "name email isEmailVerified timeZone businessInfo deletedAt",
      );
      return owner || null;
    };

    const meetingBody = req.body?.meeting;
    const submittedLink = meetingBody?.meetingLink ?? req.body?.meetingLink;
    // Contract action is set_link; accepting a bare meetingLink keeps older
    // admin editors working without weakening validation.
    const action = meetingBody?.action ?? (submittedLink !== undefined ? "set_link" : undefined);
    if (action === "cancel") {
      const reason = typeof meetingBody?.reason === "string" ? meetingBody.reason : undefined;
      // Cancellation is cleanup: a hard-deleted owner must not leave the shared
      // calendar permanently blocked. Email is skipped when no recipient exists.
      const owner = await loadOwner();
      const result = await cancelSupportMeeting({
        ticket,
        actorId: admin._id,
        actorRole: "admin",
        owner,
        reason,
        allowPast: true,
      });
      const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
        .populate("adminId", "name")
        .sort({ createdAt: 1 })
        .lean();
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketAdmin(result.ticket as ISupportTicket, notes),
        ...(result.emailAttempted ? { emailSent: result.emailSent } : {}),
      });
    }

    if (action === "complete") {
      // Completion only releases/terminates state; no recipient is needed.
      const completed = await completeSupportMeeting({ ticket, actorId: admin._id });
      const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
        .populate("adminId", "name")
        .sort({ createdAt: 1 })
        .lean();
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketAdmin(completed as ISupportTicket, notes),
      });
    }

    if (action === "set_link" || action === "add_link" || action === "link") {
      const owner = await loadOwner();
      if (!owner) {
        throw new UserFacingError(404, "Support request owner not found.", "NOT_FOUND");
      }
      const result = await setSupportMeetingLink({
        ticket,
        adminId: admin._id,
        owner,
        meetingLink: submittedLink,
      });
      const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
        .populate("adminId", "name")
        .sort({ createdAt: 1 })
        .lean();
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketAdmin(result.ticket as ISupportTicket, notes),
        unchanged: result.unchanged,
        ...(result.emailAttempted ? { emailSent: result.emailSent } : {}),
      });
    }

    if (action === "reschedule") {
      const start = toDate(meetingBody?.scheduledAt);
      if (!start) {
        throw new UserFacingError(
          400,
          "Choose a valid meeting time in UTC (ISO 8601).",
          "VALIDATION",
          "scheduledAt",
        );
      }
      const owner = await loadOwner();
      if (!owner) {
        throw new UserFacingError(
          409,
          "This meeting owner no longer exists. Cancel or complete it to release the calendar.",
          "CONFLICT",
        );
      }
      const timeZone = resolveSupportTimeZone(owner, meetingBody?.timeZone);
      const result = await rescheduleSupportMeeting({
        ticket,
        professional: owner,
        start,
        timeZone,
        owner,
        actorRole: "admin",
        allowPastPending: true,
      });
      const notes = await SupportTicketInternalNote.find({ ticketId: ticket._id })
        .populate("adminId", "name")
        .sort({ createdAt: 1 })
        .lean();
      return res.status(200).json({
        success: true,
        data: await serializeSupportTicketAdmin(result.ticket as ISupportTicket, notes),
        ...(result.emailAttempted ? { emailSent: result.emailSent } : {}),
      });
    }

    throw new UserFacingError(400, "Invalid meeting action.", "VALIDATION", "action");
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't update this meeting. Please try again.");
  }
};

export const adminGetSupportAvailability = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    const requestedZone = typeof req.query.timeZone === "string" ? req.query.timeZone : undefined;
    const timeZone = requestedZone && requestedZone.trim()
      ? requestedZone.trim()
      : admin.timeZone && isValidIanaTimeZone(admin.timeZone)
        ? admin.timeZone
        : "UTC";
    if (!isValidIanaTimeZone(timeZone)) {
      throw new UserFacingError(400, "A valid IANA time zone is required.", "VALIDATION", "timeZone");
    }
    const range = parseSupportAvailabilityRange(
      typeof req.query.from === "string" ? req.query.from : undefined,
      typeof req.query.to === "string" ? req.query.to : undefined,
      timeZone,
    );
    const excludeItemId = typeof req.query.excludeItemId === "string" ? req.query.excludeItemId : undefined;
    if (excludeItemId && !mongoose.Types.ObjectId.isValid(excludeItemId)) {
      throw new UserFacingError(400, "Invalid excludeItemId.", "VALIDATION", "excludeItemId");
    }
    const explicitProfessionalId = typeof req.query.professionalId === "string"
      ? req.query.professionalId
      : undefined;
    if (explicitProfessionalId && !mongoose.Types.ObjectId.isValid(explicitProfessionalId)) {
      throw new UserFacingError(400, "Invalid professionalId.", "VALIDATION", "professionalId");
    }

    const professional = await resolveAdminAvailabilityProfessional({
      explicitProfessionalId,
      excludeItemId,
    });

    const result = await getSupportAvailabilityForAdmin({
      from: range.from,
      to: range.to,
      timeZone,
      excludeItemId,
      professional,
    });
    const events = await listSupportCalendarEvents({
      viewer: "admin",
      from: range.from,
      to: range.to,
      timeZone: result.timeZone,
    });
    return res.status(200).json({
      success: true,
      data: {
        timeZone: result.timeZone,
        durationMinutes: result.durationMinutes,
        professional: professional
          ? {
              id: String(professional._id),
              name: professional.name || "",
              timeZone: resolveStoredCalendarTimeZone(professional),
            }
          : null,
        admins: result.admins.map((item) => ({
          id: String(item._id),
          name: item.name || "",
          timeZone: item.timeZone || "UTC",
        })),
        slots: result.slots,
        events,
      },
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load combined availability. Please try again.");
  }
};

/**
 * Resolve the selected professional for the admin picker. `excludeItemId`
 * (the meeting being rescheduled) is authoritative: its owner's calendar must
 * be free, and an explicitly supplied professionalId must match it.
 */
async function resolveAdminAvailabilityProfessional(params: {
  explicitProfessionalId?: string;
  excludeItemId?: string;
}) {
  let ownerId: string | undefined;
  if (params.excludeItemId) {
    const ticket = await SupportTicket.findOne({
      _id: params.excludeItemId,
      kind: "meeting",
    })
      .select("userId")
      .lean();
    if (ticket?.userId) {
      ownerId = String(ticket.userId);
    } else {
      const legacy = await MeetingRequest.findOne({ _id: params.excludeItemId })
        .select("userId")
        .lean();
      if (legacy?.userId) ownerId = String(legacy.userId);
    }
  }
  if (ownerId && params.explicitProfessionalId && ownerId !== params.explicitProfessionalId) {
    throw new UserFacingError(
      400,
      "The selected professional does not own this meeting.",
      "VALIDATION",
      "professionalId",
    );
  }
  const professionalId = ownerId || params.explicitProfessionalId;
  if (!professionalId) return null;

  const professional = await User.findById(professionalId).select(
    "name timeZone businessInfo role deletedAt",
  );
  if (!professional || professional.deletedAt) {
    throw new UserFacingError(404, "Professional not found.", "NOT_FOUND", "professionalId");
  }
  if (professional.role === "admin") {
    throw new UserFacingError(
      400,
      "An admin account cannot be used as the meeting professional.",
      "VALIDATION",
      "professionalId",
    );
  }
  if (!ownerId && professional.role !== "professional") {
    throw new UserFacingError(
      400,
      "Choose a professional account for the meeting calendar.",
      "VALIDATION",
      "professionalId",
    );
  }
  return professional;
}
