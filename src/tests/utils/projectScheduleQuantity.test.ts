import { describe, expect, it } from 'vitest';
import {
  getProjectDurations,
  resolveProjectScheduleQuantity,
  getBookingScheduleOptions,
  getLongestWorkingDayHours,
  isQuantityDerivedExecution,
  resolveScheduleDurations,
} from '../../utils/scheduleEngine';
import { resolveAvailability } from '../../utils/availabilityHelpers';
import Project from '../../models/project';

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

  it('books the customer hours for an hourly package the wizard saved without a professional duration', () => {
    // The wizard shows "determined by customer" and stores no execution value.
    const hourly = { subprojects: [{ pricing: { type: 'unit', unit: 'hour', durationBasis: 'per_unit' }, executionDuration: { unit: 'hours' } }] };
    expect(getProjectDurations(hourly, 0, undefined, 1)?.execution).toEqual({ value: 1, unit: 'hours' });
    expect(getProjectDurations(hourly, 0, undefined, 6)?.execution).toEqual({ value: 6, unit: 'hours' });
    const errors = new Project({ subprojects: hourly.subprojects.map((sub) => ({ ...sub, name: 'Hourly', description: 'Hourly help', pricing: { ...sub.pricing, amount: 50 } })) }).validateSync();
    expect(Object.keys(errors?.errors || {}).filter((path) => path.startsWith('subprojects.0.executionDuration'))).toEqual([]);
  });

  it('scales a per-unit duration for one unit and for a large quantity', () => {
    const perM2 = project({ durationBasis: 'per_unit' }, { value: 0.5, unit: 'hours' });
    expect(getProjectDurations(perM2, 0, undefined, 1)?.execution).toEqual({ value: 0.5, unit: 'hours' });
    expect(getProjectDurations(perM2, 0, undefined, 40)?.execution).toEqual({ value: 20, unit: 'hours' });
  });

  it('defaults an omitted quantity to the package minimum', () => {
    expect(resolveProjectScheduleQuantity(project({ minOrderQuantity: 5 }), 0, undefined)).toEqual({
      valid: true,
      quantity: 5,
    });
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

describe('FT1 6A/6B: hour quantities longer than a working day', () => {
  // Mon–Fri 09:00–17:00: the longest working day is 8 hours.
  const eightHourWeek = resolveAvailability(undefined);
  const hourly = (pricing: Record<string, unknown> = {}, executionDuration?: { value?: number; unit: 'hours' | 'days' }) => ({
    subprojects: [{ pricing: { type: 'unit', unit: 'hour', ...pricing }, executionDuration, buffer: { value: 1, unit: 'hours' } }],
  });

  it('uses the booked hours for a legacy hour package saved without a duration basis', () => {
    const legacy = hourly({}, { value: 3, unit: 'days' });
    expect(isQuantityDerivedExecution(legacy, 0)).toBe(true);
    expect(getProjectDurations(legacy, 0, undefined, 6)?.execution).toEqual({ value: 6, unit: 'hours' });
    expect(resolveScheduleDurations(legacy, 0, undefined, 6, eightHourWeek)?.execution).toEqual({ value: 6, unit: 'hours' });
  });

  it('plans 16 customer hours with an 8 hour working day as 2 days', () => {
    const durations = resolveScheduleDurations(hourly({ durationBasis: 'per_unit' }), 0, undefined, 16, eightHourWeek);
    expect(durations?.execution).toEqual({ value: 2, unit: 'days' });
    // Prep and buffer are unchanged.
    expect(durations?.buffer).toEqual({ value: 1, unit: 'hours' });
  });

  it('rounds partial days up and keeps hour mode when the hours fit in a day', () => {
    const pkg = hourly({ durationBasis: 'per_unit' });
    expect(resolveScheduleDurations(pkg, 0, undefined, 17, eightHourWeek)?.execution).toEqual({ value: 3, unit: 'days' });
    expect(resolveScheduleDurations(pkg, 0, undefined, 8, eightHourWeek)?.execution).toEqual({ value: 8, unit: 'hours' });
    expect(resolveScheduleDurations(pkg, 0, undefined, 4, eightHourWeek)?.execution).toEqual({ value: 4, unit: 'hours' });
  });

  it('applies the same rule to a per-unit hour duration multiplied by the quantity', () => {
    const perM2 = { subprojects: [{ pricing: { type: 'unit', unit: 'm²', durationBasis: 'per_unit' }, executionDuration: { value: 0.5, unit: 'hours' } }] };
    expect(resolveScheduleDurations(perM2, 0, undefined, 40, eightHourWeek)?.execution).toEqual({ value: 3, unit: 'days' });
    expect(resolveScheduleDurations(perM2, 0, undefined, 10, eightHourWeek)?.execution).toEqual({ value: 5, unit: 'hours' });
  });

  it('uses the longest working day and ignores unavailable days', () => {
    const availability = resolveAvailability({
      monday: { available: true, startTime: '08:00', endTime: '18:00' },
      tuesday: { available: true, startTime: '09:00', endTime: '13:00' },
      saturday: { available: false, startTime: '00:00', endTime: '23:00' },
    });
    expect(getLongestWorkingDayHours(availability)).toBe(10);
    expect(resolveScheduleDurations(hourly(), 0, undefined, 16, availability)?.execution).toEqual({ value: 2, unit: 'days' });
    expect(resolveScheduleDurations(hourly(), 0, undefined, 10, availability)?.execution).toEqual({ value: 10, unit: 'hours' });
    // No working day at all: nothing to convert against, hour mode is kept.
    expect(getLongestWorkingDayHours({ monday: { available: false } })).toBe(0);
    expect(resolveScheduleDurations(hourly(), 0, undefined, 16, { monday: { available: false } })?.execution).toEqual({ value: 16, unit: 'hours' });
  });

  it('leaves fixed hour packages and legacy non-hour unit packages untouched', () => {
    const fixed = { subprojects: [{ pricing: { type: 'fixed' }, executionDuration: { value: 12, unit: 'hours' } }] };
    expect(isQuantityDerivedExecution(fixed, 0)).toBe(false);
    expect(resolveScheduleDurations(fixed, 0, undefined, 1, eightHourWeek)?.execution).toEqual({ value: 12, unit: 'hours' });
    const legacyM2 = { subprojects: [{ pricing: { type: 'unit', unit: 'm²' }, executionDuration: { value: 2, unit: 'days' } }] };
    expect(isQuantityDerivedExecution(legacyM2, 0)).toBe(false);
    expect(resolveScheduleDurations(legacyM2, 0, undefined, 1000, eightHourWeek)?.execution).toEqual({ value: 2, unit: 'days' });
  });

  it('keeps a frozen day-mode snapshot as booked', () => {
    const options = getBookingScheduleOptions({ scheduleSnapshot: { quantity: 16, executionDuration: { value: 2, unit: 'days' } } });
    expect(resolveScheduleDurations(hourly({ durationBasis: 'per_unit' }), 0, options.durationOverride, options.quantity, eightHourWeek)?.execution)
      .toEqual({ value: 2, unit: 'days' });
  });
});
