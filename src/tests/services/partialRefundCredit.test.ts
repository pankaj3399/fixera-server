import { beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";

const mocks = vi.hoisted(() => ({
  platformSettings: vi.fn(),
  invoiceSequence: vi.fn(),
  bookingFindById: vi.fn(),
  bookingFindOneAndUpdate: vi.fn(),
  bookingUpdateOne: vi.fn(),
  paymentFindOneAndUpdate: vi.fn(),
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

const chainQuery = (doc: unknown) => {
  const query: Record<string, unknown> = {};
  query.populate = vi.fn(() => query);
  query.select = vi.fn(() => query);
  query.lean = vi.fn(() => Promise.resolve(doc));
  (query as any).then = (resolve: (value: unknown) => unknown) => Promise.resolve(doc).then(resolve);
  return query;
};

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.bookingFindOneAndUpdate.mockImplementation(async () => ({ _id: "booking-1" }));
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
    expect(mocks.bookingFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("completes only the missing side when a retry left a half-finished pair", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(
        baseBooking(
          basePayment({
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

  it("credits the full base on sub-cent dust while skipping the zero supplier share", async () => {
    mocks.bookingFindById.mockImplementation(() =>
      chainQuery(baseBooking(basePayment({ refundAmount: 120.996, refundReason: "Dust" })))
    );

    const outcome = await ensurePartialRefundCreditArtifacts("booking-1");
    expect(outcome).toBe("credited");
    const sets = mocks.bookingUpdateOne.mock.calls.map((call) => (call[1] as any)?.$set || {});
    const merged = Object.assign({}, ...sets);
    expect(String(merged["payment.creditNoteNumber"])).toMatch(/^FIX-CN-/);
    expect(merged["payment.supplierCreditNoteNumber"]).toBeUndefined();
    const pdfUploads = mocks.upload.mock.calls.filter((call) => String(call[1]).endsWith(".pdf"));
    expect(pdfUploads).toHaveLength(1);
    expect(pdfText(pdfUploads[0][0] as Buffer)).toContain("121.00");
  });
});
