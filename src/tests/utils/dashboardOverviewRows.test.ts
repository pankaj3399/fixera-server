import { describe, expect, it } from "vitest";
import {
  OVERVIEW_LEDGER_NOT_LOADED,
  buildBookingListOverview,
  buildSharedBookingsRow,
  overviewLedgerFromPaymentRows,
  settledCompletionAddition,
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
it('never shows the pre-VAT net for a priced version without a recorded VAT-inclusive total', () => {
  const priced = { version: 2, totalAmount: 300, currency: 'EUR', pricingLines: [{ description: 'Work', price: 300, vatRate: 21 }] };
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [priced] })).toEqual({ amount: null, currency: null, source: 'not_recorded' });
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [{ ...priced, totalWithVat: 363 }] }).amount).toBe(363);
  // Legacy versions without pricingLines keep the totalAmount fallback (0% VAT).
  expect(pinnedVersionMoney({ currentQuoteVersion: 2, quoteVersions: [{ version: 2, totalAmount: 300, currency: 'EUR' }] }).amount).toBe(300);
});
it('never presents an amount due as the paid price', () => {
  const due = { totalWithVat: 1210, currency: 'EUR', status: 'pending' };
  for (const status of ['quote_accepted', 'payment_pending']) {
    expect(buildSharedBookingsRow({ _id: 'b1', status, payment: { ...due, status: 'authorized' } }, 'customer').paidPrice)
      .toEqual({ amount: null, currency: null, source: 'not_recorded' });
  }
  // A later milestone's open checkout replaced booking.payment.
  expect(buildSharedBookingsRow({ _id: 'b1', status: 'in_progress', payment: due }, 'customer').paidPrice.amount).toBeNull();
  expect(buildSharedBookingsRow({ _id: 'b1', status: 'booked', payment: { ...due, status: 'authorized' } }, 'customer').paidPrice.amount).toBe(1210);
});

describe('recorded money on the shared bookings row', () => {
  it('never presents the pre-VAT payment.amount as the paid price', () => {
    // createPaymentIntent stores the net in payment.amount and the charge in totalWithVat.
    const payment = { amount: 110, netAmount: 110, vatAmount: 21, totalWithVat: 131, currency: 'EUR', status: 'authorized' };
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'booked', payment }, 'customer').paidPrice)
      .toEqual({ amount: 131, currency: 'EUR', source: 'recorded' });
    const { totalWithVat: _omit, ...withoutTotal } = payment;
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'booked', payment: withoutTotal }, 'customer').paidPrice)
      .toEqual({ amount: null, currency: null, source: 'not_recorded' });
  });

  const NOT_RECORDED = { amount: null, currency: null, source: 'not_recorded' };
  const ledger = (refunds: Array<Record<string, unknown>>) => overviewLedgerFromPaymentRows([{ _id: 'pay1', refunds }]);
  const EMPTY = ledger([]);

  it('reports the settled extra-cost charge from the payment, not unrecorded entry statuses', () => {
    const booking = {
      _id: 'b1',
      status: 'completed',
      extraCostStatus: 'confirmed',
      extraCostTotal: 20,
      // Real IExtraCost entries: no status, pre-commission/pre-VAT amounts.
      extraCosts: [{ type: 'other', name: 'Extra tile', justification: 'x', amount: 20 }],
      payment: {
        totalWithVat: 1210,
        currency: 'EUR',
        status: 'completed',
        extraCostAmount: 26.62,
        extraCostStatus: 'succeeded',
        extraCostPaymentSucceeded: true,
      },
    };
    expect(buildSharedBookingsRow(booking, 'customer', EMPTY).completionAddition)
      .toEqual({ amount: 26.62, currency: 'EUR', source: 'recorded' });
    // Without the ledger a refund may exist, so the addition is unknown.
    expect(buildSharedBookingsRow(booking, 'customer').completionAddition).toEqual(NOT_RECORDED);
    expect(buildSharedBookingsRow(booking, 'customer', OVERVIEW_LEDGER_NOT_LOADED).completionAddition).toEqual(NOT_RECORDED);
    // Pending, failed or missing extra-cost payments are not a settled
    // addition, and a refunded charge without its recorded refund is unknown.
    for (const extraCostStatus of ['pending', 'failed', 'refunded', undefined]) {
      expect(buildSharedBookingsRow({ ...booking, payment: { ...booking.payment, extraCostStatus } }, 'professional', EMPTY).completionAddition)
        .toEqual(NOT_RECORDED);
    }
    // A legacy invented entry status is ignored.
    expect(buildSharedBookingsRow({ _id: 'b2', status: 'completed', extraCosts: [{ status: 'paid', total: 50, amount: 50 }], payment: { totalWithVat: 10, currency: 'EUR', status: 'completed' } }, 'customer', EMPTY).completionAddition.amount)
      .toBeNull();
  });

  it('reports a returned negative adjustment from the ledger as a negative addition, excluding failed rows', () => {
    const payment = { totalWithVat: 500, currency: 'EUR', status: 'partially_refunded' };
    const facts = ledger([
      { amount: 30, kind: 'extra_cost', status: 'succeeded', refundId: 're_1' },
      { amount: 99, kind: 'extra_cost', status: 'failed', refundId: 're_2' },
    ]);
    const row = buildSharedBookingsRow({ _id: 'b1', status: 'completed', payment }, 'professional', facts);
    expect(row.completionAddition).toEqual({ amount: -30, currency: 'EUR', source: 'recorded' });
    // Extra-cost rows are not booking-price refunds.
    expect(row.refundAmount).toEqual(NOT_RECORDED);
    // booking.payment carries no refund rows; a payload field is never read.
    const fake = { ...payment, refunds: [{ amount: 30, kind: 'extra_cost', status: 'succeeded' }] };
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'completed', payment: fake }, 'professional', EMPTY).completionAddition)
      .toEqual(NOT_RECORDED);
  });

  it('nets an extra-cost charge against its recorded refunds across the charge lifecycle', () => {
    const addition = (payment: Record<string, unknown>, refunds: Array<Record<string, unknown>>) =>
      settledCompletionAddition({ currency: 'EUR', ...payment }, ledger(refunds));
    const charged = { extraCostAmount: 121, extraCostStatus: 'succeeded' };
    const refunded = { extraCostAmount: 121, extraCostStatus: 'refunded' };
    // Charge then full refund: net 0, never -121.
    expect(addition(refunded, [{ amount: 121, kind: 'extra_cost', status: 'succeeded', refundId: 're_full' }])).toBe(0);
    // Partial refunds net to the remainder (legacy rows without status count).
    expect(addition(refunded, [{ amount: 40, kind: 'extra_cost', status: 'succeeded' }])).toBe(81);
    expect(addition(charged, [{ amount: 21, kind: 'extra_cost' }])).toBe(100);
    // Refunded charge with no recorded returned refund: amount unknown.
    expect(addition(refunded, [])).toBeNull();
    expect(addition(refunded, [{ amount: 121, kind: 'extra_cost', status: 'failed' }])).toBeNull();
    // Negative-only credit (no extra-cost charge) stays negative.
    expect(addition({}, [{ amount: 30, kind: 'extra_cost', status: 'succeeded' }])).toBe(-30);
    expect(addition({ extraCostStatus: 'failed', extraCostAmount: 50 }, [{ amount: 30, kind: 'extra_cost' }])).toBe(-30);
    // Failed/canceled refunds returned nothing.
    expect(addition(charged, [
      { amount: 121, kind: 'extra_cost', status: 'failed' },
      { amount: 121, kind: 'extra_cost', status: 'canceled' },
    ])).toBe(121);
    expect(addition({}, [{ amount: 30, kind: 'extra_cost', status: 'canceled' }])).toBeNull();
    // In-flight facts are unknown, not zero.
    expect(addition(charged, [{ amount: 21, kind: 'extra_cost', status: 'pending' }])).toBeNull();
    expect(addition({}, [{ amount: 30, kind: 'extra_cost', status: 'requires_action' }])).toBeNull();
    expect(addition({ extraCostStatus: 'pending', extraCostAmount: 121 }, [])).toBeNull();
    // A settled charge without a recorded amount is unknown.
    expect(addition({ extraCostStatus: 'succeeded' }, [])).toBeNull();
    // Booking-price refunds never touch the addition.
    expect(addition(charged, [{ amount: 500, kind: 'booking', status: 'succeeded' }])).toBe(121);
    // The same provider refund recorded twice is one fact.
    expect(addition(refunded, [
      { amount: 121, kind: 'extra_cost', status: 'succeeded', refundId: 're_dup' },
      { amount: 121, kind: 'extra_cost', status: 'succeeded', refundId: 're_dup' },
    ])).toBe(0);
    // Not loaded is unknown even for a plain settled charge.
    expect(settledCompletionAddition(charged, OVERVIEW_LEDGER_NOT_LOADED)).toBeNull();
  });

  it('counts only booking-price ledger refunds that returned money', () => {
    const row = (refunds: any[], extra: Record<string, unknown> = {}) => buildSharedBookingsRow({
      _id: 'b1',
      status: 'completed',
      payment: { totalWithVat: 500, currency: 'EUR', status: 'completed', ...extra },
    }, 'professional', ledger(refunds)).refundAmount;
    expect(row([{ amount: 100, status: 'failed' }])).toEqual(NOT_RECORDED);
    expect(row([{ amount: 100, status: 'canceled' }, { amount: 40, status: 'pending' }])).toEqual(NOT_RECORDED);
    expect(row([{ amount: 100, status: 'failed' }, { amount: 40, status: 'succeeded' }, { amount: 10 }]))
      .toEqual({ amount: 50, currency: 'EUR', source: 'recorded' });
    // Extra-cost rows are the completion addition, never the refund column.
    expect(row([{ amount: 40, kind: 'extra_cost', status: 'succeeded' }])).toEqual(NOT_RECORDED);
    // The recorded aggregate stays authoritative.
    expect(row([{ amount: 100, status: 'failed' }], { refundAmount: 25 }).amount).toBe(25);
    // Not loaded: only the aggregate can answer.
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'completed', payment: { currency: 'EUR' } }, 'professional').refundAmount)
      .toEqual(NOT_RECORDED);
    // Customers never get the pro-side refund column.
    expect(buildSharedBookingsRow({ _id: 'b1', status: 'completed', payment: { refundAmount: 25, currency: 'EUR' } }, 'customer', EMPTY).refundAmount.amount).toBeNull();
  });

  it('builds the list overview DTO with only computed money fields', () => {
    const overview = buildBookingListOverview({
      _id: 'b1',
      status: 'completed',
      payment: { totalWithVat: 1210, currency: 'EUR', status: 'completed', extraCostAmount: 121, extraCostStatus: 'refunded', professionalPayout: 900 },
    }, 'professional', ledger([{ amount: 121, kind: 'extra_cost', status: 'succeeded', refundId: 're_x', notes: 'internal' }]));
    expect(overview).toEqual({
      paidPrice: { amount: 1210, currency: 'EUR', source: 'recorded' },
      completionAddition: { amount: 0, currency: 'EUR', source: 'recorded' },
    });
    // Ledger facts keep only amount/kind/status.
    expect(ledger([{ amount: 5, kind: 'extra_cost', status: 'weird', refundId: 're_y', notes: 'n', refundedBy: 'u' }]))
      .toEqual({ loaded: true, refunds: [{ amount: 5, kind: 'extra_cost', status: 'unknown' }] });
    // An unrecognised status is not money returned.
    expect(settledCompletionAddition({}, ledger([{ amount: 5, kind: 'extra_cost', status: 'weird' }]))).toBeNull();
  });
});
