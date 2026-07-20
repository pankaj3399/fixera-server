import { describe, expect, it } from 'vitest';
import { daysAgo, hasUnpaidExtras, shouldSendReminder } from '../reminderRules';

describe('shouldSendReminder', () => {
  const now = Date.parse('2026-07-20T12:00:00.000Z');

  it('sends when never sent before', () => {
    expect(shouldSendReminder(null, 0, 3, 5, now)).toBe(true);
  });

  it('blocks when max count reached', () => {
    expect(shouldSendReminder(null, 5, 3, 5, now)).toBe(false);
  });

  it('blocks when last send was within the interval', () => {
    expect(shouldSendReminder(daysAgo(1, now), 1, 3, 5, now)).toBe(false);
  });

  it('allows when last send is older than the interval', () => {
    expect(shouldSendReminder(daysAgo(3, now), 1, 3, 5, now)).toBe(true);
  });
});

describe('hasUnpaidExtras', () => {
  it('is false when total is zero', () => {
    expect(hasUnpaidExtras({ extraCostTotal: 0, extraCostStatus: 'pending' })).toBe(false);
  });

  it('is true for positive pending extras', () => {
    expect(hasUnpaidExtras({ extraCostTotal: 50, extraCostStatus: 'pending' })).toBe(true);
  });

  it('is true when status missing but total positive', () => {
    expect(hasUnpaidExtras({ extraCostTotal: 10 })).toBe(true);
  });
});
