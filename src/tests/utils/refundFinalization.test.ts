import { describe, expect, it, vi } from "vitest";
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

describe("FT3 #5 partial refund on a started booking without a resource plan", () => {
  const A = "64b000000000000000000001";
  const B = "64b000000000000000000002";
  const noPlanBooking = (overrides: Record<string, any> = {}) => ({
    status: "in_progress",
    professional: A,
    assignedTeamMembers: [A, B],
    scheduleTimeZone: "UTC",
    scheduledStartDate: new Date("2026-10-26T08:00:00Z"),
    scheduledExecutionEndDate: new Date("2026-10-31T17:00:00Z"),
    ...overrides,
  });
  const isoDays = (booking: any) =>
    booking.resourcePlan.map((entry: any) => [String(entry.resourceId), entry.days.map((d: Date) => d.toISOString().slice(0, 10))]);

  it("retains start -> day before the refund for every assigned resource", async () => {
    const { retainPastScheduledWindow } = await import("../../utils/refundFinalization");
    const booking: any = noPlanBooking();
    expect(retainPastScheduledWindow(booking, new Date("2026-10-29T12:00:00Z"))).toBe(6);
    expect(isoDays(booking)).toEqual([
      [A, ["2026-10-26", "2026-10-27", "2026-10-28"]],
      [B, ["2026-10-26", "2026-10-27", "2026-10-28"]],
    ]);
  });

  it("prune falls back to the past window only when no planned day exists", () => {
    const booking: any = noPlanBooking({ assignedTeamMembers: [], resourcePlan: [] });
    expect(pruneFutureResourcePlanDays(booking, new Date("2026-10-28T09:00:00Z"))).toEqual({ keptDays: 2, removedDays: 0 });
    // Legacy attendee fallback: the professional keeps the block.
    expect(isoDays(booking)).toEqual([[A, ["2026-10-26", "2026-10-27"]]]);
    // Idempotent: a second prune on the retained plan changes nothing.
    expect(pruneFutureResourcePlanDays(booking, new Date("2026-10-28T09:00:00Z"))).toEqual({ keptDays: 2, removedDays: 0 });
  });

  it("does not synthesize days for a plan whose days were all in the future", () => {
    const booking: any = noPlanBooking({ resourcePlan: [{ resourceId: A, days: [new Date("2026-10-30T00:00:00Z")] }] });
    expect(pruneFutureResourcePlanDays(booking, new Date("2026-10-28T09:00:00Z"))).toEqual({ keptDays: 0, removedDays: 1 });
    expect(booking.resourcePlan[0].days).toEqual([]);
    // A second pass (dispute/negotiation re-prune) must not re-materialise
    // the window from a plan that was already pruned to empty.
    expect(pruneFutureResourcePlanDays(booking, new Date("2026-10-28T09:00:00Z"))).toEqual({ keptDays: 0, removedDays: 0 });
    expect(booking.resourcePlan).toHaveLength(1);
    expect(booking.resourcePlan[0].days).toEqual([]);
  });

  it("retains nothing when the window has not passed yet and clamps to the execution end", async () => {
    const { retainPastScheduledWindow } = await import("../../utils/refundFinalization");
    const future: any = noPlanBooking();
    expect(retainPastScheduledWindow(future, new Date("2026-10-26T10:00:00Z"))).toBe(0);
    expect(future.resourcePlan).toBeUndefined();
    const finished: any = noPlanBooking({ assignedTeamMembers: [A], scheduledExecutionEndDate: new Date("2026-10-28T00:00:00Z") });
    expect(retainPastScheduledWindow(finished, new Date("2026-11-05T10:00:00Z"))).toBe(2);
    expect(isoDays(finished)).toEqual([[A, ["2026-10-26", "2026-10-27"]]]);
  });

  it("uses the booking time zone for the local calendar days", async () => {
    const { retainPastScheduledWindow } = await import("../../utils/refundFinalization");
    const booking: any = noPlanBooking({
      assignedTeamMembers: [A],
      scheduleTimeZone: "Europe/Brussels",
      // 00:30 local on Oct 26 (UTC+1 after the DST change).
      scheduledStartDate: new Date("2026-10-25T23:30:00Z"),
    });
    // 00:30 local on Oct 28 -> Oct 26 and 27 have passed locally.
    expect(retainPastScheduledWindow(booking, new Date("2026-10-27T23:30:00Z"))).toBe(2);
    expect(isoDays(booking)).toEqual([[A, ["2026-10-26", "2026-10-27"]]]);
  });

  it("preparePartialRefundCancellation cancels and keeps the past window", async () => {
    const { preparePartialRefundCancellation } = await import("../../utils/refundFinalization");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    try {
      const booking: any = noPlanBooking({ assignedTeamMembers: [B] });
      preparePartialRefundCancellation(booking, isBookingStarted(booking));
      expect(booking.status).toBe("cancelled");
      expect(booking.refundPreservesPastPlanning).toBe(true);
      expect(isoDays(booking)).toEqual([[B, ["2026-10-26", "2026-10-27"]]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not touch a booking that never started", async () => {
    const { preparePartialRefundCancellation } = await import("../../utils/refundFinalization");
    const booking: any = noPlanBooking({ status: "booked" });
    preparePartialRefundCancellation(booking, false);
    expect(booking.resourcePlan).toBeUndefined();
  });
});
