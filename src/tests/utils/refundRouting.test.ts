import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(), find: vi.fn(),
  ensurePartialRefundCreditArtifacts: vi.fn(),
  ensureBookingInvoiceArtifacts: vi.fn(),
}));

vi.mock('../../models/booking', () => ({ default: { updateOne: mocks.update, find: mocks.find } }));
vi.mock("../../services/invoiceArtifacts", () => ({
  CREDIT_GENERATION_CLAIM_TTL_MS: 900000,
  ensurePartialRefundCreditArtifacts: (...args: unknown[]) =>
    mocks.ensurePartialRefundCreditArtifacts(...args),
  ensureBookingInvoiceArtifacts: (...args: unknown[]) => mocks.ensureBookingInvoiceArtifacts(...args),
}));

import { ensureRefundInvoices, retryPendingRefundInvoices } from "../../utils/refundFinalization";

describe("ensureRefundInvoices routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({ modifiedCount: 1 });
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

  it('queues busy credits durably past claim expiry without routing to invoice generation', async () => {
    mocks.ensurePartialRefundCreditArtifacts.mockResolvedValue('busy');
    const before = Date.now();
    await ensureRefundInvoices('booking-1');
    expect(mocks.ensureBookingInvoiceArtifacts).not.toHaveBeenCalled();
    const retryAt = mocks.update.mock.calls[0][1].$set['payment.refundInvoiceRetryAt'];
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(before + 901000);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('drains queued credit retries from the existing cron and clears completed retry markers', async () => {
    const now = new Date();
    mocks.ensurePartialRefundCreditArtifacts.mockResolvedValue('credited');
    mocks.find.mockImplementation(filter => ({ select() { return this; }, sort() { return this; },
      limit: async () => filter._id ? [] : [{ _id: 'booking-1' }] }));
    await retryPendingRefundInvoices(now);
    expect(mocks.find).toHaveBeenCalledWith({ 'payment.refundInvoiceRetryAt': { $lte: now } });
    expect(mocks.ensurePartialRefundCreditArtifacts).toHaveBeenCalledWith('booking-1');
    expect(mocks.ensureBookingInvoiceArtifacts).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ _id: 'booking-1' }),
      { $unset: { 'payment.refundInvoiceRetryAt': '' } });
  });

});
