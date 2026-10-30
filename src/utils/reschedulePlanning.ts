/**
 * Reschedule plan reset (client bug list #9b, day-mode only).
 *
 * A rescheduled start date overrules earlier manual planning:
 * - all planned dates before the new start date become unplanned (all resources),
 * - planning on/after the new start date is kept,
 * - when the kept plan is shorter than the minimum execution duration, days
 *   are added across the assigned resources so the booking duration stays as
 *   short as possible (day-by-day fill, round-robin over resources).
 *
 * Minimum execution duration (resource-days):
 *   executionTime + executionTime * (resourceCount - 1) * overlapFraction
 *
 * All helpers here are pure (UTC day keys) so they unit-test without a DB.
 */

import { toZonedTime } from './scheduleEngine';

export type PlannedDayInput = {
  resourceId: string;
  days: Array<Date | string>;
};

export type PlannedDayEntry = {
  resourceId: string;
  days: string[];
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

export const toPlanDayKey = (value: Date | string): string | null => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

/**
 * Day key in the professional's timezone. `scheduledStartDate` is stored as a
 * real local-midnight instant (e.g. Nov 2 Brussels = 2026-11-01T23:00Z), so a
 * plain UTC key would point at the previous calendar day. Planning labels
 * (`resourcePlan` days) use these local labels.
 */
export const toPlanDayKeyInTimeZone = (value: Date | string, timeZone: string): string | null => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return toPlanDayKey(toZonedTime(date, timeZone));
};

export const planKeyToDate = (key: string): Date | null => {
  const parts = key.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date;
};

export const addPlanDays = (key: string, days: number): string | null => {
  const date = planKeyToDate(key);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return toPlanDayKey(date);
};

/**
 * Minimum execution duration expressed in resource-days:
 * executionTime + executionTime * (resourceCount - 1) * overlapFraction.
 */
export const computeMinExecutionResourceDays = ({
  executionDays,
  resourceCount,
  overlapFraction,
}: {
  executionDays: number;
  resourceCount: number;
  overlapFraction: number;
}): number => {
  const exec = Number.isFinite(executionDays) ? Math.max(1, Math.ceil(executionDays)) : 1;
  const count = Number.isFinite(resourceCount) ? Math.max(1, Math.floor(resourceCount)) : 1;
  const overlap = Number.isFinite(overlapFraction) ? Math.min(Math.max(overlapFraction, 0), 1) : 1;
  return Math.max(1, Math.ceil(exec + exec * (count - 1) * overlap));
};

/**
 * Resolve the execution duration in days for a day-mode booking, mirroring
 * the schedule-snapshot-first precedence used at booking/planning time.
 * Returns null when the booking is not day-mode (hour-mode is owned by
 * another workstream and must stay untouched).
 */
export const resolveDayModeExecutionDays = ({
  scheduleSnapshot,
  project,
  selectedSubprojectIndex,
}: {
  scheduleSnapshot?: { executionDuration?: { value?: unknown; unit?: unknown } } | null;
  project?: {
    executionDuration?: { value?: unknown; unit?: unknown; range?: { min?: unknown; max?: unknown } } | null;
    subprojects?: Array<{ executionDuration?: { value?: unknown; unit?: unknown; range?: { min?: unknown; max?: unknown } } | null }> | null;
  } | null;
  selectedSubprojectIndex?: unknown;
}): number | null => {
  const snapshot = scheduleSnapshot?.executionDuration;
  if (snapshot?.unit === 'days' && typeof snapshot.value === 'number' && snapshot.value > 0) {
    return Math.max(1, Math.ceil(snapshot.value));
  }
  if (snapshot?.unit === 'hours') return null;

  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

  let execution: { value?: unknown; unit?: unknown; range?: { min?: unknown; max?: unknown } } | null | undefined =
    project?.executionDuration;
  if (
    typeof selectedSubprojectIndex === 'number' &&
    Array.isArray(project?.subprojects) &&
    project.subprojects[selectedSubprojectIndex]?.executionDuration
  ) {
    execution = project.subprojects[selectedSubprojectIndex].executionDuration;
  }
  if (!execution) return null;
  if (execution.unit === 'hours') return null;
  if (execution.unit !== 'days') return null;
  const value = num(execution.value) ?? num(execution.range?.max) ?? num(execution.range?.min);
  return value == null ? null : Math.max(1, Math.ceil(value));
};

export type RebuildPlanInput = {
  resourcePlan: PlannedDayInput[];
  newStartKey: string;
  assignedResourceIds: string[];
  blockedByResource?: Map<string, Set<string>>;
  minResourceDays: number;
  /** Working execution days; the plan must cover newStart .. newStart + executionDays - 1. */
  executionDays: number;
  /** Minimum distinct free resources required on each execution-window day. */
  minResourcesPerDay: number;
};

export type RebuildPlanResult = {
  resourcePlan: PlannedDayEntry[];
  keptDays: number;
  removedDays: number;
  hadPlan: boolean;
  addedDays: Array<{ resourceId: string; dayKey: string }>;
  maxDayKey: string | null;
};

/**
 * Drop every planned day before `newStartKey`, keep the rest, and top the
 * plan back up:
 * 1. every execution-window day (newStart .. newStart + executionDays - 1)
 *    gets at least `minResourcesPerDay` distinct free resources (blocked
 *    resources are skipped; a day that cannot reach the minimum carries its
 *    deficit forward);
 * 2. the total reaches at least max(minResourceDays, executionDays *
 *    minResourcesPerDay) resource-days;
 * 3. remaining resource-days are added one per calendar day, earliest first,
 *    so the span stays as short as possible and never ends before the
 *    execution window (it only extends beyond the window when blocks force it).
 * Re-running on the result is a no-op.
 */
export const rebuildResourcePlanForNewStart = ({
  resourcePlan,
  newStartKey,
  assignedResourceIds,
  blockedByResource,
  minResourceDays,
  executionDays,
  minResourcesPerDay,
}: RebuildPlanInput): RebuildPlanResult => {
  const entries = new Map<string, Set<string>>();
  let plannedBefore = 0;

  for (const entry of Array.isArray(resourcePlan) ? resourcePlan : []) {
    const rid = typeof entry?.resourceId === 'string' ? entry.resourceId : String(entry?.resourceId ?? '');
    if (!rid) continue;
    const kept = new Set<string>();
    for (const day of Array.isArray(entry?.days) ? entry.days : []) {
      const key = toPlanDayKey(day);
      if (!key) continue;
      plannedBefore++;
      if (key >= newStartKey) kept.add(key);
    }
    if (kept.size > 0) entries.set(rid, kept);
  }

  const hadPlan = plannedBefore > 0;
  let keptDays = 0;
  entries.forEach((days) => {
    keptDays += days.size;
  });
  const removedDays = Math.max(0, plannedBefore - keptDays);

  const addedDays: Array<{ resourceId: string; dayKey: string }> = [];
  const execDays = Number.isFinite(executionDays) ? Math.max(1, Math.ceil(executionDays)) : 1;
  const minPerDay = Number.isFinite(minResourcesPerDay) ? Math.max(0, Math.floor(minResourcesPerDay)) : 0;
  const orderedIds = Array.from(new Set((assignedResourceIds || []).filter(Boolean)));
  const targetTotal = Math.max(Math.ceil(minResourceDays), execDays * minPerDay);

  const isBlocked = (rid: string, key: string): boolean =>
    blockedByResource?.get(rid)?.has(key) ?? false;
  const daysOf = (rid: string): Set<string> => {
    let days = entries.get(rid);
    if (!days) {
      days = new Set<string>();
      entries.set(rid, days);
    }
    return days;
  };
  const addDay = (rid: string, key: string): void => {
    daysOf(rid).add(key);
    keptDays++;
    addedDays.push({ resourceId: rid, dayKey: key });
  };

  if (hadPlan && orderedIds.length > 0 && minPerDay > 0) {
    // Phase A: cover each execution-window day with enough free resources.
    for (let offset = 0; offset < execDays; offset++) {
      const key = addPlanDays(newStartKey, offset);
      if (!key) continue;
      const free = orderedIds.filter((rid) => !isBlocked(rid, key));
      if (free.length < minPerDay) continue; // deficit carried forward to Phase B
      let have = 0;
      for (const rid of free) {
        if (entries.get(rid)?.has(key)) have++;
      }
      for (const rid of free) {
        if (have >= minPerDay) break;
        if (entries.get(rid)?.has(key)) continue;
        addDay(rid, key);
        have++;
      }
    }

    // Phase B: top up to the target total, one resource-day per calendar day,
    // earliest first (extends beyond the window only when blocks force it).
    let need = targetTotal - keptDays;
    let cursorKey: string | null = newStartKey;
    let guard = 0;
    while (need > 0 && cursorKey && guard < 366 * 2 + execDays) {
      guard++;
      const rid = orderedIds.find((id) => !isBlocked(id, cursorKey as string) && !entries.get(id)?.has(cursorKey as string));
      if (rid) {
        addDay(rid, cursorKey);
        need--;
      }
      cursorKey = addPlanDays(cursorKey, 1);
    }
  }

  const resourcePlanOut: PlannedDayEntry[] = [];
  let maxDayKey: string | null = null;
  entries.forEach((days, resourceId) => {
    const sorted = Array.from(days).sort();
    if (sorted.length === 0) return;
    resourcePlanOut.push({ resourceId, days: sorted });
    const last = sorted[sorted.length - 1];
    if (!maxDayKey || last > maxDayKey) maxDayKey = last;
  });

  return { resourcePlan: resourcePlanOut, keptDays, removedDays, hadPlan, addedDays, maxDayKey };
};
