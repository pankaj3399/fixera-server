import Referral from '../models/referral';
import Booking, { type IPaymentDiscountLedgerEntry } from "../models/booking";

/**
 * Durable per-payment discount ledger (`booking.paymentDiscountLedger`).
 *
 * Each milestone checkout replaces `booking.payment` and its discount
 * snapshot. When a PaymentIntent succeeds, its snapshot is copied here once,
 * keyed by the PaymentIntent id (and by milestone index for milestone
 * payments), so earlier milestones keep their recorded savings after the next
 * checkout.
 *
 * Writes are idempotent: the update matches only while no entry for the same
 * PaymentIntent (or milestone) exists, so duplicate webhook deliveries, the
 * confirm endpoint and retries add at most one entry. The write also matches
 * only while `booking.payment` still belongs to that PaymentIntent, so a
 * snapshot is never attributed to a payment it was not computed for.
 */

const money = (value: unknown): number => {
  const amount = typeof value === "string" ? Number(value) : (value as number);
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100) / 100
    : 0;
};

/** Build the ledger entry for the current `booking.payment`, or null without a PaymentIntent. */
export const buildPaymentDiscountLedgerEntry = (
  payment: any,
  recordedAt: Date = new Date(),
): IPaymentDiscountLedgerEntry | null => {
  const paymentIntentId = typeof payment?.stripePaymentIntentId === "string"
    ? payment.stripePaymentIntentId.trim()
    : "";
  if (!paymentIntentId) return null;
  const discount = payment?.discount || {};
  const milestoneIndex = Number.isInteger(payment?.milestoneIndex) && payment.milestoneIndex >= 0
    ? payment.milestoneIndex
    : undefined;
  const currency = typeof payment?.currency === "string" && payment.currency.trim()
    ? payment.currency.trim().toUpperCase()
    : undefined;
  return {
    paymentIntentId,
    ...Object.fromEntries(['netAmount', 'vatAmount', 'totalWithVat', 'platformCommission', 'professionalPayout', 'vatRate']
      .filter(key => payment[key] != null && Number.isFinite(Number(payment[key])))
      .map(key => [key, Number(payment[key])])),
    ...(typeof payment.reverseCharge === 'boolean' ? { reverseCharge: payment.reverseCharge } : {}),
    ...(milestoneIndex !== undefined ? { milestoneIndex } : {}),
    ...(currency ? { currency } : {}),
    // Legacy payments may have no snapshot; new checkouts persist one even
    // when the configured discounts amount to zero.
    originalAmount: money(discount.originalAmount),
    loyaltyAmount: money(discount.loyaltyAmount),
    repeatBuyerAmount: money(discount.repeatBuyerAmount),
    pointsDiscountAmount: money(discount.pointsDiscountAmount),
    codeDiscountAmount: money(discount.codeDiscountAmount),
    ...(discount.referralDiscountAmount !== undefined ? { referralDiscountAmount: money(discount.referralDiscountAmount) } : {}),
    totalDiscount: money(discount.totalDiscount),
    recordedAt,
  };
};

/**
 * Record the discount snapshot of a succeeded PaymentIntent exactly once.
 * Returns true only when this call added the entry.
 */
export const recordPaymentDiscountSnapshot = async (
  bookingId: unknown,
  payment: any,
  paymentIntentId: string,
  recordedAt: Date = new Date(),
): Promise<boolean> => {
  if (!bookingId || !paymentIntentId || payment?.stripePaymentIntentId !== paymentIntentId) {
    return false;
  }
  const entry = buildPaymentDiscountLedgerEntry(payment, recordedAt);
  if (!entry) return false;

  const filter: Record<string, unknown> = {
    _id: bookingId,
    "payment.stripePaymentIntentId": paymentIntentId,
    "paymentDiscountLedger.paymentIntentId": { $ne: paymentIntentId },
  };
  if (entry.milestoneIndex !== undefined) {
    filter["paymentDiscountLedger.milestoneIndex"] = { $ne: entry.milestoneIndex };
  }
  const result = await Booking.updateOne(filter, { $push: { paymentDiscountLedger: entry } });
  if (payment.discount?.referralId && money(payment.discount?.referralDiscountAmount) > 0) {
    // The settled intent's own checkout snapshot is authority. The booking
    // binding makes this idempotent and prevents consuming another benefit.
    await Referral.updateOne({ _id: payment.discount.referralId, discountBooking: bookingId }, { $set: { referredUserDiscountApplied: true } });
  }
  return result.modifiedCount === 1;
};
