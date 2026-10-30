export const INBOX_SEARCH_MAX_LENGTH = 80;

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeInboxSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, INBOX_SEARCH_MAX_LENGTH);
}

export function formatChatClosedMessage(closedAt: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(closedAt);
  return `Chat closed on ${formatted} UTC`;
}

export function round1(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

export function money2(n: number | null | undefined): number {
  const value = Number(n) || 0;
  return Number(`${Math.round(Number(`${value}e2`))}e-2`);
}

export function ratePercent(numer: number, denom: number): number | null {
  if (denom <= 0) return null;
  return round1((numer / denom) * 100);
}

export interface SupportParticipantKpis {
  level: string | null;
  reviewCount: number;
  avgRating: number | null;
  projectCount: number;
  bookingCount: number;
  completedCount: number;
  quotedCount: number;
  disputeCount: number;
  /** Recorded-EUR gross. Null when withheld (no access) or multi-currency. */
  grossEur: number | null;
  refundPercent: number | null;
  /**
   * False when the caller lacks payments read access. Front must render
   * financial fields as Restricted, never zero.
   */
  financialAccess: boolean;
  /** Per-currency recorded gross, never blended into a single EUR figure. */
  grossByCurrency: Array<{ currency: string; gross: number }>;
}

export function buildSupportParticipantKpis(input: {
  professionalLevel?: string | null;
  reviewCount: number;
  avgRating: number | null;
  projectCount: number;
  bookingCount: number;
  completedCount: number;
  quotedCount: number;
  disputeCount: number;
  grossEur: number;
  refundCount: number;
  /** Per-currency recorded gross buckets. Defaults to a single EUR bucket. */
  grossByCurrency?: Array<{ currency: string; gross: number }>;
  /** When false, financial fields are withheld (null), never zeroed. */
  financialAccess?: boolean;
}): SupportParticipantKpis {
  const financialAccess = input.financialAccess !== false;
  const grossByCurrency = (input.grossByCurrency || [{ currency: "EUR", gross: money2(input.grossEur) }])
    .map((bucket) => ({ currency: bucket.currency, gross: money2(bucket.gross) }));
  // A raw cross-currency sum is not a EUR figure. Only expose grossEur when
  // every recorded bucket is EUR; otherwise report per-currency only.
  const singleEur = grossByCurrency.length === 1 && grossByCurrency[0].currency === "EUR";
  return {
    level: input.professionalLevel || null,
    reviewCount: input.reviewCount,
    avgRating: round1(input.avgRating),
    projectCount: input.projectCount,
    bookingCount: input.bookingCount,
    completedCount: input.completedCount,
    quotedCount: input.quotedCount,
    disputeCount: input.disputeCount,
    grossEur: !financialAccess ? null : singleEur ? grossByCurrency[0].gross : null,
    refundPercent: !financialAccess ? null : ratePercent(input.refundCount, input.bookingCount),
    financialAccess,
    grossByCurrency: financialAccess ? grossByCurrency : [],
  };
}
