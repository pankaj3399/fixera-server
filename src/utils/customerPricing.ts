import { getExtraCostQuantity, roundLineAmount } from "./invoiceLineQuantity";
import type { VatPricingLineInput } from "./vatLineCalculation";

/**
 * What the customer pays for a professional's price: the price plus the
 * platform commission. Unit-priced work is charged as quantity x the
 * customer's unit price in whole cents, the way the unit price is shown at
 * checkout, so the invoice line multiplies back exactly (30 x 16.43 = 492.90)
 * instead of rounding only the total (492.82, i.e. 16.427333 per unit).
 * The professional's amount never changes; the cents are platform fee.
 */

// The same rounding as the invoice lines (half away from zero), so the price
// charged here is the one Odoo and the UBL multiply back exactly.
const roundMoney = (value: number): number => {
  const rounded = roundLineAmount(value);
  return rounded === 0 ? 0 : rounded;
};

const toFinite = (value: unknown): number | undefined => {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const commissionMultiplier = (commissionPercent: number): number =>
  1 + Math.max(0, Number(commissionPercent) || 0) / 100;

export const withCommission = (amount: number, commissionPercent: number): number =>
  roundMoney(amount * commissionMultiplier(commissionPercent));

/**
 * Commission-inclusive copy of professional pricing lines for VAT.
 * VAT is charged on the price AFTER commission is included, so every line's
 * VAT base is the customer-facing amount. Per-line rounding can drift by a
 * cent from the whole-quote commissioned total; the drift is distributed across
 * lines so the line sum is exactly the recorded customer net.
 */
export const commissionedPricingLines = (
  lines: VatPricingLineInput[],
  customerNetAmount: number,
  commissionPercent: number,
): VatPricingLineInput[] => {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const commissioned = lines.map((line) => ({
    ...line,
    price: withCommission(Number(line.price) || 0, commissionPercent),
  }));
  // Allocate in whole cents, proportionally, so reductions can span all
  // lines without a negative tail. Largest remainders absorb rounding cents.
  const target = Math.max(0, Math.round(customerNetAmount * 100));
  const weights = commissioned.map(line => Math.max(0, Math.round(line.price * 100)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const allocations = weights.map((weight, index) => {
    const exact = total > 0 ? target * weight / total : target / weights.length;
    return { index, cents: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = target - allocations.reduce((sum, line) => sum + line.cents, 0);
  for (const line of [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining-- <= 0) break;
    line.cents++;
  }
  allocations.forEach(({ index, cents }) => { commissioned[index].price = cents / 100; });
  return commissioned;
};

export const customerUnitPrice = (unitPrice: number, commissionPercent: number): number =>
  withCommission(unitPrice, commissionPercent);

export const withCommissionPerUnit = (unitPrice: number, quantity: number, commissionPercent: number): number =>
  roundLineAmount(customerUnitPrice(unitPrice, commissionPercent) * quantity);

type UnitPricedSnapshot = {
  pricingType?: string;
  unitAmount?: number;
  quantity?: number;
};

/** Unit price and quantity of a checkout package, when the booking has one. */
export const getCheckoutUnitPricing = (
  snapshot?: UnitPricedSnapshot | null,
): { unitPrice: number; quantity: number } | undefined => {
  if (snapshot?.pricingType !== "unit") return undefined;
  const unitPrice = toFinite(snapshot.unitAmount);
  const quantity = toFinite(snapshot.quantity);
  if (unitPrice == null || unitPrice < 0 || quantity == null || quantity <= 0) return undefined;
  return { unitPrice, quantity };
};

/**
 * Commission-inclusive quote amount. The unit-priced package inside it (from
 * the checkout snapshot) is charged per unit; anything else in the quote, such
 * as options a legacy checkout folded into it, gets the commission as a whole.
 */
export const commissionedQuoteAmount = (
  quoteAmount: number,
  snapshot: UnitPricedSnapshot | null | undefined,
  commissionPercent: number,
): number => {
  const unitPricing = getCheckoutUnitPricing(snapshot);
  if (unitPricing) {
    const base = roundMoney(unitPricing.unitPrice * unitPricing.quantity);
    const rest = roundMoney(quoteAmount - base);
    if (rest >= 0) {
      return roundMoney(
        withCommissionPerUnit(unitPricing.unitPrice, unitPricing.quantity, commissionPercent)
          + (rest > 0 ? withCommission(rest, commissionPercent) : 0),
      );
    }
  }
  return withCommission(quoteAmount, commissionPercent);
};

type ExtraCostLike = {
  type?: string;
  amount?: unknown;
  unitPrice?: unknown;
  actualUnits?: unknown;
  estimatedUnits?: unknown;
};

/** Customer amount of one extra cost, before any customer discount. */
export const commissionedExtraCostAmount = (cost: ExtraCostLike, commissionPercent: number): number => {
  const amount = toFinite(cost.amount) ?? 0;
  const quantity = getExtraCostQuantity(cost);
  const unitPrice = toFinite(cost.unitPrice);
  if (quantity != null && unitPrice != null && Math.abs(roundMoney(quantity * unitPrice) - amount) < 0.005) {
    return withCommissionPerUnit(unitPrice, quantity, commissionPercent);
  }
  return withCommission(amount, commissionPercent);
};

/**
 * Customer amount of a booking's extra costs, before any customer discount.
 * When the total was settled separately (e.g. a dispute set it without
 * lines), the lines no longer describe it and it gets the commission whole.
 */
export const commissionedExtraCostTotal = (
  extraCosts: ExtraCostLike[] | undefined,
  extraCostTotal: number,
  commissionPercent: number,
): number => {
  const costs = Array.isArray(extraCosts) ? extraCosts : [];
  const linesTotal = roundMoney(costs.reduce((sum, cost) => sum + (toFinite(cost.amount) ?? 0), 0));
  if (costs.length === 0 || Math.abs(linesTotal - roundMoney(extraCostTotal)) >= 0.005) {
    return withCommission(extraCostTotal, commissionPercent);
  }
  return roundMoney(costs.reduce((sum, cost) => sum + commissionedExtraCostAmount(cost, commissionPercent), 0));
};

/**
 * Customer charge for the selected extra options of a checkout booking. Checkout
 * (handlers/Stripe/payment.ts) and the public price preview both use this, so the
 * displayed total is the charged total.
 */
export const optionsCustomerCharge = (optionsTotal: number, commissionPercent: number): number =>
  +(optionsTotal * (1 + commissionPercent / 100)).toFixed(2);

/**
 * Customer total of a checkout package: the package charge plus its selected
 * options, as checkout computes it when the options are not already in the quote.
 */
export const checkoutCustomerTotal = (
  snapshot: UnitPricedSnapshot & { baseSubtotal?: number; extraOptionsTotal?: number },
  commissionPercent: number,
): number => {
  const base = commissionedQuoteAmount(Number(snapshot.baseSubtotal) || 0, snapshot, commissionPercent);
  const options = Number(snapshot.extraOptionsTotal) || 0;
  return options > 0 ? base + optionsCustomerCharge(options, commissionPercent) : base;
};

/** The extra-cost charge facts recorded on booking.payment and the Payment row. */
export type ExtraCostChargeRecord = {
  extraCostCommissionPercent?: unknown;
  extraCostNetAmount?: unknown;
  extraCostPlatformCommission?: unknown;
  extraCostCustomerDiscount?: unknown;
};

/**
 * Commission-inclusive extra-cost subtotal, before the customer discount, that
 * a recorded charge was built from: the supplier amount plus the platform
 * commission it kept plus the discount that commission funded (see
 * calculateExtraCostBreakdown). Undefined when the charge was not recorded.
 */
export const recordedExtraCostCustomerSubtotal = (record?: ExtraCostChargeRecord | null): number | undefined => {
  const net = toFinite(record?.extraCostNetAmount);
  const commission = toFinite(record?.extraCostPlatformCommission);
  if (net == null || net <= 0 || commission == null || commission < 0) return undefined;
  const discount = Math.max(0, toFinite(record?.extraCostCustomerDiscount) ?? 0);
  return roundMoney(net + commission + discount);
};

/**
 * Commission percent that applied to a booking's extra-cost charge. Charges
 * record it (`extraCostCommissionPercent`); for older charges it is recovered
 * from the recorded amounts only when that percent reproduces the recorded
 * subtotal exactly, otherwise the live percent is the best remaining answer.
 */
export const resolveExtraCostChargeCommissionPercent = (
  record: ExtraCostChargeRecord | null | undefined,
  extraCosts: ExtraCostLike[] | undefined,
  liveCommissionPercent: number,
): { commissionPercent: number; source: "recorded" | "derived" | "live" } => {
  const recorded = toFinite(record?.extraCostCommissionPercent);
  if (recorded != null && recorded >= 0) return { commissionPercent: recorded, source: "recorded" };
  const net = toFinite(record?.extraCostNetAmount);
  const subtotal = recordedExtraCostCustomerSubtotal(record);
  if (net != null && net > 0 && subtotal != null) {
    const estimate = ((subtotal - net) / net) * 100;
    const candidates = [
      Math.round(estimate),
      Math.round(estimate * 10) / 10,
      Math.round(estimate * 100) / 100,
      liveCommissionPercent,
    ];
    const match = candidates.find((percent) => Number.isFinite(percent) && percent >= 0
      && Math.abs(commissionedExtraCostTotal(extraCosts, net, percent) - subtotal) < 0.005);
    if (match != null) return { commissionPercent: match, source: "derived" };
  }
  return { commissionPercent: Math.max(0, Number(liveCommissionPercent) || 0), source: "live" };
};

/**
 * Customer amount of every extra-cost line, before any customer discount.
 * With a `customerTotal` the lines sum to it exactly: any rounding difference
 * is carried by the last line.
 */
export const commissionedExtraCostLines = (
  extraCosts: ExtraCostLike[] | undefined,
  commissionPercent: number,
  customerTotal?: number,
): number[] => {
  const amounts = (Array.isArray(extraCosts) ? extraCosts : [])
    .map((cost) => commissionedExtraCostAmount(cost, commissionPercent));
  if (customerTotal == null || !Number.isFinite(customerTotal) || amounts.length === 0) return amounts;
  const drift = roundMoney(customerTotal - roundMoney(amounts.reduce((sum, amount) => sum + amount, 0)));
  if (drift !== 0) amounts[amounts.length - 1] = roundMoney(amounts[amounts.length - 1] + drift);
  return amounts;
};
