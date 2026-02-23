import { Schema, model, Document, Types } from "mongoose";

export interface IChatMessageReadReceipt {
  userId: Types.ObjectId;
  readAt: Date;
}

export interface IChatMessage extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderRole: "customer" | "professional";
  text?: string;
  images: string[];
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
      index: true,
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

ChatMessageSchema.path("text").validate(function (value: string | undefined) {
  const hasText = typeof value === "string" && value.trim().length > 0;
  const hasImages = Array.isArray(this.images) && this.images.length > 0;
  return hasText || hasImages;
}, "Message must include text or at least one image");

ChatMessageSchema.index({ conversationId: 1, _id: -1 });
ChatMessageSchema.index({ conversationId: 1, createdAt: -1 });

const ChatMessage = model<IChatMessage>("ChatMessage", ChatMessageSchema);

export default ChatMessage;
