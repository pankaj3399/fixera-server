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

const joinAddress = (location: any): string | null => {
  if (!location || typeof location !== "object") return null;
  const parts = [location.address, location.city, location.postalCode, location.country]
    .filter((part) => typeof part === "string" && part.trim());
  return parts.length > 0 ? parts.join(", ") : null;
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

/**
 * Derive the shared bookings-table row from a viewer-sanitized booking
 * payload (i.e. AFTER bookingForViewer + pro-payout stripping). Unknown
 * stays null; same-currency recorded sources only.
 */
export function buildSharedBookingsRow(booking: any, viewerRole: "customer" | "professional" | "admin"): SharedBookingsRow {
  const titles = resolveSnapshotTitles(booking);
  const payment = booking?.payment && typeof booking.payment === "object" ? booking.payment : null;
  const currency = typeof payment?.currency === "string" && payment.currency ? payment.currency : "EUR";
  const paidSource = payment?.totalWithVat ?? payment?.amount ?? null;
  const extraCosts = Array.isArray(booking?.extraCosts)
    ? booking.extraCosts
    : booking?.extraCosts && typeof booking.extraCosts === "object"
      ? [booking.extraCosts]
      : [];
  const completedAddition = extraCosts
    .filter((entry: any) => entry && typeof entry === "object" && ["approved", "completed", "succeeded", "paid"].includes(String(entry.status)))
    .reduce((sum: number, entry: any) => sum + (typeof entry.total === "number" ? entry.total : typeof entry.amount === "number" ? entry.amount : 0), 0);
  const hasCompletedAddition = extraCosts.some((entry: any) =>
    entry && typeof entry === "object" && ["approved", "completed", "succeeded", "paid"].includes(String(entry.status)));
  const isProSide = viewerRole !== "customer";
  const payoutAmount = isProSide ? asMoney(payment?.professionalPayout ?? null, currency) : { amount: null, currency: null, source: "not_recorded" as const };
  const refundAmount = isProSide
    ? asMoney(payment?.refundAmount ?? (Array.isArray(payment?.refunds)
      ? payment.refunds.reduce((sum: number, refund: any) => sum + (typeof refund?.amount === "number" ? refund.amount : 0), 0)
      : null), currency)
    : { amount: null, currency: null, source: "not_recorded" as const };
  // Refund unknown is distinct from zero: only report a figure when a refund
  // status or record exists.
  const refundKnown = payment && (payment.status === "refunded" || payment.status === "partially_refunded" || (Array.isArray(payment.refunds) && payment.refunds.length > 0) || typeof payment.refundAmount === "number");
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
      ? booking.priceModel
      : typeof selectedPriceModel(booking) === "string" ? selectedPriceModel(booking) : null,
    paidPrice: asMoney(paidSource, currency),
    completionAddition: hasCompletedAddition
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
    refundAmount: refundKnown ? refundAmount : { amount: null, currency: null, source: "not_recorded" },
  };
}

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
  return asMoney(
    pinned.customerTotals?.totalWithVat ?? pinned.totalWithVat ?? pinned.totalAmount ?? pinned.amount ?? null,
    pinned.currency ?? booking?.quote?.currency,
  );
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
