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

import { buildUblInvoiceXml } from "../../services/invoiceArtifacts";
import { generateBookingInvoice } from "../../services/invoiceGenerator";

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
    offset = endOffset + marker.length;
  }
  return parts.join("\n");
};

const concatenatePdfHexText = (streamText: string): string =>
  [...streamText.matchAll(/<([0-9a-f]+)>/gi)]
    .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
    .join("");

const pdfText = async (booking: any, kind: "customer" | "self_bill"): Promise<string> => {
  const { pdfBuffer } = await generateBookingInvoice(booking, { kind });
  return concatenatePdfHexText(extractPdfStreamText(pdfBuffer));
};

const baseBooking = (payment: any, extra: any = {}): any => ({
  _id: "booking-ws2",
  bookingNumber: "BK-WS2",
  location: { address: "Rue de la Loi 1", postalCode: "1000", city: "Brussels", country: "BE" },
  customer: { name: "Customer", email: "customer@example.com", location: { country: "BE" } },
  professional: { name: "Professional", businessInfo: { country: "BE" } },
  quote: { amount: 300, description: "Service", currency: "EUR" },
  payment: {
    currency: "EUR",
    reverseCharge: false,
    vatRate: 21,
    ...payment,
  },
  __supplierVatDecision: { reverseCharge: false, appliedRate: 21 },
  ...extra,
});

describe("partial-refund invoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformSettings.mockResolvedValue({
      companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
      companyVatNumber: "BE0123456789",
      commissionPercent: 10,
    });
    mocks.invoiceSequence.mockResolvedValue({ value: 1 });
  });

  const refundedPayment = {
    netAmount: 100,
    vatAmount: 21,
    totalWithVat: 121,
    status: "partially_refunded",
    refundAmount: 21,
    refundReason: "Professional no-show",
    refundedAt: new Date("2026-10-29T00:00:00Z"),
  };

  it("reduces the customer invoice and shows refund facts", async () => {
    const text = await pdfText(
      baseBooking(refundedPayment, { cancellation: { adminResolutionNote: "Admin approved partial" } }),
      "customer",
    );
    expect(text).toContain("Original total");
    expect(text).toContain("121.00");
    expect(text).toContain("Refund");
    expect(text).toContain("Professional no-show");
    expect(text).toContain("Admin approved partial");
    // Remaining total: 100.00
    expect(text).toContain("100.00");
  });

  it("reconciles PDF and UBL to the retained payment after exactly one refund", async () => {
    const booking = baseBooking({ ...refundedPayment, refundAmount: 24.2 });
    const text = await pdfText(booking, "customer");
    const xml = buildUblInvoiceXml(booking, "FIX-REFUND", new Date(), { selfBilling: false, platform: { name: "Fixtract", country: "BE" } });
    const retained = booking.payment.totalWithVat - booking.payment.refundAmount;
    expect(retained).toBe(96.8);
    expect(text).toContain(retained.toFixed(2));
    expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="EUR">${retained.toFixed(2)}</cbc:TaxInclusiveAmount>`);
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="EUR">80.00</cbc:TaxExclusiveAmount>');
  });

  it("reduces the supplier invoice by the same remainder", async () => {
    const text = await pdfText(baseBooking(refundedPayment), "self_bill");
    expect(text).toContain("Refund");
    // 300 * (100/121) = 247.93 net, +21% VAT = 300.00
    expect(text).toContain("247.93");
    expect(text).toContain("300.00");
  });
});

describe("dispute-resolved extra costs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformSettings.mockResolvedValue({
      companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
      companyVatNumber: "BE0123456789",
      commissionPercent: 10,
    });
    mocks.invoiceSequence.mockResolvedValue({ value: 1 });
  });

  const extraCostBooking = (extraCostTotal: number) =>
    baseBooking(
      {
        netAmount: 100,
        vatAmount: 21,
        totalWithVat: 121,
        status: "completed",
        extraCostCustomerNetAmount: 88,
        extraCostVatAmount: 18.48,
        extraCostAmount: 106.48,
        extraCostCustomerDiscount: 0,
      },
      {
        extraCosts: [{ name: "Extra work", amount: 80, justification: "more work", type: "other" }],
        extraCostTotal,
      },
    );

  it.each([50, 0])("reconciles commissioned extra costs after admin resolution to %s", async (resolved) => {
    const booking = { ...extraCostBooking(resolved), __commissionPercent: 10 };
    const expected = 121 + 106.48 * resolved / 80;
    const text = await pdfText(booking, "customer");
    const xml = buildUblInvoiceXml(booking, "FIX-EXTRA", new Date(), { selfBilling: false, platform: { name: "Fixtract", country: "BE" } });
    expect(text).toContain(expected.toFixed(2));
    expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="EUR">${expected.toFixed(2)}</cbc:TaxInclusiveAmount>`);
    if (resolved === 0) expect(xml).not.toContain("Extra cost:");
  });

  it("renders the reduced amount on both invoices (80 -> 50)", async () => {
    // Customer: 121 + 106.48 * 50/80 (66.55) = 187.55
    const customerText = await pdfText(extraCostBooking(50), "customer");
    expect(customerText).toContain("187.55");
    // Supplier: 300 + 50 = 350 net, +21% = 423.50
    const supplierText = await pdfText(extraCostBooking(50), "self_bill");
    expect(supplierText).toContain("423.50");
    expect(supplierText).toContain("Extra cost");
  });

  it("excludes a fully declined extra cost from both invoices", async () => {
    const customerText = await pdfText(extraCostBooking(0), "customer");
    expect(customerText).not.toContain("Extra cost");
    expect(customerText).toContain("121.00");
    const supplierText = await pdfText(extraCostBooking(0), "self_bill");
    expect(supplierText).not.toContain("Extra cost");
    expect(supplierText).toContain("363.00");
  });
});

describe("quotation milestone bookings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformSettings.mockResolvedValue({
      companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
      companyVatNumber: "BE0123456789",
      commissionPercent: 10,
    });
    mocks.invoiceSequence.mockResolvedValue({ value: 1 });
  });

  const milestoneBooking = () =>
    baseBooking(
      {
        // Last milestone slice only: 200 * 1.1 = 220 net
        netAmount: 220,
        vatAmount: 46.2,
        totalWithVat: 266.2,
        status: "completed",
        discount: { totalDiscount: 0, originalAmount: 220 },
      },
      {
        __settledPayments: [
          { milestoneIndex: 0, status: "completed", stripePaymentIntentId: "pi_first", netAmount: 165, vatAmount: 34.65, totalWithVat: 199.65, professionalPayout: 150 },
          { milestoneIndex: 1, status: "completed", stripePaymentIntentId: "pi_second", netAmount: 220, vatAmount: 46.2, totalWithVat: 266.2, professionalPayout: 200 },
        ],
        milestonePayments: [
          { title: "Deposit", amount: 100, order: 0, status: "paid", dueCondition: "on_start" },
          { title: "Balance", amount: 200, order: 1, status: "paid", dueCondition: "on_start" },
        ],
        selectedExtraOptions: [{ extraOptionId: "opt1", bookedPrice: 50 }],
        currentQuoteVersion: 1,
        quoteVersions: [
          {
            version: 1,
            totalAmount: 300,
            description: "Service",
            pricingLines: [{ description: "Service", price: 300, vatRate: 21 }],
          },
        ],
      },
    );

  it("bills the full milestone scope plus options on the customer invoice", async () => {
    // (100 + 200 + 50) * 1.1 = 385 net, +21% = 465.85 — not the 266.20 slice.
    const text = await pdfText(milestoneBooking(), "customer");
    expect(text).toContain("465.85");
    expect(text).not.toContain("266.20");
  });

  it("bills the full professional scope on the supplier invoice", async () => {
    // 300 + 50 = 350 net, +21% = 423.50
    const text = await pdfText(milestoneBooking(), "self_bill");
    expect(text).toContain("423.50");
  });

  it("keeps the options when only the last-slice breakdown is stored", async () => {
    const booking = milestoneBooking();
    delete booking.quoteVersions;
    booking.payment.vatBreakdown = [
      { description: "Balance", netAmount: 220, vatRate: 21, vatAmount: 46.2 },
    ];
    // Full scope still billed: 465.85, options present, no bogus discount plug.
    const text = await pdfText(booking, "customer");
    expect(text).toContain("465.85");
    expect(text).toContain("Option");
    expect(text).not.toContain("Payment discount adjustment");
  });
});

describe('recorded settlement PDF/UBL reconciliation', () => {
  beforeEach(() => {
    mocks.platformSettings.mockResolvedValue({
      companyAddress: { name: 'Fixtract', country: 'BE' }, commissionPercent: 20,
    });
    mocks.invoiceSequence.mockResolvedValue({ value: 1 });
  });
  const settled = (index: number, netAmount: number, vatAmount: number, professionalPayout: number) => ({
    milestoneIndex: index, stripePaymentIntentId: `pi_settled_${index}`, status: 'completed',
    netAmount, vatAmount, totalWithVat: +(netAmount + vatAmount).toFixed(2), professionalPayout, vatRate: 21,
  });
  it.each([
    { name: '#5 earlier discounts', rows: [settled(0, 450, 94.5, 480), settled(1, 500, 105, 500)], total: 1149.5,
      ledger: [{ paymentIntentId: 'pi_settled_0', totalDiscount: 50, repeatBuyerAmount: 20, codeDiscountAmount: 30 }],
    },
    { name: '#6 changed commission', rows: [settled(0, 550, 115.5, 500), settled(1, 550, 115.5, 500)], total: 1331, ledger: [] },
    { name: '#6 independent VAT rounding', rows: [settled(0, 10.03, 2.11, 10.03), settled(1, 10.03, 2.11, 10.03)], total: 24.28, ledger: [] },
  ])('reconciles $name to the sum actually collected', async ({ rows, total, ledger }) => {
    const booking = baseBooking(rows[1], { status: 'completed', __settledPayments: rows, paymentDiscountLedger: ledger,
      milestonePayments: rows.map((row, order) => ({ amount: row.professionalPayout, order, status: 'paid' })),
    });
    expect(rows.reduce((sum, row) => sum + row.totalWithVat, 0)).toBeCloseTo(total, 2);
    const text = await pdfText(booking, 'customer');
    const xml = buildUblInvoiceXml(booking, 'FIX-SETTLED', new Date(), { selfBilling: false, platform: { country: 'BE' } });
    expect(text.replaceAll(',', '')).toContain(total.toFixed(2));
    expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="EUR">${total.toFixed(2)}</cbc:TaxInclusiveAmount>`);
    const net = rows.reduce((sum, row) => sum + row.netAmount, 0);
    expect(xml).toContain(`<cbc:TaxExclusiveAmount currencyID="EUR">${net.toFixed(2)}</cbc:TaxExclusiveAmount>`);
    const vat = rows.reduce((sum, row) => sum + row.vatAmount, 0);
    const taxSubtotals = [...xml.matchAll(/<cac:TaxSubtotal>[\s\S]*?<cbc:TaxAmount[^>]*>([^<]+)<\/cbc:TaxAmount>/g)]
      .reduce((sum, match) => sum + Number(match[1]), 0);
    expect(taxSubtotals).toBeCloseTo(vat, 2);
    const supplierNet = rows.reduce((sum, row) => sum + row.professionalPayout, 0);
    const supplierTotal = +(supplierNet + Math.round(supplierNet * 21) / 100).toFixed(2);
    expect((await pdfText(booking, 'self_bill')).replaceAll(',', '')).toContain(supplierTotal.toFixed(2));
    expect(buildUblInvoiceXml(booking, 'SUP-SETTLED', new Date(), { selfBilling: true, platform: { country: 'BE' } }))
      .toContain(`<cbc:TaxInclusiveAmount currencyID="EUR">${supplierTotal.toFixed(2)}</cbc:TaxInclusiveAmount>`);
  });
  it('#4 reconciles cancellation invoices to retained work without unpaid future milestones', async () => {
    const row = { ...settled(0, 100, 0, 100), vatRate: 0, reverseCharge: true };
    const booking = baseBooking({ ...row, status: 'partially_refunded', refundAmount: 25 }, {
      status: 'cancelled', quote: { amount: 200, description: 'Service' }, __settledPayments: [row],
      __supplierVatDecision: { reverseCharge: true, appliedRate: 0 },
      milestonePayments: [{ order: 0, amount: 100, status: 'paid' }, { order: 1, amount: 100, status: 'pending' }],
    });
    for (const selfBilling of [false, true]) {
      expect(await pdfText(booking, selfBilling ? 'self_bill' : 'customer')).toContain('75.00');
      expect(buildUblInvoiceXml(booking, 'SETTLEMENT', new Date(), { selfBilling, platform: { country: 'BE' } }))
        .toContain('<cbc:TaxInclusiveAmount currencyID="EUR">75.00</cbc:TaxInclusiveAmount>');
    }
  });
});
