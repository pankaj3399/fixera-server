import { Request, Response } from "express";
import mongoose from "mongoose";
import SupportTicket from "../../models/supportTicket";
import MeetingRequest from "../../models/meetingRequest";
import connectDB from "../../config/db";
import { IUser } from "../../models/user";
import { UserFacingError } from "../../utils/appErrors";
import { params } from "../../utils/requestParams";
import { createSupportItemForUser } from "../Support/service";
import { serializeSupportTicketUser } from "../../utils/support/serializers";
import { withAnonymizationWriteFence } from "../../utils/support/accountGuard";
import { sendHandlerError } from "../../utils/handlerErrors";

const isValidObjectId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

const requesterFromUser = (user: IUser) => ({
  _id: String(user._id),
  id: String(user._id),
  name: user.name,
  email: user.email,
  role: user.role,
});

export const createSupportTicket = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    await connectDB();
    // Legacy professional route: older clients do not send reason/locale. The
    // canonical reason ID "other" keeps the compatibility path working while
    // new records still get a unique number and acknowledgement email.
    const result = await createSupportItemForUser({
      user,
      body: { ...(req.body || {}), kind: "ticket" },
      options: { legacyTicketWithoutReason: true },
    });
    return res.status(201).json({
      success: true,
      data: await serializeSupportTicketUser(result.ticket, { requester: requesterFromUser(user) }),
      emailSent: result.emailSent,
    });
  } catch (error) {
    return sendHandlerError(res, error, "Failed to create ticket");
  }
};

export const listMyTickets = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    await connectDB();
    const tickets = await SupportTicket.find({ userId: user._id })
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();
    return res.status(200).json({
      success: true,
      data: {
        items: await Promise.all(tickets.map((ticket) =>
          serializeSupportTicketUser(ticket, { requester: requesterFromUser(user) }),
        )),
      },
    });
  } catch (error) {
    console.error("List my tickets error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load tickets" });
  }
};

export const replyToMyTicket = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    const { id } = params(req.params);
    if (!isValidObjectId(id)) return res.status(400).json({ success: false, msg: "Invalid ticket ID" });

    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body || body.length > 5000) {
      return res.status(400).json({ success: false, msg: "Reply body is required (max 5000 chars)" });
    }

    await connectDB();
    const existing = await SupportTicket.findOne({ _id: id, userId: user._id });
    if (!existing) return res.status(404).json({ success: false, msg: "Ticket not found" });
    if (existing.status === "closed") {
      return res.status(400).json({ success: false, msg: "Ticket is closed" });
    }
    const ticket = await withAnonymizationWriteFence([user._id], async (session) => {
      const current = await SupportTicket.findOne({ _id: id, userId: user._id })
        .session(session ?? null);
      if (!current) return null;
      if (current.status === "closed") {
        throw new UserFacingError(400, "Ticket is closed", "VALIDATION");
      }
      current.replies.push({
        authorId: user._id,
        authorRole: "professional",
        body,
        createdAt: new Date(),
      });
      await current.save(session ? { session } : undefined);
      return current;
    });
    if (!ticket) return res.status(404).json({ success: false, msg: "Ticket not found" });
    return res.status(200).json({
      success: true,
      data: await serializeSupportTicketUser(ticket, { requester: requesterFromUser(user) }),
    });
  } catch (error) {
    return sendHandlerError(res, error, "Failed to reply");
  }
};

export const createMeetingRequest = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
    const preferredTimes = typeof req.body?.preferredTimes === "string" ? req.body.preferredTimes.trim() : "";
    const durationProvided = req.body?.durationMinutes !== undefined && req.body?.durationMinutes !== null;
    let durationMinutes = 30;
    if (durationProvided) {
      const durationRaw = Number(req.body.durationMinutes);
      if (!Number.isInteger(durationRaw) || durationRaw < 15 || durationRaw > 240) {
        return res.status(400).json({ success: false, msg: "durationMinutes must be between 15 and 240" });
      }
      durationMinutes = durationRaw;
    }

    if (!topic || topic.length > 200) {
      return res.status(400).json({ success: false, msg: "Topic is required (max 200 chars)" });
    }
    if (!preferredTimes || preferredTimes.length > 1000) {
      return res.status(400).json({ success: false, msg: "Preferred times are required (max 1000 chars)" });
    }

    await connectDB();
    const request = await withAnonymizationWriteFence([user._id], async (session) => {
      const [created] = await MeetingRequest.create([{
        userId: user._id,
        topic,
        preferredTimes,
        durationMinutes,
      }], session ? { session } : undefined);
      return created;
    });

    return res.status(201).json({ success: true, data: request });
  } catch (error) {
    return sendHandlerError(res, error, "Failed to create meeting request");
  }
};

export const listMyMeetingRequests = async (req: Request, res: Response) => {
  try {
    const user = req.user as IUser;
    await connectDB();
    const items = await MeetingRequest.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    console.error("List my meeting requests error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load meeting requests" });
  }
};
