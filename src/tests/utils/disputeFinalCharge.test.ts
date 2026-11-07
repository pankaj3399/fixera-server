import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentConfig: vi.fn() }));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: mocks.getCurrentConfig } }));

import { resolveDisputeExtraCostFinalCharge } from "../../utils/disputeFinalCharge";
import { buildDisputeResolvedHtml, buildMilestonePaymentDueHtml } from "../../utils/emailService";

describe("resolveDisputeExtraCostFinalCharge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentConfig.mockResolvedValue({ commissionPercent: 10 });
  });

  it("scales the persisted VAT-inclusive charge with the admin decision", async () => {
    // Original: 80 net + 10% commission + 21% VAT = 106.48 charged.
    const booking = { payment: { extraCostAmount: 106.48, vatRate: 21, reverseCharge: false } };
    // Admin reduces 80 -> 50: final = 106.48 * 50/80 = 66.55
    await expect(resolveDisputeExtraCostFinalCharge(booking, 80, 50)).resolves.toBeCloseTo(66.55, 2);
  });

  it("returns zero when the extra cost is fully declined", async () => {
    const booking = { payment: { extraCostAmount: 106.48, vatRate: 21 } };
    await expect(resolveDisputeExtraCostFinalCharge(booking, 80, 0)).resolves.toBe(0);
  });

  it(" rebuilds the charge from commission and VAT without a baseline", async () => {
    const booking = { payment: { vatRate: 21, reverseCharge: false } };
    // 50 * 1.1 = 55 net, +21% VAT = 66.55
    await expect(resolveDisputeExtraCostFinalCharge(booking, 0, 50)).resolves.toBeCloseTo(66.55, 2);
  });

  it("respects reverse charge (no VAT)", async () => {
    const booking = { payment: { reverseCharge: true, vatRate: 0 } };
    await expect(resolveDisputeExtraCostFinalCharge(booking, 0, 50)).resolves.toBeCloseTo(55, 2);
  });
});

describe("resolveDisputeEmailAmount", () => {
  it("returns the scaled final amount on success", async () => {
    const { resolveDisputeEmailAmount } = await import("../../utils/disputeFinalCharge");
    const booking = { payment: { extraCostAmount: 106.48, vatRate: 21 } };
    await expect(resolveDisputeEmailAmount(booking, 80, 50)).resolves.toBeCloseTo(66.55, 2);
  });

  it("omits the amount (never the bare net) when resolution fails", async () => {
    const { resolveDisputeEmailAmount } = await import("../../utils/disputeFinalCharge");
    await expect(resolveDisputeEmailAmount(null, 0, 50)).resolves.toBeUndefined();
    await expect(resolveDisputeEmailAmount(undefined, 80, 50)).resolves.toBeUndefined();
  });
});

describe("dispute-resolved email", () => {
  it("shows the final amount to be paid and never a platform percentage", () => {
    const html = buildDisputeResolvedHtml("Customer", "Extra costs reduced", 66.55, "booking-1", "EUR");
    expect(html).toContain("Final amount to be paid");
    expect(html).toContain("66.55");
    expect(html).not.toContain("Adjusted amount");
    expect(html).not.toMatch(/platform\s*%/i);
    expect(html).not.toContain("commission");
  });

  it("omits the amount line when the final amount is unknown", () => {
    const html = buildDisputeResolvedHtml("Customer", "Extra costs reduced", undefined, "booking-1", "EUR");
    expect(html).toContain("Resolution:");
    expect(html).not.toContain("Final amount to be paid");
  });
});

describe("milestone payment-due email", () => {
  it("renders the milestone title and amount with a payment link", () => {
    const html = buildMilestonePaymentDueHtml("Customer", "booking-1", "Mid", 220, "EUR");
    expect(html).toContain("Mid");
    expect(html).toContain("220");
    expect(html).toContain("/bookings/booking-1/payment");
  });

  it("omits the amount block when the amount is unknown", () => {
    const html = buildMilestonePaymentDueHtml("Customer", "booking-1", "Mid", undefined, "EUR");
    expect(html).toContain("Mid");
    expect(html).not.toContain("Amount Due");
  });
});
