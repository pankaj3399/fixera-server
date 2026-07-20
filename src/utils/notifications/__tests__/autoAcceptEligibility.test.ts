import { describe, expect, it } from 'vitest';

/**
 * Pure eligibility rules for completion auto-accept (mirrors runCompletionAutoAccept guards).
 */
function isEligibleForAutoAccept(input: {
  status: string;
  professionalCompletedAt?: Date | null;
  unpaidMilestoneCount: number;
  extraCostTotal: number;
  extraCostPaymentSucceeded: boolean;
  now?: Date;
}): { eligible: boolean; reason?: string } {
  if (input.status !== 'professional_completed') {
    return { eligible: false, reason: 'invalid_status' };
  }
  const completedAt = input.professionalCompletedAt;
  if (!completedAt) return { eligible: false, reason: 'missing_completed_at' };
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - completedAt.getTime();
  if (ageMs < 10 * 24 * 60 * 60 * 1000) {
    return { eligible: false, reason: 'too_recent' };
  }
  if (input.unpaidMilestoneCount > 0) {
    return { eligible: false, reason: 'milestones_unpaid' };
  }
  if (input.extraCostTotal > 0 && !input.extraCostPaymentSucceeded) {
    return { eligible: false, reason: 'extra_cost_unpaid' };
  }
  return { eligible: true };
}

describe('completion auto-accept eligibility', () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const elevenDaysAgo = new Date(now.getTime() - 11 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  it('accepts eligible booking older than 10 days with no extras', () => {
    expect(
      isEligibleForAutoAccept({
        status: 'professional_completed',
        professionalCompletedAt: elevenDaysAgo,
        unpaidMilestoneCount: 0,
        extraCostTotal: 0,
        extraCostPaymentSucceeded: false,
        now,
      }),
    ).toEqual({ eligible: true });
  });

  it('skips unpaid extras', () => {
    expect(
      isEligibleForAutoAccept({
        status: 'professional_completed',
        professionalCompletedAt: elevenDaysAgo,
        unpaidMilestoneCount: 0,
        extraCostTotal: 100,
        extraCostPaymentSucceeded: false,
        now,
      }).reason,
    ).toBe('extra_cost_unpaid');
  });

  it('skips unpaid milestones', () => {
    expect(
      isEligibleForAutoAccept({
        status: 'professional_completed',
        professionalCompletedAt: elevenDaysAgo,
        unpaidMilestoneCount: 2,
        extraCostTotal: 0,
        extraCostPaymentSucceeded: false,
        now,
      }).reason,
    ).toBe('milestones_unpaid');
  });

  it('skips when younger than 10 days', () => {
    expect(
      isEligibleForAutoAccept({
        status: 'professional_completed',
        professionalCompletedAt: fiveDaysAgo,
        unpaidMilestoneCount: 0,
        extraCostTotal: 0,
        extraCostPaymentSucceeded: false,
        now,
      }).reason,
    ).toBe('too_recent');
  });

  it('allows when extras are paid', () => {
    expect(
      isEligibleForAutoAccept({
        status: 'professional_completed',
        professionalCompletedAt: elevenDaysAgo,
        unpaidMilestoneCount: 0,
        extraCostTotal: 50,
        extraCostPaymentSucceeded: true,
        now,
      }),
    ).toEqual({ eligible: true });
  });
});
