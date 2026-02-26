import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  createOrGetConversation,
  listMyConversations,
  getConversationMessages,
  sendMessage,
  markConversationRead,
  uploadChatImage,
  uploadChatFile,
  getConversationInfo,
} from "../../handlers/Chat";
import { protect } from "../../middlewares/auth";
import { upload } from "../../utils/s3Upload";

const router = express.Router();

const userKeyGenerator = (req: express.Request) => {
  const userId = req.user?._id;
  return userId ? String(userId) : ipKeyGenerator(req.ip ?? "unknown");
};

const chatSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many messages, please try again later" },
});

const chatUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many uploads, please try again later" },
});

const chatReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKeyGenerator,
  message: { success: false, msg: "Too many requests, please try again later" },
});

router.use(protect);

router.post("/conversations", createOrGetConversation);
router.get("/conversations", listMyConversations);
router.get("/conversations/:conversationId/messages", getConversationMessages);
router.get("/conversations/:conversationId/info", chatReadLimiter, getConversationInfo);
router.post("/conversations/:conversationId/messages", chatSendLimiter, sendMessage);
router.patch("/conversations/:conversationId/read", markConversationRead);
router.post("/upload-image", chatUploadLimiter, upload.single("image"), uploadChatImage);
router.post("/upload-file", chatUploadLimiter, upload.single("file"), uploadChatFile);

export default router;
