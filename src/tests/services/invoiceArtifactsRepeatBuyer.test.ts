import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

import type * as InvoiceArtifacts from "../../services/invoiceArtifacts";
import type * as InvoiceGenerator from "../../services/invoiceGenerator";
import { paymentConfirmationAmount } from "../../utils/paymentConfirmationAmount";

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

let buildUblInvoiceXml: typeof InvoiceArtifacts.buildUblInvoiceXml;
let generateBookingInvoice: typeof InvoiceGenerator.generateBookingInvoice;

beforeAll(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_repeat_buyer_ubl");
  ({ buildUblInvoiceXml } = await import("../../services/invoiceArtifacts"));
  ({ generateBookingInvoice } = await import("../../services/invoiceGenerator"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  mocks.platformSettings.mockResolvedValue({
    companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
    companyVatNumber: "BE1002103337",
  });
  mocks.invoiceSequence.mockResolvedValue({ value: 1 });
});

const platform = { name: "Fixtract", vatNumber: "BE1002103337", country: "BE" };
const cents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const amountOf = (xml: string, tag: string): number | undefined => {
  const match = xml.match(new RegExp(`<cbc:${tag}[^>]*>([^<]+)</cbc:${tag}>`));
  return match ? Number(match[1]) : undefined;
};

/**
 * Parses the UBL invoice and checks the EN16931 arithmetic a Peppol access
 * point validates: no negative item price (BR-27), line = qty × price,
 * BR-CO-10/11/13/14/15 totals, and the VAT breakdown per rate.
 */
const expectCompliantUbl = (xml: string) => {
  const lines = [...xml.matchAll(/<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/g)].map(([, body]) => ({
    quantity: Number(body.match(/<cbc:InvoicedQuantity[^>]*>([^<]+)</)![1]),
    amount: Number(body.match(/<cbc:LineExtensionAmount[^>]*>([^<]+)</)![1]),
    price: Number(body.match(/<cbc:PriceAmount[^>]*>([^<]+)</)![1]),
    rate: Number(body.match(/<cac:ClassifiedTaxCategory>[\s\S]*?<cbc:Percent>([^<]+)</)![1]),
    description: body.match(/<cbc:Description>([^<]*)</)![1],
  }));
  const allowances = [...xml.matchAll(/<cac:AllowanceCharge>([\s\S]*?)<\/cac:AllowanceCharge>/g)].map(([, body]) => ({
    chargeIndicator: body.match(/<cbc:ChargeIndicator>([^<]+)</)![1],
    reasonCode: body.match(/<cbc:AllowanceChargeReasonCode>([^<]+)</)?.[1],
    reason: body.match(/<cbc:AllowanceChargeReason>([^<]+)</)?.[1],
    amount: Number(body.match(/<cbc:Amount[^>]*>([^<]+)</)![1]),
    rate: Number(body.match(/<cbc:Percent>([^<]+)</)![1]),
  }));
  const subtotals = [...xml.matchAll(/<cac:TaxSubtotal>([\s\S]*?)<\/cac:TaxSubtotal>/g)].map(([, body]) => ({
    taxable: Number(body.match(/<cbc:TaxableAmount[^>]*>([^<]+)</)![1]),
    tax: Number(body.match(/<cbc:TaxAmount[^>]*>([^<]+)</)![1]),
    rate: Number(body.match(/<cbc:Percent>([^<]+)</)![1]),
  }));
  const monetary = xml.match(/<cac:LegalMonetaryTotal>([\s\S]*?)<\/cac:LegalMonetaryTotal>/)![1];
  const totalLineExtension = amountOf(monetary, "LineExtensionAmount")!;
  const taxExclusive = amountOf(monetary, "TaxExclusiveAmount")!;
  const taxInclusive = amountOf(monetary, "TaxInclusiveAmount")!;
  const allowanceTotal = amountOf(monetary, "AllowanceTotalAmount") ?? 0;
  const taxTotal = Number(xml.match(/<cac:TaxTotal>\s*<cbc:TaxAmount[^>]*>([^<]+)</)![1]);

  // BR-27: an item net price is never negative; each line multiplies back.
  for (const line of lines) {
    expect(line.price).toBeGreaterThanOrEqual(0);
    expect(cents(line.quantity * line.price)).toBe(cents(line.amount));
  }
  for (const allowance of allowances) {
    expect(allowance.chargeIndicator).toBe("false");
    expect(allowance.reasonCode).toBe("95");
    expect(allowance.reason).toBeTruthy();
    expect(allowance.amount).toBeGreaterThan(0);
  }
  // BR-CO-10, BR-CO-11, BR-CO-13, BR-CO-15.
  expect(cents(lines.reduce((sum, line) => sum + line.amount, 0))).toBe(cents(totalLineExtension));
  expect(cents(allowances.reduce((sum, allowance) => sum + allowance.amount, 0))).toBe(cents(allowanceTotal));
  expect(cents(totalLineExtension - allowanceTotal)).toBe(cents(taxExclusive));
  expect(cents(taxExclusive + taxTotal)).toBe(cents(taxInclusive));
  // BR-CO-14 and the per-rate breakdown: lines minus allowances at that rate.
  expect(cents(subtotals.reduce((sum, subtotal) => sum + subtotal.tax, 0))).toBe(cents(taxTotal));
  expect(new Set(subtotals.map((subtotal) => subtotal.rate)).size).toBe(subtotals.length);
  for (const subtotal of subtotals) {
    const linesAtRate = lines.filter((line) => line.rate === subtotal.rate).reduce((sum, line) => sum + line.amount, 0);
    const allowancesAtRate = allowances.filter((entry) => entry.rate === subtotal.rate).reduce((sum, entry) => sum + entry.amount, 0);
    expect(cents(linesAtRate - allowancesAtRate)).toBe(cents(subtotal.taxable));
  }
  return { lines, allowances, subtotals, totalLineExtension, taxExclusive, taxInclusive, allowanceTotal, taxTotal };
};

const extractPdfText = (pdf: Buffer): string => {
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
      // Not a text stream.
    }
    offset = endOffset + marker.length;
  }
  return [...parts.join("\n").matchAll(/<([0-9a-f]+)>/gi)]
    .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
    .join("");
};
const pdfText = async (booking: any, kind: "customer" | "self_bill") =>
  extractPdfText((await generateBookingInvoice(structuredClone(booking), { kind })).pdfBuffer);

// Professional price 250, 10% commission -> customer 275. Repeat-buyer 5%
// (13.75) -> discounted net 261.25. VAT 21% on the commissioned,
// discounted net: 54.86. Payable: 316.11.
const repeatBuyerBooking = {
  _id: "booking-repeat-buyer",
  bookingNumber: "BK-2026-000200",
  quote: { amount: 250, description: "Service" },
  quoteVersions: [],
  payment: {
    currency: "EUR",
    status: "completed",
    vatRate: 21,
    reverseCharge: false,
    netAmount: 261.25,
    amount: 261.25,
    vatAmount: 54.86,
    totalWithVat: 316.11,
    vatBreakdown: [
      { description: "Service", netAmount: 261.25, vatRate: 21, vatAmount: 54.86, totalAmount: 316.11 },
    ],
    discount: { repeatBuyerPercentage: 5, repeatBuyerAmount: 13.75, totalDiscount: 13.75, originalAmount: 275, finalAmount: 261.25 },
  },
  customer: { customerType: "individual", name: "Customer", location: { country: "BE" } },
  professional: { name: "Supplier", businessInfo: { vatNumber: "BE0123456848", country: "BE" } },
};

// The professional absorbs the discount on their own price: 13.75 / 1.10 =
// 12.50, exactly as calculateDiscountedPayouts reduces the payout.
const supplierBooking = (payment: Record<string, unknown> = {}) => ({
  ...repeatBuyerBooking,
  __commissionPercent: 10,
  __supplierVatDecision: { reverseCharge: false, appliedRate: 21 },
  payment: { ...repeatBuyerBooking.payment, ...payment },
});

describe("25a/25b — repeat-buyer discount in the customer UBL invoice", () => {
  it("shows the full-price first line and the discount as a document-level allowance", () => {
    const xml = buildUblInvoiceXml(repeatBuyerBooking, "FIX-2026-000200", new Date("2026-10-15T00:00:00Z"), {
      selfBilling: false,
      platform,
    });
    const facts = expectCompliantUbl(xml);
    expect(facts.lines.map((line) => line.amount)).toEqual([275]);
    expect(facts.allowances).toEqual([
      expect.objectContaining({ reason: "Repeat buyer discount", amount: 13.75, rate: 21 }),
    ]);
    expect(facts.totalLineExtension).toBe(275);
    expect(facts.allowanceTotal).toBe(13.75);
    expect(facts.subtotals).toEqual([{ taxable: 261.25, tax: 54.86, rate: 21 }]);
    // Payable total is what was charged: 261.25 + 54.86.
    expect(xml).toMatch(/<cbc:TaxExclusiveAmount currencyID="EUR">261\.25<\/cbc:TaxExclusiveAmount>/);
    expect(xml).toMatch(/<cbc:TaxInclusiveAmount currencyID="EUR">316\.11<\/cbc:TaxInclusiveAmount>/);
    // UBL element order: allowances sit between the parties and the TaxTotal.
    expect(xml.indexOf("</cac:AccountingCustomerParty>")).toBeLessThan(xml.indexOf("<cac:AllowanceCharge>"));
    expect(xml.indexOf("</cac:AllowanceCharge>")).toBeLessThan(xml.indexOf("<cac:TaxTotal>"));
    expect(xml).not.toMatch(/<cbc:PriceAmount[^>]*>-/);
  });

  it("keeps the discount visible per VAT rate when rates are mixed", () => {
    const mixed = {
      ...repeatBuyerBooking,
      bookingNumber: "BK-2026-000201",
      payment: {
        currency: "EUR",
        vatRate: 21,
        reverseCharge: false,
        netAmount: 180,
        amount: 180,
        vatAmount: 24.3,
        totalWithVat: 204.3,
        vatBreakdown: [
          { description: "Work", netAmount: 90, vatRate: 21, vatAmount: 18.9, totalAmount: 108.9 },
          { description: "Materials", netAmount: 90, vatRate: 6, vatAmount: 5.4, totalAmount: 95.4 },
        ],
        discount: { repeatBuyerPercentage: 10, repeatBuyerAmount: 20, totalDiscount: 20, originalAmount: 200, finalAmount: 180 },
      },
    };
    const xml = buildUblInvoiceXml(mixed, "FIX-2026-000201", new Date("2026-10-15T00:00:00Z"), {
      selfBilling: false,
      platform,
    });
    const facts = expectCompliantUbl(xml);
    expect(facts.allowances.filter((entry) => entry.reason === "Repeat buyer discount")
      .map((entry) => [entry.rate, entry.amount]).sort()).toEqual([[21, 10], [6, 10]]);
    expect([...xml.matchAll(/<cac:InvoiceLine>[\s\S]*?Repeat buyer discount[\s\S]*?<\/cac:InvoiceLine>/g)]).toHaveLength(0);
    expect(facts.subtotals.sort((a, b) => a.rate - b.rate)).toEqual([
      { taxable: 90, tax: 5.4, rate: 6 },
      { taxable: 90, tax: 18.9, rate: 21 },
    ]);
    // Lines still reconcile: 200 - 20 net, 24.30 VAT, 204.30 payable.
    expect(facts.taxExclusive).toBe(180);
    expect(xml).toMatch(/<cbc:PayableAmount currencyID="EUR">204\.30<\/cbc:PayableAmount>/);
  });

  it("states the amount actually paid as the invoice total (PDF, UBL and confirmation email agree)", async () => {
    const paid = paymentConfirmationAmount(repeatBuyerBooking.payment, { amount: 31611, currency: "eur" });
    expect(paid).toBe(316.11);
    const xml = buildUblInvoiceXml(repeatBuyerBooking, "FIX-2026-000202", new Date("2026-10-15T00:00:00Z"), {
      selfBilling: false,
      platform,
    });
    expect(amountOf(xml, "TaxInclusiveAmount")).toBe(paid);
    expect(amountOf(xml, "PrepaidAmount")).toBe(paid);
    expect(amountOf(xml, "PayableAmount")).toBe(0);
    const text = await pdfText(repeatBuyerBooking, "customer");
    expect(text).toContain("275.00");
    expect(text).toContain("Repeat buyer discount");
    expect(text).toContain("13.75");
    expect(text).toContain("TOTAL");
    expect(text).toContain("316.11");
    expect(text).toContain("PAID via Fixtract");
    expect(text).toContain("The total and the amount paid already include the discounts listed above.");
  });
});

describe("25a — repeat-buyer discount on the supplier self-bill", () => {
  it.each([
    ["recorded payout", { professionalPayout: 237.5 }],
    ["legacy row without a recorded payout", {}],
  ])("%s: full-price line, the supplier share as its own discount, net unchanged", async (_label, payment) => {
    const booking = supplierBooking(payment);
    const xml = buildUblInvoiceXml(booking, "SUP-2026-000200", new Date("2026-10-15T00:00:00Z"), {
      selfBilling: true,
      platform,
    });
    const facts = expectCompliantUbl(xml);
    expect(facts.lines.map((line) => line.amount)).toEqual([250]);
    expect(facts.allowances).toEqual([
      expect.objectContaining({ reason: "Repeat buyer discount", amount: 12.5, rate: 21 }),
    ]);
    // Net = payout 237.50 (250 - 12.50); VAT 49.88; total 287.38.
    expect(facts.taxExclusive).toBe(237.5);
    expect(facts.taxTotal).toBe(49.88);
    expect(facts.taxInclusive).toBe(287.38);

    const text = await pdfText(booking, "self_bill");
    expect(text).toContain("250.00");
    // The discount is listed exactly once and deducted exactly once.
    expect(text.split("Repeat buyer discount")).toHaveLength(2);
    expect(text).toContain("12.50");
    expect(text).toContain("49.88");
    expect(text).toContain("287.38");
    expect(text).not.toContain("237.50 ");
    expect(text).not.toContain("13.75");
  });

  it("splits a refund-scaled supplier line without moving the net by a cent", async () => {
    const plain = supplierBooking({ professionalPayout: 237.5 });
    const refunded = supplierBooking({
      professionalPayout: 237.5,
      status: "partially_refunded",
      refundAmount: 100,
      refundReason: "Partial cancellation",
      refundedAt: new Date("2026-10-20T00:00:00Z"),
    });
    const xml = buildUblInvoiceXml(refunded, "SUP-2026-000201", new Date("2026-10-21T00:00:00Z"), {
      selfBilling: true,
      platform,
    });
    const facts = expectCompliantUbl(xml);
    // Scale (316.11 - 100) / 316.11 applied to the discounted net 237.50.
    const scale = 216.11 / 316.11;
    expect(facts.taxExclusive).toBe(Math.round(237.5 * scale * 100) / 100);
    expect(cents(facts.lines[0].amount - facts.allowances[0].amount)).toBe(cents(facts.taxExclusive));
    // Without the refund the split is the plain 250 / 12.50.
    const plainFacts = expectCompliantUbl(buildUblInvoiceXml(plain, "SUP-X", new Date(), { selfBilling: true, platform }));
    expect(plainFacts.allowances[0].amount).toBe(12.5);
  });

  it("adds no discount line without a repeat-buyer discount", () => {
    const booking = supplierBooking({ professionalPayout: 250, discount: undefined, netAmount: 275, totalWithVat: 332.75, vatAmount: 57.75, vatBreakdown: [] });
    const xml = buildUblInvoiceXml(booking, "SUP-2026-000203", new Date(), { selfBilling: true, platform });
    const facts = expectCompliantUbl(xml);
    expect(facts.allowances).toHaveLength(0);
    expect(xml).not.toContain("AllowanceTotalAmount");
    expect(facts.lines.map((line) => line.amount)).toEqual([250]);
  });
});
