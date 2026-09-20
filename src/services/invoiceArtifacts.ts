import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
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
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  getCustomerExtraCostNet,
  type InvoiceAccountingLine,
} from "../utils/invoiceAccounting";
import {
  generateBookingInvoice,
  applyManualInvoicePartyOverrides,
  type ManualInvoiceLine,
  type ManualInvoiceOverride,
} from "./invoiceGenerator";
import { maybeDispatchPeppolInvoice } from "./peppolDispatch";
import { notify } from "../utils/notifications/notify";
import type { InvoiceArtifactHistoryEntry } from "../Types/invoice";

export const SELF_BILLING_NOTE = "Prepared and sent on behalf of the supplier.";
const SELF_BILLING_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:selfbilling:3.0";
const SELF_BILLING_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:selfbilling:01:1.0";
const COMMERCIAL_CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
const COMMERCIAL_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

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

const hasCreditNoteArtifacts = (payment: any) =>
  Boolean(
    payment?.creditNoteNumber &&
    payment?.creditNoteUrl &&
    !String(payment.creditNoteNumber).startsWith("GENERATING-CN-") &&
    payment?.supplierCreditNoteNumber &&
    payment?.supplierCreditNoteUrl
  );

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

const claimCreditNoteGeneration = async (bookingId: string) =>
  Booking.findOneAndUpdate(
    {
      _id: bookingId,
      "payment.invoiceNumber": { $exists: true, $nin: [null, ""] },
      $or: [
        { "payment.creditNoteGenerationClaim": { $exists: false } },
        { "payment.creditNoteGenerationClaim": null },
        { "payment.creditNoteGenerationClaim": "" },
        { "payment.creditNoteGenerationClaim": /^GENERATING-CN-/ },
      ],
    },
    { $set: { "payment.creditNoteGenerationClaim": `GENERATING-CN-${Date.now()}` } },
    { new: true }
  );

const clearInvoiceGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.invoiceNumber": /^GENERATING-/ },
    { $unset: { "payment.invoiceNumber": "" } }
  );
};

const clearCreditNoteGenerationClaim = async (bookingId: string) => {
  await Booking.updateOne(
    { _id: bookingId, "payment.creditNoteGenerationClaim": /^GENERATING-CN-/ },
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

const parseGenerationClaimTimestamp = (value: string, prefix: string): number | null => {
  if (!value.startsWith(prefix)) return null;
  const timestamp = Number(value.slice(prefix.length));
  return Number.isFinite(timestamp) ? timestamp : null;
};

const isStaleGenerationClaim = (value?: string | null, prefix = "GENERATING-"): boolean => {
  if (!value?.startsWith(prefix)) return false;
  const timestamp = parseGenerationClaimTimestamp(value, prefix);
  if (timestamp == null) return true;
  return Date.now() - timestamp > GENERATION_CLAIM_TTL_MS;
};

const clearStaleGenerationClaimsIfNeeded = async (bookingId: string) => {
  const booking = await Booking.findById(bookingId).select(
    "payment.invoiceNumber payment.creditNoteGenerationClaim payment.supplierInvoiceGenerationClaim"
  );
  if (isStaleGenerationClaim(booking?.payment?.invoiceNumber, "GENERATING-")) {
    await clearInvoiceGenerationClaim(bookingId);
  }
  if (isStaleGenerationClaim(booking?.payment?.creditNoteGenerationClaim, "GENERATING-CN-")) {
    await clearCreditNoteGenerationClaim(bookingId);
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
) => {
  const updateDocument: Record<string, unknown> = { $set: update };
  if (historyEntry) updateDocument.$push = { invoiceArtifactHistory: historyEntry };
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
  customerSide: boolean
): UblLine[] => {
  const rawTotal = (booking.extraCosts || []).reduce((sum: number, cost: any) => sum + moneyNumber(cost.amount), 0);
  const targetTotal = customerSide
    ? getCustomerExtraCostNet(booking.payment, rawTotal)
    : rawTotal;
  const scale = rawTotal > 0 ? targetTotal / rawTotal : 1;
  const fallbackUnit = resolveInvoiceServiceUnit({
    checkoutUnit: (booking.checkoutSnapshot as any)?.unit,
    subprojectUnit: (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.unit,
    pricingType:
      (booking.project as any)?.subprojects?.[booking.selectedSubprojectIndex as number]?.pricing?.type ||
      booking.checkoutSnapshot?.pricingType,
    pricingOptions: (booking as any).__serviceConfigPricingOptions,
  });
  return (booking.extraCosts || []).map((cost: any) => {
    const price = Math.round(moneyNumber(cost.amount) * scale * 100) / 100;
    const lineVatRate = reverseCharge ? 0 : vatRate;
    const units = Number(cost.actualUnits);
    const hasPositiveUnits = Number.isFinite(units) && units > 0;
    const unit = tryNormalizeInvoiceUnit(cost.unit) || fallbackUnit;
    return {
      description: `Extra cost: ${cost.name}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: price,
      price,
      vatRate: lineVatRate,
      vatAmount: reverseCharge ? 0 : Math.round(price * lineVatRate) / 100,
      quantity: Number.isFinite(units) ? units : undefined,
      unitPrice: Number.isFinite(Number(cost.unitPrice)) ? Number(cost.unitPrice) * scale : undefined,
      // Only attach a unit when there is a positive quantity, otherwise the UBL
      // serializer would turn a fixed-price extra cost into "1 <unit>".
      ...(hasPositiveUnits && unit ? { unit } : {}),
    };
  });
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

const getPricingLinesForUbl = (
  booking: any,
  options: { selfBilling: boolean; platform: UblPlatformParty }
): { lines: UblLine[]; totals: ReturnType<typeof calculateInvoiceSideTotals> } => {
  const currentQuote = getCurrentQuote(booking);
  const manualLines = Array.isArray(booking.__manualInvoiceLines) ? booking.__manualInvoiceLines : undefined;
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
  let baseLines: UblLine[] = Array.isArray(booking.payment?.vatBreakdown) && booking.payment.vatBreakdown.length > 0 && !options.selfBilling
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
              })
            : moneyNumber(booking.payment?.netAmount ?? booking.payment?.amount),
          price: options.selfBilling
            ? calculateSupplierInvoiceNet({
                quoteAmount: booking.quote?.amount,
                checkoutSnapshot: booking.checkoutSnapshot,
                selectedExtraOptions: booking.selectedExtraOptions,
              })
            : moneyNumber(booking.payment?.netAmount ?? booking.payment?.amount),
          vatRate,
          vatAmount: 0,
      }];

  if (!options.selfBilling && !booking.payment?.vatBreakdown?.length && !currentQuote?.pricingLines?.length) {
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
    const supplierNet = calculateSupplierInvoiceNet({
      quoteAmount: booking.quote?.amount,
      checkoutSnapshot: booking.checkoutSnapshot,
      selectedExtraOptions: booking.selectedExtraOptions,
    });
    const customerNet = moneyNumber(booking.payment?.netAmount ?? booking.payment?.amount);
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
    const supplierNet = calculateSupplierInvoiceNet({
      quoteAmount: currentQuote?.totalAmount ?? booking.quote?.amount,
      checkoutSnapshot: booking.checkoutSnapshot,
      selectedExtraOptions: booking.selectedExtraOptions,
      repeatBuyerDiscount: booking.payment?.discount?.repeatBuyerAmount,
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
      amount: Math.max(0, supplierNet - selectedOptions),
      price: Math.max(0, supplierNet - selectedOptions),
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
      const price = moneyNumber(option.bookedPrice);
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

  const baseNet = baseLines.reduce((sum, line) => sum + line.amount, 0);
  const targetBaseNet = moneyNumber(booking.payment?.netAmount ?? baseNet);
  if (Math.abs(targetBaseNet - baseNet) >= 0.01) {
    baseLines.push({
      description: targetBaseNet > baseNet ? "Platform commission" : "Payment discount adjustment",
      amount: Math.round((targetBaseNet - baseNet) * 100) / 100,
      price: Math.round((targetBaseNet - baseNet) * 100) / 100,
      vatRate,
      vatAmount: 0,
    });
  }
  const lines = [...baseLines, ...getExtraCostLinesForUbl(booking, vatRate, reverseCharge, true)];
  const totals = calculateInvoiceSideTotals({ lines, reverseCharge, vatRate, vatLabel: booking.payment?.vatLabel });
  return { lines: lines.map((line) => ({ ...line, vatAmount: reverseCharge ? 0 : Math.round(line.amount * (line.vatRate ?? vatRate)) / 100 })), totals };
};

const getPeppolLineItems = (pricing: { lines: UblLine[] }) => pricing.lines.map((line) => ({
  description: line.description,
  price: line.price,
  vatRate: line.vatRate,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
}));

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
  options?: { selfBilling?: boolean; platform?: UblPlatformParty },
  totals?: ReturnType<typeof calculateInvoiceSideTotals>
) => {
  const customer = booking.customer || {};
  const professional = booking.professional || {};
  const platform = options?.platform || {};
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
    <cbc:PayableAmount currencyID="${escapeXml(currency)}">${toMoney(Number(totals?.totalWithVat ?? booking.payment?.totalWithVat) * sign)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`,
    taxCategoryId,
  };
};

const buildUblCreditNoteXml = (
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
      <cbc:CreditedQuantity unitCode="${escapeXml(mapUnitToUneceCode(line.unit))}">${toMoney(Number(line.quantity || 1))}</cbc:CreditedQuantity>
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
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.unitPrice ?? line.price) * sign)}</cbc:PriceAmount>
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

const buildUblInvoiceXml = (
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
  const parties = buildUblPartiesAndTotals(booking, currency, sign, pricingLines, reverseCharge, {
    selfBilling,
    platform: options?.platform,
  }, pricing.totals);
  const invoiceLines = pricingLines.map((line: any, index: number) => `
    <cac:InvoiceLine>
      <cbc:ID>${index + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="${escapeXml(mapUnitToUneceCode(line.unit))}">${toMoney(Number(line.quantity || 1))}</cbc:InvoicedQuantity>
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
        <cbc:PriceAmount currencyID="${escapeXml(currency)}">${toMoney(Number(line.unitPrice ?? line.price) * sign)}</cbc:PriceAmount>
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
    .populate("customer")
    .populate("professional")
    .populate(
      "project",
      "title extraOptions subprojects category service areaOfWork serviceConfigurationId vatProfessionalAnswers",
    );
  await hydrateServiceConfigPricingOptions(booking);
  await hydrateSupplierVatDecision(booking);
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
    const reason = error instanceof Error ? error.message : String(error);
    if (existing.payment.peppolDispatchStatus !== "sent") {
      update.peppolDispatchStatus = "failed";
      update.peppolDispatchReason = reason;
    }
    if (existing.payment.supplierPeppolDispatchStatus !== "sent") {
      update.supplierPeppolDispatchStatus = "failed";
      update.supplierPeppolDispatchReason = reason;
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
        netAmount: customerPricing.totals.netAmount,
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
      Object.assign(update, {
        peppolDispatchStatus: "failed",
        peppolDispatchReason: error instanceof Error ? error.message : String(error),
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
        netAmount: supplierPricing.totals.netAmount,
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
      Object.assign(update, {
        supplierPeppolDispatchStatus: "failed",
        supplierPeppolDispatchReason: error instanceof Error ? error.message : String(error),
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
  update.supplierInvoiceNumber = supplierInvoice.invoiceNumber;
  update.supplierInvoiceUrl = supplierInvoiceUrl;
  update.supplierInvoiceUblUrl = supplierInvoiceUblUrl;
  update.supplierInvoiceGeneratedAt = generatedAt;
  update.supplierPeppolDispatchStatus = "skipped";

  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        "payment.supplierInvoiceNumber": update.supplierInvoiceNumber,
        "payment.supplierInvoiceUrl": update.supplierInvoiceUrl,
        "payment.supplierInvoiceUblUrl": update.supplierInvoiceUblUrl,
        "payment.supplierInvoiceGeneratedAt": update.supplierInvoiceGeneratedAt,
        "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
      },
    }
  );
  await persistPaymentArtifactUpdate(booking._id, paymentId, {
    supplierInvoiceNumber: update.supplierInvoiceNumber,
    supplierInvoiceUrl: update.supplierInvoiceUrl,
    supplierInvoiceUblUrl: update.supplierInvoiceUblUrl,
    supplierInvoiceGeneratedAt: update.supplierInvoiceGeneratedAt,
    supplierPeppolDispatchStatus: update.supplierPeppolDispatchStatus,
  });

  try {
    const supplierPricing = getPricingLinesForUbl(booking, { selfBilling: true, platform });
    const supplierPeppolResult = await maybeDispatchPeppolInvoice({
      booking,
      side: "supplier",
      invoiceNumber: supplierInvoice.invoiceNumber,
      ublXml: supplierUblXml,
      invoiceUblUrl: supplierInvoiceUblUrl,
      netAmount: supplierPricing.totals.netAmount,
      vatRate: supplierPricing.totals.vatRate,
      reverseCharge: supplierPricing.totals.reverseCharge,
      lineItems: getPeppolLineItems(supplierPricing),
    });
    update.supplierPeppolDispatchStatus = supplierPeppolResult.status;
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
      supplierPeppolError instanceof Error ? supplierPeppolError.message : supplierPeppolError,
    );
    update.supplierPeppolDispatchStatus = "failed";
    await Booking.updateOne(
      { _id: booking._id },
      { $set: {
        "payment.supplierPeppolDispatchStatus": "failed",
        "payment.supplierPeppolDispatchReason": supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError),
      } },
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, {
      supplierPeppolDispatchStatus: "failed",
      supplierPeppolDispatchReason: supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError),
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

    const update: InvoiceArtifactResult = {
      invoiceNumber: customerInvoice.invoiceNumber,
      invoiceUrl,
      invoiceUblUrl,
      invoiceGeneratedAt: generatedAt,
      supplierInvoiceNumber: supplierInvoice.invoiceNumber,
      supplierInvoiceUrl,
      supplierInvoiceUblUrl,
      supplierInvoiceGeneratedAt: generatedAt,
      peppolDispatchStatus: "skipped",
      supplierPeppolDispatchStatus: "skipped",
    };

    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.invoiceNumber": update.invoiceNumber,
          "payment.invoiceUrl": update.invoiceUrl,
          "payment.invoiceUblUrl": update.invoiceUblUrl,
          "payment.invoiceGeneratedAt": update.invoiceGeneratedAt,
          "payment.supplierInvoiceNumber": update.supplierInvoiceNumber,
          "payment.supplierInvoiceUrl": update.supplierInvoiceUrl,
          "payment.supplierInvoiceUblUrl": update.supplierInvoiceUblUrl,
          "payment.supplierInvoiceGeneratedAt": update.supplierInvoiceGeneratedAt,
          "payment.peppolDispatchStatus": update.peppolDispatchStatus,
          "payment.supplierPeppolDispatchStatus": update.supplierPeppolDispatchStatus,
        },
      }
    );
    await persistPaymentArtifactUpdate(booking._id, paymentId, update);

    try {
      const customerPricing = getPricingLinesForUbl(booking, { selfBilling: false, platform });
      const peppolResult = await maybeDispatchPeppolInvoice({
        booking,
        side: "customer",
        invoiceNumber: customerInvoice.invoiceNumber,
        ublXml: customerUblXml,
        invoiceUblUrl,
        netAmount: customerPricing.totals.netAmount,
        vatRate: customerPricing.totals.vatRate,
        reverseCharge: customerPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      update.peppolDispatchStatus = peppolResult.status;
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
        peppolError instanceof Error ? peppolError.message : peppolError
      );
      update.peppolDispatchStatus = "failed";
      await Booking.updateOne(
        { _id: booking._id },
        { $set: {
          "payment.peppolDispatchStatus": "failed",
          "payment.peppolDispatchReason": peppolError instanceof Error ? peppolError.message : String(peppolError),
        } }
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        peppolDispatchStatus: "failed",
        peppolDispatchReason: peppolError instanceof Error ? peppolError.message : String(peppolError),
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
        netAmount: supplierPricing.totals.netAmount,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      update.supplierPeppolDispatchStatus = supplierPeppolResult.status;
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
        supplierPeppolError instanceof Error ? supplierPeppolError.message : supplierPeppolError,
      );
      update.supplierPeppolDispatchStatus = "failed";
      await Booking.updateOne(
        { _id: booking._id },
        { $set: {
          "payment.supplierPeppolDispatchStatus": "failed",
          "payment.supplierPeppolDispatchReason": supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError),
        } },
      );
      await persistPaymentArtifactUpdate(booking._id, paymentId, {
        supplierPeppolDispatchStatus: "failed",
        supplierPeppolDispatchReason: supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError),
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
    const reason = error instanceof Error ? error.message : String(error);
    if (update.creditNotePeppolDispatchStatus !== "sent") {
      update.creditNotePeppolDispatchStatus = "failed";
      update.creditNotePeppolDispatchReason = reason;
    }
    if (update.supplierCreditNotePeppolDispatchStatus !== "sent") {
      update.supplierCreditNotePeppolDispatchStatus = "failed";
      update.supplierCreditNotePeppolDispatchReason = reason;
    }
  }

  if (platform && update.creditNotePeppolDispatchStatus !== "sent") {
    try {
      if (!existing.payment.creditNoteUblUrl) throw new Error("Customer credit note UBL artifact is missing.");
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
        documentType: "credit_note",
        netAmount: customerPricing.totals.netAmount,
        vatRate: customerPricing.totals.vatRate,
        reverseCharge: customerPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(customerPricing),
      });
      update.creditNotePeppolDispatchStatus = result.status;
      update.creditNotePeppolDispatchReason = result.reason;
      update.creditNotePeppolDispatchReference = result.reference;
    } catch (error) {
      update.creditNotePeppolDispatchStatus = "failed";
      update.creditNotePeppolDispatchReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (platform && update.supplierCreditNotePeppolDispatchStatus !== "sent") {
    try {
      if (!existing.payment.supplierCreditNoteUblUrl) throw new Error("Supplier credit note UBL artifact is missing.");
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
        documentType: "credit_note",
        netAmount: supplierPricing.totals.netAmount,
        vatRate: supplierPricing.totals.vatRate,
        reverseCharge: supplierPricing.totals.reverseCharge,
        lineItems: getPeppolLineItems(supplierPricing),
      });
      update.supplierCreditNotePeppolDispatchStatus = result.status;
      update.supplierCreditNotePeppolDispatchReason = result.reason;
      update.supplierCreditNotePeppolDispatchReference = result.reference;
    } catch (error) {
      update.supplierCreditNotePeppolDispatchStatus = "failed";
      update.supplierCreditNotePeppolDispatchReason = error instanceof Error ? error.message : String(error);
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
          documentType: "credit_note",
          netAmount: customerPricing.totals.netAmount,
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
        const reason = peppolError instanceof Error ? peppolError.message : String(peppolError);
        console.error(`[INVOICE] Peppol customer credit-note dispatch failed for booking ${bookingId}:`, reason);
        update.creditNotePeppolDispatchStatus = "failed";
        update.creditNotePeppolDispatchReason = reason;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.creditNotePeppolDispatchStatus": "failed",
            "payment.creditNotePeppolDispatchReason": reason,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          creditNotePeppolDispatchStatus: "failed",
          creditNotePeppolDispatchReason: reason,
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
          documentType: "credit_note",
          netAmount: supplierPricing.totals.netAmount,
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
        const reason = supplierPeppolError instanceof Error ? supplierPeppolError.message : String(supplierPeppolError);
        console.error(`[INVOICE] Peppol supplier credit-note dispatch failed for booking ${bookingId}:`, reason);
        update.supplierCreditNotePeppolDispatchStatus = "failed";
        update.supplierCreditNotePeppolDispatchReason = reason;
        await Booking.updateOne(
          { _id: booking._id },
          { $set: {
            "payment.supplierCreditNotePeppolDispatchStatus": "failed",
            "payment.supplierCreditNotePeppolDispatchReason": reason,
          } }
        );
        await persistPaymentArtifactUpdate(booking._id, paymentId, {
          supplierCreditNotePeppolDispatchStatus: "failed",
          supplierCreditNotePeppolDispatchReason: reason,
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
  paymentId: string,
  input: ManualInvoiceCorrectionInput,
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
  const generated = await generateBookingInvoice(manualBooking as any, {
    kind: input.side === "supplier" ? "self_bill" : "customer",
    creditNote: input.documentType === "credit_note",
    relatedInvoiceNumber,
    manualOverride: input,
  });
  const keyBase = `invoices/${booking._id.toString()}/manual/${generated.invoiceNumber}`;
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
  const ublUrl = await uploadBufferToS3(
    Buffer.from(ublXml, "utf8"),
    `${keyBase}.xml`,
    "application/xml",
    `attachment; filename="${generated.invoiceNumber}.xml"`,
  );

  let peppolDispatchStatus = "skipped";
  let peppolDispatchReason: string | undefined;
  let peppolDispatchReference: string | undefined;
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
      documentType: input.documentType,
      netAmount: pricing.totals.netAmount,
      vatRate: pricing.totals.vatRate,
      reverseCharge: pricing.totals.reverseCharge,
      lineItems: getPeppolLineItems(pricing),
    });
    peppolDispatchStatus = result.status;
    peppolDispatchReason = result.reason;
    peppolDispatchReference = result.reference;
  } catch (error) {
    peppolDispatchStatus = "failed";
    peppolDispatchReason = error instanceof Error ? error.message : String(error);
  }

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
  await Booking.updateOne({ _id: booking._id }, bookingUpdate);
  await persistPaymentArtifactUpdate(booking._id, paymentId, fields, historyEntry);
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
