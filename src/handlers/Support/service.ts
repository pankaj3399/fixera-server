import { Types } from "mongoose";
import type { IUser } from "../../models/user";
import MeetingRequest from "../../models/meetingRequest";
import SupportTicket, { type ISupportTicket } from "../../models/supportTicket";
import {
  SUPPORT_MEETING_DURATION_MINUTES,
  isSupportKind,
  normalizeSupportLocale,
  normalizeSupportReason,
  type SupportKind,
} from "../../constants/support";
import { UserFacingError } from "../../utils/appErrors";
import { toDate } from "../../utils/dateUtils";
import {
  deleteSupportAttachment,
  uploadSupportAttachment,
  type UploadedSupportAttachment,
} from "../../utils/support/attachments";
import { resolveSupportBooking } from "../../utils/support/bookings";
import {
  resolveSupportTimeZone,
  isValidIanaTimeZone,
} from "../../utils/support/availability";
import { sendSupportTicketAcknowledgementEmail } from "../../utils/support/emails";
import { applyAssignedAdminDefaultMeetingLink } from "../../utils/support/defaultMeetingLink";
import {
  buildSupportMeetingSlotKeys,
  createReservedSupportMeetingRecord,
  createSupportTicketRecord,
  selectSupportMeetingSlot,
} from "../../utils/support/meetingReservation";
import {
  assertSupportAccountWritable,
  discardSupportCreation,
} from "../../utils/support/accountGuard";
import {
  serializeLegacyMeetingRequest,
  serializeSupportTicketUser,
} from "../../utils/support/serializers";

export function requireSupportUser(reqUser: IUser | undefined): IUser {
  if (!reqUser) throw new UserFacingError(401, "Please sign in to continue.", "AUTH_REQUIRED");
  if (reqUser.role !== "customer" && reqUser.role !== "professional") {
    throw new UserFacingError(
      403,
      "Support is only available for customer and professional accounts.",
      "FORBIDDEN",
    );
  }
  return reqUser;
}

function trimmedBodyString(body: Record<string, unknown> | undefined, key: string): string {
  const value = body?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function requireLength(value: string, field: string, label: string, max: number): string {
  if (!value) {
    throw new UserFacingError(400, `${label} is required.`, "VALIDATION", field);
  }
  if (value.length > max) {
    throw new UserFacingError(
      400,
      `${label} must be ${max} characters or fewer.`,
      "VALIDATION",
      field,
    );
  }
  return value;
}

export interface CreateSupportItemResult {
  ticket: ISupportTicket;
  emailSent: boolean;
}

export interface CreateSupportItemOptions {
  /** Old professional ticket route: reason was not invented yet; default to Other. */
  legacyTicketWithoutReason?: boolean;
}

/**
 * Shared create flow for the canonical and legacy owner-facing endpoints.
 * Attachment upload happens before persistence and is deleted again if any
 * later step fails, so a failed meeting never leaves an orphan file.
 */
export async function createSupportItemForUser(params: {
  user: IUser;
  body: Record<string, unknown> | undefined;
  file?: Express.Multer.File;
  options?: CreateSupportItemOptions;
}): Promise<CreateSupportItemResult> {
  const { user, body, file, options } = params;
  const role = user.role as "customer" | "professional";

  const rawKind = trimmedBodyString(body, "kind");
  let kind: SupportKind = "ticket";
  if (rawKind) {
    if (!isSupportKind(rawKind)) {
      throw new UserFacingError(400, "Invalid support type.", "VALIDATION", "kind");
    }
    kind = rawKind;
  }

  if (kind === "meeting" && role !== "professional") {
    throw new UserFacingError(
      403,
      "Support meetings are only available for professional accounts.",
      "FORBIDDEN",
    );
  }

  const subject = requireLength(trimmedBodyString(body, "subject"), "subject", "Subject", 200);
  const description = requireLength(
    trimmedBodyString(body, "description"),
    "description",
    "Description",
    5000,
  );
  const rawReason = trimmedBodyString(body, "reason");
  const reason = normalizeSupportReason(rawReason) ||
    (options?.legacyTicketWithoutReason && kind === "ticket" ? "other" : undefined);
  if (!reason) {
    throw new UserFacingError(
      400,
      "Choose one of the support reasons.",
      "VALIDATION",
      "reason",
    );
  }

  const locale = normalizeSupportLocale(body?.locale, user.marketingLocale);

  const bookingId = trimmedBodyString(body, "bookingId");
  let booking: Record<string, unknown> | undefined;
  if (bookingId) {
    const snapshot = await resolveSupportBooking(bookingId, user._id);
    booking = {
      bookingId: new Types.ObjectId(snapshot.bookingId),
      bookingNumber: snapshot.bookingNumber,
      projectTitle: snapshot.projectTitle,
      counterpartyName: snapshot.counterpartyName,
      label: snapshot.label,
    };
  }

  // Deny a create that started before a hard delete/anonymization and only
  // reaches persistence afterwards. The duplicate check after the insert
  // covers the reverse ordering.
  await assertSupportAccountWritable(user._id);

  let attachment: UploadedSupportAttachment | undefined;
  if (file) {
    attachment = await uploadSupportAttachment(file, String(user._id));
  }

  const cleanupAfterRacedCreate = async (ticketId: Types.ObjectId | string) => {
    try {
      await discardSupportCreation(ticketId);
    } catch (cleanupError) {
      console.error("Failed to clean up a support record created during account removal", cleanupError);
    }
  };

  try {
    if (kind === "ticket") {
      const ticket = await createSupportTicketRecord({
        userId: user._id,
        kind,
        subject,
        description,
        reason,
        userType: role,
        locale,
        status: "open",
        ...(booking ? { booking } : {}),
        ...(attachment ? { attachment: attachment as unknown as Record<string, unknown> } : {}),
      });
      try {
        await assertSupportAccountWritable(user._id);
      } catch (error) {
        await cleanupAfterRacedCreate(ticket._id);
        throw error;
      }
      let emailSent = false;
      try {
        emailSent = await sendSupportTicketAcknowledgementEmail(user, ticket, "ticket");
      } catch (error) {
        console.error("Support acknowledgement email failed");
      }
      return { ticket, emailSent };
    }

    const timeZone = resolveSupportTimeZone(user, body?.timeZone);
    if (!isValidIanaTimeZone(timeZone)) {
      throw new UserFacingError(400, "A valid IANA time zone is required.", "VALIDATION", "timeZone");
    }
    const rawScheduledAt = trimmedBodyString(body, "scheduledAt");
    const scheduledAt = toDate(rawScheduledAt);
    if (!scheduledAt) {
      throw new UserFacingError(
        400,
        "Choose a valid meeting time in UTC (ISO 8601).",
        "VALIDATION",
        "scheduledAt",
      );
    }

    const selected = await selectSupportMeetingSlot({
      professional: user,
      timeZone,
      start: scheduledAt,
    });

    // The slot is reserved immediately for the admin it is assigned to. The
    // meeting starts pending; if that admin saved a default meeting link it is
    // applied right below (confirmed + email with time and link). Otherwise it
    // stays pending until an authorized support admin supplies a real link.
    const ticket = await createReservedSupportMeetingRecord(
      {
        userId: user._id,
        kind,
        subject,
        description,
        reason,
        userType: role,
        locale,
        status: "open",
        ...(booking ? { booking } : {}),
        ...(attachment ? { attachment: attachment as unknown as Record<string, unknown> } : {}),
        meeting: {
          status: "pending",
          scheduledAt: selected.start,
          durationMinutes: SUPPORT_MEETING_DURATION_MINUTES,
          timeZone,
          adminId: new Types.ObjectId(String(selected.admin._id)),
          slotKeys: buildSupportMeetingSlotKeys(selected.admin._id, user._id, selected.start),
        },
      },
      { adminId: selected.admin._id, professionalId: user._id, start: selected.start },
    );
    try {
      await assertSupportAccountWritable(user._id);
    } catch (error) {
      await cleanupAfterRacedCreate(ticket._id);
      throw error;
    }
    // Use the admin the slot was actually assigned to (combined availability
    // picks one deterministic admin per slot), never another admin's link.
    const autoLink = await applyAssignedAdminDefaultMeetingLink({
      ticket,
      adminId: selected.admin._id,
      owner: user,
    });
    if (autoLink.applied) {
      // The confirmation (time + link) replaces the "link follows" acknowledgement.
      return { ticket: autoLink.ticket, emailSent: autoLink.emailSent };
    }
    let emailSent = false;
    try {
      emailSent = await sendSupportTicketAcknowledgementEmail(user, ticket, "meeting");
    } catch (error) {
      console.error("Support meeting acknowledgement email failed");
    }
    return { ticket, emailSent };
  } catch (error) {
    if (attachment) await deleteSupportAttachment(attachment.key);
    throw error;
  }
}

export async function fetchOwnedSupportItem(params: {
  user: IUser;
  kind: string;
  id: string;
}): Promise<{ type: "ticket" | "legacy"; ticket?: ISupportTicket; legacy?: unknown }> {
  const { user, kind, id } = params;
  if (!Types.ObjectId.isValid(id)) {
    throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
  }
  if (!isSupportKind(kind)) {
    throw new UserFacingError(400, "Invalid support item type.", "VALIDATION", "kind");
  }

  if (kind === "ticket") {
    const ticket = await SupportTicket.findOne({
      _id: id,
      userId: user._id,
      kind: { $ne: "meeting" },
    }).populate("userId", "name email role");
    if (!ticket) throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");
    return { type: "ticket", ticket };
  }

  const ticket = await SupportTicket.findOne({ _id: id, userId: user._id, kind: "meeting" })
    .populate("userId", "name email role");
  if (ticket) return { type: "ticket", ticket };

  const legacy = await MeetingRequest.findOne({ _id: id, userId: user._id })
    .populate("userId", "name email role");
  if (legacy) return { type: "legacy", legacy };
  throw new UserFacingError(404, "Support item not found.", "NOT_FOUND");}

export async function serializeOwnedResult(
  result: { type: "ticket" | "legacy"; ticket?: ISupportTicket; legacy?: unknown },
  user: IUser,
): Promise<Record<string, unknown>> {
  if (result.type === "legacy") {
    return serializeLegacyMeetingRequest(result.legacy as never, {
      requester: {
        _id: String(user._id),
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  }
  return serializeSupportTicketUser(result.ticket as ISupportTicket, {
    requester: {
      _id: String(user._id),
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
}
