import { describe, expect, it } from 'vitest';
import {
  addPlanDays,
  computeMinExecutionResourceDays,
  planKeyToDate,
  rebuildResourcePlanForNewStart,
  resolveDayModeExecutionDays,
  toPlanDayKey,
  toPlanDayKeyInTimeZone,
} from '../../utils/reschedulePlanning';

describe('reschedule plan reset helpers (client bug list #9b)', () => {
  it('handles UTC day keys', () => {
    expect(toPlanDayKey(new Date(Date.UTC(2026, 9, 29, 10, 30)))).toBe('2026-10-29');
    expect(toPlanDayKey('not-a-date')).toBeNull();
    expect(planKeyToDate('2026-11-02')?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(planKeyToDate('nope')).toBeNull();
    expect(addPlanDays('2026-11-02', 1)).toBe('2026-11-03');
    expect(addPlanDays('2026-11-02', -1)).toBe('2026-11-01');
  });

  it('computes the minimum execution duration in resource-days', () => {
    // 2 + 2 * (2 - 1) * 0.9 = 3.8 -> 4 resource-days.
    expect(computeMinExecutionResourceDays({ executionDays: 2, resourceCount: 2, overlapFraction: 0.9 })).toBe(4);
    expect(computeMinExecutionResourceDays({ executionDays: 2, resourceCount: 1, overlapFraction: 0.9 })).toBe(2);
    expect(computeMinExecutionResourceDays({ executionDays: 1, resourceCount: 1, overlapFraction: 0 })).toBe(1);
    // Overlap is clamped to [0, 1].
    expect(computeMinExecutionResourceDays({ executionDays: 2, resourceCount: 2, overlapFraction: 90 })).toBe(4);
  });

  it('resolves day-mode execution days and rejects hour-mode', () => {
    expect(
      resolveDayModeExecutionDays({
        scheduleSnapshot: { executionDuration: { value: 2, unit: 'days' } },
        project: null,
        selectedSubprojectIndex: 0,
      })
    ).toBe(2);
    expect(
      resolveDayModeExecutionDays({
        scheduleSnapshot: { executionDuration: { value: 5, unit: 'hours' } },
        project: null,
        selectedSubprojectIndex: 0,
      })
    ).toBeNull();
    expect(
      resolveDayModeExecutionDays({
        scheduleSnapshot: null,
        project: { executionDuration: { value: 1, unit: 'days' }, subprojects: [{ executionDuration: { value: 3, unit: 'days' } }] },
        selectedSubprojectIndex: 0,
      })
    ).toBe(3);
    expect(
      resolveDayModeExecutionDays({
        scheduleSnapshot: null,
        project: { executionDuration: { value: 1, unit: 'days' }, subprojects: [{ executionDuration: { value: 3, unit: 'hours' } }] },
        selectedSubprojectIndex: 0,
      })
    ).toBeNull();
  });

  it('unplans days before the new start, keeps later days, and tops up to the minimum', () => {
    // BK000110-style scenario: 29 Oct + 2 Nov planned, reschedule to 2 Nov.
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29', '2026-11-02'] }],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1'],
      minResourceDays: 2,
      executionDays: 2,
      minResourcesPerDay: 1,
    });
    expect(rebuilt.hadPlan).toBe(true);
    expect(rebuilt.removedDays).toBe(1);
    expect(rebuilt.resourcePlan).toEqual([{ resourceId: 'r1', days: ['2026-11-02', '2026-11-03'] }]);
    expect(rebuilt.addedDays).toEqual([{ resourceId: 'r1', dayKey: '2026-11-03' }]);
    expect(rebuilt.maxDayKey).toBe('2026-11-03');
  });

  it('derives the start key in the professional timezone (UTC+ off-by-one guard)', () => {
    // Nov 2 local midnight in Brussels is 2026-11-01T23:00Z; a plain UTC key
    // would point at Nov 1 and wrongly keep pre-start days.
    const instant = new Date('2026-11-01T23:00:00.000Z');
    expect(toPlanDayKey(instant)).toBe('2026-11-01');
    const key = toPlanDayKeyInTimeZone(instant, 'Europe/Brussels');
    expect(key).toBe('2026-11-02');
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29', '2026-11-01', '2026-11-02'] }],
      newStartKey: key!,
      assignedResourceIds: ['r1'],
      minResourceDays: 2,
      executionDays: 2,
      minResourcesPerDay: 1,
    });
    expect(rebuilt.removedDays).toBe(2);
    expect(rebuilt.resourcePlan).toEqual([{ resourceId: 'r1', days: ['2026-11-02', '2026-11-03'] }]);
    expect(rebuilt.addedDays.every((added) => added.dayKey >= '2026-11-02')).toBe(true);
  });

  it('divides added days across assigned resources to keep the booking short', () => {
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29'] }],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1', 'r2'],
      minResourceDays: 3,
      executionDays: 2,
      minResourcesPerDay: 1,
    });
    const byResource = new Map(rebuilt.resourcePlan.map((entry) => [entry.resourceId, entry.days]));
    // Both resources share 2 Nov; only one extra calendar day is needed.
    expect(byResource.get('r1')).toEqual(['2026-11-02', '2026-11-03']);
    expect(byResource.get('r2')).toEqual(['2026-11-02']);
    expect(rebuilt.maxDayKey).toBe('2026-11-03');
  });

  it('skips blocked days when topping up', () => {
    const blockedByResource = new Map([['r1', new Set(['2026-11-03'])]]);
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29', '2026-11-02'] }],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1'],
      blockedByResource,
      minResourceDays: 2,
      executionDays: 2,
      minResourcesPerDay: 1,
    });
    expect(rebuilt.resourcePlan).toEqual([{ resourceId: 'r1', days: ['2026-11-02', '2026-11-04'] }]);
  });

  it('covers every window day with the minimum resources and reaches the total', () => {
    // 10 days, 3 resources, min 2, 70% overlap: 10 + 10*2*0.7 = 24 resource-days.
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29'] }],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1', 'r2', 'r3'],
      minResourceDays: 24,
      executionDays: 10,
      minResourcesPerDay: 2,
    });
    const perDay = new Map<string, string[]>();
    for (const entry of rebuilt.resourcePlan) {
      for (const dayKey of entry.days) {
        perDay.set(dayKey, [...(perDay.get(dayKey) || []), entry.resourceId]);
      }
    }
    const windowKeys = Array.from({ length: 10 }, (_, offset) => `2026-11-${String(2 + offset).padStart(2, '0')}`);
    for (const dayKey of windowKeys) {
      expect((perDay.get(dayKey) || []).length).toBeGreaterThanOrEqual(2);
    }
    let total = 0;
    perDay.forEach((rids) => {
      total += rids.length;
    });
    expect(total).toBe(24);
    expect(rebuilt.maxDayKey).toBe('2026-11-11');
    expect(Math.min(...Array.from(perDay.keys()).map((key) => Number(key.replace(/-/g, ''))))).toBe(20261102);
  });

  it('carries a blocked window day deficit forward instead of stalling', () => {
    const blockedByResource = new Map([
      ['r1', new Set(['2026-11-04'])],
      ['r2', new Set(['2026-11-04'])],
    ]);
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29'] }],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1', 'r2', 'r3'],
      blockedByResource,
      minResourceDays: 24,
      executionDays: 10,
      minResourcesPerDay: 2,
    });
    const perDay = new Map<string, string[]>();
    for (const entry of rebuilt.resourcePlan) {
      for (const dayKey of entry.days) {
        perDay.set(dayKey, [...(perDay.get(dayKey) || []), entry.resourceId].sort());
      }
    }
    // 4 Nov cannot reach the minimum (only r3 free) — the deficit is made up
    // on the following days, so the total still reaches 24.
    expect(perDay.get('2026-11-04')).toEqual(['r3']);
    let total = 0;
    perDay.forEach((rids) => {
      total += rids.length;
    });
    expect(total).toBe(24);
    expect(rebuilt.maxDayKey).toBe('2026-11-11');
  });

  it('is idempotent: re-running the rebuild changes nothing', () => {
    const params = {
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1', 'r2', 'r3'],
      minResourceDays: 24,
      executionDays: 10,
      minResourcesPerDay: 2,
    };
    const first = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-10-29'] }],
      ...params,
    });
    const second = rebuildResourcePlanForNewStart({
      resourcePlan: first.resourcePlan,
      ...params,
    });
    expect(second.removedDays).toBe(0);
    expect(second.addedDays).toEqual([]);
    expect(second.resourcePlan).toEqual(first.resourcePlan);
  });

  it('leaves bookings without any manual planning untouched', () => {
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1'],
      minResourceDays: 2,
      executionDays: 2,
      minResourcesPerDay: 1,
    });
    expect(rebuilt.hadPlan).toBe(false);
    expect(rebuilt.resourcePlan).toEqual([]);
    expect(rebuilt.addedDays).toEqual([]);
  });

  it('is a no-op when everything is already on/after the new start and the minimum is met', () => {
    const rebuilt = rebuildResourcePlanForNewStart({
      resourcePlan: [{ resourceId: 'r1', days: ['2026-11-02', '2026-11-03'] }],
      newStartKey: '2026-11-02',
      assignedResourceIds: ['r1'],
      minResourceDays: 2,
      executionDays: 2,
      minResourcesPerDay: 1,
    });
    expect(rebuilt.removedDays).toBe(0);
    expect(rebuilt.addedDays).toEqual([]);
    expect(rebuilt.resourcePlan).toEqual([{ resourceId: 'r1', days: ['2026-11-02', '2026-11-03'] }]);
  });
});
