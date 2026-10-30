import { describe, expect, it } from 'vitest';
import {
  buildMilestoneChargePlan,
  toMilestoneCustomerGross,
} from '../../utils/milestoneCharges';

const booking = (overrides: Record<string, any> = {}) => ({
  selectedExtraOptions: [],
  quote: { amount: 300 },
  ...overrides,
});

describe('toMilestoneCustomerGross', () => {
  it('applies commission with payment-intent rounding', () => {
    expect(toMilestoneCustomerGross(100, 10)).toBe(110);
    expect(toMilestoneCustomerGross(99.99, 10)).toBe(109.99);
  });
});

describe('buildMilestoneChargePlan', () => {
  it('returns no entries without milestones', () => {
    expect(buildMilestoneChargePlan(booking(), 10)).toEqual([]);
    expect(buildMilestoneChargePlan(booking({ milestonePayments: [] }), 10)).toEqual([]);
  });

  it('charges the milestone base alone when no options are selected', () => {
    const plan = buildMilestoneChargePlan(
      booking({
        milestonePayments: [
          { title: 'Deposit', amount: 100, order: 0 },
          { title: 'Final', amount: 200, order: 1 },
        ],
      }),
      10,
    );
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      index: 0,
      order: 0,
      baseProfessionalAmount: 100,
      baseCustomerGross: 110,
      optionsCustomerGross: 0,
      expectedCustomerGross: 110,
      includesSelectedOptions: false,
    });
    expect(plan[1]).toMatchObject({ expectedCustomerGross: 220, includesSelectedOptions: false });
  });

  it('charges selected options in full with the first milestone only', () => {
    const plan = buildMilestoneChargePlan(
      booking({
        milestonePayments: [
          { title: 'Deposit', amount: 100, order: 0 },
          { title: 'Mid', amount: 100, order: 1 },
          { title: 'Final', amount: 100, order: 2 },
        ],
        selectedExtraOptions: [{ extraOptionId: 'opt-1', bookedPrice: 20 }],
      }),
      10,
    );
    expect(plan).toHaveLength(3);
    // Options commissioned in full (22) on the first milestone, never divided.
    expect(plan[0]).toMatchObject({
      baseCustomerGross: 110,
      optionsCustomerGross: 22,
      expectedCustomerGross: 132,
      includesSelectedOptions: true,
    });
    expect(plan[1]).toMatchObject({ expectedCustomerGross: 110, includesSelectedOptions: false });
    expect(plan[2]).toMatchObject({ expectedCustomerGross: 110, includesSelectedOptions: false });
    // Full scope still adds up: milestones + options exactly once.
    const total = plan.reduce((sum, entry) => sum + entry.expectedCustomerGross, 0);
    expect(total).toBeCloseTo(110 * 3 + 22, 10);
  });

  it('attaches options to the minimum-order milestone regardless of array order', () => {
    const plan = buildMilestoneChargePlan(
      booking({
        milestonePayments: [
          { title: 'Final', amount: 200, order: 1 },
          { title: 'Deposit', amount: 100, order: 0 },
        ],
        selectedExtraOptions: [{ extraOptionId: 'opt-1', bookedPrice: 20 }],
      }),
      10,
    );
    expect(plan.find((entry) => entry.index === 0)!.includesSelectedOptions).toBe(false);
    expect(plan.find((entry) => entry.index === 1)!).toMatchObject({
      order: 0,
      expectedCustomerGross: 132,
      includesSelectedOptions: true,
    });
  });

  it('adds nothing when the quote already folds the extras in', () => {
    const plan = buildMilestoneChargePlan(
      booking({
        milestonePayments: [{ title: 'Only', amount: 120, order: 0 }],
        quote: { amount: 120 },
        checkoutSnapshot: { baseSubtotal: 100, extraOptionsTotal: 20, totalAmount: 120 },
        selectedExtraOptions: [{ extraOptionId: 'opt-1', bookedPrice: 20 }],
      }),
      10,
    );
    expect(plan[0]).toMatchObject({ optionsCustomerGross: 0, includesSelectedOptions: false });
  });

  it('matches the payment-intent math for the first milestone charge', () => {
    const commissionPercent = 10;
    const plan = buildMilestoneChargePlan(
      booking({
        milestonePayments: [
          { title: 'Deposit', amount: 99.99, order: 0 },
          { title: 'Final', amount: 200, order: 1 },
        ],
        selectedExtraOptions: [{ extraOptionId: 'opt-1', bookedPrice: 33.33 }],
      }),
      commissionPercent,
    );
    const legacyFirst =
      +(99.99 * (1 + commissionPercent / 100)).toFixed(2)
      + +(33.33 * (1 + commissionPercent / 100)).toFixed(2);
    expect(plan[0].expectedCustomerGross).toBeCloseTo(legacyFirst, 10);
  });
});
