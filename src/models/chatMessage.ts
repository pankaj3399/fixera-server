import { Schema, model, Document, Types } from "mongoose";

export interface IChatMessageReadReceipt {
  userId: Types.ObjectId;
  readAt: Date;
}

export interface IChatAttachment {
  url: string;
  fileName: string;
  fileType: "image" | "document" | "video";
  mimeType: string;
  fileSize?: number;
}

export interface IChatMessage extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderRole: "customer" | "professional";
  text?: string;
  images: string[];
  attachments: IChatAttachment[];
  readBy: IChatMessageReadReceipt[];
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderRole: {
      type: String,
      enum: ["customer", "professional"],
      required: true,
    },
    text: {
      type: String,
      required: false,
      trim: true,
      maxlength: 2000,
    },
    images: {
      type: [String],
      default: [],
      validate: {
        validator: (arr: string[]) => arr.length <= 5,
        message: "A message can include at most 5 images",
      },
    },
    attachments: {
      type: [
        {
          url: { type: String, required: true },
          fileName: { type: String, required: true },
          fileType: { type: String, enum: ["image", "document", "video"], required: true },
          mimeType: { type: String, required: true },
          fileSize: { type: Number },
        },
      ],
      default: [],
      validate: {
        validator: (arr: IChatAttachment[]) => arr.length <= 5,
        message: "A message can include at most 5 attachments",
      },
    },
    readBy: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        readAt: {
          type: Date,
          required: true,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

// Note: this validator uses document context (this.images) and only runs for
// document-level operations (create/save). Mongoose update operations
// (updateOne/findOneAndUpdate) do not invoke this with document context.
ChatMessageSchema.path("text").validate(function (value: string | undefined) {
  const hasText = typeof value === "string" && value.trim().length > 0;
  const hasImages = Array.isArray(this.images) && this.images.length > 0;
  const hasAttachments = Array.isArray(this.attachments) && this.attachments.length > 0;
  return hasText || hasImages || hasAttachments;
}, "Message must include text or at least one image/attachment");

ChatMessageSchema.index({ conversationId: 1, _id: -1 });

const ChatMessage = model<IChatMessage>("ChatMessage", ChatMessageSchema);

export default ChatMessage;
