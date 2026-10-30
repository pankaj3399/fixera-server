import { Types } from "mongoose";
import type { ISupportTicket } from "../../models/supportTicket";
import type { ISupportTicketInternalNote } from "../../models/supportTicketInternalNote";
import type { IMeetingRequest } from "../../models/meetingRequest";
import {
  normalizeSupportReason,
  supportReasonLabel,
  type SupportLocale,
  type SupportMeetingStatus,
  type SupportTicketStatus,
  type SupportUserType,
} from "../../constants/support";
import { presignSupportAttachment } from "./attachments";
import { safeSupportMeetingLink } from "./meetingLink";
import { ANONYMIZED_TEXT, ANONYMIZED_USER_NAME, isAnonymizedAccount } from "../accountAnonymity";

type AnyDoc = Record<string, any>;

export interface SupportRequester {
  _id: string;
  id: string;
  name?: string;
  email?: string;
  role?: string;
  isAnonymized?: boolean;
  deletedAt?: Date | string | null;
}

export interface SerializeSupportOptions {
  /** Disable presigning for PDFs/exports that must not expose download URLs. */
  presign?: boolean;
  requester?: SupportRequester | null;
  /** Admin-only: expose the assigned admin display name. */
  includeAdminDetails?: boolean;
}

function plain(value: unknown): AnyDoc {
  if (!value) return {};
  if (typeof (value as AnyDoc).toObject === "function") {
    return (value as AnyDoc).toObject();
  }
  return value as AnyDoc;
}

export function supportRequesterFromPopulated(
  value: unknown,
  fallback?: SupportRequester | null,
): SupportRequester {
  const raw = plain(value);
  const id = raw._id ? String(raw._id) : fallback?._id ?? "";
  const anonymized = isAnonymizedAccount(raw) || fallback?.isAnonymized === true;
  const deletedAt = raw.deletedAt || fallback?.deletedAt || null;
  return {
    _id: id,
    id,
    ...(anonymized || raw.name || fallback?.name
      ? { name: anonymized ? ANONYMIZED_USER_NAME : raw.name || fallback?.name }
      : {}),
    ...(!anonymized && (raw.email || fallback?.email)
      ? { email: raw.email || fallback?.email }
      : {}),
    ...(raw.role || fallback?.role ? { role: raw.role || fallback?.role } : {}),
    ...(anonymized || raw.isAnonymized === true || fallback?.isAnonymized === true
      ? { isAnonymized: true }
      : {}),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

function resolveUserType(ticket: AnyDoc, requester?: SupportRequester | null): SupportUserType {
  if (ticket.userType === "customer" || ticket.userType === "professional") {
    return ticket.userType;
  }
  return requester?.role === "customer" ? "customer" : "professional";
}

function resolveLocale(value: unknown): SupportLocale {
  return value === "nl" || value === "fr" ? value : "en";
}

function serializeBooking(booking: AnyDoc | undefined) {
  if (!booking?.bookingId) return null;
  const id = String(booking.bookingId);
  const bookingNumber = String(booking.bookingNumber || "");
  const projectTitle = String(booking.projectTitle || "");
  const counterpartyName = String(booking.counterpartyName || "");
  const label = String(booking.label || `${bookingNumber} - ${projectTitle} - ${counterpartyName}`);
  return {
    _id: id,
    id,
    bookingNumber,
    title: projectTitle,
    projectTitle,
    counterpartName: counterpartyName,
    counterpartyName,
    label,
  };
}

async function serializeAttachment(
  attachment: AnyDoc | undefined,
  presign: boolean,
) {
  if (!attachment?.url && !attachment?.key) return null;
  const storedUrl = typeof attachment.url === "string" ? attachment.url : "";
  const url = presign && storedUrl ? await presignSupportAttachment(storedUrl) : null;
  return {
    url,
    fileName: String(attachment.name || "attachment"),
    mimeType: String(attachment.mimeType || "application/octet-stream"),
    size: Number(attachment.size) || 0,
  };
}

function serializeReplies(
  replies: unknown,
  includeAdminAuthorId: boolean,
  anonymizedAuthorId?: string | null,
) {
  if (!Array.isArray(replies)) return [];
  return replies.map((reply) => {
    const raw = plain(reply);
    const authorId = raw.authorId ? String(raw.authorId) : "";
    const isAdminReply = raw.authorRole === "admin";
    return {
      ...(raw._id ? { _id: String(raw._id) } : {}),
      // Owner-facing payloads must never expose admin user ids.
      authorId:
        authorId && (includeAdminAuthorId || !isAdminReply) ? authorId : "",
      authorRole: raw.authorRole === "admin" ? "admin" : raw.authorRole === "customer" ? "customer" : "professional",
      body: anonymizedAuthorId && authorId === anonymizedAuthorId
        ? ANONYMIZED_TEXT
        : String(raw.body || ""),
      createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : new Date(0).toISOString(),
    };
  });
}

function serializeMeeting(
  ticket: AnyDoc,
  includeAdminDetails: boolean,
  requesterAnonymized = false,
  requesterId = "",
) {
  const meeting = plain(ticket.meeting);
  if (!meeting || !meeting.scheduledAt || !meeting.status) return null;
  const cancelledByTarget = Boolean(
    requesterAnonymized
      && requesterId
      && meeting.cancelledBy
      && String(meeting.cancelledBy) === requesterId,
  );
  const start = new Date(meeting.scheduledAt);
  const durationMinutes = Number(meeting.durationMinutes) || 30;
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const admin = plain(meeting.adminId);
  const assignedAdminName = includeAdminDetails
    ? admin.name || admin.email || null
    : null;
  const meetingLink = requesterAnonymized ? null : safeSupportMeetingLink(meeting.meetingLink);
  return {
    status: meeting.status as SupportMeetingStatus,
    scheduledAt: start.toISOString(),
    endAt: end.toISOString(),
    durationMinutes,
    timeZone: meeting.timeZone || null,
    meetingLink,
    // Only a scheduled meeting with a persisted real link can be joined.
    // Cancelled/completed rows may keep the historical link, but not as active.
    linkActive: !requesterAnonymized && meeting.status === "scheduled" && Boolean(meetingLink),
    linkAddedAt: meeting.linkAddedAt ? new Date(meeting.linkAddedAt).toISOString() : null,
    linkUpdatedAt: meeting.linkUpdatedAt ? new Date(meeting.linkUpdatedAt).toISOString() : null,
    confirmationEmailSentAt: meeting.linkEmailSentAt
      ? new Date(meeting.linkEmailSentAt).toISOString()
      : null,
    assignedAdminName,
    cancellationReason: cancelledByTarget
      ? ANONYMIZED_TEXT
      : meeting.cancellationReason || null,
    cancelledAt: meeting.cancelledAt ? new Date(meeting.cancelledAt).toISOString() : null,
    cancelledBy: meeting.cancelledByRole || null,
    preferredTimes: null,
    adminResponse: null,
    legacy: false,
  };
}

async function serializeBase(
  input: ISupportTicket | AnyDoc,
  options: SerializeSupportOptions,
): Promise<AnyDoc> {
  const ticket = plain(input);
  const requester = supportRequesterFromPopulated(ticket.userId, options.requester);
  const reasonId = normalizeSupportReason(ticket.reason) || null;
  const reasonLabel = supportReasonLabel(reasonId);
  const userType = resolveUserType(ticket, requester);
  const booking = serializeBooking(plain(ticket.booking));
  const requesterAnonymized = requester.isAnonymized === true;
  const attachment = requesterAnonymized
    ? null
    : await serializeAttachment(plain(ticket.attachment), options.presign !== false);
  const meeting = serializeMeeting(
    ticket,
    options.includeAdminDetails === true,
    requesterAnonymized,
    requester._id,
  );
  const ticketStatus = (ticket.status || "open") as SupportTicketStatus;
  const displayStatus = ticket.kind === "meeting" && meeting?.status
    ? meeting.status
    : ticketStatus;
  const id = String(ticket._id || "");

  return {
    _id: id,
    id,
    kind: ticket.kind === "meeting" ? "meeting" : "ticket",
    ticketNumber: ticket.ticketNumber || null,
    subject: requesterAnonymized ? ANONYMIZED_TEXT : String(ticket.subject || ""),
    description: requesterAnonymized ? ANONYMIZED_TEXT : String(ticket.description || ""),
    reason: reasonId,
    reasonLabel,
    status: displayStatus,
    ticketStatus,
    requester: {
      _id: requester._id,
      id: requester._id,
      ...(requester.name ? { name: requester.name } : {}),
      ...(requester.email ? { email: requester.email } : {}),
      ...(requester.isAnonymized ? { isAnonymized: true } : {}),
      ...(requester.deletedAt ? { deletedAt: requester.deletedAt } : {}),
    },
    requesterRole: userType,
    booking,
    attachments: attachment ? [attachment] : [],
    attachment,
    replies: serializeReplies(
      ticket.replies,
      options.includeAdminDetails === true,
      requesterAnonymized ? requester._id : null,
    ),
    meeting,
    tags: {
      reason: reasonId,
      reasonLabel,
      booking: booking
        ? { id: booking.id, number: booking.bookingNumber, label: booking.label }
        : null,
      userType,
      meetingAt: meeting?.scheduledAt || null,
      kind: ticket.kind === "meeting" ? "meeting" : "ticket",
    },
    createdAt: ticket.createdAt ? new Date(ticket.createdAt).toISOString() : new Date(0).toISOString(),
    updatedAt: ticket.updatedAt ? new Date(ticket.updatedAt).toISOString() : new Date(0).toISOString(),
  };
}

/** Owner-facing DTO; no admin ids, slot keys, or private notes can ever appear. */
export async function serializeSupportTicketUser(
  input: ISupportTicket | AnyDoc,
  options: SerializeSupportOptions = {},
): Promise<AnyDoc> {
  return serializeBase(input, options);
}

/** Admin DTO: adds requester identity, assignment, counts and internal notes. */
export async function serializeSupportTicketAdmin(
  input: ISupportTicket | AnyDoc,
  internalNotes: Array<ISupportTicketInternalNote | AnyDoc> = [],
  options: SerializeSupportOptions = {},
): Promise<AnyDoc> {
  const base = await serializeBase(input, { ...options, includeAdminDetails: true });
  const ticket = plain(input);
  const requester = supportRequesterFromPopulated(ticket.userId, options.requester);
  const replies = Array.isArray(ticket.replies) ? ticket.replies : [];
  const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
  const meeting = plain(ticket.meeting);
  const admin = plain(meeting.adminId);
  const adminUser = admin._id
    ? {
        _id: String(admin._id),
        id: String(admin._id),
        ...(admin.name ? { name: admin.name } : {}),
        ...(admin.email ? { email: admin.email } : {}),
      }
    : null;

  return {
    ...base,
    user: {
      _id: requester._id,
      id: requester._id,
      ...(requester.name ? { name: requester.name } : {}),
      ...(requester.email ? { email: requester.email } : {}),
      role: requester.role || base.requesterRole,
      ...(requester.isAnonymized ? { isAnonymized: true } : {}),
      ...(requester.deletedAt ? { deletedAt: requester.deletedAt } : {}),
    },
    userId: {
      _id: requester._id,
      id: requester._id,
      ...(requester.name ? { name: requester.name } : {}),
      ...(requester.email ? { email: requester.email } : {}),
      role: requester.role || base.requesterRole,
      ...(requester.isAnonymized ? { isAnonymized: true } : {}),
      ...(requester.deletedAt ? { deletedAt: requester.deletedAt } : {}),
    },
    meetingAdmin: adminUser,
    assignedAdmin: adminUser,
    replyCount: replies.length,
    lastReplyAt: lastReply?.createdAt ? new Date(lastReply.createdAt).toISOString() : null,
    legacy: false,
    internalNotes: internalNotes.map(serializeSupportNote),
  };
}

export function serializeSupportNote(note: ISupportTicketInternalNote | AnyDoc) {
  const raw = plain(note);
  const admin = plain(raw.adminId);
  return {
    _id: String(raw._id || ""),
    id: String(raw._id || ""),
    body: String(raw.body || ""),
    admin: admin._id
      ? {
          _id: String(admin._id),
          ...(admin.name ? { name: admin.name } : {}),
        }
      : null,
    createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : new Date(0).toISOString(),
  };
}

/** Read-only adapter for historical free-text MeetingRequest rows. */
export function serializeLegacyMeetingRequest(
  input: IMeetingRequest | AnyDoc,
  options: SerializeSupportOptions = {},
): AnyDoc {
  const request = plain(input);
  const requester = supportRequesterFromPopulated(request.userId, options.requester);
  const scheduledAt = request.scheduledAt ? new Date(request.scheduledAt) : null;
  const durationMinutes = Number(request.durationMinutes) || 30;
  const endAt = scheduledAt
    ? new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000).toISOString()
    : null;
  const id = String(request._id || "");
  const storedStatus = ["pending", "scheduled", "declined", "cancelled", "completed"].includes(
    request.status,
  )
    ? (request.status as SupportMeetingStatus)
    : "pending";
  const ticketStatus: SupportTicketStatus =
    storedStatus === "cancelled" || storedStatus === "declined" ? "closed" : "open";
  const requesterAnonymized = requester.isAnonymized === true;

  return {
    _id: id,
    id,
    kind: "meeting",
    ticketNumber: null,
    subject: requesterAnonymized ? ANONYMIZED_TEXT : String(request.topic || ""),
    description: "",
    reason: null,
    reasonLabel: null,
    status: storedStatus,
    ticketStatus,
    requester: {
      _id: requester._id,
      id: requester._id,
      ...(requester.name ? { name: requester.name } : {}),
      ...(requester.email ? { email: requester.email } : {}),
      ...(requester.isAnonymized ? { isAnonymized: true } : {}),
      ...(requester.deletedAt ? { deletedAt: requester.deletedAt } : {}),
    },
    requesterRole: "professional",
    booking: null,
    attachments: [],
    attachment: null,
    replies: [],
    meeting: {
      status: storedStatus,
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      endAt,
      durationMinutes,
      timeZone: null,
      meetingLink: null,
      linkActive: false,
      linkAddedAt: null,
      linkUpdatedAt: null,
      confirmationEmailSentAt: null,
      assignedAdminName: null,
      cancellationReason: null,
      cancelledAt: null,
      cancelledBy: null,
      preferredTimes: requesterAnonymized ? null : request.preferredTimes || null,
      adminResponse: request.adminResponse || null,
      legacy: true,
    },
    tags: {
      reason: null,
      reasonLabel: null,
      booking: null,
      userType: "professional",
      meetingAt: scheduledAt ? scheduledAt.toISOString() : null,
      kind: "meeting",
    },
    createdAt: request.createdAt ? new Date(request.createdAt).toISOString() : new Date(0).toISOString(),
    updatedAt: request.updatedAt ? new Date(request.updatedAt).toISOString() : new Date(0).toISOString(),
  };
}

export function serializeLegacyMeetingRequestAdmin(input: IMeetingRequest | AnyDoc): AnyDoc {
  const base = serializeLegacyMeetingRequest(input);
  const requester = base.requester as AnyDoc;
  const party = {
    _id: requester._id,
    id: requester._id,
    name: requester.name,
    email: requester.email,
    role: "professional",
    ...(requester.isAnonymized ? { isAnonymized: true } : {}),
    ...(requester.deletedAt ? { deletedAt: requester.deletedAt } : {}),
  };
  return {
    ...base,
    user: party,
    userId: party,
    meetingAdmin: null,
    assignedAdmin: null,
    replyCount: 0,
    lastReplyAt: null,
    legacy: true,
    internalNotes: [],
  };
}

/** GDPR export: no download URL, no admin assignment/slot keys, no private notes. */
export async function serializeSupportTicketsForExport(
  tickets: Array<ISupportTicket | AnyDoc>,
): Promise<AnyDoc[]> {
  return Promise.all(
    tickets.map((ticket) => serializeSupportTicketUser(ticket, { presign: false })),
  );
}

export function isObjectIdString(value: unknown): boolean {
  return typeof value === "string" && Types.ObjectId.isValid(value);
}
