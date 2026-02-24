import express from "express";
import rateLimit from "express-rate-limit";
import {
  createOrGetConversation,
  listMyConversations,
  getConversationMessages,
  sendMessage,
  markConversationRead,
  uploadChatImage,
} from "../../handlers/Chat";
import { protect } from "../../middlewares/auth";
import { upload } from "../../utils/s3Upload";

const router = express.Router();

const chatSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.user?._id;
    return userId ? String(userId) : req.ip ?? "unknown";
  },
  message: { success: false, msg: "Too many messages, please try again later" },
});

const chatUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.user?._id;
    return userId ? String(userId) : req.ip ?? "unknown";
  },
  message: { success: false, msg: "Too many uploads, please try again later" },
});

router.use(protect);

router.post("/conversations", createOrGetConversation);
router.get("/conversations", listMyConversations);
router.get("/conversations/:conversationId/messages", getConversationMessages);
router.post("/conversations/:conversationId/messages", chatSendLimiter, sendMessage);
router.patch("/conversations/:conversationId/read", markConversationRead);
router.post("/upload-image", chatUploadLimiter, upload.single("image"), uploadChatImage);

export default router;
