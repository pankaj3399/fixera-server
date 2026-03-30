import { Request, Response } from "express";
import mongoose from "mongoose";
import Booking from "../../models/booking";
import Conversation from "../../models/conversation";
import ChatMessage from "../../models/chatMessage";
import ChatReport from "../../models/chatReport";
import User from "../../models/user";
import { generateFileName, uploadToS3, validateImageFile, validateFile, validateVideoFile, parseS3KeyFromUrl, getPresignedUrl } from "../../utils/s3Upload";
import type { IChatAttachment } from "../../models/chatMessage";

const toObjectId = (value: string) =>
  mongoose.Types.ObjectId.createFromHexString(value);

const getRequestUserId = (req: Request): string | null => {
  const userIdRaw = req.user?._id;
  if (!userIdRaw) return null;
  return typeof userIdRaw === "string" ? userIdRaw : userIdRaw.toString();
};

const getIdString = (value: unknown): string => {
  if (!value) return "";
  if (typeof value === "string") return value;

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }

  if (typeof value === "object" && value !== null && "_id" in value) {
    return getIdString((value as { _id?: unknown })._id);
  }

  if (typeof (value as { toString?: () => string }).toString === "function") {
    return (value as { toString: () => string }).toString();
  }

  return String(value);
};

const isConversationParticipant = (conversation: any, userId: string) => {
  const customerId = getIdString(conversation.customerId);
  const professionalId = getIdString(conversation.professionalId);
  return customerId === userId || professionalId === userId;
};

const buildMessagePreview = (text: string, images: string[], attachments?: IChatAttachment[]) => {
  if (text.trim()) {
    return text.trim().slice(0, 200);
  }

  const atts = attachments || [];
  const totalMedia = images.length + atts.length;

  if (totalMedia === 0) {
    return "";
  }

  if (images.length > 0 && atts.length === 0) {
    return images.length === 1 ? "[Image]" : `[${images.length} images]`;
  }

  if (atts.length === 1 && images.length === 0) {
    const att = atts[0];
    if (att.fileType === "video") return "[Video]";
    if (att.fileType === "document") return `[${att.fileName || "PDF"}]`;
    return "[Image]";
  }

  return `[${totalMedia} attachments]`;
};

const ALLOWED_S3_HOSTNAME = /^[\w-]+\.s3[\w.-]*\.amazonaws\.com$/;

const isValidS3ImageUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_S3_HOSTNAME.test(parsed.hostname);
  } catch {
    return false;
  }
};

export const createOrGetConversation = async (
  req: Request,
  res: Response,
) => {
  const userId = getRequestUserId(req);
  const userRole = req.user?.role;
  const { professionalId } = req.body as {
    professionalId?: string;
  };

  if (!userId) {
    return res.status(401).json({ success: false, msg: "Authentication required" });
  }

  if (userRole !== "customer") {
    return res.status(403).json({
      success: false,
      msg: "Only customers can start new conversations",
    });
  }

  if (!professionalId || !mongoose.Types.ObjectId.isValid(professionalId)) {
    return res.status(400).json({ success: false, msg: "Valid professionalId is required" });
  }

  const professional = await User.findById(professionalId).select("role professionalStatus");
  if (!professional || professional.role !== "professional") {
    return res.status(404).json({ success: false, msg: "Professional not found" });
  }

  if (professional.professionalStatus !== "approved") {
    return res.status(400).json({
      success: false,
      msg: "Professional must be approved before chat can start",
    });
  }

  // One conversation per customer-professional pair
  const pairQuery = {
    customerId: toObjectId(userId),
    professionalId: toObjectId(professionalId),
  };

  const populateFields = [
    { path: "customerId", select: "name email businessInfo profileImage" },
    { path: "professionalId", select: "name email businessInfo profileImage" },
  ];

  let conversation = await Conversation.findOne(pairQuery)
    .populate("customerId", "name email businessInfo profileImage")
    .populate("professionalId", "name email businessInfo profileImage");

  if (conversation) {
    return res.status(200).json({ success: true, conversation });
  }

  try {
    conversation = await Conversation.create({
      customerId: toObjectId(userId),
      professionalId: toObjectId(professionalId),
      initiatedBy: toObjectId(userId),
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      conversation = await Conversation.findOne(pairQuery);
      if (!conversation) throw error;
    } else {
      throw error;
    }
  }

  await conversation.populate(populateFields);

  return res.status(201).json({ success: true, conversation });
};

export const listMyConversations = async (
  req: Request,
  res: Response,
) => {
  const userId = getRequestUserId(req);
  const userRole = req.user?.role;

  if (!userId) {
    return res.status(401).json({ success: false, msg: "Authentication required" });
  }

  if (userRole !== "customer" && userRole !== "professional") {
    return res.status(403).json({
      success: false,
      msg: "Only customers and professionals can access conversations",
    });
  }

  const pageRaw = Number.parseInt(String(req.query.page ?? "1"), 10);
  const limitRaw = Number.parseInt(String(req.query.limit ?? "20"), 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const skip = (page - 1) * limit;
  const filter = typeof req.query.filter === "string" ? req.query.filter : "all";

  const userOid = toObjectId(userId);
  const baseQuery: Record<string, any> =
    userRole === "customer"
      ? { customerId: userOid }
      : { professionalId: userOid };

  const unreadField = userRole === "customer" ? "customerUnreadCount" : "professionalUnreadCount";

  if (filter === "archived") {
    baseQuery.archivedBy = userOid;
  } else if (filter === "starred") {
    baseQuery.starredBy = userOid;
    baseQuery.archivedBy = { $ne: userOid };
  } else if (filter === "unread") {
    baseQuery[unreadField] = { $gt: 0 };
    baseQuery.archivedBy = { $ne: userOid };
  } else if (filter.startsWith("label:")) {
    const labelName = filter.slice(6);
    baseQuery.labels = { $elemMatch: { userId: userOid, label: labelName } };
    baseQuery.archivedBy = { $ne: userOid };
  } else {
    // "all" — exclude archived
    baseQuery.archivedBy = { $ne: userOid };
  }

  const [conversations, total] = await Promise.all([
    Conversation.find(baseQuery)
      .populate("customerId", "name email businessInfo profileImage")
      .populate("professionalId", "name email businessInfo profileImage")
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit),
    Conversation.countDocuments(baseQuery),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      conversations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
};

export const getConversationMessages = async (
  req: Request,
  res: Response,
) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;
  const before = typeof req.query.before === "string" ? req.query.before : undefined;

  if (!userId) {
    return res.status(401).json({ success: false, msg: "Authentication required" });
  }

  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  if (before && !mongoose.Types.ObjectId.isValid(before)) {
    return res.status(400).json({ success: false, msg: "Invalid before cursor" });
  }

  const limitRaw = Number.parseInt(String(req.query.limit ?? "30"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 30;

  const conversation = await Conversation.findById(conversationId)
    .populate("customerId", "name email businessInfo profileImage")
    .populate("professionalId", "name email businessInfo profileImage");

  if (!conversation) {
    return res.status(404).json({ success: false, msg: "Conversation not found" });
  }

  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed to access this conversation" });
  }

  const messageQuery: Record<string, any> = {
    conversationId: toObjectId(conversationId),
  };

  if (before) {
    messageQuery._id = { $lt: toObjectId(before) };
  }

  const messagesDesc = await ChatMessage.find(messageQuery)
    .populate("senderId", "name email businessInfo profileImage role")
    .populate({
      path: "replyTo",
      select: "text senderId images createdAt",
      populate: { path: "senderId", select: "name businessInfo" },
    })
    .sort({ _id: -1 })
    .limit(limit);

  const messagesRaw = [...messagesDesc].reverse();
  const hasMore = messagesDesc.length === limit;
  const nextCursor = hasMore && messagesRaw.length > 0 ? String(messagesRaw[0]._id) : null;

  // Replace private S3 URLs with presigned URLs so the browser can load them.
  // Only sign keys that belong to this conversation (chat/{conversationId}/…).
  const expectedKeyPrefix = `chat/${conversationId}/`;
  const signS3Url = async (url: string): Promise<string> => {
    const key = parseS3KeyFromUrl(url);
    if (!key || !key.startsWith(expectedKeyPrefix)) return url;
    try {
      return await getPresignedUrl(key, 3600);
    } catch {
      return url;
    }
  };

  const messages = await Promise.all(
    messagesRaw.map(async (msg) => {
      const msgObj = msg.toObject ? msg.toObject() : msg;

      const hasImages = Array.isArray(msgObj.images) && msgObj.images.length > 0;
      const hasAttachments = Array.isArray(msgObj.attachments) && msgObj.attachments.length > 0;

      if (!hasImages && !hasAttachments) return msgObj;

      const signedImages = hasImages
        ? await Promise.all(msgObj.images.map(signS3Url))
        : msgObj.images;

      const signedAttachments = hasAttachments
        ? await Promise.all(
            msgObj.attachments.map(async (att: any) => ({
              ...att,
              url: await signS3Url(att.url),
            }))
          )
        : msgObj.attachments;

      return { ...msgObj, images: signedImages, attachments: signedAttachments };
    })
  );

  return res.status(200).json({
    success: true,
    data: {
      conversation,
      messages,
      pagination: {
        limit,
        hasMore,
        nextCursor,
      },
    },
  });
};

export const sendMessage = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const userRole = req.user?.role;
  const { conversationId } = req.params;
  const rawText = typeof req.body.text === "string" ? req.body.text : "";
  const text = rawText.trim();
  const images = Array.isArray(req.body.images)
    ? req.body.images.filter(
        (item: unknown): item is string =>
          typeof item === "string" && item.trim().length > 0 && isValidS3ImageUrl(item)
      )
    : [];

  if (Array.isArray(req.body.attachments) && req.body.attachments.length > 5) {
    return res.status(400).json({ success: false, msg: "A message can include at most 5 attachments" });
  }

  const attachments: IChatAttachment[] = Array.isArray(req.body.attachments)
    ? req.body.attachments.filter((att: any) => {
        return (
          att &&
          typeof att.url === "string" &&
          isValidS3ImageUrl(att.url) &&
          typeof att.fileName === "string" &&
          ["image", "document", "video"].includes(att.fileType) &&
          typeof att.mimeType === "string"
        );
      })
    : [];

  if (!userId) {
    return res.status(401).json({ success: false, msg: "Authentication required" });
  }

  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  if (text.length === 0 && images.length === 0 && attachments.length === 0) {
    return res.status(400).json({
      success: false,
      msg: "Message must contain text or at least one image/attachment",
    });
  }

  if (text.length > 2000) {
    return res.status(400).json({ success: false, msg: "Message text exceeds 2000 characters" });
  }

  if (images.length > 5) {
    return res.status(400).json({ success: false, msg: "A message can include at most 5 images" });
  }

  if (userRole !== "customer" && userRole !== "professional") {
    return res.status(403).json({
      success: false,
      msg: "Only customers and professionals can send chat messages",
    });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    return res.status(404).json({ success: false, msg: "Conversation not found" });
  }

  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed to send messages to this conversation" });
  }

  const professionalId = getIdString(conversation.professionalId);
  const customerId = getIdString(conversation.customerId);
  let senderRole: "professional" | "customer";
  if (userId === professionalId) {
    senderRole = "professional";
  } else if (userId === customerId) {
    senderRole = "customer";
  } else {
    console.warn(`sendMessage: userId ${userId} does not match conversation participants (customer: ${customerId}, professional: ${professionalId}), falling back to userRole`);
    senderRole = userRole === "professional" ? "professional" : "customer";
  }

  const replyToRaw = typeof req.body.replyTo === "string" && mongoose.Types.ObjectId.isValid(req.body.replyTo)
    ? req.body.replyTo
    : undefined;

  let validatedReplyTo: string | undefined;
  if (replyToRaw) {
    const replyMsg = await ChatMessage.findById(replyToRaw).select("conversationId").lean();
    if (!replyMsg || replyMsg.conversationId.toString() !== conversationId) {
      return res.status(400).json({ success: false, msg: "Invalid replyTo message" });
    }
    validatedReplyTo = replyToRaw;
  }

  const message = await ChatMessage.create({
    conversationId: toObjectId(conversationId),
    senderId: toObjectId(userId),
    senderRole,
    text,
    images,
    attachments,
    readBy: [{ userId: toObjectId(userId), readAt: new Date() }],
    ...(validatedReplyTo ? { replyTo: toObjectId(validatedReplyTo) } : {}),
  });

  const preview = buildMessagePreview(text, images, attachments);
  const isCustomerSender = customerId === userId;

  const updateSet: Record<string, unknown> = {
    lastMessageAt: new Date(),
    lastMessagePreview: preview,
    lastMessageSenderId: toObjectId(userId),
  };
  const updateInc: Record<string, number> = {};

  if (isCustomerSender) {
    updateSet.customerUnreadCount = 0;
    updateInc.professionalUnreadCount = 1;
  } else {
    updateSet.professionalUnreadCount = 0;
    updateInc.customerUnreadCount = 1;
  }

  await Conversation.findByIdAndUpdate(conversation._id, {
    $set: updateSet,
    $inc: updateInc,
  });

  await message.populate("senderId", "name email businessInfo profileImage role");

  return res.status(201).json({
    success: true,
    message,
  });
};

export const markConversationRead = async (
  req: Request,
  res: Response,
) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, msg: "Authentication required" });
  }

  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    return res.status(404).json({ success: false, msg: "Conversation not found" });
  }

  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed to access this conversation" });
  }

  const isCustomer = conversation.customerId.toString() === userId;
  const fieldToReset = isCustomer ? "customerUnreadCount" : "professionalUnreadCount";
  await Conversation.findByIdAndUpdate(conversationId, {
    $set: { [fieldToReset]: 0 },
  });

  return res.status(200).json({ success: true, msg: "Conversation marked as read" });
};

const getFileType = (mimetype: string): "image" | "document" | "video" => {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  return "document";
};

class UploadError {
  constructor(public status: number, public msg: string) {}
}

const authorizeAndUploadChat = async (
  req: Request,
  file: Express.Multer.File,
  validator: (file: Express.Multer.File) => { valid: boolean; error?: string },
) => {
  const userId = getRequestUserId(req);
  const conversationId = typeof req.body.conversationId === "string" ? req.body.conversationId : undefined;

  if (!userId) {
    throw new UploadError(401, "Authentication required");
  }

  const validation = validator(file);
  if (!validation.valid) {
    throw new UploadError(400, validation.error || "Invalid file");
  }

  if (conversationId) {
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      throw new UploadError(400, "Invalid conversationId");
    }

    const conversation = await Conversation.findById(conversationId).select("customerId professionalId");
    if (!conversation) {
      throw new UploadError(404, "Conversation not found");
    }

    if (!isConversationParticipant(conversation, userId)) {
      throw new UploadError(403, "Not allowed to upload for this conversation");
    }
  }

  const folder = conversationId || "temp";
  const fileName = generateFileName(file.originalname, userId, `chat/${folder}`);
  return await uploadToS3(file, fileName);
};

export const uploadChatImage = async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ success: false, msg: "No image uploaded" });
  }

  try {
    const result = await authorizeAndUploadChat(req, req.file, validateImageFile);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof UploadError) {
      return res.status(error.status).json({ success: false, msg: error.msg });
    }
    throw error;
  }
};

export const uploadChatFile = async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ success: false, msg: "No file uploaded" });
  }

  const fileType = getFileType(req.file.mimetype);
  const validator = fileType === "image"
    ? validateImageFile
    : fileType === "video"
    ? validateVideoFile
    : validateFile;

  try {
    const result = await authorizeAndUploadChat(req, req.file, validator);
    return res.status(200).json({
      success: true,
      data: {
        ...result,
        fileName: req.file.originalname,
        fileType,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
      },
    });
  } catch (error) {
    if (error instanceof UploadError) {
      return res.status(error.status).json({ success: false, msg: error.msg });
    }
    throw error;
  }
};

export const getConversationInfo = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;

  if (!userId) {
    return res.status(401).json({ success: false, msg: "Authentication required" });
  }

  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  const conversation = await Conversation.findById(conversationId)
    .populate("customerId", "name email businessInfo profileImage createdAt")
    .populate("professionalId", "name email businessInfo profileImage createdAt");

  if (!conversation) {
    return res.status(404).json({ success: false, msg: "Conversation not found" });
  }

  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed to access this conversation" });
  }

  const customerId = getIdString(conversation.customerId);
  const professionalId = getIdString(conversation.professionalId);

  const [bookingStats, pendingBookings, professional] = await Promise.all([
    Booking.aggregate([
      {
        $match: {
          customer: toObjectId(customerId),
          professional: toObjectId(professionalId),
        },
      },
      {
        $group: {
          _id: null,
          totalBookings: { $sum: 1 },
          completedBookings: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          avgCommunication: {
            $avg: "$customerReview.communicationLevel",
          },
          avgValueOfDelivery: {
            $avg: "$customerReview.valueOfDelivery",
          },
          avgQualityOfService: {
            $avg: "$customerReview.qualityOfService",
          },
          avgProfessionalRating: {
            $avg: "$professionalReview.rating",
          },
        },
      },
    ]),
    Booking.find({
      customer: toObjectId(customerId),
      professional: toObjectId(professionalId),
      status: { $in: ["booked", "in_progress"] },
    })
      .select("_id bookingNumber rfqData.preferredStartDate quote.validUntil quote.estimatedDuration status createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
    User.findById(professionalId)
      .select("professionalLevel companyBlockedRanges companyBlockedDates blockedRanges blockedDates")
      .lean(),
  ]);

  const stats = bookingStats[0] || {
    totalBookings: 0,
    completedBookings: 0,
    avgCommunication: 0,
    avgValueOfDelivery: 0,
    avgQualityOfService: 0,
    avgProfessionalRating: 0,
  };

  const avgCom = stats.avgCommunication || 0;
  const avgVal = stats.avgValueOfDelivery || 0;
  const avgQual = stats.avgQualityOfService || 0;
  const hasCustomerRatings = avgCom > 0 || avgVal > 0 || avgQual > 0;
  const avgCustomerRating = hasCustomerRatings ? (avgCom + avgVal + avgQual) / 3 : 0;

  // Compute average response time (professional reply time to customer messages)
  // Uses a cursor to avoid materializing all messages in memory.
  let avgResponseTimeMs = 0;
  try {
    const cursor = ChatMessage.find(
      { conversationId: toObjectId(conversationId) },
      { senderRole: 1, createdAt: 1 }
    )
      .sort({ _id: 1 })
      .cursor();

    let prevRole: string | null = null;
    let prevTime: number = 0;
    let totalResponseMs = 0;
    let responseCount = 0;

    for await (const doc of cursor) {
      const role = doc.senderRole;
      const time = new Date(doc.createdAt).getTime();
      if (role === "professional" && prevRole === "customer") {
        const diff = time - prevTime;
        if (diff > 0) {
          totalResponseMs += diff;
          responseCount++;
        }
      }
      prevRole = role;
      prevTime = time;
    }

    if (responseCount > 0) {
      avgResponseTimeMs = totalResponseMs / responseCount;
    }
  } catch {
    // non-critical
  }

  // Check if professional is currently absent (company blocked ranges)
  const now = new Date();
  let absence: { from: string; to: string } | null = null;
  const allBlockedRanges = [
    ...(professional?.companyBlockedRanges || []),
    ...(professional?.blockedRanges || []),
  ];
  for (const range of allBlockedRanges) {
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (start <= now && now <= end) {
      absence = {
        from: start.toISOString(),
        to: end.toISOString(),
      };
      break;
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      conversation,
      stats: {
        totalBookings: stats.totalBookings,
        completedBookings: stats.completedBookings,
        avgCustomerRating: Math.round(avgCustomerRating * 10) / 10,
        avgCommunication: Math.round(avgCom * 10) / 10,
        avgValueOfDelivery: Math.round(avgVal * 10) / 10,
        avgQualityOfService: Math.round(avgQual * 10) / 10,
        avgProfessionalRating: Math.round((stats.avgProfessionalRating || 0) * 10) / 10,
        professionalLevel: professional?.professionalLevel || "New",
        avgResponseTimeMs: Math.round(avgResponseTimeMs),
        pendingBookings: pendingBookings.map((b: any) => ({
          bookingId: b._id?.toString?.() || null,
          bookingNumber: b.bookingNumber,
          status: b.status,
          preferredStartDate: b.rfqData?.preferredStartDate || null,
          estimatedDuration: b.quote?.estimatedDuration || null,
        })),
        absence,
      },
    },
  });
};

// --- Star / Archive / Label / Report / Search endpoints ---

export const toggleStar = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;

  if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });
  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return res.status(404).json({ success: false, msg: "Conversation not found" });
  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed" });
  }

  const userOid = toObjectId(userId);
  const isStarred = conversation.starredBy.some((id) => id.toString() === userId);

  if (isStarred) {
    await Conversation.findByIdAndUpdate(conversationId, { $pull: { starredBy: userOid } });
  } else {
    await Conversation.findByIdAndUpdate(conversationId, { $addToSet: { starredBy: userOid } });
  }

  return res.status(200).json({ success: true, starred: !isStarred });
};

export const toggleArchive = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;

  if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });
  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return res.status(404).json({ success: false, msg: "Conversation not found" });
  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed" });
  }

  const userOid = toObjectId(userId);
  const isArchived = conversation.archivedBy.some((id) => id.toString() === userId);

  if (isArchived) {
    await Conversation.findByIdAndUpdate(conversationId, { $pull: { archivedBy: userOid } });
  } else {
    await Conversation.findByIdAndUpdate(conversationId, { $addToSet: { archivedBy: userOid } });
  }

  return res.status(200).json({ success: true, archived: !isArchived });
};

export const addLabel = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;
  const { label, color } = req.body as { label?: string; color?: string };

  if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });
  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }
  if (!label || typeof label !== "string" || label.trim().length === 0 || label.trim().length > 30) {
    return res.status(400).json({ success: false, msg: "Label is required (max 30 chars)" });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return res.status(404).json({ success: false, msg: "Conversation not found" });
  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed" });
  }

  const userOid = toObjectId(userId);
  const trimmed = label.trim();
  const newLabelObj: Record<string, unknown> = { userId: userOid, label: trimmed };
  if (color) newLabelObj.color = color;

  // Atomic: filter out existing label with same name for this user, then append the new one
  await Conversation.findByIdAndUpdate(conversationId, [
    {
      $set: {
        labels: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ["$labels", []] },
                as: "l",
                cond: {
                  $not: {
                    $and: [
                      { $eq: ["$$l.userId", userOid] },
                      { $eq: ["$$l.label", trimmed] },
                    ],
                  },
                },
              },
            },
            [newLabelObj],
          ],
        },
      },
    },
  ]);

  return res.status(200).json({ success: true, msg: "Label added" });
};

export const removeLabel = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { conversationId, label } = req.params;

  if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });
  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return res.status(404).json({ success: false, msg: "Conversation not found" });
  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed" });
  }

  await Conversation.findByIdAndUpdate(conversationId, {
    $pull: { labels: { userId: toObjectId(userId), label: decodeURIComponent(label) } },
  });

  return res.status(200).json({ success: true, msg: "Label removed" });
};

export const reportMessage = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { messageId } = req.params;
  const { reason, description } = req.body as { reason?: string; description?: string };

  if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });
  if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
    return res.status(400).json({ success: false, msg: "Invalid messageId" });
  }

  const validReasons = ["spam", "harassment", "inappropriate", "scam", "other"];
  if (!reason || !validReasons.includes(reason)) {
    return res.status(400).json({ success: false, msg: "Valid reason is required" });
  }

  const message = await ChatMessage.findById(messageId);
  if (!message) return res.status(404).json({ success: false, msg: "Message not found" });

  const conversation = await Conversation.findById(message.conversationId);
  if (!conversation || !isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed" });
  }

  // Prevent self-reporting
  if (message.senderId.toString() === userId) {
    return res.status(400).json({ success: false, msg: "Cannot report your own message" });
  }

  try {
    await ChatReport.create({
      messageId: toObjectId(messageId),
      conversationId: message.conversationId,
      reportedBy: toObjectId(userId),
      reason: reason as any,
      description: description?.trim().slice(0, 500),
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, msg: "You already reported this message" });
    }
    throw error;
  }

  return res.status(201).json({ success: true, msg: "Report submitted" });
};

export const searchMessages = async (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const { conversationId } = req.params;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });
  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) {
    return res.status(400).json({ success: false, msg: "Invalid conversationId" });
  }
  if (!q || q.length < 2) {
    return res.status(400).json({ success: false, msg: "Search query must be at least 2 characters" });
  }

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return res.status(404).json({ success: false, msg: "Conversation not found" });
  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed" });
  }

  const results = await ChatMessage.find({
    conversationId: toObjectId(conversationId),
    $text: { $search: q },
  })
    .populate("senderId", "name businessInfo profileImage")
    .sort({ _id: -1 })
    .limit(50)
    .lean();

  return res.status(200).json({
    success: true,
    data: { results, total: results.length },
  });
};
