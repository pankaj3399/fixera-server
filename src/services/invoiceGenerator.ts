/**
 * Invoice Generation Service
 * Generates PDF invoices for completed bookings
 */

import PDFDocument from "pdfkit";
import path from "node:path";
import InvoiceSequence from "../models/invoiceSequence";
import PlatformSettings from "../models/platformSettings";
import { getVATExplanation, isEUCountry } from "../utils/vat";
import { formatCurrency } from "../utils/payment";
import {
  parseVatCountryCode,
  resolveSupplierInvoiceVatDecision,
} from "../utils/vatManagement";
import {
  calculateInvoiceSideTotals,
  calculateSupplierInvoiceNet,
  getCustomerExtraCostNet,
} from "../utils/invoiceAccounting";
import {
  formatVatAnswerWithUnit,
  resolveInvoiceServiceUnit,
  tryNormalizeInvoiceUnit,
} from "../utils/invoiceUnits";
import ServiceConfiguration from "../models/serviceConfiguration";

interface InvoiceData {
  invoiceNumber: string;
  invoiceDate: Date;
  bookingNumber: string;
  documentType?: "invoice" | "credit_note";
  relatedInvoiceNumber?: string;

  // Customer info
  customer: {
    name: string;
    email: string;
    businessName?: string;
    address?: string;
    postalCode?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Professional info
  professional: {
    name: string;
    companyName?: string;
    address?: string;
    postalCode?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Payment details
  payment: {
    netAmount: number;
    vatAmount: number;
    vatRate: number;
    totalWithVat: number;
    currency: string;
    reverseCharge?: boolean;
    vatLabel?: string;
  };

  // Service description
  serviceDescription: string;
  lineItems?: {
    description: string;
    amount: number;
    vatRate?: number;
    vatLabel?: string;
    quantity?: number;
    unitPrice?: number;
    unit?: string;
  }[];
  discounts?: { label: string; amount: number }[];
  actualStartDate?: Date;
  actualEndDate?: Date;
  selfBilling?: boolean;
  issuer?: {
    name?: string;
    vatNumber?: string;
    street?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  };

  // VAT explanation
  vatExplanation?: string;
}

export type ManualInvoiceLine = {
  description: string;
  amount: number;
  vatRate: number;
  vatLabel?: string;
  quantity?: number;
  unitPrice?: number;
  unit?: string;
};

export type ManualInvoicePartyOverride = {
  name?: string;
  email?: string;
  businessName?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  vatNumber?: string;
};

export type ManualInvoiceOverride = {
  lines: ManualInvoiceLine[];
  serviceDescription?: string;
  payment: {
    netAmount: number;
    vatAmount: number;
    vatRate: number;
    totalWithVat: number;
    currency: string;
    reverseCharge?: boolean;
    vatLabel?: string;
  };
  customer?: ManualInvoicePartyOverride;
  professional?: ManualInvoicePartyOverride;
};

export interface InvoiceBooking {
  _id: { toString(): string } | string;
  bookingNumber?: string;
  serviceConfigurationId?: string;
  location?: {
    address?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
  quote?: { description?: string; amount?: number };
  rfqData?: { description?: string; serviceType?: string };
  quoteVersions?: Array<{
    version?: number;
    scope?: string;
    description?: string;
    pricingLines?: { description: string; price: number; vatRate?: number; vatLabel?: string }[];
    materials?: Array<{ name: string; quantity?: string | number; unit?: string; description?: string }>;
    totalAmount?: number;
  }>;
  currentQuoteVersion?: number;
  project?: {
    title?: string;
    category?: string;
    service?: string;
    serviceConfigurationId?: string;
    areaOfWork?: string;
    vatProfessionalAnswers?: Array<{ fieldName?: string; value?: unknown }>;
    extraOptions?: Array<{ name?: string; _id?: string }>;
    subprojects?: Array<{
      title?: string;
      name?: string;
      description?: string;
      materialsIncluded?: boolean;
      materials?: Array<{ name: string; quantity?: string | number; unit?: string; description?: string }>;
    }>;
  };
  customer: {
    name: string;
    email: string;
    customerType?: string;
    businessName?: string;
    companyAddress?: {
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
    vatNumber?: string;
    location?: {
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
  };
  professional: {
    name: string;
    vatNumber?: string;
    businessInfo?: {
      companyName?: string;
      address?: string;
      city?: string;
      country?: string;
      postalCode?: string;
    };
  };
  payment: {
    netAmount?: number;
    vatAmount?: number;
    vatRate?: number;
    totalWithVat?: number;
    currency?: string;
    reverseCharge?: boolean;
    vatLabel?: string;
    professionalPayout?: number;
    extraCostAmount?: number;
    extraCostCustomerNetAmount?: number;
    extraCostVatAmount?: number;
    extraCostPlatformFee?: number;
    vatBreakdown?: { description: string; netAmount: number; vatRate: number; vatAmount: number }[];
    discount?: {
      loyaltyAmount?: number;
      repeatBuyerAmount?: number;
      pointsDiscountAmount?: number;
      codeDiscountAmount?: number;
      codeLabel?: string;
      totalDiscount?: number;
    };
  };
  actualStartDate?: Date;
  actualEndDate?: Date;
  scheduledStartDate?: Date;
  scheduledExecutionEndDate?: Date;
  extraCosts?: {
    name: string;
    amount: number;
    justification?: string;
    type?: string;
    estimatedUnits?: number;
    actualUnits?: number;
    unitPrice?: number;
  }[];
  extraCostTotal?: number;
  selectedExtraOptions?: Array<{ extraOptionId?: string; bookedPrice?: number; name?: string }>;
  selectedSubprojectIndex?: number;
  subprojects?: Array<{ title?: string; description?: string }>;
  checkoutSnapshot?: {
    pricingType?: "fixed" | "unit";
    unitAmount?: number;
    quantity?: number;
    baseSubtotal?: number;
    extraOptionsTotal?: number;
  };
  vatDecision?: {
    country?: string;
    propertyNature?: "movable" | "immovable";
    exemptFromBelgianReverseCharge?: boolean;
    answers?: Array<{ fieldName: string; value: unknown }>;
    explanation?: string;
  };
  __manualInvoiceLines?: ManualInvoiceLine[];
}

/** Apply party corrections to a plain booking object without spreading a hydrated Mongoose document. */
export const applyManualInvoicePartyOverrides = <T extends InvoiceBooking>(
  booking: T,
  override: ManualInvoiceOverride,
): T => {
  const baseBooking = typeof (booking as any).toObject === "function" ? (booking as any).toObject() : booking;
  const customerOverride = override.customer;
  const professionalOverride = override.professional;
  return {
    ...(baseBooking as any),
    customer: customerOverride
      ? {
          ...(baseBooking.customer || {}),
          name: customerOverride.name ?? baseBooking.customer?.name,
          email: customerOverride.email ?? baseBooking.customer?.email,
          businessName: customerOverride.businessName ?? baseBooking.customer?.businessName,
          vatNumber: customerOverride.vatNumber ?? baseBooking.customer?.vatNumber,
          companyAddress: {
            ...(baseBooking.customer?.companyAddress || {}),
            address: customerOverride.address ?? baseBooking.customer?.companyAddress?.address,
            postalCode: customerOverride.postalCode ?? baseBooking.customer?.companyAddress?.postalCode,
            city: customerOverride.city ?? baseBooking.customer?.companyAddress?.city,
            country: customerOverride.country ?? baseBooking.customer?.companyAddress?.country,
          },
        }
      : baseBooking.customer,
    professional: professionalOverride
      ? {
          ...(baseBooking.professional || {}),
          name: professionalOverride.name ?? baseBooking.professional?.name,
          vatNumber: professionalOverride.vatNumber ?? baseBooking.professional?.vatNumber,
          businessInfo: {
            ...(baseBooking.professional?.businessInfo || {}),
            companyName: professionalOverride.businessName ?? baseBooking.professional?.businessInfo?.companyName,
            address: professionalOverride.address ?? baseBooking.professional?.businessInfo?.address,
            postalCode: professionalOverride.postalCode ?? baseBooking.professional?.businessInfo?.postalCode,
            city: professionalOverride.city ?? baseBooking.professional?.businessInfo?.city,
            country: professionalOverride.country ?? baseBooking.professional?.businessInfo?.country,
          },
        }
      : baseBooking.professional,
  } as T;
};

/**
 * Generate invoice number
 * Format: FIX-YYYY-NNNNNN (customer) / SUP-YYYY-NNNNNN (self-bill)
 */
export async function generateInvoiceNumber(prefix: "FIX" | "SUP" | "INV" = "FIX"): Promise<string> {
  const year = new Date().getFullYear();
  const kind = prefix === "SUP" ? "supplier_invoice" : "invoice";
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year, kind },
    {
      $setOnInsert: { year, kind },
      $inc: { value: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate invoice sequence");
  }

  return `${prefix}-${year}-${String(sequence.value).padStart(6, "0")}`;
}

export async function generateCreditNoteNumber(prefix?: "FIX" | "SUP"): Promise<string> {
  const year = new Date().getFullYear();
  const kind = prefix === "SUP" ? "supplier_credit_note" : "credit_note";
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year, kind },
    {
      $setOnInsert: { year, kind },
      $inc: { value: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate credit note sequence");
  }

  return `${prefix ? `${prefix}-` : ""}CN-${year}-${String(sequence.value).padStart(6, "0")}`;
}

/**
 * Generate PDF invoice
 * Returns Buffer that can be uploaded to S3
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      // Reserve a footer band below the normal content margin so flowing text
      // (long service descriptions) can never run into the thank-you/page-number
      // block. Footer content is drawn into this band in the page loop below.
      const CONTENT_MARGIN = 50;
      const FOOTER_BAND = 60;
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: CONTENT_MARGIN, left: CONTENT_MARGIN, right: CONTENT_MARGIN, bottom: CONTENT_MARGIN + FOOTER_BAND },
        bufferPages: true,
      });
      const buffers: Buffer[] = [];
      const invoiceDate =
        data.invoiceDate instanceof Date ? data.invoiceDate : new Date(data.invoiceDate);
      const invoiceDateText = Number.isNaN(invoiceDate.getTime())
        ? new Date().toLocaleDateString("en-GB")
        : invoiceDate.toLocaleDateString("en-GB");

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      doc.on("error", (error) => {
        reject(error);
      });

      // Header: logo only on top. Platform info lives in the footer.
      // For self-billed documents the professional remains the legal
      // supplier; the platform is only the preparer of the document.
      const issuer = data.issuer || {};
      doc.image(path.resolve(__dirname, "../../assets/fixtract-logo.png"), 50, 50, { fit: [140, 50] });

      // Invoice title
      doc.fontSize(20).text(data.documentType === "credit_note" ? "CREDIT NOTE" : "INVOICE", 400, 50, { align: "right" });

      // Invoice details
      doc
        .fontSize(10)
        .text(`${data.documentType === "credit_note" ? "Credit note" : "Invoice"} #: ${data.invoiceNumber}`, 400, 75, { align: "right" })
        .text(`Date: ${invoiceDateText}`, 400, 90, { align: "right" })
        .text(`Booking #: ${data.bookingNumber}`, 400, 105, { align: "right" });
      if (data.relatedInvoiceNumber) {
        doc.text(`Related invoice: ${data.relatedInvoiceNumber}`, 400, 120, { align: "right" });
      }

      // Horizontal line
      doc.moveTo(50, 130).lineTo(550, 130).stroke();

      // Bill To section
      doc.fontSize(12).text("BILL TO:", 50, 150);

      doc.fontSize(10).text(data.customer.businessName || data.customer.name, 50, 170).text(data.customer.email, 50, 185);

      if (data.customer.address) {
        doc.text(data.customer.address, 50, 200);
      }
      if (data.customer.city && data.customer.country) {
        doc.text(`${data.customer.postalCode ? `${data.customer.postalCode} ` : ""}${data.customer.city}, ${data.customer.country}`, 50, 215);
      }
      if (data.customer.vatNumber) {
        doc.text(`VAT: ${data.customer.vatNumber}`, 50, 230);
      }

      // Supplier section (the professional is the legal supplier of the service)
      doc.fontSize(12).text(data.selfBilling ? "SUPPLIER:" : "SERVICE PROVIDER:", 320, 150);

      doc.fontSize(10).text(data.professional.companyName || data.professional.name, 320, 170);

      if (data.professional.address) {
        doc.text(data.professional.address, 320, 185);
      }
      if (data.professional.city && data.professional.country) {
        doc.text(`${data.professional.postalCode ? `${data.professional.postalCode} ` : ""}${data.professional.city}, ${data.professional.country}`, 320, 200);
      }
      if (data.professional.vatNumber) {
        doc.text(`VAT: ${data.professional.vatNumber}`, 320, 215);
      }
      if (data.selfBilling) {
        doc.text("Prepared and sent on behalf of the supplier.", 320, 230, { width: 230 });
      }

      // Service description — render as flowing text so long descriptions
      // paginate naturally instead of overflowing a fixed-height coordinate.
      doc.fontSize(12).text("SERVICE DESCRIPTION:", 50, 280);
      const descriptionWidth = 500;
      doc.fontSize(10);
      doc.text(data.serviceDescription || " ", 50, 300, { width: descriptionWidth });

      const dateLines = [
        data.actualStartDate ? `Actual start date: ${new Date(data.actualStartDate).toLocaleDateString("en-GB")}` : undefined,
        data.actualEndDate ? `Actual end date: ${new Date(data.actualEndDate).toLocaleDateString("en-GB")}` : undefined,
      ].filter(Boolean);

      // Bottom of the usable content area. The document's bottom margin already
      // reserves the footer band, so content simply stops at maxY/page bottom.
      const contentBottom = () => doc.page.height - doc.page.margins.bottom;
      const contentTop = () => doc.page.margins.top;
      const ensureSpace = (needed: number) => {
        if (doc.y + needed > contentBottom()) {
          doc.addPage();
          doc.y = contentTop();
        }
      };

      if (dateLines.length > 0) {
        ensureSpace(28);
        doc.text(dateLines.join("\n"), 50, doc.y + 6, { width: descriptionWidth });
      }

      // Invoice table (flows below the variable-height description).
      ensureSpace(46);
      let rowY = doc.y + 12;

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Description", 50, rowY, { width: 300 })
        .text("Qty", 360, rowY, { align: "right", width: 35 })
        .text("Unit price", 395, rowY, { align: "right", width: 70 })
        .text("Amount", 475, rowY, { align: "right", width: 75 });
      doc.font("Helvetica");

      // Line
      doc.moveTo(50, rowY + 18).lineTo(550, rowY + 18).stroke();
      doc.y = rowY + 24;

      const lineItems = data.lineItems?.length
        ? data.lineItems
        : [{ description: "Service Amount", amount: data.payment.netAmount, vatRate: data.payment.vatRate }];
      for (const item of lineItems) {
        const vatSuffix = data.payment.reverseCharge
          ? " (Reverse Charge)"
          : item.vatRate != null
            ? ` (${item.vatRate}% VAT)`
            : "";
        const quantity = Number(item.quantity);
        let unitPrice = Number(item.unitPrice ?? (quantity > 0 ? item.amount / quantity : Number.NaN));
        if (data.documentType === "credit_note" && item.unitPrice == null && Number.isFinite(unitPrice)) {
          unitPrice = Math.abs(unitPrice);
        }
        const descriptionText = `${item.description}${vatSuffix}`;
        const rowHeight = Math.max(
          20,
          doc.heightOfString(descriptionText, { width: 300 }) + 6,
        );
        ensureSpace(rowHeight);
        const y = doc.y;
        doc
          .text(descriptionText, 50, y, { width: 300 })
          .text(Number.isFinite(quantity) && quantity > 0 ? `${quantity}${item.unit ? ` ${item.unit}` : ""}` : "", 360, y, { align: "right", width: 35 })
          .text(Number.isFinite(unitPrice) ? formatCurrency(unitPrice, data.payment.currency) : "", 395, y, { align: "right", width: 70 })
          .text(formatCurrency(item.amount, data.payment.currency), 475, y, { align: "right", width: 75 });
        doc.y = y + rowHeight;
      }

      rowY = doc.y;
      for (const discount of data.discounts || []) {
        ensureSpace(20);
        rowY = doc.y;
        const discountAmountLabel = discount.amount < 0
          ? formatCurrency(Math.abs(discount.amount), data.payment.currency)
          : `-${formatCurrency(Math.abs(discount.amount), data.payment.currency)}`;
        doc
          .text(discount.label, 50, rowY)
          .text(discountAmountLabel, 450, rowY, { align: "right" });
        doc.y = rowY + 20;
      }

      // VAT
      if (data.payment.reverseCharge) {
        ensureSpace(20);
        rowY = doc.y;
        doc
          .text("VAT (Reverse charge)", 50, rowY)
          .text(formatCurrency(0, data.payment.currency), 450, rowY, { align: "right" });
        doc.y = rowY + 20;
      } else if (data.payment.vatAmount !== 0) {
        ensureSpace(20);
        rowY = doc.y;
        doc
          .text(`VAT (${data.payment.vatRate}%)`, 50, rowY)
          .text(formatCurrency(data.payment.vatAmount, data.payment.currency), 450, rowY, { align: "right" });
        doc.y = rowY + 20;
      }

      // Total
      ensureSpace(40);
      rowY = doc.y;
      doc.moveTo(50, rowY).lineTo(550, rowY).stroke();
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("TOTAL", 50, rowY + 10)
        .text(formatCurrency(data.payment.totalWithVat, data.payment.currency), 450, rowY + 10, { align: "right" });
      doc.font("Helvetica");
      doc.y = rowY + 28;

      // VAT explanation
      if (data.vatExplanation) {
        ensureSpace(24);
        doc.fontSize(9).text(data.vatExplanation, 50, doc.y + 8, { width: 500, align: "left" });
        doc.fontSize(10);
      }

      // Footer + page numbers: drawn on every buffered page, inside the reserved
      // footer band. Lower the bottom margin only while drawing the footer so
      // PDFKit does not append a blank page for text below the content margin.
      const platformLine = [issuer.name || "Fixtract", issuer.street, [issuer.postalCode, issuer.city].filter(Boolean).join(" "), issuer.country].filter(Boolean).join(" · ");
      const platformVatLine = issuer.vatNumber ? `VAT: ${issuer.vatNumber}` : undefined;
      const pageRange = doc.bufferedPageRange();
      for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
        doc.switchToPage(pageIndex);
        doc.page.margins.bottom = CONTENT_MARGIN;
        const footerY = doc.page.height - CONTENT_MARGIN - 52;
        const pageNumberY = doc.page.height - CONTENT_MARGIN - 12;
        doc
          .fontSize(8)
          .fillColor("#000000")
          .text("Thank you for using Fixtract!", 50, footerY, { align: "center", width: 500 })
          .text("This invoice was generated automatically by the Fixtract platform.", 50, footerY + 10, { align: "center", width: 500 });
        if (platformLine) {
          doc.text(platformLine, 50, footerY + 20, { align: "center", width: 500 });
        }
        if (platformVatLine) {
          doc.text(platformVatLine, 50, footerY + 30, { align: "center", width: 500 });
        }
        doc
          .fontSize(8)
          .fillColor("#666666")
          .text(`Page ${pageIndex - pageRange.start + 1} of ${pageRange.count}`, 50, pageNumberY, {
            align: "center",
            width: 500,
          })
          .fillColor("#000000");
      }

      // Finalize PDF
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Generate invoice for a booking
 * This should be called after payment is captured
 */
export async function generateBookingInvoice(
  booking: InvoiceBooking,
  options?: {
    creditNote?: boolean;
    relatedInvoiceNumber?: string;
    kind?: "customer" | "self_bill";
    manualOverride?: ManualInvoiceOverride;
  }
): Promise<{ invoiceNumber: string; pdfBuffer: Buffer }> {
  const manualOverride = options?.manualOverride;
  if (manualOverride) {
    booking = applyManualInvoicePartyOverrides(booking, manualOverride);
    booking = {
      ...(booking as any),
      payment: {
        ...(booking.payment as any),
        ...manualOverride.payment,
        vatBreakdown: manualOverride.lines.map((line) => ({
          description: line.description,
          netAmount: line.amount,
          vatRate: line.vatRate,
          vatAmount: manualOverride.payment.reverseCharge ? 0 : Math.round(line.amount * line.vatRate) / 100,
          vatLabel: line.vatLabel,
        })),
      },
      selectedExtraOptions: [],
      extraCosts: [],
      __manualInvoiceLines: manualOverride.lines,
    } as InvoiceBooking;
  }
  const kind = options?.kind || "customer";
  const sign = options?.creditNote ? -1 : 1;

  const customer = booking.customer;
  const professional = booking.professional;
  const customerCountry = parseVatCountryCode(
    booking.vatDecision?.country || booking.location?.country || customer.companyAddress?.country || customer.location?.country,
  );
  const settings = await PlatformSettings.getCurrentConfig();
  // Load VAT question units (for answer rendering) and pricing options (unit
  // fallback) from the service configuration. Best-effort, never blocks.
  try {
    const configId = (booking as any)?.project?.serviceConfigurationId || (booking as any)?.serviceConfigurationId;
    const projectCategory = (booking as any)?.project?.category;
    const projectService = (booking as any)?.project?.service;
    const configSelect = "vatManagement vatManagement.reducedVatQuestions vatManagement.professionalVatQuestions pricingOptions";
    const config = configId
      ? await ServiceConfiguration.findById(configId).select(configSelect).lean()
      : projectCategory && projectService
        ? await ServiceConfiguration.findOne({
            category: projectCategory,
            service: projectService,
          }).select(configSelect).lean()
        : null;
    if (config?.vatManagement) {
      (booking as any).__vatQuestionConfig = config.vatManagement;
    }
    if (Array.isArray((config as any)?.pricingOptions)) {
      (booking as any).__serviceConfigPricingOptions = (config as any).pricingOptions;
    }
  } catch {
    // ignore, answers render without units
  }
  const professionalCountry = parseVatCountryCode(professional.businessInfo?.country);
  const issuerCountry = parseVatCountryCode(settings.companyAddress?.country);
  if (!customerCountry) {
    throw new Error("Cannot generate invoice: customer/service VAT country is missing or invalid.");
  }
  if (!professionalCountry) {
    throw new Error("Cannot generate invoice: professional business country is missing or invalid.");
  }
  if (!issuerCountry) {
    throw new Error("Cannot generate invoice: platform VAT country is missing or invalid.");
  }
  // Validate all accounting parties before reserving a sequence number. A
  // malformed booking must not create a permanent sequence gap or orphaned
  // invoice artifact in object storage.
  const invoiceNumber = options?.creditNote
    ? await generateCreditNoteNumber(kind === "self_bill" ? "SUP" : "FIX")
    : await generateInvoiceNumber(kind === "self_bill" ? "SUP" : "FIX");
  const invoiceDate = new Date();
  const currentQuote = booking.quoteVersions?.find((quote) => quote.version === booking.currentQuoteVersion)
    || booking.quoteVersions?.[booking.quoteVersions.length - 1];
  const checkoutQuantity = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.quantity)
    : undefined;
  const checkoutUnitPrice = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.unitAmount)
    : undefined;
  // Real service unit from the project pricing (m², hour...), falling back to
  // the service configuration's pricing option. Unknown/malformed values are
  // skipped rather than aborting invoice generation.
  const selectedSubprojectForUnit =
    typeof booking.selectedSubprojectIndex === "number" &&
    Array.isArray(booking.project?.subprojects) &&
    booking.selectedSubprojectIndex >= 0 &&
    booking.selectedSubprojectIndex < booking.project.subprojects.length
      ? booking.project.subprojects[booking.selectedSubprojectIndex]
      : undefined;
  const checkoutUnit = resolveInvoiceServiceUnit({
    checkoutUnit: (booking.checkoutSnapshot as any)?.unit,
    subprojectUnit: (selectedSubprojectForUnit as any)?.pricing?.unit,
    pricingType:
      (selectedSubprojectForUnit as any)?.pricing?.type || booking.checkoutSnapshot?.pricingType,
    pricingOptions: (booking as any).__serviceConfigPricingOptions,
  });
  const manualLines = (booking as any).__manualInvoiceLines as ManualInvoiceLine[] | undefined;
  const quoteLines = manualLines?.length
    ? manualLines.map((line) => ({
        description: line.description,
        amount: line.amount * sign,
        vatRate: line.vatRate,
        vatLabel: line.vatLabel,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unit: line.unit,
      }))
    : booking.payment.vatBreakdown?.length
    ? booking.payment.vatBreakdown.map((line, index) => ({
        description: line.description,
        amount: line.netAmount * sign,
        vatRate: line.vatRate,
        ...(index === 0 && Number.isFinite(checkoutQuantity) && Number.isFinite(checkoutUnitPrice)
          ? { quantity: checkoutQuantity, unitPrice: checkoutUnitPrice, ...(checkoutUnit ? { unit: checkoutUnit } : {}) }
          : {}),
      }))
    : currentQuote?.pricingLines?.map((line, index) => ({
        description: line.description,
        amount: line.price * sign,
        vatRate: line.vatRate,
        ...(index === 0 && Number.isFinite(checkoutQuantity) && Number.isFinite(checkoutUnitPrice)
          ? { quantity: checkoutQuantity, unitPrice: checkoutUnitPrice, ...(checkoutUnit ? { unit: checkoutUnit } : {}) }
          : {}),
      })) || [];

  const selectedSubproject =
    typeof booking.selectedSubprojectIndex === "number" &&
    Array.isArray(booking.project?.subprojects) &&
    booking.selectedSubprojectIndex >= 0 &&
    booking.selectedSubprojectIndex < booking.project.subprojects.length
      ? booking.project.subprojects[booking.selectedSubprojectIndex]
      : undefined;

  const selfBilling = kind === "self_bill";

  const fallbackReverseChargeHeuristic =
    (booking.payment.vatRate ?? 0) === 0 &&
    (booking.payment.vatAmount ?? 0) === 0 &&
    isEUCountry(customerCountry);
  const reverseCharge =
    booking.payment.reverseCharge !== undefined
      ? booking.payment.reverseCharge
      : fallbackReverseChargeHeuristic;

  const optionLines = (booking.selectedExtraOptions || []).map((option) => {
    const projectOption = (booking as any).project?.extraOptions?.find(
      (entry: any, index: number) =>
        String(entry?._id || index) === String(option.extraOptionId) ||
        String(index) === String(option.extraOptionId)
    );
    return {
      description: `Option: ${projectOption?.name || option.name || option.extraOptionId || "Extra option"}`,
      amount: (option.bookedPrice ?? 0) * sign,
      vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
    };
  });

  const rawExtraCostTotal = (booking.extraCosts || []).reduce((sum, cost) => sum + (Number(cost.amount) || 0), 0);
  const customerExtraCostNet = getCustomerExtraCostNet(booking.payment, rawExtraCostTotal);
  const extraCostScale = rawExtraCostTotal > 0 ? customerExtraCostNet / rawExtraCostTotal : 1;
  const extraCostLines = manualLines?.length ? [] : (booking.extraCosts || []).map((cost) => {
    const costUnit = tryNormalizeInvoiceUnit((cost as any).unit) || checkoutUnit;
    const unitDetail =
      cost.type === "unit_adjustment" &&
      Number.isFinite(cost.actualUnits) &&
      Number.isFinite(cost.estimatedUnits)
        ? ` (${cost.estimatedUnits} est. → ${cost.actualUnits}${costUnit ? ` ${costUnit}` : ""} actual)`
        : cost.type === "unit_adjustment" && Number.isFinite(cost.actualUnits)
          ? ` (${cost.actualUnits}${costUnit ? ` ${costUnit}` : ""})`
          : "";
    return {
      description: `Extra cost: ${cost.name}${unitDetail}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: cost.amount * extraCostScale * sign,
      vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
      quantity: Number.isFinite(Number(cost.actualUnits)) ? Number(cost.actualUnits) : undefined,
      unitPrice: Number.isFinite(Number(cost.unitPrice)) ? Number(cost.unitPrice) * extraCostScale : undefined,
      ...(Number.isFinite(Number(cost.actualUnits)) && costUnit ? { unit: costUnit } : {}),
    };
  });
  const extraCostNet = extraCostLines.reduce((sum, line) => sum + line.amount, 0);
  const extraCostVatRate = reverseCharge ? 0 : booking.payment.vatRate ?? 0;
  const extraCostVat = Math.round(extraCostNet * extraCostVatRate) / 100;
  const extraCostGross = booking.payment.extraCostAmount != null
    ? booking.payment.extraCostAmount * sign
    : extraCostNet + extraCostVat;
  const discount = booking.payment.discount;
  const usingDiscountedVatBreakdown = Boolean(booking.payment.vatBreakdown?.length);
  const discounts = usingDiscountedVatBreakdown ? [] : selfBilling
    ? [
        discount?.repeatBuyerAmount
          ? { label: "Repeat buyer discount", amount: discount.repeatBuyerAmount * sign }
          : undefined,
      ].filter(Boolean) as { label: string; amount: number }[]
    : [
        discount?.loyaltyAmount ? { label: "Loyalty discount", amount: discount.loyaltyAmount * sign } : undefined,
        discount?.repeatBuyerAmount ? { label: "Repeat buyer discount", amount: discount.repeatBuyerAmount * sign } : undefined,
        discount?.pointsDiscountAmount ? { label: "Points discount", amount: discount.pointsDiscountAmount * sign } : undefined,
        discount?.codeDiscountAmount ? { label: `Discount code${discount.codeLabel ? ` (${discount.codeLabel})` : ""}`, amount: discount.codeDiscountAmount * sign } : undefined,
      ].filter(Boolean) as { label: string; amount: number }[];

  const issuer = {
    name: settings.companyAddress?.name || "Fixtract",
    vatNumber: settings.companyVatNumber,
    street: settings.companyAddress?.street,
    city: settings.companyAddress?.city,
    postalCode: settings.companyAddress?.postalCode,
    country: settings.companyAddress?.country,
  };

  const supplierCountry = parseVatCountryCode(
    professional.businessInfo?.country || (professional as any)?.location?.country,
  );
  const supplierVatCountry = parseVatCountryCode(issuer.country);
  const professionalVatAnswers = ((booking.project as any)?.vatProfessionalAnswers || []).reduce(
    (acc: Record<string, unknown>, answer: { fieldName?: string; value?: unknown }) => {
      if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
      return acc;
    },
    {},
  );
  const customerVatAnswers = (booking.vatDecision?.answers || []).reduce(
    (acc: Record<string, unknown>, answer: { fieldName?: string; value?: unknown }) => {
      if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
      return acc;
    },
    {},
  );
  // Self-bill VAT must follow the same configured rate as the customer leg
  // (e.g. 6% reduced for eligible renovations), not the bare country standard.
  // Reuse the decision cached by loadBookingForInvoice so the PDF and UBL agree.
  const supplierVatDecision = (booking as any).__supplierVatDecision
    || await resolveSupplierInvoiceVatDecision({
      serviceConfigurationId: (booking.project as any)?.serviceConfigurationId || booking.serviceConfigurationId,
      category: (booking.project as any)?.category,
      service: (booking.project as any)?.service,
      areaOfWork: (booking.project as any)?.areaOfWork,
      supplierCountry,
      buyerCountry: supplierVatCountry,
      supplierVatNumber: (professional as any)?.businessInfo?.vatNumber || professional.vatNumber,
      buyerVatNumber: issuer.vatNumber,
      buyerVatVerified: true,
      bookingCountry: booking.vatDecision?.country || (booking as any)?.location?.country,
      propertyNature: booking.vatDecision?.propertyNature,
      exemptFromBelgianReverseCharge: booking.vatDecision?.exemptFromBelgianReverseCharge,
      answers: customerVatAnswers,
      professionalAnswers: professionalVatAnswers,
    });
  // Cache so the UBL builder (which resolves the supplier VAT synchronously)
  // uses the exact same decision as the PDF.
  (booking as any).__supplierVatDecision = supplierVatDecision;
  const supplierReverseCharge = manualLines?.length && selfBilling
    ? Boolean(booking.payment.reverseCharge)
    : Boolean(supplierVatDecision.reverseCharge);
  const supplierVatRate = manualLines?.length && selfBilling
    ? (supplierReverseCharge ? 0 : Number(booking.payment.vatRate ?? 0))
    : (supplierReverseCharge ? 0 : supplierVatDecision.appliedRate);
  const supplierServiceNet = calculateSupplierInvoiceNet({
    quoteAmount: currentQuote?.totalAmount ?? booking.quote?.amount,
    checkoutSnapshot: booking.checkoutSnapshot,
    selectedExtraOptions: booking.selectedExtraOptions,
    repeatBuyerDiscount: booking.payment.discount?.repeatBuyerAmount,
  });
  const supplierOptionTotal = (booking.selectedExtraOptions || []).reduce(
    (sum, option) => sum + (Number(option.bookedPrice) || 0),
    0
  );
  const serviceLabel =
    booking.rfqData?.serviceType || currentQuote?.description || booking.quote?.description || "Property service";
  const unitQuantity = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.quantity)
    : undefined;
  const unitPrice = booking.checkoutSnapshot?.pricingType === "unit"
    ? Number(booking.checkoutSnapshot.unitAmount)
    : undefined;
  const hasUnits = typeof unitQuantity === "number" && Number.isFinite(unitQuantity) && unitQuantity > 0;
  const hasUnitPrice = typeof unitPrice === "number" && Number.isFinite(unitPrice) && unitPrice >= 0;
  const supplierOptionLines = (booking.selectedExtraOptions || []).map((option) => {
    const projectOption = (booking as any).project?.extraOptions?.find(
      (entry: any, index: number) =>
        String(entry?._id || index) === String(option.extraOptionId) ||
        String(index) === String(option.extraOptionId)
    );
    return {
      description: `Option: ${projectOption?.name || option.name || option.extraOptionId || "Extra option"}`,
      amount: (Number(option.bookedPrice) || 0) * sign,
      vatRate: supplierVatRate,
    };
  });
  const supplierExtraCostLines = (booking.extraCosts || []).map((cost) => {
    const supplierCostUnit = tryNormalizeInvoiceUnit((cost as any).unit) || checkoutUnit;
    return {
      description: `Extra cost: ${cost.name}${cost.justification ? ` - ${cost.justification}` : ""}`,
      amount: (Number(cost.amount) || 0) * sign,
      vatRate: supplierVatRate,
      quantity: Number.isFinite(Number(cost.actualUnits)) ? Number(cost.actualUnits) : undefined,
      unitPrice: Number.isFinite(Number(cost.unitPrice)) ? Number(cost.unitPrice) : undefined,
      ...(Number.isFinite(Number(cost.actualUnits)) && supplierCostUnit ? { unit: supplierCostUnit } : {}),
    };
  });
  const supplierLines = manualLines?.length
    ? manualLines.map((line) => ({
        description: line.description,
        amount: line.amount * sign,
        vatRate: line.vatRate,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unit: line.unit,
      }))
    : [
        {
          description: serviceLabel,
          amount: (supplierServiceNet - supplierOptionTotal) * sign,
          vatRate: supplierVatRate,
          quantity: hasUnits ? unitQuantity : undefined,
          unitPrice: hasUnitPrice ? unitPrice : undefined,
          ...(hasUnits && checkoutUnit ? { unit: checkoutUnit } : {}),
        },
        ...supplierOptionLines,
        ...supplierExtraCostLines,
      ];
  const supplierTotals = calculateInvoiceSideTotals({
    lines: supplierLines,
    reverseCharge: supplierReverseCharge,
    vatRate: supplierVatRate,
    vatLabel: supplierVatDecision.vatLabel,
  });
  const customerInvoiceNet = (booking.payment.netAmount ?? 0) * sign + extraCostNet;
  const customerInvoiceVat = reverseCharge
    ? 0
    : (booking.payment.vatAmount ?? 0) * sign + extraCostVat;
  const customerInvoiceTotal = (booking.payment.totalWithVat ?? 0) * sign + extraCostGross;
  const supplierNet = supplierTotals.netAmount;
  const billToCustomer = selfBilling
    ? {
        name: issuer.name,
        email: "",
        businessName: issuer.name,
        address: issuer.street,
        city: [issuer.postalCode, issuer.city].filter(Boolean).join(" "),
        country: issuer.country,
        vatNumber: issuer.vatNumber,
      }
    : {
        name: customer.name,
        email: customer.email,
        businessName: customer.customerType === "business" ? customer.businessName : undefined,
        address: customer.companyAddress?.address || customer.location?.address,
        postalCode: customer.companyAddress?.postalCode || customer.location?.postalCode,
        city: customer.companyAddress?.city || customer.location?.city,
        country: customer.companyAddress?.country || customer.location?.country,
        vatNumber: customer.vatNumber,
      };

  const invoiceData: InvoiceData = {
    invoiceNumber,
    invoiceDate,
    bookingNumber: booking.bookingNumber || booking._id.toString(),
    documentType: options?.creditNote ? "credit_note" : "invoice",
    relatedInvoiceNumber: options?.relatedInvoiceNumber,

    customer: billToCustomer,

    professional: {
      name: professional.name,
      companyName: professional.businessInfo?.companyName,
      address: professional.businessInfo?.address,
      postalCode: professional.businessInfo?.postalCode,
      city: professional.businessInfo?.city,
      country: professional.businessInfo?.country,
      vatNumber: professional.vatNumber,
    },

    payment: {
      netAmount: selfBilling ? supplierNet : customerInvoiceNet,
      vatAmount: selfBilling ? supplierTotals.vatAmount : customerInvoiceVat,
      vatRate: selfBilling ? supplierTotals.vatRate : (reverseCharge ? 0 : booking.payment.vatRate ?? 0),
      totalWithVat: selfBilling
        ? supplierTotals.totalWithVat
        : customerInvoiceTotal,
      currency: booking.payment.currency || "EUR",
      reverseCharge: selfBilling ? supplierTotals.reverseCharge : reverseCharge,
      vatLabel: selfBilling ? supplierTotals.vatLabel : booking.payment.vatLabel,
    },

    serviceDescription:
      [
        booking.project?.title ? `Project: ${booking.project.title}` : undefined,
        selectedSubproject?.title || selectedSubproject?.name
          ? `Package: ${selectedSubproject.title || selectedSubproject.name}`
          : undefined,
        selectedSubproject?.description ? `Package details: ${selectedSubproject.description}` : undefined,
        booking.rfqData?.serviceType ? `Service: ${booking.rfqData.serviceType}` : undefined,
        currentQuote?.scope ? `Scope: ${currentQuote.scope}` : undefined,
        manualOverride?.serviceDescription || currentQuote?.description || booking.quote?.description || booking.rfqData?.description || "Property service",
        (selectedSubproject?.materialsIncluded && selectedSubproject.materials?.length
          ? selectedSubproject.materials
          : currentQuote?.materials || []).length
          ? `Included materials:\n${(selectedSubproject?.materialsIncluded && selectedSubproject.materials?.length
            ? selectedSubproject.materials
            : currentQuote?.materials || []).map((material) =>
              `- ${material.name}${material.quantity != null ? ` (${material.quantity}${material.unit ? ` ${material.unit}` : ""})` : ""}${material.description ? `: ${material.description}` : ""}`
            ).join("\n")}`
          : undefined,
        booking.vatDecision?.answers?.length
          ? `Customer VAT answers:\n${booking.vatDecision.answers.map((answer) => formatVatAnswerWithUnit(answer.fieldName, (answer as any).value, (booking as any).__vatQuestionConfig)).join("\n")}`
          : undefined,
      ].filter(Boolean).join("\n"),

    lineItems: selfBilling
      ? supplierLines
      : (() => {
          const customerServiceNet = Number(booking.payment.netAmount ?? 0) * sign;
          const quoteSourceTotal = quoteLines.reduce((sum, line) => sum + Math.abs(Number(line.amount) || 0), 0);
          const sourceIsCustomerNet = Math.abs(quoteSourceTotal - Math.abs(customerServiceNet)) < 0.02;
          const customerScale = sourceIsCustomerNet || supplierServiceNet <= 0
            ? 1
            : Math.abs(customerServiceNet) / Math.max(0.01, supplierServiceNet);
          const scaledQuoteLines = quoteLines.map((line) => ({
            ...line,
            amount: line.amount * customerScale,
            unitPrice: line.unitPrice != null ? line.unitPrice * customerScale : undefined,
          }));
          // A VAT breakdown already represents the full customer-facing
          // service net. In that case its pricing lines include the selected
          // options and must not be appended a second time.
          const scaledOptionLines = sourceIsCustomerNet
            ? []
            : optionLines.map((line) => ({
                ...line,
                amount: line.amount * customerScale,
              }));
          const serviceLines = scaledQuoteLines.length > 0
            ? scaledQuoteLines
            : [{
                description: serviceLabel,
                amount: Math.max(
                  0,
                  Math.abs(customerServiceNet) - scaledOptionLines.reduce((sum, line) => sum + Math.abs(line.amount), 0),
                ) * (sign < 0 ? -1 : 1),
                vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
                quantity: hasUnits ? unitQuantity : undefined,
                unitPrice: hasUnitPrice ? unitPrice * customerScale : undefined,
                ...(hasUnits && checkoutUnit ? { unit: checkoutUnit } : {}),
              }];
          const serviceLinesWithOptions = [...serviceLines, ...scaledOptionLines];
          const serviceLineTotal = serviceLinesWithOptions.reduce((sum, line) => sum + Number(line.amount || 0), 0);
          const adjustment = Math.round((customerServiceNet - serviceLineTotal) * 100) / 100;
          if (Math.abs(adjustment) >= 0.01) {
            serviceLinesWithOptions.push({
              description: adjustment > 0 ? "Platform commission" : "Payment discount adjustment",
              amount: adjustment,
              vatRate: reverseCharge ? 0 : booking.payment.vatRate ?? 0,
            });
          }
          return [...serviceLinesWithOptions, ...extraCostLines];
        })(),
    discounts,
    actualStartDate: booking.actualStartDate,
    actualEndDate: booking.actualEndDate,
    selfBilling,
    issuer,

    vatExplanation: getVATExplanation(
      {
        vatRate: selfBilling ? supplierTotals.vatRate : (reverseCharge ? 0 : booking.payment.vatRate ?? 0),
        vatAmount: selfBilling ? supplierTotals.vatAmount : (reverseCharge ? 0 : (booking.payment.vatAmount ?? 0) + extraCostVat),
        total: selfBilling ? supplierTotals.totalWithVat : customerInvoiceTotal,
        reverseCharge: selfBilling ? supplierTotals.reverseCharge : reverseCharge,
      },
      selfBilling ? supplierVatCountry : customerCountry
    ),
  };

  const pdfBuffer = await generateInvoicePDF(invoiceData);

  return {
    invoiceNumber,
    pdfBuffer,
  };
}
