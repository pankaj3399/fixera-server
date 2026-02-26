import { Request, Response } from "express";
import mongoose from "mongoose";
import Booking from "../../models/booking";
import Conversation from "../../models/conversation";
import ChatMessage from "../../models/chatMessage";
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
  const { professionalId, bookingId } = req.body as {
    professionalId?: string;
    bookingId?: string;
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

  if (bookingId && !mongoose.Types.ObjectId.isValid(bookingId)) {
    return res.status(400).json({ success: false, msg: "Invalid bookingId" });
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

  if (bookingId) {
    const booking = await Booking.findById(bookingId).select("customer professional");
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const matchesCustomer = booking.customer?.toString() === userId;
    const matchesProfessional = booking.professional?.toString() === professionalId;

    if (!matchesCustomer || !matchesProfessional) {
      return res.status(403).json({
        success: false,
        msg: "Booking participants do not match this chat pair",
      });
    }
  }

  const pairQuery = bookingId
    ? {
        customerId: toObjectId(userId),
        professionalId: toObjectId(professionalId),
        bookingId: toObjectId(bookingId),
      }
    : {
        customerId: toObjectId(userId),
        professionalId: toObjectId(professionalId),
        $or: [{ bookingId: { $exists: false } }, { bookingId: null }],
      };

  const populateFields = [
    { path: "customerId", select: "name email businessInfo profileImage" },
    { path: "professionalId", select: "name email businessInfo profileImage" },
    { path: "bookingId", select: "bookingNumber status bookingType" },
  ];

  let conversation = await Conversation.findOne(pairQuery)
    .populate("customerId", "name email businessInfo profileImage")
    .populate("professionalId", "name email businessInfo profileImage")
    .populate("bookingId", "bookingNumber status bookingType");

  if (conversation) {
    return res.status(200).json({ success: true, conversation });
  }

  try {
    conversation = await Conversation.create({
      customerId: toObjectId(userId),
      professionalId: toObjectId(professionalId),
      bookingId: bookingId ? toObjectId(bookingId) : undefined,
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

  const query =
    userRole === "customer"
      ? { customerId: toObjectId(userId) }
      : { professionalId: toObjectId(userId) };

  const [conversations, total] = await Promise.all([
    Conversation.find(query)
      .populate("customerId", "name email businessInfo profileImage")
      .populate("professionalId", "name email businessInfo profileImage")
      .populate("bookingId", "bookingNumber status bookingType")
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit),
    Conversation.countDocuments(query),
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
    .populate("professionalId", "name email businessInfo profileImage")
    .populate("bookingId", "bookingNumber status bookingType");

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

  const message = await ChatMessage.create({
    conversationId: toObjectId(conversationId),
    senderId: toObjectId(userId),
    senderRole,
    text,
    images,
    attachments,
    readBy: [{ userId: toObjectId(userId), readAt: new Date() }],
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
    .populate("professionalId", "name email businessInfo profileImage createdAt")
    .populate("bookingId", "bookingNumber status bookingType");

  if (!conversation) {
    return res.status(404).json({ success: false, msg: "Conversation not found" });
  }

  if (!isConversationParticipant(conversation, userId)) {
    return res.status(403).json({ success: false, msg: "Not allowed to access this conversation" });
  }

  const customerId = getIdString(conversation.customerId);
  const professionalId = getIdString(conversation.professionalId);

  const bookingStats = await Booking.aggregate([
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
        avgCustomerRating: {
          $avg: "$customerReview.rating",
        },
        avgProfessionalRating: {
          $avg: "$professionalReview.rating",
        },
      },
    },
  ]);

  const stats = bookingStats[0] || {
    totalBookings: 0,
    completedBookings: 0,
    avgCustomerRating: 0,
    avgProfessionalRating: 0,
  };

  return res.status(200).json({
    success: true,
    data: {
      conversation,
      stats: {
        totalBookings: stats.totalBookings,
        completedBookings: stats.completedBookings,
        avgCustomerRating: Math.round((stats.avgCustomerRating || 0) * 10) / 10,
        avgProfessionalRating: Math.round((stats.avgProfessionalRating || 0) * 10) / 10,
      },
    },
  });
};
