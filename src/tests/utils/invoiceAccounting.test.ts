import { describe, expect, it } from "vitest";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  getCustomerExtraCostNet,
  scaledSupplierRepeatBuyerDiscount,
  supplierRepeatBuyerDiscount,
} from "../../utils/invoiceAccounting";
import { calculateDiscountedPayouts } from "../../utils/discountAccounting";

describe("invoice accounting", () => {
  it("keeps supplier pricing separate from the customer commission", () => {
    expect(calculateSupplierInvoiceNet({
      quoteAmount: 500,
      selectedExtraOptions: [{ bookedPrice: 50 }],
      repeatBuyerDiscount: 10,
      extraCostTotal: 25,
    })).toBe(565);
  });

  it("uses the checkout snapshot instead of adding options twice", () => {
    expect(calculateSupplierInvoiceNet({
      quoteAmount: 550,
      checkoutSnapshot: { baseSubtotal: 500, extraOptionsTotal: 50 },
      selectedExtraOptions: [{ bookedPrice: 50 }],
    })).toBe(550);
  });

  it("calculates a zero-VAT reverse-charge side", () => {
    expect(calculateInvoiceSideTotals({
      lines: [{ description: "Immovable service", amount: 500, vatRate: 21 }],
      reverseCharge: true,
      vatRate: 21,
      vatLabel: "Reverse Charge",
    })).toMatchObject({
      netAmount: 500,
      vatAmount: 0,
      totalWithVat: 500,
      vatRate: 0,
      reverseCharge: true,
      vatLabel: "Reverse Charge",
    });
  });

  describe("getCustomerExtraCostNet", () => {
    it("prefers the persisted customer net amount", () => {
      expect(getCustomerExtraCostNet({
        extraCostCustomerNetAmount: 42.456,
        extraCostAmount: 60,
        extraCostVatAmount: 10,
        reverseCharge: false,
      }, 999)).toBe(42.46);
    });

    it("deducts VAT from the gross extra cost unless reverse charged", () => {
      expect(getCustomerExtraCostNet({ extraCostAmount: 121, extraCostVatAmount: 21 }, 999)).toBe(100);
      expect(getCustomerExtraCostNet({ extraCostAmount: 121, extraCostVatAmount: 21, reverseCharge: true }, 999)).toBe(121);
    });

    it("falls back to the raw extra-cost sum when no payment metadata exists", () => {
      expect(getCustomerExtraCostNet({}, 37.5)).toBe(37.5);
      expect(getCustomerExtraCostNet(undefined as any, 12)).toBe(12);
    });
  });
});

describe("supplier repeat-buyer discount (FT3 #25a)", () => {
  it.each([[13.75, 10], [110, 10], [33.33, 17.5], [5, 0]])(
    "matches the payout reduction for a %s customer discount at %s%% commission",
    (discount, commission) => {
      const base = { originalAmount: 1100, finalAmount: 1100 - discount, loyaltyDiscount: {}, pointsDiscount: {} };
      const full = calculateDiscountedPayouts({ ...base, repeatBuyerDiscount: { amount: 0 } }, commission, 1000);
      const withRepeat = calculateDiscountedPayouts({ ...base, repeatBuyerDiscount: { amount: discount } }, commission, 1000);
      const share = supplierRepeatBuyerDiscount(discount, commission);
      expect(Math.round((full.professionalPayout - withRepeat.professionalPayout) * 100) / 100).toBe(share);
      // Full-price line minus the shown discount is the discounted (paid out) net.
      expect(calculateSupplierInvoiceNet({ quoteAmount: 1000, repeatBuyerDiscount: share })).toBe(withRepeat.professionalPayout);
    },
  );

  it("splits a refund-scaled line so full price minus discount is the old rounded line", () => {
    for (const scale of [1, 216.11 / 316.11, 0.333333, 0.5]) {
      const discounted = 237.5;
      const shown = scaledSupplierRepeatBuyerDiscount(discounted, 12.5, scale);
      const full = Math.round((discounted + 12.5) * scale * 100) / 100;
      expect(Math.round((full - shown) * 100)).toBe(Math.round(discounted * scale * 100));
    }
    expect(scaledSupplierRepeatBuyerDiscount(237.5, 0, 1)).toBe(0);
    expect(supplierRepeatBuyerDiscount(undefined, 10)).toBe(0);
  });
});
