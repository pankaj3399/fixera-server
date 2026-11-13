import { Schema, model, Document, Types } from "mongoose";
import {
  SUPPORT_KINDS,
  SUPPORT_LOCALES,
  SUPPORT_MEETING_DURATION_MINUTES,
  SUPPORT_MEETING_STATUSES,
  SUPPORT_REASON_IDS,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_USER_TYPES,
  type SupportKind,
  type SupportLocale,
  type SupportMeetingStatus,
  type SupportReasonId,
  type SupportTicketStatus,
  type SupportUserType,
} from "../constants/support";

export {
  SUPPORT_TICKET_STATUSES,
  SUPPORT_MEETING_STATUSES,
  type SupportTicketStatus,
  type SupportMeetingStatus,
  type SupportKind,
  type SupportLocale,
  type SupportReasonId,
  type SupportUserType,
};

export interface ISupportTicketReply {
  authorId: Types.ObjectId;
  authorRole: "customer" | "professional" | "admin";
  body: string;
  createdAt: Date;
}

export interface ISupportTicketBookingSnapshot {
  bookingId: Types.ObjectId;
  bookingNumber: string;
  projectTitle: string;
  counterpartyName: string;
  label: string;
}

export interface ISupportTicketAttachment {
  key: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ISupportTicketMeeting {
  status: SupportMeetingStatus;
  scheduledAt?: Date;
  durationMinutes: number;
  timeZone?: string;
  adminId?: Types.ObjectId;
  meetingLink?: string;
  linkAddedAt?: Date;
  linkAddedBy?: Types.ObjectId;
  linkUpdatedAt?: Date;
  /** `admin_default` when the assigned admin's saved link was applied on submit. */
  linkSource?: "admin_default" | "manual";
  /** Set only after a real confirmation email was accepted by the mail service. */
  linkEmailSentAt?: Date;
  /**
   * Monotonic transition counter. Every meeting state change increments it and
   * uses a conditional update on the previous value, so competing admin/owner
   * actions cannot overwrite each other from stale documents.
   */
  revision?: number;
  /** Durable notification identities. Delivery state lives in SupportMeetingNotification. */
  confirmationEventId?: string;
  linkUpdateEventId?: string;
  rescheduledEventId?: string;
  cancelledEventId?: string;
  slotKeys?: string[];
  previousScheduledAt?: Date;
  previousTimeZone?: string;
  cancelledAt?: Date;
  cancelledBy?: Types.ObjectId;
  cancelledByRole?: "user" | "admin";
  cancellationReason?: string;
  completedAt?: Date;
}

export interface ISupportTicket extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  ticketNumber?: string;
  kind: SupportKind;
  subject: string;
  description: string;
  reason?: SupportReasonId;
  userType?: SupportUserType;
  locale: SupportLocale;
  status: SupportTicketStatus;
  booking?: ISupportTicketBookingSnapshot;
  attachment?: ISupportTicketAttachment;
  meeting?: ISupportTicketMeeting;
  /** Used only when an operator explicitly backfills a legacy MeetingRequest. */
  legacyMeetingRequestId?: Types.ObjectId;
  replies: ISupportTicketReply[];
  createdAt: Date;
  updatedAt: Date;
}

const bookingSnapshotSchema = new Schema<ISupportTicketBookingSnapshot>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    bookingNumber: { type: String, trim: true, maxlength: 100 },
    projectTitle: { type: String, trim: true, maxlength: 300 },
    counterpartyName: { type: String, trim: true, maxlength: 300 },
    label: { type: String, trim: true, maxlength: 700 },
  },
  { _id: false },
);

const attachmentSchema = new Schema<ISupportTicketAttachment>(
  {
    key: { type: String, trim: true, required: true, maxlength: 1000 },
    url: { type: String, trim: true, required: true, maxlength: 1500 },
    name: { type: String, trim: true, required: true, maxlength: 255 },
    mimeType: { type: String, trim: true, required: true, maxlength: 200 },
    size: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const meetingSchema = new Schema<ISupportTicketMeeting>(
  {
    status: {
      type: String,
      enum: SUPPORT_MEETING_STATUSES,
      default: "pending",
      required: true,
    },
    scheduledAt: { type: Date },
    durationMinutes: {
      type: Number,
      default: SUPPORT_MEETING_DURATION_MINUTES,
      min: 15,
      max: 240,
      required: true,
    },
    timeZone: { type: String, trim: true, maxlength: 100 },
    adminId: { type: Schema.Types.ObjectId, ref: "User" },
    meetingLink: { type: String, trim: true, maxlength: 500 },
    linkAddedAt: { type: Date },
    linkAddedBy: { type: Schema.Types.ObjectId, ref: "User" },
    linkUpdatedAt: { type: Date },
    linkSource: { type: String, enum: ["admin_default", "manual"] },
    linkEmailSentAt: { type: Date },
    revision: { type: Number, default: 0, min: 0 },
    confirmationEventId: { type: String, trim: true, maxlength: 120 },
    linkUpdateEventId: { type: String, trim: true, maxlength: 120 },
    rescheduledEventId: { type: String, trim: true, maxlength: 120 },
    cancelledEventId: { type: String, trim: true, maxlength: 120 },
    slotKeys: { type: [String], default: undefined },
    previousScheduledAt: { type: Date },
    previousTimeZone: { type: String, trim: true, maxlength: 100 },
    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelledByRole: { type: String, enum: ["user", "admin"] },
    cancellationReason: { type: String, trim: true, maxlength: 500 },
    completedAt: { type: Date },
  },
  { _id: false },
);

const replySchema = new Schema<ISupportTicketReply>(
  {
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, enum: ["customer", "professional", "admin"], required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Sparse + unique: historical tickets intentionally have no number.
    ticketNumber: { type: String, trim: true, maxlength: 40 },
    kind: { type: String, enum: SUPPORT_KINDS, default: "ticket", required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    reason: { type: String, enum: SUPPORT_REASON_IDS },
    userType: { type: String, enum: SUPPORT_USER_TYPES },
    locale: { type: String, enum: SUPPORT_LOCALES, default: "en", required: true },
    status: {
      type: String,
      enum: SUPPORT_TICKET_STATUSES,
      default: "open",
      required: true,
      index: true,
    },
    booking: { type: bookingSnapshotSchema },
    attachment: { type: attachmentSchema },
    meeting: { type: meetingSchema },
    legacyMeetingRequestId: { type: Schema.Types.ObjectId, ref: "MeetingRequest" },
    replies: { type: [replySchema], default: [] },
  },
  { timestamps: true, optimisticConcurrency: true },
);

supportTicketSchema.index({ userId: 1, updatedAt: -1 });
supportTicketSchema.index({ status: 1, updatedAt: -1 });
supportTicketSchema.index({ kind: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ kind: 1, 'meeting.scheduledAt': 1 });
supportTicketSchema.index({ userType: 1, updatedAt: -1 });
supportTicketSchema.index({ reason: 1, updatedAt: -1 });
supportTicketSchema.index({ 'booking.bookingNumber': 1 });
supportTicketSchema.index({ ticketNumber: 1 }, { unique: true, sparse: true });
// Multikey unique reservation keys: one document cannot hold the same admin or
// professional slot twice, and two concurrent support meetings cannot share it.
supportTicketSchema.index({ 'meeting.slotKeys': 1 }, { unique: true, sparse: true });

const SupportTicket = model<ISupportTicket>("SupportTicket", supportTicketSchema);
export default SupportTicket;
