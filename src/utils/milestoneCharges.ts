/**
 * Milestone charge plan (client bug list #19b).
 *
 * Quotation options are NEVER split across milestones: the selected options
 * are charged in full (commission included) together with the first
 * milestone, and every other milestone charges its own base amount only.
 * This is the single source of truth for that rule — the Stripe payment
 * intent builder, the milestone-due notifier and the booking-details read
 * model all derive their per-milestone amounts from it, so the amounts the
 * customer sees always match the amounts actually charged.
 */
import { quoteAmountIncludesSelectedExtras } from './payment';

export interface MilestoneChargeEntry {
  /** Position in booking.milestonePayments. */
  index: number;
  /** Milestone order value (first milestone = smallest order). */
  order: number;
  /** Professional-net milestone amount, as stored on the booking. */
  baseProfessionalAmount: number;
  /** Customer gross for the milestone alone (commission included). */
  baseCustomerGross: number;
  /** Commissioned options total attached to this milestone (0 except first). */
  optionsCustomerGross: number;
  /** Amount the customer is actually charged for this milestone. */
  expectedCustomerGross: number;
  /** True when this milestone carries the selected options in full. */
  includesSelectedOptions: boolean;
}

/** Commission-inclusive gross, mirroring the payment-intent rounding. */
export const toMilestoneCustomerGross = (professionalAmount: number, commissionPercent: number): number => {
  const safeCommission = Math.max(0, Number(commissionPercent) || 0);
  return +(Number(professionalAmount) * (1 + safeCommission / 100)).toFixed(2);
};

export const sumSelectedOptionPrices = (booking: any): number =>
  (Array.isArray(booking?.selectedExtraOptions) ? booking.selectedExtraOptions : []).reduce(
    (sum: number, option: any) => sum + (Number(option?.bookedPrice) || 0),
    0,
  );

/**
 * Per-milestone customer charges with options concentrated on the first
 * (minimum-order) milestone. Returns [] when the booking has no milestones.
 * When the quote already folds the selected extras in
 * (quoteAmountIncludesSelectedExtras), nothing extra is attached anywhere.
 */
export const buildMilestoneChargePlan = (
  booking: any,
  commissionPercent: number,
): MilestoneChargeEntry[] => {
  const milestones = Array.isArray(booking?.milestonePayments) ? booking.milestonePayments : [];
  if (milestones.length === 0) return [];

  const orders = milestones.map((milestone: any) => Number(milestone?.order ?? 0));
  const minOrder = Math.min(...orders);
  const optionsTotal = sumSelectedOptionPrices(booking);
  const optionsGross =
    optionsTotal > 0 && !quoteAmountIncludesSelectedExtras(booking)
      ? toMilestoneCustomerGross(optionsTotal, commissionPercent)
      : 0;

  return milestones.map((milestone: any, index: number) => {
    const order = Number(milestone?.order ?? 0);
    const baseProfessionalAmount = Number(milestone?.amount) || 0;
    const baseCustomerGross = toMilestoneCustomerGross(baseProfessionalAmount, commissionPercent);
    const isFirst = order === minOrder;
    const optionsCustomerGross = isFirst ? optionsGross : 0;
    return {
      index,
      order,
      baseProfessionalAmount,
      baseCustomerGross,
      optionsCustomerGross,
      expectedCustomerGross: +(baseCustomerGross + optionsCustomerGross).toFixed(2),
      includesSelectedOptions: optionsCustomerGross > 0,
    };
  });
};
