import express from "express";
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

router.use(protect);

router.post("/conversations", createOrGetConversation);
router.get("/conversations", listMyConversations);
router.get("/conversations/:conversationId/messages", getConversationMessages);
router.post("/conversations/:conversationId/messages", sendMessage);
router.post("/conversations/:conversationId/read", markConversationRead);
router.post("/upload-image", upload.single("image"), uploadChatImage);

export default router;
