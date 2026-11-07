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
  /** Commission-inclusive plan net, BEFORE customer discounts and VAT. */
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

  const orders = milestones.map((milestone: any) => {
    const order = Number(milestone?.order ?? 0);
    return Number.isFinite(order) ? order : 0;
  });
  const minOrder = Math.min(...orders);
  const optionsTotal = sumSelectedOptionPrices(booking);
  const optionsGross =
    optionsTotal > 0 && !quoteAmountIncludesSelectedExtras(booking)
      ? toMilestoneCustomerGross(optionsTotal, commissionPercent)
      : 0;

  return milestones.map((milestone: any, index: number) => {
    const order = orders[index];
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

/** A display total requires recorded VAT/discount terms, or an actual payment. */
export const milestoneCustomerCharge = (
  booking: any,
  entry: MilestoneChargeEntry,
  payments: any[] = [],
): number | null => {
  const matchingRows = payments.filter(payment => payment.milestoneIndex === entry.index);
  const matching = matchingRows.find(payment => ['completed', 'partially_refunded', 'refunded'].includes(payment.status))
    || matchingRows.find(payment => ['pending', 'authorized'].includes(payment.status));
  const snapshot = booking.payment?.milestoneIndex === entry.index
    && !['failed', 'canceled'].includes(booking.payment?.status) ? booking.payment : undefined;
  const recorded = matching || snapshot;
  if (recorded?.totalWithVat != null && Number.isFinite(Number(recorded.totalWithVat))) {
    return Number(recorded.totalWithVat);
  }
  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  const version = versions.find((candidate: any) => Number(candidate.version) === Number(booking.currentQuoteVersion));
  const totals = version?.customerTotals;
  const beforeDiscount = Number(totals?.amountBeforeDiscounts);
  const afterDiscount = Number(totals?.customerNetAmount);
  // Quote-time benefits can differ from checkout benefits. Once a checkout
  // exists above, its own total takes precedence over this estimate.
  const discountRatio = beforeDiscount > 0 && Number.isFinite(afterDiscount)
    ? Math.min(1, Math.max(0, afterDiscount / beforeDiscount)) : 1;
  const net = Math.round(entry.expectedCustomerGross * discountRatio * 100) / 100;
  const reverseCharge = booking.vatDecision?.reverseCharge;
  if (reverseCharge === true) return net;
  const vatRate = totals?.vatRate ?? booking.vatDecision?.appliedRate;
  if (vatRate == null || !Number.isFinite(Number(vatRate))) return null;
  // For mixed-rate quotations, keep the recorded tax ratio rather than
  // treating the nominal headline rate as every line's rate.
  const vatRatio = afterDiscount > 0 && totals?.vatAmount != null
    ? Number(totals.vatAmount) / afterDiscount : Number(vatRate) / 100;
  return Math.round((net + Math.round(net * vatRatio * 100) / 100) * 100) / 100;
};
