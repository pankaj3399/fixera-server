import { describe, expect, it } from "vitest";
import {
  getMilestoneFullCustomerGross,
  normalizeInvoiceBasis,
  scaleDiscountToFullGross,
} from "../../utils/milestoneInvoice";

const milestoneBooking = (overrides: any = {}) => ({
  milestonePayments: [
    { title: "Deposit", amount: 100, order: 0, status: "paid", dueCondition: "on_start" },
    { title: "Balance", amount: 200, order: 1, status: "pending", dueCondition: "on_start" },
  ],
  selectedExtraOptions: [{ extraOptionId: "opt1", bookedPrice: 50 }],
  quote: { amount: 300 },
  payment: {
    netAmount: 220,
    vatAmount: 46.2,
    vatRate: 21,
    totalWithVat: 266.2,
    currency: "EUR",
    reverseCharge: false,
    discount: { loyaltyAmount: 0, totalDiscount: 0, originalAmount: 220 },
  },
  ...overrides,
});

describe("getMilestoneFullCustomerGross", () => {
  it("returns null without milestones", () => {
    expect(getMilestoneFullCustomerGross({}, 10)).toBeNull();
    expect(getMilestoneFullCustomerGross({ milestonePayments: [] }, 10)).toBeNull();
  });

  it("sums all milestones plus options with commission", () => {
    // (100 + 200 + 50) * 1.1 = 385
    expect(getMilestoneFullCustomerGross(milestoneBooking(), 10)).toBeCloseTo(385, 2);
  });

  it("excludes options already folded into the quote", () => {
    const booking = milestoneBooking({
      quote: { amount: 350, breakdown: [{ item: "checkout_snapshot:computed_total", totalPrice: 350 }] },
      checkoutSnapshot: { extraOptionsTotal: 50, totalAmount: 350 },
    });
    // (100 + 200) * 1.1 = 330
    expect(getMilestoneFullCustomerGross(booking, 10)).toBeCloseTo(330, 2);
  });
});

describe("scaleDiscountToFullGross", () => {
  it("returns undefined without a discount", () => {
    expect(scaleDiscountToFullGross(undefined, 220, 385)).toBeUndefined();
    expect(scaleDiscountToFullGross({ totalDiscount: 0 }, 220, 385)).toBeUndefined();
  });

  it("scales the slice back up to the full gross", () => {
    const scaled = scaleDiscountToFullGross(
      { loyaltyAmount: 5, repeatBuyerAmount: 2, totalDiscount: 7, originalAmount: 220 },
      220,
      440,
    );
    expect(scaled?.loyaltyAmount).toBeCloseTo(10, 2);
    expect(scaled?.repeatBuyerAmount).toBeCloseTo(4, 2);
    expect(scaled?.totalDiscount).toBeCloseTo(14, 2);
  });
});

describe("normalizeInvoiceBasis", () => {
  it("passes stored values through for plain bookings", () => {
    const basis = normalizeInvoiceBasis(
      { payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, status: "completed" } },
      10,
    );
    expect(basis.serviceNet).toBe(100);
    expect(basis.serviceTotal).toBe(121);
    expect(basis.milestoneActive).toBe(false);
    expect(basis.refund).toBeUndefined();
    expect(basis.supplierScale).toBe(1);
  });

  it("uses the full milestone scope instead of the last slice", () => {
    const basis = normalizeInvoiceBasis(milestoneBooking(), 10);
    expect(basis.milestoneActive).toBe(true);
    expect(basis.serviceNet).toBeCloseTo(385, 2);
    expect(basis.serviceVat).toBeCloseTo(80.85, 2);
    expect(basis.useQuotePricingLines).toBe(true);
  });

  it("reduces the base for a partial refund and records refund metadata", () => {
    const basis = normalizeInvoiceBasis(
      {
        payment: {
          netAmount: 100,
          vatAmount: 21,
          vatRate: 21,
          totalWithVat: 121,
          status: "partially_refunded",
          refundAmount: 21,
          refundReason: "Professional no-show",
          refundedAt: new Date("2026-10-29T00:00:00Z"),
        },
        cancellation: { adminResolutionNote: "Admin approved partial" },
      },
      10,
    );
    expect(basis.refund?.amount).toBe(21);
    expect(basis.refund?.reason).toBe("Professional no-show");
    expect(basis.refund?.description).toBe("Admin approved partial");
    expect(basis.serviceTotal).toBeCloseTo(100, 2);
    expect(basis.supplierScale).toBeCloseTo(100 / 121, 4);
  });

  it("still shows the refund block for sub-cent dust and floors the remainder", () => {
    const basis = normalizeInvoiceBasis(
      {
        payment: {
          netAmount: 100,
          vatAmount: 21,
          vatRate: 21,
          totalWithVat: 121,
          status: "partially_refunded",
          refundAmount: 120.996,
          refundReason: "Dust",
          refundedAt: new Date("2026-10-29T00:00:00Z"),
        },
      },
      10,
    );
    expect(basis.refund?.amount).toBeCloseTo(121, 2);
    expect(basis.serviceTotal).toBe(0);
    expect(basis.serviceNet).toBe(0);
    expect(basis.serviceVat).toBe(0);
  });
});
