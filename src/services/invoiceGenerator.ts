/**
 * Invoice Generation Service
 * Generates PDF invoices for completed bookings
 */

import PDFDocument from 'pdfkit';
import { getVATExplanation } from '../utils/vat';
import { formatCurrency } from '../utils/payment';

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

/**
 * Generate invoice number
 * Format: INV-YYYY-NNNNNN
 */
export function generateInvoiceNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `INV-${year}-${random}`;
}

/**
 * Generate PDF invoice
 * Returns Buffer that can be uploaded to S3
 */
export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers: Buffer[] = [];

      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // Header
      doc
        .fontSize(20)
        .text('FIXERA', 50, 50)
        .fontSize(10)
        .text('Property Services Marketplace', 50, 75)
        .text('Belgium', 50, 90);

      // Invoice title
      doc
        .fontSize(20)
        .text('INVOICE', 400, 50, { align: 'right' });

      // Invoice details
      doc
        .fontSize(10)
        .text(`Invoice #: ${data.invoiceNumber}`, 400, 75, { align: 'right' })
        .text(`Date: ${data.invoiceDate.toLocaleDateString()}`, 400, 90, { align: 'right' })
        .text(`Booking #: ${data.bookingNumber}`, 400, 105, { align: 'right' });

      // Horizontal line
      doc
        .moveTo(50, 130)
        .lineTo(550, 130)
        .stroke();

      // Bill To section
      doc
        .fontSize(12)
        .text('BILL TO:', 50, 150);

      doc
        .fontSize(10)
        .text(data.customer.name, 50, 170)
        .text(data.customer.email, 50, 185);

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
      doc
        .fontSize(12)
        .text('SERVICE PROVIDER:', 320, 150);

      doc
        .fontSize(10)
        .text(data.professional.companyName || data.professional.name, 320, 170);

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
      doc
        .fontSize(12)
        .text('SERVICE DESCRIPTION:', 50, 280);

      doc
        .fontSize(10)
        .text(data.serviceDescription, 50, 300, { width: 500 });

      // Invoice table
      const tableTop = 360;

      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Description', 50, tableTop)
        .text('Amount', 450, tableTop, { align: 'right' });
      doc.font('Helvetica');

      // Line
      doc
        .moveTo(50, tableTop + 20)
        .lineTo(550, tableTop + 20)
        .stroke();

      // Net amount
      doc
        .text('Service Amount', 50, tableTop + 30)
        .text(
          formatCurrency(data.payment.netAmount, data.payment.currency),
          450,
          tableTop + 30,
          { align: 'right' }
        );

      // VAT
      if (data.payment.vatAmount > 0) {
        doc
          .text(`VAT (${data.payment.vatRate}%)`, 50, tableTop + 50)
          .text(
            formatCurrency(data.payment.vatAmount, data.payment.currency),
            450,
            tableTop + 50,
            { align: 'right' }
          );
      }

      // Total line
      doc
        .moveTo(50, tableTop + 70)
        .lineTo(550, tableTop + 70)
        .stroke();

      // Total
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('TOTAL', 50, tableTop + 80)
        .text(
          formatCurrency(data.payment.totalWithVat, data.payment.currency),
          450,
          tableTop + 80,
          { align: 'right' }
        );
      doc.font('Helvetica');

      // VAT explanation
      if (data.vatExplanation) {
        doc
          .fontSize(9)
          .text(data.vatExplanation, 50, tableTop + 120, {
            width: 500,
            align: 'left'
          });
      }

      // Footer
      doc
        .fontSize(8)
        .text('Thank you for using Fixera!', 50, 700, {
          align: 'center',
          width: 500
        })
        .text('This invoice was generated automatically by the Fixera platform.', 50, 715, {
          align: 'center',
          width: 500
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
export async function generateBookingInvoice(booking: any): Promise<{ invoiceNumber: string; pdfBuffer: Buffer }> {
  const invoiceNumber = generateInvoiceNumber();
  const invoiceDate = new Date();

  const customer = booking.customer;
  const professional = booking.professional;

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
      netAmount: booking.payment.netAmount,
      vatAmount: booking.payment.vatAmount,
      vatRate: booking.payment.vatRate,
      totalWithVat: booking.payment.totalWithVat,
      currency: booking.payment.currency,
    },

    serviceDescription: booking.quote?.description || booking.rfqDetails?.description || 'Property service',

    vatExplanation: getVATExplanation(
      {
        vatRate: booking.payment.vatRate,
        vatAmount: booking.payment.vatAmount,
        total: booking.payment.totalWithVat,
        reverseCharge: booking.payment.vatRate === 0 && booking.payment.vatAmount === 0,
      },
      customer.location?.country || 'BE'
    ),
  };

  const pdfBuffer = await generateInvoicePDF(invoiceData);

  return {
    invoiceNumber,
    pdfBuffer
  };
}
