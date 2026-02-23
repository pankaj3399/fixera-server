import { Schema, model, Document, Types } from "mongoose";

export interface IConversation extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  professionalId: Types.ObjectId;
  bookingId?: Types.ObjectId;
  initiatedBy: Types.ObjectId;
  status: "active" | "archived";
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
      index: true,
    },
    professionalId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: false,
      index: true,
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
      index: true,
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
  },
  { timestamps: true }
);

ConversationSchema.index({ customerId: 1, lastMessageAt: -1 });
ConversationSchema.index({ professionalId: 1, lastMessageAt: -1 });
ConversationSchema.index({ customerId: 1, professionalId: 1, bookingId: 1 });

const Conversation = model<IConversation>("Conversation", ConversationSchema);

export default Conversation;
