import { describe, expect, it } from "vitest";
import { normalizeInvoiceBasis } from "../../utils/milestoneInvoice";

const milestoneBooking = (overrides: any = {}) => ({
  milestonePayments: [
    { title: "Deposit", amount: 100, order: 0, status: "paid", dueCondition: "on_start" },
    { title: "Balance", amount: 200, order: 1, status: "pending", dueCondition: "on_start" },
  ],
  selectedExtraOptions: [{ extraOptionId: "opt1", bookedPrice: 50 }],
  __settledPayments: [
    { milestoneIndex: 0, status: "completed", stripePaymentIntentId: "pi_first", netAmount: 165, vatAmount: 34.65, totalWithVat: 199.65 },
    { milestoneIndex: 1, status: "completed", stripePaymentIntentId: "pi_second", netAmount: 220, vatAmount: 46.2, totalWithVat: 266.2 },
  ],
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
