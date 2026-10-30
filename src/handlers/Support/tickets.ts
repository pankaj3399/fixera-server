import { Request, Response } from "express";
import mongoose from "mongoose";
import connectDB from "../../config/db";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket, { type ISupportTicket } from "../../models/supportTicket";
import type { IUser } from "../../models/user";
import { UserFacingError } from "../../utils/appErrors";
import { sendHandlerError } from "../../utils/handlerErrors";
import { withAnonymizationWriteFence } from "../../utils/support/accountGuard";
import {
  buildLegacyMeetingRequestFilter,
  buildSupportTicketFilter,
  paginationMeta,
  parseSupportListQuery,
} from "../../utils/support/query";
import {
  serializeLegacyMeetingRequest,
  serializeSupportTicketUser,
} from "../../utils/support/serializers";
import {
  createSupportItemForUser,
  fetchOwnedSupportItem,
  requireSupportUser,
  serializeOwnedResult,
} from "./service";

function requesterFromUser(user: IUser) {
  return {
    _id: String(user._id),
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

export const createSupportItem = async (req: Request, res: Response) => {
  try {
    const user = requireSupportUser(req.user as IUser | undefined);
    await connectDB();
    const result = await createSupportItemForUser({
      user,
      body: req.body as Record<string, unknown> | undefined,
      file: req.file,
    });
    return res.status(201).json({
      success: true,
      data: await serializeSupportTicketUser(result.ticket, {
        requester: requesterFromUser(user),
      }),
      emailSent: result.emailSent,
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't create your support request. Please try again.");
  }
};

export const listSupportItems = async (req: Request, res: Response) => {
  try {
    const user = requireSupportUser(req.user as IUser | undefined);
    await connectDB();
    const parsed = parseSupportListQuery(req.query as Record<string, unknown>);
    const ticketFilter = buildSupportTicketFilter(parsed);
    // Legacy rows are read-only but owned by the same user record. A former
    // professional who is now a customer keeps access to that history.
    const legacyFilter = buildLegacyMeetingRequestFilter(parsed);

    const fetchLimit = parsed.page * parsed.limit;
    const [tickets, legacyRequests, ticketTotal, legacyTotal] = await Promise.all([
      SupportTicket.find({ userId: user._id, ...ticketFilter })
        .populate("userId", "name email role")
        .sort({ updatedAt: -1, _id: -1 })
        .limit(fetchLimit)
        .lean(),
      legacyFilter
        ? MeetingRequest.find({ userId: user._id, ...legacyFilter })
            .populate("userId", "name email role")
            .sort({ updatedAt: -1, _id: -1 })
            .limit(fetchLimit)
            .lean()
        : Promise.resolve([]),
      SupportTicket.countDocuments({ userId: user._id, ...ticketFilter }),
      legacyFilter
        ? MeetingRequest.countDocuments({ userId: user._id, ...legacyFilter })
        : Promise.resolve(0),
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
    const items = await Promise.all(
      pageEntries.map(async (entry) => {
        if (entry.type === "ticket") {
          return serializeSupportTicketUser(entry.doc as unknown as ISupportTicket, {
            requester: requesterFromUser(user),
          });
        }
        return serializeLegacyMeetingRequest(entry.doc as never, {
          requester: requesterFromUser(user),
        });
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
    return sendHandlerError(res, error, "We couldn't load your support requests. Please try again.");
  }
};

export const getSupportItem = async (req: Request, res: Response) => {
  try {
    const user = requireSupportUser(req.user as IUser | undefined);
    await connectDB();
    const result = await fetchOwnedSupportItem({
      user,
      kind: String(req.params.kind),
      id: String(req.params.id),
    });
    return res.status(200).json({
      success: true,
      data: await serializeOwnedResult(result, user),
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load this support request. Please try again.");
  }
};

export const replySupportItem = async (req: Request, res: Response) => {
  try {
    const user = requireSupportUser(req.user as IUser | undefined);
    await connectDB();
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    if (kind !== "ticket" && kind !== "meeting") {
      throw new UserFacingError(400, "Invalid support item type.", "VALIDATION", "kind");
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
    }
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) {
      throw new UserFacingError(400, "Reply body is required.", "VALIDATION", "body");
    }
    if (body.length > 5000) {
      throw new UserFacingError(400, "Reply body must be 5000 characters or fewer.", "VALIDATION", "body");
    }

    const query = kind === "ticket"
      ? { _id: id, userId: user._id, kind: { $ne: "meeting" } }
      : { _id: id, userId: user._id, kind: "meeting" };
    const existing = await SupportTicket.findOne(query);
    if (!existing) {
      if (kind === "meeting") {
        const legacy = await MeetingRequest.findOne({ _id: id, userId: user._id }).select("_id").lean();
        if (legacy) {
          throw new UserFacingError(
            409,
            "Historical meeting requests are read-only. Please open a new ticket for changes.",
            "CONFLICT",
          );
        }
      }
      throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
    }
    if (existing.status === "closed") {
      throw new UserFacingError(
        400,
        "This support request is closed. Open a new request if you need more help.",
        "VALIDATION",
      );
    }

    // The fenced re-read is the authoritative one: a request that passed
    // authentication before the tombstone must not append a reply afterwards.
    const ticket = await withAnonymizationWriteFence([user._id], async (session) => {
      const current = await SupportTicket.findOne(query).session(session ?? null);
      if (!current) return null;
      if (current.status === "closed") {
        throw new UserFacingError(
          400,
          "This support request is closed. Open a new request if you need more help.",
          "VALIDATION",
        );
      }
      current.replies.push({
        authorId: user._id,
        authorRole: user.role === "professional" ? "professional" : "customer",
        body,
        createdAt: new Date(),
      });
      await current.save(session ? { session } : undefined);
      return current;
    });
    if (!ticket) {
      throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
    }

    return res.status(200).json({
      success: true,
      data: await serializeSupportTicketUser(ticket as ISupportTicket, {
        requester: requesterFromUser(user),
      }),
    });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't add your reply. Please try again.");
  }
};
