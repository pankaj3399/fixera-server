import { describe, expect, it } from 'vitest';
import Booking from '../../models/booking';
import { buildPaymentDiscountLedgerEntry } from '../../utils/paymentDiscountLedger';
import { normalizeInvoiceBasis } from '../../utils/milestoneInvoice';

const row = (index: number, net: number, discount = 0, commission = 0) => ({
  milestoneIndex: index, stripePaymentIntentId: `pi_${index}`, status: 'completed',
  netAmount: net, vatAmount: Math.round(net * 21) / 100,
  totalWithVat: Math.round(net * 121) / 100,
  professionalPayout: net + discount - commission,
  platformCommission: commission - discount,
});
const booking = (rows: any[]) => ({
  status: 'completed', quote: { amount: 1000 }, selectedExtraOptions: [],
  milestonePayments: [0, 1].map(order => ({ order, amount: 500, status: 'paid' })),
  payment: { ...rows.at(-1), vatRate: 21, discount: { totalDiscount: 0 } },
  __settledPayments: rows,
  paymentDiscountLedger: rows.map((payment, index) => ({
    paymentIntentId: payment.stripePaymentIntentId, milestoneIndex: index,
    originalAmount: 500, totalDiscount: index === 0 ? 50 : 0,
    repeatBuyerAmount: index === 0 ? 20 : 0, codeDiscountAmount: index === 0 ? 30 : 0,
  })),
});

describe('recorded invoice settlements', () => {
  it('#5 sums earlier milestone discounts and their actual VAT instead of extrapolating the last slice', () => {
    const basis = normalizeInvoiceBasis(booking([row(0, 450, 50), row(1, 500)]), 0);
    expect(basis.serviceNet).toBe(950);
    expect(basis.serviceVat).toBe(199.5);
    expect(basis.serviceTotal).toBe(1149.5);
    expect(basis.discount).toMatchObject({ totalDiscount: 50, repeatBuyerAmount: 20, codeDiscountAmount: 30 });
  });
  it('#6 freezes the collected commission and rounding when platform settings change', () => {
    const doc = booking([row(0, 550, 0, 50), row(1, 550, 0, 50)]);
    doc.paymentDiscountLedger = [];
    const before = normalizeInvoiceBasis(doc, 10);
    const after = normalizeInvoiceBasis(doc, 20);
    expect(after.serviceNet).toBe(1100);
    expect(after.serviceTotal).toBe(1331);
    expect(after).toEqual(before);
  });
  it('#4 invoices only the retained paid milestone on cancellation, excluding future work', () => {
    const doc: any = booking([{ ...row(0, 100), vatAmount: 0, totalWithVat: 100, professionalPayout: 100 }]);
    doc.status = 'cancelled';
    doc.milestonePayments = [{ order: 0, amount: 100, status: 'paid' }, { order: 1, amount: 100, status: 'pending' }];
    doc.paymentDiscountLedger = [];
    doc.payment = { ...doc.payment, reverseCharge: true, vatRate: 0, status: 'partially_refunded', refundAmount: 25 };
    const basis = normalizeInvoiceBasis(doc, 0);
    expect(basis.serviceNet).toBe(75);
    expect(basis.serviceTotal).toBe(75);
    expect((basis as any).supplierServiceNet * basis.supplierScale).toBe(75);
  });
  it('blocks an incomplete historical settlement instead of guessing from the latest slice', () => {
    const doc: any = booking([row(1, 500)]);
    doc.__settledPayments = [];
    expect(() => normalizeInvoiceBasis(doc, 20)).toThrow('historical settled payment rows are missing');
  });

  it('retains financial facts in a real hydrated ledger when historical Payment rows need repair', () => {
    const payments = [row(0, 450, 50), row(1, 500)];
    const snapshots = payments.map((payment, index) => buildPaymentDiscountLedgerEntry({ ...payment,
      discount: { originalAmount: 500, totalDiscount: index === 0 ? 50 : 0, codeDiscountAmount: index === 0 ? 50 : 0 },
    }));
    const doc = Booking.hydrate({ ...booking(payments), paymentDiscountLedger: snapshots });
    expect(doc.paymentDiscountLedger![0].netAmount).toBe(450);
    expect(normalizeInvoiceBasis(doc, 99).serviceTotal).toBe(1149.5);
  });

});


it('reconciles missing ledger settlements while Payment rows stay authoritative for their intents', async () => {
  const { invoiceSettledPayments } = await import('../../utils/invoiceSettlements');
  const payments = [row(0, 450, 50), row(1, 500)];
  const doc = booking(payments);
  doc.paymentDiscountLedger = payments.map(payment => buildPaymentDiscountLedgerEntry({ ...payment,
    discount: { originalAmount: 500, totalDiscount: payment.milestoneIndex === 0 ? 50 : 0 } })) as any;
  doc.__settledPayments = [payments[1]];
  (doc.paymentDiscountLedger[1] as any).totalWithVat = 999;
  expect(invoiceSettledPayments(doc)).toHaveLength(2);
  expect(invoiceSettledPayments(doc).find(p => p.stripePaymentIntentId === 'pi_1').totalWithVat).toBe(605);
  expect(normalizeInvoiceBasis(doc, 99).serviceTotal).toBe(1149.5);
});
