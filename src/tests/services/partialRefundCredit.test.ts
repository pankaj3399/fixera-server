import { beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

const mocks = vi.hoisted(() => ({
  activeClaim: undefined as string | undefined,
  platformSettings: vi.fn(),
  invoiceSequence: vi.fn(),
  bookingFindById: vi.fn(),
  bookingFindOneAndUpdate: vi.fn(),
  bookingUpdateOne: vi.fn(),
  paymentFindOneAndUpdate: vi.fn(),
  paymentFind: vi.fn(),
  upload: vi.fn(),
  peppol: vi.fn(),
  notify: vi.fn(),
  presign: vi.fn(),
}));

vi.mock("../../models/platformSettings", () => ({
  default: { getCurrentConfig: mocks.platformSettings },
}));
vi.mock("../../models/invoiceSequence", () => ({
  default: { findOneAndUpdate: mocks.invoiceSequence },
}));
vi.mock("../../models/booking", () => ({
  default: {
    findById: (...args: unknown[]) => mocks.bookingFindById(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.bookingFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mocks.bookingUpdateOne(...args),
  },
}));
vi.mock("../../models/payment", () => ({
  default: {
    find: (...args: unknown[]) => mocks.paymentFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.paymentFindOneAndUpdate(...args),
    findByIdAndUpdate: vi.fn(),
  },
}));
vi.mock("../../utils/s3Upload", () => ({
  uploadBufferToS3: (...args: unknown[]) => mocks.upload(...args),
  downloadBufferFromS3: async () => null,
  presignS3Url: (...args: unknown[]) => mocks.presign(...args),
}));
vi.mock("../../services/peppolDispatch", () => ({
  maybeDispatchPeppolInvoice: (...args: unknown[]) => mocks.peppol(...args),
}));
vi.mock("../../utils/notifications/notify", () => ({ notify: (...args: unknown[]) => mocks.notify(...args) }));

import {
  buildPartialRefundCreditInput,
  buildPartialRefundDescription,
  ensurePartialRefundCreditArtifacts,
} from "../../services/invoiceArtifacts";

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

const pdfText = (pdf: Buffer): string =>
  [...extractPdfStreamText(pdf).matchAll(/<([0-9a-f]+)>/gi)]
    .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
    .join("");

const basePayment = (overrides: Record<string, unknown> = {}) => ({
  netAmount: 100,
  vatAmount: 21,
  vatRate: 21,
  totalWithVat: 121,
  currency: "EUR",
  reverseCharge: false,
  status: "partially_refunded",
  refundAmount: 21,
  refundReason: "Professional no-show",
  refundedAt: new Date("2026-10-29T00:00:00Z"),
  invoiceNumber: "FIX-2026-000001",
  invoiceUrl: "s3://bucket/FIX-2026-000001.pdf",
  supplierInvoiceNumber: "SUP-2026-000001",
  supplierInvoiceUrl: "s3://bucket/SUP-2026-000001.pdf",
  ...overrides,
});

const baseBooking = (payment: Record<string, unknown>) => ({
  _id: "booking-1",
  bookingNumber: "BK-1",
  location: { address: "Rue de la Loi 1", postalCode: "1000", city: "Brussels", country: "BE" },
  customer: { _id: "cust", name: "Customer", email: "customer@example.com", location: { country: "BE" } },
  professional: { _id: "pro", name: "Professional", businessInfo: { country: "BE" } },
  project: { title: "Service" },
  quote: { amount: 300, description: "Service", currency: "EUR" },
  quoteVersions: [
    { version: 1, totalAmount: 300, description: "Service", pricingLines: [{ description: "Service", price: 300, vatRate: 21 }] },
  ],
  currentQuoteVersion: 1,
  payment,
  cancellation: { adminResolutionNote: "Admin approved partial" },
  __supplierVatDecision: { reverseCharge: false, appliedRate: 21 },
});

const chainQuery = (doc: any) => {
  if (doc?.payment && mocks.activeClaim !== undefined) doc.payment.creditNoteGenerationClaim = mocks.activeClaim;
  const query: Record<string, unknown> = {};
  query.populate = vi.fn(() => query);
  query.select = vi.fn(() => query);
  query.lean = vi.fn(() => Promise.resolve(doc));
  (query as any).then = (resolve: (value: unknown) => unknown) => Promise.resolve(doc).then(resolve);
  return query;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeClaim = undefined;
  mocks.platformSettings.mockResolvedValue({
    companyAddress: { name: "Fixtract", street: "Main 1", city: "Brussels", postalCode: "1000", country: "BE" },
    companyVatNumber: "BE0123456789",
    commissionPercent: 10,
  });
  mocks.invoiceSequence.mockResolvedValue({ value: 7 });
  mocks.upload.mockImplementation(async (buffer: Buffer, key: string) => `s3://bucket/${key}`);
  mocks.peppol.mockResolvedValue({ status: "skipped" });
  mocks.presign.mockResolvedValue(null);
  mocks.notify.mockResolvedValue({ notificationId: "n", emailSent: true, pushSent: false });
  mocks.bookingUpdateOne.mockResolvedValue({});
  mocks.paymentFindOneAndUpdate.mockResolvedValue({});
  mocks.paymentFind.mockReturnValue(chainQuery([]));
  mocks.bookingFindOneAndUpdate.mockImplementation(async (_filter: any, update: any) => {
    mocks.activeClaim = update?.$set?.['payment.creditNoteGenerationClaim'];
    return { _id: 'booking-1' };
  });
});

describe("partial-refund credit builders", () => {
  it("describes the refund once for both documents", () => {
    expect(
      buildPartialRefundDescription({
        amount: 21,
        currency: "EUR",
        date: new Date("2026-10-29T00:00:00Z"),
        reason: "Professional no-show",
        description: "Admin approved partial",
      }),
    ).toBe("Partial refund of 21.00 EUR on 2026-10-29: Professional no-show — Admin approved partial");
  });

  it("builds an exact-amounts credit input referencing the original invoice", () => {
    const input = buildPartialRefundCreditInput({
      side: "customer",
      net: 17.36,
      vat: 3.64,
      vatRate: 20.97,
      reverseCharge: false,
      currency: "EUR",
      relatedInvoiceNumber: "FIX-2026-000001",
      description: "Partial refund of 21.00 EUR",
    });
    expect(input).toMatchObject({
      side: "customer",
      documentType: "credit_note",
      relatedInvoiceNumber: "FIX-2026-000001",
      exactAmounts: true,
      payment: { netAmount: 17.36, vatAmount: 3.64, totalWithVat: 21, currency: "EUR" },
    });
    expect(input.lines).toHaveLength(1);
  });
});

describe("ensurePartialRefundCreditArtifacts", () => {
  it("issues partial FIX+SUP credit notes with metadata and exact amounts", async () => {
    mocks.bookingFindById.mockImplementation(() => chainQuery(baseBooking(basePayment())));

    const outcome = await ensurePartialRefundCreditArtifacts("booking-1");
    expect(outcome).toBe("credited");

    const sets = mocks.bookingUpdateOne.mock.calls.map((call) => (call[1] as any)?.$set || {});
    const merged = Object.assign({}, ...sets);
    expect(String(merged["payment.creditNoteNumber"])).toMatch(/^FIX-CN-/);
    expect(String(merged["payment.supplierCreditNoteNumber"])).toMatch(/^SUP-CN-/);
    expect(merged["payment.creditNoteRelatedInvoiceNumber"]).toBe("FIX-2026-000001");
    expect(merged["payment.supplierCreditNoteRelatedInvoiceNumber"]).toBe("SUP-2026-000001");

    const uploads = mocks.upload.mock.calls.map((call) => call as unknown[]);
    const pdfBuffers = uploads.filter((call) => String(call[1]).endsWith(".pdf")).map((call) => call[0] as Buffer);
    const xmlTexts = uploads
      .filter((call) => String(call[1]).endsWith(".xml"))
      .map((call) => (call[0] as Buffer).toString("utf8"));
    expect(pdfBuffers).toHaveLength(2);
    expect(xmlTexts).toHaveLength(2);

    const fixText = pdfText(pdfBuffers[0]);
    expect(fixText).toContain("CREDIT NOTE");
    expect(fixText).toContain("21.00");
    expect(fixText).toContain("17.36");
    expect(fixText).toContain("FIX-2026-000001");
    expect(fixText).toContain("Partial refund of 21.00 EUR");
    expect(fixText).toContain("Professional no-show");
    expect(fixText).not.toContain("Original total");

    const fixXml = xmlTexts.find((xml) => xml.includes("FIX-CN-")) || "";
    expect(fixXml).toContain("CreditNote");
    expect(fixXml).toContain("Partial refund of 21.00 EUR");
    expect(fixXml).toContain("FIX-2026-000001");
    expect(fixXml).toContain("17.36");
    expect(fixXml).toContain("21.00");

    // Supplier credit: same refund fraction of the supplier document (300 + 63 VAT).
    const supText = pdfText(pdfBuffers[1]);
    expect(supText).toContain("SUP-2026-000001");
    expect(supText).toContain("63.00");
    expect(supText).toContain("52.07");
  });

  it("is idempotent: a retry never issues a second credit note", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(
        baseBooking(
          basePayment({
            invoiceSettlementBasis: {
              customer: { netAmount: 100, vatAmount: 21, totalWithVat: 121, refundAmount: 0 },
              supplier: { netAmount: 300, vatAmount: 63, totalWithVat: 363, refundAmount: 0 },
            },
            refundCreditLedger: [
              { side: 'customer', key: 'legacy-first', refundAmount: 21, netAmount: 17.36, vatAmount: 3.64 },
              { side: 'supplier', key: 'legacy-first', refundAmount: 21, netAmount: 52.07, vatAmount: 10.93 },
            ],
            creditNoteNumber: "FIX-CN-2026-000007",
            creditNoteUrl: "s3://bucket/FIX-CN-2026-000007.pdf",
            supplierCreditNoteNumber: "SUP-CN-2026-000007",
            supplierCreditNoteUrl: "s3://bucket/SUP-CN-2026-000007.pdf",
          })
        )
      )
    );

    const outcome = await ensurePartialRefundCreditArtifacts("booking-1");
    expect(outcome).toBe("credited");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.invoiceSequence).not.toHaveBeenCalled();
    expect(mocks.bookingFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("completes only the missing side when a retry left a half-finished pair", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(
        baseBooking(
          basePayment({
            invoiceSettlementBasis: {
              customer: { netAmount: 100, vatAmount: 21, totalWithVat: 121, refundAmount: 0 },
              supplier: { netAmount: 300, vatAmount: 63, totalWithVat: 363, refundAmount: 0 },
            },
            refundCreditLedger: [
              { side: 'customer', key: 'legacy-first', refundAmount: 21, netAmount: 17.36, vatAmount: 3.64 },
            ],
            creditNoteNumber: "FIX-CN-2026-000007",
            creditNoteUrl: "s3://bucket/FIX-CN-2026-000007.pdf",
          })
        )
      )
    );

    const outcome = await ensurePartialRefundCreditArtifacts("booking-1");
    expect(outcome).toBe("credited");
    const pdfUploads = mocks.upload.mock.calls.filter((call) => String(call[1]).endsWith(".pdf"));
    expect(pdfUploads).toHaveLength(1);
    const sets = mocks.bookingUpdateOne.mock.calls.map((call) => (call[1] as any)?.$set || {});
    const merged = Object.assign({}, ...sets);
    expect(merged["payment.supplierCreditNoteNumber"]).toMatch(/^SUP-CN-/);
    expect(merged["payment.creditNoteNumber"]).toBeUndefined();
  });

  it('#3 creates a second credit for only the new refund delta and keeps retry idempotency', async () => {
    const doc = baseBooking(basePayment({ refundAmount: 36.3,
      creditNoteNumber: 'FIX-CN-FIRST', creditNoteUrl: 's3://first.pdf',
      supplierCreditNoteNumber: 'SUP-CN-FIRST', supplierCreditNoteUrl: 's3://supplier-first.pdf',
      invoiceSettlementBasis: {
        customer: { netAmount: 100, vatAmount: 21, totalWithVat: 121, refundAmount: 0 },
        supplier: { netAmount: 300, vatAmount: 63, totalWithVat: 363, refundAmount: 0 },
      },
      refundCreditLedger: [
        { side: 'customer', key: 're_first', refundAmount: 24.2, netAmount: 20, vatAmount: 4.2 },
        { side: 'supplier', key: 're_first', refundAmount: 24.2, netAmount: 60, vatAmount: 12.6 },
      ],
    }));
    (doc as any).__settledPayments = [{ status: 'completed', stripePaymentIntentId: 'pi_paid',
      refunds: [{ refundId: 're_first', amount: 24.2, netAmount: 20, vatAmount: 4.2 },
        { refundId: 're_second', amount: 12.1, netAmount: 10, vatAmount: 2.1 }] }];
    mocks.paymentFind.mockReturnValue(chainQuery((doc as any).__settledPayments));
    mocks.bookingFindById.mockImplementation(() => chainQuery(doc));
    mocks.bookingUpdateOne.mockImplementation(async (_filter: any, update: any) => {
      const fact = update.$push?.['payment.refundCreditLedger'];
      if (fact) (doc.payment.refundCreditLedger as any[]).push(fact);
      return { modifiedCount: 1 };
    });
    expect(await ensurePartialRefundCreditArtifacts('booking-1')).toBe('credited');
    const xmls = mocks.upload.mock.calls.filter(call => String(call[1]).endsWith('.xml')).map(call => (call[0] as Buffer).toString());
    expect(xmls).toHaveLength(2);
    expect(xmls[0]).toContain('<cbc:TaxInclusiveAmount currencyID="EUR">-12.10</cbc:TaxInclusiveAmount>');
    expect(xmls[1]).toContain('<cbc:TaxInclusiveAmount currencyID="EUR">-36.30</cbc:TaxInclusiveAmount>');
    mocks.upload.mockClear();
    expect(await ensurePartialRefundCreditArtifacts('booking-1')).toBe('credited');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('#3 credits only the increment after the first refund was included in net invoices', async () => {
    const doc = baseBooking(basePayment({ refundAmount: 36.3,
      invoiceSettlementBasis: {
        customer: { netAmount: 80, vatAmount: 16.8, totalWithVat: 96.8, refundAmount: 24.2 },
        supplier: { netAmount: 240, vatAmount: 50.4, totalWithVat: 290.4, refundAmount: 24.2 },
      },
    }));
    mocks.bookingFindById.mockImplementation(() => chainQuery(doc));
    expect(await ensurePartialRefundCreditArtifacts('booking-1')).toBe('credited');
    const xmls = mocks.upload.mock.calls.filter(call => String(call[1]).endsWith('.xml')).map(call => (call[0] as Buffer).toString());
    expect(xmls[0]).toContain('<cbc:TaxInclusiveAmount currencyID="EUR">-12.10</cbc:TaxInclusiveAmount>');
    expect(xmls[1]).toContain('<cbc:TaxInclusiveAmount currencyID="EUR">-36.30</cbc:TaxInclusiveAmount>');
  });

  it('#3 refuses to guess the covered amount of a legacy credit without facts', async () => {
    mocks.bookingFindById.mockImplementation(() => chainQuery(baseBooking(basePayment({
      creditNoteNumber: 'FIX-CN-LEGACY', creditNoteUrl: 's3://legacy.pdf',
    }))));
    await expect(ensurePartialRefundCreditArtifacts('booking-1')).rejects.toThrow('lack recorded coverage');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('#3 never dispatches a credit after losing its generation claim', async () => {
    const doc = baseBooking(basePayment({ invoiceSettlementBasis: {
      customer: { netAmount: 100, vatAmount: 21, totalWithVat: 121, refundAmount: 0 },
      supplier: { netAmount: 300, vatAmount: 63, totalWithVat: 363, refundAmount: 0 },
    } }));
    mocks.bookingFindById.mockImplementation(() => chainQuery(doc));
    mocks.bookingUpdateOne.mockImplementation(async (_filter: any, update: any) => ({
      modifiedCount: update.$push?.['payment.refundCreditLedger'] ? 0 : 1,
    }));
    await expect(ensurePartialRefundCreditArtifacts('booking-1')).rejects.toThrow('claim expired');
    expect(mocks.peppol).not.toHaveBeenCalled();
  });

  it("returns generate when no invoice exists yet", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(baseBooking(basePayment({ invoiceNumber: undefined, invoiceUrl: undefined, supplierInvoiceNumber: undefined, supplierInvoiceUrl: undefined })))
    );
    expect(await ensurePartialRefundCreditArtifacts("booking-1")).toBe("generate");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("skips full refunds and non-refunds without touching documents", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(baseBooking(basePayment({ status: "refunded", refundAmount: 121 })))
    );
    expect(await ensurePartialRefundCreditArtifacts("booking-1")).toBe("skip");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("credits both original invoice bases when a dust remainder rounds to zero", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(baseBooking(basePayment({ refundAmount: 120.996, refundReason: "Dust" })))
    );

    const outcome = await ensurePartialRefundCreditArtifacts("booking-1");
    expect(outcome).toBe("credited");
    const sets = mocks.bookingUpdateOne.mock.calls.map((call) => (call[1] as any)?.$set || {});
    const merged = Object.assign({}, ...sets);
    expect(String(merged["payment.creditNoteNumber"])).toMatch(/^FIX-CN-/);
    expect(merged["payment.supplierCreditNoteNumber"]).toMatch(/^SUP-CN-/);
    const pdfUploads = mocks.upload.mock.calls.filter((call) => String(call[1]).endsWith(".pdf"));
    expect(pdfUploads).toHaveLength(2);
    expect(pdfText(pdfUploads[0][0] as Buffer)).toContain("121.00");
    expect(pdfText(pdfUploads[1][0] as Buffer)).toContain("363.00");
  });

  it('returns busy when another credit worker owns the claim', async () => {
    mocks.bookingFindById.mockImplementation(() => chainQuery(baseBooking(basePayment())));
    mocks.bookingFindOneAndUpdate.mockResolvedValueOnce(null);
    expect(await ensurePartialRefundCreditArtifacts('booking-1')).toBe('busy');
    expect(mocks.invoiceSequence).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('does not reserve credit numbers or upload when the claim is lost before generation', async () => {
    mocks.bookingFindById.mockImplementation(() => chainQuery(baseBooking(basePayment())));
    mocks.platformSettings.mockImplementationOnce(async () => {
      mocks.activeClaim = 'another-worker';
      return { companyAddress: { country: 'BE' }, companyVatNumber: 'BE0123456789' };
    });
    await expect(ensurePartialRefundCreditArtifacts('booking-1')).rejects.toThrow('claim expired');
    expect(mocks.invoiceSequence).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.peppol).not.toHaveBeenCalled();
  });

  it('allows slow credit work a fifteen-minute lease rather than reclaiming after one minute', async () => {
    const claim = `GENERATING-CN-${Date.now() - 120000}-slow`;
    mocks.bookingFindById.mockImplementation(() => chainQuery(baseBooking(basePayment({ creditNoteGenerationClaim: claim }))));
    mocks.bookingFindOneAndUpdate.mockResolvedValueOnce(null);
    expect(await ensurePartialRefundCreditArtifacts('booking-1')).toBe('busy');
    expect(mocks.bookingUpdateOne.mock.calls.some(([, update]) => update.$unset?.['payment.creditNoteGenerationClaim'] !== undefined)).toBe(false);
  });

});
