import mongoose from "mongoose";
import { createHash, randomUUID } from "node:crypto";
import Booking from "../models/booking";
import Payment from "../models/payment";
import PlatformSettings from "../models/platformSettings";
import ServiceConfiguration from "../models/serviceConfiguration";
import { presignS3Url, uploadBufferToS3, downloadBufferFromS3 } from "../utils/s3Upload";
import {
  REVERSE_CHARGE_LABEL,
  normalizeVatCountry,
  resolveSupplierB2BInvoiceDecision,
  resolveSupplierInvoiceVatDecision,
  type VatDecision,
} from "../utils/vatManagement";
import { mapUnitToUneceCode, resolveInvoiceServiceUnit, tryNormalizeInvoiceUnit } from "../utils/invoiceUnits";
import { getExtraCostQuantity, reconcileUnitPrice } from "../utils/invoiceLineQuantity";
import { commissionedExtraCostAmount, customerUnitPrice } from "../utils/customerPricing";
import { getInvoicePayment } from "../utils/invoiceSettlement";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  effectiveVatRateForCredit,
  getCustomerExtraCostNet,
  resolveExtraCostScale,
  type InvoiceAccountingLine,
} from "../utils/invoiceAccounting";
import {
  generateBookingInvoice,
  applyManualInvoicePartyOverrides,
  scaleLineItemsToTotal,
  type ManualInvoiceLine,
  type ManualInvoiceOverride,
} from "./invoiceGenerator";
import { invoiceRefundFacts, invoiceSettledServiceLines } from "../utils/invoiceSettlements";
import type { InvoiceSettlementBasis, RefundCreditFact } from "../models/invoiceSettlement";
import { normalizeInvoiceBasis } from "../utils/milestoneInvoice";
import { quoteAmountIncludesSelectedExtras } from "../utils/payment";
import { maybeDispatchPeppolInvoice } from "./peppolDispatch";
import { isUserFacingError, UserFacingError } from "../utils/appErrors";
import { safeErrorSummary } from "../utils/safeErrorLog";
import { notify } from "../utils/notifications/notify";
import type { InvoiceArtifactHistoryEntry } from "../Types/invoice";

export const SELF_BILLING_NOTE = "Prepared and sent on behalf of the supplier.";
const SELF_BILLING_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:selfbilling:3.0";
const SELF_BILLING_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:selfbilling:01:1.0";
const COMMERCIAL_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
const COMMERCIAL_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";
const PEPPOL_DISPATCH_IN_PROGRESS =
  "Peppol dispatch in progress; if this does not change, generate the invoice again to finish it";
// Anything unexpected at the provider boundary stays in logs; only safe,
// actionable text is persisted on the booking/payment.
const PEPPOL_DISPATCH_RETRY_REASON =
  "Peppol dispatch failed. Generate the invoice again to retry; if it keeps failing, check the Peppol settings.";
const PEPPOL_PLATFORM_CONFIG_REASON =
  "Peppol dispatch could not start because the platform invoice details are incomplete. Check the platform company and VAT settings, then generate the invoice again.";
const providerErrorMessage = (error: unknown): string =>
  // Logs only: raw provider text can carry secrets (tokens, connection
  // strings), so log the allowlisted summary instead. Persisted reasons
  // already go through dispatchFailureReason.
  JSON.stringify(safeErrorSummary(error));
const dispatchFailureReason = (error: unknown): string =>
  isUserFacingError(error) ? error.message : PEPPOL_DISPATCH_RETRY_REASON;

type InvoiceArtifactResult = {
  invoiceNumber: string;
  invoiceUrl: string;
  invoiceUblUrl?: string;
  invoiceGeneratedAt: Date;
  supplierInvoiceNumber?: string;
  supplierInvoiceUrl?: string;
  supplierInvoiceUblUrl?: string;
  supplierInvoiceGeneratedAt?: Date;
  peppolDispatchStatus?: string;
  peppolDispatchReason?: string;
  peppolDispatchReference?: string;
  supplierPeppolDispatchStatus?: string;
  supplierPeppolDispatchReason?: string;
  supplierPeppolDispatchReference?: string;
};

type CreditArtifactResult = {
  creditNoteNumber: string;
  creditNoteUrl: string;
  creditNoteUblUrl?: string;
  creditNoteGeneratedAt: Date;
  creditNoteRelatedInvoiceNumber?: string;
  relatedInvoiceNumber?: string;
  supplierCreditNoteNumber?: string;
  supplierCreditNoteUrl?: string;
  supplierCreditNoteUblUrl?: string;
  supplierCreditNoteGeneratedAt?: Date;
  supplierCreditNoteRelatedInvoiceNumber?: string;
  creditNotePeppolDispatchStatus?: string;
  creditNotePeppolDispatchReason?: string;
  creditNotePeppolDispatchReference?: string;
  supplierCreditNotePeppolDispatchStatus?: string;
  supplierCreditNotePeppolDispatchReason?: string;
  supplierCreditNotePeppolDispatchReference?: string;
};

export type ManualInvoiceCorrectionInput = ManualInvoiceOverride & {
  side: "customer" | "supplier";
  documentType: "invoice" | "credit_note";
  relatedInvoiceNumber?: string;
  /**
   * Render the override lines and totals verbatim (partial-refund credits).
   * Without it the manual path rescales lines to the stored payment, which
   * is only valid for corrections that restate the booked amounts.
   */
  exactAmounts?: boolean;
};

const escapeXml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const hasCustomerInvoiceArtifacts = (payment: any) =>
  Boolean(
    payment?.invoiceNumber &&
    payment?.invoiceUrl &&
    !String(payment.invoiceNumber).startsWith("GENERATING-") &&
    String(payment.invoiceNumber).startsWith("FIX-")
  );

const hasSupplierInvoiceArtifacts = (payment: any) =>
  Boolean(
    payment?.supplierInvoiceNumber &&
    payment?.supplierInvoiceUrl &&
    String(payment.supplierInvoiceNumber).startsWith("SUP-")
  );

const hasInvoiceArtifacts = (payment: any) =>
  Boolean(hasCustomerInvoiceArtifacts(payment) && hasSupplierInvoiceArtifacts(payment));

const hasCustomerCreditArtifacts = (payment: any): boolean =>
  Boolean(
    payment?.creditNoteNumber &&
    payment?.creditNoteUrl &&
    !String(payment.creditNoteNumber).startsWith("GENERATING-CN-")
  );

const hasSupplierCreditArtifacts = (payment: any): boolean =>
  Boolean(payment?.supplierCreditNoteNumber && payment?.supplierCreditNoteUrl);

const hasCreditNoteArtifacts = (payment: any) =>
  Boolean(hasCustomerCreditArtifacts(payment) && hasSupplierCreditArtifacts(payment));

const toInvoiceArtifactResult = (payment: any): InvoiceArtifactResult => ({
  invoiceNumber: payment.invoiceNumber,
  invoiceUrl: payment.invoiceUrl,
  invoiceUblUrl: payment.invoiceUblUrl,
  invoiceGeneratedAt: payment.invoiceGeneratedAt || new Date(),
  supplierInvoiceNumber: payment.supplierInvoiceNumber,
  supplierInvoiceUrl: payment.supplierInvoiceUrl,
  supplierInvoiceUblUrl: payment.supplierInvoiceUblUrl,
  supplierInvoiceGeneratedAt: payment.supplierInvoiceGeneratedAt,
  peppolDispatchStatus: payment.peppolDispatchStatus,
  peppolDispatchReason: payment.peppolDispatchReason,
  peppolDispatchReference: payment.peppolDispatchReference,
  supplierPeppolDispatchStatus: payment.supplierPeppolDispatchStatus,
  supplierPeppolDispatchReason: payment.supplierPeppolDispatchReason,
  supplierPeppolDispatchReference: payment.supplierPeppolDispatchReference,
});

const toCreditArtifactResult = (payment: any): CreditArtifactResult => ({
  creditNoteNumber: payment.creditNoteNumber,
  creditNoteUrl: payment.creditNoteUrl,
  creditNoteUblUrl: payment.creditNoteUblUrl,
  creditNoteGeneratedAt: payment.creditNoteGeneratedAt || new Date(),
  relatedInvoiceNumber: payment.invoiceNumber,
  supplierCreditNoteNumber: payment.supplierCreditNoteNumber,
  supplierCreditNoteUrl: payment.supplierCreditNoteUrl,
  supplierCreditNoteUblUrl: payment.supplierCreditNoteUblUrl,
  supplierCreditNoteGeneratedAt: payment.supplierCreditNoteGeneratedAt,
  supplierCreditNoteRelatedInvoiceNumber: payment.supplierCreditNoteRelatedInvoiceNumber,
  creditNotePeppolDispatchStatus: payment.creditNotePeppolDispatchStatus,
  creditNotePeppolDispatchReason: payment.creditNotePeppolDispatchReason,
  creditNotePeppolDispatchReference: payment.creditNotePeppolDispatchReference,
  supplierCreditNotePeppolDispatchStatus: payment.supplierCreditNotePeppolDispatchStatus,
  supplierCreditNotePeppolDispatchReason: payment.supplierCreditNotePeppolDispatchReason,
  supplierCreditNotePeppolDispatchReference: payment.supplierCreditNotePeppolDispatchReference,
});

const claimInvoiceGeneration = async (bookingId: string) =>
  Booking.findOneAndUpdate(
    {
      _id: bookingId,
      $and: [
        {
          $or: [
            { "payment.invoiceNumber": { $exists: false } },
            { "payment.invoiceNumber": null },
            { "payment.invoiceNumber": "" },
            // Reclaim abandoned in-flight claims (no URL yet).
            { "payment.invoiceNumber": /^GENERATING-/ },
          ],
        },
        {
          $or: [
            { "payment.invoiceUrl": { $exists: false } },
            { "payment.invoiceUrl": null },
            { "payment.invoiceUrl": "" },
          ],
        },
      ],
    },
    { $set: { "payment.invoiceNumber": `GENERATING-${Date.now()}` } },
    { new: true }
  );

const claimCreditNoteGeneration = async (bookingId: string) => {
  const token = `GENERATING-CN-${Date.now()}-${randomUUID()}`;
  const claimed = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      "payment.invoiceNumber": { $exists: true, $nin: [null, ""] },
      $or: [
        { "payment.creditNoteGenerationClaim": { $exists: false } },
        { "payment.creditNoteGenerationClaim": null },
        { "payment.creditNoteGenerationClaim": "" },
      ],
    },
    { $set: { "payment.creditNoteGenerationClaim": token } },
    { new: true }
  );
  return claimed ? token : null;
};

const clearInvoiceGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.invoiceNumber": /^GENERATING-/ },
    { $unset: { "payment.invoiceNumber": "" } }
  );
};

const clearCreditNoteGenerationClaim = async (bookingId: string, token?: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.creditNoteGenerationClaim": token || /^GENERATING-CN-/ },
    { $unset: { "payment.creditNoteGenerationClaim": "" } }
  );
};

/**
 * Supplier self-bill generation claim.
 *
 * The token is opaque and owner-bound: a caller may only release the exact
 * token it acquired, so one caller's cleanup can never drop another caller's
 * live claim. The reclaim TTL deliberately exceeds PDF rendering, S3 upload,
 * and Peppol dispatch time, so clearStaleGenerationClaimsIfNeeded never
 * steals a lease from work that is still in flight.
 */
const SUPPLIER_CLAIM_PREFIX = "GENERATING-SUP-";
const SUPPLIER_GENERATION_CLAIM_TTL_MS = 15 * 60 * 1000;

const parseSupplierClaimIssuedAt = (value?: string | null): number | null => {
  if (!value?.startsWith(SUPPLIER_CLAIM_PREFIX)) return null;
  // Tokens carry "<issuedAt>-<random>"; tolerate legacy timestamp-only values.
  const rest = value.slice(SUPPLIER_CLAIM_PREFIX.length);
  const separator = rest.indexOf("-");
  const issuedAt = Number(separator === -1 ? rest : rest.slice(0, separator));
  return Number.isFinite(issuedAt) ? issuedAt : null;
};

const isStaleSupplierGenerationClaim = (value?: string | null): boolean => {
  if (!value?.startsWith(SUPPLIER_CLAIM_PREFIX)) return false;
  const issuedAt = parseSupplierClaimIssuedAt(value);
  if (issuedAt == null) return true;
  return Date.now() - issuedAt > SUPPLIER_GENERATION_CLAIM_TTL_MS;
};

const claimSupplierInvoiceGeneration = async (bookingId: string): Promise<string | null> => {
  const token = `${SUPPLIER_CLAIM_PREFIX}${Date.now()}-${randomUUID()}`;
  const claimed = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      $or: [
        { "payment.supplierInvoiceNumber": { $exists: false } },
        { "payment.supplierInvoiceNumber": null },
        { "payment.supplierInvoiceNumber": "" },
      ],
      "payment.supplierInvoiceGenerationClaim": { $in: [null, ""] },
    },
    { $set: { "payment.supplierInvoiceGenerationClaim": token } },
    { new: true }
  );
  return claimed ? token : null;
};

/** Release only the exact token this caller acquired. */
const releaseSupplierInvoiceGenerationClaim = async (
  bookingId: string,
  token: string
) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.supplierInvoiceGenerationClaim": token },
    { $unset: { "payment.supplierInvoiceGenerationClaim": "" } }
  );
};

/** Short TTL so a hung/background generation does not block admin retries for 15 minutes. */
const GENERATION_CLAIM_TTL_MS = 60 * 1000;
// Credit PDFs, XML uploads and dispatch can exceed a minute.
export const CREDIT_GENERATION_CLAIM_TTL_MS = 15 * 60 * 1000;

const parseGenerationClaimTimestamp = (value: string, prefix: string): number | null => {
  if (!value.startsWith(prefix)) return null;
  const timestamp = Number(value.slice(prefix.length).split("-")[0]);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isStaleGenerationClaim = (value?: string | null, prefix = "GENERATING-"): boolean => {
  if (!value?.startsWith(prefix)) return false;
  const timestamp = parseGenerationClaimTimestamp(value, prefix);
  if (timestamp == null) return true;
  return Date.now() - timestamp > (prefix === "GENERATING-CN-"
    ? CREDIT_GENERATION_CLAIM_TTL_MS : GENERATION_CLAIM_TTL_MS);
};

const clearStaleGenerationClaimsIfNeeded = async (bookingId: string) => {
  const booking = await Booking.findById(bookingId).select(
    "payment.invoiceNumber payment.creditNoteGenerationClaim payment.supplierInvoiceGenerationClaim"
  );
  if (isStaleGenerationClaim(booking?.payment?.invoiceNumber, "GENERATING-")) {
    await clearInvoiceGenerationClaim(bookingId);
  }
  if (isStaleGenerationClaim(booking?.payment?.creditNoteGenerationClaim, "GENERATING-CN-")) {
    await clearCreditNoteGenerationClaim(bookingId, booking!.payment!.creditNoteGenerationClaim);
  }
  const staleSupplierClaim = booking?.payment?.supplierInvoiceGenerationClaim;
  if (isStaleSupplierGenerationClaim(staleSupplierClaim)) {
    // Match the exact stale token so a claim issued to a newer caller after
    // this read can never be released here.
    await Booking.updateOne(
      { _id: bookingId, "payment.supplierInvoiceGenerationClaim": staleSupplierClaim! },
      { $unset: { "payment.supplierInvoiceGenerationClaim": "" } }
    );
  }
};

const clearLegacyInvoiceFields = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId },
    {
      $unset: {
        "payment.invoiceNumber": "",
        "payment.invoiceUrl": "",
        "payment.invoiceUblUrl": "",
        "payment.invoiceGeneratedAt": "",
        "payment.supplierInvoiceNumber": "",
        "payment.supplierInvoiceUrl": "",
        "payment.supplierInvoiceUblUrl": "",
        "payment.supplierInvoiceGeneratedAt": "",
        "payment.peppolDispatchStatus": "",
        "payment.peppolDispatchReason": "",
        "payment.peppolDispatchReference": "",
        "payment.peppolDispatchedAt": "",
        "payment.supplierPeppolDispatchStatus": "",
        "payment.supplierPeppolDispatchReason": "",
        "payment.supplierPeppolDispatchReference": "",
        "payment.supplierPeppolDispatchedAt": "",
      },
    }
  );
};

const persistPaymentArtifactUpdate = async (
  bookingId: mongoose.Types.ObjectId | string,
  paymentId: string | undefined,
  update: Record<string, unknown>,
  historyEntry?: InvoiceArtifactHistoryEntry,
  creditFact?: RefundCreditFact,
) => {
  const updateDocument: Record<string, unknown> = { $set: update };
  if (historyEntry) updateDocument.$push = { invoiceArtifactHistory: historyEntry };
  if (creditFact) updateDocument.$push = { ...(updateDocument.$push as object), refundCreditLedger: creditFact };
  if (paymentId && mongoose.Types.ObjectId.isValid(paymentId)) {
    await Payment.findByIdAndUpdate(paymentId, updateDocument);
    return;
  }
  // Without a payment id, target the booking's base payment only. A booking can
  // have multiple milestone Payment documents and invoice artifacts are
  // booking-level, so an unconstrained booking match could update the wrong one.
  await Payment.findOneAndUpdate({ booking: bookingId, milestoneIndex: null }, updateDocument);
};

const toMoney = (value: unknown): string => {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toFixed(2);
};

// Unit prices keep up to 6 decimals so quantity × price still equals the
// two-decimal line amount (5 × 16.428 = 82.14, whereas 5 × 16.43 = 82.15).
const toUnitPrice = (value: unknown): string => {
  const amount = Number(value);
  const fixed = (Number.isFinite(amount) ? amount : 0).toFixed(6).replace(/0+$/, "");
  const [whole, decimals = ""] = fixed.split(".");
  return `${whole}.${decimals.padEnd(2, "0")}`;
};

// Quantities need the same headroom as the unit prices: a measured-unit
// adjustment of 32.125 − 30 is 2.125 m², and a two-decimal quantity with a
// six-decimal price no longer multiplies back to the line amount.
const toQuantity = (value: unknown): string => toUnitPrice(value);

const getCurrentQuote = (booking: any) => {
  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  return versions.find((quote: any) => quote.version === booking.currentQuoteVersion) || versions[versions.length - 1];
};

const buildUblAddress = (parts: {
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}): string => {
  const countryCode = normalizeVatCountry(parts.country);
  if (!countryCode) {
    throw new Error("UBL address country is required and must be a valid country code.");
  }
  return `
      <cac:PostalAddress>
        ${parts.street ? `<cbc:StreetName>${escapeXml(parts.street)}</cbc:StreetName>` : ""}
        ${parts.city ? `<cbc:CityName>${escapeXml(parts.city)}</cbc:CityName>` : ""}
        ${parts.postalCode ? `<cbc:PostalZone>${escapeXml(parts.postalCode)}</cbc:PostalZone>` : ""}
        <cac:Country><cbc:IdentificationCode>${escapeXml(countryCode)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>`;
};

type UblPlatformParty = {
  name?: string;
  vatNumber?: string;
  peppolParticipantId?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
};

type UblLine = InvoiceAccountingLine & { price: number; vatAmount: number };

const moneyNumber = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;

const getExtraCostLinesForUbl = (
  booking: any,
  vatRate: number,
  reverseCharge: boolean,
  customerSide: boolean,
  /** Lines at their price before the customer's loyalty discount, which then gets its own line. */
  beforeCustomerDiscount = false,
): UblLine[] => {
  const rawTotal = (booking.extraCosts || []).reduce((sum: number, cost: any) => sum + moneyNumber(cost.amount), 0);
  const customerDiscount = customerSide && beforeCustomerDiscount
    ? Math.max(0, moneyNumber(booking.payment?.extraCostCustomerDiscount))
    : 0;
  const targetTotal = customerSide
    ? Math.round((getCustomerExtraCostNet(booking.payment, rawTotal) + customerDiscount) * 100) / 100
    : rawTotal;
  // A dispute-resolved total (and a partial refund on the supplier side)
  // scales the rendered lines away from the originally booked amounts.
  const resolvedScale = resolveExtraCostScale(booking.extraCosts, booking.extraCostTotal);
  const refundScale = customerSide
    ? 1
    : normalizeInvoiceBasis(
        booking,
        Number.isFinite(Number(booking.__commissionPercent)) ? Number(booking.__commissionPercent) : 0,
      ).supplierScale;
  const adjustedTarget = Math.round(targetTotal * resolvedScale * refundScale * 100) / 100;
  const scale = rawTotal > 0 ? adjustedTarget / rawTotal : 1;
  // Charged per unit (see customerPricing): each line at its own customer
  // price, so unit lines keep whole-cent unit prices.
  const commissionPercent = Number(booking.__commissionPercent);
  const perLine = customerSide && Number.isFinite(commissionPercent)
    ? (booking.extraCosts || []).map((cost: any) => commissionedExtraCostAmount(cost, commissionPercent))
    : [];
  const chargedPerLine = perLine.length > 0
    && Math.abs(Math.round(perLine.reduce((sum: number, amount: number) => sum + amount, 0) * 100) / 100 - adjustedTarget) < 0.005;
  const fallbackUnit = resolveInvoiceServiceUnit({
    checkoutUnit: (booking.checkoutSnapshot as any)?.unit,
    subprojectUnit: (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.unit,
    pricingType:
      (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.type ||
      booking.checkoutSnapshot?.pricingType,
    pricingOptions: (booking as any).__serviceConfigPricingOptions,
  });
  const pricedLines: Array<UblLine | undefined> = (booking.extraCosts || [])
    .map((cost: any, index: number): UblLine | undefined => {
    const price = chargedPerLine ? perLine[index] : Math.round(moneyNumber(cost.amount) * scale * 100) / 100;
    const lineVatRate = reverseCharge ? 0 : vatRate;
    const units = getExtraCostQuantity(cost);
    const hasUnits = units != null;
    const unit = tryNormalizeInvoiceUnit(cost.unit) || fallbackUnit;
    const line: UblLine = {
      description: `Extra cost: ${cost.name}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: price,
      price,
      vatRate: lineVatRate,
      vatAmount: reverseCharge ? 0 : Math.round(price * lineVatRate) / 100,
      quantity: units,
      unitPrice: Number.isFinite(Number(cost.unitPrice))
        ? (chargedPerLine ? customerUnitPrice(Number(cost.unitPrice), commissionPercent) : Number(cost.unitPrice) * scale)
        : undefined,
      // Only attach a unit when there is a quantity, otherwise the UBL
      // serializer would turn a fixed-price extra cost into "1 <unit>".
      ...(hasUnits && unit ? { unit } : {}),
    };
    return Math.abs(line.amount) >= 0.005 ? line : undefined;
    });
  return pricedLines.filter((line): line is UblLine => Boolean(line));
};

const getSupplierVatContext = (booking: any, platform: UblPlatformParty): VatDecision => {
  // Prefer the decision resolved from the service configuration (reduced rates),
  // cached by loadBookingForInvoice so PDF and UBL stay in lockstep.
  if (booking?.__supplierVatDecision) return booking.__supplierVatDecision as VatDecision;
  return resolveSupplierB2BInvoiceDecision({
    supplierCountry: booking.professional?.businessInfo?.country || booking.professional?.location?.country,
    buyerCountry: platform.country,
    supplierVatNumber: booking.professional?.businessInfo?.vatNumber || booking.professional?.vatNumber,
    buyerVatNumber: platform.vatNumber,
    bookingCountry: booking.vatDecision?.country || booking.location?.country,
    propertyNature: booking.vatDecision?.propertyNature || "movable",
    exemptFromBelgianReverseCharge: booking.vatDecision?.exemptFromBelgianReverseCharge,
  });
};

const withConsistentUnitPrices = <T extends { lines: UblLine[] }>(pricing: T): T => ({
  ...pricing,
  lines: pricing.lines.map((line) => ({ ...line, unitPrice: reconcileUnitPrice(line.price, line.quantity, line.unitPrice) })),
});

const getPricingLinesForUbl = (
  booking: any,
  options: { selfBilling: boolean; platform: UblPlatformParty }
): { lines: UblLine[]; totals: ReturnType<typeof calculateInvoiceSideTotals> } =>
  withConsistentUnitPrices(getRawPricingLinesForUbl(booking, options));

const getRawPricingLinesForUbl = (
  booking: any,
  options: { selfBilling: boolean; platform: UblPlatformParty }
): { lines: UblLine[]; totals: ReturnType<typeof calculateInvoiceSideTotals> } => {
  const currentQuote = getCurrentQuote(booking);
  const manualLines = Array.isArray(booking.__manualInvoiceLines) ? booking.__manualInvoiceLines : undefined;
  const commissionPercent = Number.isFinite(Number(booking.__commissionPercent))
    ? Number(booking.__commissionPercent)
    : 0;
  // Same basis as the PDF builder: milestone scope, recovered full discount,
  // and any partial-refund reduction. Keeps both documents in lockstep.
  const basis = normalizeInvoiceBasis(booking, commissionPercent);
  const supplierVat = options.selfBilling ? getSupplierVatContext(booking, options.platform) : null;
  const reverseCharge = options.selfBilling
    ? Boolean(supplierVat?.reverseCharge)
    : Boolean(booking.payment?.reverseCharge);
  const vatRate = options.selfBilling
    ? (supplierVat?.appliedRate || 0)
    : (booking.payment?.vatRate || 0);
  if (manualLines?.length) {
    const manualReverseCharge = Boolean(booking.payment?.reverseCharge);
    const lines = manualLines.map((line: any) => ({
      description: String(line.description || "Manual correction"),
      amount: moneyNumber(line.amount),
      price: moneyNumber(line.amount),
      vatRate: moneyNumber(line.vatRate),
      vatAmount: manualReverseCharge ? 0 : Math.round(moneyNumber(line.amount) * moneyNumber(line.vatRate)) / 100,
      vatLabel: line.vatLabel,
      quantity: Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : undefined,
      unitPrice: Number.isFinite(Number(line.unitPrice)) ? Number(line.unitPrice) : undefined,
      unit: line.unit,
    }));
    const totals = calculateInvoiceSideTotals({
      lines,
      reverseCharge: manualReverseCharge,
      vatRate: moneyNumber(booking.payment?.vatRate),
      vatLabel: booking.payment?.vatLabel,
    });
    return { lines, totals };
  }
  // Milestone bookings: the stored breakdown only covers the last charged
  // milestone, so the full-scope quote pricing lines describe the service.
  const preferQuoteLines = !options.selfBilling
    && basis.useQuotePricingLines
    && Array.isArray(currentQuote?.pricingLines)
    && currentQuote.pricingLines.length > 0;
  let baseLines: UblLine[] = basis.milestoneActive && !options.selfBilling
    ? invoiceSettledServiceLines(booking).map(line => ({ ...line, price: line.amount }))
    : preferQuoteLines
    ? currentQuote.pricingLines.map((line: any) => ({
      description: line.description,
      amount: moneyNumber(line.price),
      price: moneyNumber(line.price),
      vatRate: moneyNumber(line.vatRate),
      vatAmount: 0,
      vatLabel: line.vatLabel,
    }))
    : Array.isArray(booking.payment?.vatBreakdown) && booking.payment.vatBreakdown.length > 0 && !options.selfBilling
    ? booking.payment.vatBreakdown.map((line: any) => ({
      description: line.description,
      amount: moneyNumber(line.netAmount),
      price: moneyNumber(line.netAmount),
      vatRate: line.vatRate,
      vatAmount: moneyNumber(line.vatAmount),
      vatLabel: line.vatLabel,
    }))
    : Array.isArray(currentQuote?.pricingLines) && currentQuote.pricingLines.length > 0
      ? currentQuote.pricingLines.map((line: any) => ({
          description: line.description,
          amount: moneyNumber(line.price),
          price: moneyNumber(line.price),
          vatRate: options.selfBilling ? vatRate : moneyNumber(line.vatRate),
          vatAmount: 0,
          vatLabel: line.vatLabel,
        }))
      : [{
          description: booking.quote?.description || booking.rfqData?.description || "Service",
          amount: options.selfBilling
            ? calculateSupplierInvoiceNet({
                quoteAmount: booking.quote?.amount,
                checkoutSnapshot: booking.checkoutSnapshot,
                selectedExtraOptions: booking.selectedExtraOptions,
                quoteIncludesSelectedOptions: quoteAmountIncludesSelectedExtras(booking),
              })
            : moneyNumber(basis.serviceNet > 0 ? basis.serviceNet : (booking.payment?.netAmount ?? booking.payment?.amount)),
          price: options.selfBilling
            ? calculateSupplierInvoiceNet({
                quoteAmount: booking.quote?.amount,
                checkoutSnapshot: booking.checkoutSnapshot,
                selectedExtraOptions: booking.selectedExtraOptions,
                quoteIncludesSelectedOptions: quoteAmountIncludesSelectedExtras(booking),
              })
            : moneyNumber(basis.serviceNet > 0 ? basis.serviceNet : (booking.payment?.netAmount ?? booking.payment?.amount)),
          vatRate,
          vatAmount: 0,
      }];

  const appendScaledOptions = (): void => {
    const selectedOptions: UblLine[] = (booking.selectedExtraOptions || []).map((option: any, index: number) => {
      const projectOption = booking.project?.extraOptions?.find((entry: any, entryIndex: number) =>
        String(entry?._id || entryIndex) === String(option.extraOptionId) || String(entryIndex) === String(option.extraOptionId)
      );
      return {
        description: `Option: ${projectOption?.name || option.name || option.extraOptionId || `Option ${index + 1}`}`,
        amount: moneyNumber(option.bookedPrice),
        price: moneyNumber(option.bookedPrice),
        vatRate,
        vatAmount: 0,
      } as UblLine;
    });
    if (selectedOptions.length > 0) {
      const supplierNetForScale = calculateSupplierInvoiceNet({
        quoteAmount: currentQuote?.totalAmount ?? booking.quote?.amount,
        checkoutSnapshot: booking.checkoutSnapshot,
        selectedExtraOptions: booking.selectedExtraOptions,
        repeatBuyerDiscount: basis.discount?.repeatBuyerAmount,
        quoteIncludesSelectedOptions: quoteAmountIncludesSelectedExtras(booking),
      });
      const scale = supplierNetForScale > 0 ? moneyNumber(basis.serviceNet) / supplierNetForScale : 1;
      baseLines = [
        ...baseLines,
        ...selectedOptions.map((line: UblLine) => ({
          ...line,
          amount: Math.round(line.amount * scale * 100) / 100,
          price: Math.round(line.price * scale * 100) / 100,
        })),
      ];
    }
  };

  if (!options.selfBilling && !basis.milestoneActive && preferQuoteLines) {
    // Quote pricing lines never contain the selected options; append them
    // scaled to the customer net like the no-lines fallback below does, so
    // the plug line only carries the commission instead of the options too.
    appendScaledOptions();
  }

  if (!options.selfBilling && !basis.milestoneActive && !preferQuoteLines && !booking.payment?.vatBreakdown?.length && !currentQuote?.pricingLines?.length) {
    const selectedOptions: UblLine[] = (booking.selectedExtraOptions || []).map((option: any, index: number) => {
      const projectOption = booking.project?.extraOptions?.find((entry: any, entryIndex: number) =>
        String(entry?._id || entryIndex) === String(option.extraOptionId) || String(entryIndex) === String(option.extraOptionId)
      );
      return {
        description: `Option: ${projectOption?.name || option.name || option.extraOptionId || `Option ${index + 1}`}`,
        amount: moneyNumber(option.bookedPrice),
        price: moneyNumber(option.bookedPrice),
        vatRate,
        vatAmount: 0,
      } as UblLine;
    });
    const rawOptionTotal = selectedOptions.reduce((sum: number, line: UblLine) => sum + line.amount, 0);
    const supplierNet = basis.supplierServiceNet ?? calculateSupplierInvoiceNet({
      quoteAmount: booking.quote?.amount,
      checkoutSnapshot: booking.checkoutSnapshot,
      selectedExtraOptions: booking.selectedExtraOptions,
      quoteIncludesSelectedOptions: quoteAmountIncludesSelectedExtras(booking),
    });
    const customerNet = moneyNumber(basis.serviceNet);
    const scale = supplierNet > 0 ? customerNet / supplierNet : 1;
    const scaledOptions = selectedOptions.map((line: UblLine) => ({
      ...line,
      amount: Math.round(line.amount * scale * 100) / 100,
      price: Math.round(line.price * scale * 100) / 100,
    }));
    const optionTotal = scaledOptions.reduce((sum: number, line: UblLine) => sum + line.amount, 0);
    baseLines = [{
      description: booking.quote?.description || booking.rfqData?.description || "Service",
      amount: Math.max(0, Math.round((customerNet - optionTotal) * 100) / 100),
      price: Math.max(0, Math.round((customerNet - optionTotal) * 100) / 100),
      vatRate,
      vatAmount: 0,
    }, ...scaledOptions];
    if (rawOptionTotal <= 0) {
      baseLines[0].amount = customerNet;
      baseLines[0].price = customerNet;
    }
  }

  if (!options.selfBilling && baseLines.length > 0 && booking.checkoutSnapshot?.pricingType === "unit") {
    const quantity = moneyNumber(booking.checkoutSnapshot.quantity);
    if (quantity > 0) {
      const unit = resolveInvoiceServiceUnit({
        checkoutUnit: (booking.checkoutSnapshot as any)?.unit,
        subprojectUnit: (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.unit,
        pricingType:
          (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.type ||
          booking.checkoutSnapshot?.pricingType,
        pricingOptions: (booking as any).__serviceConfigPricingOptions,
      });
      baseLines[0] = {
        ...baseLines[0],
        quantity: baseLines[0].quantity ?? quantity,
        unitPrice: baseLines[0].unitPrice ?? moneyNumber(booking.checkoutSnapshot.unitAmount),
        ...(unit && !baseLines[0].unit ? { unit } : {}),
      };
    }
  }

  if (options.selfBilling) {
    if (basis.milestoneActive && basis.supplierServiceNet == null) {
      throw new Error("Cannot invoice milestone supplier amounts without recorded professional payouts.");
    }
    const supplierNet = basis.supplierServiceNet ?? calculateSupplierInvoiceNet({
      quoteAmount: currentQuote?.totalAmount ?? booking.quote?.amount,
      checkoutSnapshot: booking.checkoutSnapshot,
      selectedExtraOptions: booking.selectedExtraOptions,
      repeatBuyerDiscount: basis.discount?.repeatBuyerAmount,
      quoteIncludesSelectedOptions: quoteAmountIncludesSelectedExtras(booking),
    });
    const selectedOptions = (booking.selectedExtraOptions || []).reduce(
      (sum: number, option: any) => sum + moneyNumber(option.bookedPrice),
      0
    );
    const checkoutUnit = resolveInvoiceServiceUnit({
      checkoutUnit: (booking.checkoutSnapshot as any)?.unit,
      subprojectUnit: (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.unit,
      pricingType:
        (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.type ||
        booking.checkoutSnapshot?.pricingType,
      pricingOptions: (booking as any).__serviceConfigPricingOptions,
    });
    const serviceLine: UblLine = {
      description: booking.rfqData?.serviceType || currentQuote?.description || booking.quote?.description || "Service",
      amount: Math.max(0, Math.round((supplierNet - selectedOptions) * basis.supplierScale * 100) / 100),
      price: Math.max(0, Math.round((supplierNet - selectedOptions) * basis.supplierScale * 100) / 100),
      vatRate,
      vatAmount: 0,
      quantity: booking.checkoutSnapshot?.pricingType === "unit" ? moneyNumber(booking.checkoutSnapshot.quantity) : undefined,
      unitPrice: booking.checkoutSnapshot?.pricingType === "unit" ? moneyNumber(booking.checkoutSnapshot.unitAmount) : undefined,
      ...(booking.checkoutSnapshot?.pricingType === "unit" && checkoutUnit ? { unit: checkoutUnit } : {}),
    };
    const optionLines = (booking.selectedExtraOptions || []).map((option: any, index: number) => {
      const projectOption = booking.project?.extraOptions?.find((entry: any, entryIndex: number) =>
        String(entry?._id || entryIndex) === String(option.extraOptionId) || String(entryIndex) === String(option.extraOptionId)
      );
      const price = Math.round(moneyNumber(option.bookedPrice) * basis.supplierScale * 100) / 100;
      return {
        description: `Option: ${projectOption?.name || option.name || option.extraOptionId || `Option ${index + 1}`}`,
        amount: price,
        price,
        vatRate,
        vatAmount: 0,
      };
    });
    const lines = [serviceLine, ...optionLines, ...getExtraCostLinesForUbl(booking, vatRate, reverseCharge, false)];
    const totals = calculateInvoiceSideTotals({ lines, reverseCharge, vatRate, vatLabel: supplierVat?.vatLabel });
    return { lines: lines.map((line) => ({ ...line, vatAmount: reverseCharge ? 0 : Math.round(line.amount * (line.vatRate ?? vatRate)) / 100 })), totals };
  }

  if (basis.milestoneActive || basis.refund) {
    baseLines = scaleLineItemsToTotal(baseLines, basis.serviceNet).map(line => ({ ...line, price: line.amount }));
  }
  const baseNet = baseLines.reduce((sum, line) => sum + line.amount, 0);
  const targetBaseNet = (basis.milestoneActive || basis.serviceNet > 0)
    ? moneyNumber(basis.serviceNet)
    : baseNet;
  if (Math.abs(targetBaseNet - baseNet) >= 0.01) {
    baseLines.push({
      description: targetBaseNet > baseNet ? "Platform commission" : "Payment discount adjustment",
      amount: Math.round((targetBaseNet - baseNet) * 100) / 100,
      price: Math.round((targetBaseNet - baseNet) * 100) / 100,
      vatRate,
      vatAmount: 0,
    });
  }
  const serviceAndDiscountLines = withCustomerDiscountLines(booking, baseLines, vatRate, reverseCharge, basis.discount)
    ?? [...baseLines, ...getExtraCostLinesForUbl(booking, vatRate, reverseCharge, true)];
  // normalizeInvoiceBasis already deducts the refund. Keep its facts in the
  // header note; another negative line would deduct it a second time.
  const lines = serviceAndDiscountLines;
  const totals = calculateInvoiceSideTotals({ lines, reverseCharge, vatRate, vatLabel: booking.payment?.vatLabel });
  const reconciledLines = lines.map(line => ({ ...line, vatAmount: reverseCharge ? 0 : Math.round(line.amount * (line.vatRate ?? vatRate)) / 100 }));
  if (booking.payment?.totalWithVat != null || basis.milestoneActive) {
    const rawExtra = (booking.extraCosts || []).reduce((sum: number, cost: any) => sum + moneyNumber(cost.amount), 0);
    const resolved = resolveExtraCostScale(booking.extraCosts, booking.extraCostTotal);
    const extraNet = roundCreditMoney(getCustomerExtraCostNet(booking.payment, rawExtra) * resolved);
    const extraGross = booking.payment?.extraCostAmount != null
      ? roundCreditMoney(Number(booking.payment.extraCostAmount) * resolved)
      : roundCreditMoney(extraNet * (1 + (reverseCharge ? 0 : vatRate) / 100));
    totals.netAmount = roundCreditMoney(basis.serviceNet + extraNet);
    totals.totalWithVat = roundCreditMoney(basis.serviceTotal + extraGross);
    totals.vatAmount = roundCreditMoney(totals.totalWithVat - totals.netAmount);
    // Keep independently rounded settlement VAT, rather than recalculating
    // it from an aggregate and silently losing a cent across installments.
    const vatDelta = roundCreditMoney(totals.vatAmount - reconciledLines.reduce((sum, line) => sum + line.vatAmount, 0));
    if (reconciledLines.length && vatDelta) reconciledLines[reconciledLines.length - 1].vatAmount =
      roundCreditMoney(reconciledLines[reconciledLines.length - 1].vatAmount + vatDelta);
  }
  return { lines: reconciledLines, totals };
};

/**
 * Customer lines at their full price with the discounts on their own lines,
 * as on the Fixtract PDF. Folding a discount into the lines would make every
 * unit price a fraction of a cent again (e.g. (492.90 - 24.65) / 30). The
 * discount is apportioned across the VAT rates present (largest remainder in
 * cents), so every discount stays visible as its own line(s) and the VAT
 * stays exactly the same as without the split.
 */
const withCustomerDiscountLines = (
  booking: any,
  baseLines: UblLine[],
  vatRate: number,
  reverseCharge: boolean,
  discountOverride?: any,
): UblLine[] | undefined => {
  const discount = discountOverride !== undefined ? discountOverride || {} : booking.payment?.discount || {};
  const serviceDiscounts = [
    { label: "Loyalty discount", amount: moneyNumber(discount.loyaltyAmount) },
    { label: "Repeat buyer discount", amount: moneyNumber(discount.repeatBuyerAmount) },
    { label: "Referral discount", amount: moneyNumber(discount.referralDiscountAmount) },
    { label: "Points discount", amount: moneyNumber(discount.pointsDiscountAmount) },
    { label: `Discount code${discount.codeLabel ? ` (${discount.codeLabel})` : ""}`, amount: moneyNumber(discount.codeDiscountAmount) },
  ].filter((entry) => entry.amount > 0);
  const extraCostDiscount = Math.round(Math.max(0, moneyNumber(booking.payment?.extraCostCustomerDiscount))
    * resolveExtraCostScale(booking.extraCosts, booking.extraCostTotal) * 100) / 100;
  if (serviceDiscounts.length === 0 && extraCostDiscount === 0) return undefined;
  const lineRateOf = (line: UblLine): number =>
    reverseCharge ? 0 : moneyNumber(line.vatRate ?? vatRate);
  const baseNet = baseLines.reduce((sum, line) => sum + line.amount, 0);
  if (!(baseNet > 0)) return undefined;

  const serviceDiscountTotal = Math.round(serviceDiscounts.reduce((sum, entry) => sum + entry.amount, 0) * 100) / 100;
  // Loyalty also carries the extra-cost loyalty reduction (as on the PDF);
  // fold it into the loyalty label before splitting by rate.
  const labels = serviceDiscounts.map((entry) => ({
    ...entry,
    amount: entry.label === "Loyalty discount"
      ? Math.round((entry.amount + extraCostDiscount) * 100) / 100
      : entry.amount,
  }));
  if (serviceDiscounts.length === 0 && extraCostDiscount > 0) {
    labels.push({ label: "Loyalty discount", amount: Math.round(extraCostDiscount * 100) / 100 });
  }
  const totalDiscount = Math.round(labels.reduce((sum, entry) => sum + entry.amount, 0) * 100) / 100;
  if (!(totalDiscount > 0)) return undefined;

  const distinctRates = [...new Set(baseLines.map(lineRateOf))].sort((a, b) => a - b);
  // Apportion the discount across rates by base share (largest remainder).
  // Service lines are grossed up by the service discount only, exactly as
  // before; the extra-cost reduction lives in the extra-cost lines. Discount
  // lines carry the full reduction (service + extra-cost part), so the lines
  // always reconcile with the charged total.
  const baseByRate = distinctRates.map((rate) =>
    baseLines.filter((line) => lineRateOf(line) === rate).reduce((sum, line) => sum + line.amount, 0),
  );
  const serviceDiscountByRate = apportionByShare(serviceDiscountTotal, baseByRate);
  const totalDiscountByRate = apportionByShare(totalDiscount, baseByRate);

  const fullBaseLines: UblLine[] = [];
  const discountLines: UblLine[] = [];
  distinctRates.forEach((rate, rateIndex) => {
    const group = baseLines.filter((line) => lineRateOf(line) === rate);
    const grossUp = serviceDiscountByRate[rateIndex];
    const rateDiscount = totalDiscountByRate[rateIndex];
    const groupBase = baseByRate[rateIndex];
    fullBaseLines.push(
      ...(grossUp > 0 && groupBase > 0
        ? scaleLineItemsToTotal(group, Math.round((groupBase + grossUp) * 100) / 100).map((line) => ({ ...line, price: line.amount }))
        : group),
    );
    if (!(rateDiscount > 0)) return;
    // Split each discount label by the same base shares (largest remainder).
    const labelShares = apportionByShare(rateDiscount, labels.map((entry) => entry.amount));
    labels.forEach((entry, labelIndex) => {
      const share = labelShares[labelIndex];
      if (!(share > 0)) return;
      discountLines.push({
        description: entry.label,
        amount: -share,
        price: -share,
        vatRate: rate,
        vatAmount: 0,
      });
    });
  });
  return [...fullBaseLines, ...getExtraCostLinesForUbl(booking, vatRate, reverseCharge, true, true), ...discountLines];
};

/** Split `total` across `weights` proportionally, in cents, largest remainder. */
const apportionByShare = (total: number, weights: number[]): number[] => {
  const totalCents = Math.round(total * 100);
  const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (!(totalCents > 0) || !(weightSum > 0)) return weights.map(() => 0);
  const floors = weights.map((weight) => Math.floor((totalCents * Math.max(0, weight)) / weightSum));
  let remainder = totalCents - floors.reduce((sum, cents) => sum + cents, 0);
  const fractions = weights
    .map((weight, index) => ({ index, frac: (totalCents * Math.max(0, weight)) / weightSum - floors[index] }))
    .sort((a, b) => b.frac - a.frac);
  for (const { index } of fractions) {
    if (remainder <= 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  return floors.map((cents) => cents / 100);
};

const getPeppolLineItems = (pricing: { lines: UblLine[] }) => pricing.lines.map((line) => ({
  description: line.description,
  price: line.price,
  vatRate: line.vatRate,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
}));

/** Human-readable refund facts for the UBL header note (both invoice sides). */
const describeRefundForUbl = (booking: any, currency: string): string | undefined => {
  const refund = normalizeInvoiceBasis(
    booking,
    Number.isFinite(Number(booking?.__commissionPercent)) ? Number(booking.__commissionPercent) : 0,
  ).refund;
  if (!refund) return undefined;
  return buildPartialRefundDescription({
    amount: refund.amount,
    currency,
    date: refund.date,
    reason: refund.reason,
    description: refund.description,
  });
};

const ublPartyXml = (
  tag: "AccountingSupplierParty" | "AccountingCustomerParty",
  party: { name: string; vatNumber?: string; peppolParticipantId?: string; street?: string; city?: string; postalCode?: string; country?: string }
) => `<cac:${tag}>
    <cac:Party>
      ${party.peppolParticipantId ? `<cbc:EndpointID schemeID="0208">${escapeXml(party.peppolParticipantId.replace(/^0208:/, ""))}</cbc:EndpointID>` : ""}
      <cac:PartyName><cbc:Name>${escapeXml(party.name)}</cbc:Name></cac:PartyName>${buildUblAddress({
        street: party.street,
        city: party.city,
        postalCode: party.postalCode,
        country: party.country,
      })}
      ${party.vatNumber ? `<cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(party.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>` : ""}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(party.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:${tag}>`;

const toBelgianPeppolParticipantId = (vatNumber?: string, country?: string): string | undefined => {
  if (normalizeVatCountry(country) !== "BE" || !vatNumber) return undefined;
  const compact = vatNumber.replace(/[\s.]/g, "").toUpperCase();
  if (compact.includes(":")) return compact;
  if (/^\d{10}$/.test(compact)) return `BE${compact}`;
  if (/^BE\d{10}$/.test(compact)) return compact;
  return undefined;
};

const buildUblPartiesAndTotals = (
  booking: any,
  currency: string,
  sign: number,
  pricingLines: any[],
  reverseCharge: boolean,
  options?: { selfBilling?: boolean; platform?: UblPlatformParty; paidAmount?: number },
  totals?: ReturnType<typeof calculateInvoiceSideTotals>
) => {
  const customer = booking.customer || {};
  const professional = booking.professional || {};
  const platform = options?.platform || {};
  const invoiceTotal = Math.round(Number(totals?.totalWithVat ?? booking.payment?.totalWithVat) * 100) / 100;
  const paidAmount = Math.min(invoiceTotal, Math.max(0, Number(options?.paidAmount) || 0));
  const taxCategoryId = reverseCharge ? "AE" : "S";
  const taxCategoryExtras = reverseCharge
    ? `<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>
        <cbc:TaxExemptionReason>${escapeXml(REVERSE_CHARGE_LABEL)}</cbc:TaxExemptionReason>`
    : "";
  const taxSubtotals = pricingLines.map((line: any) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price || 0) * sign)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.vatAmount ?? (Number(line.price || 0) * Number(line.vatRate || 0)) / 100) * sign)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${taxCategoryId}</cbc:ID>
        <cbc:Percent>${toMoney(reverseCharge ? 0 : (line.vatRate ?? booking.payment?.vatRate ?? 0))}</cbc:Percent>
        ${taxCategoryExtras}
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join("");

  const professionalParty = {
    name: professional.businessInfo?.companyName || professional.name || "Supplier",
    vatNumber: professional.vatNumber || professional.businessInfo?.vatNumber || "",
    peppolParticipantId: toBelgianPeppolParticipantId(
      professional.vatNumber || professional.businessInfo?.vatNumber,
      professional.businessInfo?.country,
    ),
    street: professional.businessInfo?.address,
    city: professional.businessInfo?.city,
    postalCode: professional.businessInfo?.postalCode,
    country: professional.businessInfo?.country,
  };
  const customerParty = {
    name: customer.businessName || customer.name || "Customer",
    vatNumber: customer.vatNumber || "",
    country: booking.vatDecision?.country || customer.companyAddress?.country || customer.location?.country,
    peppolParticipantId: toBelgianPeppolParticipantId(
      customer.vatNumber,
      booking.vatDecision?.country || customer.companyAddress?.country || customer.location?.country,
    ),
    street: customer.companyAddress?.address || customer.location?.address,
    city: customer.companyAddress?.city || customer.location?.city,
    postalCode: customer.companyAddress?.postalCode || customer.location?.postalCode,
  };
  const platformParty = {
    name: platform.name || "Fixtract",
    vatNumber: platform.vatNumber || "",
    peppolParticipantId:
      platform.peppolParticipantId ||
      toBelgianPeppolParticipantId(platform.vatNumber, platform.country),
    street: platform.street,
    city: platform.city,
    postalCode: platform.postalCode,
    country: platform.country,
  };

  const selfBilling = options?.selfBilling !== false;
  const supplier = selfBilling ? professionalParty : platformParty;
  const buyer = selfBilling ? platformParty : customerParty;

  return {
    supplierParty: ublPartyXml("AccountingSupplierParty", supplier),
    customerParty: ublPartyXml("AccountingCustomerParty", buyer),
    taxTotal: `<cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.vatAmount ?? booking.payment?.vatAmount ?? 0) * sign)}</cbc:TaxAmount>
    ${taxSubtotals}
  </cac:TaxTotal>`,
    monetaryTotal: `<cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.netAmount ?? booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.netAmount ?? booking.payment?.netAmount ?? booking.payment?.amount) * sign)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.totalWithVat ?? booking.payment?.totalWithVat) * sign)}</cbc:TaxInclusiveAmount>
    ${paidAmount > 0 ? `<cbc:PrepaidAmount currencyID="${escapeXml(currency)}">${toMoney(paidAmount * sign)}</cbc:PrepaidAmount>` : ""}
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${toMoney((invoiceTotal - paidAmount) * sign)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`,
    taxCategoryId,
  };
};

export const buildUblCreditNoteXml = (
  booking: any,
  creditNoteNumber: string,
  issuedAt: Date,
  options?: { relatedInvoiceNumber?: string; platform?: UblPlatformParty; selfBilling?: boolean }
): string => {
  const currency = booking.payment?.currency || "EUR";
  const sign = -1;
  const selfBilling = options?.selfBilling === true;
  const platform = options?.platform || {};
  const pricing = getPricingLinesForUbl(booking, { selfBilling, platform });
  const pricingLines = pricing.lines;
  const reverseCharge = pricing.totals.reverseCharge;
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge, {
    selfBilling,
    platform: options?.platform,
  }, pricing.totals);
  const creditNoteLines = pricingLines.map((line: any, index: number) => `
    <cac:CreditNoteLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:CreditedQuantity unitCode="${escapeXml(mapUnitToUneceCode(line.unit))}">${toQuantity(Number(line.quantity || 1))}</cbc:CreditedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${parties.taxCategoryId}</cbc:ID>
          <cbc:Percent>${toMoney(reverseCharge ? 0 : (line.vatRate ?? booking.payment?.vatRate ?? 0))}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toUnitPrice(Number(line.unitPrice ?? line.price) * sign)}</cbc:PriceAmount>
      </cac:Price>
    </cac:CreditNoteLine>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${selfBilling ? SELF_BILLING_CUSTOMIZATION_ID : COMMERCIAL_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${selfBilling ? SELF_BILLING_PROFILE_ID : COMMERCIAL_PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${escapeXml(creditNoteNumber)}</cbc:ID>
  <cbc:IssueDate>${issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  ${selfBilling ? `<cbc:Note>${escapeXml(SELF_BILLING_NOTE)}</cbc:Note>` : ""}
  ${reverseCharge ? `<cbc:Note>${escapeXml(REVERSE_CHARGE_LABEL)}</cbc:Note>` : ""}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  ${parties.supplierParty}
  ${parties.customerParty}
  ${parties.taxTotal}
  ${parties.monetaryTotal}${creditNoteLines}
</CreditNote>`;
};

export const buildUblInvoiceXml = (
  booking: any,
  invoiceNumber: string,
  issuedAt: Date,
  options?: {
    creditNote?: boolean;
    relatedInvoiceNumber?: string;
    selfBilling?: boolean;
    platform?: UblPlatformParty;
  }
): string => {
  if (options?.creditNote) {
    return buildUblCreditNoteXml(booking, invoiceNumber, issuedAt, {
      relatedInvoiceNumber: options.relatedInvoiceNumber,
      platform: options.platform,
      selfBilling: options.selfBilling,
    });
  }

  const currency = booking.payment?.currency || "EUR";
  const sign = 1;
  const selfBilling = options?.selfBilling !== false;
  const invoiceTypeCode = selfBilling ? "389" : "380";
  const pricing = getPricingLinesForUbl(booking, { selfBilling, platform: options?.platform || {} });
  const pricingLines = pricing.lines;
  const reverseCharge = pricing.totals.reverseCharge;
  // Partial refunds are billed net of the refund; the note carries the refund
  // date, amount, reason and description on both the FIX and the SUP document.
  const refundNote = describeRefundForUbl(booking, currency);
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge, {
    selfBilling,
    platform: options?.platform,
    // Paid through Stripe: only the rest is left to transfer.
    paidAmount: getInvoicePayment(booking, selfBilling ? "supplier" : "customer", pricing.totals.totalWithVat).paidAmount,
  }, pricing.totals);
  const invoiceLines = pricingLines.map((line: any, index: number) => `
    <cac:InvoiceLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${escapeXml(mapUnitToUneceCode(line.unit))}">${toQuantity(Number(line.quantity || 1))}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.price) * sign)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Description>${escapeXml(line.description)}</cbc:Description>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${parties.taxCategoryId}</cbc:ID>
          <cbc:Percent>${toMoney(reverseCharge ? 0 : (line.vatRate ?? booking.payment?.vatRate ?? 0))}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toUnitPrice(Number(line.unitPrice ?? line.price) * sign)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${selfBilling ? SELF_BILLING_CUSTOMIZATION_ID : COMMERCIAL_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${selfBilling ? SELF_BILLING_PROFILE_ID : COMMERCIAL_PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${escapeXml(invoiceNumber)}</cbc:ID>
  <cbc:IssueDate>${issuedAt.toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${invoiceTypeCode}</cbc:InvoiceTypeCode>
  ${selfBilling ? `<cbc:Note>${escapeXml(SELF_BILLING_NOTE)}</cbc:Note>` : ""}
  ${reverseCharge ? `<cbc:Note>${escapeXml(REVERSE_CHARGE_LABEL)}</cbc:Note>` : ""}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${escapeXml(booking.bookingNumber || booking._id?.toString?.())}</cbc:BuyerReference>
  ${options?.relatedInvoiceNumber ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(options.relatedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
  ${parties.supplierParty}
  ${parties.customerParty}
  ${parties.taxTotal}
  ${parties.monetaryTotal}${invoiceLines}
</Invoice>`;
};

/**
 * Attach the service configuration's pricing options to a booking so unit
 * resolution works on paths that never call generateBookingInvoice (Peppol
 * retries, supplier-only generation). Without this the UBL builder falls back
 * to C62 for unit-priced services.
 */
const hydrateServiceConfigPricingOptions = async (booking: any) => {
  if (!booking || Array.isArray(booking.__serviceConfigPricingOptions)) return booking;
  try {
    const configId = booking.project?.serviceConfigurationId || booking.serviceConfigurationId;
    const category = booking.project?.category;
    const service = booking.project?.service;
    const config = configId
      ? await ServiceConfiguration.findById(configId).select("pricingOptions").lean()
      : category && service
        ? await ServiceConfiguration.findOne({ category, service }).select("pricingOptions").lean()
        : null;
    if (Array.isArray((config as any)?.pricingOptions)) {
      booking.__serviceConfigPricingOptions = (config as any).pricingOptions;
    }
  } catch {
    // best-effort; callers fall back to C62 when the config is unavailable
  }
  return booking;
};

const loadBookingForInvoice = async (bookingId: string) => {
  const booking = await Booking.findById(bookingId)
    .select("+paymentDiscountLedger +payment.invoiceSettlementBasis +payment.refundCreditLedger")
    .populate("customer")
    .populate("professional")
    .populate(
      "project",
      "title extraOptions subprojects category service areaOfWork serviceConfigurationId vatProfessionalAnswers",
    );
  await hydrateServiceConfigPricingOptions(booking);
  await hydrateSupplierVatDecision(booking);
  if (booking) {
    const quote = getCurrentQuote(booking);
    (booking as any).__commissionPercent = Number(quote?.customerTotals?.commissionPercent) || 0;
    if (booking.milestonePayments?.length || booking.payment?.status === "partially_refunded") {
      (booking as any).__settledPayments = await Payment.find({
        booking: booking._id, status: { $in: ["completed", "partially_refunded", "refunded"] },
      }).lean();
    }
  }
  return booking;
};

/**
 * Resolve the supplier self-bill VAT once per loaded booking using the service
 * configuration's reduced-rate rules, and cache it for the sync UBL builder.
 * Falls back silently to the country standard rate when the config/platform
 * context is unavailable (never blocks invoice generation).
 */
const hydrateSupplierVatDecision = async (booking: any) => {
  if (!booking || booking.__supplierVatDecision) return booking;
  try {
    const settings = await PlatformSettings.getCurrentConfig();
    const professionalAnswers = (booking.project?.vatProfessionalAnswers || []).reduce(
      (acc: Record<string, unknown>, answer: { fieldName?: string; value?: unknown }) => {
        if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
        return acc;
      },
      {},
    );
    const customerAnswers = (booking.vatDecision?.answers || []).reduce(
      (acc: Record<string, unknown>, answer: { fieldName?: string; value?: unknown }) => {
        if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
        return acc;
      },
      {},
    );
    booking.__supplierVatDecision = await resolveSupplierInvoiceVatDecision({
      serviceConfigurationId: booking.project?.serviceConfigurationId || booking.serviceConfigurationId,
      category: booking.project?.category,
      service: booking.project?.service,
      areaOfWork: booking.project?.areaOfWork,
      supplierCountry: booking.professional?.businessInfo?.country || booking.professional?.location?.country,
      buyerCountry: settings.companyAddress?.country,
      supplierVatNumber: booking.professional?.businessInfo?.vatNumber || booking.professional?.vatNumber,
      buyerVatNumber: settings.companyVatNumber,
      buyerVatVerified: true,
      bookingCountry: booking.vatDecision?.country || booking.location?.country,
      propertyNature: booking.vatDecision?.propertyNature,
      exemptFromBelgianReverseCharge: booking.vatDecision?.exemptFromBelgianReverseCharge,
      answers: customerAnswers,
      professionalAnswers,
    });
  } catch {
    // best-effort; getSupplierVatContext falls back to the standard-rate path
  }
  return booking;
};

const getPlatformParty = async (): Promise<UblPlatformParty> => {
  const settings = await PlatformSettings.getCurrentConfig();
  return {
    name: settings.companyAddress?.name || "Fixtract",
    vatNumber: settings.companyVatNumber,
    peppolParticipantId: settings.eInvoicing?.peppolParticipantId,
    street: settings.companyAddress?.street,
    city: settings.companyAddress?.city,
    postalCode: settings.companyAddress?.postalCode,
    country: settings.companyAddress?.country,
  };
};

const notifyInvoiceReady = async (
  booking: any,
  update: InvoiceArtifactResult,
  attachments?: { customerInvoicePdf?: Buffer; supplierInvoicePdf?: Buffer },
) => {
  const customerId = booking.customer?._id?.toString?.() || booking.customer?.toString?.();
  const professionalId = booking.professional?._id?.toString?.() || booking.professional?.toString?.();
  const bookingId = booking._id?.toString?.() || "";
  try {
    if (customerId && update.invoiceUrl) {
      const invoiceUrl = (await presignS3Url(update.invoiceUrl)) || update.invoiceUrl;
      const attachmentContent = attachments?.customerInvoicePdf
        ? attachments.customerInvoicePdf.toString("base64")
        : await inlineInvoiceAttachment(update.invoiceUrl);
      await notify({
        userId: customerId,
        eventKey: "customer.invoice_ready",
        entityType: "booking",
        entityId: bookingId,
        // Stable key so retries only re-send when the previous attempt failed
        // (DeliveryClaim marks the inbox row emailSent once delivered).
        idempotencyKey: `invoice-ready:${bookingId}:customer`,
        context: {
          bookingId,
          invoiceNumber: update.invoiceNumber,
          invoiceUrl,
          ...(attachmentContent ? { invoiceAttachmentContent: attachmentContent } : {}),
        },
      });
    }
    if (professionalId && update.supplierInvoiceUrl) {
      const supplierInvoiceUrl = (await presignS3Url(update.supplierInvoiceUrl)) || update.supplierInvoiceUrl;
      const attachmentContent = attachments?.supplierInvoicePdf
        ? attachments.supplierInvoicePdf.toString("base64")
        : await inlineInvoiceAttachment(update.supplierInvoiceUrl);
      await notify({
        userId: professionalId,
        eventKey: "professional.invoice_ready",
        entityType: "booking",
        entityId: bookingId,
        idempotencyKey: `invoice-ready:${bookingId}:supplier`,
        context: {
          bookingId,
          invoiceNumber: update.supplierInvoiceNumber,
          invoiceUrl: supplierInvoiceUrl,
          ...(attachmentContent ? { invoiceAttachmentContent: attachmentContent } : {}),
        },
      });
    }
  } catch (error) {
    console.error(
      `[INVOICE] Failed to email invoice links for booking ${bookingId}:`,
      error instanceof Error ? error.message : error
    );
  }
};

/**
 * Re-read an already-issued PDF from S3 so a notification retry can attach the
 * bytes directly instead of asking the email provider to fetch a private URL.
 */
const inlineInvoiceAttachment = async (s3Url: string): Promise<string | undefined> => {
  try {
    const buffer = await downloadBufferFromS3(s3Url);
    return buffer ? buffer.toString("base64") : undefined;
  } catch {
    return undefined;
  }
};

const retryPeppolForExistingArtifacts = async (
  bookingId: string,
  paymentId: string | undefined,
  existing: any,
): Promise<InvoiceArtifactResult> => {
  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment?.status) return toInvoiceArtifactResult(existing.payment);
  const update: InvoiceArtifactResult = toInvoiceArtifactResult(existing.payment);
  let platform: UblPlatformParty | undefined;
  try {
    platform = await getPlatformParty();
  } catch (error) {
    console.error(`[INVOICE] Platform invoice party could not be loaded for booking ${bookingId}:`, providerErrorMessage(error));
    if (existing.payment.peppolDispatchStatus !== "sent") {
      update.peppolDispatchStatus = "failed";
      update.peppolDispatchReason = PEPPOL_PLATFORM_CONFIG_REASON;
    }
    if (existing.payment.supplierPeppolDispatchStatus !== "sent") {
      update.supplierPeppolDispatchStatus = "failed";
      update.supplierPeppolDispatchReason = PEPPOL_PLATFORM_CONFIG_REASON;
    }
    await persistPaymentArtifactUpdate(bookingId, paymentId, {
      peppolDispatchStatus: update.peppolDispatchStatus,
      peppolDispatchReason: update.peppolDispatchReason,
      supplierPeppolDispatchStatus: update.supplierPeppolDispatchStatus,
      supplierPeppolDispatchReason: update.supplierPeppolDispatchReason,
    });
    return update;
  }

  if (existing.payment.peppolDispatchStatus !== "sent") {
    try {
      const customerUblXml = buildUblInvoiceXml(
        booking,
        existing.payment.invoiceNumber,
        existing.payment.invoiceGeneratedAt || new Date(),
        {
          selfBilling: false,
          platform,
        },
      );
      const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: existing.payment.invoiceNumber,
        ublXml: customerUblXml,
        invoiceUblUrl: existing.payment.invoiceUblUrl,
        invoicePdfUrl: existing.payment.invoiceUrl,
        issueDate: existing.payment.invoiceGeneratedAt,
        netAmount: customerPricing.totals.netAmount,
        totalWithVat: customerPricing.totals.totalWithVat,
        vatRate: customerPricing.totals.vatRate,
        reverseCharge: customerPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      Object.assign(update, {
        peppolDispatchStatus: result.status,
        peppolDispatchReason: result.reason,
        peppolDispatchReference: result.reference,
      });
    } catch (error) {
      console.error(`[INVOICE] Customer Peppol dispatch failed for booking ${bookingId}:`, providerErrorMessage(error));
      Object.assign(update, {
        peppolDispatchStatus: "failed",
        peppolDispatchReason: dispatchFailureReason(error),
      });
    }
  }

  if (existing.payment.supplierPeppolDispatchStatus !== "sent") {
    try {
      const supplierUblXml = buildUblInvoiceXml(
        booking,
        existing.payment.supplierInvoiceNumber,
        existing.payment.supplierInvoiceGeneratedAt || new Date(),
        {
          selfBilling: true,
          platform,
        },
      );
      const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "supplier",
        invoiceNumber: existing.payment.supplierInvoiceNumber,
        ublXml: supplierUblXml,
        invoiceUblUrl: existing.payment.supplierInvoiceUblUrl,
        invoicePdfUrl: existing.payment.supplierInvoiceUrl,
        issueDate: existing.payment.supplierInvoiceGeneratedAt,
        netAmount: supplierPricing.totals.netAmount,
        totalWithVat: supplierPricing.totals.totalWithVat,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      Object.assign(update, {
        supplierPeppolDispatchStatus: result.status,
        supplierPeppolDispatchReason: result.reason,
        supplierPeppolDispatchReference: result.reference,
      });
    } catch (error) {
      console.error(`[INVOICE] Supplier Peppol dispatch failed for booking ${bookingId}:`, providerErrorMessage(error));
      Object.assign(update, {
        supplierPeppolDispatchStatus: "failed",
        supplierPeppolDispatchReason: dispatchFailureReason(error),
      });
    }
  }

  await Booking.updateOne(
    { _id: bookingId },
    { $set: {
      "payment.peppolDispatchStatus": update.peppolDispatchStatus,
      "payment.peppolDispatchReason": update.peppolDispatchReason,
      "payment.peppolDispatchReference": update.peppolDispatchReference,
      "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
      "payment.supplierPeppolDispatchReason": update.supplierPeppolDispatchReason,
      "payment.supplierPeppolDispatchReference": update.supplierPeppolDispatchReference,
    } },
  );
  await persistPaymentArtifactUpdate(bookingId, paymentId, {
    peppolDispatchStatus: update.peppolDispatchStatus,
    peppolDispatchReason: update.peppolDispatchReason,
    peppolDispatchReference: update.peppolDispatchReference,
    supplierPeppolDispatchStatus: update.supplierPeppolDispatchStatus,
    supplierPeppolDispatchReason: update.supplierPeppolDispatchReason,
    supplierPeppolDispatchReference: update.supplierPeppolDispatchReference,
  });
  // Re-attempt invoice-ready emails for already-issued artifacts. The stable
  // idempotency key makes this a no-op once delivery succeeded, but recovers
  // bookings whose original notification failed after the PDF was stored.
  await notifyInvoiceReady(booking, update);
  return update;
};

/**
 * Legacy bookings can already carry an issued customer (FIX-) invoice without a
 * supplier self-bill invoice. Generate only the missing supplier side and leave
 * every customer-facing field untouched.
 */
const generateMissingSupplierInvoiceArtifacts = async (
  bookingId: string,
  paymentId: string | undefined,
  existing: any,
): Promise<InvoiceArtifactResult> => {
  // Reserve the generation atomically with an owner-bound token: concurrent
  // callers must not reserve a second SUP- number, overwrite each other's
  // artifacts, or submit duplicate self-bills. A losing caller returns the
  // existing artifact state as-is.
  const claimToken = await claimSupplierInvoiceGeneration(bookingId);
  if (!claimToken) return toInvoiceArtifactResult(existing.payment);

  try {
    return await generateSupplierInvoiceArtifactsWithClaim(bookingId, paymentId, existing);
  } finally {
    await releaseSupplierInvoiceGenerationClaim(bookingId, claimToken);
  }
};

const generateSupplierInvoiceArtifactsWithClaim = async (
  bookingId: string,
  paymentId: string | undefined,
  existing: any,
): Promise<InvoiceArtifactResult> => {
  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment?.status) return toInvoiceArtifactResult(existing.payment);

  const platform = await getPlatformParty();
  const generatedAt = new Date();
  const supplierInvoice = await generateBookingInvoice(booking as any, { kind: "self_bill" });
  const supplierKey = `invoices/${booking._id.toString()}/${supplierInvoice.invoiceNumber}`;
  const supplierInvoiceUrl = await uploadBufferToS3(
    supplierInvoice.pdfBuffer,
    `${supplierKey}.pdf`,
    "application/pdf",
    `inline; filename="${supplierInvoice.invoiceNumber}.pdf"`
  );
  const supplierUblXml = buildUblInvoiceXml(booking, supplierInvoice.invoiceNumber, generatedAt, {
    selfBilling: true,
    platform,
  });
  const supplierInvoiceUblUrl = await uploadBufferToS3(
    Buffer.from(supplierUblXml, "utf8"),
    `${supplierKey}.xml`,
    "application/xml",
    `attachment; filename="${supplierInvoice.invoiceNumber}.xml"`
  );

  const update: InvoiceArtifactResult = toInvoiceArtifactResult(existing.payment);
  const invoiceSettlementBasis = { ...booking.payment.invoiceSettlementBasis,
    supplier: recordedInvoiceSettlementBasis(booking, platform).supplier };
  update.supplierInvoiceNumber = supplierInvoice.invoiceNumber;
  update.supplierInvoiceUrl = supplierInvoiceUrl;
  update.supplierInvoiceUblUrl = supplierInvoiceUblUrl;
  update.supplierInvoiceGeneratedAt = generatedAt;
  update.supplierPeppolDispatchStatus = "queued";
  update.supplierPeppolDispatchReason = PEPPOL_DISPATCH_IN_PROGRESS;

  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        "payment.invoiceSettlementBasis": invoiceSettlementBasis,
        "payment.supplierInvoiceNumber": update.supplierInvoiceNumber,
        "payment.supplierInvoiceUrl": update.supplierInvoiceUrl,
        "payment.supplierInvoiceUblUrl": update.supplierInvoiceUblUrl,
        "payment.supplierInvoiceGeneratedAt": update.supplierInvoiceGeneratedAt,
        "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
        "payment.supplierPeppolDispatchReason": update.supplierPeppolDispatchReason,
      },
    }
  );
  await persistPaymentArtifactUpdate(booking._id, paymentId, {
    invoiceSettlementBasis,
    supplierInvoiceNumber: update.supplierInvoiceNumber,
    supplierInvoiceUrl: update.supplierInvoiceUrl,
    supplierInvoiceUblUrl: update.supplierInvoiceUblUrl,
    supplierInvoiceGeneratedAt: update.supplierInvoiceGeneratedAt,
    supplierPeppolDispatchStatus: update.supplierPeppolDispatchStatus,
    supplierPeppolDispatchReason: update.supplierPeppolDispatchReason,
  });

  try {
    const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
    const supplierPeppolResult = await maybeDispatchPeppolInvoice({
      booking,
      side: "supplier",
      invoiceNumber: supplierInvoice.invoiceNumber,
      ublXml: supplierUblXml,
      invoiceUblUrl: supplierInvoiceUblUrl,
      invoicePdf: supplierInvoice.pdfBuffer,
      issueDate: generatedAt,
      netAmount: supplierPricing.totals.netAmount,
      totalWithVat: supplierPricing.totals.totalWithVat,
      vatRate: supplierPricing.totals.vatRate,
      reverseCharge: supplierPricing.totals.reverseCharge,
      lineItems: getPeppolLineItems(supplierPricing),
    });
    update.supplierPeppolDispatchStatus = supplierPeppolResult.status;
    update.supplierPeppolDispatchReason = supplierPeppolResult.reason;
    update.supplierPeppolDispatchReference = supplierPeppolResult.reference;
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.supplierPeppolDispatchStatus": supplierPeppolResult.status,
          "payment.supplierPeppolDispatchReason": supplierPeppolResult.reason,
          "payment.supplierPeppolDispatchReference": supplierPeppolResult.reference,
          "payment.supplierPeppolDispatchedAt": supplierPeppolResult.dispatchedAt,
        },
      },
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, {
      supplierPeppolDispatchStatus: supplierPeppolResult.status,
      supplierPeppolDispatchReason: supplierPeppolResult.reason,
      supplierPeppolDispatchReference: supplierPeppolResult.reference,
      supplierPeppolDispatchedAt: supplierPeppolResult.dispatchedAt,
    });
  } catch (supplierPeppolError) {
    console.error(
      `[INVOICE] Supplier Peppol dispatch failed for booking ${bookingId}:`,
      providerErrorMessage(supplierPeppolError),
    );
    update.supplierPeppolDispatchStatus = "failed";
    update.supplierPeppolDispatchReason = dispatchFailureReason(supplierPeppolError);
    await Booking.updateOne(
      { _id: booking._id },
      { $set: {
        "payment.supplierPeppolDispatchStatus": "failed",
        "payment.supplierPeppolDispatchReason": dispatchFailureReason(supplierPeppolError),
      } },
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, {
      supplierPeppolDispatchStatus: "failed",
      supplierPeppolDispatchReason: dispatchFailureReason(supplierPeppolError),
    });
  }

  await notifyInvoiceReady(booking, update);
  return update;
};

export async function ensureBookingInvoiceArtifacts(
  bookingId: string,
  paymentId?: string
): Promise<InvoiceArtifactResult | null> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment?.status) return null;
  if (hasCustomerInvoiceArtifacts(existing.payment)) {
    // A customer invoice that was already issued must never be cleared or
    // renumbered. When the supplier side is missing (e.g. bookings invoiced
    // before self-billing existed), generate only the missing supplier side.
    if (hasSupplierInvoiceArtifacts(existing.payment)) {
      return retryPeppolForExistingArtifacts(bookingId, paymentId, existing);
    }
    return generateMissingSupplierInvoiceArtifacts(bookingId, paymentId, existing);
  }

  const invoiceNumber = existing.payment.invoiceNumber;
  if (
    invoiceNumber &&
    !String(invoiceNumber).startsWith("GENERATING-")
  ) {
    await clearLegacyInvoiceFields(bookingId);
  }

  const claimed = await claimInvoiceGeneration(bookingId);
  if (!claimed) {
    const refreshed = await Booking.findById(bookingId);
    if (refreshed?.payment && hasInvoiceArtifacts(refreshed.payment)) {
      return toInvoiceArtifactResult(refreshed.payment);
    }
    return null;
  }

  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment?.status) {
      await clearInvoiceGenerationClaim(bookingId);
      return null;
    }

    const platform = await getPlatformParty();
    const generatedAt = new Date();
    const customerInvoice = await generateBookingInvoice(booking as any, { kind: "customer" });
    const supplierInvoice = await generateBookingInvoice(booking as any, { kind: "self_bill" });

    const customerKey = `invoices/${booking._id.toString()}/${customerInvoice.invoiceNumber}`;
    const supplierKey = `invoices/${booking._id.toString()}/${supplierInvoice.invoiceNumber}`;
    const invoiceUrl = await uploadBufferToS3(
      customerInvoice.pdfBuffer,
      `${customerKey}.pdf`,
      "application/pdf",
      `inline; filename="${customerInvoice.invoiceNumber}.pdf"`
    );
    const supplierInvoiceUrl = await uploadBufferToS3(
      supplierInvoice.pdfBuffer,
      `${supplierKey}.pdf`,
      "application/pdf",
      `inline; filename="${supplierInvoice.invoiceNumber}.pdf"`
    );
    const customerUblXml = buildUblInvoiceXml(booking, customerInvoice.invoiceNumber, generatedAt, {
      selfBilling: false,
      platform,
    });
    const supplierUblXml = buildUblInvoiceXml(booking, supplierInvoice.invoiceNumber, generatedAt, {
      selfBilling: true,
      platform,
    });
    const invoiceUblUrl = await uploadBufferToS3(
      Buffer.from(customerUblXml, "utf8"),
      `${customerKey}.xml`,
      "application/xml",
      `attachment; filename="${customerInvoice.invoiceNumber}.xml"`
    );
    const supplierInvoiceUblUrl = await uploadBufferToS3(
      Buffer.from(supplierUblXml, "utf8"),
      `${supplierKey}.xml`,
      "application/xml",
      `attachment; filename="${supplierInvoice.invoiceNumber}.xml"`
    );

    const invoiceSettlementBasis = recordedInvoiceSettlementBasis(booking, platform);
    const update: InvoiceArtifactResult = {
      invoiceNumber: customerInvoice.invoiceNumber,
      invoiceUrl,
      invoiceUblUrl,
      invoiceGeneratedAt: generatedAt,
      supplierInvoiceNumber: supplierInvoice.invoiceNumber,
      supplierInvoiceUrl,
      supplierInvoiceUblUrl,
      supplierInvoiceGeneratedAt: generatedAt,
      // Stays like this only if the dispatch below never finished; "skipped"
      // here used to read as a deliberate skip with no reason.
      peppolDispatchStatus: "queued",
      peppolDispatchReason: PEPPOL_DISPATCH_IN_PROGRESS,
      supplierPeppolDispatchStatus: "queued",
      supplierPeppolDispatchReason: PEPPOL_DISPATCH_IN_PROGRESS,
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.invoiceSettlementBasis": invoiceSettlementBasis,
          "payment.invoiceNumber": update.invoiceNumber,
          "payment.invoiceUrl": update.invoiceUrl,
          "payment.invoiceUblUrl": update.invoiceUblUrl,
          "payment.invoiceGeneratedAt": update.invoiceGeneratedAt,
          "payment.supplierInvoiceNumber": update.supplierInvoiceNumber,
          "payment.supplierInvoiceUrl": update.supplierInvoiceUrl,
          "payment.supplierInvoiceUblUrl": update.supplierInvoiceUblUrl,
          "payment.supplierInvoiceGeneratedAt": update.supplierInvoiceGeneratedAt,
          "payment.peppolDispatchStatus": update.peppolDispatchStatus,
          "payment.peppolDispatchReason": update.peppolDispatchReason,
          "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
          "payment.supplierPeppolDispatchReason": update.supplierPeppolDispatchReason,
        },
      }
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, { ...update, invoiceSettlementBasis });

    try {
      const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
      const peppolResult = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: customerInvoice.invoiceNumber,
        ublXml: customerUblXml,
        invoiceUblUrl,
        invoicePdf: customerInvoice.pdfBuffer,
        issueDate: generatedAt,
        netAmount: customerPricing.totals.netAmount,
        totalWithVat: customerPricing.totals.totalWithVat,
        vatRate: customerPricing.totals.vatRate,
        reverseCharge: customerPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      update.peppolDispatchStatus = peppolResult.status;
      update.peppolDispatchReason = peppolResult.reason;
      update.peppolDispatchReference = peppolResult.reference;
      await Booking.updateOne(
        { _id: booking._id },
        {
          $set: {
            "payment.peppolDispatchStatus": peppolResult.status,
            "payment.peppolDispatchReason": peppolResult.reason,
            "payment.peppolDispatchReference": peppolResult.reference,
            "payment.peppolDispatchedAt": peppolResult.dispatchedAt,
          },
        }
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        peppolDispatchStatus: peppolResult.status,
        peppolDispatchReason: peppolResult.reason,
        peppolDispatchReference: peppolResult.reference,
        peppolDispatchedAt: peppolResult.dispatchedAt,
      });
    } catch (peppolError) {
      console.error(
        `[INVOICE] Peppol dispatch failed for booking ${bookingId} after artifacts were saved:`,
        providerErrorMessage(peppolError)
      );
      update.peppolDispatchStatus = "failed";
      update.peppolDispatchReason = dispatchFailureReason(peppolError);
      await Booking.updateOne(
        { _id: booking._id },
        { $set: {
          "payment.peppolDispatchStatus": "failed",
          "payment.peppolDispatchReason": update.peppolDispatchReason,
        } }
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        peppolDispatchStatus: "failed",
        peppolDispatchReason: dispatchFailureReason(peppolError),
      });
    }

    try {
      const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
      const supplierPeppolResult = await maybeDispatchPeppolInvoice({
        booking,
        side: "supplier",
        invoiceNumber: supplierInvoice.invoiceNumber,
        ublXml: supplierUblXml,
        invoiceUblUrl: supplierInvoiceUblUrl,
        invoicePdf: supplierInvoice.pdfBuffer,
        issueDate: generatedAt,
        netAmount: supplierPricing.totals.netAmount,
        totalWithVat: supplierPricing.totals.totalWithVat,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      update.supplierPeppolDispatchStatus = supplierPeppolResult.status;
      update.supplierPeppolDispatchReason = supplierPeppolResult.reason;
      update.supplierPeppolDispatchReference = supplierPeppolResult.reference;
      await Booking.updateOne(
        { _id: booking._id },
        {
          $set: {
            "payment.supplierPeppolDispatchStatus": supplierPeppolResult.status,
            "payment.supplierPeppolDispatchReason": supplierPeppolResult.reason,
            "payment.supplierPeppolDispatchReference": supplierPeppolResult.reference,
            "payment.supplierPeppolDispatchedAt": supplierPeppolResult.dispatchedAt,
          },
        },
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        supplierPeppolDispatchStatus: supplierPeppolResult.status,
        supplierPeppolDispatchReason: supplierPeppolResult.reason,
        supplierPeppolDispatchReference: supplierPeppolResult.reference,
        supplierPeppolDispatchedAt: supplierPeppolResult.dispatchedAt,
      });
    } catch (supplierPeppolError) {
      console.error(
        `[INVOICE] Supplier Peppol dispatch failed for booking ${bookingId}:`,
        providerErrorMessage(supplierPeppolError),
      );
      update.supplierPeppolDispatchStatus = "failed";
      update.supplierPeppolDispatchReason = dispatchFailureReason(supplierPeppolError);
      await Booking.updateOne(
        { _id: booking._id },
        { $set: {
          "payment.supplierPeppolDispatchStatus": "failed",
          "payment.supplierPeppolDispatchReason": dispatchFailureReason(supplierPeppolError),
        } },
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        supplierPeppolDispatchStatus: "failed",
        supplierPeppolDispatchReason: dispatchFailureReason(supplierPeppolError),
      });
    }

    await notifyInvoiceReady(booking, update, {
      customerInvoicePdf: customerInvoice.pdfBuffer,
      supplierInvoicePdf: supplierInvoice.pdfBuffer,
    });
    return update;
  } catch (error) {
    await clearInvoiceGenerationClaim(bookingId);
    throw error;
  }
}

const retryPeppolForExistingCreditArtifacts = async (
  bookingId: string,
  paymentId: string | undefined,
  existing: any,
): Promise<CreditArtifactResult> => {
  const booking = await loadBookingForInvoice(bookingId);
  const update = toCreditArtifactResult(existing.payment);
  if (!booking?.payment?.status) return update;

  let platform: UblPlatformParty | undefined;
  try {
    platform = await getPlatformParty();
  } catch (error) {
    console.error(`[INVOICE] Platform invoice party could not be loaded for credit notes on booking ${bookingId}:`, providerErrorMessage(error));
    if (update.creditNotePeppolDispatchStatus !== "sent") {
      update.creditNotePeppolDispatchStatus = "failed";
      update.creditNotePeppolDispatchReason = PEPPOL_PLATFORM_CONFIG_REASON;
    }
    if (update.supplierCreditNotePeppolDispatchStatus !== "sent") {
      update.supplierCreditNotePeppolDispatchStatus = "failed";
      update.supplierCreditNotePeppolDispatchReason = PEPPOL_PLATFORM_CONFIG_REASON;
    }
  }

  if (platform && update.creditNotePeppolDispatchStatus !== "sent") {
    try {
      if (!existing.payment.creditNoteUblUrl) {
        throw new UserFacingError(502, "Customer credit note UBL artifact is missing. Generate the credit note again.", 'UNAVAILABLE');
      }
      const customerUblXml = buildUblInvoiceXml(
        booking,
        existing.payment.creditNoteNumber,
        existing.payment.creditNoteGeneratedAt || new Date(),
        {
          creditNote: true,
          relatedInvoiceNumber: existing.payment.creditNoteRelatedInvoiceNumber || existing.payment.invoiceNumber,
          selfBilling: false,
          platform,
        },
      );
      const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: existing.payment.creditNoteNumber,
        ublXml: customerUblXml,
        invoiceUblUrl: existing.payment.creditNoteUblUrl,
        invoicePdfUrl: existing.payment.creditNoteUrl,
        issueDate: existing.payment.creditNoteGeneratedAt,
        documentType: "credit_note",
        netAmount: customerPricing.totals.netAmount,
        totalWithVat: customerPricing.totals.totalWithVat,
        vatRate: customerPricing.totals.vatRate,
        reverseCharge: customerPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      update.creditNotePeppolDispatchStatus = result.status;
      update.creditNotePeppolDispatchReason = result.reason;
      update.creditNotePeppolDispatchReference = result.reference;
    } catch (error) {
      console.error(`[INVOICE] Customer credit-note Peppol dispatch failed for booking ${bookingId}:`, providerErrorMessage(error));
      update.creditNotePeppolDispatchStatus = "failed";
      update.creditNotePeppolDispatchReason = dispatchFailureReason(error);
    }
  }

  if (platform && update.supplierCreditNotePeppolDispatchStatus !== "sent") {
    try {
      if (!existing.payment.supplierCreditNoteUblUrl) {
        throw new UserFacingError(502, "Supplier credit note UBL artifact is missing. Generate the credit note again.", 'UNAVAILABLE');
      }
      const supplierUblXml = buildUblInvoiceXml(
        booking,
        existing.payment.supplierCreditNoteNumber,
        existing.payment.supplierCreditNoteGeneratedAt || new Date(),
        {
          creditNote: true,
          relatedInvoiceNumber: existing.payment.supplierCreditNoteRelatedInvoiceNumber || existing.payment.supplierInvoiceNumber,
          selfBilling: true,
          platform,
        },
      );
      const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
      const result = await maybeDispatchPeppolInvoice({
        booking,
        side: "supplier",
        invoiceNumber: existing.payment.supplierCreditNoteNumber,
        ublXml: supplierUblXml,
        invoiceUblUrl: existing.payment.supplierCreditNoteUblUrl,
        invoicePdfUrl: existing.payment.supplierCreditNoteUrl,
        issueDate: existing.payment.supplierCreditNoteGeneratedAt,
        documentType: "credit_note",
        netAmount: supplierPricing.totals.netAmount,
        totalWithVat: supplierPricing.totals.totalWithVat,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      update.supplierCreditNotePeppolDispatchStatus = result.status;
      update.supplierCreditNotePeppolDispatchReason = result.reason;
      update.supplierCreditNotePeppolDispatchReference = result.reference;
    } catch (error) {
      console.error(`[INVOICE] Supplier credit-note Peppol dispatch failed for booking ${bookingId}:`, providerErrorMessage(error));
      update.supplierCreditNotePeppolDispatchStatus = "failed";
      update.supplierCreditNotePeppolDispatchReason = dispatchFailureReason(error);
    }
  }

  const persisted = {
    creditNotePeppolDispatchStatus: update.creditNotePeppolDispatchStatus,
    creditNotePeppolDispatchReason: update.creditNotePeppolDispatchReason,
    creditNotePeppolDispatchReference: update.creditNotePeppolDispatchReference,
    supplierCreditNotePeppolDispatchStatus: update.supplierCreditNotePeppolDispatchStatus,
    supplierCreditNotePeppolDispatchReason: update.supplierCreditNotePeppolDispatchReason,
    supplierCreditNotePeppolDispatchReference: update.supplierCreditNotePeppolDispatchReference,
  };
  await Booking.updateOne({ _id: bookingId }, { $set: Object.fromEntries(Object.entries(persisted).map(([key, value]) => [`payment.${key}`, value])) });
  await persistPaymentArtifactUpdate(bookingId, paymentId, persisted);
  return update;
};

export async function ensureCreditInvoiceArtifacts(
  bookingId: string,
  paymentId?: string
): Promise<CreditArtifactResult | null> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment?.invoiceNumber || String(existing.payment.invoiceNumber).startsWith("GENERATING-")) {
    return null;
  }
  if (hasCreditNoteArtifacts(existing.payment)) {
    return retryPeppolForExistingCreditArtifacts(bookingId, paymentId, existing);
  }

  const claimed = await claimCreditNoteGeneration(bookingId);
  if (!claimed) {
    const refreshed = await Booking.findById(bookingId);
    if (refreshed?.payment && hasCreditNoteArtifacts(refreshed.payment)) {
      return toCreditArtifactResult(refreshed.payment);
    }
    return null;
  }

  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment?.invoiceNumber) {
      await clearCreditNoteGenerationClaim(bookingId);
      return null;
    }

    const relatedInvoiceNumber = booking.payment.invoiceNumber;
    const supplierRelatedInvoiceNumber = booking.payment.supplierInvoiceNumber || relatedInvoiceNumber;
    const generatedAt = new Date();
    const platform = await getPlatformParty();
    const existingCustomerCredit = Boolean(
      booking.payment.creditNoteNumber &&
      booking.payment.creditNoteUrl &&
      !String(booking.payment.creditNoteNumber).startsWith("GENERATING-CN-"),
    );
    const existingSupplierCredit = Boolean(
      booking.payment.supplierCreditNoteNumber && booking.payment.supplierCreditNoteUrl,
    );

    let creditNoteNumber = booking.payment.creditNoteNumber;
    let creditNoteUrl = booking.payment.creditNoteUrl;
    let creditNoteUblUrl = booking.payment.creditNoteUblUrl;
    let customerUblXml: string | undefined;
    if (!existingCustomerCredit) {
      const customerCredit = await generateBookingInvoice(booking as any, {
        creditNote: true,
        relatedInvoiceNumber,
        kind: "customer",
      });
      creditNoteNumber = customerCredit.invoiceNumber;
      const keyBase = `invoices/${booking._id.toString()}/${creditNoteNumber}`;
      creditNoteUrl = await uploadBufferToS3(
        customerCredit.pdfBuffer,
        `${keyBase}.pdf`,
        "application/pdf",
        `inline; filename="${creditNoteNumber}.pdf"`
      );
      customerUblXml = buildUblInvoiceXml(booking, creditNoteNumber, generatedAt, {
        creditNote: true,
        relatedInvoiceNumber,
        selfBilling: false,
        platform,
      });
      creditNoteUblUrl = await uploadBufferToS3(
        Buffer.from(customerUblXml, "utf8"),
        `${keyBase}.xml`,
        "application/xml",
        `attachment; filename="${creditNoteNumber}.xml"`
      );
    }

    let supplierCreditNoteNumber = booking.payment.supplierCreditNoteNumber;
    let supplierCreditNoteUrl = booking.payment.supplierCreditNoteUrl;
    let supplierCreditNoteUblUrl = booking.payment.supplierCreditNoteUblUrl;
    let supplierUblXml: string | undefined;
    if (!existingSupplierCredit) {
      const supplierCredit = await generateBookingInvoice(booking as any, {
        creditNote: true,
        relatedInvoiceNumber: supplierRelatedInvoiceNumber,
        kind: "self_bill",
      });
      supplierCreditNoteNumber = supplierCredit.invoiceNumber;
      const supplierKeyBase = `invoices/${booking._id.toString()}/${supplierCreditNoteNumber}`;
      supplierCreditNoteUrl = await uploadBufferToS3(
        supplierCredit.pdfBuffer,
        `${supplierKeyBase}.pdf`,
        "application/pdf",
        `inline; filename="${supplierCreditNoteNumber}.pdf"`
      );
      supplierUblXml = buildUblInvoiceXml(booking, supplierCreditNoteNumber, generatedAt, {
        creditNote: true,
        relatedInvoiceNumber: supplierRelatedInvoiceNumber,
        selfBilling: true,
        platform,
      });
      supplierCreditNoteUblUrl = await uploadBufferToS3(
        Buffer.from(supplierUblXml, "utf8"),
        `${supplierKeyBase}.xml`,
        "application/xml",
        `attachment; filename="${supplierCreditNoteNumber}.xml"`
      );
    }

    // Persist PDF/UBL before Peppol so a slow Odoo call cannot leave a stuck GENERATING-CN claim.
    const update: CreditArtifactResult = {
      creditNoteNumber: creditNoteNumber!,
      creditNoteUrl: creditNoteUrl!,
      creditNoteUblUrl,
      creditNoteGeneratedAt: generatedAt,
      creditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
      supplierCreditNoteNumber: supplierCreditNoteNumber!,
      supplierCreditNoteUrl: supplierCreditNoteUrl!,
      supplierCreditNoteUblUrl,
      supplierCreditNoteGeneratedAt: generatedAt,
      supplierCreditNoteRelatedInvoiceNumber: supplierRelatedInvoiceNumber,
      creditNotePeppolDispatchStatus: existingCustomerCredit
        ? (booking.payment.creditNotePeppolDispatchStatus || "skipped")
        : "skipped",
      creditNotePeppolDispatchReason: existingCustomerCredit
        ? booking.payment.creditNotePeppolDispatchReason
        : undefined,
      creditNotePeppolDispatchReference: existingCustomerCredit
        ? booking.payment.creditNotePeppolDispatchReference
        : undefined,
      supplierCreditNotePeppolDispatchStatus: existingSupplierCredit
        ? (booking.payment.supplierCreditNotePeppolDispatchStatus || "skipped")
        : "skipped",
      supplierCreditNotePeppolDispatchReason: existingSupplierCredit
        ? booking.payment.supplierCreditNotePeppolDispatchReason
        : undefined,
      supplierCreditNotePeppolDispatchReference: existingSupplierCredit
        ? booking.payment.supplierCreditNotePeppolDispatchReference
        : undefined,
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.creditNoteNumber": update.creditNoteNumber,
          "payment.creditNoteUrl": update.creditNoteUrl,
          "payment.creditNoteUblUrl": update.creditNoteUblUrl,
          "payment.creditNoteGeneratedAt": update.creditNoteGeneratedAt,
          "payment.creditNoteRelatedInvoiceNumber": update.creditNoteRelatedInvoiceNumber,
          "payment.supplierCreditNoteNumber": update.supplierCreditNoteNumber,
          "payment.supplierCreditNoteUrl": update.supplierCreditNoteUrl,
          "payment.supplierCreditNoteUblUrl": update.supplierCreditNoteUblUrl,
          "payment.supplierCreditNoteGeneratedAt": update.supplierCreditNoteGeneratedAt,
          "payment.supplierCreditNoteRelatedInvoiceNumber": update.supplierCreditNoteRelatedInvoiceNumber,
          "payment.creditNotePeppolDispatchStatus": update.creditNotePeppolDispatchStatus,
          "payment.supplierCreditNotePeppolDispatchStatus": update.supplierCreditNotePeppolDispatchStatus,
        },
      }
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, update);

    if (customerUblXml && update.creditNotePeppolDispatchStatus !== "sent") {
      try {
        const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
        const peppolResult = await maybeDispatchPeppolInvoice({
          booking,
          side: "customer",
          invoiceNumber: creditNoteNumber!,
          ublXml: customerUblXml,
          invoiceUblUrl: creditNoteUblUrl!,
          invoicePdfUrl: creditNoteUrl,
          issueDate: generatedAt,
          documentType: "credit_note",
          netAmount: customerPricing.totals.netAmount,
          totalWithVat: customerPricing.totals.totalWithVat,
          vatRate: customerPricing.totals.vatRate,
          reverseCharge: customerPricing.totals.reverseCharge,
          lineItems: getPeppolLineItems(customerPricing),
        });
        update.creditNotePeppolDispatchStatus = peppolResult.status;
        update.creditNotePeppolDispatchReason = peppolResult.reason;
        update.creditNotePeppolDispatchReference = peppolResult.reference;
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: {
              "payment.creditNotePeppolDispatchStatus": peppolResult.status,
              "payment.creditNotePeppolDispatchReason": peppolResult.reason,
              "payment.creditNotePeppolDispatchReference": peppolResult.reference,
            },
          }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          creditNotePeppolDispatchStatus: peppolResult.status,
          creditNotePeppolDispatchReason: peppolResult.reason,
          creditNotePeppolDispatchReference: peppolResult.reference,
        });
      } catch (peppolError) {
        const reason = providerErrorMessage(peppolError);
        console.error(`[INVOICE] Peppol customer credit-note dispatch failed for booking ${bookingId}:`, reason);
        const safeReason = dispatchFailureReason(peppolError);
        update.creditNotePeppolDispatchStatus = "failed";
        update.creditNotePeppolDispatchReason = safeReason;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.creditNotePeppolDispatchStatus": "failed",
            "payment.creditNotePeppolDispatchReason": safeReason,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          creditNotePeppolDispatchStatus: "failed",
          creditNotePeppolDispatchReason: safeReason,
        });
      }
    }

    if (supplierUblXml && update.supplierCreditNotePeppolDispatchStatus !== "sent") {
      try {
        const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
        const supplierPeppolResult = await maybeDispatchPeppolInvoice({
          booking,
          side: "supplier",
          invoiceNumber: supplierCreditNoteNumber!,
          ublXml: supplierUblXml,
          invoiceUblUrl: supplierCreditNoteUblUrl!,
          invoicePdfUrl: supplierCreditNoteUrl,
          issueDate: generatedAt,
          documentType: "credit_note",
          netAmount: supplierPricing.totals.netAmount,
          totalWithVat: supplierPricing.totals.totalWithVat,
          vatRate: supplierPricing.totals.vatRate,
          reverseCharge: supplierPricing.totals.reverseCharge,
          lineItems: getPeppolLineItems(supplierPricing),
        });
        update.supplierCreditNotePeppolDispatchStatus = supplierPeppolResult.status;
        update.supplierCreditNotePeppolDispatchReason = supplierPeppolResult.reason;
        update.supplierCreditNotePeppolDispatchReference = supplierPeppolResult.reference;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.supplierCreditNotePeppolDispatchStatus": supplierPeppolResult.status,
            "payment.supplierCreditNotePeppolDispatchReason": supplierPeppolResult.reason,
            "payment.supplierCreditNotePeppolDispatchReference": supplierPeppolResult.reference,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          supplierCreditNotePeppolDispatchStatus: supplierPeppolResult.status,
          supplierCreditNotePeppolDispatchReason: supplierPeppolResult.reason,
          supplierCreditNotePeppolDispatchReference: supplierPeppolResult.reference,
        });
      } catch (supplierPeppolError) {
        const reason = providerErrorMessage(supplierPeppolError);
        console.error(`[INVOICE] Peppol supplier credit-note dispatch failed for booking ${bookingId}:`, reason);
        const safeReason = dispatchFailureReason(supplierPeppolError);
        update.supplierCreditNotePeppolDispatchStatus = "failed";
        update.supplierCreditNotePeppolDispatchReason = safeReason;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.supplierCreditNotePeppolDispatchStatus": "failed",
            "payment.supplierCreditNotePeppolDispatchReason": safeReason,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          supplierCreditNotePeppolDispatchStatus: "failed",
          supplierCreditNotePeppolDispatchReason: safeReason,
        });
      }
    }

    // Release the generation claim as soon as the artifacts are persisted so a
    // manual correction can immediately trigger a regeneration if needed.
    await clearCreditNoteGenerationClaim(bookingId);

    return {
      creditNoteNumber: creditNoteNumber!,
      creditNoteUrl: creditNoteUrl!,
      creditNoteUblUrl,
      creditNoteGeneratedAt: generatedAt,
      relatedInvoiceNumber,
      supplierCreditNoteNumber,
      supplierCreditNoteUrl,
      supplierCreditNoteUblUrl,
      supplierCreditNoteGeneratedAt: generatedAt,
      supplierCreditNoteRelatedInvoiceNumber: supplierRelatedInvoiceNumber,
      creditNotePeppolDispatchStatus: update.creditNotePeppolDispatchStatus,
      creditNotePeppolDispatchReason: update.creditNotePeppolDispatchReason,
      creditNotePeppolDispatchReference: update.creditNotePeppolDispatchReference,
      supplierCreditNotePeppolDispatchStatus: update.supplierCreditNotePeppolDispatchStatus,
      supplierCreditNotePeppolDispatchReason: update.supplierCreditNotePeppolDispatchReason,
      supplierCreditNotePeppolDispatchReference: update.supplierCreditNotePeppolDispatchReference,
    };
  } catch (error) {
    await clearCreditNoteGenerationClaim(bookingId);
    throw error;
  }
}

const roundCreditMoney = (value: unknown): number =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/** Canonical one-line refund summary shared by the credit lines and UBL notes. */
export const buildPartialRefundDescription = (args: {
  amount: number;
  currency: string;
  date?: Date | string;
  reason?: string;
  description?: string;
}): string => {
  const date = args.date ? new Date(args.date) : undefined;
  const dateLabel = date && !Number.isNaN(date.getTime())
    ? ` on ${date.toISOString().slice(0, 10)}`
    : "";
  const reasonLabel = args.reason ? `: ${args.reason}` : "";
  const descriptionLabel = args.description ? ` — ${args.description}` : "";
  return `Partial refund of ${args.amount.toFixed(2)} ${args.currency}${dateLabel}${reasonLabel}${descriptionLabel}`;
};

/** Manual-correction input for one side of a partial-refund credit note. */
export const buildPartialRefundCreditInput = (args: {
  side: "customer" | "supplier";
  net: number;
  vat: number;
  vatRate: number;
  reverseCharge: boolean;
  currency: string;
  relatedInvoiceNumber: string;
  description: string;
}): ManualInvoiceCorrectionInput => ({
  side: args.side,
  documentType: "credit_note",
  relatedInvoiceNumber: args.relatedInvoiceNumber,
  lines: [{ description: args.description, amount: args.net, vatRate: args.vatRate }],
  payment: {
    netAmount: args.net,
    vatAmount: args.vat,
    vatRate: args.vatRate,
    totalWithVat: roundCreditMoney(args.net + args.vat),
    currency: args.currency,
    reverseCharge: args.reverseCharge,
  },
  exactAmounts: true,
});

const recordedInvoiceSettlementBasis = (booking: any, platform: UblPlatformParty): InvoiceSettlementBasis => {
  const refundAmount = normalizeInvoiceBasis(booking, 0).refund?.amount || 0;
  const side = (selfBilling: boolean) => {
    const totals = getPricingLinesForUbl(booking, { selfBilling, platform }).totals;
    return { netAmount: totals.netAmount, vatAmount: totals.vatAmount, totalWithVat: totals.totalWithVat, refundAmount };
  };
  return { customer: side(false), supplier: side(true) };
};

/**
 * Credit only refunds not yet represented by the issued invoice and credit
 * ledger. Each side has its own durable refund-fact key, so a retry completes
 * a half-finished pair and a later refund creates a new pair. Original
 * artifacts remain in history; coverage and URLs are persisted atomically.
 */
export async function ensurePartialRefundCreditArtifacts(
  bookingId: string,
): Promise<"credited" | "generate" | "skip" | "busy"> {
  await clearStaleGenerationClaimsIfNeeded(bookingId);
  const existing = await Booking.findById(bookingId);
  if (!existing?.payment || existing.payment.status !== "partially_refunded") return "skip";
  if (!(Number(existing.payment.refundAmount) > 0)) return "skip";
  if (!hasCustomerInvoiceArtifacts(existing.payment)) return "generate";
  const claimed = await claimCreditNoteGeneration(bookingId);
  if (!claimed) return "busy";
  try {
    const booking = await loadBookingForInvoice(bookingId);
    if (!booking?.payment || booking.payment.status !== "partially_refunded") return "skip";
    const platform = await getPlatformParty();
    const facts = invoiceRefundFacts(booking);
    const cumulativeRefund = roundCreditMoney(facts.reduce((sum, fact) => sum + fact.amount, 0));
    const key = createHash("sha256").update(facts.map(fact => fact.key).sort().join("|")).digest("hex");
    const current = recordedInvoiceSettlementBasis(booking, platform);
    let issued = booking.payment.invoiceSettlementBasis;
    const ledger = booking.payment.refundCreditLedger || [];
    if (!issued) {
      // Legacy invoices can be reconstructed only from their recorded payments
      // and issue date. Existing credits without coverage metadata need an
      // explicit reconciliation; guessing would issue duplicate money.
      if (hasCustomerCreditArtifacts(booking.payment) || hasSupplierCreditArtifacts(booking.payment)) {
        throw new Error("Existing refund credits lack recorded coverage; reconcile their amounts before issuing another credit.");
      }
      const issuedAt = booking.payment.invoiceGeneratedAt?.getTime?.();
      const included = issuedAt ? roundCreditMoney(facts.filter(fact => fact.refundedAt
        && new Date(fact.refundedAt).getTime() <= issuedAt).reduce((sum, fact) => sum + fact.amount, 0)) : 0;
      const originalBooking = { ...(booking.toObject?.() || booking), __settledPayments: (booking as any).__settledPayments,
        payment: { ...(booking.toObject?.() || booking).payment, refundAmount: included, status: included > 0 ? "partially_refunded" : "completed" } };
      // The durable refund rows remain unchanged. Restrict this historical view
      // to the facts represented at invoice issuance.
      originalBooking.__settledPayments = originalBooking.__settledPayments?.map((payment: any) => ({ ...payment,
        refunds: (payment.refunds || []).filter((fact: any) => issuedAt && new Date(fact.refundedAt).getTime() <= issuedAt) }));
      issued = recordedInvoiceSettlementBasis(originalBooking, platform);
      await Booking.updateOne({ _id: booking._id }, { $set: { "payment.invoiceSettlementBasis": issued } });
    }
    for (const side of ["customer", "supplier"] as const) {
      const original = issued[side];
      const remaining = current[side];
      const relatedInvoiceNumber = side === "customer" ? booking.payment.invoiceNumber : booking.payment.supplierInvoiceNumber;
      if (!original || !remaining || !relatedInvoiceNumber) continue;
      const prior = ledger.filter(fact => fact.side === side);
      const covered = prior.reduce((sum, fact) => sum + fact.refundAmount, 0);
      const delta = roundCreditMoney(cumulativeRefund - original.refundAmount - covered);
      if (delta < 0.01 || prior.some(fact => fact.key === key)) continue;
      // Supplier credits use the VAT and amount on the ISSUED document,
      // never a newly resolved supplier tax setting.
      const refundShare = issued.customer?.totalWithVat
        ? Math.min(1, Math.max(0, (cumulativeRefund - original.refundAmount) / issued.customer.totalWithVat)) : 0;
      const targetNet = side === "supplier" ? roundCreditMoney(original.netAmount * refundShare) : original.netAmount - remaining.netAmount;
      const targetVat = side === "supplier" ? roundCreditMoney(original.vatAmount * refundShare) : original.vatAmount - remaining.vatAmount;
      const net = roundCreditMoney(targetNet - prior.reduce((sum, fact) => sum + fact.netAmount, 0));
      const vat = roundCreditMoney(targetVat - prior.reduce((sum, fact) => sum + fact.vatAmount, 0));
      if (side === "customer" && Math.abs(net + vat - delta) >= 0.005) {
        throw new Error("Refund credit does not reconcile with the outstanding settled refund.");
      }
      if (net + vat < 0.005) continue;
      const currency = booking.payment.currency || "EUR";
      const description = buildPartialRefundDescription({ amount: delta, currency,
        date: booking.payment.refundedAt, reason: booking.payment.refundReason,
        description: booking.cancellation?.adminResolutionNote });
      await createManualInvoiceArtifact(bookingId, undefined, buildPartialRefundCreditInput({
        side, net, vat, vatRate: effectiveVatRateForCredit(net, vat, booking.payment.vatRate),
        reverseCharge: vat === 0 && Boolean(side === "customer" ? booking.payment.reverseCharge : getSupplierVatContext(booking, platform).reverseCharge),
        currency, relatedInvoiceNumber, description,
      }), { key, side, refundAmount: delta, netAmount: net, vatAmount: vat, generationClaim: claimed });
    }
    return "credited";
  } finally {
    await clearCreditNoteGenerationClaim(bookingId, claimed);
  }
}

const applyManualParty = (booking: any, input: ManualInvoiceCorrectionInput): any => {
  const partyBooking = applyManualInvoicePartyOverrides(booking, input);
  return {
    ...(typeof partyBooking.toObject === "function" ? partyBooking.toObject() : partyBooking),
    payment: {
      ...(partyBooking.payment || {}),
      ...input.payment,
      vatBreakdown: input.lines.map((line: ManualInvoiceLine) => ({
        description: line.description,
        netAmount: line.amount,
        vatRate: line.vatRate,
        vatAmount: input.payment.reverseCharge ? 0 : Math.round(line.amount * line.vatRate) / 100,
        vatLabel: line.vatLabel,
      })),
    },
    selectedExtraOptions: [],
    extraCosts: [],
    __manualInvoiceLines: input.lines,
  };
};

const notifyManualArtifactReady = async (
  booking: any,
  input: ManualInvoiceCorrectionInput,
  number: string,
  url: string,
  pdfBuffer?: Buffer,
) => {
  const bookingId = booking._id?.toString?.() || "";
  const eventKey = input.side === "customer" ? "customer.invoice_ready" : "professional.invoice_ready";
  const recipientId = input.side === "customer"
    ? booking.customer?._id?.toString?.()
    : booking.professional?._id?.toString?.();
  if (!recipientId) return;
  const invoiceUrl = (await presignS3Url(url)) || url;
  await notify({
    userId: recipientId,
    eventKey,
    entityType: "booking",
    entityId: bookingId,
    context: {
      bookingId,
      invoiceNumber: number,
      invoiceUrl,
      ...(pdfBuffer ? { invoiceAttachmentContent: pdfBuffer.toString("base64") } : {}),
    },
  });
};

export async function createManualInvoiceArtifact(
  bookingId: string,
  paymentId: string | undefined,
  input: ManualInvoiceCorrectionInput,
  refundFact?: Pick<RefundCreditFact, "key" | "side" | "refundAmount" | "netAmount" | "vatAmount"> & { generationClaim?: string },
): Promise<Record<string, unknown>> {
  const booking = await loadBookingForInvoice(bookingId);
  if (!booking?.payment?.status) throw new Error("Booking payment was not found.");

  const relatedInvoiceNumber = input.relatedInvoiceNumber || (
    input.side === "customer" ? booking.payment.invoiceNumber : booking.payment.supplierInvoiceNumber
  );
  if (input.documentType === "credit_note" && !relatedInvoiceNumber) {
    throw new Error("A related original invoice number is required for a credit note.");
  }

  const manualBooking = applyManualParty(booking, input);
  const generatedAt = new Date();
  const platform = await getPlatformParty();
  const assertCreditClaim = async () => {
    if (!refundFact) return;
    const active = await Booking.findById(bookingId).select('payment.creditNoteGenerationClaim +payment.refundCreditLedger');
    const token = active?.payment?.creditNoteGenerationClaim;
    if (!refundFact.generationClaim || token !== refundFact.generationClaim
      || isStaleGenerationClaim(token, 'GENERATING-CN-')
      || active?.payment?.refundCreditLedger?.some(fact => fact.key === refundFact.key && fact.side === refundFact.side)) {
      throw new Error('Refund credit generation claim expired or was already recorded.');
    }
  };
  // Check after asynchronous setup, before reserving a FIX-CN/SUP-CN number.
  await assertCreditClaim();
  const generated = await generateBookingInvoice(manualBooking as any, {
    kind: input.side === "supplier" ? "self_bill" : "customer",
    creditNote: input.documentType === "credit_note",
    relatedInvoiceNumber,
    manualOverride: input,
    exactManualAmounts: input.exactAmounts,
  });
  const keyBase = `invoices/${booking._id.toString()}/manual/${generated.invoiceNumber}`;
  await assertCreditClaim();
  const artifactUrl = await uploadBufferToS3(
    generated.pdfBuffer,
    `${keyBase}.pdf`,
    "application/pdf",
    `inline; filename="${generated.invoiceNumber}.pdf"`,
  );
  const ublXml = buildUblInvoiceXml(manualBooking, generated.invoiceNumber, generatedAt, {
    creditNote: input.documentType === "credit_note",
    relatedInvoiceNumber,
    selfBilling: input.side === "supplier",
    platform,
  });
  await assertCreditClaim();
  const ublUrl = await uploadBufferToS3(
    Buffer.from(ublXml, "utf8"),
    `${keyBase}.xml`,
    "application/xml",
    `attachment; filename="${generated.invoiceNumber}.xml"`,
  );

  let peppolDispatchStatus = "queued";
  let peppolDispatchReason: string | undefined;
  let peppolDispatchReference: string | undefined;

  const isCustomer = input.side === "customer";
  const isCredit = input.documentType === "credit_note";
  const previousArtifact = isCredit
    ? isCustomer
      ? {
          invoiceNumber: booking.payment.creditNoteNumber,
          invoiceUrl: booking.payment.creditNoteUrl,
          invoiceUblUrl: booking.payment.creditNoteUblUrl,
          generatedAt: booking.payment.creditNoteGeneratedAt,
          relatedInvoiceNumber: booking.payment.creditNoteRelatedInvoiceNumber,
        }
      : {
          invoiceNumber: booking.payment.supplierCreditNoteNumber,
          invoiceUrl: booking.payment.supplierCreditNoteUrl,
          invoiceUblUrl: booking.payment.supplierCreditNoteUblUrl,
          generatedAt: booking.payment.supplierCreditNoteGeneratedAt,
          relatedInvoiceNumber: booking.payment.supplierCreditNoteRelatedInvoiceNumber,
        }
    : isCustomer
      ? {
          invoiceNumber: booking.payment.invoiceNumber,
          invoiceUrl: booking.payment.invoiceUrl,
          invoiceUblUrl: booking.payment.invoiceUblUrl,
          generatedAt: booking.payment.invoiceGeneratedAt,
        }
      : {
          invoiceNumber: booking.payment.supplierInvoiceNumber,
          invoiceUrl: booking.payment.supplierInvoiceUrl,
          invoiceUblUrl: booking.payment.supplierInvoiceUblUrl,
          generatedAt: booking.payment.supplierInvoiceGeneratedAt,
        };
  const historyEntry: InvoiceArtifactHistoryEntry | undefined = previousArtifact.invoiceNumber
    ? {
        side: input.side,
        documentType: input.documentType,
        invoiceNumber: previousArtifact.invoiceNumber,
        invoiceUrl: previousArtifact.invoiceUrl,
        invoiceUblUrl: previousArtifact.invoiceUblUrl,
        generatedAt: previousArtifact.generatedAt,
        relatedInvoiceNumber: previousArtifact.relatedInvoiceNumber,
        replacedAt: generatedAt,
      }
    : undefined;
  const fields = isCredit
    ? isCustomer
      ? {
          creditNoteNumber: generated.invoiceNumber,
          creditNoteUrl: artifactUrl,
          creditNoteUblUrl: ublUrl,
          creditNoteGeneratedAt: generatedAt,
          creditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
          creditNotePeppolDispatchStatus: peppolDispatchStatus,
          creditNotePeppolDispatchReason: peppolDispatchReason,
          creditNotePeppolDispatchReference: peppolDispatchReference,
        }
      : {
          supplierCreditNoteNumber: generated.invoiceNumber,
          supplierCreditNoteUrl: artifactUrl,
          supplierCreditNoteUblUrl: ublUrl,
          supplierCreditNoteGeneratedAt: generatedAt,
          supplierCreditNoteRelatedInvoiceNumber: relatedInvoiceNumber,
          supplierCreditNotePeppolDispatchStatus: peppolDispatchStatus,
          supplierCreditNotePeppolDispatchReason: peppolDispatchReason,
          supplierCreditNotePeppolDispatchReference: peppolDispatchReference,
        }
    : isCustomer
      ? {
          invoiceNumber: generated.invoiceNumber,
          invoiceUrl: artifactUrl,
          invoiceUblUrl: ublUrl,
          invoiceGeneratedAt: generatedAt,
          peppolDispatchStatus,
          peppolDispatchReason,
          peppolDispatchReference,
        }
      : {
          supplierInvoiceNumber: generated.invoiceNumber,
          supplierInvoiceUrl: artifactUrl,
          supplierInvoiceUblUrl: ublUrl,
          supplierInvoiceGeneratedAt: generatedAt,
          supplierPeppolDispatchStatus: peppolDispatchStatus,
          supplierPeppolDispatchReason: peppolDispatchReason,
          supplierPeppolDispatchReference: peppolDispatchReference,
        };

  const bookingUpdate: Record<string, unknown> = {
    $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`payment.${key}`, value])),
  };
  if (historyEntry) bookingUpdate.$push = { "payment.invoiceArtifactHistory": historyEntry };
  const creditFact = refundFact ? {
    key: refundFact.key, side: refundFact.side, refundAmount: refundFact.refundAmount,
    netAmount: refundFact.netAmount, vatAmount: refundFact.vatAmount,
    invoiceNumber: generated.invoiceNumber, invoiceUrl: artifactUrl,
    invoiceUblUrl: ublUrl, generatedAt,
  } : undefined;
  if (creditFact) bookingUpdate.$push = { ...(bookingUpdate.$push as object), "payment.refundCreditLedger": creditFact };
  const artifactFilter: Record<string, unknown> = { _id: booking._id };
  if (refundFact) {
    artifactFilter["payment.creditNoteGenerationClaim"] = refundFact.generationClaim;
    artifactFilter["payment.refundCreditLedger"] = { $not: { $elemMatch: { key: refundFact.key, side: refundFact.side } } };
  }
  const saved = await Booking.updateOne(artifactFilter, bookingUpdate);
  if (refundFact && saved.modifiedCount === 0) throw new Error("Refund credit generation claim expired or was already recorded.");
  await persistPaymentArtifactUpdate(booking._id, paymentId, fields, historyEntry, creditFact);
  try {
    const pricing = getPricingLinesForUbl(manualBooking, {
      selfBilling: input.side === "supplier",
      platform,
    });
    const result = await maybeDispatchPeppolInvoice({
      booking: manualBooking,
      side: input.side,
      invoiceNumber: generated.invoiceNumber,
      ublXml,
      invoiceUblUrl: ublUrl,
      invoicePdf: generated.pdfBuffer,
      issueDate: generatedAt,
      documentType: input.documentType,
      netAmount: pricing.totals.netAmount,
      totalWithVat: pricing.totals.totalWithVat,
      vatRate: pricing.totals.vatRate,
      reverseCharge: pricing.totals.reverseCharge,
      lineItems: getPeppolLineItems(pricing),
    });
    peppolDispatchStatus = result.status;
    peppolDispatchReason = result.reason;
    peppolDispatchReference = result.reference;
  } catch (error) {
    console.error(`[INVOICE] Manual ${input.documentType} Peppol dispatch failed for booking ${bookingId}:`, providerErrorMessage(error));
    peppolDispatchStatus = "failed";
    peppolDispatchReason = dispatchFailureReason(error);
  }

  const dispatchPrefix = isCredit ? (isCustomer ? "creditNote" : "supplierCreditNote") : (isCustomer ? "peppol" : "supplierPeppol");
  const dispatchFields = isCredit ? {
    [`${dispatchPrefix}PeppolDispatchStatus`]: peppolDispatchStatus,
    [`${dispatchPrefix}PeppolDispatchReason`]: peppolDispatchReason,
    [`${dispatchPrefix}PeppolDispatchReference`]: peppolDispatchReference,
  } : {
    [`${dispatchPrefix}DispatchStatus`]: peppolDispatchStatus,
    [`${dispatchPrefix}DispatchReason`]: peppolDispatchReason,
    [`${dispatchPrefix}DispatchReference`]: peppolDispatchReference,
  };
  await Booking.updateOne({ _id: booking._id }, { $set: Object.fromEntries(Object.entries(dispatchFields).map(([key, value]) => [`payment.${key}`, value])) });
  await persistPaymentArtifactUpdate(booking._id, paymentId, dispatchFields);
  try {
    await notifyManualArtifactReady(booking, input, generated.invoiceNumber, artifactUrl, generated.pdfBuffer);
  } catch (notifyError) {
    // The artifact and history entry are already persisted; a notification
    // failure must not make the admin endpoint report the operation as failed.
    console.error(
      `[INVOICE] Manual artifact notification failed for booking ${booking._id}:`,
      notifyError instanceof Error ? notifyError.message : notifyError,
    );
  }
  return {
    side: input.side,
    documentType: input.documentType,
    invoiceNumber: generated.invoiceNumber,
    invoiceUrl: artifactUrl,
    invoiceUblUrl: ublUrl,
    peppolDispatchStatus,
    peppolDispatchReason,
    peppolDispatchReference,
  };
}
