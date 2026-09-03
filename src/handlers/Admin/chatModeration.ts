import { Request, Response } from "express";
import mongoose from "mongoose";
import ChatReport from "../../models/chatReport";
import ChatMessage from "../../models/chatMessage";
import Conversation from "../../models/conversation";
import Booking from "../../models/booking";
import User from "../../models/user";
import Project from "../../models/project";
import { params } from "../../utils/requestParams";
import {
  buildSupportParticipantKpis,
  escapeRegex,
  formatChatClosedMessage,
  normalizeInboxSearch,
} from "../../utils/adminSupportChat";

const VALID_STATUSES = ["pending", "reviewed", "dismissed"] as const;

const parsePagination = (query: any) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  return { page, limit, skip: (page - 1) * limit };
};

export const listChatReports = async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const filter: any = {};
    if (typeof status === "string" && (VALID_STATUSES as readonly string[]).includes(status)) {
      filter.status = status;
    }

    const [items, total] = await Promise.all([
      ChatReport.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("reportedBy", "name email role")
        .populate({ path: "messageId", select: "text senderId senderRole createdAt" })
        .populate({
          path: "conversationId",
          select: "type customerId professionalId supportAdminId supportTargetUserId",
          populate: [
            { path: "customerId", select: "name email" },
            { path: "professionalId", select: "name email" },
          ],
        })
        .lean(),
      ChatReport.countDocuments(filter),
    ]);

    return res.json({ success: true, data: { items, total, page, limit } });
  } catch (error: any) {
    console.error("List chat reports error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load chat reports" });
  }
};

export const getChatReport = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const report = await ChatReport.findById(id)
      .populate("reportedBy", "name email role")
      .populate({ path: "messageId", select: "text senderId senderRole createdAt" })
      .populate({
        path: "conversationId",
        select: "type customerId professionalId supportAdminId supportTargetUserId",
        populate: [
          { path: "customerId", select: "name email" },
          { path: "professionalId", select: "name email" },
        ],
      })
      .lean();

    if (!report) {
      return res.status(404).json({ success: false, msg: "Report not found" });
    }

    let surroundingMessages: any[] = [];
    const reportedMessageId = (report as any).messageId?._id;
    const conversationId = (report as any).conversationId?._id;
    if (reportedMessageId && conversationId) {
      const before = await ChatMessage.find({
        conversationId,
        _id: { $lt: reportedMessageId },
      })
        .sort({ _id: -1 })
        .limit(10)
        .populate("senderId", "name email")
        .lean();
      const after = await ChatMessage.find({
        conversationId,
        _id: { $gt: reportedMessageId },
      })
        .sort({ _id: 1 })
        .limit(10)
        .populate("senderId", "name email")
        .lean();
      const reported = await ChatMessage.findById(reportedMessageId)
        .populate("senderId", "name email")
        .lean();
      surroundingMessages = [
        ...before.reverse(),
        ...(reported ? [reported] : []),
        ...after,
      ];
    }

    return res.json({ success: true, data: { report, surroundingMessages } });
  } catch (error: any) {
    console.error("Get chat report error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load chat report" });
  }
};

export const resolveChatReport = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { id } = params(req.params);
    const { action, notes } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    if (!["warn", "ban", "dismiss"].includes(action)) {
      return res.status(400).json({ success: false, msg: "action must be warn, ban, or dismiss" });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const report = await ChatReport.findById(id).populate("messageId").session(session);
      if (!report) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, msg: "Report not found" });
      }
      if (report.status !== "pending") {
        await session.abortTransaction();
        return res.status(409).json({ success: false, msg: `Report is already ${report.status}` });
      }

      const messageDoc: any = report.messageId;
      if (!messageDoc) {
        await session.abortTransaction();
        return res.status(409).json({ success: false, msg: "Reported message not found" });
      }
      const reportedSenderId = messageDoc.senderId?.toString();

      if (action === "warn") {
        const warnText = `⚠️ Admin warning: this conversation is being reviewed for reported content.${notes ? ` Note: ${notes}` : ""}`;
        const [createdMessage] = await ChatMessage.create(
          [{
            conversationId: report.conversationId,
            senderId: adminObjectId,
            senderRole: "admin",
            text: warnText,
            messageType: "text",
            readBy: [{ userId: adminObjectId, readAt: new Date() }],
          }],
          { session }
        );
        await Conversation.findByIdAndUpdate(
          report.conversationId,
          {
            $set: {
              lastMessageAt: createdMessage?.createdAt || new Date(),
              lastMessagePreview: warnText.slice(0, 200),
              lastMessageSenderId: adminObjectId,
            },
          },
          { session }
        );
        report.status = "reviewed";
      } else if (action === "ban") {
        if (!reportedSenderId || !mongoose.Types.ObjectId.isValid(reportedSenderId)) {
          await session.abortTransaction();
          return res.status(400).json({
            success: false,
            msg: "Cannot ban: reported message has no valid sender",
          });
        }
        const result = await User.updateOne(
          { _id: reportedSenderId, role: { $in: ["customer", "professional"] } },
          {
            $set: {
              accountStatus: "suspended",
              suspensionReason: typeof notes === "string" && notes.trim()
                ? `Banned by admin: ${notes.trim()}`
                : "Banned by admin (chat moderation)",
            },
          },
          { session }
        );
        if (result.matchedCount === 0) {
          await session.abortTransaction();
          return res.status(409).json({
            success: false,
            msg: "Cannot ban this user (admin/system accounts cannot be suspended via chat moderation)",
          });
        }
        report.status = "reviewed";
      } else {
        report.status = "dismissed";
      }

      await report.save({ session });
      await session.commitTransaction();
      return res.json({ success: true, data: { report } });
    } catch (innerErr: any) {
      try { await session.abortTransaction(); } catch {}
      throw innerErr;
    } finally {
      session.endSession();
    }
  } catch (error: any) {
    console.error("Resolve chat report error:", error);
    return res.status(500).json({ success: false, msg: "Failed to resolve report" });
  }
};

export const adminGetConversation = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const conversation = await Conversation.findById(id)
      .populate("customerId", "name email phone username")
      .populate("professionalId", "name email phone username professionalLevel")
      .populate("supportAdminId", "name email")
      .populate("supportTargetUserId", "name email phone username role professionalLevel")
      .lean();
    if (!conversation) {
      return res.status(404).json({ success: false, msg: "Conversation not found" });
    }
    return res.json({ success: true, data: conversation });
  } catch (error: any) {
    console.error("Admin get conversation error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load conversation" });
  }
};

export const adminGetConversationMessages = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    const { page, limit, skip } = parsePagination(req.query);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const [messages, total] = await Promise.all([
      ChatMessage.find({ conversationId: id })
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .populate("senderId", "name email")
        .lean(),
      ChatMessage.countDocuments({ conversationId: id }),
    ]);
    return res.json({ success: true, data: { items: messages.reverse(), total, page, limit } });
  } catch (error: any) {
    console.error("Admin get messages error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load messages" });
  }
};

export const adminStartSupportChat = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { targetUserId, initialMessage } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res.status(400).json({ success: false, msg: "Invalid targetUserId" });
    }
    if (adminId === String(targetUserId)) {
      return res.status(400).json({ success: false, msg: "Cannot start a support chat with yourself" });
    }
    if (typeof initialMessage !== "string" || !initialMessage.trim() || initialMessage.length > 2000) {
      return res.status(400).json({ success: false, msg: "initialMessage is required (max 2000 chars)" });
    }

    const targetUser = await User.findById(targetUserId).select("_id role name email").lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "Target user not found" });
    }
    if (targetUser.role !== "customer" && targetUser.role !== "professional") {
      return res.status(400).json({
        success: false,
        msg: "Support chats are only available for customers or professionals",
      });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const targetObjectId = new mongoose.Types.ObjectId(targetUserId);

    // Shared inbox: reuse any existing support thread for this user (not per-admin).
    let conversation = await Conversation.findOne({
      type: "support",
      supportTargetUserId: targetObjectId,
    }).sort({ status: 1, lastMessageAt: -1 });
    if (!conversation) {
      try {
        conversation = await Conversation.create({
          type: "support",
          supportAdminId: adminObjectId,
          supportTargetUserId: targetObjectId,
          initiatedBy: adminObjectId,
          status: "active",
        } as any);
      } catch (err: any) {
        if (err?.code === 11000) {
          conversation = await Conversation.findOne({
            type: "support",
            supportTargetUserId: targetObjectId,
          }).sort({ status: 1, lastMessageAt: -1 });
        } else {
          throw err;
        }
      }
      if (!conversation) {
        return res.status(500).json({ success: false, msg: "Failed to create or load support conversation" });
      }
    }

    if (conversation.status !== "active") {
      conversation.status = "active";
    }
    // Claim / reassign so the shared thread shows a current assignee.
    conversation.supportAdminId = adminObjectId as any;
    await conversation.save();

    const message = await ChatMessage.create({
      conversationId: conversation._id,
      senderId: adminObjectId,
      senderRole: "admin",
      text: initialMessage.trim(),
      messageType: "text",
      readBy: [{ userId: adminObjectId, readAt: new Date() }],
    });

    await Conversation.findByIdAndUpdate(conversation._id, {
      $set: {
        lastMessageAt: new Date(),
        lastMessagePreview: initialMessage.trim().slice(0, 200),
        lastMessageSenderId: adminObjectId,
      },
      $inc: { customerUnreadCount: 1 },
      $unset: { unreadChatReminderLastSentAt: '' },
    });

    return res.status(201).json({
      success: true,
      data: { conversationId: conversation._id, messageId: message._id },
    });
  } catch (error: any) {
    console.error("Admin start support chat error:", error);
    return res.status(500).json({ success: false, msg: "Failed to start support chat" });
  }
};

export const adminReplySupportChat = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { id } = params(req.params);
    const { text } = req.body || {};
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid conversation id" });
    }
    if (typeof text !== "string" || !text.trim() || text.length > 2000) {
      return res.status(400).json({ success: false, msg: "text is required (max 2000 chars)" });
    }

    const conversation = await Conversation.findById(id);
    if (!conversation || conversation.type !== "support") {
      return res.status(404).json({ success: false, msg: "Support conversation not found" });
    }
    if (conversation.status !== "active") {
      return res.status(409).json({ success: false, msg: "This support conversation is closed" });
    }

    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const preview = text.trim().slice(0, 200);

    const session = await mongoose.startSession();
    try {
      let messageId: mongoose.Types.ObjectId | null = null;

      await session.withTransaction(async () => {
        const [message] = await ChatMessage.create(
          [
            {
              conversationId: conversation._id,
              senderId: adminObjectId,
              senderRole: "admin",
              text: text.trim(),
              messageType: "text",
              readBy: [{ userId: adminObjectId, readAt: new Date() }],
            },
          ],
          { session }
        );

        const updated = await Conversation.findOneAndUpdate(
          { _id: conversation._id, type: "support", status: "active" },
          {
            $set: {
              supportAdminId: adminObjectId,
              lastMessageAt: new Date(),
              lastMessagePreview: preview,
              lastMessageSenderId: adminObjectId,
            },
            $inc: { customerUnreadCount: 1 },
            $unset: { unreadChatReminderLastSentAt: "" },
          },
          { session, new: true }
        );
        if (!updated) {
          throw new Error("SUPPORT_CHAT_CLOSED");
        }
        messageId = message._id as mongoose.Types.ObjectId;
      });

      if (!messageId) {
        return res.status(500).json({ success: false, msg: "Failed to send message" });
      }
      return res.status(201).json({ success: true, data: { messageId } });
    } catch (innerErr: any) {
      if (innerErr?.message === "SUPPORT_CHAT_CLOSED") {
        return res.status(409).json({ success: false, msg: "This support conversation is closed" });
      }
      throw innerErr;
    } finally {
      session.endSession();
    }
  } catch (error: any) {
    console.error("Admin reply support chat error:", error);
    return res.status(500).json({ success: false, msg: "Failed to send message" });
  }
};

export const adminCloseSupportChat = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    const { id } = params(req.params);
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid conversation id" });
    }
    const conversation = await Conversation.findById(id);
    if (!conversation || conversation.type !== "support") {
      return res.status(404).json({ success: false, msg: "Support conversation not found" });
    }
    if (conversation.status === "archived") {
      return res.json({ success: true, data: { conversationId: conversation._id, status: "archived" } });
    }

    const closedAt = new Date();
    const closeText = formatChatClosedMessage(closedAt);
    const adminObjectId = new mongoose.Types.ObjectId(adminId);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const [message] = await ChatMessage.create(
          [
            {
              conversationId: conversation._id,
              senderId: adminObjectId,
              senderRole: "system",
              text: closeText,
              messageType: "text",
              readBy: [{ userId: adminObjectId, readAt: closedAt }],
            },
          ],
          { session },
        );
        const updated = await Conversation.findOneAndUpdate(
          { _id: conversation._id, type: "support", status: "active" },
          {
            $set: {
              status: "archived",
              lastMessageAt: message?.createdAt || closedAt,
              lastMessagePreview: closeText.slice(0, 200),
              lastMessageSenderId: adminObjectId,
            },
          },
          { session, new: true },
        );
        if (!updated) {
          throw new Error("SUPPORT_CHAT_ALREADY_CLOSED");
        }
      });
    } catch (innerErr: any) {
      if (innerErr?.message === "SUPPORT_CHAT_ALREADY_CLOSED") {
        return res.json({ success: true, data: { conversationId: conversation._id, status: "archived" } });
      }
      throw innerErr;
    } finally {
      session.endSession();
    }

    return res.json({ success: true, data: { conversationId: conversation._id, status: "archived" } });
  } catch (error: any) {
    console.error("Admin close support chat error:", error);
    return res.status(500).json({ success: false, msg: "Failed to close support chat" });
  }
};

export const adminGetConversationParticipant = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: "Invalid conversation id" });
    }

    const conversation = await Conversation.findById(id)
      .select("type supportTargetUserId professionalId customerId")
      .lean();
    if (!conversation) {
      return res.status(404).json({ success: false, msg: "Conversation not found" });
    }

    const targetId =
      conversation.type === "support"
        ? conversation.supportTargetUserId
        : conversation.professionalId;
    if (!targetId) {
      return res.status(404).json({ success: false, msg: "No participant found for this conversation" });
    }

    const user = await User.findById(targetId)
      .select("name email phone username role professionalLevel")
      .lean();
    if (!user) {
      return res.status(404).json({ success: false, msg: "Participant not found" });
    }

    const bookingMatch =
      user.role === "professional" ? { professional: user._id } : { customer: user._id };

    const [agg, projectCount] = await Promise.all([
      Booking.aggregate([
        { $match: bookingMatch },
        {
          $group: {
            _id: null,
            bookingCount: { $sum: 1 },
            completedCount: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            quotedCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ifNull: ["$quote.submittedAt", false] },
                      {
                        $gt: [
                          {
                            $size: {
                              $cond: [
                                { $isArray: "$quoteVersions" },
                                "$quoteVersions",
                                [],
                              ],
                            },
                          },
                          0,
                        ],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            disputeCount: { $sum: { $cond: [{ $ifNull: ["$dispute.raisedAt", false] }, 1, 0] } },
            refundCount: {
              $sum: {
                $cond: [{ $in: ["$payment.status", ["refunded", "partially_refunded"]] }, 1, 0],
              },
            },
            reviewCount: { $sum: { $cond: [{ $ifNull: ["$customerReview.reviewedAt", false] }, 1, 0] } },
            avgRating: {
              $avg: {
                $cond: [
                  { $ifNull: ["$customerReview.reviewedAt", false] },
                  {
                    $avg: [
                      { $ifNull: ["$customerReview.communicationLevel", null] },
                      { $ifNull: ["$customerReview.valueOfDelivery", null] },
                      { $ifNull: ["$customerReview.qualityOfService", null] },
                    ],
                  },
                  null,
                ],
              },
            },
            grossEur: {
              $sum: {
                $cond: [
                  { $eq: ["$status", "completed"] },
                  { $ifNull: ["$payment.totalWithVat", { $ifNull: ["$payment.amount", 0] }] },
                  0,
                ],
              },
            },
          },
        },
      ]),
      user.role === "professional"
        ? Project.countDocuments({ professionalId: user._id })
        : Promise.resolve(0),
    ]);

    const row = agg[0] || {};
    return res.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          name: user.name || null,
          email: user.email || null,
          phone: user.phone || null,
          username: user.username || null,
          role: user.role,
        },
        kpis: buildSupportParticipantKpis({
          professionalLevel: user.professionalLevel,
          reviewCount: Number(row.reviewCount) || 0,
          avgRating: typeof row.avgRating === "number" ? row.avgRating : null,
          projectCount,
          bookingCount: Number(row.bookingCount) || 0,
          completedCount: Number(row.completedCount) || 0,
          quotedCount: Number(row.quotedCount) || 0,
          disputeCount: Number(row.disputeCount) || 0,
          grossEur: Number(row.grossEur) || 0,
          refundCount: Number(row.refundCount) || 0,
        }),
      },
    });
  } catch (error: any) {
    console.error("Admin get conversation participant error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load participant info" });
  }
};

export const adminGetBookingConversation = async (req: Request, res: Response) => {
  try {
    const { bookingId } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking id" });
    }
    const booking = await Booking.findById(bookingId).select("customer professional").lean();
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }
    if (!booking.customer || !booking.professional) {
      return res.status(404).json({ success: false, msg: "Booking has no customer-professional conversation" });
    }
    const conversation = await Conversation.findOne({
      type: "direct",
      customerId: booking.customer,
      professionalId: booking.professional,
    })
      .select("_id")
      .lean();
    if (!conversation) {
      return res.status(404).json({ success: false, msg: "No conversation found between customer and professional" });
    }
    return res.json({ success: true, data: { conversationId: conversation._id } });
  } catch (error: any) {
    console.error("Admin get booking conversation error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load booking conversation" });
  }
};

export const adminListSupportConversations = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    const { page, limit, skip } = parsePagination(req.query);
    const assigneeRaw = typeof req.query.assigneeId === "string" ? req.query.assigneeId.trim() : "";
    const mineOnly = String(req.query.mine || "").toLowerCase() === "true" || req.query.mine === "1";
    const search = normalizeInboxSearch(req.query.q);

    const filter: Record<string, unknown> = {
      type: "support",
      status: "active",
    };
    if (mineOnly) {
      filter.supportAdminId = new mongoose.Types.ObjectId(adminId);
    } else if (assigneeRaw && mongoose.Types.ObjectId.isValid(assigneeRaw)) {
      filter.supportAdminId = new mongoose.Types.ObjectId(assigneeRaw);
    }
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      const [facet] = await Conversation.aggregate([
        { $match: filter },
        {
          $lookup: {
            from: "users",
            localField: "supportTargetUserId",
            foreignField: "_id",
            as: "supportTargetUserId",
          },
        },
        { $unwind: { path: "$supportTargetUserId", preserveNullAndEmptyArrays: false } },
        {
          $match: {
            $or: [
              { "supportTargetUserId.name": rx },
              { "supportTargetUserId.email": rx },
              { "supportTargetUserId.username": rx },
              { "supportTargetUserId.phone": rx },
            ],
          },
        },
        { $sort: { lastMessageAt: -1 } },
        {
          $facet: {
            items: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "users",
                  localField: "supportAdminId",
                  foreignField: "_id",
                  as: "supportAdminId",
                },
              },
              { $unwind: { path: "$supportAdminId", preserveNullAndEmptyArrays: true } },
              {
                $project: {
                  _id: 1,
                  lastMessagePreview: 1,
                  lastMessageAt: 1,
                  lastMessageSenderId: 1,
                  supportAdminId: {
                    _id: "$supportAdminId._id",
                    name: "$supportAdminId.name",
                    email: "$supportAdminId.email",
                  },
                  supportTargetUserId: {
                    _id: "$supportTargetUserId._id",
                    name: "$supportTargetUserId.name",
                    email: "$supportTargetUserId.email",
                    username: "$supportTargetUserId.username",
                  },
                },
              },
            ],
            total: [{ $count: "count" }],
          },
        },
      ]);
      const conversations = Array.isArray(facet?.items) ? facet.items : [];
      const total = Number(facet?.total?.[0]?.count) || 0;
      const items = conversations.map((c: any) => {
        const targetId = c.supportTargetUserId?._id?.toString();
        const senderId = c.lastMessageSenderId?.toString();
        return {
          _id: c._id,
          supportAdminId: c.supportAdminId || null,
          supportTargetUserId: c.supportTargetUserId,
          lastMessagePreview: c.lastMessagePreview || "",
          lastMessageAt: c.lastMessageAt || null,
          awaitingReply: Boolean(targetId && senderId && targetId === senderId),
        };
      });
      return res.json({ success: true, data: { items, total, page, limit } });
    }

    const [conversations, total] = await Promise.all([
      Conversation.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("supportTargetUserId", "name email username")
        .populate("supportAdminId", "name email")
        .select("_id supportAdminId supportTargetUserId lastMessagePreview lastMessageAt lastMessageSenderId")
        .lean(),
      Conversation.countDocuments(filter),
    ]);

    const items = conversations.map((c: any) => {
      const targetId = c.supportTargetUserId?._id?.toString();
      const senderId = c.lastMessageSenderId?.toString();
      return {
        _id: c._id,
        supportAdminId: c.supportAdminId || null,
        supportTargetUserId: c.supportTargetUserId,
        lastMessagePreview: c.lastMessagePreview || "",
        lastMessageAt: c.lastMessageAt || null,
        awaitingReply: Boolean(targetId && senderId && targetId === senderId),
      };
    });

    return res.json({ success: true, data: { items, total, page, limit } });
  } catch (error: any) {
    console.error("Admin list support conversations error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load support conversations" });
  }
};

export const adminGetSupportUnreadCount = async (req: Request, res: Response) => {
  try {
    const adminIdRaw = (req as any).admin?._id ?? (req as any).user?._id;
    const adminId = adminIdRaw?.toString();
    if (!adminId || !mongoose.Types.ObjectId.isValid(adminId)) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    // Shared inbox: count all support threads awaiting an admin reply.
    const count = await Conversation.countDocuments({
      type: "support",
      status: "active",
      lastMessageSenderId: { $ne: null },
      $expr: { $eq: ["$lastMessageSenderId", "$supportTargetUserId"] },
    });
    return res.json({ success: true, data: { count } });
  } catch (error: any) {
    console.error("Admin get support unread count error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load support unread count" });
  }
};
