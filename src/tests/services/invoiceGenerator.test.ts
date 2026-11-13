import { beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

const mocks = vi.hoisted(() => ({
  platformSettings: vi.fn(),
  invoiceSequence: vi.fn(),
}));

vi.mock("../../models/platformSettings", () => ({
  default: { getCurrentConfig: mocks.platformSettings },
}));
vi.mock("../../models/invoiceSequence", () => ({
  default: { findOneAndUpdate: mocks.invoiceSequence },
}));

import {
  applyManualInvoicePartyOverrides,
  formatInvoiceServiceAddress,
  generateBookingInvoice,
  generateInvoicePDF,
  scaleLineItemsToTotal,
} from "../../services/invoiceGenerator";

const extractPdfStreamText = (pdf: Buffer): string => {
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  const parts: string[] = [];
  let offset = 0;
  while (true) {
    const streamOffset = pdf.indexOf(marker, offset);
    if (streamOffset < 0) break;
    let contentStart = streamOffset + marker.length;
    if (pdf[contentStart] === 13) contentStart += 1;
    if (pdf[contentStart] === 10) contentStart += 1;
    const endOffset = pdf.indexOf(endMarker, contentStart);
    if (endOffset < 0) break;
    try {
      parts.push(inflateSync(pdf.subarray(contentStart, endOffset)).toString("latin1"));
    } catch {
      // Non-compressed streams are not text-bearing PDFKit content.
    }
    offset = endOffset + endMarker.length;
  }
  return parts.join("\n");
};

const concatenatePdfHexText = (streamText: string): string =>
  [...streamText.matchAll(/<([0-9a-f]+)>/gi)]
    .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
    .join("");

// Mirrors invoiceGenerator: 50pt page margin + 60pt reserved footer band.
// PDFKit flips the page (`1 0 0 -1 0 <height> cm`), so a text-matrix y is
// measured from the PDF bottom edge; the band starts this many points above it.
const PDF_CONTENT_MARGIN = 50;
const PDF_FOOTER_BAND = 60;
const PDF_FOOTER_BAND_TOP_FROM_BOTTOM = PDF_CONTENT_MARGIN + PDF_FOOTER_BAND;
const PDF_FOOTER_PATTERNS = [
  /^Page \d+ of \d+$/,
  /^Thank you for using Fixtract!$/,
  /^This invoice was generated automatically/,
  /^Fixtract$/,
  /^VAT:/,
];
const isFooterText = (text: string): boolean =>
  PDF_FOOTER_PATTERNS.some((pattern) => pattern.test(text));

/** One text-bearing content stream per page, in page order. */
const extractPdfPageTextStreams = (pdf: Buffer): string[] => {
  const marker = Buffer.from("stream");
  const endMarker = Buffer.from("endstream");
  const parts: string[] = [];
  let offset = 0;
  while (true) {
    const streamOffset = pdf.indexOf(marker, offset);
    if (streamOffset < 0) break;
    let contentStart = streamOffset + marker.length;
    if (pdf[contentStart] === 13) contentStart += 1;
    if (pdf[contentStart] === 10) contentStart += 1;
    const endOffset = pdf.indexOf(endMarker, contentStart);
    if (endOffset < 0) break;
    try {
      const text = inflateSync(pdf.subarray(contentStart, endOffset)).toString("latin1");
      const printable = [...text].filter((char) => {
        const code = char.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127);
      }).length / text.length;
      // Invoice page content is the only highly printable stream with text ops.
      if (printable > 0.9 && text.includes("BT")) parts.push(text);
    } catch {
      // Non-flate streams (images/fonts) do not carry page text.
    }
    offset = endOffset + endMarker.length;
  }
  return parts;
};

/** Text baselines measured from the PDF bottom edge (the native `Tm` y). */
const extractTextPositions = (pageStream: string): Array<{ yFromBottom: number; text: string }> =>
  [...pageStream.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm([\s\S]*?)ET/g)].map((match) => ({
    yFromBottom: Number(match[2]),
    text: concatenatePdfHexText(match[3]),
  }));

describe("customer invoice pre-discount display", () => {
  it("scales lines so full prices minus the discount lines equal the charged net", () => {
    const lines = [
      { description: "Service", amount: 273.79, unitPrice: 10.95 },
      { description: "Option", amount: 54.76 },
    ];
    const scaled = scaleLineItemsToTotal(lines, 335.26);
    expect(scaled.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(335.26, 2);
    expect(scaled[0].unitPrice).toBeCloseTo(10.95 * (335.26 / 328.55), 2);
    expect(scaled[1]).toMatchObject({ description: "Option" });
  });

  it("keeps lines untouched without a discount and never invents lines", () => {
    const lines = [{ description: "Service", amount: 100 }];
    expect(scaleLineItemsToTotal(lines, 100)).toEqual(lines);
    expect(scaleLineItemsToTotal([], 100)).toEqual([]);
  });

  it("builds a one-line service address from the booking location", () => {
    expect(formatInvoiceServiceAddress({
      location: { address: "Rue de la Loi 1", postalCode: "1000", city: "Brussels", country: "BE" },
    } as any)).toBe("Rue de la Loi 1, 1000 Brussels, BE");
  });

  it("falls back to the customer address for legacy bookings without a service location", () => {
    expect(formatInvoiceServiceAddress({
      customer: { companyAddress: { address: "Main Street 2", postalCode: "2000", city: "Antwerp", country: "BE" } },
    } as any)).toBe("Main Street 2, 2000 Antwerp, BE");
    expect(formatInvoiceServiceAddress({ customer: {} } as any)).toBeUndefined();
  });
});

describe("customer invoice composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformSettings.mockResolvedValue({
      companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
      companyVatNumber: "BE0123456789",
    });
    mocks.invoiceSequence.mockResolvedValue({ value: 1 });
  });

  it("renders full pre-discount prices, the combined loyalty discount and the service address", async () => {
    const booking = {
      _id: "booking-1",
      bookingNumber: "BK-DISCOUNT",
      location: { address: "Rue de la Loi 1", postalCode: "1000", city: "Brussels", country: "BE" },
      customer: { name: "Customer", email: "customer@example.com", location: { country: "BE" } },
      professional: { name: "Professional", businessInfo: { country: "BE" } },
      payment: {
        netAmount: 328.55,
        vatAmount: 69,
        vatRate: 21,
        totalWithVat: 397.55,
        currency: "EUR",
        reverseCharge: false,
        vatBreakdown: [
          { description: "Paint walls", netAmount: 273.79, vatRate: 21, vatAmount: 57.5 },
          { description: "Option: Special Effects", netAmount: 54.76, vatRate: 21, vatAmount: 11.5 },
        ],
        discount: { loyaltyAmount: 6.71, totalDiscount: 6.71 },
        extraCostCustomerNetAmount: 21.9,
        extraCostVatAmount: 4.6,
        extraCostAmount: 26.5,
        extraCostCustomerDiscount: 0.45,
      },
      extraCosts: [{
        name: "Unit-based adjustment",
        amount: 20,
        justification: "extra",
        type: "unit_adjustment",
        estimatedUnits: 25,
        actualUnits: 27,
        unitPrice: 10,
      }],
      __supplierVatDecision: { reverseCharge: false, appliedRate: 21 },
    } as any;

    const { pdfBuffer } = await generateBookingInvoice(booking, { kind: "customer" });
    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdfBuffer));

    // Full service prices (grossed back up from the discounted net).
    expect(encodedText).toContain(Buffer.from("279.38").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("55.88").toString("latin1"));
    // Extra costs shown before loyalty, and loyalty including the extra-cost part.
    expect(encodedText).toContain(Buffer.from("22.35").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Loyalty discount").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("7.16").toString("latin1"));
    // VAT stays on the discounted amounts and the total is the sum of the lines.
    expect(encodedText).toContain(Buffer.from("73.60").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("424.05").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Service address: Rue de la Loi 1, 1000 Brussels, BE").toString("latin1"));
  });
});

describe("invoice PDF artifacts", () => {
  it("renders a valid PDF with units, VAT, and page metadata inputs", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000001",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-1",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: {
        netAmount: 100,
        vatAmount: 0,
        vatRate: 6,
        reverseCharge: true,
        totalWithVat: 100,
        currency: "EUR",
      },
      serviceDescription: "Service\nIncluded materials: paint",
      lineItems: [{ description: "Service", amount: 100, vatRate: 6, quantity: 2, unitPrice: 50, unit: "units" }],
      actualStartDate: new Date("2026-08-19T00:00:00.000Z"),
      actualEndDate: new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Type /Page");
    const renderedText = extractPdfStreamText(pdf);
    const encodedText = concatenatePdfHexText(renderedText);
    expect(encodedText).toContain(Buffer.from("VAT (Reverse charge)").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Page 1 of 1").toString("latin1"));
  });

  it("renders line-item quantity units in the Qty column", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000002",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-3",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, currency: "EUR" },
      serviceDescription: "Service",
      lineItems: [{ description: "Plastering", amount: 100, vatRate: 21, quantity: 50, unitPrice: 2, unit: "m²" }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("50 m").toString("latin1"));
  });

  it("prints a unit price that multiplies back to the charged line amount", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000015",
      invoiceDate: new Date("2026-10-13T00:00:00.000Z"),
      bookingNumber: "BK-2026-000100",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 82.14, vatAmount: 4.93, vatRate: 6, totalWithVat: 87.07, currency: "EUR" },
      serviceDescription: "Service",
      // 5 extra m² charged 82.14 while the catalogue price was 15/m².
      lineItems: [{ description: "Extra cost: Unit-based adjustment", amount: 82.14, vatRate: 6, quantity: 5, unitPrice: 15, unit: "m²" }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("16.43").toString("latin1"));
    expect(encodedText).not.toContain(Buffer.from("15.00").toString("latin1"));
  });

  it("renders the self-billing party label", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "SUP-2026-000001",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-2",
      customer: { name: "Fixtract", email: "accounts@example.com", country: "BE" },
      professional: { name: "Supplier", country: "BE" },
      payment: { netAmount: 100, vatAmount: 0, vatRate: 0, totalWithVat: 100, currency: "EUR" },
      serviceDescription: "Supplier service",
      selfBilling: true,
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("SUPPLIER").toString("latin1"));
  });

  it("keeps flowing content out of the reserved footer band on every page", async () => {
    const longDescription = Array.from(
      { length: 60 },
      (_, index) => `Scope line ${index + 1}: detailed description of the work.`,
    ).join("\n");
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000003",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-LONG",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, currency: "EUR" },
      serviceDescription: longDescription,
      lineItems: [{ description: "Service", amount: 100, vatRate: 21, quantity: 2, unitPrice: 50 }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("Page 1 of 2").toString("latin1"));
    expect(encodedText).toContain(Buffer.from("Page 2 of 2").toString("latin1"));

    const pages = extractPdfPageTextStreams(pdf).map(extractTextPositions);
    expect(pages).toHaveLength(2);

    for (const items of pages) {
      // Footer/page number is present on each page, inside the reserved band.
      const pageNumber = items.find((item) => /^Page \d+ of \d+$/.test(item.text));
      expect(pageNumber).toBeDefined();
      expect(pageNumber!.yFromBottom).toBeLessThanOrEqual(PDF_FOOTER_BAND_TOP_FROM_BOTTOM);

      // No description/table content may extend into the footer band.
      const contentItems = items.filter((item) => item.text && !isFooterText(item.text));
      expect(contentItems.length).toBeGreaterThan(0);
      for (const item of contentItems) {
        expect(item.yFromBottom).toBeGreaterThanOrEqual(PDF_FOOTER_BAND_TOP_FROM_BOTTOM);
      }
    }

    // The description actually flowed onto page 2 instead of being clipped.
    expect(pages[1].some((item) => /^Scope line \d+:/.test(item.text))).toBe(true);
  });

  it("keeps a short invoice on a single page", async () => {
    const pdf = await generateInvoicePDF({
      invoiceNumber: "FIX-2026-000004",
      invoiceDate: new Date("2026-08-20T00:00:00.000Z"),
      bookingNumber: "BK-SHORT",
      customer: { name: "Customer", email: "customer@example.com", country: "BE" },
      professional: { name: "Professional", country: "BE" },
      payment: { netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121, currency: "EUR" },
      serviceDescription: "Short service",
      lineItems: [{ description: "Service", amount: 100, vatRate: 21, quantity: 1, unitPrice: 100 }],
    });

    const encodedText = concatenatePdfHexText(extractPdfStreamText(pdf));
    expect(encodedText).toContain(Buffer.from("Page 1 of 1").toString("latin1"));
    expect(encodedText).not.toContain(Buffer.from("Page 2 of").toString("latin1"));
  });

  it("applies manual party overrides to hydrated bookings without losing fields", () => {
    const booking = {
      toObject: () => ({
        customer: { name: "Original customer", email: "customer@example.com", location: { country: "BE" } },
        professional: { name: "Original supplier", businessInfo: { country: "BE" } },
        location: { country: "BE" },
        payment: { netAmount: 100 },
      }),
    } as any;
    const result = applyManualInvoicePartyOverrides(booking, {
      lines: [],
      payment: { netAmount: 100, vatAmount: 0, vatRate: 0, totalWithVat: 100, currency: "EUR" },
      customer: { name: "Corrected customer", country: "NL" },
    });

    expect(result.location).toEqual({ country: "BE" });
    expect(result.customer).toMatchObject({
      name: "Corrected customer",
      email: "customer@example.com",
      companyAddress: { country: "NL" },
    });
    expect(result.professional).toMatchObject({
      name: "Original supplier",
      businessInfo: { country: "BE" },
    });
  });
});

describe('referral customer invoice and UBL accounting', () => {
  const issuedAt = new Date('2026-11-05T12:00:00Z');
  const round = (value: number) => Math.round(value * 100) / 100;
  const bookingFor = (original: number, referral: number, loyalty = 0, code = 0): any => {
    const net = round(original - referral - loyalty - code);
    return {
      _id: 'referral-invoice', bookingNumber: 'BK-REFERRAL',
      customer: { name: 'Customer', email: 'customer@example.test', location: { country: 'BE' } },
      professional: { name: 'Supplier', businessInfo: { country: 'BE' } },
      quote: { amount: original, description: 'Service' },
      payment: {
        currency: 'EUR', status: 'pending', amount: net, netAmount: net,
        vatRate: 21, vatAmount: round(net * 0.21), totalWithVat: round(net * 1.21),
        professionalPayout: original,
        discount: { referralDiscountAmount: referral, loyaltyAmount: loyalty, codeDiscountAmount: code, totalDiscount: referral + loyalty + code },
      },
      __supplierVatDecision: { reverseCharge: false, appliedRate: 21 },
    };
  };
  beforeEach(() => {
    mocks.platformSettings.mockResolvedValue({ companyAddress: { name: 'Fixtract', country: 'BE' } });
    mocks.invoiceSequence.mockResolvedValue({ value: 1 });
  });

  it.each([
    ['referral alone', 100, 10, 0, 0],
    ['referral with loyalty and code', 100, 10, 5, 7],
    ['first prorated milestone', 40, 4, 2, 2.8],
    ['second prorated milestone', 60, 6, 3, 4.2],
  ])('%s: full service minus discounts equals the paid amount on invoice and credit note', async (_label, original, referral, loyalty, code) => {
    const { buildUblInvoiceXml, buildUblCreditNoteXml } = await import('../../services/invoiceArtifacts');
    const booking = bookingFor(Number(original), Number(referral), Number(loyalty), Number(code));
    for (const creditNote of [false, true]) {
      const { pdfBuffer } = await generateBookingInvoice(booking, { kind: 'customer', creditNote });
      const text = concatenatePdfHexText(extractPdfStreamText(pdfBuffer));
      expect(text).toContain('Referral discount');
      expect(text).toContain(Number(original).toFixed(2));
      expect(text).toContain(Number(referral).toFixed(2));
      expect(text).toContain(booking.payment.totalWithVat.toFixed(2));
      const xml = (creditNote ? buildUblCreditNoteXml : buildUblInvoiceXml)(booking, 'FIX-REFERRAL', issuedAt, { selfBilling: false, platform: { country: 'BE' } });
      expect(xml).toContain('Referral discount');
      const sign = creditNote ? -1 : 1;
      expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="EUR">${(booking.payment.totalWithVat * sign).toFixed(2)}</cbc:TaxInclusiveAmount>`);
      // Sum the actual rendered UBL lines, excluding the monetary-total summary.
      // Invoices carry the discounts as document-level allowances (BR-27),
      // credit notes still as lines: lines minus allowances is the paid net.
      const lineXml = xml.match(/<cac:(?:InvoiceLine|CreditNoteLine)>[\s\S]*?<\/cac:(?:InvoiceLine|CreditNoteLine)>/g)!;
      const amounts = lineXml.map(line => Number(line.match(/<cbc:LineExtensionAmount[^>]*>([^<]+)/)![1]));
      const allowances = [...xml.matchAll(/<cac:AllowanceCharge>[\s\S]*?<cbc:Amount[^>]*>([^<]+)<\/cbc:Amount>/g)].map(match => Number(match[1]));
      expect(allowances.length > 0).toBe(!creditNote);
      expect(xml).not.toMatch(creditNote ? /<cbc:AllowanceTotalAmount/ : /<cbc:PriceAmount[^>]*>-/);
      expect(amounts[0]).toBe(Number(original) * sign);
      expect(round(amounts.reduce((sum, value) => sum + value, 0) - allowances.reduce((sum, value) => sum + value, 0)))
        .toBe(booking.payment.netAmount * sign);
      expect(xml).toContain(`<cbc:TaxExclusiveAmount currencyID="EUR">${(booking.payment.netAmount * sign).toFixed(2)}</cbc:TaxExclusiveAmount>`);
      expect(round((Number(original) - Number(referral) - Number(loyalty) - Number(code)) * 1.21)).toBe(booking.payment.totalWithVat);
    }
  });

  it('does not put platform-absorbed referral savings on supplier invoice or UBL', async () => {
    const { buildUblInvoiceXml } = await import('../../services/invoiceArtifacts');
    const booking = bookingFor(100, 10, 5, 7);
    const without = structuredClone(booking);
    without.payment.discount.referralDiscountAmount = 0;
    for (const creditNote of [false, true]) {
      const supplier = await generateBookingInvoice(booking, { kind: 'self_bill', creditNote });
      const control = await generateBookingInvoice(without, { kind: 'self_bill', creditNote });
      const text = concatenatePdfHexText(extractPdfStreamText(supplier.pdfBuffer));
      expect(text).not.toContain('Referral discount');
      expect(text).toBe(concatenatePdfHexText(extractPdfStreamText(control.pdfBuffer)));
      const options = { platform: { country: 'BE' }, creditNote, selfBilling: true };
      expect(buildUblInvoiceXml(booking, 'SUP-1', issuedAt, options)).toBe(buildUblInvoiceXml(without, 'SUP-1', issuedAt, options));
    }
  });

  it('keeps the legacy invoice and UBL exactly unchanged when referral attribution is absent versus zero', async () => {
    const { buildUblInvoiceXml, buildUblCreditNoteXml } = await import('../../services/invoiceArtifacts');
    const modern = bookingFor(100, 0, 5, 7);
    const legacy = structuredClone(modern);
    delete legacy.payment.discount.referralDiscountAmount;
    for (const creditNote of [false, true]) {
      const oldPdf = await generateBookingInvoice(legacy, { kind: 'customer', creditNote });
      const newPdf = await generateBookingInvoice(modern, { kind: 'customer', creditNote });
      expect(extractPdfStreamText(newPdf.pdfBuffer)).toBe(extractPdfStreamText(oldPdf.pdfBuffer));
      const build = creditNote ? buildUblCreditNoteXml : buildUblInvoiceXml;
      expect(build(modern, 'FIX-1', issuedAt, { selfBilling: false, platform: { country: 'BE' } })).toBe(build(legacy, 'FIX-1', issuedAt, { selfBilling: false, platform: { country: 'BE' } }));
    }
  });
});
