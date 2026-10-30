import { withCommission } from "./customerPricing";
import { computePostRefundInvoicePayment } from "./invoiceAccounting";
import { quoteAmountIncludesSelectedExtras } from "./payment";

const roundMoney = (value: number): number =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const sumMilestoneProfessionalAmounts = (booking: any): number =>
  (Array.isArray(booking?.milestonePayments) ? booking.milestonePayments : []).reduce(
    (sum: number, milestone: any) => {
      const amount = Number(milestone?.amount);
      return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
    },
    0,
  );

const sumSelectedOptionPrices = (booking: any): number =>
  (Array.isArray(booking?.selectedExtraOptions) ? booking.selectedExtraOptions : []).reduce(
    (sum: number, option: any) => {
      const price = Number(option?.bookedPrice);
      return Number.isFinite(price) && price > 0 ? sum + price : sum;
    },
    0,
  );

/**
 * Full pre-discount customer gross for a milestone booking: every milestone's
 * professional amount plus the selected options (unless the quote already
 * folds them in), with the platform commission applied the same way each
 * milestone charge applied it. Returns null when the booking has no usable
 * milestone amounts (caller keeps the legacy payment-field behaviour).
 */
export const getMilestoneFullCustomerGross = (
  booking: any,
  commissionPercent: number,
): number | null => {
  if (!Array.isArray(booking?.milestonePayments) || booking.milestonePayments.length === 0) {
    return null;
  }
  const milestoneProSum = sumMilestoneProfessionalAmounts(booking);
  if (!(milestoneProSum > 0)) return null;
  const optionsPro = quoteAmountIncludesSelectedExtras(booking) ? 0 : sumSelectedOptionPrices(booking);
  return withCommission(milestoneProSum + optionsPro, commissionPercent);
};

export type ScaledInvoiceDiscount = {
  loyaltyAmount: number;
  repeatBuyerAmount: number;
  pointsDiscountAmount: number;
  codeDiscountAmount: number;
  codeLabel?: string;
  totalDiscount: number;
};

/**
 * Recover the full-booking discount from the stored per-milestone slice. Each
 * milestone payment prorated the whole-booking discount by
 * (milestone charge / full charge); scaling the slice back up by the inverse
 * ratio restores the full amounts (within rounding).
 */
export const scaleDiscountToFullGross = (
  discount: any,
  sliceOriginalAmount: unknown,
  fullGross: number,
): ScaledInvoiceDiscount | undefined => {
  if (!discount) return undefined;
  const sliceOriginal = Number(sliceOriginalAmount);
  const total = Number(discount.totalDiscount) || 0;
  if (total <= 0) return undefined;
  const factor = sliceOriginal > 0 && fullGross > 0 ? fullGross / sliceOriginal : 1;
  const scale = (value: unknown): number => roundMoney((Number(value) || 0) * factor);
  return {
    loyaltyAmount: scale(discount.loyaltyAmount),
    repeatBuyerAmount: scale(discount.repeatBuyerAmount),
    pointsDiscountAmount: scale(discount.pointsDiscountAmount),
    codeDiscountAmount: scale(discount.codeDiscountAmount),
    codeLabel: discount.codeLabel,
    totalDiscount: scale(total),
  };
};

export type InvoiceRefundBasis = {
  amount: number;
  net: number;
  vat: number;
  reason?: string;
  description?: string;
  date?: Date | string;
  supplierScale: number;
};

export type NormalizedInvoiceBasis = {
  /** Full service net (milestone-aware), reduced by a partial refund. Unsigned. */
  serviceNet: number;
  serviceVat: number;
  serviceTotal: number;
  /** Full discount (recovered from the milestone slice when needed). */
  discount: any;
  /** Milestone booking: prefer the quote pricing lines over the last-milestone breakdown. */
  useQuotePricingLines: boolean;
  /** Present only for a partial refund (remaining total still positive). */
  refund?: InvoiceRefundBasis;
  /** Factor the supplier-side lines must be scaled by (1 without a refund). */
  supplierScale: number;
  /** A milestone gross was resolved (even if it nets to zero). */
  milestoneActive: boolean;
};

/**
 * Single source of truth for the invoice service basis, shared by the PDF and
 * UBL builders so the two cannot drift:
 * - milestone bookings use the full amount of all milestones + options (the
 *   stored payment fields only carry the last charged milestone);
 * - a partial refund reduces the service base by the refunded amount with the
 *   refund split proportionally across net/VAT.
 * Non-milestone, non-refunded bookings return the stored payment values
 * untouched.
 */
export const normalizeInvoiceBasis = (
  booking: any,
  commissionPercent: number,
): NormalizedInvoiceBasis => {
  const payment = booking?.payment || {};
  const reverseCharge = Boolean(payment.reverseCharge);
  const vatRate = reverseCharge ? 0 : Math.max(0, Number(payment.vatRate) || 0);
  const milestoneGross = getMilestoneFullCustomerGross(booking, commissionPercent);
  const storedDiscount = payment.discount;
  let serviceNet = Number(payment.netAmount) || 0;
  let serviceVat = Number(payment.vatAmount) || 0;
  let serviceTotal = Number(payment.totalWithVat) || 0;
  let discount = storedDiscount;
  let useQuotePricingLines = false;
  const milestoneActive = milestoneGross != null;
  if (milestoneActive && milestoneGross != null) {
    const scaled = scaleDiscountToFullGross(storedDiscount, storedDiscount?.originalAmount, milestoneGross);
    discount = scaled || storedDiscount;
    serviceNet = Math.max(0, roundMoney(milestoneGross - (Number(discount?.totalDiscount) || 0)));
    serviceVat = reverseCharge ? 0 : roundMoney((serviceNet * vatRate) / 100);
    serviceTotal = roundMoney(serviceNet + serviceVat);
    useQuotePricingLines = true;
  }
  let refund: InvoiceRefundBasis | undefined;
  let supplierScale = 1;
  const refundAmount = Number(payment.refundAmount) || 0;
  // Admit any positive refund up to the service total (plus float dust): the
  // split clamps to the total and money() rounds a sub-cent remainder to zero,
  // so no cent is ever silently dropped — the block is always shown.
  if (payment.status === "partially_refunded" && refundAmount > 0 && serviceTotal > 0
    && refundAmount - serviceTotal < 0.005) {
    const adjusted = computePostRefundInvoicePayment({
      netAmount: serviceNet,
      vatAmount: serviceVat,
      totalWithVat: serviceTotal,
      refundAmount,
      commissionPercent,
    });
    const reason = typeof payment.refundReason === "string" ? payment.refundReason : undefined;
    const description =
      typeof booking?.cancellation?.adminResolutionNote === "string"
        ? booking.cancellation.adminResolutionNote
        : undefined;
    refund = {
      amount: roundMoney(refundAmount),
      net: adjusted.refundNet,
      vat: adjusted.refundVat,
      reason,
      description,
      date: (payment.refundedAt as Date | string | undefined),
      supplierScale: adjusted.supplierScale,
    };
    serviceNet = adjusted.netAmount;
    serviceVat = adjusted.vatAmount;
    serviceTotal = adjusted.totalWithVat;
    supplierScale = adjusted.supplierScale;
  }
  return {
    serviceNet,
    serviceVat,
    serviceTotal,
    discount,
    useQuotePricingLines,
    refund,
    supplierScale,
    milestoneActive,
  };
};
