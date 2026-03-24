import { Schema, model, Document, Types } from "mongoose";

export interface IChatReport extends Document {
  _id: Types.ObjectId;
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  reportedBy: Types.ObjectId;
  reason: "spam" | "harassment" | "inappropriate" | "scam" | "other";
  description?: string;
  status: "pending" | "reviewed" | "dismissed";
  createdAt: Date;
  updatedAt: Date;
}

const ChatReportSchema = new Schema<IChatReport>(
  {
    messageId: {
      type: Schema.Types.ObjectId,
      ref: "ChatMessage",
      required: true,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    reportedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      enum: ["spam", "harassment", "inappropriate", "scam", "other"],
      required: true,
    },
    description: {
      type: String,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ["pending", "reviewed", "dismissed"],
      default: "pending",
      required: true,
    },
  },
  { timestamps: true }
);

ChatReportSchema.index({ messageId: 1, reportedBy: 1 }, { unique: true });
ChatReportSchema.index({ status: 1 });

const ChatReport = model<IChatReport>("ChatReport", ChatReportSchema);

export default ChatReport;
