import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as InvoiceArtifacts from "../../services/invoiceArtifacts";

let buildUblInvoiceXml: typeof InvoiceArtifacts.buildUblInvoiceXml;

beforeAll(async () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_repeat_buyer_ubl");
  ({ buildUblInvoiceXml } = await import("../../services/invoiceArtifacts"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const platform = { name: "Fixtract", vatNumber: "BE1002103337", country: "BE" };

// Professional price 250, 10% commission -> customer 275. Repeat-buyer 5%
// (13.75) -> discounted net 261.25. VAT 21% on the commissioned,
// discounted net: 54.86. Payable: 316.11.
const repeatBuyerBooking = {
  bookingNumber: "BK-2026-000200",
  quote: { amount: 250, description: "Service" },
  quoteVersions: [],
  payment: {
    currency: "EUR",
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

describe("25a/25b — repeat-buyer discount in the UBL invoice", () => {
  it("shows the full-price first line with the discount on its own line", () => {
    const xml = buildUblInvoiceXml(repeatBuyerBooking, "FIX-2026-000200", new Date("2026-10-15T00:00:00Z"), {
      selfBilling: false,
      platform,
    });
    expect(xml).toContain("Repeat buyer discount");
    expect(xml).toMatch(/<cbc:LineExtensionAmount currencyID="EUR">275\.00<\/cbc:LineExtensionAmount>/);
    expect(xml).toMatch(/<cbc:LineExtensionAmount currencyID="EUR">-13\.75<\/cbc:LineExtensionAmount>/);
    // Payable total is what was charged: 261.25 + 54.86.
    expect(xml).toMatch(/<cbc:TaxExclusiveAmount currencyID="EUR">261\.25<\/cbc:TaxExclusiveAmount>/);
    expect(xml).toMatch(/<cbc:PayableAmount currencyID="EUR">316\.11<\/cbc:PayableAmount>/);
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
    const discountLines = [...xml.matchAll(/<cac:InvoiceLine>[\s\S]*?Repeat buyer discount[\s\S]*?<\/cac:InvoiceLine>/g)];
    expect(discountLines.length).toBe(2);
    // Lines still reconcile: 200 - 20 net, 24.30 VAT, 204.30 payable.
    expect(xml).toMatch(/<cbc:TaxExclusiveAmount currencyID="EUR">180\.00<\/cbc:TaxExclusiveAmount>/);
    expect(xml).toMatch(/<cbc:PayableAmount currencyID="EUR">204\.30<\/cbc:PayableAmount>/);
  });
});
