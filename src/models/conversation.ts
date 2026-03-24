import { Schema, model, Document, Types } from "mongoose";

export interface IConversationLabel {
  userId: Types.ObjectId;
  label: string;
  color?: string;
}

export interface IConversation extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  professionalId: Types.ObjectId;
  initiatedBy: Types.ObjectId;
  status: "active" | "archived";
  starredBy: Types.ObjectId[];
  archivedBy: Types.ObjectId[];
  labels: IConversationLabel[];
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  lastMessageSenderId?: Types.ObjectId;
  customerUnreadCount: number;
  professionalUnreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    professionalId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    initiatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
      required: true,
    },
    lastMessageAt: {
      type: Date,
      required: false,
    },
    lastMessagePreview: {
      type: String,
      required: false,
      maxlength: 200,
    },
    lastMessageSenderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    customerUnreadCount: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    professionalUnreadCount: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    starredBy: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    archivedBy: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    labels: {
      type: [
        {
          userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
          label: { type: String, required: true, maxlength: 30 },
          color: { type: String, maxlength: 20 },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

ConversationSchema.index({ customerId: 1, lastMessageAt: -1 });
ConversationSchema.index({ professionalId: 1, lastMessageAt: -1 });
ConversationSchema.index(
  { customerId: 1, professionalId: 1 },
  { unique: true }
);

const Conversation = model<IConversation>("Conversation", ConversationSchema);

export default Conversation;
