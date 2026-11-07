import { convertFromStripeAmount } from './payment';

/** Match legacy booking details for a first payment. A milestone's amount is
 * its plan net; without a recorded gross use that intent's actual Stripe charge.
 */
export const paymentConfirmationAmount = (
  payment: { totalWithVat?: unknown; amount?: unknown; milestoneIndex?: unknown } | undefined,
  intent: { amount: number; currency: string },
): number | undefined => {
  const confirmed = convertFromStripeAmount(intent.amount, intent.currency);
  const candidates = payment?.milestoneIndex != null
    ? [payment.totalWithVat, confirmed]
    : [payment?.totalWithVat, payment?.amount, confirmed];
  for (const value of candidates) {
    if (value != null && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
};
