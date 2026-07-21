import { Schema, model, Document, Types } from "mongoose";

export interface IConversationLabel {
  userId: Types.ObjectId;
  label: string;
  color?: string;
}

export type ConversationType = "direct" | "support";

export interface IConversation extends Document {
  _id: Types.ObjectId;
  type: ConversationType;
  customerId?: Types.ObjectId;
  professionalId?: Types.ObjectId;
  supportAdminId?: Types.ObjectId;
  supportTargetUserId?: Types.ObjectId;
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
  unreadChatReminderLastSentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    type: {
      type: String,
      enum: ["direct", "support"],
      default: "direct",
      required: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: IConversation) {
        return this.type === "direct";
      },
    },
    professionalId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: IConversation) {
        return this.type === "direct";
      },
    },
    supportAdminId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: IConversation) {
        return this.type === "support";
      },
    },
    supportTargetUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: IConversation) {
        return this.type === "support";
      },
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
    unreadChatReminderLastSentAt: {
      type: Date,
      required: false,
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

ConversationSchema.pre("validate", function (next) {
  if (
    this.type === "support" &&
    this.supportAdminId &&
    this.supportTargetUserId &&
    this.supportAdminId.toString() === this.supportTargetUserId.toString()
  ) {
    this.invalidate(
      "supportTargetUserId",
      "supportAdminId and supportTargetUserId must be different users"
    );
  }
  next();
});

ConversationSchema.index({ customerId: 1, lastMessageAt: -1 });
ConversationSchema.index({ professionalId: 1, lastMessageAt: -1 });
ConversationSchema.index(
  { customerId: 1, professionalId: 1 },
  { unique: true, partialFilterExpression: { type: "direct" } }
);
ConversationSchema.index({ supportTargetUserId: 1, lastMessageAt: -1 });
ConversationSchema.index({ supportAdminId: 1, lastMessageAt: -1 });
ConversationSchema.index(
  { supportAdminId: 1, supportTargetUserId: 1 },
  { unique: true, partialFilterExpression: { type: "support" } }
);
ConversationSchema.index({ starredBy: 1 });
ConversationSchema.index({ archivedBy: 1 });
ConversationSchema.index({ "labels.userId": 1, "labels.label": 1 });

const Conversation = model<IConversation>("Conversation", ConversationSchema);

export default Conversation;
