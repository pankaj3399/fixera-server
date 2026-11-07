import { releaseBookingCalendar, replaceBookingCalendar } from "./support/bookingCalendar";
import { DateTime } from 'luxon';

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfUtcDay = (value: Date): Date =>
  new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 0, 0, 0, 0));

/** A booking counts as started once work began (or the status proves it). */
export const isBookingStarted = (booking: any): boolean => {
  if (!booking) return false;
  if (booking.actualStartDate || booking.refundPreservesPastPlanning) return true;
  const started = ["in_progress", "professional_completed", "completed"];
  return started.includes(String(booking.status))
    || started.includes(String(booking.statusBeforeDispute))
    || (booking.statusHistory || []).some((entry: any) => started.includes(String(entry.status)));
};

/** Capture the started state before a refund changes the booking status. */
export const preparePartialRefundCancellation = (booking: any, wasStarted: boolean): void => {
  if (isPreCompletionStatus(booking.status)) booking.status = 'cancelled';
  booking.refundPreservesPastPlanning = wasStarted;
  if (wasStarted) pruneFutureResourcePlanDays(booking);
};

/**
 * Drop every planned day that has not passed yet from the in-memory resource
 * plan. Days that already passed stay exactly as they are so their resources
 * keep the block in their calendars. Returns the kept/removed day counts.
 */
export const pruneFutureResourcePlanDays = (
  booking: any,
  now: Date = new Date(),
): { keptDays: number; removedDays: number } => {
  let keptDays = 0;
  let removedDays = 0;
  if (!Array.isArray(booking?.resourcePlan)) return { keptDays, removedDays };
  const localNow = DateTime.fromJSDate(now).setZone(booking.scheduleTimeZone || 'UTC');
  const todayStart = localNow.isValid
    ? Date.UTC(localNow.year, localNow.month - 1, localNow.day)
    : startOfUtcDay(now).getTime();
  for (const entry of booking.resourcePlan) {
    if (!Array.isArray(entry?.days)) continue;
    const kept: Date[] = [];
    for (const raw of entry.days) {
      const day = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(day.getTime())) continue;
      if (startOfUtcDay(day).getTime() < todayStart) {
        kept.push(day instanceof Date ? day : new Date(day));
        keptDays += 1;
      } else {
        removedDays += 1;
      }
    }
    entry.days = kept;
  }
  return { keptDays, removedDays };
};

/**
 * After a partial refund on a started booking: past planned days keep their
 * calendar blocks, future days are freed. Replaces the whole reservation set
 * from the (already pruned) plan: release-all + re-reserve is exactly what
 * keeps past blocks while dropping future ones. Never throws; a calendar
 * failure must not roll back an already-issued refund.
 */
export const retainPastBookingCalendar = async (booking: any): Promise<void> => {
  try {
    if (booking.resourcePlan?.some((entry: any) => entry.days?.length > 0)) {
      await replaceBookingCalendar(booking);
    } else {
      // An empty retained plan must not invoke the whole-window fallback.
      await releaseBookingCalendar(booking._id);
    }
  } catch (error) {
    console.error(
      `Partial refund kept past calendar blocks for booking ${booking?._id}, but the reservation replace failed:`,
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * Generate FIX + SUP invoices for a partially refunded booking, or partial
 * credit notes when the invoices were already issued. Fully idempotent:
 * existing artifacts are never regenerated, retries converge, and a stale
 * generation claim recovers through the shared machinery. Never throws.
 */
export const ensureRefundInvoices = async (bookingId: string): Promise<void> => {
  try {
    const startedAt = new Date();
    const { ensureBookingInvoiceArtifacts, ensurePartialRefundCreditArtifacts, CREDIT_GENERATION_CLAIM_TTL_MS } = await import("../services/invoiceArtifacts");
    const outcome = await ensurePartialRefundCreditArtifacts(bookingId);
    const Booking = (await import('../models/booking')).default;
    if (outcome === 'busy') {
      // Durable retry: this survives worker/process shutdown and is picked up
      // by the existing reminder cron after the competing lease can expire.
      const retryAt = new Date(Date.now() + CREDIT_GENERATION_CLAIM_TTL_MS + 1000);
      await Booking.updateOne({ _id: bookingId, $or: [
        { 'payment.refundInvoiceRetryAt': null },
        { 'payment.refundInvoiceRetryAt': { $gt: retryAt } },
      ] }, { $set: { 'payment.refundInvoiceRetryAt': retryAt } });
      return;
    }
    if (outcome === "generate") {
      await ensureBookingInvoiceArtifacts(bookingId);
    }
    await Booking.updateOne({ _id: bookingId, 'payment.refundInvoiceRetryAt': { $lte: startedAt } },
      { $unset: { 'payment.refundInvoiceRetryAt': '' } });
  } catch (error) {
    console.error(
      `Failed to generate refund invoices for booking ${bookingId}:`,
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * Booking states a partial refund may still close. Terminal, dispute-managed
 * and post-completion states keep the status their own flow assigned.
 * Shared by executeRefund and the negotiation finalizer so neither can
 * clobber a status owned by another flow.
 */
export const isPreCompletionStatus = (status: unknown): boolean =>
  [
    'booked',
    'in_progress',
    'professional_completed',
    'payment_pending',
    'quote_accepted',
    'rescheduling_requested',
  ].includes(String(status));

/** True when the refund leaves a billable remainder (i.e. it is partial).
 * Any positive remainder counts, including sub-cent dust: Stripe cannot move
 * fractions of a cent, so a remainder below €0.01 rounds to zero in the
 * documents while the refund block is still shown for the exact amount. */
export const leavesBillableRemainder = (totalWithVat: unknown, refundAmount: unknown): boolean => {
  const total = Number(totalWithVat);
  const refund = Number(refundAmount);
  return (
    Number.isFinite(total) &&
    Number.isFinite(refund) &&
    refund > 0 &&
    total - refund > 0
  );
};

/** Whole UTC days from today until the given date (negative when past). */
export const utcDaysUntil = (value: Date | string | undefined | null, now: Date = new Date()): number | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((startOfUtcDay(date).getTime() - startOfUtcDay(now).getTime()) / DAY_MS);
};


/** Drain due durable retries in stable pages; a busy attempt moves into the future. */
export const retryPendingRefundInvoices = async (now = new Date()): Promise<void> => {
  const Booking = (await import('../models/booking')).default;
  let after: unknown;
  while (true) {
    const due = await Booking.find({ 'payment.refundInvoiceRetryAt': { $lte: now },
      ...(after ? { _id: { $gt: after } } : {}),
    }).select('_id').sort({ _id: 1 }).limit(200);
    if (!due.length) return;
    for (const candidate of due) {
      after = candidate._id;
      await ensureRefundInvoices(String(candidate._id));
    }
  }
};
