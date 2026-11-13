import { createHash } from 'crypto';
import { refundCountsAsCash } from '../paymentRefunds';

/**
 * Read-only normalization of the two persisted payment sources:
 *
 * - `Payment` documents hold the per-charge/per-refund ledger (`refunds[]`).
 * - `Booking.payment` holds the legacy/aggregate payment facts, including the
 *   authoritative aggregate booking refund (`refundAmount`, `refundedAt`,
 *   `refundReason`, `refundSource`). Provider-dashboard refunds issued before
 *   the per-refund ledger existed only have this aggregate.
 *
 * The aggregate can coexist with a `Payment` row for the same PaymentIntent.
 * It must still be surfaced, but only the amount not already represented by a
 * recorded refund row, otherwise the same money would be refunded twice in the
 * details DTO/activity.
 */

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const num = (value: unknown): number | null => {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : null;
};

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export const opaqueRefundReference = (seed: string): string =>
  createHash('sha256').update(seed).digest('hex').slice(0, 16);

export interface ResolvedPaymentRow {
  payment: any;
  isFallback: boolean;
}

const paymentFingerprint = (payment: any): string => {
  if (payment?._id) return `id:${String(payment._id)}`;
  const intent = str(payment?.stripePaymentIntentId)
    || str(payment?.extraCostStripePaymentIntentId)
    || '';
  return `intent:${intent}:${payment?.milestoneIndex ?? 'base'}`;
};

/**
 * Return every distinct payment record plus the booking payment fallback when
 * no `Payment` row represents the same intent. The fallback keeps legacy
 * amounts/timestamps readable; it is never used to duplicate a real row.
 */
export const resolvePaymentRows = (booking: any, payments: any[]): ResolvedPaymentRow[] => {
  const rows: ResolvedPaymentRow[] = [];
  const seen = new Set<string>();
  for (const payment of Array.isArray(payments) ? payments : []) {
    if (!payment || typeof payment !== 'object') continue;
    const fingerprint = paymentFingerprint(payment);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    rows.push({ payment, isFallback: false });
  }

  const fallback = booking?.payment;
  if (fallback && typeof fallback === 'object') {
    const intent = str(fallback.stripePaymentIntentId);
    const represented = Boolean(
      intent && rows.some((row) => str(row.payment?.stripePaymentIntentId) === intent),
    );
    // With a real Payment row and no intent to match, the booking subdocument
    // stays the aggregate source rather than becoming a duplicate record.
    if (!represented && (rows.length === 0 || intent)) {
      rows.push({ payment: { ...fallback, __fallback: true }, isFallback: true });
    }
  }

  return rows;
};

export interface RefundFact {
  /** Stable seed used to build participant-facing opaque ids. */
  seed: string;
  amount: number;
  currency: string | null;
  currencySource: 'payment' | 'quote' | 'cancellation_request' | 'not_recorded';
  refundedAt: string | null;
  source: 'professional' | 'platform' | 'mixed' | null;
  status: 'recorded' | 'aggregate_only' | 'approved' | 'denied';
  /**
   * Provider refund status when the record came from Stripe. A `pending` or
   * `requires_action` refund counts as reserved cash but has not moved yet.
   */
  providerStatus: string | null;
  justification: string | null;
  justificationRecorded: boolean;
  vatAmount: number | null;
  netAmount: number | null;
  vatRate: number | null;
  vatSplitRecorded: boolean;
  /** VAT/net computed pro rata from the refunded payment's recorded VAT (not written by the refund itself). */
  vatSplitDerived?: boolean;
  kind: 'booking' | 'extra_cost';
  providerRefundId: string | null;
  /** Actual actor recorded on the refund source, when one exists. */
  actorId: string | null;
  internalNotes: string | null;
  paymentId: string | null;
  paymentIndex: number | null;
  refundIndex: number | null;
  cancellationRequestId: string | null;
  noticeCodes: string[];
}

/**
 * Build the authoritative refund ledger:
 *
 * 1. Every positive `Payment.refunds[]` row, deduped by provider refund id.
 * 2. The booking-payment aggregate refund, reduced by the booking-kind rows
 *    that belong to the same PaymentIntent. Only the unrepresented residual is
 *    emitted, and always as `aggregate_only` with no invented VAT split.
 * 3. Cancellation-request refunds that no payment/aggregate record represents
 *    (matched by amount and recorded time, never by read time).
 *
 * Extra-cost refunds are excluded from the base aggregate arithmetic but kept
 * in the ledger with `kind:"extra_cost"`.
 */
/**
 * Pro-rata VAT split of a refund from the refunded payment's RECORDED VAT
 * (vatBreakdown lines, else its single rate, else its VAT share). Used only
 * when the refund writer did not record its own split; the result is
 * labelled "derived" to the viewer. Returns null when the payment carries no
 * usable VAT facts.
 */
export const deriveRefundVatSplit = (
  amount: number,
  payment: any,
): { netAmount: number; vatAmount: number; vatRate: number | null } | null => {
  if (!payment || !(amount > 0)) return null;
  const lines = Array.isArray(payment.vatBreakdown) ? payment.vatBreakdown : [];
  const usable = lines.filter((line: any) =>
    Number.isFinite(Number(line?.netAmount)) && Number.isFinite(Number(line?.vatAmount)));
  const gross = usable.reduce((sum: number, line: any) => sum + Number(line.netAmount) + Number(line.vatAmount), 0);
  if (usable.length > 0 && gross > 0) {
    const vat = usable.reduce((sum: number, line: any) => sum + (amount * Number(line.vatAmount)) / gross, 0);
    const rates = Array.from(new Set(usable.map((line: any) => Number(line.vatRate)).filter((rate: number) => Number.isFinite(rate))));
    const vatAmount = roundMoney(vat);
    return { netAmount: roundMoney(amount - vatAmount), vatAmount, vatRate: rates.length === 1 ? (rates[0] as number) : null };
  }
  const rate = num(payment.vatRate);
  if (rate != null && rate >= 0) {
    const netAmount = roundMoney(amount / (1 + rate / 100));
    return { netAmount, vatAmount: roundMoney(amount - netAmount), vatRate: rate };
  }
  const paymentVat = num(payment.vatAmount);
  const paymentGross = num(payment.totalWithVat);
  if (paymentVat != null && paymentGross != null && paymentGross > 0) {
    const vatAmount = roundMoney((amount * paymentVat) / paymentGross);
    return { netAmount: roundMoney(amount - vatAmount), vatAmount, vatRate: null };
  }
  return null;
};

const withDerivedVat = <T extends { amount: number; vatSplitRecorded: boolean; netAmount: number | null; vatAmount: number | null; vatRate: number | null; noticeCodes: string[] }>(
  fact: T,
  payment: any,
): T & { vatSplitDerived?: boolean } => {
  if (fact.vatSplitRecorded) return fact;
  const derived = deriveRefundVatSplit(fact.amount, payment);
  if (!derived) return fact;
  return {
    ...fact,
    netAmount: derived.netAmount,
    vatAmount: derived.vatAmount,
    vatRate: derived.vatRate,
    vatSplitDerived: true,
    noticeCodes: [...fact.noticeCodes.filter((code) => code !== 'REFUND_VAT_SPLIT_NOT_RECORDED'), 'REFUND_VAT_SPLIT_DERIVED'],
  };
};

export const resolveRefundFacts = (params: {
  booking: any;
  paymentRows: Array<ResolvedPaymentRow | any>;
  quoteCurrency?: string | null;
}): RefundFact[] => {
  const { booking } = params;
  const quoteCurrency = str(params.quoteCurrency);
  const rows: ResolvedPaymentRow[] = (params.paymentRows || []).map((row: any) =>
    row && row.payment ? row : { payment: row, isFallback: false },
  );

  const facts: RefundFact[] = [];
  const seenProviderIds = new Set<string>();
  const seenRowKeys = new Set<string>();
  const baseIntent = str(booking?.payment?.stripePaymentIntentId);
  let representedBaseBookingRefund = 0;

  for (const [paymentIndex, row] of rows.entries()) {
    const payment = row.payment || {};
    const paymentId = payment._id ? String(payment._id) : null;
    const currency = str(payment.currency) || quoteCurrency || null;
    const currencySource = payment.currency
      ? 'payment' as const
      : quoteCurrency
        ? 'quote' as const
        : 'not_recorded' as const;
    const rowMatchesBaseIntent = baseIntent
      ? str(payment.stripePaymentIntentId) === baseIntent
        || (num(payment.milestoneIndex) == null && !str(payment.stripePaymentIntentId))
      : row.isFallback || rows.length === 1;
    const refunds = Array.isArray(payment.refunds) ? payment.refunds : [];

    for (const [refundIndex, refund] of refunds.entries()) {
      if (!refund || typeof refund !== 'object') continue;
      if (!refundCountsAsCash(refund)) continue;
      const amount = num(refund.amount);
      if (amount == null || amount <= 0) continue;
      const providerRefundId = str(refund.refundId);
      if (providerRefundId && seenProviderIds.has(providerRefundId)) continue;
      const rowKey = providerRefundId
        ? `id:${providerRefundId}`
        : `${paymentId || 'booking'}:${refundIndex}:${amount}:${iso(refund.refundedAt) || ''}`;
      if (seenRowKeys.has(rowKey)) continue;
      seenRowKeys.add(rowKey);
      if (providerRefundId) seenProviderIds.add(providerRefundId);

      const kind: RefundFact['kind'] = refund.kind === 'extra_cost' ? 'extra_cost' : 'booking';
      if (kind === 'booking' && rowMatchesBaseIntent) {
        representedBaseBookingRefund = roundMoney(representedBaseBookingRefund + amount);
      }
      const netAmount = num(refund.netAmount);
      const vatAmount = num(refund.vatAmount);
      const vatSplitRecorded = netAmount != null || vatAmount != null;
      facts.push(withDerivedVat({
        seed: providerRefundId
          ? `provider:${providerRefundId}`
          : `payment:${paymentId || 'booking'}:${refundIndex}:${amount}`,
        amount,
        currency,
        currencySource,
        refundedAt: iso(refund.refundedAt),
        source: refund.source || null,
        status: 'recorded',
        providerStatus: str(refund.status),
        justification: str(refund.reason),
        justificationRecorded: Boolean(str(refund.reason)),
        vatAmount,
        netAmount,
        vatRate: num(refund.vatRate),
        vatSplitRecorded,
        kind,
        providerRefundId,
        actorId: refund.refundedBy ? String(refund.refundedBy) : null,
        internalNotes: str(refund.notes),
        paymentId,
        paymentIndex,
        refundIndex,
        cancellationRequestId: null,
        noticeCodes: vatSplitRecorded ? [] : ['REFUND_VAT_SPLIT_NOT_RECORDED'],
      }, payment));
    }
  }

  const aggregateAmount = num(booking?.payment?.refundAmount);
  if (aggregateAmount != null && aggregateAmount > 0) {
    const residual = roundMoney(aggregateAmount - representedBaseBookingRefund);
    if (residual > 0.01) {
      const anchor = rows.find(
        (row) => baseIntent && str(row.payment?.stripePaymentIntentId) === baseIntent,
      ) || rows.find((row) => row.isFallback) || rows[0];
      const anchorPayment = anchor?.payment || null;
      const aggregateCurrency = str(booking?.payment?.currency)
        || str(anchorPayment?.currency)
        || quoteCurrency
        || null;
      const paymentId = anchorPayment?._id ? String(anchorPayment._id) : null;
      facts.push(withDerivedVat({
        seed: `aggregate:${paymentId || 'booking'}:${residual}`,
        amount: residual,
        currency: aggregateCurrency,
        currencySource: booking?.payment?.currency
          ? 'payment'
          : anchorPayment?.currency
            ? 'payment'
            : quoteCurrency
              ? 'quote'
              : 'not_recorded',
        refundedAt: iso(booking?.payment?.refundedAt),
        source: booking?.payment?.refundSource || null,
        status: 'aggregate_only',
        providerStatus: null,
        justification: str(booking?.payment?.refundReason),
        justificationRecorded: Boolean(str(booking?.payment?.refundReason)),
        vatAmount: null,
        netAmount: null,
        vatRate: null,
        vatSplitRecorded: false,
        kind: 'booking',
        providerRefundId: null,
        actorId: null,
        internalNotes: str(booking?.payment?.refundNotes),
        paymentId,
        paymentIndex: anchor ? rows.indexOf(anchor) : null,
        refundIndex: null,
        cancellationRequestId: null,
        noticeCodes: ['REFUND_VAT_SPLIT_NOT_RECORDED'],
      }, anchorPayment));
    }
  }

  // Cancellation-request refunds are real recorded facts. They are only added
  // when no payment row/aggregate refund already represents the same amount at
  // the recorded time. This is the same fact-matching rule the details DTO has
  // always used, now applied to aggregate facts as well.
  const cancellationRequests = Array.isArray(booking?.__cancellationRequests)
    ? booking.__cancellationRequests
    : [];
  for (const request of cancellationRequests) {
    const amount = num(request?.refundAmount);
    const refundedAt = iso(request?.refundedAt);
    if (amount == null || amount <= 0 || !refundedAt) continue;
    const refundTime = new Date(refundedAt).getTime();
    const represented = facts.some((fact) => {
      const time = fact.refundedAt ? new Date(fact.refundedAt).getTime() : NaN;
      return Number.isFinite(time)
        && Math.abs(time - refundTime) <= 5 * 60 * 1000
        && Math.abs(fact.amount - amount) < 0.01;
    });
    if (represented) continue;
    const basePaymentRow = rows.find(
      (row) => baseIntent && str(row.payment?.stripePaymentIntentId) === baseIntent,
    ) || rows.find((row) => row.isFallback) || rows[0];
    facts.push(withDerivedVat({
      seed: `cancellation:${String(request._id)}:refund`,
      amount,
      currency: str(booking?.payment?.currency) || quoteCurrency || null,
      currencySource: booking?.payment?.currency
        ? 'payment'
        : quoteCurrency
          ? 'quote'
          : 'cancellation_request',
      refundedAt,
      source: 'platform',
      status: request?.status === 'denied' ? 'denied' : 'approved',
      providerStatus: null,
      justification: str(request?.reason),
      justificationRecorded: Boolean(str(request?.reason)),
      vatAmount: null,
      netAmount: null,
      vatRate: null,
      vatSplitRecorded: false,
      kind: 'booking',
      providerRefundId: null,
      actorId: request?.resolvedBy ? String(request.resolvedBy) : null,
      internalNotes: null,
      paymentId: null,
      paymentIndex: null,
      refundIndex: null,
      cancellationRequestId: request?._id ? String(request._id) : null,
      noticeCodes: ['REFUND_VAT_SPLIT_NOT_RECORDED'],
    }, basePaymentRow?.payment));
  }

  facts.sort((a, b) => {
    const at = a.refundedAt ? new Date(a.refundedAt).getTime() : 0;
    const bt = b.refundedAt ? new Date(b.refundedAt).getTime() : 0;
    return at - bt;
  });

  return facts;
};

export const refundFactReference = (fact: RefundFact): string =>
  opaqueRefundReference(fact.seed);
