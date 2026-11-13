import { describe, expect, it } from 'vitest';
import { deriveRefundVatSplit, resolveRefundFacts } from '../../utils/bookingDetails/paymentFacts';

describe('refund VAT split derived from the refunded payment (phase 2)', () => {
  it('uses a single recorded VAT rate', () => {
    expect(deriveRefundVatSplit(121, { vatRate: 21 })).toEqual({ netAmount: 100, vatAmount: 21, vatRate: 21 });
  });

  it('allocates pro rata across mixed-rate VAT breakdown lines', () => {
    const payment = {
      vatBreakdown: [
        { netAmount: 100, vatRate: 21, vatAmount: 21 },
        { netAmount: 100, vatRate: 6, vatAmount: 6 },
      ],
    };
    // Refund half of the 227 gross: VAT = 13.5, net = 100.
    expect(deriveRefundVatSplit(113.5, payment)).toEqual({ netAmount: 100, vatAmount: 13.5, vatRate: null });
  });

  it('falls back to the payment VAT share and returns null without VAT facts', () => {
    expect(deriveRefundVatSplit(50, { vatAmount: 21, totalWithVat: 121 })).toEqual({ netAmount: 41.32, vatAmount: 8.68, vatRate: null });
    expect(deriveRefundVatSplit(50, {})).toBeNull();
    expect(deriveRefundVatSplit(0, { vatRate: 21 })).toBeNull();
  });

  it('marks refund facts as derived (never as recorded) and keeps recorded splits untouched', () => {
    const facts = resolveRefundFacts({
      booking: { payment: { stripePaymentIntentId: 'pi_1', currency: 'EUR' } },
      paymentRows: [
        {
          payment: {
            _id: 'p1',
            stripePaymentIntentId: 'pi_1',
            currency: 'EUR',
            vatRate: 21,
            refunds: [
              { amount: 60.5, refundId: 're_1', refundedAt: new Date('2026-10-01'), reason: 'Partial cancellation' },
              { amount: 12.1, refundId: 're_2', refundedAt: new Date('2026-10-02'), netAmount: 10, vatAmount: 2.1, vatRate: 21 },
            ],
          },
          isFallback: false,
        },
      ],
    });
    expect(facts[0]).toMatchObject({ netAmount: 50, vatAmount: 10.5, vatRate: 21, vatSplitRecorded: false, vatSplitDerived: true });
    expect(facts[0].noticeCodes).toEqual(['REFUND_VAT_SPLIT_DERIVED']);
    expect(facts[1]).toMatchObject({ netAmount: 10, vatAmount: 2.1, vatSplitRecorded: true });
    expect(facts[1].vatSplitDerived).toBeUndefined();
  });
});
