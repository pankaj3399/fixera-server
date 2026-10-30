/**
 * One-time backfill for legacy hour-mode schedules (client bug list #23b/c).
 *
 * Background: hour-mode wall times ("14:00") were converted to UTC instants
 * in UTC instead of the professional's real zone, because
 * `businessInfo.timezone` was never written (schema default 'UTC'). Legacy
 * rows therefore store wall-as-UTC (`14:00Z` for 14:00 Brussels) and render
 * +offset. New rows store the correct instant via the effective-zone resolver.
 *
 * What this script does (default `--dry-run`: read-only, logs what it WOULD
 * do; pass `--apply` to write):
 *  a. Backfills `businessInfo.timezone` from the business country for
 *     professionals whose stored zone is 'UTC'/missing and whose country maps
 *     to BE/NL/FR/DE/LU.
 *  b. Detects legacy wall-as-UTC hour-mode bookings: rows recording BOTH
 *     scheduledStartTime and scheduledEndTime whose recorded zone is
 *     null/'UTC' and whose stored start instant renders a different wall time
 *     than scheduledStartTime in the effective zone. Shifts the UTC-instants
 *     that encode the wall time (scheduledStartDate, scheduledExecutionEndDate,
 *     scheduledBufferStart/EndDate when present, and a pending
 *     rescheduleRequest.proposedSchedule's scheduled*Date fields) by the
 *     DST-aware wall mismatch so the rendered wall time equals the recorded
 *     wall times again. Never touches scheduledStartTime/scheduledEndTime
 *     strings, resourcePlan day entries, previous schedules, or history.
 *     Rebuilds calendar reservations idempotently via replaceBookingCalendar
 *     (release + reserve). Rows whose wall time already matches are correct
 *     new rows and are left untouched (also skips on re-run: zone + wall match).
 *
 * Safety: skips rows whose shifted window would collide with another
 * source's reservations (logs them); never deletes other writers' rows.
 *
 * Usage:
 *   npx tsx src/scripts/migrate/migrateHourModeScheduleTimeZones.ts [--dry-run|--apply]
 *
 * NEVER run against a real database without a backup and product sign-off.
 */
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';
import path from 'path';
import Booking from '../../models/booking';
import User from '../../models/user';
import CalendarReservation from '../../models/calendarReservation';
import { replaceBookingCalendar } from '../../utils/support/bookingCalendar';
import { resolveEffectiveScheduleTimeZone } from '../../utils/scheduleEngine';
import {
  computeShiftedSchedule,
  computeWallMismatch,
  isLegacyHourScheduleCandidate,
  parseWallMinutes,
  renderWallMinutes,
  resolveProfessionalBackfillZone,
} from '../../utils/hourScheduleRepair';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

const toObjectId = (value: unknown): Types.ObjectId | null => {
  try {
    const inner =
      value !== null && typeof value === 'object' && '_id' in (value as Record<string, unknown>)
        ? (value as Record<string, unknown>)._id
        : value;
    const id = inner instanceof Types.ObjectId ? inner.toHexString() : String(inner);
    return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
  } catch {
    return null;
  }
};

const toDateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
};

async function main(): Promise<void> {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI or MONGODB_URI not found in environment variables');
  }

  console.log(`Hour-mode schedule timezone migration (${APPLY ? 'APPLY' : 'DRY-RUN'})...`);
  await mongoose.connect(mongoUri);
  console.log('Connected.');

  // (a) Professional timezone backfill.
  const pros = await User.find({
    role: 'professional',
    $or: [
      { 'businessInfo.timezone': 'UTC' },
      { 'businessInfo.timezone': { $exists: false } },
      { 'businessInfo.timezone': null },
    ],
  })
    .select('businessInfo.timezone businessInfo.country')
    .lean();
  let proBackfilled = 0;
  let proSkipped = 0;
  for (const pro of pros as Array<{ _id: unknown; businessInfo?: { timezone?: unknown; country?: unknown } }>) {
    const zone = resolveProfessionalBackfillZone(pro?.businessInfo);
    if (!zone) {
      proSkipped++;
      continue;
    }
    if (APPLY) {
      await User.updateOne({ _id: pro._id }, { $set: { 'businessInfo.timezone': zone } });
    }
    proBackfilled++;
  }
  console.log(`Professionals: ${proBackfilled} would be/have been backfilled, ${proSkipped} skipped (unmapped country).`);

  // (b) Legacy booking detection + shift.
  const candidates = await Booking.find({
    scheduledStartTime: { $type: 'string' },
    $or: [{ scheduleTimeZone: null }, { scheduleTimeZone: 'UTC' }],
    scheduledStartDate: { $exists: true, $ne: null },
    scheduledExecutionEndDate: { $exists: true, $ne: null },
  })
    .select(
      'professional assignedTeamMembers resourcePlan status scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledStartTime scheduledEndTime scheduleTimeZone rescheduleRequest'
    )
    .lean();

  let scanned = 0;
  let alreadyCorrect = 0;
  let skippedNoZone = 0;
  let skippedConflict = 0;
  let shifted = 0;

  for (const row of candidates as Array<Record<string, any>>) {
    scanned++;
    if (!isLegacyHourScheduleCandidate(row)) continue;

    const professionalId = toObjectId(row.professional);
    const professional = professionalId
      ? await User.findById(professionalId).select('businessInfo.timezone businessInfo.country').lean()
      : null;
    const effectiveZone = resolveEffectiveScheduleTimeZone(
      (professional as { businessInfo?: { timezone?: string | null; country?: string | null } } | null) || undefined,
      undefined
    );
    if (effectiveZone === 'UTC' && String((professional as any)?.businessInfo?.country || '').trim() === '') {
      // No usable zone info at all: cannot interpret the wall times safely.
      skippedNoZone++;
      continue;
    }

    const start = toDateOrNull(row.scheduledStartDate);
    const execEnd = toDateOrNull(row.scheduledExecutionEndDate);
    if (!start || !execEnd) continue;

    const mismatch = computeWallMismatch({
      instant: start,
      wantTime: row.scheduledStartTime,
      timeZone: effectiveZone,
    });
    if (mismatch.match) {
      alreadyCorrect++;
      continue;
    }

    // Duration-preserving end check: warn when the shifted end would not
    // render the recorded end time (e.g. DST edge), but still shift by the
    // start delta so the window keeps its length.
    const wantEnd = parseWallMinutes(row.scheduledEndTime);
    if (wantEnd != null) {
      const shiftedEnd = new Date(execEnd.getTime() + mismatch.deltaMs);
      const renderedEnd = renderWallMinutes(shiftedEnd, effectiveZone);
      if (renderedEnd !== wantEnd) {
        console.warn(
          `  booking ${String(row._id)}: shifted end renders ` +
            `${renderedEnd} but recorded end is ${row.scheduledEndTime}; shifting by start delta anyway`
        );
      }
    }

    const newStart = new Date(start.getTime() + mismatch.deltaMs);
    const shiftedSchedule = computeShiftedSchedule(
      {
        scheduledStartDate: start,
        scheduledExecutionEndDate: execEnd,
        scheduledBufferStartDate: toDateOrNull(row.scheduledBufferStartDate),
        scheduledBufferEndDate: toDateOrNull(row.scheduledBufferEndDate),
      },
      mismatch.deltaMs
    );
    const newEnd = (shiftedSchedule.scheduledBufferEndDate ||
      shiftedSchedule.scheduledExecutionEndDate) as Date;

    const assignedIds = Array.isArray(row.assignedTeamMembers)
      ? row.assignedTeamMembers.map((m: unknown) => toObjectId(m)).filter(Boolean)
      : [];
    const attendeeIds = (assignedIds.length > 0 ? assignedIds : [toObjectId(professionalId)]).filter(
      Boolean
    ) as Types.ObjectId[];

    // Collision guard: never move into another source's reserved buckets.
    // Own current rows are released before reserving, so exclude them here.
    const colliding = await CalendarReservation.find({
      userId: { $in: attendeeIds },
      startAt: { $lt: newEnd },
      endAt: { $gt: newStart },
      $nor: [{ sourceType: 'booking', sourceId: row._id }],
    })
      .select('_id')
      .lean();
    if (colliding.length > 0) {
      skippedConflict++;
      console.warn(
        `  booking ${String(row._id)}: shifted window collides with ${colliding.length} foreign reservation(s); skipping`
      );
      continue;
    }

    const setFields: Record<string, unknown> = {
      scheduledStartDate: shiftedSchedule.scheduledStartDate,
      scheduledExecutionEndDate: shiftedSchedule.scheduledExecutionEndDate,
      scheduleTimeZone: effectiveZone,
    };
    if (shiftedSchedule.scheduledBufferStartDate) {
      setFields.scheduledBufferStartDate = shiftedSchedule.scheduledBufferStartDate;
    }
    if (shiftedSchedule.scheduledBufferEndDate) {
      setFields.scheduledBufferEndDate = shiftedSchedule.scheduledBufferEndDate;
    }
    // A pending proposal becomes live on accept: shift it by the same delta.
    const proposed = (row.rescheduleRequest as Record<string, any> | undefined)?.proposedSchedule;
    if (
      (row.rescheduleRequest as Record<string, any> | undefined)?.status === 'pending' &&
      proposed &&
      typeof proposed === 'object'
    ) {
      for (const key of [
        'scheduledStartDate',
        'scheduledExecutionEndDate',
        'scheduledBufferStartDate',
        'scheduledBufferEndDate',
      ]) {
        const current = toDateOrNull((proposed as Record<string, unknown>)[key]);
        if (current) {
          setFields[`rescheduleRequest.proposedSchedule.${key}`] = new Date(
            current.getTime() + mismatch.deltaMs
          );
        }
      }
    }

    if (!APPLY) {
      console.log(
        `  would shift booking ${String(row._id)} by ${mismatch.deltaMs / 60000} min ` +
          `(${start.toISOString()} -> ${newStart.toISOString()}, zone ${effectiveZone})`
      );
      shifted++;
      continue;
    }

    await Booking.updateOne({ _id: row._id }, { $set: setFields });
    await replaceBookingCalendar({
      _id: row._id,
      professional: professionalId || undefined,
      assignedTeamMembers: attendeeIds,
      resourcePlan: Array.isArray(row.resourcePlan) ? row.resourcePlan : [],
      scheduledStartDate: shiftedSchedule.scheduledStartDate,
      scheduledExecutionEndDate: shiftedSchedule.scheduledExecutionEndDate,
      scheduledBufferEndDate:
        shiftedSchedule.scheduledBufferEndDate || shiftedSchedule.scheduledExecutionEndDate,
    } as never);
    shifted++;
  }

  console.log(
    `Bookings scanned: ${scanned}; already correct: ${alreadyCorrect}; ` +
      `shifted${APPLY ? '' : ' (dry-run)'}: ${shifted}; ` +
      `skipped (no zone): ${skippedNoZone}; skipped (conflict): ${skippedConflict}.`
  );

  await mongoose.disconnect();
  console.log('Done.');
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error('Hour-mode schedule timezone migration failed:', error);
    process.exitCode = 1;
  });
