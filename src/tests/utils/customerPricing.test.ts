import { describe, expect, it } from "vitest";
import {
  commissionedExtraCostTotal,
  commissionedQuoteAmount,
  withCommission,
} from "../../utils/customerPricing";
import { computeGrossBookingAmount } from "../../utils/payment";
import { calculateDiscountedPayouts } from "../../utils/discountAccounting";
import { calculateExtraCostBreakdown } from "../../utils/extraCostAccounting";

// 15/m² becomes 16.427325/m² with this commission: 16.43 once rounded.
const commission = 9.5155;
const unitSnapshot = { pricingType: "unit", unitAmount: 15, quantity: 30, baseSubtotal: 450, totalAmount: 450 };

describe("per-unit customer pricing", () => {
  it("charges quantity x the whole-cent unit price instead of rounding only the total", () => {
    expect(withCommission(450, commission)).toBe(492.82);
    expect(commissionedQuoteAmount(450, unitSnapshot, commission)).toBe(492.9);
    expect(computeGrossBookingAmount({ quote: { amount: 450 }, checkoutSnapshot: unitSnapshot }, commission)).toBe(492.9);
  });

  it("keeps fixed prices and quotes without a unit package as before", () => {
    expect(commissionedQuoteAmount(450, { pricingType: "fixed", unitAmount: 450, quantity: 1 }, commission)).toBe(492.82);
    expect(commissionedQuoteAmount(450, undefined, commission)).toBe(492.82);
  });

  it("rounds half-cent ties away from zero, like the invoice lines", () => {
    expect(withCommission(10.075, 0)).toBe(10.08);
    expect(withCommission(-10.075, 0)).toBe(-10.08);
    expect(Object.is(withCommission(-0.001, 0), 0)).toBe(true);
  });

  it("adds options folded into the quote at their own commissioned price", () => {
    expect(commissionedQuoteAmount(500, unitSnapshot, commission)).toBe(492.9 + withCommission(50, commission));
  });

  it("prices unit extra costs per unit, other extra costs as a whole", () => {
    const extraCosts = [
      { type: "unit_adjustment", estimatedUnits: 30, actualUnits: 35, unitPrice: 15, amount: 75 },
      { type: "condition", amount: 50 },
    ];
    expect(commissionedExtraCostTotal(extraCosts, 125, commission)).toBe(82.15 + 54.76);
    // Fewer units than estimated: refunded per unit as well.
    expect(commissionedExtraCostTotal(
      [{ type: "unit_adjustment", estimatedUnits: 30, actualUnits: 27.5, unitPrice: 15, amount: -37.5 }], -37.5, commission,
    )).toBe(-41.08);
  });

  it("falls back to the whole total when it no longer matches the lines (dispute)", () => {
    const extraCosts = [{ type: "unit_adjustment", estimatedUnits: 30, actualUnits: 35, unitPrice: 15, amount: 75 }];
    expect(commissionedExtraCostTotal(extraCosts, 40, commission)).toBe(withCommission(40, commission));
  });
});

describe("payouts under per-unit pricing", () => {
  const breakdown = (originalAmount: number, loyalty = 0) => ({
    originalAmount,
    finalAmount: originalAmount - loyalty,
    loyaltyDiscount: { amount: loyalty },
    repeatBuyerDiscount: { amount: 0 },
    pointsDiscount: { discountAmount: 0 },
  });

  it("pays the professional their own price; the rounding cents are platform fee", () => {
    expect(calculateDiscountedPayouts(breakdown(492.9), commission, 450)).toMatchObject({
      professionalPayout: 450,
      platformCommission: 42.9,
    });
    // Derived from the total, the payout would have drifted to 450.07.
    expect(calculateDiscountedPayouts(breakdown(492.9), commission).professionalPayout).toBe(450.07);
  });

  it("still lets the platform absorb customer discounts", () => {
    expect(calculateDiscountedPayouts(breakdown(492.9, 24.65), commission, 450)).toMatchObject({
      professionalPayout: 450,
      platformCommission: 18.25,
    });
  });

  it("splits a per-unit extra-cost charge the same way", () => {
    expect(calculateExtraCostBreakdown({
      extraCostNetAmount: 75,
      commissionPercent: commission,
      customerSubtotal: 82.15,
    })).toMatchObject({ customerChargeAmount: 82.15, platformCommissionAmount: 7.15, professionalPayout: 75 });
  });
});


describe('commissioned line drift', () => {
  it('spreads negative drift without making a small final line negative', async () => {
    const { commissionedPricingLines } = await import('../../utils/customerPricing');
    const lines = commissionedPricingLines([{ description: 'A', price: 80, vatRate: 21 },
      { description: 'B', price: 20, vatRate: 6 }, { description: 'C', price: 1, vatRate: 21 }], 10, 0);
    expect(lines.every(line => line.price >= 0)).toBe(true);
    expect(lines.reduce((sum, line) => sum + line.price, 0)).toBeCloseTo(10, 8);
    expect(commissionedPricingLines([{ description: 'A', price: 1, vatRate: 0 },
      { description: 'B', price: 1, vatRate: 0 }], 3, 0).map(line => line.price)).toEqual([1.5, 1.5]);
  });
});
