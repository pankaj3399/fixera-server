import { describe, expect, it } from 'vitest';
import { getProjectDurations, resolveProjectScheduleQuantity, getBookingScheduleOptions } from '../../utils/scheduleEngine';

describe('unit priced project scheduling quantity', () => {
  const project = (pricing: Record<string, unknown>, executionDuration?: { value: number; unit: 'hours' | 'days' }) => ({
    subprojects: [{ pricing: { type: 'unit', unit: 'm²', ...pricing }, executionDuration, preparationDuration: { value: 2, unit: 'hours' }, buffer: { value: 1, unit: 'days' } }],
  });

  it('scales only execution for per-unit duration and keeps prep/buffer once', () => {
    const durations = getProjectDurations(project({ durationBasis: 'per_unit' }, { value: 1.5, unit: 'days' }), 0, undefined, 2.5);
    expect(durations).toEqual({
      execution: { value: 3.75, unit: 'days' },
      preparation: { value: 2, unit: 'hours' },
      buffer: { value: 1, unit: 'days' },
    });
  });

  it('preserves the legacy whole-booking duration when no duration basis was stored', () => {
    const durations = getProjectDurations(project({}, { value: 2, unit: 'days' }), 0, undefined, 5);
    expect(durations?.execution).toEqual({ value: 2, unit: 'days' });
  });

  it('uses customer quantity as hours for per-unit hourly packages even if a duration was saved', () => {
    const durations = getProjectDurations({ subprojects: [{ pricing: { type: 'unit', unit: 'hour', durationBasis: 'per_unit' }, executionDuration: { value: 5, unit: 'days' } }] }, 0, undefined, 2.5);
    expect(durations?.execution).toEqual({ value: 2.5, unit: 'hours' });
  });

  it('rejects non-finite, non-positive and below-minimum quantities', () => {
    const value = project({ minOrderQuantity: 2 });
    expect(resolveProjectScheduleQuantity(value, 0, '2.5')).toEqual({ valid: true, quantity: 2.5 });
    for (const quantity of ['NaN', 'Infinity', '0', '-1', '1.5', ['2'], true, { value: 2 }]) {
      expect(resolveProjectScheduleQuantity(value, 0, quantity).valid).toBe(false);
    }
  });
  it('uses frozen execution and explicit zero prep/buffer after live package changes', () => {
    const options = getBookingScheduleOptions({ scheduleSnapshot: { quantity: 6, executionDuration: { value: 12, unit: 'days' } } });
    const changed = project({ durationBasis: 'per_unit', unit: 'hour' }, { value: 9, unit: 'days' });
    expect(getProjectDurations(changed, 0, options.durationOverride, options.quantity)).toEqual({
      execution: { value: 12, unit: 'days' }, preparation: { value: 0, unit: 'hours' }, buffer: { value: 0, unit: 'hours' },
    });
    expect(getBookingScheduleOptions({ checkoutSnapshot: { quantity: 3 } })).toEqual({ quantity: 3 });
  });

});
