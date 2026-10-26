import { Types, type ClientSession } from "mongoose";
import SupportTicket, { type ISupportTicket } from "../../models/supportTicket";
import { getNextSequence } from "../counterSequence";
import { UserFacingError } from "../appErrors";
import { fenceAccountWritesInSession } from "./accountGuard";
import {
  getSupportAvailabilityForProfessional,
  type SupportAdminLike,
} from "./availability";
import {
  releaseCalendarReservations,
  reserveCalendarKeys,
  buildCalendarReservationKeysForInterval,
  withCalendarTransaction,
} from "./calendarReservations";
import {
  sendSupportMeetingCancelledEmail,
  sendSupportMeetingConfirmedEmail,
  sendSupportMeetingLinkUpdatedEmail,
  sendSupportMeetingRescheduledEmail,
  type SupportEmailUser,
} from "./emails";
import { assertRealHttpsMeetingLink } from "./meetingLink";
import {
  claimSupportMeetingNotification,
  findSentSupportMeetingNotification,
  markSupportMeetingNotificationFailed,
  markSupportMeetingNotificationSent,
  markSupportMeetingNotificationSuperseded,
  startSupportMeetingNotificationDispatch,
  supportMeetingEventId,
  supersedeSupportMeetingNotifications,
} from "./meetingNotifications";

export interface CreateSupportTicketRecordInput {
  _id?: Types.ObjectId;
  userId: Types.ObjectId | string;
  kind: "ticket" | "meeting";
  subject: string;
  description: string;
  reason: string;
  userType: "customer" | "professional";
  locale: "en" | "nl" | "fr";
  status?: string;
  booking?: Record<string, unknown>;
  attachment?: Record<string, unknown>;
  meeting?: Record<string, unknown>;
  replies?: Array<Record<string, unknown>>;
}

export function buildSupportMeetingSlotKeys(
  adminId: Types.ObjectId | string,
  professionalId: Types.ObjectId | string,
  start: Date,
): string[] {
  const iso = start.toISOString();
  return [`admin:${String(adminId)}:${iso}`, `professional:${String(professionalId)}:${iso}`];
}

function isDuplicateKeyError(error: unknown): error is {
  code?: number;
  keyPattern?: Record<string, unknown>;
  message?: string;
} {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { code?: unknown }).code === 11000 ||
        (error as { code?: unknown }).code === 11001),
  );
}

function duplicateField(error: { keyPattern?: Record<string, unknown>; message?: string }): string {
  if (error.keyPattern) {
    const keys = Object.keys(error.keyPattern);
    if (keys.length > 0) return keys[0];
  }
  if (error.message?.includes("ticketNumber")) return "ticketNumber";
  if (error.message?.includes("slotKeys")) return "meeting.slotKeys";
  return "";
}

function isVersionError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "VersionError",
  );
}

/**
 * The transition CAS found a newer meeting revision (or a state that no
 * longer allows the action) instead of the snapshot this attempt was built
 * from. Unlike a Mongoose VersionError this is not tied to the ticket `__v`,
 * so an unrelated notification-fence version bump cannot abort the write.
 */
class MeetingTransitionConflictError extends Error {
  constructor() {
    super("Meeting changed concurrently");
    this.name = "MeetingTransitionConflictError";
  }
}

function isMeetingTransitionConflict(error: unknown): boolean {
  return error instanceof MeetingTransitionConflictError;
}

/**
 * Transitions are conditional on the meeting revision (not the document
 * `__v`): every real meeting transition increments it, while notification
 * dispatch/timestamp bumps only move `__v`. The update is therefore
 * idempotent under a driver callback replay — it re-applies the same fields
 * against the rolled-back revision — and a concurrent transition still makes
 * it match zero documents.
 */
function meetingRevisionFilter(ticket: ISupportTicket): Record<string, unknown> {
  const revision = Number(ticket.meeting?.revision || 0);
  if (revision === 0) {
    return {
      $or: [
        { "meeting.revision": 0 },
        { "meeting.revision": { $exists: false } },
      ],
    };
  }
  return { "meeting.revision": revision };
}

async function applyMeetingTransition(
  ticket: ISupportTicket,
  params: {
    session: ClientSession;
    stateFilter: Record<string, unknown>;
    set: Record<string, unknown>;
    unset?: Record<string, 1>;
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    $set: params.set,
    $inc: { __v: 1 },
  };
  if (params.unset) update.$unset = params.unset;
  const result = await SupportTicket.updateOne(
    {
      _id: ticket._id,
      ...meetingRevisionFilter(ticket),
      ...params.stateFilter,
    },
    update,
    { session: params.session },
  );
  if (result.matchedCount !== 1) {
    throw new MeetingTransitionConflictError();
  }
}

async function reloadMeetingTicket(ticketId: Types.ObjectId | string): Promise<ISupportTicket | null> {
  const model = SupportTicket as unknown as { findById?: unknown };
  if (typeof model.findById !== "function") return null;
  return SupportTicket.findById(ticketId)
    .populate("userId", "name email role isEmailVerified deletedAt")
    .populate("meeting.adminId", "name email");
}

function nextMeetingRevision(ticket: ISupportTicket): number {
  return Number(ticket.meeting?.revision || 0) + 1;
}

interface MeetingNotificationDelivery {
  emailSent: boolean;
  emailAttempted: boolean;
}

interface MeetingNotificationSnapshot {
  revision: number;
  meetingLink: string | null;
  scheduledAt: Date | null;
}

/**
 * Mail providers cannot be asked to recall a message. Give the provider call a
 * bounded budget so a hung transport cannot strand the notification lease.
 * Tests may lower this; production defaults to 20 seconds.
 */
function supportMeetingEmailTimeoutMs(): number {
  const raw = Number(process.env.SUPPORT_MEETING_EMAIL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

async function sendWithBoundedTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Support meeting email exceeded the dispatch timeout")),
        supportMeetingEmailTimeoutMs(),
      );
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function notificationSnapshot(ticket: ISupportTicket): MeetingNotificationSnapshot {
  const scheduledAt = ticket.meeting?.scheduledAt
    ? new Date(ticket.meeting.scheduledAt)
    : null;
  return {
    revision: Number(ticket.meeting?.revision || 0),
    meetingLink: typeof ticket.meeting?.meetingLink === "string"
      ? ticket.meeting.meetingLink
      : null,
    scheduledAt:
      scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
  };
}

function sameInstant(value: Date | string | null | undefined, expected: Date | null): boolean {
  if (!value || !expected) return false;
  return new Date(value).getTime() === expected.getTime();
}

/**
 * The persisted ticket is the authority. An event is only deliverable while
 * the meeting still carries that exact transition revision/identity and the
 * content the mail would claim. This is checked immediately before the
 * database dispatch fence and once more atomically by the fence itself.
 */
export function isSupportMeetingNotificationCurrent(
  ticket: ISupportTicket,
  params: {
    eventId: string;
    type: "confirmed" | "link_updated" | "rescheduled" | "cancelled";
    snapshot: MeetingNotificationSnapshot;
  },
): boolean {
  const meeting = ticket.meeting;
  if (!meeting) return false;
  if (Number(meeting.revision || 0) !== params.snapshot.revision) return false;

  switch (params.type) {
    case "confirmed":
      return (
        meeting.status === "scheduled"
        && meeting.confirmationEventId === params.eventId
        && Boolean(params.snapshot.meetingLink)
        && meeting.meetingLink === params.snapshot.meetingLink
        && sameInstant(meeting.scheduledAt, params.snapshot.scheduledAt)
      );
    case "link_updated":
      return (
        meeting.status === "scheduled"
        && meeting.linkUpdateEventId === params.eventId
        && Boolean(params.snapshot.meetingLink)
        && meeting.meetingLink === params.snapshot.meetingLink
        && sameInstant(meeting.scheduledAt, params.snapshot.scheduledAt)
      );
    case "rescheduled":
      return (
        (meeting.status === "pending" || meeting.status === "scheduled")
        && meeting.rescheduledEventId === params.eventId
        && sameInstant(meeting.scheduledAt, params.snapshot.scheduledAt)
      );
    case "cancelled":
      return (
        meeting.status === "cancelled"
        && meeting.cancelledEventId === params.eventId
      );
    default:
      return false;
  }
}

function notificationTicketVersionFilter(ticket: ISupportTicket): Record<string, unknown> {
  const version = Number((ticket as unknown as { __v?: number }).__v || 0);
  if (version === 0) {
    return { $or: [{ __v: 0 }, { __v: { $exists: false } }] };
  }
  return { __v: version };
}

/**
 * Atomic fence with every meeting transition. Both use the same ticket
 * document's `__v` predicate, so either the transition commits first (this
 * dispatch loses and is suppressed) or the dispatch starts first and the
 * transition retries against the new version. A mail already handed to the
 * provider is never claimed to be recallable.
 */
async function fenceSupportMeetingNotificationDispatch(
  ticket: ISupportTicket,
  params: {
    eventId: string;
    type: "confirmed" | "link_updated" | "rescheduled" | "cancelled";
    snapshot: MeetingNotificationSnapshot;
  },
): Promise<ISupportTicket | null> {
  const filter: Record<string, unknown> = {
    _id: ticket._id,
    "meeting.revision": params.snapshot.revision,
    ...notificationTicketVersionFilter(ticket),
  };
  if (params.type === "confirmed") {
    filter["meeting.status"] = "scheduled";
    filter["meeting.confirmationEventId"] = params.eventId;
  } else if (params.type === "link_updated") {
    filter["meeting.status"] = "scheduled";
    filter["meeting.linkUpdateEventId"] = params.eventId;
  } else if (params.type === "rescheduled") {
    filter["meeting.status"] = { $in: ["pending", "scheduled"] };
    filter["meeting.rescheduledEventId"] = params.eventId;
  } else {
    filter["meeting.status"] = "cancelled";
    filter["meeting.cancelledEventId"] = params.eventId;
  }
  if (params.snapshot.meetingLink) {
    filter["meeting.meetingLink"] = params.snapshot.meetingLink;
  }
  if (params.snapshot.scheduledAt) {
    filter["meeting.scheduledAt"] = params.snapshot.scheduledAt;
  }

  return SupportTicket.findOneAndUpdate(
    filter,
    { $inc: { __v: 1 } },
    { new: true },
  );
}

async function reconcileConfirmationTimestamp(
  ticketId: Types.ObjectId | string,
  eventId: string,
): Promise<void> {
  const sent = await findSentSupportMeetingNotification(ticketId, eventId);
  if (sent) await markConfirmationTimestamp(ticketId, eventId, sent.sentAt);
}

/**
 * Claim one durable notification event and send exactly that template. A
 * concurrent request that already claimed/sent the same event does not send.
 * The current persisted event is verified and fenced by a ticket-version CAS
 * immediately before the provider hand-off.
 */
export async function deliverMeetingNotification(params: {
  ticket: ISupportTicket;
  owner: SupportEmailUser | null | undefined;
  eventId: string;
  type: "confirmed" | "link_updated" | "rescheduled" | "cancelled";
  send: (owner: SupportEmailUser, ticket: any) => Promise<boolean>;
  now?: Date;
}): Promise<MeetingNotificationDelivery> {
  const { ticket, owner, eventId, type } = params;
  if (!owner) {
    // No recipient record at all (hard-deleted owner): confirmation/update
    // remains retriable if the account is restored; cancellation/complete
    // cleanup still succeeds without a mail attempt.
    return { emailSent: false, emailAttempted: false };
  }

  const now = params.now || new Date();
  const snapshot = notificationSnapshot(ticket);
  const claim = await claimSupportMeetingNotification({
    ticketId: ticket._id,
    eventId,
    type,
    now,
  });
  if (!claim.claimed) {
    // A crash can land between "mail accepted" and the confirmation timestamp.
    // Reconcile that marker from the durable sent ledger instead of leaving it
    // permanently null or resending the wrong template.
    if (type === "confirmed") await reconcileConfirmationTimestamp(ticket._id, eventId);
    return { emailSent: false, emailAttempted: false };
  }

  const current = await reloadMeetingTicket(ticket._id);
  if (
    !current
    || !isSupportMeetingNotificationCurrent(current, { eventId, type, snapshot })
  ) {
    await markSupportMeetingNotificationSuperseded(claim.notificationId, now);
    return { emailSent: false, emailAttempted: false };
  }

  const dispatchStarted = await startSupportMeetingNotificationDispatch(
    claim.notificationId,
    claim.attempts,
    now,
  );
  if (!dispatchStarted) {
    return { emailSent: false, emailAttempted: false };
  }

  let fenced: ISupportTicket | null = null;
  let candidate: ISupportTicket | null = current;
  for (let fenceAttempt = 0; fenceAttempt < 3 && candidate; fenceAttempt += 1) {
    fenced = await fenceSupportMeetingNotificationDispatch(candidate, {
      eventId,
      type,
      snapshot,
    });
    if (fenced) break;
    candidate = await reloadMeetingTicket(ticket._id);
    if (
      !candidate
      || !isSupportMeetingNotificationCurrent(candidate, { eventId, type, snapshot })
    ) {
      break;
    }
  }
  if (!fenced) {
    const after = await reloadMeetingTicket(ticket._id);
    if (
      !after
      || !isSupportMeetingNotificationCurrent(after, { eventId, type, snapshot })
    ) {
      await markSupportMeetingNotificationSuperseded(claim.notificationId, now);
    } else {
      // The event is still current but another writer bumped the document
      // version before us. Treat this attempt as retryable, never as sent.
      await markSupportMeetingNotificationFailed(
        claim.notificationId,
        now,
        "Meeting changed before the notification hand-off",
      );
    }
    return { emailSent: false, emailAttempted: false };
  }

  let sent = false;
  try {
    sent = await sendWithBoundedTimeout(params.send(owner, fenced));
  } catch (error) {
    console.error(`Support meeting ${type} email failed`);
    sent = false;
  }
  if (sent) {
    await markSupportMeetingNotificationSent(claim.notificationId);
    if (type === "confirmed") {
      await markConfirmationTimestamp(ticket._id, eventId);
    }
    return { emailSent: true, emailAttempted: true };
  }
  await markSupportMeetingNotificationFailed(
    claim.notificationId,
    now,
    "Mail provider rejected, threw, or exceeded the dispatch timeout",
  );
  return { emailSent: false, emailAttempted: true };
}

async function markConfirmationTimestamp(
  ticketId: Types.ObjectId | string,
  eventId: string,
  sentAt = new Date(),
) {
  await SupportTicket.updateOne(
    {
      _id: ticketId,
      "meeting.confirmationEventId": eventId,
      $or: [
        { "meeting.linkEmailSentAt": { $exists: false } },
        { "meeting.linkEmailSentAt": null },
      ],
    },
    {
      $set: { "meeting.linkEmailSentAt": sentAt },
      // Bump the optimistic version so a stale save cannot overwrite this
      // accepted-delivery marker with the old whole-subdocument value.
      $inc: { __v: 1 },
    },
  );
}

export interface CreateSupportTicketRecordOptions {
  session?: ClientSession;
  /** Pre-allocated number so a transaction retry never reuses an aborted transaction. */
  ticketNumber?: string;
}

/**
 * Persist a support record with an atomic human-readable number. The unique
 * indexes are the real guard: a concurrent duplicate slot becomes a 409, while
 * a rare ticket-number collision simply retries with the next counter value.
 */
export async function createSupportTicketRecord(
  input: CreateSupportTicketRecordInput,
  options: CreateSupportTicketRecordOptions = {},
): Promise<ISupportTicket> {
  let lastError: unknown;
  const maxAttempts = options.ticketNumber ? 1 : 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const year = new Date().getUTCFullYear();
    const ticketNumber = options.ticketNumber || await getNextSequence(`ticketNumber-${year}`, `SUP-${year}`);
    try {
      const created = await SupportTicket.create(
        [{
          ...input,
          ticketNumber,
          kind: input.kind,
          status: input.status || "open",
        }],
        options.session ? { session: options.session } : undefined,
      );
      return created[0];
    } catch (error) {
      lastError = error;
      if (!isDuplicateKeyError(error)) throw error;
      const field = duplicateField(error);
      if (field === "meeting.slotKeys" || field.includes("slotKeys")) {
        throw new UserFacingError(
          409,
          "That meeting time was just taken. Refresh the available slots and choose another one.",
          "SLOT_UNAVAILABLE",
        );
      }
      if (field !== "ticketNumber") throw error;
      if (options.ticketNumber) throw error;
    }
  }
  throw lastError;
}

/**
 * Atomically reserves admin + professional calendars and creates the meeting
 * ticket. The shared CalendarReservation collection also prevents existing
 * Meeting/MeetingRequest routes from racing this reservation.
 */
export async function createReservedSupportMeetingRecord(
  input: CreateSupportTicketRecordInput,
  params: {
    adminId: Types.ObjectId | string;
    professionalId: Types.ObjectId | string;
    start: Date;
  },
): Promise<ISupportTicket> {
  const ticketId = new Types.ObjectId();
  const end = new Date(params.start.getTime() + 30 * 60 * 1000);
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const year = new Date().getUTCFullYear();
    // Allocate outside the transaction so a duplicate number can retry the
    // whole transaction instead of reusing an already-aborted one.
    const ticketNumber = await getNextSequence(`ticketNumber-${year}`, `SUP-${year}`);
    try {
      return await withCalendarTransaction(async (session) => {
        await reserveCalendarKeys(
          {
            sourceType: "support",
            sourceId: ticketId,
            keys: [
              ...buildCalendarReservationKeysForInterval({
                role: "admin",
                userId: params.adminId,
                startAt: params.start,
                endAt: end,
              }),
              ...buildCalendarReservationKeysForInterval({
                role: "professional",
                userId: params.professionalId,
                startAt: params.start,
                endAt: end,
              }),
            ],
          },
          session,
        );
        return createSupportTicketRecord(
          { ...input, _id: ticketId },
          { session, ticketNumber },
        );
      });
    } catch (error) {
      lastError = error;
      if (isDuplicateKeyError(error) && duplicateField(error) === "ticketNumber") {
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export interface SelectedSupportSlot {
  start: Date;
  end: Date;
  admin: SupportAdminLike;
  adminIds: string[];
}

export async function selectSupportMeetingSlot(params: {
  professional: { _id: Types.ObjectId | string; businessInfo?: { timezone?: string }; timeZone?: string };
  timeZone: string;
  start: Date;
  excludeItemId?: string;
}): Promise<SelectedSupportSlot> {
  const end = new Date(params.start.getTime() + 30 * 60 * 1000);
  if (params.start.getTime() <= Date.now()) {
    throw new UserFacingError(409, "Choose a meeting time in the future.", "SLOT_UNAVAILABLE");
  }
  const availability = await getSupportAvailabilityForProfessional({
    professional: params.professional as never,
    timeZone: params.timeZone,
    from: params.start,
    to: end,
    excludeItemId: params.excludeItemId,
  });
  const slot = availability.slots.find((candidate) => candidate.start === params.start.toISOString());
  if (!slot || slot.adminIds.length === 0) {
    throw new UserFacingError(
      409,
      "That meeting time is not available. Refresh the available slots and choose another one.",
      "SLOT_UNAVAILABLE",
    );
  }
  const sortedAdminIds = [...slot.adminIds].sort();
  const admin = availability.admins.find((candidate) => String(candidate._id) === sortedAdminIds[0]);
  if (!admin) {
    throw new UserFacingError(
      409,
      "That meeting time is not available. Refresh the available slots and choose another one.",
      "SLOT_UNAVAILABLE",
    );
  }
  return { start: new Date(slot.start), end: new Date(slot.end), admin, adminIds: sortedAdminIds };
}

export function meetingSlotKeysReleaseUpdate(): Record<string, unknown> {
  // An explicit $unset avoids a stale whole-subdocument write from an
  // in-memory document that still has the old slot keys.
  return { $unset: { "meeting.slotKeys": 1 } };
}

export function isSupportMeetingPast(ticket: ISupportTicket, now = new Date()): boolean {
  const scheduledAt = ticket.meeting?.scheduledAt;
  if (!scheduledAt) return false;
  return new Date(scheduledAt).getTime() <= now.getTime();
}

export interface SetSupportMeetingLinkResult {
  ticket: ISupportTicket;
  emailSent: boolean;
  emailAttempted: boolean;
  unchanged: boolean;
}

/**
 * Persist an admin-supplied real meeting link. Pending meetings become
 * scheduled only after the link is saved; the confirmation email is sent
 * afterwards, so a mail failure can never discard or hide the real link.
 *
 * Repeating the same link is idempotent: no reservation is recreated and no
 * second confirmation is sent once one has succeeded. If the earlier email
 * failed, the same-link call retries that confirmation. A different link is a
 * real update and gets the localized link-updated email instead.
 */
export async function setSupportMeetingLink(params: {
  ticket: ISupportTicket;
  adminId: Types.ObjectId | string;
  owner: SupportEmailUser;
  meetingLink: unknown;
  now?: Date;
}): Promise<SetSupportMeetingLinkResult> {
  return setSupportMeetingLinkAttempt(params, 0);
}

async function retrySameLinkNotification(
  ticket: ISupportTicket,
  owner: SupportEmailUser,
  now?: Date,
): Promise<MeetingNotificationDelivery> {
  const meeting = ticket.meeting!;
  if (meeting.confirmationEventId && !meeting.linkEmailSentAt) {
    await reconcileConfirmationTimestamp(ticket._id, meeting.confirmationEventId);
  }
  // A replacement link whose email failed must retry the link-updated
  // template, not the original confirmation.
  if (meeting.linkUpdateEventId) {
    return deliverMeetingNotification({
      ticket,
      owner,
      eventId: meeting.linkUpdateEventId,
      type: "link_updated",
      send: sendSupportMeetingLinkUpdatedEmail,
      now,
    });
  }
  if (meeting.linkEmailSentAt || isSupportMeetingPast(ticket, now)) {
    return { emailSent: false, emailAttempted: false };
  }
  const eventId =
    meeting.confirmationEventId || supportMeetingEventId("confirmed", meeting.revision || 1);
  const delivery = await deliverMeetingNotification({
    ticket,
    owner,
    eventId,
    type: "confirmed",
    send: sendSupportMeetingConfirmedEmail,
    now,
  });
  if (delivery.emailSent) await markConfirmationTimestamp(ticket._id, eventId);
  return delivery;
}

async function setSupportMeetingLinkAttempt(
  params: {
    ticket: ISupportTicket;
    adminId: Types.ObjectId | string;
    owner: SupportEmailUser;
    meetingLink: unknown;
    now?: Date;
  },
  attempt: number,
): Promise<SetSupportMeetingLinkResult> {
  const { ticket } = params;
  if (ticket.kind !== "meeting" || !ticket.meeting) {
    throw new UserFacingError(400, "This item is not a support meeting.", "VALIDATION");
  }
  if (ticket.meeting.status === "cancelled") {
    throw new UserFacingError(409, "Cancelled meetings cannot be updated with a link.", "CONFLICT");
  }
  if (ticket.meeting.status === "completed") {
    throw new UserFacingError(409, "Completed meetings cannot be updated with a link.", "CONFLICT");
  }
  if (!["pending", "scheduled"].includes(ticket.meeting.status)) {
    throw new UserFacingError(409, "This meeting can no longer be updated with a link.", "CONFLICT");
  }
  if (ticket.status === "closed") {
    throw new UserFacingError(409, "Closed support tickets cannot receive a meeting link.", "CONFLICT");
  }
  if (!ticket.meeting.scheduledAt) {
    throw new UserFacingError(409, "This meeting has no reserved time.", "CONFLICT");
  }

  const meetingLink = assertRealHttpsMeetingLink(params.meetingLink);
  const existingLink = typeof ticket.meeting.meetingLink === "string"
    ? ticket.meeting.meetingLink
    : null;
  const isSameLink = existingLink === meetingLink;
  const isPast = isSupportMeetingPast(ticket, params.now);

  if (isSameLink && ticket.meeting.status === "scheduled") {
    const current = ticket;
    const mayRetry =
      Boolean(ticket.meeting.linkUpdateEventId) ||
      (!ticket.meeting.linkEmailSentAt && !isPast);
    const delivery = mayRetry
      ? await retrySameLinkNotification(current, params.owner, params.now)
      : { emailSent: false, emailAttempted: false };
    const fresh = await reloadMeetingTicket(ticket._id);
    return {
      ticket: fresh || current,
      emailSent: delivery.emailSent,
      emailAttempted: delivery.emailAttempted,
      unchanged: true,
    };
  }

  if (isPast) {
    throw new UserFacingError(
      409,
      "This meeting time has passed. Reschedule it before adding or changing the meeting link.",
      "CONFLICT",
    );
  }

  const firstLink = !existingLink;
  const revision = nextMeetingRevision(ticket);
  const eventId = supportMeetingEventId(firstLink ? "confirmed" : "link_updated", revision);
  const now = params.now || new Date();
  const transitionSet: Record<string, unknown> = {
    "meeting.meetingLink": meetingLink,
    // The previous confirmation timestamp is never cleared: it describes a real
    // accepted confirmation for the link that was confirmed, not this update.
    "meeting.linkAddedAt": ticket.meeting.linkAddedAt || now,
    "meeting.linkAddedBy": new Types.ObjectId(String(params.adminId)),
    "meeting.revision": revision,
    "meeting.status": "scheduled",
  };
  if (firstLink) {
    transitionSet["meeting.confirmationEventId"] = eventId;
  } else {
    transitionSet["meeting.linkUpdatedAt"] = now;
    transitionSet["meeting.linkUpdateEventId"] = eventId;
  }

  try {
    // The link write and the supersede of older events are one unit. A newer
    // cancel/reschedule cannot commit (and claim its event) between them, so an
    // older link transition can never suppress a newer notification.
    await withCalendarTransaction(async (session) => {
      await applyMeetingTransition(ticket, {
        session,
        stateFilter: {
          "meeting.status": { $in: ["pending", "scheduled"] },
          status: { $ne: "closed" },
        },
        set: transitionSet,
      });
      await supersedeSupportMeetingNotifications(ticket._id, { session, revision });
      return true;
    });
  } catch (error) {
    if ((isMeetingTransitionConflict(error) || isVersionError(error)) && attempt < 2) {
      const fresh = await reloadMeetingTicket(ticket._id);
      if (!fresh) throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
      const freshLink = typeof fresh.meeting?.meetingLink === "string"
        ? fresh.meeting.meetingLink
        : null;
      if (fresh.meeting?.status === "cancelled" || fresh.meeting?.status === "completed") {
        throw new UserFacingError(
          409,
          "This meeting changed concurrently. Refresh and try again.",
          "CONFLICT",
        );
      }
      if (freshLink && freshLink !== meetingLink) {
        throw new UserFacingError(
          409,
          "Another administrator changed this meeting link. Refresh before replacing it.",
          "CONFLICT",
        );
      }
      return setSupportMeetingLinkAttempt({ ...params, ticket: fresh }, attempt + 1);
    }
    throw error;
  }

  // Delivery is based on the persisted transition, never on the captured
  // document (the conditional update does not mutate it).
  const committed = await reloadMeetingTicket(ticket._id);
  if (!committed) {
    throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
  }
  // The link transition starts a new event; any older undelivered event was
  // already superseded in the same transaction. The delivery itself claims and
  // sends only the new event below.
  const delivery = firstLink
    ? await deliverMeetingNotification({
        ticket: committed,
        owner: params.owner,
        eventId,
        type: "confirmed",
        send: sendSupportMeetingConfirmedEmail,
        now: params.now,
      })
    : await deliverMeetingNotification({
        ticket: committed,
        owner: params.owner,
        eventId,
        type: "link_updated",
        send: sendSupportMeetingLinkUpdatedEmail,
        now: params.now,
      });

  if (delivery.emailSent && firstLink) {
    await markConfirmationTimestamp(ticket._id, eventId);
  }

  const fresh = await reloadMeetingTicket(ticket._id);
  return {
    ticket: fresh || committed,
    emailSent: delivery.emailSent,
    emailAttempted: delivery.emailAttempted,
    unchanged: false,
  };
}

export interface CancelSupportMeetingResult {
  ticket: ISupportTicket;
  emailSent: boolean;
  emailAttempted: boolean;
  alreadyCancelled?: boolean;
}

export async function cancelSupportMeeting(params: {
  ticket: ISupportTicket;
  actorId: Types.ObjectId | string;
  actorRole: "user" | "admin";
  owner?: SupportEmailUser | null;
  reason?: string;
  allowPast?: boolean;
  now?: Date;
}): Promise<CancelSupportMeetingResult> {
  return cancelSupportMeetingAttempt(params, 0);
}

async function cancelSupportMeetingAttempt(
  params: {
    ticket: ISupportTicket;
    actorId: Types.ObjectId | string;
    actorRole: "user" | "admin";
    owner?: SupportEmailUser | null;
    reason?: string;
    allowPast?: boolean;
    now?: Date;
  },
  attempt: number,
): Promise<CancelSupportMeetingResult> {
  const { ticket } = params;
  if (ticket.kind !== "meeting" || !ticket.meeting) {
    throw new UserFacingError(400, "This item is not a support meeting.", "VALIDATION");
  }
  if (ticket.meeting.status === "cancelled") {
    const eventId = ticket.meeting.cancelledEventId;
    const delivery = eventId
      ? await deliverMeetingNotification({
          ticket,
          owner: params.owner,
          eventId,
          type: "cancelled",
          send: sendSupportMeetingCancelledEmail,
          now: params.now,
        })
      : { emailSent: false, emailAttempted: false };
    return {
      ticket,
      emailSent: delivery.emailSent,
      emailAttempted: delivery.emailAttempted,
      alreadyCancelled: true,
    };
  }
  if (ticket.meeting.status === "completed") {
    throw new UserFacingError(409, "Completed meetings cannot be cancelled.", "CONFLICT");
  }
  // An unconfirmed pending meeting whose time has passed never became a real
  // meeting; letting the owner cancel it releases the stale reservation.
  const pendingWithoutLink = ticket.meeting.status === "pending" && !ticket.meeting.meetingLink;
  if (!params.allowPast && !pendingWithoutLink && isSupportMeetingPast(ticket, params.now)) {
    throw new UserFacingError(409, "This meeting has already started and cannot be cancelled.", "CONFLICT");
  }

  const revision = nextMeetingRevision(ticket);
  const eventId = supportMeetingEventId("cancelled", revision);
  const transitionSet: Record<string, unknown> = {
    "meeting.status": "cancelled",
    "meeting.cancelledAt": params.now || new Date(),
    "meeting.cancelledBy": new Types.ObjectId(String(params.actorId)),
    "meeting.cancelledByRole": params.actorRole,
    "meeting.cancelledEventId": eventId,
    "meeting.revision": revision,
    status: "closed",
  };
  const cancellationReason = params.reason?.trim().slice(0, 500);
  if (cancellationReason) transitionSet["meeting.cancellationReason"] = cancellationReason;
  try {
    await withCalendarTransaction(async (session) => {
      if (params.actorRole === "user") {
        await fenceAccountWritesInSession([ticket.userId], session);
      }
      await applyMeetingTransition(ticket, {
        session,
        stateFilter: { "meeting.status": { $in: ["pending", "scheduled"] } },
        set: transitionSet,
        unset: { "meeting.slotKeys": 1 },
      });
      await releaseCalendarReservations("support", ticket._id, session);
      await supersedeSupportMeetingNotifications(ticket._id, { session, revision });
      return true;
    });
  } catch (error) {
    if ((isMeetingTransitionConflict(error) || isVersionError(error)) && attempt < 2) {
      const fresh = await reloadMeetingTicket(ticket._id);
      if (!fresh) throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
      if (fresh.meeting?.status === "cancelled") {
        return {
          ticket: fresh,
          emailSent: false,
          emailAttempted: false,
          alreadyCancelled: true,
        };
      }
      if (fresh.meeting?.status === "completed") {
        throw new UserFacingError(409, "Completed meetings cannot be cancelled.", "CONFLICT");
      }
      // A concurrent notification hand-off or link update bumped the version.
      // Retry the same cancellation against the fresh state instead of telling
      // the actor the meeting changed when it is still cancellable.
      return cancelSupportMeetingAttempt({ ...params, ticket: fresh }, attempt + 1);
    }
    throw error;
  }

  const committed = await reloadMeetingTicket(ticket._id);
  if (!committed) {
    throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
  }
  const delivery = await deliverMeetingNotification({
    ticket: committed,
    owner: params.owner,
    eventId,
    type: "cancelled",
    send: sendSupportMeetingCancelledEmail,
    now: params.now,
  });
  const fresh = await reloadMeetingTicket(ticket._id);
  return {
    ticket: fresh || committed,
    emailSent: delivery.emailSent,
    emailAttempted: delivery.emailAttempted,
  };
}

export async function completeSupportMeeting(params: {
  ticket: ISupportTicket;
  actorId: Types.ObjectId | string;
  /** Injectable clock for tests and callers that need a deterministic time. */
  now?: Date;
}): Promise<ISupportTicket> {
  return completeSupportMeetingAttempt(params, 0);
}

async function completeSupportMeetingAttempt(
  params: { ticket: ISupportTicket; actorId: Types.ObjectId | string; now?: Date },
  attempt: number,
): Promise<ISupportTicket> {
  const { ticket } = params;
  if (ticket.kind !== "meeting" || !ticket.meeting) {
    throw new UserFacingError(400, "This item is not a support meeting.", "VALIDATION");
  }
  if (ticket.meeting.status === "completed") return ticket;
  if (ticket.meeting.status === "cancelled") {
    throw new UserFacingError(409, "Cancelled meetings cannot be completed.", "CONFLICT");
  }
  if (ticket.meeting.status !== "scheduled" || !ticket.meeting.meetingLink) {
    throw new UserFacingError(
      409,
      "This meeting is not confirmed yet. Cancel it instead, or add a meeting link first.",
      "CONFLICT",
    );
  }
  const revision = nextMeetingRevision(ticket);
  try {
    await withCalendarTransaction(async (session) => {
      await applyMeetingTransition(ticket, {
        session,
        stateFilter: { "meeting.status": "scheduled", "meeting.meetingLink": { $ne: null } },
        set: {
          "meeting.status": "completed",
          "meeting.completedAt": params.now || new Date(),
          "meeting.revision": revision,
          status: "resolved",
        },
        unset: { "meeting.slotKeys": 1 },
      });
      await releaseCalendarReservations("support", ticket._id, session);
      await supersedeSupportMeetingNotifications(ticket._id, { session, revision });
      return true;
    });
  } catch (error) {
    if ((isMeetingTransitionConflict(error) || isVersionError(error)) && attempt < 2) {
      const fresh = await reloadMeetingTicket(ticket._id);
      if (!fresh) throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
      if (fresh.meeting?.status === "completed") return fresh;
      if (fresh.meeting?.status === "cancelled") {
        throw new UserFacingError(409, "Cancelled meetings cannot be completed.", "CONFLICT");
      }
      if (fresh.meeting?.status !== "scheduled" || !fresh.meeting?.meetingLink) {
        throw new UserFacingError(
          409,
          "This meeting is not confirmed yet. Cancel it instead, or add a meeting link first.",
          "CONFLICT",
        );
      }
      return completeSupportMeetingAttempt({ ticket: fresh, actorId: params.actorId }, attempt + 1);
    }
    throw error;
  }
  const fresh = await reloadMeetingTicket(ticket._id);
  if (!fresh) {
    throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
  }
  return fresh;
}

export async function rescheduleSupportMeeting(params: {
  ticket: ISupportTicket;
  professional: { _id: Types.ObjectId | string; businessInfo?: { timezone?: string }; timeZone?: string };
  start: Date;
  timeZone: string;
  owner: SupportEmailUser;
  now?: Date;
  actorRole?: "user" | "admin";
  /** Support admins may repair a pending, unconfirmed meeting whose slot passed. */
  allowPastPending?: boolean;
}): Promise<{ ticket: ISupportTicket; emailSent: boolean; emailAttempted: boolean }> {
  return rescheduleSupportMeetingAttempt(params, 0);
}

async function rescheduleSupportMeetingAttempt(
  params: {
    ticket: ISupportTicket;
    professional: { _id: Types.ObjectId | string; businessInfo?: { timezone?: string }; timeZone?: string };
    start: Date;
    timeZone: string;
    owner: SupportEmailUser;
    now?: Date;
    actorRole?: "user" | "admin";
    allowPastPending?: boolean;
  },
  attempt: number,
): Promise<{ ticket: ISupportTicket; emailSent: boolean; emailAttempted: boolean }> {
  const { ticket } = params;
  if (ticket.kind !== "meeting" || !ticket.meeting) {
    throw new UserFacingError(400, "This item is not a support meeting.", "VALIDATION");
  }
  if (ticket.meeting.status === "cancelled" || ticket.meeting.status === "completed") {
    throw new UserFacingError(409, "This meeting can no longer be rescheduled.", "CONFLICT");
  }
  if (!["pending", "scheduled"].includes(ticket.meeting.status)) {
    throw new UserFacingError(409, "This meeting can no longer be rescheduled.", "CONFLICT");
  }
  const pendingWithoutLink = ticket.meeting.status === "pending" && !ticket.meeting.meetingLink;
  if (isSupportMeetingPast(ticket, params.now) && !(params.allowPastPending && pendingWithoutLink)) {
    throw new UserFacingError(409, "Past meetings cannot be rescheduled.", "CONFLICT");
  }

  const selected = await selectSupportMeetingSlot({
    professional: params.professional,
    timeZone: params.timeZone,
    start: params.start,
    excludeItemId: String(ticket._id),
  });

  // Repeating the exact reschedule is an idempotent retry of its notification,
  // not a new transition or reservation move.
  if (
    ticket.meeting.scheduledAt &&
    new Date(ticket.meeting.scheduledAt).getTime() === selected.start.getTime()
  ) {
    const eventId = ticket.meeting.rescheduledEventId;
    const current = ticket;
    const delivery = eventId
      ? await deliverMeetingNotification({
          ticket: current,
          owner: params.owner,
          eventId,
          type: "rescheduled",
          send: sendSupportMeetingRescheduledEmail,
          now: params.now,
        })
      : { emailSent: false, emailAttempted: false };
    const fresh = await reloadMeetingTicket(ticket._id);
    return { ticket: fresh || current, ...delivery };
  }

  const previousScheduledAt = ticket.meeting.scheduledAt;
  const revision = nextMeetingRevision(ticket);
  const eventId = supportMeetingEventId("rescheduled", revision);
  const transitionSet: Record<string, unknown> = {
    "meeting.scheduledAt": selected.start,
    "meeting.timeZone": params.timeZone,
    "meeting.adminId": new Types.ObjectId(String(selected.admin._id)),
    "meeting.slotKeys": buildSupportMeetingSlotKeys(
      selected.admin._id,
      params.professional._id,
      selected.start,
    ),
    // A pending meeting must stay pending after a reschedule: only a real link
    // makes it scheduled. A confirmed meeting stays scheduled with its link.
    "meeting.status": ticket.meeting.meetingLink ? "scheduled" : "pending",
    "meeting.rescheduledEventId": eventId,
    "meeting.revision": revision,
  };
  if (previousScheduledAt) transitionSet["meeting.previousScheduledAt"] = previousScheduledAt;
  if (ticket.meeting.timeZone) transitionSet["meeting.previousTimeZone"] = ticket.meeting.timeZone;
  const end = new Date(selected.start.getTime() + 30 * 60 * 1000);
  try {
    await withCalendarTransaction(async (session) => {
      if ((params.actorRole || "user") === "user") {
        await fenceAccountWritesInSession([ticket.userId], session);
      }
      await releaseCalendarReservations("support", ticket._id, session);
      await reserveCalendarKeys(
        {
          sourceType: "support",
          sourceId: ticket._id,
          keys: [
            ...buildCalendarReservationKeysForInterval({
              role: "admin",
              userId: selected.admin._id,
              startAt: selected.start,
              endAt: end,
            }),
            ...buildCalendarReservationKeysForInterval({
              role: "professional",
              userId: params.professional._id,
              startAt: selected.start,
              endAt: end,
            }),
          ],
        },
        session,
      );
      await applyMeetingTransition(ticket, {
        session,
        stateFilter: { "meeting.status": { $in: ["pending", "scheduled"] } },
        set: transitionSet,
      });
      await supersedeSupportMeetingNotifications(ticket._id, { session, revision });
      return true;
    });
  } catch (error) {
    if (isDuplicateKeyError(error) && duplicateField(error).includes("slotKeys")) {
      throw new UserFacingError(
        409,
        "That meeting time was just taken. Refresh the available slots and choose another one.",
        "SLOT_UNAVAILABLE",
      );
    }
    if ((isMeetingTransitionConflict(error) || isVersionError(error)) && attempt < 2) {
      const fresh = await reloadMeetingTicket(ticket._id);
      if (!fresh) throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
      const sameTarget = fresh.meeting?.scheduledAt &&
        new Date(fresh.meeting.scheduledAt).getTime() === selected.start.getTime();
      if (sameTarget) {
        return rescheduleSupportMeetingAttempt({ ...params, ticket: fresh }, attempt + 1);
      }
      throw new UserFacingError(
        409,
        "This meeting changed concurrently. Refresh and try again.",
        "CONFLICT",
      );
    }
    throw error;
  }

  const committed = await reloadMeetingTicket(ticket._id);
  if (!committed) {
    throw new UserFacingError(404, "Support meeting not found.", "NOT_FOUND");
  }
  const delivery = await deliverMeetingNotification({
    ticket: committed,
    owner: params.owner,
    eventId,
    type: "rescheduled",
    send: sendSupportMeetingRescheduledEmail,
    now: params.now,
  });
  const fresh = await reloadMeetingTicket(ticket._id);
  return { ticket: fresh || committed, emailSent: delivery.emailSent, emailAttempted: delivery.emailAttempted };
}
