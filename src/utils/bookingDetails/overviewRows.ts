/**
 * Shared dashboard overview row helpers (groups 13/14/15a).
 *
 * Additive module: `bookingDetails/types.ts` is preexisting WIP and must not
 * be edited, so overview row types live here. All functions are pure and
 * wire-agnostic so they regress without a database.
 *
 * Money rules (load-bearing):
 * - Unknown/missing-after-event -> null -> front renders dash, never 0.
 * - Multi-currency buckets are never blended into a single-currency figure.
 * - Paid price is VAT & discounts inclusive from recorded sources only.
 * - Payout date means the actual transfer date (`transferredAt`). There is
 *   no capturedAt fallback: a capture is not a pay-out fact.
 */

import { collectBaseRefunds } from "../paymentRefunds";

export type OverviewMoney = {
  amount: number | null;
  currency: string | null;
  source: "recorded" | "not_recorded";
};

export type SharedBookingsRow = {
  id: string;
  bookingNumber: string | null;
  projectId: string | null;
  projectTitle: string | null;
  subprojectTitle: string | null;
  /** Canonical snapshot preferred; live project only when no snapshot. */
  titleSource: "booking_snapshot" | "live_project" | "not_recorded";
  serviceAddress: string | null;
  orderDate: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  priceModel: string | null;
  paidPrice: OverviewMoney;
  completionAddition: OverviewMoney;
  status: string;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  /** Pro-only, server-gated. Null for customers. */
  payoutDate: string | null;
  payoutAmount: OverviewMoney;
  refundAmount: OverviewMoney;
};

export type SharedQuoteRow = {
  id: string;
  bookingNumber: string | null;
  quotationNumber: string | null;
  /** Pinned version to link: accepted version when recorded, else current. */
  pinnedVersion: number | null;
  pinnedVersionSource: "recorded" | "inferred_current" | "not_recorded";
  projectId: string | null;
  projectTitle: string | null;
  subprojectTitle: string | null;
  titleSource: "booking_snapshot" | "live_project" | "not_recorded";
  serviceAddress: string | null;
  requestedDate: string | null;
  quoteDate: string | null;
  expiryDate: string | null;
  firstPossibleStart: string | null;
  executionDuration: string | null;
  quotePrice: OverviewMoney;
  status: string;
};

const asId = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof (value as any)?.toHexString === "function") return (value as any).toHexString();
  const raw = (value as any)?._id ?? (value as any)?.id ?? value;
  if (raw === null || raw === undefined) return null;
  if (typeof raw?.toHexString === "function") return raw.toHexString();
  const text = String(raw);
  return text ? text : null;
};

const asDate = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value as any).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
};

const asMoney = (amount: unknown, currency: unknown): OverviewMoney => {
  const value = typeof amount === "number" && Number.isFinite(amount) ? amount : null;
  return {
    amount: value,
    currency: value == null ? null : typeof currency === "string" && currency ? currency : "EUR",
    source: value == null ? "not_recorded" : "recorded",
  };
};

const addressWords = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** "BE" also reads as Belgium / België / Belgique when the address already names the country. */
const countryNameVariants = (value: string): string[] => {
  if (!/^[A-Za-z]{2}$/.test(value.trim())) return [];
  return ["en", "nl", "fr", "de"].flatMap((locale) => {
    try {
      const name = new Intl.DisplayNames([locale], { type: "region" }).of(value.trim().toUpperCase());
      return name ? [name] : [];
    } catch {
      return [];
    }
  });
};

/**
 * Whole-segment forms of an address segment: the segment itself and, for a
 * combined "postcode city" / "city postcode" segment, each leading and trailing
 * run of its words ("2000 Antwerpen" also stands for "2000" and "Antwerpen").
 */
const segmentForms = (segment: string): string[] => {
  const words = addressWords(segment).split(" ").filter(Boolean);
  const forms = [words.join(" ")];
  for (let k = 1; k < words.length; k += 1) forms.push(words.slice(0, k).join(" "), words.slice(k).join(" "));
  return forms;
};

/**
 * One-line service address. A Google-formatted street address ("Meir 1, 2000
 * Antwerpen, Belgium") already names the city, postcode and country, and some
 * bookings stored the profile address with those parts appended again; each
 * part is shown once, in its first position. A part is dropped only when it
 * matches a whole segment already added after the street (case, accents and
 * spacing ignored; "BE" matches "Belgium"), never because the street name
 * contains the same word ("Rue de Namur 12" in Namur).
 */
export const joinAddress = (location: any): string | null => {
  if (!location || typeof location !== "object") return null;
  const segments = [
    ...(typeof location.address === "string" ? location.address.split(",") : []),
    location.city,
    location.postalCode,
    location.country,
  ];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (typeof segment !== "string" || !segment.trim()) continue;
    const variants = [segment, ...countryNameVariants(segment)].map(addressWords).filter(Boolean);
    if (variants.length === 0 || variants.some((variant) => seen.has(variant))) continue;
    // The first kept segment is the street; only later segments name the city, postcode or country.
    if (kept.length > 0) for (const form of segmentForms(segment)) seen.add(form);
    kept.push(segment.trim());
  }
  return kept.length > 0 ? kept.join(", ") : null;
};

/**
 * Canonical booked project/subproject snapshot. The booking-time snapshot
 * wins over the current mutable project; RFQ-initial unfilled fields stay
 * null (front renders dash).
 */
export function resolveSnapshotTitles(booking: any): {
  projectId: string | null;
  projectTitle: string | null;
  subprojectTitle: string | null;
  titleSource: "booking_snapshot" | "live_project" | "not_recorded";
} {
  const snapshot = booking?.bookingSnapshot;
  const snapshotProject = snapshot?.project;
  const selectedSubproject = snapshot?.selectedSubproject;
  if (snapshotProject && typeof snapshotProject === "object") {
    const subprojectTitle = selectedSubproject && typeof selectedSubproject === "object"
      ? (selectedSubproject.title || selectedSubproject.name || null)
      : null;
    return {
      projectId: asId(snapshotProject.id ?? booking?.project?._id ?? booking?.project),
      projectTitle: typeof snapshotProject.title === "string" && snapshotProject.title
        ? snapshotProject.title
        : null,
      subprojectTitle: typeof subprojectTitle === "string" && subprojectTitle ? subprojectTitle : null,
      titleSource: "booking_snapshot",
    };
  }
  const liveProject = booking?.project;
  if (liveProject && typeof liveProject === "object") {
    return {
      projectId: asId(liveProject._id ?? liveProject.id),
      projectTitle: typeof liveProject.title === "string" && liveProject.title ? liveProject.title : null,
      subprojectTitle: null,
      titleSource: "live_project",
    };
  }
  return { projectId: asId(booking?.project), projectTitle: null, subprojectTitle: null, titleSource: "not_recorded" };
}

const UNPAID_BOOKING_STATUSES = new Set(["quote_accepted", "payment_pending"]);
const UNPAID_PAYMENT_STATUSES = new Set(["pending", "failed"]);

/**
 * True unless `booking.payment` only carries an amount due: awaiting-payment
 * bookings and pending/failed payments (including a later milestone's open
 * checkout) never present their amount as paid.
 */
export function hasRecordedPaidAmount(booking: any, payment: any): boolean {
  if (UNPAID_BOOKING_STATUSES.has(String(booking?.status))) return false;
  return !UNPAID_PAYMENT_STATUSES.has(String(payment?.status));
}

/**
 * Refund facts for one booking from the stored Payment ledger
 * (`Payment.refunds[]` on the booking-level rows). `booking.payment` carries
 * no refund rows, so callers load these first (see
 * `loadOverviewRefundLedgers`) and pass them in. `loaded: false` means the
 * ledger was not read (or the read failed): figures that depend on it stay
 * unknown. `loaded: true` with no rows means the ledger is known to be empty.
 */
export type OverviewRefundFact = {
  amount: number;
  kind: "booking" | "extra_cost";
  /**
   * null on legacy rows without a status (an actual refund). `unknown` for a
   * status this read model does not recognise: never counted as returned.
   */
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled" | "unknown" | null;
};

export type OverviewRefundLedger =
  | { loaded: true; refunds: OverviewRefundFact[] }
  | { loaded: false };

export const OVERVIEW_LEDGER_NOT_LOADED: OverviewRefundLedger = Object.freeze({ loaded: false as const });

const REFUND_STATUSES = new Set(["pending", "requires_action", "succeeded", "failed", "canceled"]);

/**
 * Ledger facts from stored base-payment rows (deduplicated by provider refund
 * id, as the refund paths do). Only amount, kind and status are kept: no
 * provider ids, notes or actors leave this function.
 */
export function overviewLedgerFromPaymentRows(rows: any[]): OverviewRefundLedger {
  const refunds: OverviewRefundFact[] = [];
  for (const refund of collectBaseRefunds(rows)) {
    const status: OverviewRefundFact["status"] = refund.status == null || refund.status === ""
      ? null
      : typeof refund.status === "string" && REFUND_STATUSES.has(refund.status)
        ? refund.status as OverviewRefundFact["status"]
        : "unknown";
    refunds.push({
      amount: Number(refund.amount),
      kind: refund.kind === "extra_cost" ? "extra_cost" : "booking",
      status,
    });
  }
  return { loaded: true, refunds };
}

/** Legacy rows (no status) and `succeeded` rows returned money. */
const isReturned = (refund: OverviewRefundFact): boolean =>
  (refund.status === null || refund.status === "succeeded")
  && Number.isFinite(refund.amount) && refund.amount > 0;

/** Pending/requires_action (or unrecognised) rows have not settled either way. */
const isInFlight = (refund: OverviewRefundFact): boolean =>
  refund.status === "pending" || refund.status === "requires_action" || refund.status === "unknown";

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Settled completion addition, VAT-inclusive as the customer was charged or
 * refunded, from recorded facts only:
 * - The separate extra-cost charge `payment.extraCostAmount` counts once it
 *   settled: `extraCostStatus` `succeeded`, or `refunded` (it was charged and
 *   later refunded; the refund is in the ledger).
 * - Returned `kind: "extra_cost"` ledger rows are subtracted. They cover a
 *   negative adjustment refunded against the base charge and a refund of the
 *   extra-cost charge itself, so a charge of 121 with a returned refund of
 *   121 nets to 0, a partial refund nets to the remainder, and a refund with
 *   no settled charge is a negative-only credit.
 * - Failed/canceled refund rows returned nothing and are ignored.
 * Unknown (null) when the ledger was not loaded, when a charge or extra-cost
 * refund is still in flight (charge `pending`, refund pending or
 * requires_action), when a `refunded` charge has no returned refund recorded
 * (the refunded amount is not known), or when nothing settled is recorded.
 * `extraCosts[]` entries carry no status and are pre-commission, pre-VAT
 * professional amounts, so they are never summed.
 */
export function settledCompletionAddition(payment: any, ledger: OverviewRefundLedger): number | null {
  if (!ledger.loaded) return null;
  const chargeStatus = payment && typeof payment === "object" ? payment.extraCostStatus : undefined;
  if (chargeStatus === "pending") return null;
  const extraCostRefunds = ledger.refunds.filter((refund) => refund.kind === "extra_cost");
  if (extraCostRefunds.some(isInFlight)) return null;
  const returned = extraCostRefunds.filter(isReturned);
  const chargeSettled = chargeStatus === "succeeded" || chargeStatus === "refunded";
  const chargeAmount = chargeSettled
    && typeof payment.extraCostAmount === "number" && Number.isFinite(payment.extraCostAmount)
    ? payment.extraCostAmount
    : null;
  if (chargeSettled && chargeAmount === null) return null;
  if (chargeStatus === "refunded" && returned.length === 0) return null;
  if (chargeAmount === null && returned.length === 0) return null;
  const returnedTotal = returned.reduce((sum, refund) => sum + refund.amount, 0);
  return roundMoney((chargeAmount ?? 0) - returnedTotal);
}

/**
 * Booking-price money returned to the customer. `payment.refundAmount` is
 * the authoritative aggregate when recorded; otherwise the returned
 * booking-price ledger rows are summed (extra-cost rows belong to the
 * completion addition). Null when the ledger was not loaded or holds no
 * returned booking-price row: a failed/canceled or still pending refund alone
 * is not a recorded refund.
 */
export function recordedBookingRefund(payment: any, ledger: OverviewRefundLedger): number | null {
  if (payment && typeof payment === "object"
    && typeof payment.refundAmount === "number" && Number.isFinite(payment.refundAmount)) {
    return payment.refundAmount;
  }
  if (!ledger.loaded) return null;
  const returned = ledger.refunds.filter((refund) => refund.kind === "booking" && isReturned(refund));
  if (returned.length === 0) return null;
  return roundMoney(returned.reduce((sum, refund) => sum + refund.amount, 0));
}

/**
 * Derive the shared bookings-table row from a viewer-sanitized booking
 * payload (i.e. AFTER bookingForViewer + pro-payout stripping) and the
 * booking's stored refund ledger facts. Unknown stays null; same-currency
 * recorded sources only.
 */
export function buildSharedBookingsRow(
  booking: any,
  viewerRole: "customer" | "professional" | "admin",
  ledger: OverviewRefundLedger = OVERVIEW_LEDGER_NOT_LOADED,
): SharedBookingsRow {
  const titles = resolveSnapshotTitles(booking);
  const payment = booking?.payment && typeof booking.payment === "object" ? booking.payment : null;
  const currency = typeof payment?.currency === "string" && payment.currency ? payment.currency : "EUR";
  // VAT-inclusive recorded total only. `payment.amount` is the pre-VAT net
  // (createPaymentIntent stores netAmount there), so it is never presented as
  // the paid price; a payment without totalWithVat renders as not recorded.
  const paidSource = hasRecordedPaidAmount(booking, payment)
    ? payment?.totalWithVat ?? null
    : null;
  const completedAddition = settledCompletionAddition(payment, ledger);
  const isProSide = viewerRole !== "customer";
  const payoutAmount = isProSide ? asMoney(payment?.professionalPayout ?? null, currency) : { amount: null, currency: null, source: "not_recorded" as const };
  const bookingRefund = recordedBookingRefund(payment, ledger);
  const refundAmount = isProSide && bookingRefund != null
    ? asMoney(bookingRefund, currency)
    : { amount: null, currency: null, source: "not_recorded" as const };
  return {
    id: asId(booking?._id) || "",
    bookingNumber: typeof booking?.bookingNumber === "string" ? booking.bookingNumber : null,
    ...titles,
    serviceAddress: joinAddress(booking?.location),
    orderDate: asDate(booking?.createdAt),
    plannedStart: asDate(booking?.scheduledStartDate),
    plannedEnd: asDate(booking?.scheduledExecutionEndDate),
    actualStart: asDate(booking?.actualStartDate),
    actualEnd: asDate(booking?.actualEndDate),
    priceModel: typeof booking?.priceModel === "string"
      ? normalizePriceModel(booking.priceModel) ?? booking.priceModel
      : typeof selectedPriceModel(booking) === "string" ? selectedPriceModel(booking) : null,
    paidPrice: asMoney(paidSource, currency),
    completionAddition: completedAddition != null
      ? { amount: completedAddition, currency, source: "recorded" }
      : { amount: null, currency: null, source: "not_recorded" },
    status: typeof booking?.status === "string" ? booking.status : "unknown",
    invoiceNumber: typeof payment?.invoiceNumber === "string" && viewerRole !== "professional" ? payment.invoiceNumber
      : typeof payment?.supplierInvoiceNumber === "string" && viewerRole === "professional" ? payment.supplierInvoiceNumber : null,
    invoiceUrl: typeof payment?.invoiceUrl === "string" && viewerRole !== "professional" ? payment.invoiceUrl
      : typeof payment?.supplierInvoiceUrl === "string" && viewerRole === "professional" ? payment.supplierInvoiceUrl : null,
    // Actual transfer date only. A missing transfer record means unknown,
    // never a capturedAt/createdAt fallback presented as paid-out fact.
    payoutDate: isProSide ? asDate(payment?.transferredAt ?? null) : null,
    payoutAmount,
    refundAmount,
  };
}

/**
 * Viewer-safe overview money attached to each `GET /api/bookings/my-bookings`
 * row as `booking.overview`. Only computed scalars: no ledger rows, provider
 * ids or payout facts. The dashboard bookings table treats each present
 * field as authoritative, including `source: "not_recorded"` (unknown).
 */
export type BookingListOverview = Pick<SharedBookingsRow, "paidPrice" | "completionAddition">;

export function buildBookingListOverview(
  booking: any,
  viewerRole: "customer" | "professional",
  ledger: OverviewRefundLedger,
): BookingListOverview {
  const row = buildSharedBookingsRow(booking, viewerRole, ledger);
  return { paidPrice: row.paidPrice, completionAddition: row.completionAddition };
}

/** Price-model tokens the frontend translates (booking details and dashboard tables). */
export const PRICE_MODEL_TOKENS = ["fixed", "unit", "rfq", "hour", "day", "meter", "m2", "room"] as const;
export type PriceModelToken = (typeof PRICE_MODEL_TOKENS)[number];

/**
 * Maps a recorded price model to a token. Projects store the service
 * configuration's pricing option name ("Fixed Price", "Price per m²"), which is
 * free text; subproject pricing stores the enum (fixed/unit/rfq), and older
 * records may hold the option type (fixed_price/price_per_unit). Null when the
 * text names no known model, or names more than one (the legacy combined
 * option "Total price or m² of material"), so the caller shows it as recorded.
 * Mirrored by the frontend's priceModelKey (fixera lib/priceModel.ts).
 */
const PRICE_MODEL_PATTERNS: ReadonlyArray<readonly [PriceModelToken, RegExp]> = [
  ["rfq", /\b(rfq|quote|quotation|request)\b|offerte|devis/],
  ["fixed", /\b(fixed|total|flat|fixe)\b|vaste|forfait/],
  ["hour", /\b(hour|hours|hourly|uur)\b|heure/],
  ["day", /\b(day|days|daily|dag)\b|jour/],
  ["m2", /m²|\bm2\b|square met/],
  ["room", /\b(room|rooms|kamer)\b|pièce/],
  ["meter", /\b(metre|meter|linear|lineair)\b|mètre/],
];

export const normalizePriceModel = (value: unknown): PriceModelToken | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!text) return null;
  if ((PRICE_MODEL_TOKENS as readonly string[]).includes(text)) return text as PriceModelToken;
  let matches = PRICE_MODEL_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([token]) => token);
  // "Square metre" names the area model, not the linear one.
  if (matches.includes("m2")) matches = matches.filter((token) => token !== "meter");
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  return /\b(unit|per)\b|eenheid|unité/.test(text) ? "unit" : null;
};

const UNIT_BASED_TOKENS: ReadonlySet<PriceModelToken> = new Set(["unit", "hour", "day", "meter", "m2", "room"]);

export const selectedPriceModel = (booking: any): string | null => {
  const snapshot = booking?.bookingSnapshot;
  const candidates = [
    snapshot?.project?.priceModel,
    snapshot?.selectedSubproject?.pricing?.type,
    snapshot?.selectedSubproject?.pricingModel,
    snapshot?.selectedSubproject?.priceModel,
    booking?.project?.priceModel,
    booking?.project?.pricingModel,
  ];
  // First recognisable model in priority order, as a token the frontend translates.
  let token: PriceModelToken | null = null;
  for (const candidate of candidates) {
    token = normalizePriceModel(candidate);
    if (token) break;
  }
  // The booked subproject's pricing type (fixed/unit/rfq) wins over the
  // project-level text; a unit-based project text only refines "unit" to its
  // specific unit (m², hour, ...).
  const subprojectType = normalizePriceModel(snapshot?.selectedSubproject?.pricing?.type);
  if (subprojectType && !(subprojectType === "unit" && token && UNIT_BASED_TOKENS.has(token))) return subprojectType;
  if (token) return token;
  // Unrecognised free text is still shown as recorded.
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
};

/**
 * Quote version pinning: the table links the recorded accepted version when
 * present, else the current version. Never a mutable "latest" assumption —
 * the booking detail route must load this exact version.
 */
export function resolvePinnedQuoteVersion(booking: any): {
  pinnedVersion: number | null;
  pinnedVersionSource: "recorded" | "inferred_current" | "not_recorded";
} {
  const accepted = booking?.acceptedQuoteVersion ?? booking?.quote?.acceptedVersion;
  if (typeof accepted === "number" && Number.isFinite(accepted)) {
    return { pinnedVersion: accepted, pinnedVersionSource: "recorded" };
  }
  const current = booking?.currentQuoteVersion ?? booking?.quote?.currentVersion;
  if (typeof current === "number" && Number.isFinite(current)) {
    return { pinnedVersion: current, pinnedVersionSource: "inferred_current" };
  }
  const versions = Array.isArray(booking?.quoteVersions) ? booking.quoteVersions : [];
  const maxVersion = versions.reduce((max: number | null, entry: any) => {
    const version = typeof entry?.version === "number" ? entry.version : null;
    return version != null && (max == null || version > max) ? version : max;
  }, null);
  // Even a max-of-versions is only an inference, flagged as such.
  return maxVersion != null
    ? { pinnedVersion: maxVersion, pinnedVersionSource: "inferred_current" }
    : { pinnedVersion: null, pinnedVersionSource: "not_recorded" };
}

/** Money of the pinned version when recorded, else null (never latest-mutable). */
export function pinnedVersionMoney(booking: any): OverviewMoney {
  const { pinnedVersion } = resolvePinnedQuoteVersion(booking);
  if (pinnedVersion == null) return { amount: null, currency: null, source: "not_recorded" };
  const versions = Array.isArray(booking?.quoteVersions) ? booking.quoteVersions : [];
  const pinned = versions.find((entry: any) => entry?.version === pinnedVersion);
  if (!pinned || typeof pinned !== "object") {
    // Fall back to the legacy single-quote record only when no version
    // documents exist at all.
    if (versions.length === 0 && booking?.quote && typeof booking.quote === "object") {
      return asMoney(booking.quote.totalAmount ?? booking.quote.amount ?? null, booking.quote.currency);
    }
    return { amount: null, currency: null, source: "not_recorded" };
  }
  const recordedGross = pinned.customerTotals?.totalWithVat ?? pinned.totalWithVat ?? null;
  if (recordedGross != null) return asMoney(recordedGross, pinned.currency ?? booking?.quote?.currency);
  // `totalAmount` is the pre-VAT net. It stands in for the gross only for
  // legacy versions without pricingLines (treated as 0% VAT); a priced
  // version without a recorded VAT-inclusive total stays unknown.
  if (Array.isArray(pinned.pricingLines) && pinned.pricingLines.length > 0) {
    return { amount: null, currency: null, source: "not_recorded" };
  }
  return asMoney(pinned.totalAmount ?? pinned.amount ?? null, pinned.currency ?? booking?.quote?.currency);
}

export function buildSharedQuoteRow(booking: any): SharedQuoteRow {
  const titles = resolveSnapshotTitles(booking);
  const { pinnedVersion, pinnedVersionSource } = resolvePinnedQuoteVersion(booking);
  const quotePrice = pinnedVersionMoney(booking);
  const versions = Array.isArray(booking?.quoteVersions) ? booking.quoteVersions : [];
  const pinned = pinnedVersion != null ? versions.find((entry: any) => entry?.version === pinnedVersion) : null;
  const firstPossibleStart = (pinned && typeof pinned === "object"
    ? pinned.firstPossibleStart ?? pinned.earliestStartDate ?? null
    : null) ?? booking?.scheduleSnapshot?.firstPossibleStart ?? null;
  const duration = (pinned && typeof pinned === "object"
    ? pinned.executionDuration ?? null
    : null) ?? booking?.scheduleSnapshot?.executionDuration ?? booking?.project?.executionDuration ?? null;
  return {
    id: asId(booking?._id) || "",
    bookingNumber: typeof booking?.bookingNumber === "string" ? booking.bookingNumber : null,
    quotationNumber: typeof booking?.quotationNumber === "string"
      ? booking.quotationNumber
      : typeof booking?.quote?.quotationNumber === "string" ? booking.quote.quotationNumber : null,
    pinnedVersion,
    pinnedVersionSource,
    ...titles,
    serviceAddress: joinAddress(booking?.location),
    requestedDate: asDate(booking?.createdAt),
    quoteDate: asDate(pinned?.submittedAt ?? pinned?.createdAt ?? booking?.quote?.submittedAt),
    expiryDate: asDate(pinned?.validUntil ?? booking?.quote?.validUntil),
    firstPossibleStart: typeof firstPossibleStart === "string" ? firstPossibleStart : asDate(firstPossibleStart),
    executionDuration: typeof duration === "string"
      ? duration
      : duration && typeof duration === "object"
        ? `${duration.value ?? "?"} ${duration.unit ?? ""}`.trim()
        : null,
    quotePrice,
    status: typeof booking?.status === "string" ? booking.status : "unknown",
  };
}

/**
 * Archive restore target. Restoring to published would bypass approval, so a
 * previously published project restores as draft; other verified states
 * restore to their recorded pre-archive status.
 */
export function resolveArchiveRestoreTarget(
  statusBeforeArchive: string | null | undefined,
): "draft" | "pending" | "rejected" | "on_hold" | "suspended" {
  const restorable = ["draft", "pending", "rejected", "on_hold", "suspended"];
  if (typeof statusBeforeArchive === "string" && restorable.includes(statusBeforeArchive)) {
    return statusBeforeArchive as "draft" | "pending" | "rejected" | "on_hold" | "suspended";
  }
  return "draft";
}

/** Customer pay-now eligibility mirrors the dashboard quick action rule. */
export function isPayNowEligible(status: unknown): boolean {
  return status === "quote_accepted" || status === "payment_pending";
}

/** Customer warranty-action eligibility mirrors the dashboard rule. */
export function isWarrantyActionEligible(booking: any, now: number = Date.now()): boolean {
  if (!booking || booking.status !== "completed") return false;
  const durationValue = Number(booking?.warrantyCoverage?.duration?.value || 0);
  const endsAt = booking?.warrantyCoverage?.endsAt ? new Date(booking.warrantyCoverage.endsAt).getTime() : NaN;
  return durationValue > 0 && Number.isFinite(endsAt) && endsAt > now;
}
