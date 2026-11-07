import { invoiceSettledPayments, invoiceSettlementDiscount, invoiceRefundFacts } from "./invoiceSettlements";
import { computePostRefundInvoicePayment } from "./invoiceAccounting";

const roundMoney = (value: number): number =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

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
  /** Recorded professional payout before any refund; null on legacy non-milestone rows. */
  supplierServiceNet: number | null;
  /** Sum of the recorded per-payment discount components. */
  discount: any;
  /** Milestone booking: service lines come from the settled rows. */
  useQuotePricingLines: boolean;
  /** Present only for a partial refund (remaining total still positive). */
  refund?: InvoiceRefundBasis;
  /** Factor the supplier-side lines must be scaled by (1 without a refund). */
  supplierScale: number;
  /** This invoice uses recorded milestone settlements. */
  milestoneActive: boolean;
};

/**
 * Shared PDF/UBL basis from recorded settlements. Completed quotations include
 * all settled milestones; cancellations include only paid work. No price,
 * discount, commission or rounding is reconstructed from the last checkout.
 */
export const normalizeInvoiceBasis = (
  booking: any,
  _commissionPercent: number,
): NormalizedInvoiceBasis => {
  const payment = booking?.payment || {};
  const milestoneActive = Array.isArray(booking?.milestonePayments) && booking.milestonePayments.length > 0;
  const rows = milestoneActive ? invoiceSettledPayments(booking) : [];
  const storedDiscount = payment.discount;
  let serviceNet = Number(payment.netAmount) || 0;
  let serviceVat = Number(payment.vatAmount) || 0;
  let serviceTotal = Number(payment.totalWithVat) || 0;
  let discount = storedDiscount;
  let supplierServiceNet: number | null = payment.professionalPayout != null && Number.isFinite(Number(payment.professionalPayout))
    ? Number(payment.professionalPayout) : null;
  const useQuotePricingLines = milestoneActive;
  if (milestoneActive) {
    if (!rows.length) throw new Error("Cannot invoice milestones without recorded settled payments.");
    // Each checkout is rounded and discounted independently. Its settled rows
    // are the only authority for money, including cancelled quotations.
    if (rows.some(row => ![row.netAmount, row.vatAmount, row.totalWithVat].every(value =>
      value != null && Number.isFinite(Number(value))))) {
      throw new Error("Cannot invoice milestones without recorded settlement net, VAT and total.");
    }
    const paidMilestones = booking.milestonePayments.filter((milestone: any) => milestone.status === "paid").length;
    if (paidMilestones > rows.length) {
      throw new Error("Cannot invoice milestones: historical settled payment rows are missing.");
    }
    const sum = (key: string) => roundMoney(rows.reduce((total, row) => total + (Number(row[key]) || 0), 0));
    serviceNet = sum("netAmount");
    serviceVat = sum("vatAmount");
    serviceTotal = sum("totalWithVat");
    discount = invoiceSettlementDiscount(booking, rows);
    if (rows.every(row => row.professionalPayout != null && Number.isFinite(Number(row.professionalPayout)))) {
      supplierServiceNet = sum("professionalPayout");
    } else {
      supplierServiceNet = null;
    }
  }
  let refund: InvoiceRefundBasis | undefined;
  let supplierScale = 1;
  const refundFacts = invoiceRefundFacts(booking);
  const refundAmount = roundMoney(refundFacts.reduce((sum, fact) => sum + fact.amount, 0));
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
      commissionPercent: 0,
    });
    if (refundFacts.every(fact => fact.netAmount != null && fact.vatAmount != null)) {
      const refundNet = roundMoney(refundFacts.reduce((sum, fact) => sum + Number(fact.netAmount), 0));
      const refundVat = roundMoney(refundFacts.reduce((sum, fact) => sum + Number(fact.vatAmount), 0));
      if (Math.abs(refundNet + refundVat - refundAmount) >= 0.005 || refundNet > serviceNet || refundVat > serviceVat) {
        throw new Error("Recorded refund net/VAT does not reconcile with the settled payment.");
      }
      adjusted.refundNet = refundNet;
      adjusted.refundVat = refundVat;
      adjusted.netAmount = roundMoney(serviceNet - refundNet);
      adjusted.vatAmount = roundMoney(serviceVat - refundVat);
    }
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
    supplierServiceNet,
    discount,
    useQuotePricingLines,
    refund,
    supplierScale,
    milestoneActive,
  };
};
