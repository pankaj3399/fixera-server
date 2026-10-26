import mongoose, { type ClientSession, Types } from "mongoose";
import User from "../models/user";
import AccountDataGuard from "../models/accountDataGuard";
import AuditLog from "../models/auditLog";
import Booking from "../models/booking";
import ChatMessage from "../models/chatMessage";
import ChatReport from "../models/chatReport";
import Conversation from "../models/conversation";
import EmailLog from "../models/emailLog";
import Favorite from "../models/favorite";
import MarketingSubscriber from "../models/marketingSubscriber";
import MarketingSuppression from "../models/marketingSuppression";
import Meeting from "../models/meeting";
import MeetingRequest from "../models/meetingRequest";
import Notification from "../models/notification";
import Payment from "../models/payment";
import PointTransaction from "../models/pointTransaction";
import ProfileView from "../models/profileView";
import Project from "../models/project";
import Referral from "../models/referral";
import SupportMeetingNotification from "../models/supportMeetingNotification";
import SupportTicket from "../models/supportTicket";
import WarrantyClaim from "../models/warrantyClaim";
import BacklinkSubmission from "../models/backlinkSubmission";
import CancellationRequest from "../models/cancellationRequest";
import { isAllowedS3Url, parseS3KeyFromUrl, deleteFromS3 } from "./s3Upload";
import {
  releaseCalendarReservations,
  withCalendarTransaction,
} from "./support/calendarReservations";
import { beginAccountDataRemoval } from "./support/accountGuard";
import { invalidateFavoritesOverviewCache } from "../handlers/Admin/favoritesAdmin";
import {
  ANONYMIZED_MESSAGE,
  ANONYMIZED_TEXT,
  ANONYMIZED_USER_NAME,
} from "./accountAnonymity";

const CLAIM_TTL_MS = 15 * 60 * 1000;
const ANONYMIZED_NAME = ANONYMIZED_USER_NAME;

const ACTIVE_BOOKING_STATUSES = [
  "rfq",
  "rfq_accepted",
  "draft_quote",
  "quoted",
  "quote_accepted",
  "payment_pending",
  "booked",
  "rescheduling_requested",
  "in_progress",
  "professional_completed",
  "dispute",
] as const;

const ACTIVE_CANCELLATION_STATUSES = [
  "pending",
  "processing",
  "negotiating",
  "escalated",
] as const;

const ACTIVE_WARRANTY_STATUSES = [
  "open",
  "proposal_sent",
  "proposal_accepted",
  "escalated",
] as const;

const PENDING_REFUND_STATUSES = ["pending", "requires_action"] as const;

const ACTIVE_SUPPORT_MEETING_STATUSES = ["pending", "scheduled"] as const;
const ACTIVE_MEETING_REQUEST_STATUSES = ["pending", "scheduled"] as const;
const ACTIVE_MEETING_STATUSES = ["scheduled", "rescheduled"] as const;

/** A recorded professional payout with no settled transfer is still owed. */
const transferObligationConditions = (path = "") => {
  const field = (name: string) => (path ? `${path}.${name}` : name);
  return [
    { [field("transferStatus")]: "pending" },
    {
      [field("transferStatus")]: "failed",
      [field("transferredAt")]: null,
      [field("professionalPayout")]: { $gt: 0 },
    },
    {
      [field("metadata.transferFailed")]: true,
      [field("transferStatus")]: { $ne: "succeeded" },
      [field("transferredAt")]: null,
      [field("professionalPayout")]: { $gt: 0 },
    },
    {
      [field("transferStatus")]: null,
      [field("stripeTransferId")]: null,
      [field("professionalPayout")]: { $gt: 0 },
    },
  ];
};

const extraCostTransferObligationConditions = [
  { extraCostTransferStatus: "pending" },
  {
    extraCostTransferStatus: "failed",
    extraCostPaymentSucceeded: true,
    extraCostProfessionalPayout: { $gt: 0 },
  },
  {
    extraCostTransferStatus: null,
    extraCostTransferId: null,
    extraCostPaymentSucceeded: true,
    extraCostProfessionalPayout: { $gt: 0 },
  },
];

const paymentObligationFilter = (userId: Types.ObjectId) => ({
  $and: [
    targetPaymentFilter(userId),
    {
      $or: [
        { status: { $in: ["pending", "authorized", "disputed"] } },
        ...transferObligationConditions(),
        { extraCostStatus: "pending" },
        ...extraCostTransferObligationConditions,
      ],
    },
  ],
});

const bookingPaymentObligationFilter = (bookingFilter: AnyDoc) => ({
  $and: [
    bookingFilter,
    {
      $or: [
        { "payment.extraCostRefundPending": true },
        { "payment.extraCostStatus": "pending" },
        { "payment.status": { $in: ["pending", "authorized", "disputed"] } },
        ...transferObligationConditions("payment"),
      ],
    },
  ],
});

/**
 * Upload roots whose key contains the uploader id as a complete path segment,
 * or whose records are proven target-owned before the URL is read. Invoice
 * roots are deliberately absent: retained invoice artifacts are never deleted.
 */
const OWNED_UPLOAD_ROOTS = [
  "profile-images",
  "id-proof",
  "id-proofs",
  "certifications",
  "project-images",
  "project-videos",
  "project-attachments",
  "projects",
  "review-images",
  "reviews",
  "warranty-claims",
  "rfq-attachments",
  "quotation-attachments",
  "completion-attachments",
  "dispute-attachments",
  "chat",
  "support-attachments",
] as const;

const RETAINED_CATEGORIES = [
  {
    category: "bookings",
    label: "Booking and service facts",
    reason:
      "Kept for contract history, schedule history, and counterparty access. Party display values and owned files are redacted.",
  },
  {
    category: "payments",
    label: "Payments, refunds, and transfers",
    reason:
      "Kept for settlement, reconciliation, and financial audit. Amounts, statuses, provider ids, and stable user ids stay unchanged.",
  },
  {
    category: "invoices",
    label: "Invoices and credit notes",
    reason:
      "Invoice numbers, credit-note numbers, artifact history, and files under the invoice root are retained evidence and are not deleted.",
  },
  {
    category: "disputes",
    label: "Dispute and cancellation decisions",
    reason:
      "Financial outcomes, admin decisions, and statuses stay. Target-authored narrative and target-owned evidence files are redacted.",
  },
  {
    category: "warranty",
    label: "Warranty decisions",
    reason:
      "Warranty status, deadlines, and resolution outcomes stay. Target-authored narrative and target-owned evidence files are redacted.",
  },
  {
    category: "support",
    label: "Support history",
    reason:
      "Ticket, meeting, and reply rows stay without the target's content so support audit and counterparty context still resolve.",
  },
  {
    category: "audit",
    label: "Anonymization audit",
    reason:
      "A minimal record keeps the stable target id, admin id, action, time, outcome, and counts. It does not store the old name or email.",
  },
] as const;

const WARNINGS = [
  "External provider records (for example Stripe, Brevo, and Odoo) are not changed by this endpoint.",
  "Invoices and credit-note files are retained as financial evidence and are not deleted.",
  "Counterparty-authored, admin-authored, and unknown-authorship free text inside retained records is preserved by policy and is not rewritten.",
  "Legacy notifications and email logs without recorded actor provenance are only redacted when their entity relationship identifies a target-owned booking, conversation, project, or request. Records with no such provenance are retained and are not matched by name or email text.",
];

export type AnonymizationBlocker = {
  code: string;
  message: string;
  count?: number;
};

export type AnonymizationCleanup = {
  pendingFiles: number;
  pendingCalendarReleases: number;
  deletedFiles: number;
  failedFiles: number;
  completedAt: Date | null;
  lastError: string | null;
};

export type AnonymizationPreview = {
  target: {
    id: string;
    role: string;
    name: string | null;
    email: string | null;
    accountStatus: string | null;
    professionalStatus: string | null;
    deletedAt: Date | null;
    isAnonymized: boolean;
    identityRemoved: boolean;
    accessDisabled?: boolean;
    needsRedaction?: boolean;
    legacyAnonymized?: boolean;
  };
  status: "eligible" | "blocked" | "already_anonymized" | "recovery_required";
  eligible: boolean;
  alreadyAnonymized: boolean;
  recoveryRequired: boolean;
  fullyAnonymized: boolean;
  blockers: AnonymizationBlocker[];
  impact: {
    bookings: { total: number; active: number; asCustomer: number; asProfessional: number };
    payments: { total: number; invoiceRecords: number; pendingObligations: number };
    refunds: { total: number; pending: number };
    disputes: { total: number; active: number };
    warrantyClaims: { total: number; active: number };
    cancellationRequests: { total: number; active: number };
    supportTickets: number;
    chatMessages: number;
    meetings: number;
    projects: number;
    marketingSubscribers: number;
    notifications: number;
    emailLogs: number;
  };
  retained: typeof RETAINED_CATEGORIES;
  cleanup: AnonymizationCleanup;
  confirmation: { requiredText: "ANONYMIZE" };
  warnings: string[];
};

export type AnonymizedRedactionCounts = {
  profile: true;
  supportTickets: number;
  chatMessages: number;
  meetings: number;
  bookingRecords: number;
  projects: number;
  marketingSubscribers: number;
  notifications: number;
  emailLogs: number;
  s3Objects: number;
};

export type AnonymizationResult = {
  outcome: "anonymized" | "partially_completed" | "already_anonymized";
  fullyAnonymized: boolean;
  target: {
    id: string;
    role: string;
    deletedAt: Date | null;
    isAnonymized: boolean;
    anonymizedAt: Date | null;
  };
  redacted: AnonymizedRedactionCounts;
  cleanup: AnonymizationCleanup;
  warnings: string[];
};

export type RecoverableAnonymizationAccount = {
  targetId: string;
  role: string;
  state: "partial_cleanup" | "recovery_in_progress" | "recovery_required";
  isAnonymized: boolean;
  accessDisabled: boolean;
  identityRemoved: boolean;
  legacyAnonymized: boolean;
  needsRedaction: boolean;
  deletedAt: Date | null;
  anonymizedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  pendingFiles: number;
  pendingCalendarReleases: number;
  lastError: string | null;
  previewPath: string;
};

export type AnonymizeResult = {
  userId: string;
  anonymizedAt: Date;
  redactedMessageCount: number;
  fullyAnonymized?: boolean;
  cleanupPendingFiles?: number;
};

export class AnonymizationError extends Error {
  readonly expose = true;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AnonymizationError";
  }
}

type AnyDoc = Record<string, any>;

type CollectedData = {
  user: AnyDoc;
  bookings: AnyDoc[];
  conversationIds: Types.ObjectId[];
  supportTickets: AnyDoc[];
  chatMessages: AnyDoc[];
  meetings: AnyDoc[];
  meetingRequests: AnyDoc[];
  cancellationRequests: AnyDoc[];
  warrantyClaims: AnyDoc[];
  projects: AnyDoc[];
  bookingIds: Types.ObjectId[];
  projectIds: Types.ObjectId[];
  keys: string[];
};

const idString = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof (value as any).toHexString === "function") return (value as any).toHexString();
  if (typeof (value as any)._id !== "undefined") return idString((value as any)._id);
  return String(value);
};

const toObjectId = (value: unknown): Types.ObjectId | null => {
  const text = String(value || "");
  return /^[a-f0-9]{24}$/i.test(text) ? new Types.ObjectId(text) : null;
};

const placeholderEmail = (id: Types.ObjectId | string) => `deleted-${String(id)}@anon.local`;
const placeholderPhone = (id: Types.ObjectId | string) => `DELETED-${String(id)}`;

/**
 * The older writer saved the placeholder name, id-derived email, and
 * id-derived phone in one document update. One placeholder is not proof: a
 * half-written row must stay a recovery candidate so the current redaction
 * path can finish it.
 */
const isLegacyAnonymized = (user: AnyDoc): boolean => {
  if (!user?.deletedAt) return false;
  const id = idString(user._id);
  if (!id) return false;
  const normalizedPhone = String(user.phone || "").trim().toLowerCase();
  return user.name === ANONYMIZED_NAME
    && String(user.email || "").trim().toLowerCase() === placeholderEmail(id).toLowerCase()
    && normalizedPhone === placeholderPhone(id).toLowerCase();
};

const isAlreadyAnonymized = (user: AnyDoc): boolean =>
  user?.isAnonymized === true;

const hasLiveClaim = (user: AnyDoc, now = new Date()): boolean =>
  Boolean(
    user?.anonymizationClaimExpiresAt
      && new Date(user.anonymizationClaimExpiresAt).getTime() > now.getTime(),
  );

const targetBookingFilter = (userId: Types.ObjectId, projectIds: Types.ObjectId[] = []) => {
  const filters: AnyDoc[] = [{ customer: userId }, { professional: userId }];
  if (projectIds.length > 0) filters.push({ project: { $in: projectIds } });
  return { $or: filters };
};

const targetPaymentFilter = (userId: Types.ObjectId) => ({
  $or: [{ customer: userId }, { professional: userId }],
});

const targetMeetingFilter = (userId: Types.ObjectId | string) => ({
  $or: [
    { professionalId: userId },
    { professionalId: String(userId) },
    { "attendees.userId": String(userId) },
    { createdBy: String(userId) },
  ],
});

const ownedS3Key = (value: unknown, userId: string): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  let key: string | null = null;
  if (/^https?:\/\//i.test(trimmed)) {
    if (!isAllowedS3Url(trimmed)) return null;
    key = parseS3KeyFromUrl(trimmed);
  } else {
    key = trimmed.replace(/^\/+/, "");
  }
  if (!key) return null;
  const segments = key.split("/").filter(Boolean);
  if (segments.length < 3) return null;
  if (!(OWNED_UPLOAD_ROOTS as readonly string[]).includes(segments[0])) return null;
  return segments.slice(1).includes(userId) ? segments.join("/") : null;
};

const addOwnedKey = (keys: Set<string>, value: unknown, userId: string) => {
  const key = ownedS3Key(value, userId);
  if (key) keys.add(key);
};

const addOwnedKeys = (keys: Set<string>, values: unknown, userId: string) => {
  if (!Array.isArray(values)) return;
  for (const value of values) addOwnedKey(keys, value, userId);
};

const collectOwnedDeep = (
  keys: Set<string>,
  value: unknown,
  userId: string,
  depth = 0,
) => {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    addOwnedKey(keys, value, userId);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOwnedDeep(keys, item, userId, depth + 1);
    return;
  }
  if (typeof value === "object") {
    if (
      value instanceof Date
      || value instanceof Types.ObjectId
      || Buffer.isBuffer(value)
    ) return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectOwnedDeep(keys, child, userId, depth + 1);
    }
  }
};

const collectBookingKeys = (keys: Set<string>, booking: AnyDoc, userId: string) => {
  addOwnedKeys(keys, booking?.rfqData?.attachments, userId);
  addOwnedKeys(keys, booking?.completionDetails?.images, userId);
  addOwnedKeys(keys, booking?.completionDetails?.attachments, userId);
  addOwnedKeys(keys, booking?.completionAttestation?.attachments, userId);
  addOwnedKeys(keys, booking?.customerReview?.images, userId);
  addOwnedKeys(keys, booking?.dispute?.attachments, userId);
  addOwnedKeys(keys, booking?.dispute?.resolutionAttachments, userId);
  for (const message of booking?.messages || []) {
    addOwnedKeys(keys, message?.attachments, userId);
  }
  for (const cost of booking?.extraCosts || []) {
    addOwnedKeys(keys, cost?.attachments, userId);
  }
  collectOwnedDeep(keys, booking?.rfqData, userId);
  collectOwnedDeep(keys, booking?.postBookingData, userId);
  collectOwnedDeep(keys, booking?.bookingSnapshot, userId);
  collectOwnedDeep(keys, booking?.postBookingQuestionSnapshot, userId);
};

const collectProjectKeys = (keys: Set<string>, project: AnyDoc, userId: string) => {
  for (const certification of project?.certifications || []) {
    addOwnedKey(keys, certification?.fileUrl, userId);
  }
  addOwnedKeys(keys, project?.media?.images, userId);
  addOwnedKey(keys, project?.media?.video, userId);
  for (const question of project?.rfqQuestions || []) {
    addOwnedKeys(keys, question?.professionalAttachments, userId);
  }
  for (const question of project?.postBookingQuestions || []) {
    addOwnedKeys(keys, question?.professionalAttachments, userId);
  }
  collectOwnedDeep(keys, project?.previousSnapshot, userId);
  collectOwnedDeep(keys, project?.pendingChanges, userId);
};

const filterOwnedUrls = (values: unknown, userId: string): string[] => {
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value) => typeof value === "string" && value.trim() && !ownedS3Key(value, userId),
  ) as string[];
};

const sanitizeCleanupError = (failed: number): string =>
  failed > 0
    ? `Could not delete ${failed} stored file${failed === 1 ? "" : "s"}. A repeated request will retry them.`
    : "";

const cleanupFromGuard = (guard: AnyDoc | null): AnonymizationCleanup => {
  const pending = Array.isArray(guard?.externalCleanup?.pendingKeys)
    ? guard.externalCleanup.pendingKeys.filter(Boolean)
    : [];
  const pendingReleases = Array.isArray(guard?.externalCleanup?.pendingCalendarReleases)
    ? guard.externalCleanup.pendingCalendarReleases.filter(Boolean)
    : [];
  return {
    pendingFiles: pending.length,
    pendingCalendarReleases: pendingReleases.length,
    deletedFiles: 0,
    failedFiles: pending.length,
    completedAt: guard?.externalCleanup?.completedAt
      ? new Date(guard.externalCleanup.completedAt)
      : null,
    lastError: guard?.externalCleanup?.lastError || null,
  };
};

const loadGuard = async (userId: Types.ObjectId) =>
  AccountDataGuard.findById(userId).lean() as Promise<AnyDoc | null>;

const loadBlockingConditions = async (
  userId: Types.ObjectId,
  options: { role?: string; actorId?: Types.ObjectId | null; skipClaim?: boolean } = {},
): Promise<AnonymizationBlocker[]> => {
  const user = await User.findById(userId)
    .select("role deletedAt isAnonymized anonymizationClaimExpiresAt professionalStatus")
    .lean() as AnyDoc | null;
  if (!user) {
    throw new AnonymizationError(404, "NOT_FOUND", "User not found");
  }
  if (options.actorId && idString(options.actorId) === idString(userId)) {
    return [{
      code: "SELF_TARGET",
      message: "Use the self-service account deletion flow for your own account.",
    }];
  }
  if (user.role === "admin") {
    return [{
      code: "ADMIN_TARGET",
      message: "Admin accounts cannot be anonymized through this endpoint.",
    }];
  }

  const blockers: AnonymizationBlocker[] = [];
  if (user.role === "employee") {
    blockers.push({
      code: "UNSUPPORTED_ACCOUNT_ROLE",
      message: "Employee accounts are outside this endpoint's customer and professional scope.",
    });
  }
  if (!options.skipClaim && hasLiveClaim(user)) {
    blockers.push({
      code: "ANONYMIZATION_IN_PROGRESS",
      message: "Another anonymization request currently owns this account.",
    });
  }

  const projects = await Project.find({ professionalId: userId }).select("_id").lean();
  const projectIds = projects.map((project: AnyDoc) => project._id);
  const bookingFilter = targetBookingFilter(userId, projectIds);
  const bookingIds = await Booking.find(bookingFilter).distinct("_id");

  const [
    activeBookings,
    activeDisputes,
    activeWarrantyClaims,
    activeCancellationRequests,
    pendingPayments,
    pendingBookingObligations,
    pendingRefunds,
    activeSupportMeetings,
    activeMeetingRequests,
    activeMeetings,
  ] = await Promise.all([
    Booking.countDocuments({
      $and: [
        bookingFilter,
        { status: { $in: ACTIVE_BOOKING_STATUSES } },
      ],
    }),
    Booking.countDocuments({
      $and: [
        bookingFilter,
        {
          $or: [
            { status: "dispute" },
            {
              $and: [
                { "dispute.raisedBy": { $exists: true, $ne: null } },
                { "dispute.resolvedAt": { $exists: false } },
              ],
            },
          ],
        },
      ],
    }),
    WarrantyClaim.countDocuments({
      $and: [
        { $or: [{ customer: userId }, { professional: userId }] },
        { status: { $in: ACTIVE_WARRANTY_STATUSES } },
      ],
    }),
    CancellationRequest.countDocuments({
      $and: [
        {
          $or: [
            { requestedBy: userId },
            ...(bookingIds.length > 0 ? [{ booking: { $in: bookingIds } }] : []),
          ],
        },
        { status: { $in: ACTIVE_CANCELLATION_STATUSES } },
      ],
    }),
    Payment.countDocuments(paymentObligationFilter(userId)),
    Booking.countDocuments(bookingPaymentObligationFilter(bookingFilter)),
    Payment.aggregate([
      { $match: targetPaymentFilter(userId) },
      { $unwind: "$refunds" },
      { $match: { "refunds.status": { $in: PENDING_REFUND_STATUSES } } },
      { $count: "count" },
    ]),
    SupportTicket.countDocuments({
      userId,
      "meeting.status": { $in: ACTIVE_SUPPORT_MEETING_STATUSES },
    }),
    MeetingRequest.countDocuments({
      userId,
      status: { $in: ACTIVE_MEETING_REQUEST_STATUSES },
    }),
    Meeting.countDocuments({
      $and: [
        targetMeetingFilter(userId),
        { status: { $in: ACTIVE_MEETING_STATUSES } },
      ],
    }),
  ]);

  if (activeBookings > 0) {
    blockers.push({
      code: "ACTIVE_BOOKINGS",
      message: `${activeBookings} booking${activeBookings === 1 ? "" : "s"} still have an active lifecycle state.`,
      count: activeBookings,
    });
  }
  if (activeDisputes > 0) {
    blockers.push({
      code: "ACTIVE_DISPUTES",
      message: `${activeDisputes} dispute${activeDisputes === 1 ? "" : "s"} are still unresolved.`,
      count: activeDisputes,
    });
  }
  if (activeWarrantyClaims > 0) {
    blockers.push({
      code: "ACTIVE_WARRANTY_CLAIMS",
      message: `${activeWarrantyClaims} warranty claim${activeWarrantyClaims === 1 ? "" : "s"} are still open.`,
      count: activeWarrantyClaims,
    });
  }
  if (activeCancellationRequests > 0) {
    blockers.push({
      code: "ACTIVE_CANCELLATION_REQUESTS",
      message: `${activeCancellationRequests} cancellation request${activeCancellationRequests === 1 ? "" : "s"} still need a decision.`,
      count: activeCancellationRequests,
    });
  }
  const meetingObligations = activeSupportMeetings + activeMeetingRequests + activeMeetings;
  if (meetingObligations > 0) {
    blockers.push({
      code: "ACTIVE_MEETINGS",
      message: `${meetingObligations} support or project meeting${meetingObligations === 1 ? "" : "s"} still need a decision or completion.`,
      count: meetingObligations,
    });
  }
  const paymentObligations =
    pendingPayments
    + pendingBookingObligations
    + Number(pendingRefunds[0]?.count || 0);
  if (paymentObligations > 0) {
    blockers.push({
      code: "PAYMENT_OBLIGATIONS",
      message: `${paymentObligations} payment or refund obligation${paymentObligations === 1 ? "" : "s"} are still open.`,
      count: paymentObligations,
    });
  }
  return blockers;
};

export async function previewAccountAnonymization(
  targetId: string | Types.ObjectId,
  options: { actorId?: string | Types.ObjectId | null } = {},
): Promise<AnonymizationPreview> {
  const id = toObjectId(targetId);
  if (!id) throw new AnonymizationError(400, "VALIDATION", "Invalid userId");
  const actorId = options.actorId ? toObjectId(options.actorId) : null;

  const user = await User.findById(id)
    .select("+anonymizationClaimId")
    .lean() as AnyDoc | null;
  if (!user) throw new AnonymizationError(404, "NOT_FOUND", "User not found");

  const alreadyAnonymized = isAlreadyAnonymized(user);
  const legacyAnonymized = !alreadyAnonymized && isLegacyAnonymized(user);
  const recoveryRequired = Boolean(user.deletedAt && !alreadyAnonymized);
  const guard = await loadGuard(id);
  const cleanup = cleanupFromGuard(guard);
  const fullyAnonymized = alreadyAnonymized
    && cleanup.pendingFiles === 0
    && cleanup.pendingCalendarReleases === 0
    && (!guard || guard.state === "anonymized");

  const [blockers, projects, bookingsAsCustomer] = await Promise.all([
    alreadyAnonymized
      ? Promise.resolve([] as AnonymizationBlocker[])
      : loadBlockingConditions(id, {
          role: user.role,
          actorId,
          skipClaim: false,
        }),
    Project.find({ professionalId: id }).select("_id").lean(),
    Booking.countDocuments({ customer: id }),
  ]);

  const projectIds = projects.map((project: AnyDoc) => project._id);
  const bookingFilter = targetBookingFilter(id, projectIds);
  const professionalBookingFilter = {
    $or: [
      { professional: id },
      ...(projectIds.length > 0 ? [{ project: { $in: projectIds } }] : []),
    ],
  };
  const bookingIds = await Booking.find(bookingFilter).distinct("_id");
  const [
    bookingsTotal,
    bookingsActive,
    bookingsAsProfessional,
    paymentTotal,
    invoiceRecords,
    pendingPayments,
    pendingBookingObligations,
    refundRows,
    disputeTotal,
    disputeActive,
    warrantyTotal,
    warrantyActive,
    cancellationTotal,
    cancellationActive,
    supportTickets,
    chatMessages,
    meetings,
    marketingSubscribers,
    notifications,
    emailLogs,
  ] = await Promise.all([
    Booking.countDocuments(bookingFilter),
    Booking.countDocuments({
      $and: [bookingFilter, { status: { $in: ACTIVE_BOOKING_STATUSES } }],
    }),
    Booking.countDocuments(professionalBookingFilter),
    Payment.countDocuments(targetPaymentFilter(id)),
    Payment.countDocuments({
      $and: [
        targetPaymentFilter(id),
        {
          $or: [
            { invoiceNumber: { $exists: true, $ne: "" } },
            { supplierInvoiceNumber: { $exists: true, $ne: "" } },
          ],
        },
      ],
    }),
    Payment.countDocuments(paymentObligationFilter(id)),
    Booking.countDocuments(bookingPaymentObligationFilter(bookingFilter)),
    Payment.aggregate([
      { $match: targetPaymentFilter(id) },
      { $unwind: "$refunds" },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pending: {
            $sum: {
              $cond: [
                { $in: ["$refunds.status", [...PENDING_REFUND_STATUSES]] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Booking.countDocuments({
      $and: [
        bookingFilter,
        { "dispute.raisedBy": { $exists: true, $ne: null } },
      ],
    }),
    Booking.countDocuments({
      $and: [
        bookingFilter,
        {
          $or: [
            { status: "dispute" },
            {
              $and: [
                { "dispute.raisedBy": { $exists: true, $ne: null } },
                { "dispute.resolvedAt": { $exists: false } },
              ],
            },
          ],
        },
      ],
    }),
    WarrantyClaim.countDocuments({
      $or: [{ customer: id }, { professional: id }],
    }),
    WarrantyClaim.countDocuments({
      $and: [
        { $or: [{ customer: id }, { professional: id }] },
        { status: { $in: ACTIVE_WARRANTY_STATUSES } },
      ],
    }),
    CancellationRequest.countDocuments({
      $or: [
        { requestedBy: id },
        ...(bookingIds.length > 0 ? [{ booking: { $in: bookingIds } }] : []),
      ],
    }),
    CancellationRequest.countDocuments({
      $and: [
        {
          $or: [
            { requestedBy: id },
            ...(bookingIds.length > 0 ? [{ booking: { $in: bookingIds } }] : []),
          ],
        },
        { status: { $in: ACTIVE_CANCELLATION_STATUSES } },
      ],
    }),
    SupportTicket.countDocuments({ userId: id }),
    ChatMessage.countDocuments({ senderId: id }),
    Meeting.countDocuments(targetMeetingFilter(id)),
    MarketingSubscriber.countDocuments({ userId: id }),
    Notification.countDocuments({
      $or: [{ userId: id }, { actorId: id }, { subjectUserId: id }],
    }),
    EmailLog.countDocuments({
      $or: [
        { relatedUser: id },
        { actorId: id },
        ...(isAlreadyAnonymized(user) || !user.email
          ? []
          : [{ to: String(user.email).toLowerCase() }]),
      ],
    }),
  ]);

  const refundStats = refundRows[0] || { total: 0, pending: 0 };
  const paymentObligations =
    pendingPayments
    + pendingBookingObligations
    + Number(refundStats.pending || 0);
  const warnings = [...WARNINGS];
  if (legacyAnonymized) {
    warnings.push(
      "This account was redacted by an older anonymization flow. A confirmed request will complete the current database and file redaction after open records are resolved.",
    );
  }
  if (user.deletedAt && !isAlreadyAnonymized(user) && !legacyAnonymized) {
    warnings.push(
      "This account is locked and read-masked, but database identity redaction has not committed. Resolve any blockers, then repeat the confirmed request.",
    );
  }
  if (user.deletedAt && !isAlreadyAnonymized(user) && !legacyAnonymized && !guard) {
    warnings.push(
      "No redaction phase or cleanup ledger proves that the old identity was removed. Treat this account as access-disabled and needing redaction, not as legacy-redacted.",
    );
  }
  if (alreadyAnonymized && !guard) {
    warnings.push(
      "This account was anonymized before cleanup tracking existed. Existing database and file cleanup cannot be verified from a ledger.",
    );
  }
  if (cleanup.pendingFiles > 0) {
    warnings.push(
      `${cleanup.pendingFiles} stored file${cleanup.pendingFiles === 1 ? "" : "s"} still need deletion. A repeated request will retry them.`,
    );
  }
  if (cleanup.pendingCalendarReleases > 0) {
    warnings.push(
      `${cleanup.pendingCalendarReleases} calendar cleanup task${cleanup.pendingCalendarReleases === 1 ? "" : "s"} still need a retry.`,
    );
  }
  if (recoveryRequired && !legacyAnonymized) {
    warnings.push(
      "A previous attempt tombstoned this account before database redaction finished. Blockers are checked again; repeat the confirmed request only when none remain.",
    );
  }

  const status: AnonymizationPreview["status"] = alreadyAnonymized
    ? "already_anonymized"
    : blockers.length > 0
      ? "blocked"
      : recoveryRequired
        ? "recovery_required"
        : "eligible";
  const identityRemoved = alreadyAnonymized || legacyAnonymized;
  const privacyBoundary = Boolean(user.deletedAt || user.isAnonymized || legacyAnonymized);

  return {
    target: {
      id: idString(id),
      role: String(user.role || ""),
      name: user.deletedAt ? null : user.name || null,
      email: user.deletedAt ? null : user.email || null,
      accountStatus: user.deletedAt ? "rejected" : user.accountStatus || null,
      professionalStatus: user.professionalStatus || null,
      deletedAt: user.deletedAt || null,
      isAnonymized: privacyBoundary,
      identityRemoved,
      accessDisabled: Boolean(user.deletedAt),
      needsRedaction: !identityRemoved,
      ...(legacyAnonymized ? { legacyAnonymized: true } : {}),
    },
    status,
    eligible: !alreadyAnonymized && blockers.length === 0,
    alreadyAnonymized,
    recoveryRequired,
    fullyAnonymized,
    blockers,
    impact: {
      bookings: {
        total: bookingsTotal,
        active: bookingsActive,
        asCustomer: bookingsAsCustomer,
        asProfessional: bookingsAsProfessional,
      },
      payments: {
        total: paymentTotal,
        invoiceRecords,
        pendingObligations: paymentObligations,
      },
      refunds: {
        total: Number(refundStats.total || 0),
        pending: Number(refundStats.pending || 0),
      },
      disputes: { total: disputeTotal, active: disputeActive },
      warrantyClaims: { total: warrantyTotal, active: warrantyActive },
      cancellationRequests: { total: cancellationTotal, active: cancellationActive },
      supportTickets,
      chatMessages,
      meetings,
      projects: projects.length,
      marketingSubscribers,
      notifications,
      emailLogs,
    },
    retained: RETAINED_CATEGORIES,
    cleanup,
    confirmation: { requiredText: "ANONYMIZE" },
    warnings,
  };
}

export async function listRecoverableAnonymizations(
  options: { page?: number; limit?: number } = {},
): Promise<{
  accounts: RecoverableAnonymizationAccount[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  counts: {
    partialCleanup: number;
    recoveryInProgress: number;
    recoveryRequired: number;
  };
}> {
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 20), 1), 100);
  const guards = await AccountDataGuard.find({
    state: { $in: ["anonymizing", "anonymized"] },
  })
    .select("_id state startedAt completedAt externalCleanup")
    .lean() as AnyDoc[];
  const guardById = new Map(guards.map((guard) => [idString(guard._id), guard]));
  const guardIds = guards
    .filter((guard) => guard.state === "anonymizing")
    .map((guard) => guard._id);

  const users = await User.find({
    $or: [
      ...(guardIds.length > 0 ? [{ _id: { $in: guardIds } }] : []),
      { deletedAt: { $type: "date" } },
    ],
    role: { $in: ["customer", "professional"] },
  })
    .select("_id role deletedAt isAnonymized anonymizedAt name email phone")
    .lean() as AnyDoc[];

  const accounts: RecoverableAnonymizationAccount[] = [];
  for (const user of users) {
    const targetId = idString(user._id);
    const guard = guardById.get(targetId);
    const guardAnonymizing = guard?.state === "anonymizing";
    const identityRemoved = isAlreadyAnonymized(user) || isLegacyAnonymized(user);
    const accessDisabled = Boolean(user.deletedAt);
    const recoveryRequired = accessDisabled && !identityRemoved;
    const pendingKeys = Array.isArray(guard?.externalCleanup?.pendingKeys)
      ? guard.externalCleanup.pendingKeys.filter(Boolean)
      : [];
    const pendingReleases = Array.isArray(guard?.externalCleanup?.pendingCalendarReleases)
      ? guard.externalCleanup.pendingCalendarReleases.filter(Boolean)
      : [];
    const guardNeedsCleanup = pendingKeys.length > 0 || pendingReleases.length > 0;
    const legacyAnonymized = !isAlreadyAnonymized(user) && isLegacyAnonymized(user);
    // Older-flow redaction has no ledger. The list still has to make those
    // accounts discoverable; a completed current record with no pending work
    // stays out of the operator queue.
    if (!guardAnonymizing && !recoveryRequired && !guardNeedsCleanup && !legacyAnonymized) continue;

    const state: RecoverableAnonymizationAccount["state"] = guardAnonymizing
      || (guardNeedsCleanup && identityRemoved)
      ? identityRemoved
        ? "partial_cleanup"
        : "recovery_in_progress"
      : "recovery_required";

    accounts.push({
      targetId,
      role: String(user.role || ""),
      state,
      isAnonymized: isAlreadyAnonymized(user),
      accessDisabled,
      identityRemoved,
      legacyAnonymized,
      needsRedaction: !identityRemoved,
      deletedAt: user.deletedAt ? new Date(user.deletedAt) : null,
      anonymizedAt: user.anonymizedAt ? new Date(user.anonymizedAt) : null,
      startedAt: guard?.startedAt ? new Date(guard.startedAt) : user.deletedAt ? new Date(user.deletedAt) : null,
      completedAt: guard?.completedAt ? new Date(guard.completedAt) : null,
      pendingFiles: pendingKeys.length,
      pendingCalendarReleases: pendingReleases.length,
      lastError: guard?.externalCleanup?.lastError || null,
      previewPath: `/api/admin/users/${targetId}/anonymize/preview`,
    });
  }

  accounts.sort((left, right) => {
    const byDate =
      (left.deletedAt?.getTime() || 0) - (right.deletedAt?.getTime() || 0);
    if (byDate !== 0) return byDate;
    return left.targetId.localeCompare(right.targetId);
  });

  const counts = {
    partialCleanup: accounts.filter((account) => account.state === "partial_cleanup").length,
    recoveryInProgress: accounts.filter((account) => account.state === "recovery_in_progress").length,
    recoveryRequired: accounts.filter((account) => account.state === "recovery_required").length,
  };
  const total = accounts.length;
  const offset = (page - 1) * limit;

  return {
    accounts: accounts.slice(offset, offset + limit),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    counts,
  };
}

const collectData = async (
  userId: Types.ObjectId,
  session?: ClientSession,
): Promise<CollectedData> => {
  const user = await User.findById(userId)
    .select("+anonymizationClaimId +fcmTokens")
    .session(session ?? null)
    .lean() as AnyDoc | null;
  if (!user) throw new AnonymizationError(404, "NOT_FOUND", "User not found");

  const projects = await Project.find({ professionalId: userId })
    .session(session ?? null)
    .lean() as AnyDoc[];
  const projectIds = projects.map((project) => project._id);
  const bookings = await Booking.find(targetBookingFilter(userId, projectIds))
    .session(session ?? null)
    .lean() as AnyDoc[];
  const bookingIds = bookings.map((booking) => booking._id);
  const supportTickets = await SupportTicket.find({ userId })
    .session(session ?? null)
    .lean() as AnyDoc[];
  const chatMessages = await ChatMessage.find({ senderId: userId })
    .session(session ?? null)
    .lean() as AnyDoc[];
  const conversationIds = await Conversation.find({
    $or: [
      { customerId: userId },
      { professionalId: userId },
      { supportTargetUserId: userId },
    ],
  }).distinct("_id").session(session ?? null) as Types.ObjectId[];
  const meetings = await Meeting.find(targetMeetingFilter(userId))
    .session(session ?? null)
    .lean() as AnyDoc[];
  const meetingRequests = await MeetingRequest.find({ userId })
    .session(session ?? null)
    .lean() as AnyDoc[];
  const cancellationRequests = await CancellationRequest.find({
    $or: [
      { requestedBy: userId },
      ...(bookingIds.length > 0 ? [{ booking: { $in: bookingIds } }] : []),
    ],
  })
    .session(session ?? null)
    .lean() as AnyDoc[];
  const warrantyClaims = await WarrantyClaim.find({
    $or: [
      { customer: userId },
      { professional: userId },
      ...(bookingIds.length > 0 ? [{ booking: { $in: bookingIds } }] : []),
    ],
  })
    .session(session ?? null)
    .lean() as AnyDoc[];

  const keys = new Set<string>();
  addOwnedKey(keys, user.profileImage, idString(userId));
  addOwnedKey(keys, user.idProofUrl, idString(userId));
  addOwnedKey(keys, user.idProofFileName, idString(userId));

  for (const booking of bookings) collectBookingKeys(keys, booking, idString(userId));
  for (const project of projects) collectProjectKeys(keys, project, idString(userId));
  for (const ticket of supportTickets) {
    addOwnedKey(keys, ticket?.attachment?.key, idString(userId));
    addOwnedKey(keys, ticket?.attachment?.url, idString(userId));
  }
  for (const message of chatMessages) {
    addOwnedKeys(keys, message?.images, idString(userId));
    for (const attachment of message?.attachments || []) {
      addOwnedKey(keys, attachment?.url, idString(userId));
    }
  }
  for (const meeting of meetings) addOwnedKeys(keys, meeting?.attachments, idString(userId));
  for (const claim of warrantyClaims) {
    addOwnedKeys(keys, claim?.evidence, idString(userId));
    addOwnedKeys(keys, claim?.resolution?.attachments, idString(userId));
  }
  for (const request of cancellationRequests) {
    addOwnedKeys(keys, request?.evidence, idString(userId));
  }

  return {
    user,
    bookings,
    conversationIds,
    supportTickets,
    chatMessages,
    meetings,
    meetingRequests,
    cancellationRequests,
    warrantyClaims,
    projects,
    bookingIds,
    projectIds,
    keys: [...keys].sort(),
  };
};

const releaseClaim = async (userId: Types.ObjectId, claimId: string, session?: ClientSession) => {
  await User.updateOne(
    { _id: userId, anonymizationClaimId: claimId },
    { $unset: { anonymizationClaimId: 1, anonymizationClaimExpiresAt: 1 } },
    session ? { session } : undefined,
  );
};

const restoreFirstAttemptTombstone = async (
  userId: Types.ObjectId,
  claimId: string,
  original: {
    deletedAt?: Date | null;
    deletedBy?: Types.ObjectId | null;
    accountStatus?: string | null;
    professionalStatus?: string | null;
  },
  session?: ClientSession,
) => {
  if (original.deletedAt) {
    await releaseClaim(userId, claimId, session);
    return;
  }
  const unset: Record<string, 1> = {
    deletedAt: 1,
    deletedBy: 1,
    anonymizationClaimId: 1,
    anonymizationClaimExpiresAt: 1,
  };
  const set: Record<string, unknown> = {};
  if (original.accountStatus) set.accountStatus = original.accountStatus;
  else unset.accountStatus = 1;
  if (original.professionalStatus) set.professionalStatus = original.professionalStatus;
  else unset.professionalStatus = 1;
  await User.updateOne(
    { _id: userId, anonymizationClaimId: claimId },
    {
      ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      $unset: unset,
    },
    session ? { session } : undefined,
  );
  const guard = await AccountDataGuard.findById(userId)
    .select("state externalCleanup")
    .lean() as AnyDoc | null;
  const pendingCleanup =
    (guard?.externalCleanup?.pendingKeys || []).length
    + (guard?.externalCleanup?.pendingCalendarReleases || []).length;
  if (guard?.state === "anonymizing" && pendingCleanup === 0) {
    await AccountDataGuard.deleteOne(
      { _id: userId },
      session ? { session } : undefined,
    );
  }
};

const finalizeUser = async (
  userId: Types.ObjectId,
  actorId: Types.ObjectId,
  role: string,
  originalDeletedAt: Date | null,
  session: ClientSession,
) => {
  const now = new Date();
  const email = placeholderEmail(userId);
  const phone = placeholderPhone(userId);
  const set: Record<string, unknown> = {
    name: ANONYMIZED_NAME,
    email,
    phone,
    accountStatus: "rejected",
    isEmailVerified: false,
    isPhoneVerified: false,
    isVatVerified: false,
    isIdVerified: false,
    isAnonymized: true,
    anonymizedAt: now,
    deletedAt: originalDeletedAt || now,
    deletedBy: actorId,
    pendingIdChanges: [],
    fcmTokens: [],
    points: 0,
    totalReferrals: 0,
    completedReferrals: 0,
    marketingConsentAt: null,
    marketingOptInPending: false,
  };
  if (role === "professional") set.professionalStatus = "rejected";

  const unset: Record<string, 1> = {
    password: 1,
    username: 1,
    vatNumber: 1,
    idProofUrl: 1,
    idProofFileName: 1,
    idProofUploadedAt: 1,
    idCountryOfIssue: 1,
    idExpirationDate: 1,
    idExpiryEmailSentAt: 1,
    idExpiryReminderLastSentAt: 1,
    idExpiryReminderCount: 1,
    verificationCode: 1,
    verificationCodeExpires: 1,
    referralCode: 1,
    referredBy: 1,
    businessName: 1,
    companyAddress: 1,
    location: 1,
    businessInfo: 1,
    hourlyRate: 1,
    currency: 1,
    serviceCategories: 1,
    availability: 1,
    blockedDates: 1,
    blockedRanges: 1,
    companyAvailability: 1,
    companyBlockedDates: 1,
    companyBlockedRanges: 1,
    profileImage: 1,
    profileCompletedAt: 1,
    professionalOnboardingCompletedAt: 1,
    onboardingAgreements: 1,
    rejectionReason: 1,
    suspensionReason: 1,
    previousProfessionalStatus: 1,
    lastIdChangeRejectionReason: 1,
    approvedBy: 1,
    approvedAt: 1,
    lastFavoritesViewedAt: 1,
    employee: 1,
    timeZone: 1,
    marketingLocale: 1,
    marketingLocaleSource: 1,
    notificationPreferences: 1,
    adminTags: 1,
    adminStaff: 1,
    customerType: 1,
    manualCustomerLevelOverride: 1,
    manualProfessionalLevelOverride: 1,
    pointsExpiry: 1,
    anonymizationClaimId: 1,
    anonymizationClaimExpiresAt: 1,
  };
  await User.updateOne({ _id: userId }, { $set: set, $unset: unset }, { session });
};

const redactSupportTickets = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const userIdText = idString(userId);
  const ticketIds = data.supportTickets.map((ticket) => ticket._id);
  for (const ticket of data.supportTickets) {
    const activeMeeting = ["pending", "scheduled"].includes(ticket?.meeting?.status || "");
    const replies = (ticket.replies || []).map((reply: AnyDoc) => (
      idString(reply?.authorId) === userIdText && reply?.body
        ? { ...reply, body: ANONYMIZED_TEXT }
        : reply
    ));
    const set: Record<string, unknown> = {
      subject: ANONYMIZED_TEXT,
      description: ANONYMIZED_TEXT,
      replies,
    };
    if (
      ticket?.meeting?.cancellationReason
      && idString(ticket.meeting.cancelledBy) === userIdText
    ) {
      set["meeting.cancellationReason"] = ANONYMIZED_TEXT;
    }
    if (activeMeeting) {
      set["meeting.status"] = "cancelled";
      set["meeting.cancelledAt"] = new Date();
      set["meeting.cancelledByRole"] = "admin";
      set["meeting.cancellationReason"] = "Account anonymized";
      set.status = "closed";
    }
    const unset: Record<string, 1> = { attachment: 1 };
    if (ticket.meeting) {
      unset["meeting.slotKeys"] = 1;
      unset["meeting.meetingLink"] = 1;
    }
    await SupportTicket.updateOne(
      { _id: ticket._id },
      { $set: set, $unset: unset, $inc: { __v: 1 } },
      { session },
    );
  }
  if (ticketIds.length > 0) {
    // Internal notes are admin-authored support audit. They are retained; only
    // the target's own ticket and replies are content-redacted above.
    await SupportMeetingNotification.deleteMany(
      { ticketId: { $in: ticketIds } },
      { session },
    );
  }
};

const redactConversations = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  await Conversation.updateMany(
    {
      $or: [
        { customerId: userId },
        { professionalId: userId },
        { supportTargetUserId: userId },
      ],
    },
    {
      $pull: {
        starredBy: userId,
        archivedBy: userId,
        labels: { userId },
      },
    },
    { session },
  );
  await Conversation.updateMany(
    { lastMessageSenderId: userId },
    { $set: { lastMessagePreview: ANONYMIZED_MESSAGE } },
    { session },
  );
};

const redactChat = async (userId: Types.ObjectId, session: ClientSession) => {
  const messageUpdate = await ChatMessage.updateMany(
    { senderId: userId },
    {
      $set: {
        text: ANONYMIZED_MESSAGE,
        images: [],
        attachments: [],
      },
      $unset: {
        "reviewMeta.comment": 1,
        "reviewMeta.customerName": 1,
      },
    },
    { session },
  );
  await ChatMessage.updateMany(
    { "readBy.userId": userId },
    { $pull: { readBy: { userId } } },
    { session },
  );
  await ChatReport.deleteMany({ reportedBy: userId }, { session });
  return messageUpdate.modifiedCount || 0;
};

const isMeetingOwnedByTarget = (meeting: AnyDoc, userIdText: string): boolean =>
  idString(meeting.professionalId) === userIdText
  || idString(meeting.createdBy) === userIdText;

const collectCalendarReleases = (data: CollectedData, userId: Types.ObjectId) => {
  const userIdText = idString(userId);
  const releases: Array<{ sourceType: string; sourceId: Types.ObjectId }> = [];
  for (const ticket of data.supportTickets) {
    releases.push({ sourceType: "support", sourceId: ticket._id });
  }
  for (const request of data.meetingRequests) {
    releases.push({ sourceType: "meeting_request", sourceId: request._id });
  }
  for (const meeting of data.meetings) {
    if (isMeetingOwnedByTarget(meeting, userIdText)) {
      releases.push({ sourceType: "meeting", sourceId: meeting._id });
    }
  }
  return releases;
};

const redactMeetings = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const userIdText = idString(userId);
  let changed = 0;
  for (const meeting of data.meetings) {
    const isOwner = isMeetingOwnedByTarget(meeting, userIdText);
    const isAttendee = (meeting.attendees || []).some(
      (attendee: AnyDoc) => idString(attendee.userId) === userIdText,
    );
    if (!isOwner && !isAttendee) continue;
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (isOwner) {
      set.title = "[deleted meeting]";
      unset.description = 1;
      unset.location = 1;
      unset.meetingLink = 1;
      unset.agenda = 1;
      unset.notes = 1;
      unset.attachments = 1;
      if (
        meeting.cancellationReason
        && idString(meeting.cancelledBy) === userIdText
      ) {
        set.cancellationReason = ANONYMIZED_TEXT;
      }
      if (
        meeting.reschedulingReason
        && idString(meeting.rescheduledBy) === userIdText
      ) {
        set.reschedulingReason = ANONYMIZED_TEXT;
      }
      if (meeting.status !== "completed" && meeting.status !== "cancelled") {
        set.status = "cancelled";
        set.cancellationReason = "Account anonymized";
        set.cancelledAt = new Date();
        set.cancelledBy = userIdText;
      }
    }
    if (!isOwner && Array.isArray(meeting.attachments)) {
      const attachments = filterOwnedUrls(meeting.attachments, userIdText);
      if (attachments.length !== meeting.attachments.length) {
        set.attachments = attachments;
      }
    }
    const update: AnyDoc = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    if (isAttendee) update.$pull = { attendees: { userId: userIdText } };
    await Meeting.updateOne({ _id: meeting._id }, update, { session });
    changed += 1;
  }
  return changed;
};

const redactMeetingRequests = async (
  data: CollectedData,
  session: ClientSession,
) => {
  for (const request of data.meetingRequests) {
    await MeetingRequest.updateOne(
      { _id: request._id },
      {
        $set: {
          topic: ANONYMIZED_TEXT,
          preferredTimes: ANONYMIZED_TEXT,
        },
        $unset: { adminResponse: 1 },
      },
      { session },
    );
  }
  return data.meetingRequests.length;
};

const redactCancellationRequests = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const userIdText = idString(userId);
  let changed = 0;
  for (const request of data.cancellationRequests) {
    const set: Record<string, unknown> = {};
    const requestedByTarget = idString(request.requestedBy) === userIdText;
    if (requestedByTarget) {
      set.reason = redactCancellationText(String(request.reason || ""));
    }
    if (idString(request.professionalRespondedBy) === userIdText) {
      set.professionalNote = ANONYMIZED_TEXT;
    }
    const evidence = filterOwnedUrls(request.evidence, userIdText);
    if (evidence.length !== (request.evidence || []).length) {
      set.evidence = evidence;
    }
    if (Object.keys(set).length === 0) continue;
    await CancellationRequest.updateOne({ _id: request._id }, { $set: set }, { session });
    changed += 1;
  }
  return changed;
};

const redactWarrantyClaims = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const userIdText = idString(userId);
  let changed = 0;
  for (const claim of data.warrantyClaims) {
    const set: Record<string, unknown> = {};
    const customerTarget = idString(claim.customer) === userIdText;
    const professionalTarget = idString(claim.professional) === userIdText;
    if (customerTarget) {
      set.description = ANONYMIZED_TEXT;
      if (claim?.proposal?.customerDecision) {
        set["proposal.decisionNote"] = ANONYMIZED_TEXT;
      }
    }
    if (professionalTarget) {
      set["proposal.message"] = ANONYMIZED_TEXT;
      if (idString(claim?.resolution?.resolvedBy) === userIdText) {
        set["resolution.summary"] = ANONYMIZED_TEXT;
      }
    }
    if (idString(claim?.escalation?.escalatedBy) === userIdText) {
      set["escalation.reason"] = ANONYMIZED_TEXT;
      set["escalation.note"] = ANONYMIZED_TEXT;
    }
    const evidence = filterOwnedUrls(claim.evidence, userIdText);
    if (evidence.length !== (claim.evidence || []).length) {
      set.evidence = evidence;
    }
    const resolutionAttachments = filterOwnedUrls(
      claim?.resolution?.attachments,
      userIdText,
    );
    if (resolutionAttachments.length !== (claim?.resolution?.attachments || []).length) {
      set["resolution.attachments"] = resolutionAttachments;
    }
    const history = (claim.statusHistory || []).map((entry: AnyDoc) => (
      idString(entry.updatedBy) === userIdText && entry.note
        ? { ...entry, note: ANONYMIZED_TEXT }
        : entry
    ));
    if (JSON.stringify(history) !== JSON.stringify(claim.statusHistory || [])) {
      set.statusHistory = history;
    }
    if (Object.keys(set).length === 0) continue;
    await WarrantyClaim.updateOne({ _id: claim._id }, { $set: set }, { session });
    changed += 1;
  }
  return changed;
};

const redactProjects = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const userIdText = idString(userId);
  let changed = 0;
  for (const project of data.projects) {
    const certifications = (project.certifications || []).filter(
      (certification: AnyDoc) => !ownedS3Key(certification?.fileUrl, userIdText),
    );
    const mediaImages = filterOwnedUrls(project?.media?.images, userIdText);
    const mediaVideo = project?.media?.video && !ownedS3Key(project.media.video, userIdText)
      ? project.media.video
      : undefined;
    const media: AnyDoc = {
      ...(project.media || {}),
      images: mediaImages,
    };
    if (mediaVideo) media.video = mediaVideo;
    else delete media.video;
    const rfqQuestions = (project.rfqQuestions || []).map((question: AnyDoc) => ({
      ...question,
      professionalAttachments: filterOwnedUrls(
        question.professionalAttachments,
        userIdText,
      ),
    }));
    const postBookingQuestions = (project.postBookingQuestions || []).map((question: AnyDoc) => ({
      ...question,
      professionalAttachments: filterOwnedUrls(
        question.professionalAttachments,
        userIdText,
      ),
    }));
    const set: Record<string, unknown> = {
      status: project.status === "draft" ? "draft" : "suspended",
      certifications,
      media,
      "distance.address": ANONYMIZED_TEXT,
      "distance.useCompanyAddress": false,
      resources: [],
      rfqQuestions,
      postBookingQuestions,
      pendingChanges: [],
    };
    const unset: Record<string, 1> = {
      previousSnapshot: 1,
      adminFeedback: 1,
      "distance.location": 1,
      "distance.countryCode": 1,
      "intakeMeeting.resources": 1,
      "renovationPlanning.resources": 1,
    };
    await Project.updateOne(
      { _id: project._id },
      { $set: set, $unset: unset },
      { session },
    );
    changed += 1;
  }
  return changed;
};

const redactCancellationText = (_value: string): string => ANONYMIZED_TEXT;

const sanitizeBookingSnapshotForProfessional = (  snapshot: AnyDoc | undefined,
  userId: string,
) => {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const next: AnyDoc = { ...snapshot };
  if (snapshot.parties?.professional) {
    next.parties = {
      ...snapshot.parties,
      professional: {
        ...snapshot.parties.professional,
        displayName: ANONYMIZED_NAME,
        companyName: null,
        city: null,
        country: null,
        timezone: null,
      },
    };
  }
  if (snapshot.project?.media) {
    next.project = { ...snapshot.project };
    delete next.project.media;
  }
  if (snapshot.questions) {
    next.questions = { ...snapshot.questions };
    for (const key of ["rfq", "postBooking"]) {
      if (Array.isArray(snapshot.questions[key])) {
        next.questions[key] = snapshot.questions[key].map((question: AnyDoc) => ({
          ...question,
          professionalAttachments: filterOwnedUrls(
            question?.professionalAttachments,
            userId,
          ),
        }));
      }
    }
  }
  return next;
};

const redactFileAnswers = (answers: unknown, userId: string): unknown[] | null => {
  if (!Array.isArray(answers)) return null;
  let changed = false;
  const next = answers.map((entry: AnyDoc) => {
    if (
      entry?.fieldType === "file"
      && typeof entry?.answer === "string"
      && ownedS3Key(entry.answer, userId)
    ) {
      changed = true;
      return { ...entry, answer: ANONYMIZED_TEXT };
    }
    return entry;
  });
  return changed ? next : null;
};

const buildBookingUpdate = (
  booking: AnyDoc,
  userId: Types.ObjectId,
  isProfessional: boolean,
  isCustomer: boolean,
): AnyDoc | null => {
  const userIdText = idString(userId);
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  const rfqAttachments = filterOwnedUrls(booking?.rfqData?.attachments, userIdText);
  if (rfqAttachments.length !== (booking?.rfqData?.attachments || []).length) {
    set["rfqData.attachments"] = rfqAttachments;
  }
  const rfqAnswers = redactFileAnswers(booking?.rfqData?.answers, userIdText);
  if (rfqAnswers) set["rfqData.answers"] = rfqAnswers;
  const postBookingAnswers = redactFileAnswers(booking?.postBookingData, userIdText);
  if (postBookingAnswers) set.postBookingData = postBookingAnswers;
  if (Array.isArray(booking?.postBookingQuestionSnapshot?.questions)) {
    const questions = booking.postBookingQuestionSnapshot.questions.map((question: AnyDoc) => ({
      ...question,
      professionalAttachments: filterOwnedUrls(
        question?.professionalAttachments,
        userIdText,
      ),
    }));
    const changed = questions.some(
      (question: AnyDoc, index: number) =>
        (question.professionalAttachments || []).length
        !== (booking.postBookingQuestionSnapshot.questions[index]?.professionalAttachments || []).length,
    );
    if (changed) {
      set.postBookingQuestionSnapshot = {
        ...booking.postBookingQuestionSnapshot,
        questions,
      };
    }
  }

  if (isCustomer) {
    if (booking.bookingSnapshot) {
      set["bookingSnapshot.parties.customer.displayName"] = ANONYMIZED_NAME;
      set["bookingSnapshot.parties.customer.businessName"] = null;
      set["bookingSnapshot.parties.customer.city"] = null;
      set["bookingSnapshot.parties.customer.country"] = null;
      if (booking.bookingSnapshot.location) {
        set["bookingSnapshot.location.address"] = ANONYMIZED_TEXT;
        set["bookingSnapshot.location.city"] = null;
        set["bookingSnapshot.location.postalCode"] = null;
        set["bookingSnapshot.location.coordinates"] = [0, 0];
      }
    }
    set["location.address"] = ANONYMIZED_TEXT;
    set["location.city"] = null;
    set["location.postalCode"] = null;
    set["location.coordinates"] = [0, 0];
    if (booking.customerBlocks) {
      const blocks = booking.customerBlocks || {};
      set.customerBlocks = {
        dates: (blocks.dates || []).map((entry: AnyDoc) => ({
          ...entry,
          ...(entry?.reason ? { reason: ANONYMIZED_TEXT } : {}),
        })),
        windows: (blocks.windows || []).map((entry: AnyDoc) => ({
          ...entry,
          ...(entry?.reason ? { reason: ANONYMIZED_TEXT } : {}),
        })),
      };
    }
  }

  if (isProfessional && booking.bookingSnapshot) {
    set.bookingSnapshot = sanitizeBookingSnapshotForProfessional(
      booking.bookingSnapshot,
      userIdText,
    );
  }

  if (Array.isArray(booking.quoteVersions) && booking.quoteVersions.length > 0) {
    let versionsChanged = false;
    const quoteVersions = booking.quoteVersions.map((version: AnyDoc) => {
      const next = { ...version };
      if (
        isProfessional
        && idString(version?.createdBy) === userIdText
        && version?.changeNote
      ) {
        next.changeNote = ANONYMIZED_TEXT;
        versionsChanged = true;
      }
      if (
        idString(version?.rejectedBy) === userIdText
        && version?.rejectionReason
      ) {
        next.rejectionReason = ANONYMIZED_TEXT;
        versionsChanged = true;
      }
      if (isCustomer && version?.serviceLocation) {
        next.serviceLocation = {
          ...version.serviceLocation,
          address: ANONYMIZED_TEXT,
          city: null,
          postalCode: null,
          coordinates: [0, 0],
        };
        versionsChanged = true;
      }
      return next;
    });
    if (versionsChanged) set.quoteVersions = quoteVersions;
  }

  if (
    booking.rfqResponse
    && idString(booking.rfqResponse.respondedBy) === userIdText
    && booking.rfqResponse.rejectionReason
  ) {
    set["rfqResponse.rejectionReason"] = ANONYMIZED_TEXT;
  }
  if (isCustomer && booking.customerRejectionReason) {
    set.customerRejectionReason = ANONYMIZED_TEXT;
  }

  if (Array.isArray(booking.statusHistory) && booking.statusHistory.length > 0) {
    let historyChanged = false;
    const cancellationByTarget = Boolean(
      booking.cancellation
      && idString(booking.cancellation.cancelledBy) === userIdText,
    );
    const statusHistory = booking.statusHistory.map((entry: AnyDoc) => {
      if (!entry?.note) return entry;
      if (idString(entry.updatedBy) === userIdText) {
        historyChanged = true;
        return { ...entry, note: ANONYMIZED_TEXT };
      }
      if (
        cancellationByTarget
        && String(entry.note).startsWith("Cancellation approved by admin: ")
      ) {
        historyChanged = true;
        return {
          ...entry,
          note: `Cancellation approved by admin: ${redactCancellationText(
            String(entry.note).slice("Cancellation approved by admin: ".length),
          )}`,
        };
      }
      if (cancellationByTarget && String(entry.note).startsWith("Refund issued ")) {
        const match = String(entry.note).match(/^(Refund issued \([^)]+\) [—-] )([\s\S]*)$/);
        if (match) {
          historyChanged = true;
          return { ...entry, note: `${match[1]}${ANONYMIZED_TEXT}` };
        }
      }
      return entry;
    });
    if (historyChanged) set.statusHistory = statusHistory;
  }

  if (booking.customerReview) {
    if (isCustomer) {
      unset["customerReview.comment"] = 1;
      const reviewImages = filterOwnedUrls(booking.customerReview.images, userIdText);
      if (reviewImages.length !== (booking.customerReview.images || []).length) {
        set["customerReview.images"] = reviewImages;
      }
    }
    if (isProfessional) {
      if (booking.customerReview.reply?.comment) unset["customerReview.reply.comment"] = 1;
    }
  }
  if (isProfessional && booking.professionalReview?.comment) {
    unset["professionalReview.comment"] = 1;
  }

  if (Array.isArray(booking.messages)) {
    let messagesChanged = false;
    const messages = booking.messages.map((message: AnyDoc) => {
      if (idString(message?.senderId) !== userIdText) return message;
      messagesChanged = true;
      return {
        ...message,
        message: ANONYMIZED_MESSAGE,
        attachments: [],
      };
    });
    if (messagesChanged) set.messages = messages;
  }

  if (booking.dispute) {
    const attachments = filterOwnedUrls(booking.dispute.attachments, userIdText);
    const resolutionAttachments = filterOwnedUrls(
      booking.dispute.resolutionAttachments,
      userIdText,
    );
    if (attachments.length !== (booking.dispute.attachments || []).length) {
      set["dispute.attachments"] = attachments;
    }
    if (resolutionAttachments.length !== (booking.dispute.resolutionAttachments || []).length) {
      set["dispute.resolutionAttachments"] = resolutionAttachments;
    }
    if (idString(booking.dispute.raisedBy) === userIdText) {
      set["dispute.reason"] = ANONYMIZED_TEXT;
      set["dispute.description"] = ANONYMIZED_TEXT;
    }
  }

  if (booking.cancellation && idString(booking.cancellation.cancelledBy) === userIdText) {
    set["cancellation.reason"] = redactCancellationText(
      String(booking.cancellation.reason || ""),
    );
  }

  if (booking.rescheduleRequest) {
    if (idString(booking.rescheduleRequest.requestedBy) === userIdText) {
      set["rescheduleRequest.reason"] = ANONYMIZED_TEXT;
      set["rescheduleRequest.description"] = ANONYMIZED_TEXT;
      set["rescheduleRequest.note"] = ANONYMIZED_TEXT;
    }
    if (idString(booking.rescheduleRequest.respondedBy) === userIdText) {
      set["rescheduleRequest.responseNote"] = ANONYMIZED_TEXT;
    }
  }

  if (Array.isArray(booking.rescheduleHistory) && booking.rescheduleHistory.length > 0) {
    set.rescheduleHistory = booking.rescheduleHistory.map((entry: AnyDoc) => {
      const next = { ...entry };
      if (idString(entry?.requestedBy) === userIdText) {
        next.reason = ANONYMIZED_TEXT;
        next.description = ANONYMIZED_TEXT;
        next.note = ANONYMIZED_TEXT;
      }
      if (idString(entry?.respondedBy) === userIdText) {
        next.responseNote = ANONYMIZED_TEXT;
      }
      return next;
    });
  }

  if (booking.completionAttestation) {
    const completionAttachments = filterOwnedUrls(
      booking.completionAttestation.attachments,
      userIdText,
    );
    if (
      completionAttachments.length
      !== (booking.completionAttestation.attachments || []).length
    ) {
      set["completionAttestation.attachments"] = completionAttachments;
    }
    if (idString(booking.completionAttestation.confirmedBy) === userIdText) {
      unset["completionAttestation.notes"] = 1;
    }
  }

  if (booking.completionDetails) {
    for (const field of ["images", "attachments"]) {
      const values = booking.completionDetails[field];
      const filtered = filterOwnedUrls(values, userIdText);
      if (filtered.length !== (values || []).length) {
        set[`completionDetails.${field}`] = filtered;
      }
    }
  }

  if (booking.noShow && idString(booking.noShow.markedBy) === userIdText && booking.noShow.reason) {
    set["noShow.reason"] = ANONYMIZED_TEXT;
  }

  if (Array.isArray(booking.extraCosts) && booking.extraCosts.some((cost: AnyDoc) => cost?.attachments)) {
    set.extraCosts = booking.extraCosts.map((cost: AnyDoc) => ({
      ...cost,
      ...(cost?.attachments
        ? { attachments: filterOwnedUrls(cost.attachments, userIdText) }
        : {}),
    }));
  }

  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) return null;
  return {
    ...(Object.keys(set).length > 0 ? { $set: set } : {}),
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
  };
};

const redactBookings = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const projectIds = new Set(data.projectIds.map((id) => idString(id)));
  let changed = 0;
  for (const booking of data.bookings) {
    const customerTarget = idString(booking.customer) === idString(userId);
    const professionalTarget =
      idString(booking.professional) === idString(userId)
      || (booking.project && projectIds.has(idString(booking.project)));
    const update = buildBookingUpdate(
      booking,
      userId,
      professionalTarget,
      customerTarget,
    );
    if (!update) continue;
    await Booking.updateOne({ _id: booking._id }, update, { session });
    changed += 1;
  }
  return changed;
};

const redactAncillaryData = async (
  data: CollectedData,
  userId: Types.ObjectId,
  session: ClientSession,
) => {
  const userIdText = idString(userId);
  const projectIds = data.projectIds;
  const originalEmail = /^deleted-[a-f0-9]{24}@anon\.local$/i.test(String(data.user.email || ""))
    ? null
    : String(data.user.email || "").trim().toLowerCase();
  const email = placeholderEmail(userId);
  const cancellationIds = data.cancellationRequests.map((request) => request._id);
  const notificationRelatedEntities = [
    ...(data.bookingIds.length > 0
      ? [{ entityType: "booking", entityId: { $in: data.bookingIds } }]
      : []),
    ...(data.conversationIds.length > 0
      ? [{ entityType: "conversation", entityId: { $in: data.conversationIds } }]
      : []),
    ...(cancellationIds.length > 0
      ? [{ entityType: "cancellation_request", entityId: { $in: cancellationIds } }]
      : []),
    ...(projectIds.length > 0
      ? [{ entityType: "project", entityId: { $in: projectIds } }]
      : []),
    { entityType: "user", entityId: userId },
  ];

  const [
    notificationResult,
    actorNotificationResult,
    marketingResult,
    ,
    ,
    ,
    ,
    emailLogResult,
    actorEmailLogResult,
    relatedEmailLogResult,
  ] = await Promise.all([
    Notification.deleteMany({ userId }, { session }),
    Notification.updateMany(
      {
        userId: { $ne: userId },
        $or: [
          { actorId: userId },
          { subjectUserId: userId },
          ...notificationRelatedEntities,
        ],
      },
      {
        $set: {
          title: ANONYMIZED_TEXT,
          body: ANONYMIZED_TEXT,
        },
        $unset: { meta: 1 },
      },
      { session },
    ),
    MarketingSubscriber.deleteMany(
      {
        $or: [
          { userId },
          ...(originalEmail ? [{ emailNormalized: originalEmail }] : []),
        ],
      },
      { session },
    ),
    PointTransaction.deleteMany({ userId }, { session }),
    BacklinkSubmission.deleteMany({ userId }, { session }),
    Favorite.deleteMany({
      $or: [
        { user: userId },
        { targetType: "professional", targetId: userId },
        ...(projectIds.length > 0
          ? [{ targetType: "project", targetId: { $in: projectIds } }]
          : []),
      ],
    }, { session }),
    ProfileView.deleteMany({
      $or: [{ professional: userId }, { viewer: userId }],
    }, { session }),
    EmailLog.updateMany(
      {
        $or: [
          { relatedUser: userId },
          ...(originalEmail ? [{ to: originalEmail }] : []),
        ],
      },
      {
        $set: {
          to: email,
          subject: ANONYMIZED_TEXT,
        },
        $unset: { errorMessage: 1 },
      },
      { session },
    ),
    EmailLog.updateMany(
      { actorId: userId, relatedUser: { $ne: userId } },
      {
        $set: { subject: ANONYMIZED_TEXT },
        $unset: { errorMessage: 1 },
      },
      { session },
    ),
    ...(data.bookingIds.length > 0
      ? [EmailLog.updateMany(
          {
            relatedBooking: { $in: data.bookingIds },
            relatedUser: { $ne: userId },
          },
          {
            $set: { subject: ANONYMIZED_TEXT },
            $unset: { errorMessage: 1 },
          },
          { session },
        )]
      : []),
  ]);

  await Promise.all([
    Referral.updateMany(
      { referrer: userId },
      {
        $set: { referralCode: ANONYMIZED_TEXT, ipAddress: ANONYMIZED_TEXT },
        $unset: { revokedReason: 1 },
      },
      { session },
    ),
    Referral.updateMany(
      { referredUser: userId },
      {
        $set: { ipAddress: ANONYMIZED_TEXT },
        $unset: { revokedReason: 1 },
      },
      { session },
    ),
    Referral.updateMany(
      { referredUser: userId, status: "pending" },
      { $set: { status: "expired" } },
      { session },
    ),
    AuditLog.updateMany(
      { actor: userId },
      {
        $set: { actorEmail: email },
        $unset: { ip: 1, userAgent: 1 },
      },
      { session },
    ),
    AuditLog.updateMany(
      {
        targetId: userId,
        action: { $in: ["admin.users.anonymize", "user.anonymize"] },
      },
      { $unset: { "details.before": 1 } },
      { session },
    ),
    ...(originalEmail
      ? [MarketingSuppression.deleteMany({ emailNormalized: originalEmail }, { session })]
      : []),
  ]);

  await Promise.all([
    Booking.updateMany(
      { assignedTeamMembers: userId },
      { $pull: { assignedTeamMembers: userId } },
      { session },
    ),
    Booking.updateMany(
      { "resourcePlan.resourceId": userId },
      { $pull: { resourcePlan: { resourceId: userId } } },
      { session },
    ),
    Project.updateMany(
      {
        $or: [
          { resources: userIdText },
          { "intakeMeeting.resources": userIdText },
          { "renovationPlanning.resources": userIdText },
        ],
      },
      {
        $pull: {
          resources: userIdText,
          "intakeMeeting.resources": userIdText,
          "renovationPlanning.resources": userIdText,
        },
      },
      { session },
    ),
    mongoose.connection.collection("calendarreservations").deleteMany(
      { userId },
      { session },
    ),
  ]);

  return {
    notifications:
      (notificationResult.deletedCount || 0)
      + (actorNotificationResult.modifiedCount || 0),
    marketingSubscribers: marketingResult.deletedCount || 0,
    emailLogs:
      (emailLogResult.modifiedCount || 0)
      + (actorEmailLogResult.modifiedCount || 0)
      + (relatedEmailLogResult?.modifiedCount || 0),
  };
};

const applyDatabaseRedaction = async (
  data: CollectedData,
  userId: Types.ObjectId,
  actorId: Types.ObjectId,
  role: string,
  claimId: string,
  session: ClientSession,
) => {
  const claimUser = await User.findOne({ _id: userId, anonymizationClaimId: claimId })
    .session(session)
    .select("+anonymizationClaimId")
    .lean() as AnyDoc | null;
  if (!claimUser) {
    throw new AnonymizationError(
      409,
      "ANONYMIZATION_IN_PROGRESS",
      "Another request took over this account before redaction started.",
    );
  }

  const originalDeletedAt = claimUser.deletedAt ? new Date(claimUser.deletedAt) : null;
  const supportCount = data.supportTickets.length;
  const meetingCount = await redactMeetings(data, userId, session);
  const meetingRequestCount = await redactMeetingRequests(data, session);
  await redactSupportTickets(data, userId, session);
  await redactConversations(data, userId, session);
  const chatCount = await redactChat(userId, session);
  await redactCancellationRequests(data, userId, session);
  await redactWarrantyClaims(data, userId, session);
  const projectCount = await redactProjects(data, userId, session);
  const bookingCount = await redactBookings(data, userId, session);
  const ancillary = await redactAncillaryData(data, userId, session);

  const now = new Date();
  const pendingKeys = data.keys;
  const pendingCalendarReleases = collectCalendarReleases(data, userId);
  const cleanupPending =
    pendingKeys.length > 0 || pendingCalendarReleases.length > 0;
  await AccountDataGuard.updateOne(
    { _id: userId },
    {
      $set: {
        state: cleanupPending ? "anonymizing" : "anonymized",
        ...(cleanupPending ? {} : { completedAt: now }),
        externalCleanup: {
          pendingKeys,
          pendingCalendarReleases,
          attempts: 0,
          ...(cleanupPending ? {} : { completedAt: now }),
        },
      },
    },
    { session },
  );

  await finalizeUser(userId, actorId, role, originalDeletedAt, session);

  return {
    supportTickets: supportCount,
    meetings: meetingCount + meetingRequestCount,
    chatMessages: chatCount,
    bookingRecords: bookingCount,
    projects: projectCount,
    ...ancillary,
  };
};

const retryCleanupInternal = async (
  userId: Types.ObjectId,
  options: { queuedKeys?: string[] } = {},
): Promise<AnonymizationCleanup> => {
  const guard = await loadGuard(userId);
  const pending = new Set<string>([
    ...(guard?.externalCleanup?.pendingKeys || []).filter(Boolean),
    ...((options.queuedKeys || []).filter(Boolean)),
  ]);
  const pendingReleases: Array<{ sourceType: string; sourceId: Types.ObjectId }> =
    Array.isArray(guard?.externalCleanup?.pendingCalendarReleases)
      ? guard.externalCleanup.pendingCalendarReleases.filter(Boolean)
      : [];

  const failedReleases: Array<{ sourceType: string; sourceId: Types.ObjectId }> = [];
  for (const release of pendingReleases) {
    try {
      await releaseCalendarReservations(
        release.sourceType as any,
        release.sourceId,
      );
    } catch {
      failedReleases.push(release);
    }
  }
  if (pendingReleases.length > 0) {
    await AccountDataGuard.updateOne(
      { _id: userId },
      {
        $set: {
          "externalCleanup.pendingCalendarReleases": failedReleases,
        },
      },
    );
  }

  const deletedKeys: string[] = [];
  const failedKeys: string[] = [];
  for (const key of pending) {
    try {
      await deleteFromS3(key);
      deletedKeys.push(key);
    } catch {
      failedKeys.push(key);
    }
  }

  const now = new Date();
  if (pending.size > 0) {
    if (deletedKeys.length > 0) {
      await AccountDataGuard.updateOne(
        { _id: userId },
        { $pull: { "externalCleanup.pendingKeys": { $in: deletedKeys } } },
      );
    }
    await AccountDataGuard.updateOne(
      { _id: userId },
      {
        ...(failedKeys.length > 0
          ? { $addToSet: { "externalCleanup.pendingKeys": { $each: failedKeys } } }
          : {}),
        $set: { "externalCleanup.lastAttemptAt": now },
        $inc: { "externalCleanup.attempts": 1 },
      },
    );
  }

  const after = await loadGuard(userId);
  const remainingKeys = (after?.externalCleanup?.pendingKeys || []).filter(Boolean);
  const remainingReleases = Array.isArray(after?.externalCleanup?.pendingCalendarReleases)
    ? after.externalCleanup.pendingCalendarReleases.filter(Boolean)
    : [];
  const pendingCount = remainingKeys.length + remainingReleases.length;
  if (pendingCount === 0) {
    await AccountDataGuard.updateOne(
      { _id: userId },
      {
        $set: {
          state: "anonymized",
          completedAt: now,
          "externalCleanup.completedAt": now,
          "externalCleanup.lastError": null,
          "externalCleanup.pendingKeys": [],
          "externalCleanup.pendingCalendarReleases": [],
        },
      },
    );
  } else {
    await AccountDataGuard.updateOne(
      { _id: userId },
      {
        $set: {
          state: "anonymizing",
          "externalCleanup.lastError": sanitizeCleanupError(pendingCount),
        },
        $unset: { completedAt: 1 },
      },
    );
  }

  return {
    pendingFiles: remainingKeys.length,
    pendingCalendarReleases: remainingReleases.length,
    deletedFiles: deletedKeys.length,
    failedFiles: remainingKeys.length,
    completedAt: pendingCount === 0 ? now : null,
    lastError: pendingCount > 0 ? sanitizeCleanupError(pendingCount) : null,
  };
};

const emptyRedactionCounts = (keys: number): AnonymizedRedactionCounts => ({
  profile: true,
  supportTickets: 0,
  chatMessages: 0,
  meetings: 0,
  bookingRecords: 0,
  projects: 0,
  marketingSubscribers: 0,
  notifications: 0,
  emailLogs: 0,
  s3Objects: keys,
});

const buildResult = (
  outcome: AnonymizationResult["outcome"],
  user: AnyDoc,
  redacted: AnonymizedRedactionCounts,
  cleanup: AnonymizationCleanup,
): AnonymizationResult => {
  const fullyAnonymized = Boolean(
    (user?.isAnonymized || isLegacyAnonymized(user))
    && cleanup.pendingFiles === 0
    && cleanup.pendingCalendarReleases === 0
    && cleanup.failedFiles === 0
    && (!outcome || outcome !== "partially_completed"),
  );
  const warnings = [...WARNINGS];
  if (cleanup.pendingFiles > 0) {
    warnings.push(
      `${cleanup.pendingFiles} stored file${cleanup.pendingFiles === 1 ? "" : "s"} still need deletion. Repeat the confirmed request to retry them.`,
    );
  }
  if (cleanup.pendingCalendarReleases > 0) {
    warnings.push(
      `${cleanup.pendingCalendarReleases} calendar cleanup task${cleanup.pendingCalendarReleases === 1 ? "" : "s"} still need a retry.`,
    );
  }
  if (outcome === "already_anonymized" && !user?.isAnonymized && isLegacyAnonymized(user)) {
    warnings.push(
      "This account was anonymized before cleanup tracking existed. Current database and file cleanup cannot be verified from a ledger.",
    );
  }
  const cleanupPending =
    cleanup.pendingFiles + cleanup.pendingCalendarReleases;
  return {
    outcome: cleanupPending > 0 && outcome === "anonymized"
      ? "partially_completed"
      : outcome,
    fullyAnonymized: cleanupPending > 0 ? false : fullyAnonymized,
    target: {
      id: idString(user._id),
      role: String(user.role || ""),
      deletedAt: user.deletedAt || null,
      isAnonymized: Boolean(user.isAnonymized || user.deletedAt || isLegacyAnonymized(user)),
      anonymizedAt: user.anonymizedAt || user.deletedAt || null,
    },
    redacted,
    cleanup,
    warnings,
  };
};

export async function executeAccountAnonymization(input: {
  targetId: string | Types.ObjectId;
  actorId: string | Types.ObjectId;
  initiatedBy: "admin" | "self";
  enforceBlockers?: boolean;
}): Promise<AnonymizationResult> {
  const userId = toObjectId(input.targetId);
  const actorId = toObjectId(input.actorId);
  if (!userId) throw new AnonymizationError(400, "VALIDATION", "Invalid userId");
  if (!actorId) throw new AnonymizationError(401, "AUTH_REQUIRED", "Actor authentication required");

  const existing = await User.findById(userId)
    .select("+anonymizationClaimId")
    .lean() as AnyDoc | null;
  if (!existing) throw new AnonymizationError(404, "NOT_FOUND", "User not found");
  if (input.initiatedBy !== "self" && idString(userId) === idString(actorId)) {
    throw new AnonymizationError(
      403,
      "SELF_TARGET",
      "Use the self-service account deletion flow for your own account.",
    );
  }
  if (existing.role === "admin") {
    throw new AnonymizationError(
      403,
      "ADMIN_TARGET",
      "Admin accounts cannot be anonymized through this endpoint.",
    );
  }
  if (existing.role === "employee") {
    throw new AnonymizationError(
      403,
      "UNSUPPORTED_ACCOUNT_ROLE",
      "Employee accounts are outside this endpoint's customer and professional scope.",
    );
  }

  if (isAlreadyAnonymized(existing)) {
    const cleanup = await retryCleanupInternal(userId);
    const after = await User.findById(userId).lean() as AnyDoc | null;
    return buildResult(
      "already_anonymized",
      after || existing,
      emptyRedactionCounts(0),
      cleanup,
    );
  }

  const enforceBlockers = input.enforceBlockers !== false;
  if (enforceBlockers) {
    const blockers = await loadBlockingConditions(userId, { actorId, skipClaim: true });
    if (blockers.length > 0) {
      throw new AnonymizationError(
        409,
        "ANONYMIZE_BLOCKED",
        "This account still has open records that must be resolved before anonymization.",
        { blockers, previewPath: `/api/admin/users/${idString(userId)}/anonymize/preview` },
      );
    }
  }

  const claimId = new Types.ObjectId().toHexString();
  const now = new Date();
  const original = {
    deletedAt: existing.deletedAt || null,
    deletedBy: existing.deletedBy || null,
    accountStatus: existing.accountStatus || null,
    professionalStatus: existing.professionalStatus || null,
  };
  const claimSet: Record<string, unknown> = {
    anonymizationClaimId: claimId,
    anonymizationClaimExpiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
  };
  if (!original.deletedAt) {
    claimSet.deletedAt = now;
    claimSet.deletedBy = actorId;
    claimSet.accountStatus = "rejected";
  }
  if (existing.role === "professional" && existing.professionalStatus !== "rejected") {
    claimSet.professionalStatus = "rejected";
  }

  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      role: { $ne: "admin" },
      isAnonymized: { $ne: true },
      $or: [
        { anonymizationClaimExpiresAt: { $exists: false } },
        { anonymizationClaimExpiresAt: null },
        { anonymizationClaimExpiresAt: { $lt: now } },
      ],
    },
    { $set: claimSet },
    { new: true },
  );
  if (!claimed) {
    const latest = await User.findById(userId)
      .select("+anonymizationClaimId")
      .lean() as AnyDoc | null;
    if (latest && isAlreadyAnonymized(latest)) {
      const cleanup = await retryCleanupInternal(userId);
      return buildResult(
        "already_anonymized",
        latest,
        emptyRedactionCounts(0),
        cleanup,
      );
    }
    if (latest && hasLiveClaim(latest)) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(
          (new Date(latest.anonymizationClaimExpiresAt).getTime() - Date.now()) / 1000,
        ),
      );
      throw new AnonymizationError(
        409,
        "ANONYMIZATION_IN_PROGRESS",
        "Another anonymization request currently owns this account.",
        { retryAfterSeconds },
      );
    }
    throw new AnonymizationError(
      409,
      "ANONYMIZE_INCOMPLETE",
      "The account could not be claimed for anonymization.",
      {
        targetId: idString(userId),
        tombstoned: false,
        fullyAnonymized: false,
        retryable: true,
        previewPath: `/api/admin/users/${idString(userId)}/anonymize/preview`,
      },
    );
  }

  try {
    if (enforceBlockers) {
      const blockers = await loadBlockingConditions(userId, {
        actorId,
        skipClaim: true,
      });
      if (blockers.length > 0) {
        await restoreFirstAttemptTombstone(userId, claimId, original);
        throw new AnonymizationError(
          409,
          "ANONYMIZE_BLOCKED",
          "This account gained an open record before anonymization could start.",
          { blockers, previewPath: `/api/admin/users/${idString(userId)}/anonymize/preview` },
        );
      }
    }

    await beginAccountDataRemoval(userId, "anonymizing");

    const redactionResult = await withCalendarTransaction(async (session) => {
      // The collection must read from the same snapshot that writes the
      // tombstone and guard. A business write that commits after this snapshot
      // conflicts on the User/guard fence and cannot slip a new row past it.
      const collected = await collectData(userId, session);
      return {
        data: collected,
        redaction: await applyDatabaseRedaction(
          collected,
          userId,
          actorId,
          String(existing.role || ""),
          claimId,
          session,
        ),
      };
    });
    const data = redactionResult.data;
    const redaction = redactionResult.redaction;

    const cleanup = await retryCleanupInternal(userId, { queuedKeys: data.keys });
    const after = await User.findById(userId).lean() as AnyDoc | null;
    invalidateFavoritesOverviewCache();
    return buildResult(
      "anonymized",
      after || existing,
      {
        profile: true,
        ...redaction,
        s3Objects: data.keys.length,
      },
      cleanup,
    );
  } catch (error) {
    if (error instanceof AnonymizationError) {
      const latest = await User.findById(userId)
        .select("+anonymizationClaimId")
        .lean() as AnyDoc | null;
      if (latest && isAlreadyAnonymized(latest)) {
        const cleanup = await retryCleanupInternal(userId);
        return buildResult(
          "already_anonymized",
          latest,
          emptyRedactionCounts(0),
          cleanup,
        );
      }
      if (latest && idString(latest.anonymizationClaimId) === claimId) {
        await restoreFirstAttemptTombstone(userId, claimId, original);
      }
      throw error;
    }

    const latest = await User.findById(userId)
      .select("+anonymizationClaimId")
      .lean() as AnyDoc | null;
    if (latest && isAlreadyAnonymized(latest)) {
      const cleanup = await retryCleanupInternal(userId);
      invalidateFavoritesOverviewCache();
      return buildResult(
        "already_anonymized",
        latest,
        emptyRedactionCounts(0),
        cleanup,
      );
    }
    let restored = false;
    if (latest && idString(latest.anonymizationClaimId) === claimId) {
      if (!original.deletedAt) {
        await restoreFirstAttemptTombstone(userId, claimId, original);
        restored = true;
      } else {
        await releaseClaim(userId, claimId);
      }
    }
    if (restored) {
      throw new AnonymizationError(
        500,
        "INTERNAL",
        "Anonymization failed before any durable change. Retry when ready.",
        {
          targetId: idString(userId),
          tombstoned: false,
          fullyAnonymized: false,
          retryable: true,
          previewPath: `/api/admin/users/${idString(userId)}/anonymize/preview`,
        },
      );
    }
    throw new AnonymizationError(
      500,
      "ANONYMIZE_INCOMPLETE",
      "The account is tombstoned, but database redaction did not complete. Preview the account and retry.",
      {
        targetId: idString(userId),
        tombstoned: true,
        fullyAnonymized: false,
        retryable: true,
        previewPath: `/api/admin/users/${idString(userId)}/anonymize/preview`,
      },
    );
  }
}

/**
 * Backward-compatible self-service entry point. Admin anonymization calls
 * executeAccountAnonymization so it can enforce blockers and typed confirmation.
 */
export async function anonymizeUser(
  userId: Types.ObjectId | string,
  actorId: Types.ObjectId | string,
): Promise<AnonymizeResult> {
  const result = await executeAccountAnonymization({
    targetId: userId,
    actorId,
    initiatedBy: "self",
    enforceBlockers: false,
  });
  return {
    userId: result.target.id,
    anonymizedAt: result.target.anonymizedAt || result.target.deletedAt || new Date(),
    redactedMessageCount: result.redacted.chatMessages,
    fullyAnonymized: result.fullyAnonymized,
    cleanupPendingFiles: result.cleanup.pendingFiles,
  };
}
