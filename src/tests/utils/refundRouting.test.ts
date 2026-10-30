import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePartialRefundCreditArtifacts: vi.fn(),
  ensureBookingInvoiceArtifacts: vi.fn(),
}));

vi.mock("../../services/invoiceArtifacts", () => ({
  ensurePartialRefundCreditArtifacts: (...args: unknown[]) =>
    mocks.ensurePartialRefundCreditArtifacts(...args),
  ensureBookingInvoiceArtifacts: (...args: unknown[]) => mocks.ensureBookingInvoiceArtifacts(...args),
}));

import { ensureRefundInvoices } from "../../utils/refundFinalization";

describe("ensureRefundInvoices routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops at the partial credit when invoices already exist", async () => {
    mocks.ensurePartialRefundCreditArtifacts.mockResolvedValue("credited");
    await ensureRefundInvoices("booking-1");
    expect(mocks.ensurePartialRefundCreditArtifacts).toHaveBeenCalledWith("booking-1");
    expect(mocks.ensureBookingInvoiceArtifacts).not.toHaveBeenCalled();
  });

  it("generates net invoices when none exist yet", async () => {
    mocks.ensurePartialRefundCreditArtifacts.mockResolvedValue("generate");
    await ensureRefundInvoices("booking-1");
    expect(mocks.ensureBookingInvoiceArtifacts).toHaveBeenCalledWith("booking-1");
  });

  it("does nothing when there is nothing to credit (e.g. full refund)", async () => {
    mocks.ensurePartialRefundCreditArtifacts.mockResolvedValue("skip");
    await ensureRefundInvoices("booking-1");
    expect(mocks.ensureBookingInvoiceArtifacts).not.toHaveBeenCalled();
  });
});
