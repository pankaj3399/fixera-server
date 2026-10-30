import { describe, expect, it } from "vitest";
import {
  buildSharedBookingsRow,
  buildSharedQuoteRow,
  isPayNowEligible,
  isWarrantyActionEligible,
  pinnedVersionMoney,
  resolveArchiveRestoreTarget,
  resolvePinnedQuoteVersion,
  resolveSnapshotTitles,
} from "../../utils/bookingDetails/overviewRows";

describe("shared bookings overview rows", () => {
  it("prefers the booking-time snapshot over the live project", () => {
    const titles = resolveSnapshotTitles({
      project: { _id: "p1", title: "Live mutated title" },
      bookingSnapshot: {
        project: { id: "p1", title: "Snapshot title" },
        selectedSubproject: { title: "Snapshot subproject" },
      },
    });
    expect(titles).toEqual({
      projectId: "p1",
      projectTitle: "Snapshot title",
      subprojectTitle: "Snapshot subproject",
      titleSource: "booking_snapshot",
    });
  });

  it("falls back to the live project only when no snapshot exists", () => {
    const titles = resolveSnapshotTitles({ project: { _id: "p1", title: "Live title" } });
    expect(titles.titleSource).toBe("live_project");
    expect(titles.projectTitle).toBe("Live title");
    expect(titles.subprojectTitle).toBeNull();
  });

  it("reports paid price VAT-inclusive and unknown dates as null", () => {
    const row = buildSharedBookingsRow({
      _id: "b1",
      bookingNumber: "BK-2026-000001",
      status: "booked",
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      payment: { totalWithVat: 1210, currency: "EUR" },
    }, "customer");
    expect(row.paidPrice).toEqual({ amount: 1210, currency: "EUR", source: "recorded" });
    expect(row.plannedStart).toBeNull();
    expect(row.actualStart).toBeNull();
    expect(row.actualEnd).toBeNull();
  });

  it("ends the planned window at the execution end, never the buffer end (client bug list #22c)", () => {
    const row = buildSharedBookingsRow({
      _id: "b1",
      bookingNumber: "BK-2026-000110",
      status: "booked",
      scheduledStartDate: new Date("2026-11-02T00:00:00.000Z"),
      scheduledExecutionEndDate: new Date("2026-11-03T00:00:00.000Z"),
      scheduledBufferEndDate: new Date("2026-11-06T00:00:00.000Z"),
      payment: { totalWithVat: 1210, currency: "EUR" },
    }, "customer");
    // The timeline/duration frontend must consume plannedEnd (execution),
    // not the buffer/delivery window end.
    expect(row.plannedEnd).toBe(new Date("2026-11-03T00:00:00.000Z").toISOString());
  });

  it("keeps pro payout fields for professionals but strips them for customers", () => {
    const booking = {
      _id: "b1",
      status: "completed",
      payment: {
        totalWithVat: 1210,
        currency: "EUR",
        professionalPayout: 1089,
        transferredAt: new Date("2026-04-01T10:00:00.000Z"),
        transferStatus: "succeeded",
        status: "completed",
      },
    };
    const pro = buildSharedBookingsRow(booking, "professional");
    expect(pro.payoutAmount.amount).toBe(1089);
    expect(pro.payoutDate).toBe("2026-04-01T10:00:00.000Z");

    const customer = buildSharedBookingsRow(booking, "customer");
    expect(customer.payoutAmount).toEqual({ amount: null, currency: null, source: "not_recorded" });
    expect(customer.payoutDate).toBeNull();
    // Customer-own totals stay intact.
    expect(customer.paidPrice.amount).toBe(1210);
  });

  it("uses the actual transfer date only, never a capture fallback", () => {
    const row = buildSharedBookingsRow({
      _id: "b1",
      status: "completed",
      payment: {
        totalWithVat: 500,
        currency: "EUR",
        professionalPayout: 450,
        capturedAt: new Date("2026-04-01T10:00:00.000Z"),
        status: "completed",
      },
    }, "professional");
    expect(row.payoutDate).toBeNull();
  });

  it("reports refunds only when a refund record or status exists", () => {
    const withoutRefund = buildSharedBookingsRow({
      _id: "b1",
      status: "completed",
      payment: { totalWithVat: 500, currency: "EUR", status: "completed" },
    }, "professional");
    expect(withoutRefund.refundAmount).toEqual({ amount: null, currency: null, source: "not_recorded" });

    const withRefund = buildSharedBookingsRow({
      _id: "b1",
      status: "refunded",
      payment: { totalWithVat: 500, currency: "EUR", status: "refunded", refundAmount: 500 },
    }, "professional");
    expect(withRefund.refundAmount.amount).toBe(500);
  });
});

describe("shared quote overview rows", () => {
  it("pins the recorded accepted version, not the mutable latest", () => {
    const booking = {
      acceptedQuoteVersion: 2,
      currentQuoteVersion: 4,
      quoteVersions: [
        { version: 2, totalAmount: 1000, currency: "EUR" },
        { version: 4, totalAmount: 2500, currency: "EUR" },
      ],
    };
    expect(resolvePinnedQuoteVersion(booking)).toEqual({ pinnedVersion: 2, pinnedVersionSource: "recorded" });
    expect(pinnedVersionMoney(booking).amount).toBe(1000);
  });

  it("infers the current version only when no accepted version is recorded", () => {
    const booking = {
      currentQuoteVersion: 3,
      quoteVersions: [{ version: 3, totalAmount: 750, currency: "EUR" }],
    };
    expect(resolvePinnedQuoteVersion(booking)).toEqual({ pinnedVersion: 3, pinnedVersionSource: "inferred_current" });
  });

  it("returns unknown money when the pinned version document is missing", () => {
    expect(pinnedVersionMoney({ currentQuoteVersion: 9, quoteVersions: [] }))
      .toEqual({ amount: null, currency: null, source: "not_recorded" });
  });

  it("renders RFQ-initial unfilled fields as null", () => {
    const row = buildSharedQuoteRow({ _id: "b1", status: "rfq", createdAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(row.quotationNumber).toBeNull();
    expect(row.pinnedVersion).toBeNull();
    expect(row.quoteDate).toBeNull();
    expect(row.expiryDate).toBeNull();
    expect(row.quotePrice).toEqual({ amount: null, currency: null, source: "not_recorded" });
  });
});

describe("archive restore target", () => {
  it("never restores straight to published", () => {
    expect(resolveArchiveRestoreTarget("published")).toBe("draft");
    expect(resolveArchiveRestoreTarget(undefined)).toBe("draft");
  });

  it("preserves verified non-published states", () => {
    expect(resolveArchiveRestoreTarget("on_hold")).toBe("on_hold");
    expect(resolveArchiveRestoreTarget("draft")).toBe("draft");
    expect(resolveArchiveRestoreTarget("suspended")).toBe("suspended");
  });
});

describe("dashboard eligibility helpers", () => {
  it("marks quote_accepted and payment_pending as pay-now eligible", () => {
    expect(isPayNowEligible("quote_accepted")).toBe(true);
    expect(isPayNowEligible("payment_pending")).toBe(true);
    expect(isPayNowEligible("booked")).toBe(false);
  });

  it("marks completed bookings inside warranty coverage as eligible", () => {
    const now = new Date("2026-06-01T00:00:00.000Z").getTime();
    expect(isWarrantyActionEligible({
      status: "completed",
      warrantyCoverage: { duration: { value: 12, unit: "months" }, endsAt: "2027-01-01T00:00:00.000Z" },
    }, now)).toBe(true);
    expect(isWarrantyActionEligible({
      status: "completed",
      warrantyCoverage: { duration: { value: 12, unit: "months" }, endsAt: "2026-01-01T00:00:00.000Z" },
    }, now)).toBe(false);
    expect(isWarrantyActionEligible({ status: "booked" }, now)).toBe(false);
  });
});

it('derives the price model from the booking snapshot before the mutable project', () => {
  const row = buildSharedBookingsRow({ bookingSnapshot: { project: { priceModel: 'unit' } }, project: { priceModel: 'fixed' } }, 'professional');
  expect(row.priceModel).toBe('unit');
});
it('uses the recorded customer VAT-inclusive total for the pinned quote', () => {
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [{ version: 2, totalAmount: 300, customerTotals: { totalWithVat: 363 }, currency: 'EUR' }] }).amount).toBe(363);
});
it('preserves a recorded zero refund and unknown when absent', () => {
  expect(buildSharedBookingsRow({ payment: { refundAmount: 0, currency: 'EUR' } }, 'professional').refundAmount.amount).toBe(0);
});
