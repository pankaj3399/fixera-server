import { describe, expect, it } from "vitest";

/**
 * Mirrors the reclaim predicate used by claimInvoiceGeneration:
 * a GENERATING-* claim with no invoiceUrl is reclaimable.
 */
const canReclaimInvoiceClaim = (payment: {
  invoiceNumber?: string | null;
  invoiceUrl?: string | null;
}) => {
  const number = payment.invoiceNumber;
  const url = payment.invoiceUrl;
  const numberEmpty = number == null || number === "";
  const numberGenerating = typeof number === "string" && number.startsWith("GENERATING-");
  const urlEmpty = url == null || url === "";
  return (numberEmpty || numberGenerating) && urlEmpty;
};

describe("invoice generation claim reclaim", () => {
  it("reclaims abandoned GENERATING claims without a URL", () => {
    expect(
      canReclaimInvoiceClaim({
        invoiceNumber: "GENERATING-1783597446295",
        invoiceUrl: null,
      })
    ).toBe(true);
  });

  it("does not reclaim completed invoices", () => {
    expect(
      canReclaimInvoiceClaim({
        invoiceNumber: "INV-2026-000010",
        invoiceUrl: "https://bucket.s3.amazonaws.com/invoices/x.pdf",
      })
    ).toBe(false);
  });

  it("allows first-time claim when fields are empty", () => {
    expect(canReclaimInvoiceClaim({ invoiceNumber: null, invoiceUrl: null })).toBe(true);
  });
});
