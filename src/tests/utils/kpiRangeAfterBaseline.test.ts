import { describe, expect, it } from 'vitest';
import { kpiRangeAfterBaseline } from '../../utils/adminDashboardBaselines';

describe('kpiRangeAfterBaseline (monthly KPI report after a dashboard reset)', () => {
  const from = new Date('2026-10-01T00:00:00.000Z');
  const to = new Date('2026-10-31T23:59:59.999Z');

  it('keeps the month when there is no reset or it is older', () => {
    expect(kpiRangeAfterBaseline(from, to, null)).toEqual({ from, to });
    expect(kpiRangeAfterBaseline(from, to, new Date('2026-09-15T00:00:00.000Z'))).toEqual({ from, to });
  });

  it('starts at a reset inside the month', () => {
    const resetAt = new Date('2026-10-20T08:00:00.000Z');
    expect(kpiRangeAfterBaseline(from, to, resetAt)).toEqual({ from: resetAt, to });
  });

  it('collapses (never inverts) when the reset is after the month', () => {
    const resetAt = new Date('2026-11-05T00:00:00.000Z');
    expect(kpiRangeAfterBaseline(from, to, resetAt)).toEqual({ from: resetAt, to: resetAt });
  });
});
