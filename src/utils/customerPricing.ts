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
 * cent from the whole-quote commissioned total; the drift is absorbed on the
 * last line so the line sum is exactly the recorded customer net.
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
  const sum = roundMoney(commissioned.reduce((total, line) => total + line.price, 0));
  const drift = roundMoney(customerNetAmount - sum);
  if (Math.abs(drift) >= 0.005) {
    const last = commissioned[commissioned.length - 1];
    commissioned[commissioned.length - 1] = {
      ...last,
      price: roundMoney(last.price + drift),
    };
  }
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
