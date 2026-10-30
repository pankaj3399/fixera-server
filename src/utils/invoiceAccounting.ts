/**
 * Shared invoice-side arithmetic.
 *
 * Customer invoices and supplier self-bills are different commercial
 * documents. Keeping their totals in one pure module makes it impossible for
 * the PDF and UBL builders to silently reuse the other side's VAT or amount.
 */

export type InvoiceAccountingLine = {
  description: string;
  amount: number;
  vatRate: number;
  vatLabel?: string;
  quantity?: number;
  unitPrice?: number;
  unit?: string;
};

export type InvoiceSideTotals = {
  netAmount: number;
  vatAmount: number;
  totalWithVat: number;
  vatRate: number;
  reverseCharge: boolean;
  vatLabel?: string;
};

export type SupplierInvoiceBasisInput = {
  quoteAmount?: number;
  checkoutSnapshot?: {
    baseSubtotal?: number;
    extraOptionsTotal?: number;
  };
  selectedExtraOptions?: Array<{ bookedPrice?: number } | number>;
  repeatBuyerDiscount?: number;
  extraCostTotal?: number;
  /**
   * The quoted amount already contains the selected extra options (legacy
   * checkout folded them into quote.amount). Without a checkout snapshot the
   * options must not be added a second time.
   */
  quoteIncludesSelectedOptions?: boolean;
};

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Single source of truth for the customer-facing extra-cost net amount, shared
 * by the PDF and UBL builders so the two cannot drift:
 * 1. prefer the persisted customer net amount,
 * 2. else gross extra cost minus its VAT (VAT is zero under reverse charge),
 * 3. else the raw sum of the booking's extra costs.
 */
export const getCustomerExtraCostNet = (
  payment: {
    extraCostCustomerNetAmount?: unknown;
    extraCostAmount?: unknown;
    extraCostVatAmount?: unknown;
    reverseCharge?: boolean;
  },
  fallback: number,
): number => {
  if (payment?.extraCostCustomerNetAmount != null) {
    const net = Number(payment.extraCostCustomerNetAmount);
    if (Number.isFinite(net)) return money(net);
  }
  if (payment?.extraCostAmount != null) {
    const gross = Number(payment.extraCostAmount);
    if (Number.isFinite(gross)) {
      const vat = payment.reverseCharge ? 0 : Number(payment.extraCostVatAmount) || 0;
      return money(Math.max(0, gross - vat));
    }
  }
  return fallback;
};

const sumOptions = (options?: SupplierInvoiceBasisInput["selectedExtraOptions"]): number =>
  (options || []).reduce<number>((sum, option) => {
    if (typeof option === "number") return sum + option;
    return sum + (Number(option?.bookedPrice) || 0);
  }, 0);

/**
 * The supplier's invoice amount is the professional price, not the
 * customer-facing price with the platform commission. A repeat-buyer discount
 * is deducted because that discount is explicitly assigned to the supplier by
 * the existing discount policy; platform-funded discounts are not deducted.
 */
export const calculateSupplierInvoiceNet = (input: SupplierInvoiceBasisInput): number => {
  const snapshotBase = Number(input.checkoutSnapshot?.baseSubtotal);
  const snapshotExtras = Number(input.checkoutSnapshot?.extraOptionsTotal);
  const hasSnapshot = Number.isFinite(snapshotBase) && Number.isFinite(snapshotExtras);
  const selectedOptions = sumOptions(input.selectedExtraOptions);
  const quotedAmount = Number(input.quoteAmount) || 0;
  const serviceNet = hasSnapshot
    ? snapshotBase + snapshotExtras
    : quotedAmount + (input.quoteIncludesSelectedOptions ? 0 : selectedOptions);
  const repeatBuyerDiscount = Math.max(0, Number(input.repeatBuyerDiscount) || 0);
  const extraCosts = Math.max(0, Number(input.extraCostTotal) || 0);
  return money(Math.max(0, serviceNet - repeatBuyerDiscount + extraCosts));
};

/**
 * Scale factor that maps persisted extra-cost lines to the resolved extra-cost
 * total. After an admin dispute resolution the booking's `extraCostTotal` is
 * authoritative (reduced or zeroed) while `extraCosts[]` still carries the
 * originally requested amounts; both invoice sides must render the resolved
 * amount instead of the stale lines.
 */
export const resolveExtraCostScale = (
  extraCosts: Array<{ amount?: unknown }> | undefined,
  extraCostTotal: unknown,
): number => {
  const rawTotal = (extraCosts || []).reduce(
    (sum, cost) => sum + (Number(cost?.amount) || 0),
    0,
  );
  const resolved = Number(extraCostTotal);
  if (!Number.isFinite(resolved)) return 1;
  if (rawTotal === 0) return resolved > 0 ? 1 : 0;
  return resolved / rawTotal;
};

export type PostRefundInvoicePayment = {
  netAmount: number;
  vatAmount: number;
  totalWithVat: number;
  platformCommission: number;
  professionalPayout: number;
  /** Share of the refund taken from the net amount (proportional split). */
  refundNet: number;
  /** Share of the refund taken from the VAT amount (proportional split). */
  refundVat: number;
  /** Factor the supplier-side service lines must be scaled by. */
  supplierScale: number;
};

/**
 * Post-refund invoice basis for a partially refunded booking. The refund is
 * split proportionally across net/VAT (mirroring how it was charged) and the
 * platform commission is recalculated on the remaining net amount. Pure: the
 * caller decides whether to persist the result or keep it in memory.
 */
export const computePostRefundInvoicePayment = (input: {
  netAmount: number;
  vatAmount: number;
  totalWithVat: number;
  platformCommission?: number;
  professionalPayout?: number;
  refundAmount: number;
  commissionPercent: number;
}): PostRefundInvoicePayment => {
  const total = Math.max(0, Number(input.totalWithVat) || 0);
  const refund = Math.min(Math.max(0, Number(input.refundAmount) || 0), total);
  const net = Math.max(0, Number(input.netAmount) || 0);
  const vat = Math.max(0, Number(input.vatAmount) || 0);
  const netPlusVat = net + vat;
  const refundNet = netPlusVat > 0 ? money((refund * net) / netPlusVat) : 0;
  const refundVat = money(refund - refundNet);
  const remainingNet = money(net - refundNet);
  const remainingTotal = money(total - refund);
  const commissionPercent = Math.max(0, Number(input.commissionPercent) || 0);
  const platformCommission = money((remainingNet * commissionPercent) / 100);
  const professionalPayout = money(Math.max(0, remainingNet - platformCommission));
  return {
    netAmount: remainingNet,
    vatAmount: money(vat - refundVat),
    totalWithVat: remainingTotal,
    platformCommission,
    professionalPayout,
    refundNet,
    refundVat,
    supplierScale: total > 0 ? remainingTotal / total : 1,
  };
};

/**
 * VAT rate (2 decimals) that reproduces a fixed VAT amount from a fixed net
 * amount under the UBL/PDF per-line rule `round(net × rate)`. A partial
 * refund's gross is exact but rarely factorable at the nominal rate (e.g.
 * €21.00 at 21% has no exact cent split), so the credit carries the effective
 * rate of its own amounts and both documents reconcile to the cent. A small
 * search around the nominal ratio absorbs remainder rounding; the fallback is
 * the nominal ratio itself.
 */
export const effectiveVatRateForCredit = (
  netAmount: unknown,
  vatAmount: unknown,
  fallbackRate: unknown = 0,
): number => {
  const net = Number(netAmount) || 0;
  const vat = Number(vatAmount) || 0;
  if (!(net > 0) || !(vat > 0)) return 0;
  const raw = (vat / net) * 100;
  for (const delta of [0, 0.01, -0.01, 0.02, -0.02, 0.03, -0.03, 0.04, -0.04, 0.05, -0.05, 0.1, -0.1]) {
    const candidate = money(raw + delta);
    if (candidate < 0 || candidate > 100) continue;
    if (money((net * candidate) / 100) === money(vat)) return candidate;
  }
  return money(raw || Number(fallbackRate) || 0);
};

/**
 * Calculates totals from the actual lines that will be rendered in both PDF
 * and UBL. Reverse charge is represented by a zero VAT amount and label, not
 * by a synthetic percentage.
 */
export const calculateInvoiceSideTotals = (input: {
  lines: InvoiceAccountingLine[];
  reverseCharge?: boolean;
  vatRate?: number;
  vatLabel?: string;
}): InvoiceSideTotals => {
  const reverseCharge = Boolean(input.reverseCharge);
  const netAmount = money(input.lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0));
  const effectiveRate = reverseCharge ? 0 : Math.max(0, Number(input.vatRate) || 0);
  const vatAmount = reverseCharge
    ? 0
    : money(input.lines.reduce((sum, line) => {
        const lineRate = Number.isFinite(Number(line.vatRate)) ? Number(line.vatRate) : effectiveRate;
        return sum + ((Number(line.amount) || 0) * lineRate) / 100;
      }, 0));

  return {
    netAmount,
    vatAmount,
    totalWithVat: money(netAmount + vatAmount),
    vatRate: effectiveRate,
    reverseCharge,
    vatLabel: input.vatLabel,
  };
};
