export type InvoiceViewerRole = "admin" | "customer" | "professional";

/**
 * Provider diagnostics are admin-only. Historical booking/payment rows can
 * still contain raw Odoo/Peppol text, so strip it from non-admin payloads
 * without a DB migration.
 */
const PEPPOL_DIAGNOSTIC_FIELDS = [
  "peppolDispatchReason",
  "supplierPeppolDispatchReason",
  "creditNotePeppolDispatchReason",
  "supplierCreditNotePeppolDispatchReason",
] as const;

/**
 * Internal payment diagnostics. These are written from provider/webhook
 * failures or platform recovery notes and are never safe to show to a
 * customer or professional. Status/amount/timestamp fields stay intact.
 */
const INTERNAL_PAYMENT_DIAGNOSTIC_FIELDS = [
  "transferFailureReason",
  "extraCostTransferFailureReason",
  "extraCostRefundPending",
  "refundNotes",
] as const;

/**
 * `metadata` is a free-form stripe/recovery bag. Only known diagnostic keys
 * are removed; operational flags such as `transferFailed` remain available.
 */
const INTERNAL_PAYMENT_METADATA_KEYS = [
  "transferError",
  "lastError",
  "error",
  "errorMessage",
  "failureReason",
  "transferFailureReason",
  "providerError",
  "stripeError",
] as const;

/**
 * Provider identifiers/credentials and operational metadata are admin payment
 * data. The legacy raw booking response keeps only the customer's own client
 * secrets (the existing payment page reads them); these fields are removed for
 * every participant.
 */
const PARTICIPANT_PROVIDER_FIELDS = [
  "stripePaymentIntentId",
  "stripeChargeId",
  "stripeTransferId",
  "stripeDestinationPayment",
  "transferIdempotencyKey",
  "extraCostStripePaymentIntentId",
  "extraCostStripeChargeId",
  "extraCostTransferId",
  "disputeId",
] as const;

/** Invoice fields that belong to the customer (FIX) side. */
const CUSTOMER_INVOICE_FIELDS = [
  "invoiceNumber",
  "creditNoteNumber",
  "invoiceUrl",
  "invoiceUblUrl",
  "creditNoteUrl",
  "creditNoteUblUrl",
  "invoiceGeneratedAt",
  "creditNoteGeneratedAt",
  "creditNoteRelatedInvoiceNumber",
  "peppolDispatchStatus",
  "peppolDispatchReference",
  "peppolDispatchedAt",
  "peppolRetriedAt",
  "creditNotePeppolDispatchStatus",
  "creditNotePeppolDispatchReference",
  "creditNoteGenerationClaim",
] as const;

/** Invoice fields that belong to the professional/supplier self-billing (SUP) side. */
const SUPPLIER_INVOICE_FIELDS = [
  "supplierInvoiceNumber",
  "supplierCreditNoteNumber",
  "supplierInvoiceUrl",
  "supplierInvoiceUblUrl",
  "supplierCreditNoteUrl",
  "supplierCreditNoteUblUrl",
  "supplierInvoiceGeneratedAt",
  "supplierCreditNoteGeneratedAt",
  "supplierCreditNoteRelatedInvoiceNumber",
  "supplierPeppolDispatchStatus",
  "supplierPeppolDispatchReference",
  "supplierPeppolDispatchedAt",
  "supplierCreditNotePeppolDispatchStatus",
  "supplierCreditNotePeppolDispatchReference",
  "supplierInvoiceGenerationClaim",
] as const;

const stripFields = (payment: Record<string, any>, fields: readonly string[]) => {
  for (const field of fields) {
    if (field in payment) payment[field] = undefined;
  }
};

/**
 * Remove both invoice sides (and their artifact history/claims). Used when an
 * admin can read bookings but not the payments area: invoice documents are
 * payment-area artifacts, while amounts/statuses remain visible.
 */
export const stripAllInvoiceFields = <T extends Record<string, any>>(payment: T): T => {
  if (!payment || typeof payment !== "object") return payment;
  const clean: Record<string, any> = { ...payment };
  stripFields(clean, CUSTOMER_INVOICE_FIELDS);
  stripFields(clean, SUPPLIER_INVOICE_FIELDS);
  if ("invoiceArtifactHistory" in clean) clean.invoiceArtifactHistory = undefined;
  if ("manualArtifactClaims" in clean) clean.manualArtifactClaims = undefined;
  return clean as T;
};

const filterArtifactHistory = (
  history: unknown,
  side: "customer" | "supplier"
): unknown => {
  if (!Array.isArray(history)) return history;
  return history.filter((entry: any) => entry?.side === side);
};

const filterManualArtifactClaims = (
  claims: unknown,
  side: "customer" | "supplier"
): unknown => {
  if (!Array.isArray(claims)) return claims;
  return claims.filter((claim: any) => claim?.side === side);
};

/**
 * Remove non-role-specific internal/provider diagnostics from a payment
 * payload (booking.payment subdocument or a Payment document). Never mutates
 * the source object.
 */
export const stripInternalPaymentDiagnostics = <T extends Record<string, any>>(
  payment: T
): T => {
  if (!payment || typeof payment !== "object") return payment;

  const clean: Record<string, any> = { ...payment };
  stripFields(clean, PEPPOL_DIAGNOSTIC_FIELDS);
  stripFields(clean, INTERNAL_PAYMENT_DIAGNOSTIC_FIELDS);

  if (Array.isArray(clean.refunds)) {
    clean.refunds = clean.refunds.map((refund: any) =>
      refund && typeof refund === "object"
        ? {
            ...refund,
            notes: undefined,
            refundId: undefined,
            obligationId: undefined,
            // Internal actor id only; participant details/activity resolve the
            // recorded actor name without exposing the admin's user id.
            refundedBy: undefined,
          }
        : refund
    );
  }

  if (clean.metadata && typeof clean.metadata === "object" && !Array.isArray(clean.metadata)) {
    const metadata = { ...clean.metadata };
    for (const key of INTERNAL_PAYMENT_METADATA_KEYS) delete metadata[key];
    clean.metadata = metadata;
  }

  return clean as T;
};

/**
 * Backwards-compatible name for the expanded payment sanitizer. Prefer
 * `stripInternalPaymentDiagnostics` in new code.
 */
export const stripPeppolDispatchDiagnostics = <T extends Record<string, any>>(
  payment: T
): T => stripInternalPaymentDiagnostics(payment);

/**
 * Role-aware payment serializer. Admins keep diagnostics; everyone else gets
 * only their own invoice side (including history/claims) and no internal
 * provider text. Returns a new object and never mutates the source.
 */
export const sanitizePaymentForViewer = (
  payment: any,
  viewerRole: InvoiceViewerRole
) => {
  if (!payment || typeof payment !== "object") return payment;
  if (viewerRole === "admin") return { ...payment };

  const clean: Record<string, any> = stripInternalPaymentDiagnostics(payment);
  stripFields(clean, PARTICIPANT_PROVIDER_FIELDS);
  if ("metadata" in clean) clean.metadata = undefined;

  if (viewerRole === "customer") {
    stripFields(clean, SUPPLIER_INVOICE_FIELDS);
  } else {
    stripFields(clean, CUSTOMER_INVOICE_FIELDS);
    // A client secret can confirm or capture the customer's payment. The
    // professional only needs payout/invoice data, never the payment credential.
    if ("stripeClientSecret" in clean) clean.stripeClientSecret = undefined;
    if ("extraCostClientSecret" in clean) clean.extraCostClientSecret = undefined;
  }

  const side = viewerRole === "customer" ? "customer" : "supplier";
  clean.invoiceArtifactHistory = filterArtifactHistory(clean.invoiceArtifactHistory, side);
  clean.manualArtifactClaims = filterManualArtifactClaims(clean.manualArtifactClaims, side);

  return clean;
};

/**
 * Milestone payment records only need their schedule/status/amount fields in a
 * booking payload. Client secrets are handed out by the dedicated
 * payment-intent endpoint instead.
 */
export const sanitizeMilestonesForViewer = (milestones: unknown) => {
  if (!Array.isArray(milestones)) return milestones;
  return milestones.map((milestone: any) => sanitizeMilestoneForViewer(milestone));
};

export const sanitizeMilestoneForViewer = (milestone: any) => {
  if (!milestone || typeof milestone !== "object") return milestone;
  const clean: Record<string, any> = {
    ...milestone,
    stripeClientSecret: undefined,
    extraCostClientSecret: undefined,
  };
  stripFields(clean, PARTICIPANT_PROVIDER_FIELDS);
  if ("metadata" in clean) clean.metadata = undefined;
  return clean;
};

/**
 * Remove the other party's invoice artifacts, including identifiers, before
 * returning a booking. Admins keep the stored diagnostics and both sides.
 */
export const filterInvoiceFieldsByRole = (booking: any, viewerRole: InvoiceViewerRole) => {
  if (!booking || typeof booking !== "object" || viewerRole === "admin") return booking;

  if (booking.payment && typeof booking.payment === "object") {
    booking.payment = sanitizePaymentForViewer(booking.payment, viewerRole);
  }

  booking.milestonePayments = sanitizeMilestonesForViewer(booking.milestonePayments);

  return booking;
};

/**
 * Non-mutating booking serializer for route responses. Accepts Mongoose
 * documents or lean objects and returns a plain object safe for the viewer.
 */
export const bookingForViewer = (booking: any, viewerRole: InvoiceViewerRole) => {
  if (!booking || typeof booking !== "object" || viewerRole === "admin") return booking;

  const source = typeof booking.toObject === "function" ? booking.toObject() : { ...booking };
  const visible = filterInvoiceFieldsByRole(source, viewerRole);

  // Internal booking notes and admin-only dispute internals are not part of
  // any participant payload. They must be removed here as well as in details,
  // because older clients still read the raw booking object.
  if ("notes" in visible) visible.notes = undefined;
  if (visible.dispute && typeof visible.dispute === "object") {
    delete visible.dispute.resolution;
    delete visible.dispute.resolutionAttachments;
    delete visible.dispute.resolvedBy;
    delete visible.dispute.adminAdjustedAmount;
  }

  return visible;
};

const referenceId = (value: any): string | undefined => {
  if (value === null || value === undefined) return undefined;
  // ObjectId also exposes a binary `.id` buffer, so prefer its hex form.
  if (typeof value.toHexString === "function") return value.toHexString();
  const raw = value._id ?? value.id ?? value;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw.toHexString === "function") return raw.toHexString();
  return typeof raw.toString === "function" ? raw.toString() : String(raw);
};

/**
 * Resolve the role of the authenticated viewer relative to a booking. This is
 * safer than trusting a single global role for dual-party routes and also
 * recognizes project owners and admins.
 */
export const resolveBookingViewerRole = (
  user: any,
  booking: any
): InvoiceViewerRole => {
  if (user?.role === "admin" || user?.isAdmin === true) return "admin";

  const userId = referenceId(user?._id ?? user?.id ?? user);
  if (userId) {
    const customerId = referenceId(booking?.customer);
    const professionalId =
      referenceId(booking?.professional) || referenceId(booking?.project?.professionalId);
    if (professionalId && userId === professionalId) return "professional";
    if (customerId && userId === customerId) return "customer";
  }

  return user?.role === "professional" ? "professional" : "customer";
};

/** Resolve which booking/payment payload the current request may receive. */
export const bookingForRequest = (booking: any, user: any) =>
  bookingForViewer(booking, resolveBookingViewerRole(user, booking));

export const paymentForViewer = (payment: any, viewerRole: InvoiceViewerRole) =>
  sanitizePaymentForViewer(payment, viewerRole);
