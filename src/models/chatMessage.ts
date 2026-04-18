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

export type ChatMessageType = "text" | "review_notification" | "warranty_notification" | "quotation_notification";

export interface IReviewNotificationMeta {
  bookingId: string;
  avgRating: number;
  communicationLevel: number;
  valueOfDelivery: number;
  qualityOfService: number;
  comment?: string;
  customerName: string;
}

export interface IWarrantyNotificationMeta {
  claimId: string;
  claimNumber: string;
  bookingId?: string;
  status?: string;
}

export interface IQuotationNotificationMeta {
  bookingId: string;
  quotationNumber: string;
  version: number;
  scope: string;
  totalAmount: number;
  currency: string;
  validUntil: string;
  status: 'quoted' | 'quote_accepted' | 'quote_rejected';
}

export interface IChatMessage extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  senderRole: "customer" | "professional" | "system";
  messageType: ChatMessageType;
  text?: string;
  images: string[];
  attachments: IChatAttachment[];
  readBy: IChatMessageReadReceipt[];
  reviewMeta?: IReviewNotificationMeta;
  warrantyMeta?: IWarrantyNotificationMeta;
  quotationMeta?: IQuotationNotificationMeta;
  replyTo?: Types.ObjectId;
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
      enum: ["customer", "professional", "system"],
      required: true,
    },
    messageType: {
      type: String,
      enum: ["text", "review_notification", "warranty_notification", "quotation_notification"],
      default: "text",
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
    reviewMeta: {
      bookingId: { type: String },
      avgRating: { type: Number, min: 1, max: 5 },
      communicationLevel: { type: Number, min: 1, max: 5 },
      valueOfDelivery: { type: Number, min: 1, max: 5 },
      qualityOfService: { type: Number, min: 1, max: 5 },
      comment: { type: String },
      customerName: { type: String },
    },
    warrantyMeta: {
      claimId: { type: String },
      claimNumber: { type: String },
      bookingId: { type: String },
      status: { type: String },
    },
    quotationMeta: {
      bookingId: { type: String },
      quotationNumber: { type: String },
      version: { type: Number },
      scope: { type: String },
      totalAmount: { type: Number },
      currency: { type: String },
      validUntil: { type: String },
      status: { type: String, enum: ['quoted', 'quote_accepted', 'quote_rejected'] },
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
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "ChatMessage",
      required: false,
    },
  },
  { timestamps: true }
);

// Note: this validator uses document context (this.images) and only runs for
// document-level operations (create/save). Mongoose update operations
// (updateOne/findOneAndUpdate) do not invoke this with document context.
ChatMessageSchema.path("text").validate(function (value: string | undefined) {
  if (this.messageType === "review_notification" || this.messageType === "warranty_notification" || this.messageType === "quotation_notification") return true;
  const hasText = typeof value === "string" && value.trim().length > 0;
  const hasImages = Array.isArray(this.images) && this.images.length > 0;
  const hasAttachments = Array.isArray(this.attachments) && this.attachments.length > 0;
  return hasText || hasImages || hasAttachments;
}, "Message must include text or at least one image/attachment");

ChatMessageSchema.index({ conversationId: 1, _id: -1 });
ChatMessageSchema.index({ conversationId: 1, _id: 1 });
ChatMessageSchema.index({ text: "text" });

const ChatMessage = model<IChatMessage>("ChatMessage", ChatMessageSchema);

export default ChatMessage;
