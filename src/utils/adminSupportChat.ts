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
  grossEur: number;
  refundPercent: number | null;
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
}): SupportParticipantKpis {
  return {
    level: input.professionalLevel || null,
    reviewCount: input.reviewCount,
    avgRating: round1(input.avgRating),
    projectCount: input.projectCount,
    bookingCount: input.bookingCount,
    completedCount: input.completedCount,
    quotedCount: input.quotedCount,
    disputeCount: input.disputeCount,
    grossEur: money2(input.grossEur),
    refundPercent: ratePercent(input.refundCount, input.bookingCount),
  };
}
