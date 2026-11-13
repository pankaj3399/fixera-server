import type { Types } from "mongoose";
import User from "../../models/user";
import SupportTicket, { type ISupportTicket } from "../../models/supportTicket";
import type { SupportEmailUser } from "./emails";
import { safeSupportMeetingLink } from "./meetingLink";
import { setSupportMeetingLink } from "./meetingReservation";

/**
 * The saved default meeting link of one admin, re-validated on read so a value
 * written before a validation change can never reach a ticket or an email.
 */
export async function findAdminDefaultSupportMeetingLink(
  adminId: Types.ObjectId | string,
): Promise<string | null> {
  const admin = await User.findById(adminId)
    .select("supportMeetingLink")
    .lean<{ supportMeetingLink?: { url?: string } | null } | null>();
  return safeSupportMeetingLink(admin?.supportMeetingLink?.url);
}

export interface AppliedDefaultMeetingLink {
  /** True when the meeting now carries the assigned admin's default link. */
  applied: boolean;
  ticket: ISupportTicket;
  emailSent: boolean;
  emailAttempted: boolean;
}

/**
 * On submit: when the admin the slot is assigned to has a saved default link,
 * put it on the ticket right away. This reuses the manual set-link transition,
 * so the meeting becomes `scheduled` through the same revision CAS, durable
 * notification ledger and bounded email timeout as an admin-pasted link, and
 * the professional gets the localized confirmation (time + link) at once.
 *
 * Without a default link, or if applying it fails, the meeting stays pending
 * and the existing manual flow (admin pastes a link later) is unchanged.
 */
export async function applyAssignedAdminDefaultMeetingLink(params: {
  ticket: ISupportTicket;
  adminId: Types.ObjectId | string;
  owner: SupportEmailUser;
}): Promise<AppliedDefaultMeetingLink> {
  const notApplied: AppliedDefaultMeetingLink = {
    applied: false,
    ticket: params.ticket,
    emailSent: false,
    emailAttempted: false,
  };
  let defaultLink: string | null = null;
  try {
    defaultLink = await findAdminDefaultSupportMeetingLink(params.adminId);
  } catch {
    console.error("Failed to read the assigned admin's default support meeting link");
    return notApplied;
  }
  if (!defaultLink) return notApplied;

  try {
    const result = await setSupportMeetingLink({
      ticket: params.ticket,
      adminId: params.adminId,
      owner: params.owner,
      meetingLink: defaultLink,
      source: "admin_default",
    });
    return {
      applied: true,
      ticket: result.ticket,
      emailSent: result.emailSent,
      emailAttempted: result.emailAttempted,
    };
  } catch {
    // Never log the link itself (it may carry a passcode in the query).
    console.error("Failed to apply the default support meeting link; the meeting stays pending");
    // A failure after the transition committed (e.g. a reload error) must not
    // fall back to the "link follows" acknowledgement for a confirmed meeting.
    const current = await reloadTicketQuietly(params.ticket._id);
    if (current?.meeting?.status === "scheduled" && current.meeting.meetingLink) {
      return { applied: true, ticket: current, emailSent: false, emailAttempted: false };
    }
    return notApplied;
  }
}

async function reloadTicketQuietly(
  ticketId: Types.ObjectId | string,
): Promise<ISupportTicket | null> {
  try {
    return await SupportTicket.findById(ticketId)
      .populate("userId", "name email role isEmailVerified deletedAt")
      .populate("meeting.adminId", "name email");
  } catch {
    return null;
  }
}
