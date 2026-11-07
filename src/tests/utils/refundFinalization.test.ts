import { describe, expect, it } from "vitest";
import {
  computePostRefundInvoicePayment,
  resolveExtraCostScale,
} from "../../utils/invoiceAccounting";
import {
  isBookingStarted,
  leavesBillableRemainder,
  pruneFutureResourcePlanDays,
} from "../../utils/refundFinalization";

describe("pruneFutureResourcePlanDays", () => {
  const day = (iso: string) => new Date(iso);
  it("keeps past days and drops today/future days", () => {
    const booking = {
      resourcePlan: [
        { resourceId: "r1", days: [day("2026-10-20T00:00:00Z"), day("2026-10-29T00:00:00Z"), day("2026-10-30T00:00:00Z"), day("2026-11-02T00:00:00Z")] },
        { resourceId: "r2", days: [day("2026-10-28T00:00:00Z")] },
      ],
    };
    const result = pruneFutureResourcePlanDays(booking, day("2026-10-30T12:00:00Z"));
    expect(result).toEqual({ keptDays: 3, removedDays: 2 });
    expect(booking.resourcePlan[0].days.map((d: Date) => d.toISOString())).toEqual([
      "2026-10-20T00:00:00.000Z",
      "2026-10-29T00:00:00.000Z",
    ]);
    expect(booking.resourcePlan[1].days.map((d: Date) => d.toISOString())).toEqual([
      "2026-10-28T00:00:00.000Z",
    ]);
  });

  it("is a no-op without a plan", () => {
    expect(pruneFutureResourcePlanDays({}, new Date())).toEqual({ keptDays: 0, removedDays: 0 });
  });
});

describe("isBookingStarted", () => {
  it("treats actual start or active statuses as started", () => {
    expect(isBookingStarted({ status: "booked" })).toBe(false);
    expect(isBookingStarted({ status: "in_progress" })).toBe(true);
    expect(isBookingStarted({ status: "booked", actualStartDate: new Date() })).toBe(true);
    expect(isBookingStarted(null)).toBe(false);
  });
});

describe("leavesBillableRemainder", () => {
  it("detects partial vs full refunds", () => {
    expect(leavesBillableRemainder(121, 21)).toBe(true);
    expect(leavesBillableRemainder(121, 121)).toBe(false);
    expect(leavesBillableRemainder(121, 200)).toBe(false);
    expect(leavesBillableRemainder(121, 0)).toBe(false);
  });
});

describe("computePostRefundInvoicePayment", () => {
  it("splits the refund proportionally and recalculates commission on the remainder", () => {
    const result = computePostRefundInvoicePayment({
      netAmount: 100,
      vatAmount: 21,
      totalWithVat: 121,
      refundAmount: 21,
      commissionPercent: 10,
    });
    // 21 * 100/121 = 17.36 net share, 3.64 VAT share
    expect(result.refundNet).toBeCloseTo(17.36, 2);
    expect(result.refundVat).toBeCloseTo(3.64, 2);
    expect(result.netAmount).toBeCloseTo(82.64, 2);
    expect(result.totalWithVat).toBeCloseTo(100, 2);
    // Commission recalculated on the remaining net: 10% of 82.64
    expect(result.platformCommission).toBeCloseTo(8.26, 2);
    expect(result.professionalPayout).toBeCloseTo(74.38, 2);
    expect(result.supplierScale).toBeCloseTo(100 / 121, 4);
  });

  it("handles reverse-charge (zero VAT) bookings", () => {
    const result = computePostRefundInvoicePayment({
      netAmount: 100,
      vatAmount: 0,
      totalWithVat: 100,
      refundAmount: 40,
      commissionPercent: 10,
    });
    expect(result.refundNet).toBe(40);
    expect(result.refundVat).toBe(0);
    expect(result.netAmount).toBe(60);
    expect(result.platformCommission).toBe(6);
  });
});

describe("leavesBillableRemainder", () => {
  it("treats full refunds as non-billable", () => {
    expect(leavesBillableRemainder(121, 121)).toBe(false);
    expect(leavesBillableRemainder(121, 0)).toBe(false);
  });

  it("keeps sub-cent dust billable so the refund block still shows", () => {
    expect(leavesBillableRemainder(121, 21)).toBe(true);
    expect(leavesBillableRemainder(121, 120.996)).toBe(true);
  });
});

describe("effectiveVatRateForCredit", () => {
  it("finds the rate that reproduces the split to the cent", async () => {
    const { effectiveVatRateForCredit } = await import("../../utils/invoiceAccounting");
    // €21.00 has no exact 21% split (17.36 + 3.64): effective rate reconciles it.
    const rate = effectiveVatRateForCredit(17.36, 3.64, 21);
    expect(Math.round((17.36 * rate) / 100 * 100) / 100).toBe(3.64);
    expect(effectiveVatRateForCredit(100, 21, 21)).toBe(21);
    expect(effectiveVatRateForCredit(100, 0, 0)).toBe(0);
    expect(effectiveVatRateForCredit(0, 0, 0)).toBe(0);
  });
});

describe("isPreCompletionStatus", () => {
  it("guards dispute-managed and terminal states", async () => {
    const { isPreCompletionStatus } = await import("../../utils/refundFinalization");
    expect(isPreCompletionStatus("booked")).toBe(true);
    expect(isPreCompletionStatus("in_progress")).toBe(true);
    expect(isPreCompletionStatus("dispute")).toBe(false);
    expect(isPreCompletionStatus("completed")).toBe(false);
    expect(isPreCompletionStatus("cancelled")).toBe(false);
    expect(isPreCompletionStatus("refunded")).toBe(false);
  });
});

describe("resolveExtraCostScale", () => {
  const lines = [{ amount: 80 }];
  it("is 1 when nothing was resolved", () => {
    expect(resolveExtraCostScale(lines, undefined)).toBe(1);
    expect(resolveExtraCostScale(lines, 80)).toBe(1);
  });
  it("scales to the admin-resolved total and zeroes when declined", () => {
    expect(resolveExtraCostScale(lines, 50)).toBeCloseTo(0.625, 5);
    expect(resolveExtraCostScale(lines, 0)).toBe(0);
  });
});
