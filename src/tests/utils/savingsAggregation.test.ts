import { describe, expect, it } from 'vitest';
import { aggregateRecordedSavings } from '../../utils/savingsAggregation';

const settled = (discount: any, currency = 'EUR') => ({
  payment: { status: 'completed', currency, discount },
});

describe('aggregateRecordedSavings', () => {
  it('sums recorded parts per currency and labels the total recorded', () => {
    const summary = aggregateRecordedSavings([
      settled({
        loyaltyAmount: 10,
        repeatBuyerAmount: 5,
        pointsDiscountAmount: 4,
        codeDiscountAmount: 6,
        originalAmount: 100,
      }),
      settled({ loyaltyAmount: 3, originalAmount: 50 }, 'USD'),
    ]);
    expect(summary.settledBookingCount).toBe(2);
    expect(summary.unrecordedBookingCount).toBe(0);
    expect(summary.complete).toBe(true);
    const eur = summary.groups.find((group) => group.currency === 'EUR')!;
    expect(eur.byType).toEqual({ recurring: 5, loyalty: 10, discountCode: 6, points: 4 });
    expect(eur.totalRecorded).toBe(25);
    expect(eur.referral).toBeNull();
    const usd = summary.groups.find((group) => group.currency === 'USD')!;
    expect(usd.totalRecorded).toBe(3);
  });

  it('never mixes currencies into one total', () => {
    const summary = aggregateRecordedSavings([
      settled({ loyaltyAmount: 10, originalAmount: 100 }, 'EUR'),
      settled({ loyaltyAmount: 10, originalAmount: 100 }, 'USD'),
    ]);
    expect(summary.groups).toHaveLength(2);
    for (const group of summary.groups) {
      expect(group.totalRecorded).toBe(10);
    }
  });

  it('excludes unpaid and fully refunded bookings, flags partial refunds as uncertain', () => {
    const summary = aggregateRecordedSavings([
      { payment: { status: 'pending', currency: 'EUR', discount: { loyaltyAmount: 50, originalAmount: 200 } } },
      { payment: { status: 'refunded', currency: 'EUR', discount: { loyaltyAmount: 50, originalAmount: 200 } } },
      {
        payment: { status: 'partially_refunded', currency: 'EUR', discount: { loyaltyAmount: 50, originalAmount: 200 } },
      },
      settled({ loyaltyAmount: 7, originalAmount: 100 }),
    ]);
    expect(summary.settledBookingCount).toBe(1);
    expect(summary.excludedUncertainCount).toBe(1);
    expect(summary.complete).toBe(false);
    const eur = summary.groups.find((group) => group.currency === 'EUR')!;
    expect(eur.totalRecorded).toBe(7);
    expect(eur.coverage).toBe('partial');
    expect(eur.excludedUncertain).toBe(1);
  });

  it('counts completed bookings without snapshots as unrecorded, never zero', () => {
    const summary = aggregateRecordedSavings([
      settled({ loyaltyAmount: 7, originalAmount: 100 }),
      { payment: { status: 'completed', currency: 'EUR' } },
    ]);
    expect(summary.unrecordedBookingCount).toBe(1);
    expect(summary.complete).toBe(false);
    const eur = summary.groups.find((group) => group.currency === 'EUR')!;
    expect(eur.unrecorded).toBe(1);
    expect(eur.totalRecorded).toBe(7);
  });

  it('caps a booking total at its recorded original amount (double-count guard)', () => {
    const summary = aggregateRecordedSavings([
      settled({ loyaltyAmount: 90, repeatBuyerAmount: 90, originalAmount: 100 }),
    ]);
    const eur = summary.groups[0];
    expect(eur.totalRecorded).toBe(100);
    expect(eur.byType).toEqual({ recurring: 50, loyalty: 50, discountCode: 0, points: 0 });
  });

  it('prefers the booking snapshot and never adds milestone snapshots on top', () => {
    const summary = aggregateRecordedSavings([
      {
        payment: { status: 'completed', currency: 'EUR', discount: { loyaltyAmount: 10, originalAmount: 100 } },
        milestonePayments: [{ discount: { loyaltyAmount: 10, originalAmount: 100 } }],
      },
    ]);
    expect(summary.groups[0].totalRecorded).toBe(10);
  });

  it('reports an empty settled base as true zero only when nothing is recorded', () => {
    const summary = aggregateRecordedSavings([]);
    expect(summary.groups).toEqual([]);
    expect(summary.settledBookingCount).toBe(0);
  });
});

it('keeps capped component cents equal to their total', () => {
  for (const originalAmount of [0.01, 1, 100]) {
    const group = aggregateRecordedSavings([settled({ loyaltyAmount: 60, codeDiscountAmount: 50, pointsDiscountAmount: 20, repeatBuyerAmount: 5, originalAmount })]).groups[0];
    expect(Math.round(Object.values(group.byType).reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(group.totalRecorded * 100));
    expect(group.totalRecorded).toBe(originalAmount);
  }
});
it('does not infer unrecorded booking discounts from unsupported milestone fields', () => {
  const summary = aggregateRecordedSavings([{ payment: { status: 'completed', currency: 'EUR' }, milestonePayments: [{ discount: { loyaltyAmount: 10 } }] }]);
  expect(summary.unrecordedBookingCount).toBe(1);
});
