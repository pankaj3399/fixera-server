import type { Request } from 'express';
import {
  AdminDashboardBaseline,
  ADMIN_DASHBOARD_BASELINE_IDS,
  type AdminDashboardBaselineKey,
} from '../models/adminDashboardBaseline';

/**
 * "Counting since" baselines for booking-flow admin dashboards.
 *
 * THE RULE (one place, used by every list, count, badge and KPI in scope):
 *
 * 1. Work queues and nav badges. Every item that is still open or pending is
 *    listed and counted, whatever its date. A closed item created before the
 *    baseline is hidden. Only work that is finished can disappear.
 * 2. Each count uses the same filter as the list it describes. The "Open" card
 *    matches the Open list, and "All" matches the All list pagination total.
 * 3. Totals and KPI aggregates with no list behind them (warranty analytics,
 *    booking KPIs) count only items on or after the baseline.
 * 4. `?history=all` turns the baseline off for that one request. Nothing is
 *    deleted or edited: resets only move the baseline forward.
 *
 * Per dashboard:
 * - disputes:        booking disputes, by `dispute.raisedAt`. Open = no `dispute.resolvedAt`.
 * - warrantyClaims:  warranty claims, by `createdAt`. Open = any status except `closed`.
 * - cancellations:   cancellation and refund requests, by `createdAt`. Final = approved or denied.
 * - bookingKpis:     KPI summary and by-* aggregates. Clamps the requested `from` to the baseline.
 */

export const ADMIN_DASHBOARD_KEYS = Object.freeze(
  Object.keys(ADMIN_DASHBOARD_BASELINE_IDS) as AdminDashboardBaselineKey[],
);

/** Cancellation/refund requests that are finished (nothing left for an admin). */
export const FINAL_CANCELLATION_STATUSES = Object.freeze(['approved', 'denied']);
/** Warranty claims that are finished. Every other status is still open. */
export const CLOSED_WARRANTY_STATUS = 'closed';

export const isAdminDashboardKey = (value: unknown): value is AdminDashboardBaselineKey =>
  typeof value === 'string' && (ADMIN_DASHBOARD_KEYS as readonly string[]).includes(value);

/** `?history=all` (case-insensitive) lifts the baseline for one request. */
export const isHistoryAllRequested = (query: unknown): boolean => {
  const raw = (query as Record<string, unknown> | undefined)?.history;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'all';
};

/**
 * Mongo clause that keeps open work visible and closed history on or after the
 * baseline. Returns `{}` when no baseline applies (no reset, or show-all).
 */
export const disputeBaselineClause = (resetAt: Date): Record<string, unknown> => ({
  $or: [{ 'dispute.raisedAt': { $gte: resetAt } }, { 'dispute.resolvedAt': null }],
});

export const warrantyBaselineClause = (resetAt: Date): Record<string, unknown> => ({
  $or: [{ createdAt: { $gte: resetAt } }, { status: { $ne: CLOSED_WARRANTY_STATUS } }],
});

export const cancellationBaselineClause = (resetAt: Date): Record<string, unknown> => ({
  $or: [{ createdAt: { $gte: resetAt } }, { status: { $nin: [...FINAL_CANCELLATION_STATUSES] } }],
});

export const clauseForDashboard = (key: AdminDashboardBaselineKey, resetAt: Date): Record<string, unknown> => {
  switch (key) {
    case 'disputes':
      return disputeBaselineClause(resetAt);
    case 'warrantyClaims':
      return warrantyBaselineClause(resetAt);
    case 'cancellations':
      return cancellationBaselineClause(resetAt);
    case 'bookingKpis':
      // KPIs are range aggregates. They use `clampKpiFrom`, not a clause.
      return {};
  }
};

/** Start of a KPI range after applying the baseline (never earlier than the reset). */
export const clampKpiFrom = (from: Date, resetAt: Date | null): Date =>
  resetAt && resetAt.getTime() > from.getTime() ? resetAt : from;

/**
 * A KPI range after the bookingKpis reset: starts no earlier than the reset
 * and never inverts (a range entirely before the reset collapses to an empty
 * range at the baseline). Shared by the dashboard and the monthly PDF report.
 */
export const kpiRangeAfterBaseline = (
  from: Date,
  to: Date,
  resetAt: Date | null,
): { from: Date; to: Date } => {
  const clampedFrom = clampKpiFrom(from, resetAt);
  return { from: clampedFrom, to: clampedFrom.getTime() > to.getTime() ? clampedFrom : to };
};

/** Combine a base list filter with a baseline clause without mutating either. */
export const withBaselineClause = (
  base: Record<string, unknown>,
  clause: Record<string, unknown>,
): Record<string, unknown> => (Object.keys(clause).length === 0 ? base : { $and: [base, clause] });

export interface DashboardBaselineInfo {
  key: AdminDashboardBaselineKey;
  /** ISO timestamp of the baseline, or null when none is set. */
  resetAt: string | null;
  /** True when the request asked for `history=all`. */
  showAll: boolean;
  /** True when the baseline restricts this response (set, and not show-all). */
  applied: boolean;
}

export interface ResolvedDashboardBaseline extends DashboardBaselineInfo {
  /** Date form of `resetAt` for range math; null when no baseline is set. */
  resetAtDate: Date | null;
  /** Mongo clause to AND into the list or count filter (`{}` when not applied). */
  clause: Record<string, unknown>;
}

/** Current `resetAt` per dashboard (null = no baseline). */
export type DashboardBaselineMap = Map<AdminDashboardBaselineKey, Date | null>;
type BaselineCache = DashboardBaselineMap;
const CACHE_SYMBOL = Symbol.for('fixera.adminDashboardBaselines.cache');

/** Current baselines for all dashboards, one indexed query per request. */
export async function loadDashboardBaselines(req?: Request): Promise<BaselineCache> {
  const cached = req ? (req as any)[CACHE_SYMBOL] as BaselineCache | undefined : undefined;
  if (cached) return cached;

  const docs = await AdminDashboardBaseline.find({ _id: { $in: [...ADMIN_DASHBOARD_KEYS] } })
    .select('_id resetAt')
    .lean();
  const map: BaselineCache = new Map();
  for (const key of ADMIN_DASHBOARD_KEYS) map.set(key, null);
  for (const doc of docs as Array<{ _id: string; resetAt?: Date | null }>) {
    if (isAdminDashboardKey(doc._id)) map.set(doc._id, doc.resetAt ?? null);
  }
  if (req) (req as any)[CACHE_SYMBOL] = map;
  return map;
}

/** Baseline for one dashboard as this request should apply it. */
export async function resolveDashboardBaseline(
  req: Request,
  key: AdminDashboardBaselineKey,
): Promise<ResolvedDashboardBaseline> {
  const map = await loadDashboardBaselines(req);
  const resetAtDate = map.get(key) ?? null;
  const showAll = isHistoryAllRequested(req.query);
  const applied = Boolean(resetAtDate) && !showAll;
  return {
    key,
    resetAt: resetAtDate ? resetAtDate.toISOString() : null,
    resetAtDate,
    showAll,
    applied,
    clause: applied && resetAtDate ? clauseForDashboard(key, resetAtDate) : {},
  };
}

/** Serializable subset for response bodies (the indicator reads this). */
export const toBaselineInfo = (resolved: ResolvedDashboardBaseline): DashboardBaselineInfo => ({
  key: resolved.key,
  resetAt: resolved.resetAt,
  showAll: resolved.showAll,
  applied: resolved.applied,
});
