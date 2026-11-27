/**
 * FT2-13 "Invoice download link forwards to an error": invoice PDFs live in a
 * private S3 bucket. The booking detail endpoint presigns them, but the
 * overview list (`GET /api/bookings/my-bookings`) returned the stored object
 * URLs as they are, so the table's "Download" link opened S3's AccessDenied
 * page. The list now presigns the invoice links it exposes (the viewer's own
 * invoice only: role filtering has already removed the other party's fields).
 */
export const LIST_INVOICE_URL_FIELDS = [
  "invoiceUrl",
  "invoiceUblUrl",
  "supplierInvoiceUrl",
  "supplierInvoiceUblUrl",
  "creditNoteUrl",
  "creditNoteUblUrl",
  "supplierCreditNoteUrl",
  "supplierCreditNoteUblUrl",
] as const;

type Presign = (url: string) => Promise<string | null>;

export async function signListInvoiceLinks<T>(row: T, presign: Presign): Promise<T> {
  const payment = (row as any)?.payment;
  if (!payment || typeof payment !== "object") return row;
  const signed: Record<string, string> = {};
  await Promise.all(
    LIST_INVOICE_URL_FIELDS.map(async (field) => {
      const url = payment[field];
      if (typeof url !== "string" || !url) return;
      // Same rule as the detail endpoint: links that are not our S3 objects
      // (or cannot be signed) are passed through unchanged.
      const result = await presign(url).catch(() => null);
      signed[field] = result ?? url;
    }),
  );
  if (Object.keys(signed).length === 0) return row;
  return { ...(row as any), payment: { ...payment, ...signed } } as T;
}
