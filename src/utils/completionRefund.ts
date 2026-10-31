import mongoose from 'mongoose';
import Booking from '../models/booking';
import {
  recordExtraCostRefundFact,
  refundExtraCostAdjustment,
} from '../handlers/Stripe/payment';
import { commissionedExtraCostTotal } from './customerPricing';
import { stripe } from '../services/stripe';
import { convertFromStripeAmount } from './payment';
import { collectBaseRefunds } from './paymentRefunds';
import {
  loadBasePaymentRows,
  updateBasePaymentRefundStatus,
} from './paymentRefundLedger';

/**
 * A completion that requires a negative extra-cost refund persists this marker
 * in the same atomic status update that marks the booking completed. The refund
 * is therefore never lost if the provider call fails: the automatic job and the
 * customer-confirmation handler can retry the exact same operation.
 *
 * `processingAt` is a short lease and `claimId` is its fencing token, so a stale
 * attempt can neither clear a newer attempt's marker nor repeat the completion
 * side effects. `obligationId` is the stable logical refund identity carried in
 * provider metadata; it lets a retry reconcile an accepted refund after the
 * provider idempotency-key window has expired.
 */
export interface PendingExtraCostRefund {
  amount: number;
  reason: string;
  actorId?: mongoose.Types.ObjectId;
  notifyAutoAccept?: boolean;
  requestedAt: Date;
  processingAt?: Date;
  obligationId?: string;
  claimId?: string;
  providerRefundId?: string;
}

export const COMPLETION_EXTRA_COST_REFUND_REASON =
  'Negative extra-cost adjustment (unit underuse)';

const CLAIM_LEASE_MS = 15 * 60 * 1000;
const OBLIGATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PROVIDER_REFUND_PAGE_LIMIT = 100;
const PROVIDER_REFUND_MAX_PAGES = 50;
const AMOUNT_EPSILON = 0.01;

const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const dateFrom = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const dateMs = (value: unknown): number | null => {
  const date = dateFrom(value);
  return date ? date.getTime() : null;
};

const normalizeRefundStatus = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;

const isFailedRefundStatus = (status: unknown): boolean =>
  status === 'failed' || status === 'canceled';

const isPendingRefundStatus = (status: unknown): boolean =>
  status === 'pending' || status === 'requires_action';

const isSettledRefundStatus = (status: unknown): boolean =>
  status === undefined || status === null || status === 'succeeded';

interface RefundFact {
  refundId?: string;
  amount: number;
  status?: string;
  refundedAt?: Date;
  obligationId?: string;
  kind?: string;
  reason?: string;
}

type Reconciliation =
  | { action: 'settled'; refundId?: string }
  | { action: 'pending'; refundId?: string }
  | { action: 'retry'; attempt: number };

export const getPendingExtraCostRefund = (
  booking: any,
): PendingExtraCostRefund | null => {
  const pending = booking?.payment?.extraCostRefundPending;
  if (!pending || typeof pending !== 'object') return null;
  const amount = Number(pending.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return pending as PendingExtraCostRefund;
};

/**
 * Build the persisted refund obligation for a completion. Returns null when
 * the booking does not owe an extra-cost refund (positive/zero extra cost,
 * no payment intent, or an amount that rounds to zero).
 */
export const buildPendingExtraCostRefund = (params: {
  booking: any;
  commissionPercent: number;
  actorId?: string | mongoose.Types.ObjectId | null;
  notifyAutoAccept?: boolean;
  requestedAt: Date;
}): PendingExtraCostRefund | null => {
  const extraCostTotal = Number(params.booking?.extraCostTotal || 0);
  if (!(extraCostTotal < 0) || !params.booking?.payment?.stripePaymentIntentId) {
    return null;
  }
  const amount = Math.abs(
    commissionedExtraCostTotal(
      params.booking.extraCosts,
      extraCostTotal,
      params.commissionPercent || 0,
    ),
  );
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const actorId = params.actorId && mongoose.Types.ObjectId.isValid(String(params.actorId))
    ? new mongoose.Types.ObjectId(String(params.actorId))
    : undefined;
  return {
    amount: roundMoney(amount),
    reason: COMPLETION_EXTRA_COST_REFUND_REASON,
    ...(actorId ? { actorId } : {}),
    ...(params.notifyAutoAccept ? { notifyAutoAccept: true } : {}),
    requestedAt: params.requestedAt,
    processingAt: params.requestedAt,
    obligationId: new mongoose.Types.ObjectId().toString(),
    claimId: new mongoose.Types.ObjectId().toString(),
  };
};

/**
 * Claim the pending refund with an atomic compare-and-set. A recent claim is
 * treated as in progress; an expired lease (crashed attempt) is reclaimable.
 */
export const claimPendingExtraCostRefund = async (
  bookingId: string | mongoose.Types.ObjectId,
  now: Date = new Date(),
): Promise<any | null> => {
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  return Booking.findOneAndUpdate(
    {
      _id: bookingId,
      status: 'completed',
      'payment.extraCostRefundPending.amount': { $gt: 0 },
      $or: [
        { 'payment.extraCostRefundPending.processingAt': { $exists: false } },
        { 'payment.extraCostRefundPending.processingAt': null },
        { 'payment.extraCostRefundPending.processingAt': { $lte: staleBefore } },
      ],
    },
    {
      $set: {
        'payment.extraCostRefundPending.processingAt': now,
        'payment.extraCostRefundPending.claimId': new mongoose.Types.ObjectId().toString(),
      },
    },
    { new: true },
  );
};

/**
 * Release only this attempt's lease. A stale attempt whose lease expired must
 * not clear the claim of the attempt that replaced it.
 */
export const releasePendingExtraCostRefundClaim = async (
  bookingId: string | mongoose.Types.ObjectId,
  claimId?: string | null,
): Promise<void> => {
  if (!claimId) return;
  await Booking.updateOne(
    {
      _id: bookingId,
      'payment.extraCostRefundPending.amount': { $gt: 0 },
      'payment.extraCostRefundPending.claimId': claimId,
    },
    { $unset: { 'payment.extraCostRefundPending.processingAt': 1, 'payment.extraCostRefundPending.claimId': 1 } },
  );
};

/**
 * Remove the marker only after the refund is recorded AND this attempt still
 * owns the claim. Returns false when a newer attempt owns the obligation, so
 * the caller can skip the completion side effects it no longer owns.
 */
export const clearPersistedPendingExtraCostRefund = async (
  bookingId: string | mongoose.Types.ObjectId,
  claimId?: string | null,
): Promise<boolean> => {
  if (!claimId) return false;
  const result = await Booking.updateOne(
    {
      _id: bookingId,
      'payment.extraCostRefundPending.amount': { $gt: 0 },
      'payment.extraCostRefundPending.claimId': claimId,
    },
    { $unset: { 'payment.extraCostRefundPending': 1 } },
  );
  return result.matchedCount > 0;
};

/** Persist an accepted provider id on the current, still-fenced attempt. */
const persistPendingProviderRefundId = async (
  bookingId: string | mongoose.Types.ObjectId,
  claimId: string | undefined,
  refundId: string | undefined,
): Promise<void> => {
  if (!claimId || !refundId) return;
  await Booking.updateOne(
    {
      _id: bookingId,
      'payment.extraCostRefundPending.amount': { $gt: 0 },
      'payment.extraCostRefundPending.claimId': claimId,
    },
    { $set: { 'payment.extraCostRefundPending.providerRefundId': refundId } },
  ).catch(() => undefined);
};

const amountMatches = (left: number, right: number): boolean =>
  Math.abs(left - right) <= AMOUNT_EPSILON;

/**
 * A recorded/provider refund belongs to this obligation only when its amount
 * matches and its identity is proven. New obligations carry an explicit
 * obligation id. Older/legacy refunds without one are accepted only when they
 * were created no earlier than the obligation request time, so an unrelated
 * equal-amount refund from before the obligation is never inferred as this one.
 */
const matchesPendingObligation = (
  fact: RefundFact,
  pending: PendingExtraCostRefund,
): boolean => {
  if (fact.kind !== 'extra_cost' || !amountMatches(fact.amount, pending.amount)) {
    return false;
  }
  if (pending.obligationId && fact.obligationId) {
    return fact.obligationId === pending.obligationId;
  }
  if (pending.providerRefundId) {
    return fact.refundId === pending.providerRefundId;
  }
  const requestedAt = dateMs(pending.requestedAt);
  const refundedAt = dateMs(fact.refundedAt);
  if (requestedAt == null || refundedAt == null) return false;
  return refundedAt >= requestedAt - OBLIGATION_CLOCK_SKEW_MS;
};

const toRecordedFact = (refund: any): RefundFact | null => {
  const amount = Number(refund?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    refundId: str(refund?.refundId) || undefined,
    amount,
    status: normalizeRefundStatus(refund?.status),
    refundedAt: dateFrom(refund?.refundedAt),
    obligationId: str(refund?.obligationId) || undefined,
    kind: str(refund?.kind) || undefined,
    reason: str(refund?.reason) || undefined,
  };
};

const providerRefundFact = (params: {
  refund: any;
  booking: any;
  intent: string;
  currency: string;
  recordedById: Map<string, any>;
}): RefundFact | null => {
  const { refund, booking, intent, currency, recordedById } = params;
  const refundId = str(refund?.id);
  if (!refundId) return null;
  if (refund?.payment_intent && String(refund.payment_intent) !== intent) return null;
  const metadata = refund?.metadata && typeof refund.metadata === 'object'
    ? refund.metadata as Record<string, unknown>
    : {};
  const recorded = recordedById.get(refundId);
  const metadataKind = str(metadata.refundKind) || str(metadata.kind) || str(metadata.type);
  const kind = metadataKind === 'extra_cost'
    ? 'extra_cost'
    : metadataKind === 'booking'
      ? 'booking'
      : str(recorded?.kind);
  if (kind !== 'extra_cost') return null;
  if (metadata.bookingId && String(metadata.bookingId) !== String(booking?._id)) return null;
  // An unmarked provider-dashboard refund cannot be proven to be this
  // booking's extra-cost obligation; only an already recorded safe kind may.
  if (!metadata.bookingId && !recorded) return null;
  const providerCurrency = str(refund?.currency) || currency;
  const amount = convertFromStripeAmount(Number(refund?.amount), providerCurrency);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const created = Number(refund?.created);
  return {
    refundId,
    amount,
    status: normalizeRefundStatus(refund?.status),
    refundedAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000) : undefined,
    obligationId: str(metadata.obligationId) || undefined,
    kind,
    reason: str(refund?.reason) || undefined,
  };
};

const listProviderRefunds = async (intent: string): Promise<any[]> => {
  const refunds: any[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < PROVIDER_REFUND_MAX_PAGES; page += 1) {
    const response: any = await stripe.refunds.list({
      payment_intent: intent,
      limit: PROVIDER_REFUND_PAGE_LIMIT,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = Array.isArray(response?.data) ? response.data : [];
    refunds.push(...data);
    if (!response?.has_more) return refunds;
    const lastId = str(data[data.length - 1]?.id);
    if (!lastId) break;
    startingAfter = lastId;
  }
  // An incomplete provider list cannot prove the obligation is unsettled.
  throw new Error('Provider refund reconciliation list was incomplete');
};

const hasSingleIdentity = (
  facts: RefundFact[],
  pending: PendingExtraCostRefund,
): boolean => {
  if (facts.length <= 1) return true;
  const ids = new Set(facts.map((fact) => fact.refundId).filter(Boolean));
  if (ids.size <= 1) return true;
  if (pending.providerRefundId) {
    return facts.every((fact) => fact.refundId === pending.providerRefundId);
  }
  if (pending.obligationId) {
    return facts.every((fact) => fact.obligationId === pending.obligationId);
  }
  // Legacy equal-amount rows with no identity cannot be disambiguated.
  return false;
};

const pickRefundId = (
  facts: RefundFact[],
  pending: PendingExtraCostRefund,
): string | undefined =>
  (pending.providerRefundId && facts.find((fact) => fact.refundId === pending.providerRefundId)?.refundId)
  || facts.find((fact) => fact.refundId)?.refundId;

const persistProviderFacts = async (params: {
  booking: any;
  facts: RefundFact[];
}): Promise<void> => {
  for (const fact of params.facts) {
    if (!fact.refundId || !fact.refundedAt) continue;
    await recordExtraCostRefundFact({
      booking: params.booking,
      fact: {
        refundId: fact.refundId,
        amount: fact.amount,
        status: fact.status,
        refundedAt: fact.refundedAt,
        obligationId: fact.obligationId,
        reason: fact.reason,
        notes: `Provider extra-cost refund ${fact.refundId}`,
      },
    });
  }
};

/**
 * Reconcile this obligation against the durable local ledger first, then the
 * provider's actual refund objects for the same PaymentIntent. Reconciliation
 * never issues cash; it only proves whether an accepted/pending/failed refund
 * already exists.
 */
const reconcilePendingExtraCostRefund = async (params: {
  booking: any;
  pending: PendingExtraCostRefund;
  claimId?: string;
}): Promise<Reconciliation> => {
  const { booking, pending, claimId } = params;
  const intent = str(booking?.payment?.stripePaymentIntentId);
  if (!intent) return { action: 'retry', attempt: 0 };
  const currency = str(booking?.payment?.currency) || 'EUR';

  const rows = await loadBasePaymentRows(booking, intent);
  const recordedById = new Map<string, any>();
  for (const refund of collectBaseRefunds(rows)) {
    const id = str(refund?.refundId);
    if (id) recordedById.set(id, refund);
  }
  const recordedFacts = collectBaseRefunds(rows)
    .map(toRecordedFact)
    .filter((fact): fact is RefundFact => Boolean(fact))
    .filter((fact) => matchesPendingObligation(fact, pending));

  // A recorded pending refund is reserved cash. Poll its actual provider
  // status; never create a replacement while it can still succeed.
  for (const fact of recordedFacts) {
    if (!isPendingRefundStatus(fact.status) || !fact.refundId) continue;
    const providerRefund: any = await stripe.refunds.retrieve(fact.refundId);
    const status = normalizeRefundStatus(providerRefund?.status);
    if (status && status !== fact.status) {
      await updateBasePaymentRefundStatus(booking, fact.refundId, status);
      fact.status = status;
    }
  }

  const recordedSettled = recordedFacts.filter((fact) => isSettledRefundStatus(fact.status));
  if (recordedSettled.length > 0) {
    if (!hasSingleIdentity(recordedSettled, pending)) {
      return { action: 'pending', refundId: pickRefundId(recordedSettled, pending) };
    }
    const refundId = pickRefundId(recordedSettled, pending);
    await persistPendingProviderRefundId(booking._id, claimId, refundId);
    return { action: 'settled', refundId };
  }

  const recordedPending = recordedFacts.filter((fact) => isPendingRefundStatus(fact.status));
  if (recordedPending.length > 0) {
    const refundId = pickRefundId(recordedPending, pending);
    await persistPendingProviderRefundId(booking._id, claimId, refundId);
    return { action: 'pending', refundId };
  }

  const providerRefunds = await listProviderRefunds(intent);
  const providerFacts = providerRefunds
    .map((refund) => providerRefundFact({ refund, booking, intent, currency, recordedById }))
    .filter((fact): fact is RefundFact => Boolean(fact))
    .filter((fact) => matchesPendingObligation(fact, pending))
    .filter((fact) => !fact.refundId || !recordedById.has(fact.refundId));

  const providerSettled = providerFacts.filter((fact) => isSettledRefundStatus(fact.status));
  if (providerSettled.length > 0) {
    await persistProviderFacts({ booking, facts: providerSettled });
    if (!hasSingleIdentity(providerSettled, pending)) {
      return { action: 'pending', refundId: pickRefundId(providerSettled, pending) };
    }
    const refundId = pickRefundId(providerSettled, pending);
    await persistPendingProviderRefundId(booking._id, claimId, refundId);
    return { action: 'settled', refundId };
  }

  const providerPending = providerFacts.filter((fact) => isPendingRefundStatus(fact.status));
  if (providerPending.length > 0) {
    await persistProviderFacts({ booking, facts: providerPending });
    const refundId = pickRefundId(providerPending, pending);
    await persistPendingProviderRefundId(booking._id, claimId, refundId);
    return { action: 'pending', refundId };
  }

  const allFacts = [...recordedFacts, ...providerFacts];
  // A previously persisted provider refund that is no longer visible in the
  // provider list cannot be proven failed. Do not create another cash movement
  // on an ambiguous provider state; keep the obligation pending for support.
  if (
    pending.providerRefundId
    && !allFacts.some((fact) => fact.refundId === pending.providerRefundId)
  ) {
    return { action: 'pending', refundId: pending.providerRefundId };
  }

  const failed = allFacts.filter((fact) => isFailedRefundStatus(fact.status));
  const failedIds = new Set(failed.map((fact) => fact.refundId).filter(Boolean));
  return { action: 'retry', attempt: failedIds.size };
};

export type CompletionRefundSettlement =
  | {
      ok: true;
      booking: any;
      pending: PendingExtraCostRefund;
      claimId: string;
      reconciled: boolean;
      providerRefundId?: string;
    }
  | {
      ok: false;
      reason: 'refund_in_progress' | 'refund_not_pending' | 'refund_failed' | 'refund_pending';
      error?: unknown;
    };

/**
 * Settle the persisted refund through the shared tagged extra-cost operation.
 * Before any cash movement it reconciles the local ledger and the actual
 * provider refunds for this PaymentIntent, so an accepted refund is recognised
 * even after the provider idempotency-key window and after a failed local
 * ledger write. A failure releases only this claim's lease; the obligation
 * stays persisted for another attempt.
 */
export const settlePendingExtraCostRefund = async (
  booking: any,
  opts: { alreadyClaimed?: boolean; claimId?: string } = {},
): Promise<CompletionRefundSettlement> => {
  let target = booking;
  let claimId = opts.claimId;
  if (!opts.alreadyClaimed) {
    const claimed = await claimPendingExtraCostRefund(booking._id);
    if (!claimed) return { ok: false, reason: 'refund_in_progress' };
    target = claimed;
    claimId = getPendingExtraCostRefund(claimed)?.claimId;
  }

  const pending = getPendingExtraCostRefund(target);
  if (!pending) {
    await releasePendingExtraCostRefundClaim(target._id, claimId).catch(() => undefined);
    return { ok: false, reason: 'refund_not_pending' };
  }
  claimId = claimId || pending.claimId;
  if (!claimId) {
    return { ok: false, reason: 'refund_not_pending' };
  }

  try {
    const reconciliation = await reconcilePendingExtraCostRefund({
      booking: target,
      pending,
      claimId,
    });

    if (reconciliation.action === 'settled') {
      return {
        ok: true,
        booking: target,
        pending,
        claimId,
        reconciled: true,
        providerRefundId: reconciliation.refundId,
      };
    }
    if (reconciliation.action === 'pending') {
      await releasePendingExtraCostRefundClaim(target._id, claimId).catch(() => undefined);
      return { ok: false, reason: 'refund_pending' };
    }

    const result = await refundExtraCostAdjustment({
      booking: target,
      amount: pending.amount,
      reason: pending.reason,
      actorId: pending.actorId || null,
      obligationId: pending.obligationId,
      attempt: reconciliation.attempt,
      claimId,
    });
    const status = normalizeRefundStatus(result.status);
    if (isFailedRefundStatus(status)) {
      await releasePendingExtraCostRefundClaim(target._id, claimId).catch(() => undefined);
      return { ok: false, reason: 'refund_failed' };
    }
    if (isPendingRefundStatus(status)) {
      await releasePendingExtraCostRefundClaim(target._id, claimId).catch(() => undefined);
      return { ok: false, reason: 'refund_pending' };
    }
    await persistPendingProviderRefundId(target._id, claimId, result.refundId);
    return {
      ok: true,
      booking: target,
      pending,
      claimId,
      reconciled: false,
      providerRefundId: result.refundId,
    };
  } catch (error) {
    await releasePendingExtraCostRefundClaim(target._id, claimId).catch(() => undefined);
    return { ok: false, reason: 'refund_failed', error };
  }
};
