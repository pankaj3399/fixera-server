import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import {
  bookingForViewer,
  filterInvoiceFieldsByRole,
  resolveBookingViewerRole,
  sanitizePaymentForViewer,
  stripPeppolDispatchDiagnostics,
  stripProPayoutSummaryForCustomer,
} from "../../utils/invoiceVisibility";

const payment = {
  invoiceNumber: "FIX-2026-000001",
  invoiceUrl: "https://example/FIX.pdf",
  creditNoteNumber: "CN-FIX-1",
  peppolDispatchStatus: "failed",
  peppolDispatchReason: "Odoo Server Error: Traceback (most recent call last)",
  supplierPeppolDispatchStatus: "failed",
  supplierPeppolDispatchReason: "Odoo proxy rejected endpoint 0208:secret",
  creditNotePeppolDispatchReason: "raw customer credit-note provider detail",
  supplierCreditNotePeppolDispatchReason: "raw supplier credit-note provider detail",
  supplierInvoiceNumber: "SUP-2026-000001",
  supplierInvoiceUrl: "https://example/SUP.pdf",
  supplierCreditNoteNumber: "CN-SUP-1",
  supplierCreditNotePeppolDispatchStatus: "failed",
  supplierCreditNotePeppolDispatchReference: "SUP-CN-REF",
  supplierPeppolDispatchedAt: "2026-01-02T00:00:00.000Z",
  supplierCreditNoteRelatedInvoiceNumber: "SUP-2026-000001",
  supplierInvoiceGenerationClaim: "GENERATING-SUP-1",
  creditNotePeppolDispatchStatus: "sent",
  creditNotePeppolDispatchReference: "FIX-CN-REF",
  peppolDispatchedAt: "2026-01-02T00:00:00.000Z",
  peppolRetriedAt: "2026-01-03T00:00:00.000Z",
  creditNoteRelatedInvoiceNumber: "FIX-2026-000001",
  creditNoteGenerationClaim: "GENERATING-CN-1",
  invoiceArtifactHistory: [
    { side: "customer", invoiceNumber: "FIX-OLD", invoiceUrl: "https://example/FIX-old.pdf" },
    { side: "supplier", invoiceNumber: "SUP-OLD", invoiceUrl: "https://example/SUP-old.pdf" },
  ],
};

describe("invoice visibility", () => {
  it("hides customer identifiers as well as URLs from professionals", () => {
    const result = filterInvoiceFieldsByRole({ payment: { ...payment } }, "professional");
    expect(result.payment.invoiceNumber).toBeUndefined();
    expect(result.payment.creditNoteNumber).toBeUndefined();
    expect(result.payment.creditNoteRelatedInvoiceNumber).toBeUndefined();
    expect(result.payment.creditNotePeppolDispatchStatus).toBeUndefined();
    expect(result.payment.creditNotePeppolDispatchReference).toBeUndefined();
    expect(result.payment.creditNoteGenerationClaim).toBeUndefined();
    expect(result.payment.peppolDispatchedAt).toBeUndefined();
    expect(result.payment.peppolRetriedAt).toBeUndefined();
    expect(result.payment.supplierInvoiceNumber).toBe("SUP-2026-000001");
    expect(result.payment.supplierCreditNotePeppolDispatchStatus).toBe("failed");
    expect(result.payment.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: "supplier", invoiceNumber: "SUP-OLD" }),
    ]);
  });

  it("hides supplier identifiers as well as URLs from customers", () => {
    const result = filterInvoiceFieldsByRole({ payment: { ...payment } }, "customer");
    expect(result.payment.invoiceNumber).toBe("FIX-2026-000001");
    expect(result.payment.creditNotePeppolDispatchStatus).toBe("sent");
    expect(result.payment.supplierInvoiceNumber).toBeUndefined();
    expect(result.payment.supplierCreditNoteNumber).toBeUndefined();
    expect(result.payment.supplierCreditNotePeppolDispatchStatus).toBeUndefined();
    expect(result.payment.supplierCreditNotePeppolDispatchReference).toBeUndefined();
    expect(result.payment.supplierPeppolDispatchedAt).toBeUndefined();
    expect(result.payment.supplierCreditNoteRelatedInvoiceNumber).toBeUndefined();
    expect(result.payment.supplierInvoiceGenerationClaim).toBeUndefined();
    expect(result.payment.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: "customer", invoiceNumber: "FIX-OLD" }),
    ]);
  });

  it("hides stored Peppol provider reasons from both non-admin parties", () => {
    for (const role of ["customer", "professional"] as const) {
      const result = filterInvoiceFieldsByRole({ payment: { ...payment } }, role);
      expect(result.payment.peppolDispatchReason).toBeUndefined();
      expect(result.payment.supplierPeppolDispatchReason).toBeUndefined();
      expect(result.payment.creditNotePeppolDispatchReason).toBeUndefined();
      expect(result.payment.supplierCreditNotePeppolDispatchReason).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("Traceback");
      expect(JSON.stringify(result)).not.toContain("Odoo proxy rejected");
    }
  });

  it("keeps the stored diagnostic reason for admins", () => {
    const result = filterInvoiceFieldsByRole({ payment: { ...payment } }, "admin");
    expect(result.payment.peppolDispatchReason).toBe(payment.peppolDispatchReason);
    expect(result.payment.supplierPeppolDispatchReason).toBe(payment.supplierPeppolDispatchReason);
  });

  it("strips diagnostics from customer payment-history documents without mutating the source", () => {
    const source = {
      peppolDispatchReason: "raw provider text",
      supplierPeppolDispatchReason: "raw supplier text",
      creditNotePeppolDispatchReason: "raw credit text",
      supplierCreditNotePeppolDispatchReason: "raw supplier credit text",
      status: "completed",
    };
    const result = stripPeppolDispatchDiagnostics(source);
    expect(result.status).toBe("completed");
    expect(result.peppolDispatchReason).toBeUndefined();
    expect(result.supplierPeppolDispatchReason).toBeUndefined();
    expect(result.creditNotePeppolDispatchReason).toBeUndefined();
    expect(result.supplierCreditNotePeppolDispatchReason).toBeUndefined();
    expect(source.peppolDispatchReason).toBe("raw provider text");
  });
});

describe("non-admin payment diagnostics", () => {
  const historicalPayment = () => ({
    status: "completed",
    amount: 120,
    totalWithVat: 145.2,
    currency: "EUR",
    transferFailureReason: "Stripe API error: SQLSTATE 42P01 relation \\\"transfers\\\" does not exist",
    extraCostTransferFailureReason: "Odoo Server Error: Traceback (most recent call last)",
    refundNotes: "Dispute dp_123 opened. Provider secret sk_live_abc",
    refunds: [
      {
        amount: 20,
        reason: "Completion extra-cost adjustment",
        source: "platform",
        refundedAt: "2026-01-01T00:00:00.000Z",
        notes: "Stripe refund failure: card_declined sk_live_secret",
        refundId: "re_provider_internal",
        obligationId: "obligation-internal-id",
        refundedBy: "507f1f77bcf86cd799439011",
        kind: "extra_cost",
        status: "succeeded",
      },
      {
        amount: 5,
        reason: "Goodwill",
        source: "professional",
        refundedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    metadata: {
      transferFailed: true,
      transferError: "Request failed with api_key=sk_live_meta_secret",
      environment: "production",
    },
    refundReason: "Customer accepted negotiated refund",
    disputeReason: "product_not_received",
    disputeStatus: "needs_response",
    invoiceNumber: "FIX-1",
    supplierInvoiceNumber: "SUP-1",
    invoiceArtifactHistory: [
      { side: "customer", invoiceNumber: "FIX-OLD", invoiceUrl: "https://example/FIX-old.pdf" },
      { side: "supplier", invoiceNumber: "SUP-OLD", invoiceUrl: "https://example/SUP-old.pdf" },
    ],
    manualArtifactClaims: [
      { key: "customer:invoice", side: "customer", documentType: "invoice", invoiceNumber: "FIX-MANUAL" },
      { key: "supplier:invoice", side: "supplier", documentType: "invoice", invoiceNumber: "SUP-MANUAL" },
    ],
  });

  it("strips every historical internal diagnostic from customer and professional payment-history/export payloads", () => {
    for (const role of ["customer", "professional"] as const) {
      const source = historicalPayment();
      const result = sanitizePaymentForViewer(source, role);
      const serialized = JSON.stringify(result);

      expect(result.transferFailureReason).toBeUndefined();
      expect(result.extraCostTransferFailureReason).toBeUndefined();
      expect(result.refundNotes).toBeUndefined();
      expect(result.refunds[0].notes).toBeUndefined();
      expect(result.refunds[0].refundId).toBeUndefined();
      expect(result.refunds[0].obligationId).toBeUndefined();
      expect(result.refunds[0].refundedBy).toBeUndefined();
      expect(result.metadata).toBeUndefined();

      expect(serialized).not.toContain("sk_live");
      expect(serialized).not.toContain("SQLSTATE");
      expect(serialized).not.toContain("Traceback");
      expect(serialized).not.toContain("card_declined");
      expect(serialized).not.toContain("re_provider_internal");
      expect(serialized).not.toContain("obligation-internal-id");
      expect(serialized).not.toContain("507f1f77bcf86cd799439011");

      // Financial/user state survives sanitization.
      expect(result.status).toBe("completed");
      expect(result.amount).toBe(120);
      expect(result.totalWithVat).toBe(145.2);
      expect(result.refunds[0].amount).toBe(20);
      expect(result.refunds[0].reason).toBe("Completion extra-cost adjustment");
      expect(result.refunds[0].kind).toBe("extra_cost");
      expect(result.refunds[0].status).toBe("succeeded");
      expect(result.refundReason).toBe("Customer accepted negotiated refund");
      expect(result.disputeReason).toBe("product_not_received");
      expect(result.disputeStatus).toBe("needs_response");
      expect(result.metadata).toBeUndefined();

      // The source document is never mutated.
      expect(source.transferFailureReason).toContain("Stripe API error");
      expect(source.refunds[0].notes).toContain("card_declined");
    }
  });

  it("keeps both invoice sides and all diagnostics for admins", () => {
    const result = sanitizePaymentForViewer(historicalPayment(), "admin");
    expect(result.transferFailureReason).toContain("Stripe API error");
    expect(result.extraCostTransferFailureReason).toContain("Traceback");
    expect(result.refundNotes).toContain("sk_live_abc");
    expect(result.refunds[0].notes).toContain("card_declined");
    expect(result.refunds[0].refundId).toBe("re_provider_internal");
    expect(result.refunds[0].obligationId).toBe("obligation-internal-id");
    expect(result.refunds[0].refundedBy).toBe("507f1f77bcf86cd799439011");
    expect(result.metadata.transferError).toContain("sk_live_meta_secret");
    expect(result.invoiceNumber).toBe("FIX-1");
    expect(result.supplierInvoiceNumber).toBe("SUP-1");
    expect(result.invoiceArtifactHistory).toHaveLength(2);
    expect(result.manualArtifactClaims).toHaveLength(2);
  });

  it("does not expose the other side's manual invoice claims or artifact history", () => {
    const customerResult = sanitizePaymentForViewer(historicalPayment(), "customer");
    expect(customerResult.manualArtifactClaims).toEqual([
      expect.objectContaining({ side: "customer", invoiceNumber: "FIX-MANUAL" }),
    ]);
    expect(customerResult.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: "customer", invoiceNumber: "FIX-OLD" }),
    ]);

    const professionalResult = sanitizePaymentForViewer(historicalPayment(), "professional");
    expect(professionalResult.manualArtifactClaims).toEqual([
      expect.objectContaining({ side: "supplier", invoiceNumber: "SUP-MANUAL" }),
    ]);
    expect(professionalResult.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: "supplier", invoiceNumber: "SUP-OLD" }),
    ]);
  });

  it("strips payment client secrets from professionals but keeps them for the paying customer", () => {
    const payment = {
      status: "pending",
      stripeClientSecret: "pi_secret_customer",
      extraCostClientSecret: "pi_extra_secret_customer",
    };
    const customerResult = sanitizePaymentForViewer(payment, "customer");
    expect(customerResult.stripeClientSecret).toBe("pi_secret_customer");
    expect(customerResult.extraCostClientSecret).toBe("pi_extra_secret_customer");

    const professionalResult = sanitizePaymentForViewer(payment, "professional");
    expect(professionalResult.stripeClientSecret).toBeUndefined();
    expect(professionalResult.extraCostClientSecret).toBeUndefined();
  });

  it("removes milestone client secrets from booking payloads", () => {
    const booking = {
      payment: { status: "pending" },
      milestonePayments: [
        { title: "Start", amount: 50, status: "pending", stripeClientSecret: "pi_milestone_secret" },
      ],
    };
    const result = bookingForViewer(booking, "customer");
    expect(result.milestonePayments[0].stripeClientSecret).toBeUndefined();
    expect(result.milestonePayments[0].amount).toBe(50);
    expect(booking.milestonePayments[0].stripeClientSecret).toBe("pi_milestone_secret");
  });

  it("resolves the viewer from booking participation, not only the global role", () => {
    const booking = {
      customer: { _id: "customer-1" },
      professional: { _id: "professional-1" },
      project: { professionalId: "owner-1" },
    };
    expect(resolveBookingViewerRole({ _id: "admin-1", role: "admin" }, booking)).toBe("admin");
    expect(resolveBookingViewerRole({ _id: "customer-1", role: "customer" }, booking)).toBe("customer");
    expect(resolveBookingViewerRole({ _id: "professional-1", role: "professional" }, booking)).toBe("professional");
    expect(resolveBookingViewerRole({ _id: "owner-1", role: "professional" }, booking)).toBe("professional");
    expect(resolveBookingViewerRole({ _id: "someone", role: "customer" }, booking)).toBe("customer");
  });
});

describe("booking-level historical sanitation", () => {
  const booking = () => ({
    status: "dispute",
    payment: {
      status: "completed",
      totalWithVat: 121,
      transferFailureReason: "Stripe API error: SQLSTATE 42P01",
      extraCostTransferFailureReason: "Odoo Traceback: raw provider text",
      refundNotes: "provider secret sk_live_booking",
      refunds: [{ amount: 10, reason: "Customer accepted refund", notes: "raw refund note" }],
      metadata: { transferError: "raw metadata error", transferFailed: true },
      peppolDispatchReason: "Traceback: peppol",
      supplierPeppolDispatchReason: "Traceback: supplier peppol",
      invoiceNumber: "FIX-1",
      supplierInvoiceNumber: "SUP-1",
      refundReason: "Customer accepted negotiated refund",
    },
    cancellation: { reason: "Customer moved house", refundAmount: 10 },
    dispute: { reason: "Work incomplete", description: "Two radiators missing" },
    milestonePayments: [{ title: "Start", amount: 50, stripeClientSecret: "pi_secret_milestone" }],
  });

  it("strips provider diagnostics through the main booking filter while keeping user/business state", () => {
    for (const role of ["customer", "professional"] as const) {
      const result = filterInvoiceFieldsByRole(booking(), role);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("SQLSTATE");
      expect(serialized).not.toContain("Traceback");
      expect(serialized).not.toContain("sk_live_booking");
      expect(serialized).not.toContain("raw refund note");
      expect(serialized).not.toContain("raw metadata error");
      expect(serialized).not.toContain("pi_secret_milestone");

      expect(result.payment.status).toBe("completed");
      expect(result.payment.totalWithVat).toBe(121);
      expect(result.payment.refundReason).toBe("Customer accepted negotiated refund");
      expect(result.cancellation.reason).toBe("Customer moved house");
      expect(result.cancellation.refundAmount).toBe(10);
      expect(result.dispute.reason).toBe("Work incomplete");
    }
  });

  it("keeps historical diagnostics for admin booking responses", () => {
    const result = filterInvoiceFieldsByRole(booking(), "admin");
    expect(result.payment.transferFailureReason).toContain("SQLSTATE");
    expect(result.payment.refundNotes).toContain("sk_live_booking");
    expect(result.payment.metadata.transferError).toContain("raw metadata error");
    expect(result.payment.peppolDispatchReason).toContain("Traceback");
    expect(result.payment.supplierInvoiceNumber).toBe("SUP-1");
  });
});

describe("viewer role with Mongo ObjectIds", () => {
  it("matches raw ObjectIds instead of their binary id buffer", () => {
    const customerId = new mongoose.Types.ObjectId();
    const professionalId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const booking = { customer: customerId, professional: professionalId };

    expect(
      resolveBookingViewerRole({ _id: customerId, role: "customer" }, booking)
    ).toBe("customer");
    expect(
      resolveBookingViewerRole({ _id: professionalId, role: "professional" }, booking)
    ).toBe("professional");
    expect(
      resolveBookingViewerRole({ _id: otherId, role: "professional" }, booking)
    ).toBe("professional");
  });
});

describe("pro payout summary stripping", () => {
  it("strips transfer facts for customers while keeping own totals and refunds", () => {
    const payment = {
      status: "completed",
      currency: "EUR",
      totalWithVat: 1210,
      professionalPayout: 1089,
      transferredAt: new Date("2026-04-01T00:00:00.000Z"),
      transferStatus: "succeeded",
      refunds: [{ amount: 100, currency: "EUR" }],
      invoiceNumber: "FIX-1",
      supplierInvoiceNumber: "SUP-1",
    };
    const stripped = stripProPayoutSummaryForCustomer({ ...payment });
    expect(stripped.professionalPayout).toBeUndefined();
    expect(stripped.transferredAt).toBeUndefined();
    expect(stripped.transferStatus).toBeUndefined();
    expect(stripped.supplierInvoiceNumber).toBeUndefined();
    expect(stripped.totalWithVat).toBe(1210);
    expect(stripped.refunds).toHaveLength(1);
    expect(stripped.invoiceNumber).toBe("FIX-1");
  });
});
