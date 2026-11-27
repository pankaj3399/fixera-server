import { describe, expect, it, vi } from 'vitest';
import { signListInvoiceLinks } from '../../utils/bookingDetails/listInvoiceLinks';

describe('signListInvoiceLinks', () => {
  it('signs stored invoice links and leaves other fields and rows untouched', async () => {
    const presign = vi.fn(async (url: string) => `${url}?sig=1`);
    const row = { _id: 'b1', payment: { invoiceNumber: 'FIX-1', invoiceUrl: 'https://s3/x.pdf', status: 'completed' } };
    const signed = await signListInvoiceLinks(row, presign);
    expect(signed.payment.invoiceUrl).toBe('https://s3/x.pdf?sig=1');
    expect(signed.payment.invoiceNumber).toBe('FIX-1');
    expect(row.payment.invoiceUrl).toBe('https://s3/x.pdf');
    expect(presign).toHaveBeenCalledTimes(1);
    const noPayment = { _id: 'b2' };
    expect(await signListInvoiceLinks(noPayment, presign)).toBe(noPayment);
  });

  it('keeps a link it cannot sign (not one of our S3 objects), like the detail endpoint', async () => {
    const row = { payment: { invoiceUrl: 'https://example.com/a.pdf', supplierInvoiceUrl: 'https://s3/b.pdf' } };
    const signed = await signListInvoiceLinks(row, async (url) => {
      if (url.includes('example.com')) return null;
      throw new Error('boom');
    });
    expect(signed.payment).toEqual(row.payment);
  });
});
