/**
 * Invoice Generation Service
 * Generates PDF invoices for completed bookings
 */

import PDFDocument from "pdfkit";
import InvoiceSequence from "../models/invoiceSequence";
import { getVATExplanation, isEUCountry } from "../utils/vat";
import { formatCurrency } from "../utils/payment";

interface InvoiceData {
  invoiceNumber: string;
  invoiceDate: Date;
  bookingNumber: string;

  // Customer info
  customer: {
    name: string;
    email: string;
    address?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
  };

  // Professional info
  professional: {
    name: string;
    companyName?: string;
    address?: string;
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
  };

  // Service description
  serviceDescription: string;

  // VAT explanation
  vatExplanation?: string;
}

interface InvoiceBooking {
  _id: { toString(): string } | string;
  bookingNumber?: string;
  quote?: { description?: string };
  rfqDetails?: { description?: string };
  customer: {
    name: string;
    email: string;
    vatNumber?: string;
    location?: {
      address?: string;
      city?: string;
      country?: string;
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
    };
  };
  payment: {
    netAmount?: number;
    vatAmount?: number;
    vatRate?: number;
    totalWithVat?: number;
    currency?: string;
    reverseCharge?: boolean;
  };
}

/**
 * Generate invoice number
 * Format: INV-YYYY-NNNNNN
 */
export async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const sequence = await InvoiceSequence.findOneAndUpdate(
    { year },
    {
      $setOnInsert: { year, value: 0 },
      $inc: { value: 1 },
    },
    { new: true, upsert: true }
  );

  if (!sequence) {
    throw new Error("Failed to generate invoice sequence");
  }

  return `INV-${year}-${String(sequence.value).padStart(6, "0")}`;
}

/**
 * Generate PDF invoice
 * Returns Buffer that can be uploaded to S3
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
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

      // Header
      doc
        .fontSize(20)
        .text("FIXERA", 50, 50)
        .fontSize(10)
        .text("Property Services Marketplace", 50, 75)
        .text("Belgium", 50, 90);

      // Invoice title
      doc.fontSize(20).text("INVOICE", 400, 50, { align: "right" });

      // Invoice details
      doc
        .fontSize(10)
        .text(`Invoice #: ${data.invoiceNumber}`, 400, 75, { align: "right" })
        .text(`Date: ${invoiceDateText}`, 400, 90, { align: "right" })
        .text(`Booking #: ${data.bookingNumber}`, 400, 105, { align: "right" });

      // Horizontal line
      doc.moveTo(50, 130).lineTo(550, 130).stroke();

      // Bill To section
      doc.fontSize(12).text("BILL TO:", 50, 150);

      doc.fontSize(10).text(data.customer.name, 50, 170).text(data.customer.email, 50, 185);

      if (data.customer.address) {
        doc.text(data.customer.address, 50, 200);
      }
      if (data.customer.city && data.customer.country) {
        doc.text(`${data.customer.city}, ${data.customer.country}`, 50, 215);
      }
      if (data.customer.vatNumber) {
        doc.text(`VAT: ${data.customer.vatNumber}`, 50, 230);
      }

      // Service Provider section
      doc.fontSize(12).text("SERVICE PROVIDER:", 320, 150);

      doc.fontSize(10).text(data.professional.companyName || data.professional.name, 320, 170);

      if (data.professional.address) {
        doc.text(data.professional.address, 320, 185);
      }
      if (data.professional.city && data.professional.country) {
        doc.text(`${data.professional.city}, ${data.professional.country}`, 320, 200);
      }
      if (data.professional.vatNumber) {
        doc.text(`VAT: ${data.professional.vatNumber}`, 320, 215);
      }

      // Service description
      doc.fontSize(12).text("SERVICE DESCRIPTION:", 50, 280);
      const descriptionStartY = 300;
      const descriptionWidth = 500;
      doc.fontSize(10);
      const descriptionHeight = doc.heightOfString(data.serviceDescription, {
        width: descriptionWidth,
      });
      doc.text(data.serviceDescription, 50, descriptionStartY, { width: descriptionWidth });

      // Invoice table (always rendered below the variable-height description)
      const tableTop = Math.max(360, descriptionStartY + descriptionHeight + 20);

      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Description", 50, tableTop)
        .text("Amount", 450, tableTop, { align: "right" });
      doc.font("Helvetica");

      // Line
      doc.moveTo(50, tableTop + 20).lineTo(550, tableTop + 20).stroke();

      // Net amount
      doc
        .text("Service Amount", 50, tableTop + 30)
        .text(formatCurrency(data.payment.netAmount, data.payment.currency), 450, tableTop + 30, {
          align: "right",
        });

      // VAT
      if (data.payment.vatAmount > 0) {
        doc
          .text(`VAT (${data.payment.vatRate}%)`, 50, tableTop + 50)
          .text(formatCurrency(data.payment.vatAmount, data.payment.currency), 450, tableTop + 50, {
            align: "right",
          });
      }

      // Total line
      doc.moveTo(50, tableTop + 70).lineTo(550, tableTop + 70).stroke();

      // Total
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("TOTAL", 50, tableTop + 80)
        .text(formatCurrency(data.payment.totalWithVat, data.payment.currency), 450, tableTop + 80, {
          align: "right",
        });
      doc.font("Helvetica");

      // VAT explanation
      if (data.vatExplanation) {
        doc.fontSize(9).text(data.vatExplanation, 50, tableTop + 120, {
          width: 500,
          align: "left",
        });
      }

      // Footer
      const tableContentBottom = data.vatExplanation ? tableTop + 170 : tableTop + 100;
      const contentBottom = Math.max(doc.y, tableContentBottom);
      const footerHeight = 30;
      const footerPadding = 20;
      const maxFooterY = doc.page.height - doc.page.margins.bottom - footerHeight;
      let footerY = contentBottom + footerPadding;

      if (footerY > maxFooterY) {
        doc.addPage();
        footerY = doc.page.margins.top;
      }

      doc
        .fontSize(8)
        .text("Thank you for using Fixera!", 50, footerY, {
          align: "center",
          width: 500,
        })
        .text("This invoice was generated automatically by the Fixera platform.", 50, footerY + 15, {
          align: "center",
          width: 500,
        });

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
  booking: InvoiceBooking
): Promise<{ invoiceNumber: string; pdfBuffer: Buffer }> {
  const invoiceNumber = await generateInvoiceNumber();
  const invoiceDate = new Date();

  const customer = booking.customer;
  const professional = booking.professional;
  const customerCountry = customer.location?.country || "BE";

  const fallbackReverseChargeHeuristic =
    (booking.payment.vatRate ?? 0) === 0 &&
    (booking.payment.vatAmount ?? 0) === 0 &&
    isEUCountry(customerCountry);
  const reverseCharge =
    booking.payment.reverseCharge !== undefined
      ? booking.payment.reverseCharge
      : fallbackReverseChargeHeuristic;

  const invoiceData: InvoiceData = {
    invoiceNumber,
    invoiceDate,
    bookingNumber: booking.bookingNumber || booking._id.toString(),

    customer: {
      name: customer.name,
      email: customer.email,
      address: customer.location?.address,
      city: customer.location?.city,
      country: customer.location?.country,
      vatNumber: customer.vatNumber,
    },

    professional: {
      name: professional.name,
      companyName: professional.businessInfo?.companyName,
      address: professional.businessInfo?.address,
      city: professional.businessInfo?.city,
      country: professional.businessInfo?.country,
      vatNumber: professional.vatNumber,
    },

    payment: {
      netAmount: booking.payment.netAmount ?? 0,
      vatAmount: booking.payment.vatAmount ?? 0,
      vatRate: booking.payment.vatRate ?? 0,
      totalWithVat: booking.payment.totalWithVat ?? 0,
      currency: booking.payment.currency || "EUR",
    },

    serviceDescription:
      booking.quote?.description || booking.rfqDetails?.description || "Property service",

    vatExplanation: getVATExplanation(
      {
        vatRate: booking.payment.vatRate ?? 0,
        vatAmount: booking.payment.vatAmount ?? 0,
        total: booking.payment.totalWithVat ?? 0,
        reverseCharge,
      },
      customerCountry
    ),
  };

  const pdfBuffer = await generateInvoicePDF(invoiceData);

  return {
    invoiceNumber,
    pdfBuffer,
  };
}
