/**
 * Shared pure helpers for the persisted refund ledger.
 *
 * `Payment.refunds[]` is the per-refund ledger; `booking.payment.refundAmount`
 * is the historical/authoritative aggregate for booking-price refunds. Both
 * must be read together, and only for the base PaymentIntent: milestone
 * payments are separate charges and must never reduce the base refundable
 * capacity or absorb the base refund row.
 *
 * Database reads/writes live in `paymentRefundLedger.ts` so read-only DTO
 * builders do not import the Payment model (and its Stripe configuration).
 */

export type RecordedRefundStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled';

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const roundRefundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * A failed/canceled refund did not return money and must not consume the
 * refundable capacity. Pending/requires_action refunds do reserve provider
 * capacity and are therefore counted as refunded until the provider reports a
 * failure.
 */
export const refundCountsAsCash = (refund: any): boolean => {
  const status = str(refund?.status);
  return status !== 'failed' && status !== 'canceled';
};

export const basePaymentRowFilter = (booking: any) => ({
  booking: booking?._id,
  milestoneIndex: null,
});

export interface BaseRefundSummary {
  refunds: any[];
  allTotal: number;
  bookingTotal: number;
  extraCostTotal: number;
}

/**
 * Normalize/dedupe the base refund ledger, keeping failed/canceled rows so a
 * reconciliation path can distinguish "not cash" from "not recorded". Duplicate
 * webhook/provider rows with the same provider refund id are one fact.
 */
export const collectBaseRefunds = (rows: any[]): any[] => {
  const seen = new Set<string>();
  const refunds: any[] = [];

  for (const [paymentIndex, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const rowId = row?._id ? String(row._id) : `row-${paymentIndex}`;
    const rowRefunds = Array.isArray(row?.refunds) ? row.refunds : [];
    for (const [refundIndex, refund] of rowRefunds.entries()) {
      if (!refund || typeof refund !== 'object') continue;
      const amount = Number(refund.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const providerRefundId = str(refund.refundId);
      const key = providerRefundId
        ? `id:${providerRefundId}`
        : `${rowId}:${refundIndex}:${amount}:${iso(refund.refundedAt) || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refunds.push(refund);
    }
  }

  return refunds;
};

/**
 * Cash summary of the base ledger. Failed/canceled refunds are excluded;
 * pending/requires_action rows reserve capacity.
 */
export const summarizeBaseRefunds = (rows: any[]): BaseRefundSummary => {
  const refunds: any[] = [];
  let allTotal = 0;
  let bookingTotal = 0;
  let extraCostTotal = 0;

  for (const refund of collectBaseRefunds(rows)) {
    if (!refundCountsAsCash(refund)) continue;
    const amount = Number(refund.amount);
    refunds.push(refund);
    allTotal += amount;
    if (refund.kind === 'extra_cost') {
      extraCostTotal += amount;
    } else {
      bookingTotal += amount;
    }
  }

  return {
    refunds,
    allTotal: roundRefundMoney(allTotal),
    bookingTotal: roundRefundMoney(bookingTotal),
    extraCostTotal: roundRefundMoney(extraCostTotal),
  };
};

const idOf = (value: any): any =>
  value && typeof value === 'object' && value._id ? value._id : value;

/**
 * Required/default facts when a provider or completion refund must create the
 * first Payment row for a legacy booking. Copies only recorded base-payment
 * facts; no amount is allocated or invented.
 */
export const basePaymentRowDefaults = (booking: any): Record<string, any> => {
  const base = booking?.payment || {};
  const quote = booking?.quote || {};
  const defaults: Record<string, any> = {
    booking: booking?._id,
    customer: idOf(booking?.customer),
    status: base.status || 'pending',
    currency: base.currency || quote.currency || 'EUR',
    amount: base.amount ?? quote.amount ?? 0,
  };
  const bookingNumber = booking?.bookingNumber;
  if (bookingNumber != null) defaults.bookingNumber = bookingNumber;
  const professional = idOf(booking?.professional);
  if (professional) defaults.professional = professional;
  const copyFields = [
    'method',
    'netAmount',
    'vatAmount',
    'vatRate',
    'totalWithVat',
    'reverseCharge',
    'vatBreakdown',
    'platformCommission',
    'professionalPayout',
    'stripePaymentIntentId',
    'stripeChargeId',
    'stripeTransferId',
    'stripeDestinationPayment',
    'transferStatus',
    'transferCurrency',
    'transferAmount',
    'transferIdempotencyKey',
    'transferAttempt',
    'transferFailureReason',
    'transferAttemptedAt',
    'authorizedAt',
    'capturedAt',
    'transferredAt',
    'refundedAt',
    'canceledAt',
    'extraCostAmount',
    'extraCostCustomerNetAmount',
    'extraCostVatAmount',
    'extraCostPlatformFee',
    'extraCostNetAmount',
    'extraCostCustomerDiscount',
    'extraCostPlatformCommission',
    'extraCostProfessionalPayout',
    'extraCostStatus',
    'extraCostPaymentSucceeded',
    'extraCostPaidAt',
    'extraCostStripePaymentIntentId',
    'extraCostStripeChargeId',
    'extraCostTransferId',
    'extraCostTransferStatus',
  ] as const;
  for (const field of copyFields) {
    if (base[field] !== undefined) defaults[field] = base[field];
  }
  return defaults;
};
