/**
 * Central, append-only archive of booking status transitions.
 *
 * Every code path that changes a booking's status appends to
 * `statusHistory` — via `doc.save()` (updateStatus, handlers) or an atomic
 * `$push` update. The Booking model hooks call into this module for both, so
 * the archive is complete without touching each handler:
 * - the executioner is the entry's `updatedBy`, else the authenticated
 *   request actor (utils/requestActor), else "system" (cron/webhook);
 * - missing `updatedBy` on new entries is filled from the request actor;
 * - a small snapshot of the context the transition happened in is kept
 *   (dispute, cancellation, reschedule request, completion evidence, quote
 *   rejection), so later overwrites of those single-object fields lose
 *   nothing.
 * Archiving is best-effort: it never fails the booking write.
 */
import { Types, type ClientSession } from 'mongoose';
import BookingEvent from '../../models/bookingEvent';
import { currentRequestActor } from '../requestActor';

const TEXT_MAX = 1000;
const MAX_ATTACHMENTS = 20;

type Entry = { status?: unknown; timestamp?: unknown; updatedBy?: unknown; note?: unknown };

const str = (value: unknown, max = TEXT_MAX): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};
const idOf = (value: unknown): string | undefined => {
  if (!value) return undefined;
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (typeof value === 'object' && (value as any)._id) return String((value as any)._id);
  const text = String(value);
  return Types.ObjectId.isValid(text) ? text : undefined;
};
const dateOf = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const urls = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((url): url is string => typeof url === 'string' && url.trim().length > 0) : [];

/** Snapshot of the context relevant to a transition into `status`. Small by construction. */
export function contextSnapshot(booking: any, status: string): { context?: Record<string, unknown>; attachments: string[] } {
  const context: Record<string, unknown> = {};
  let attachments: string[] = [];
  const plain = (value: any) => (value && typeof value.toObject === 'function' ? value.toObject() : value);

  const dispute = plain(booking?.dispute);
  if (status === 'dispute' && dispute) {
    context.dispute = {
      type: str(dispute.type, 50),
      reason: str(dispute.reason, 500),
      description: str(dispute.description),
      raisedBy: idOf(dispute.raisedBy),
      raisedAt: dateOf(dispute.raisedAt),
    };
    attachments = urls(dispute.attachments);
  }
  const cancellation = plain(booking?.cancellation);
  if ((status === 'cancelled' || status === 'refunded') && cancellation) {
    context.cancellation = {
      reason: str(cancellation.reason, 500),
      cancelledBy: idOf(cancellation.cancelledBy),
      cancelledAt: dateOf(cancellation.cancelledAt),
      refundAmount: typeof cancellation.refundAmount === 'number' ? cancellation.refundAmount : undefined,
    };
  }
  const reschedule = plain(booking?.rescheduleRequest);
  if (status === 'rescheduling_requested' && reschedule) {
    context.reschedule = {
      reason: str(reschedule.reason, 500),
      description: str(reschedule.description),
      requestedBy: idOf(reschedule.requestedBy),
      proposedStartDate: dateOf(reschedule.proposedSchedule?.scheduledStartDate),
    };
  }
  const attestation = plain(booking?.completionAttestation);
  if ((status === 'professional_completed' || status === 'completed') && attestation) {
    context.completion = { notes: str(attestation.notes), confirmedBy: idOf(attestation.confirmedBy) };
    attachments = urls(attestation.attachments);
  }
  if (status === 'quote_rejected') {
    const reason = str(booking?.customerRejectionReason, 500);
    if (reason) context.quoteRejection = { reason };
  }
  for (const value of Object.values(context)) {
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) if (inner === undefined) delete (value as any)[key];
    }
  }
  return {
    ...(Object.keys(context).length ? { context } : {}),
    attachments: attachments.slice(0, MAX_ATTACHMENTS),
  };
}

/** Fills a missing `updatedBy` on new statusHistory entries from the request actor. */
export function stampEntryActors(entries: Entry[]): void {
  const actor = currentRequestActor();
  if (!actor || !Types.ObjectId.isValid(actor.userId)) return;
  for (const entry of entries) {
    if (entry && !entry.updatedBy) entry.updatedBy = new Types.ObjectId(actor.userId);
  }
}

function actorRoleFor(booking: any, actorId: string | undefined): 'customer' | 'professional' | 'admin' | 'employee' | 'system' {
  if (!actorId) return 'system';
  const request = currentRequestActor();
  if (request && request.userId === actorId) {
    const role = request.role;
    if (role === 'customer' || role === 'professional' || role === 'admin' || role === 'employee') return role;
  }
  if (idOf(booking?.customer) === actorId) return 'customer';
  if (idOf(booking?.professional) === actorId) return 'professional';
  return 'system';
}

/** Writes one archive row per new statusHistory entry. Never throws. */
export async function archiveStatusEntries(
  booking: any,
  entries: Entry[],
  previousStatus: string | null | undefined,
  session?: ClientSession | null,
): Promise<void> {
  try {
    const bookingId = idOf(booking?._id);
    if (!bookingId || entries.length === 0) return;
    const requestActor = currentRequestActor();
    let from: string | null = previousStatus ?? null;
    const rows = entries.flatMap((entry) => {
      const to = str(entry?.status, 60);
      if (!to) return [];
      const entryActor = idOf(entry.updatedBy);
      const actorId = entryActor ?? (requestActor && Types.ObjectId.isValid(requestActor.userId) ? requestActor.userId : undefined);
      const { context, attachments } = contextSnapshot(booking, to);
      const row = {
        booking: bookingId,
        type: 'status_changed' as const,
        at: dateOf(entry.timestamp) ?? new Date(),
        statusFrom: from,
        statusTo: to,
        actor: actorId ?? null,
        actorRole: actorRoleFor(booking, actorId),
        actorFromEntry: Boolean(entryActor),
        ...(str(entry.note) ? { note: str(entry.note) } : {}),
        ...(context ? { context } : {}),
        attachments,
      };
      from = to;
      return [row];
    });
    // Same session as the booking write: a rolled-back (or retried)
    // transaction must not leave phantom or duplicate archive rows.
    if (rows.length) await BookingEvent.insertMany(rows, { ordered: false, ...(session ? { session } : {}) });
  } catch (err) {
    console.error('[bookingEvents] archive write failed (booking write unaffected):', err);
  }
}

/** Entries pushed by an update document ({$push: {statusHistory: x | {$each: [...]}}}). */
export function pushedStatusEntries(update: any): Entry[] {
  const push = update?.$push?.statusHistory;
  if (!push) return [];
  if (push && typeof push === 'object' && Array.isArray(push.$each)) return push.$each as Entry[];
  return [push as Entry];
}
