import Booking from '../../models/booking';
import User from '../../models/user';
import CancellationRequest from '../../models/cancellationRequest';
import { notify } from './notify';
import { notifyMilestonePaymentDue } from './milestonePaymentDue';
import { daysAgo, hasUnpaidExtras, shouldSendReminder } from './reminderRules';
import { processUnreadChatMirrorReminders } from './processUnreadChatMirrors';

export interface ReminderJobCounts {
  unfinishedCheckout: number;
  reschedule: number;
  refund: number;
  completion: number;
  completionExtraDue: number;
  review: number;
  rfqPending: number;
  notStarted: number;
  milestoneDue: number;
  unreadChat: number;
  idExpiry: number;
  errors: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REMINDERS = 5;

function shouldSend(
  lastSentAt: Date | undefined | null,
  count: number | undefined | null,
  intervalDays: number,
  maxCount = MAX_REMINDERS,
): boolean {
  return shouldSendReminder(lastSentAt, count, intervalDays, maxCount);
}

/**
 * Sweep overdue notification reminders. Designed for external cron →
 * POST /api/admin/run-notification-reminders
 */
export async function runNotificationReminders(): Promise<ReminderJobCounts> {
  const counts: ReminderJobCounts = {
    unfinishedCheckout: 0,
    reschedule: 0,
    refund: 0,
    completion: 0,
    completionExtraDue: 0,
    review: 0,
    rfqPending: 0,
    notStarted: 0,
    milestoneDue: 0,
    unreadChat: 0,
    idExpiry: 0,
    errors: [],
  };

  const now = new Date();
  console.log(`[Notification Reminders] Running at ${now.toISOString()}`);

  // --- Unfinished checkout (payment_pending ≥ 24h, then every 3d) ---
  try {
    const eligibleUnfinishedCheckout = {
      status: 'payment_pending',
      customer: { $exists: true, $ne: null },
      updatedAt: { $lte: daysAgo(1) },
      $and: [
        {
          $or: [
            { 'notificationReminders.unfinishedCheckoutCount': { $exists: false } },
            { 'notificationReminders.unfinishedCheckoutCount': { $lt: MAX_REMINDERS } },
          ],
        },
        {
          $or: [
            { 'notificationReminders.unfinishedCheckoutLastSentAt': { $exists: false } },
            { 'notificationReminders.unfinishedCheckoutLastSentAt': { $lte: daysAgo(3) } },
          ],
        },
      ],
    };
    const bookings = await Booking.find(eligibleUnfinishedCheckout)
      .select('_id')
      .sort({ updatedAt: 1, _id: 1 })
      .limit(200);

    const recoveryDiscountCode = process.env.MARKETING_ABANDONED_CHECKOUT_DISCOUNT_CODE?.trim() || '';

    for (const candidate of bookings) {
      const booking = await Booking.findOneAndUpdate(
        { _id: candidate._id, ...eligibleUnfinishedCheckout },
        {
          $set: { 'notificationReminders.unfinishedCheckoutLastSentAt': now },
          $inc: { 'notificationReminders.unfinishedCheckoutCount': 1 },
        },
        {
          new: false,
          projection: {
            _id: 1,
            customer: 1,
            notificationReminders: 1,
            'rfqData.serviceType': 1,
          },
        },
      );
      if (!booking) continue;

      const rem = booking.notificationReminders || {};
      const customerId = booking.customer?.toString();
      if (!customerId) continue;
      const reminderNumber = (rem.unfinishedCheckoutCount ?? 0) + 1;
      const discountCode =
        recoveryDiscountCode && reminderNumber >= 2 ? recoveryDiscountCode : undefined;
      try {
        const result = await notify({
          userId: customerId,
          eventKey: 'customer.unfinished_checkout',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            projectTitle: booking.rfqData?.serviceType,
            discountCode,
          },
        });
        if (result.emailOutcome === 'failed') {
          throw new Error('unfinished checkout email delivery failed');
        }
        counts.unfinishedCheckout++;
      } catch (e: any) {
        const rollback =
          rem.unfinishedCheckoutLastSentAt
            ? { $set: { 'notificationReminders.unfinishedCheckoutLastSentAt': rem.unfinishedCheckoutLastSentAt } }
            : { $unset: { 'notificationReminders.unfinishedCheckoutLastSentAt': 1 } };
        await Booking.updateOne(
          {
            _id: booking._id,
            'notificationReminders.unfinishedCheckoutLastSentAt': now,
          },
          {
            ...rollback,
            $inc: { 'notificationReminders.unfinishedCheckoutCount': -1 },
          },
        );
        counts.errors.push(`unfinishedCheckout ${booking._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`unfinishedCheckout query: ${e?.message || e}`);
  }

  // --- Reschedule pending every 3d ---
  try {
    const bookings = await Booking.find({
      status: 'rescheduling_requested',
      'rescheduleRequest.status': 'pending',
    }).select('_id customer professional notificationReminders rescheduleRequest').limit(200);

    for (const booking of bookings) {
      const rem = booking.notificationReminders || {};
      if (!shouldSend(rem.rescheduleLastSentAt, rem.rescheduleCount, 3)) continue;
      const customerId = booking.customer?.toString();
      const professionalId = booking.professional?.toString();
      const requestedBy = (booking as any).rescheduleRequest?.requestedBy?.toString?.();
      try {
        // Remind the party who still needs to respond
        if (requestedBy && professionalId && requestedBy === professionalId && customerId) {
          await notify({
            userId: customerId,
            eventKey: 'customer.reschedule_reminder',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
        } else if (professionalId) {
          await notify({
            userId: professionalId,
            eventKey: 'professional.reschedule_requested',
            entityType: 'booking',
            entityId: String(booking._id),
            ...(customerId ? { subjectUserId: customerId } : {}),
            meta: { reminder: true },
            context: { bookingId: String(booking._id) },
          });
        }
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: { 'notificationReminders.rescheduleLastSentAt': now },
            $inc: { 'notificationReminders.rescheduleCount': 1 },
          },
        );
        counts.reschedule++;
      } catch (e: any) {
        counts.errors.push(`reschedule ${booking._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`reschedule query: ${e?.message || e}`);
  }

  // --- Refund negotiation every 3d ---
  try {
    const requests = await CancellationRequest.find({
      status: { $in: ['pending', 'negotiating'] },
      requestedRole: 'customer',
      createdAt: { $lte: daysAgo(3) },
    }).select('_id booking requestedBy status createdAt').limit(200);

    for (const req of requests) {
      const booking = await Booking.findById(req.booking)
        .select('_id customer professional notificationReminders')
        .lean();
      if (!booking) continue;
      const rem = (booking as any).notificationReminders || {};
      if (!shouldSend(rem.refundLastSentAt, rem.refundCount, 3)) continue;

      try {
        const professionalId = (booking as any).professional?.toString?.();
        const customerId = (booking as any).customer?.toString?.();
        if (professionalId) {
          await notify({
            userId: professionalId,
            eventKey: 'professional.refund_request_reminder',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
        }
        if (customerId) {
          await notify({
            userId: customerId,
            eventKey: 'customer.refund_negotiation_reminder',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
        }
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: { 'notificationReminders.refundLastSentAt': now },
            $inc: { 'notificationReminders.refundCount': 1 },
          },
        );
        counts.refund++;
      } catch (e: any) {
        counts.errors.push(`refund ${req._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`refund query: ${e?.message || e}`);
  }

  // --- Completion request / extras due every 3d ---
  try {
    const bookings = await Booking.find({
      status: 'professional_completed',
      professionalCompletedAt: { $lte: daysAgo(3) },
    }).select('_id customer notificationReminders extraCostTotal extraCostStatus professionalCompletedAt').limit(200);

    for (const booking of bookings) {
      const rem = booking.notificationReminders || {};
      const customerId = booking.customer?.toString();
      if (!customerId) continue;
      const unpaidExtras = hasUnpaidExtras(booking);

      try {
        if (unpaidExtras) {
          if (!shouldSend(rem.completionExtraDueLastSentAt, rem.completionExtraDueCount, 3)) continue;
          await notify({
            userId: customerId,
            eventKey: 'customer.completion_extra_payment_due',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
          await Booking.updateOne(
            { _id: booking._id },
            {
              $set: { 'notificationReminders.completionExtraDueLastSentAt': now },
              $inc: { 'notificationReminders.completionExtraDueCount': 1 },
            },
          );
          counts.completionExtraDue++;
        } else {
          if (!shouldSend(rem.completionLastSentAt, rem.completionCount, 3)) continue;
          await notify({
            userId: customerId,
            eventKey: 'customer.completion_reminder',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
          await Booking.updateOne(
            { _id: booking._id },
            {
              $set: { 'notificationReminders.completionLastSentAt': now },
              $inc: { 'notificationReminders.completionCount': 1 },
            },
          );
          counts.completion++;
        }
      } catch (e: any) {
        counts.errors.push(`completion ${booking._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`completion query: ${e?.message || e}`);
  }

  // --- Review reminders at 10d and 20d ---
  try {
    const bookings = await Booking.find({
      status: 'completed',
      actualEndDate: { $lte: daysAgo(10) },
      $or: [
        { 'customerReview.communicationLevel': { $exists: false } },
        { 'professionalReview.rating': { $exists: false } },
      ],
      $and: [
        {
          $or: [
            { 'notificationReminders.reviewRemindersSent': { $exists: false } },
            { 'notificationReminders.reviewRemindersSent': { $lt: 2 } },
          ],
        },
      ],
    }).select('_id customer professional actualEndDate customerReview professionalReview notificationReminders').limit(200);

    for (const booking of bookings) {
      const rem = booking.notificationReminders || {};
      const sent = rem.reviewRemindersSent ?? 0;

      const endAt = booking.actualEndDate ? new Date(booking.actualEndDate).getTime() : 0;
      const daysSinceEnd = endAt ? (Date.now() - endAt) / DAY_MS : 0;
      const needFirst = sent === 0 && daysSinceEnd >= 10;
      const needSecond = sent === 1 && daysSinceEnd >= 20;
      if (!needFirst && !needSecond) continue;
      if (rem.reviewLastSentAt && rem.reviewLastSentAt.getTime() > Date.now() - DAY_MS) continue;

      try {
        const customerId = booking.customer?.toString();
        const professionalId = booking.professional?.toString();
        if (customerId && !(booking as any).customerReview?.communicationLevel) {
          await notify({
            userId: customerId,
            eventKey: 'customer.review_reminder',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
        }
        if (professionalId && !(booking as any).professionalReview?.rating) {
          await notify({
            userId: professionalId,
            eventKey: 'professional.review_reminder',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
        }
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: { 'notificationReminders.reviewLastSentAt': now },
            $inc: { 'notificationReminders.reviewRemindersSent': 1 },
          },
        );
        counts.review++;
      } catch (e: any) {
        counts.errors.push(`review ${booking._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`review query: ${e?.message || e}`);
  }

  // --- RFQ pending (status=rfq) every 3d ---
  try {
    const bookings = await Booking.find({
      status: 'rfq',
      createdAt: { $lte: daysAgo(3) },
      $or: [
        { 'notificationReminders.rfqPendingCount': { $exists: false } },
        { 'notificationReminders.rfqPendingCount': { $lt: 3 } },
      ],
    }).select('_id professional notificationReminders createdAt').limit(200);

    for (const booking of bookings) {
      const rem = booking.notificationReminders || {};
      if (!shouldSend(rem.rfqPendingLastSentAt, rem.rfqPendingCount, 3)) continue;
      const professionalId = booking.professional?.toString();
      if (!professionalId) continue;
      try {
        await notify({
          userId: professionalId,
          eventKey: 'professional.rfq_reminder',
          entityType: 'booking',
          entityId: String(booking._id),
          context: { bookingId: String(booking._id) },
        });
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: { 'notificationReminders.rfqPendingLastSentAt': now },
            $inc: { 'notificationReminders.rfqPendingCount': 1 },
          },
        );
        counts.rfqPending++;
      } catch (e: any) {
        counts.errors.push(`rfqPending ${booking._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`rfqPending query: ${e?.message || e}`);
  }

  // --- Booking not started when start date ≤ today, every 3d ---
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const bookings = await Booking.find({
      status: 'booked',
      scheduledStartDate: { $lte: startOfToday },
      actualStartDate: { $exists: false },
      $or: [
        { 'notificationReminders.notStartedCount': { $exists: false } },
        { 'notificationReminders.notStartedCount': { $lt: 3 } },
      ],
    }).select('_id professional notificationReminders scheduledStartDate').limit(200);

    for (const booking of bookings) {
      const rem = booking.notificationReminders || {};
      if (!shouldSend(rem.notStartedLastSentAt, rem.notStartedCount, 3)) continue;
      const professionalId = booking.professional?.toString();
      if (!professionalId) continue;
      try {
        await notify({
          userId: professionalId,
          eventKey: 'professional.booking_not_started_reminder',
          entityType: 'booking',
          entityId: String(booking._id),
          context: { bookingId: String(booking._id) },
        });
        await Booking.updateOne(
          { _id: booking._id },
          {
            $set: { 'notificationReminders.notStartedLastSentAt': now },
            $inc: { 'notificationReminders.notStartedCount': 1 },
          },
        );
        counts.notStarted++;
      } catch (e: any) {
        counts.errors.push(`notStarted ${booking._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`notStarted query: ${e?.message || e}`);
  }

  // --- Milestone payment due (payable but unpaid) ---
  // Covers custom_date milestones whose due date passed and any transition the
  // event-driven notifies missed. The per-milestone delivery key dedupes
  // repeats, so each payable milestone notifies exactly once.
  try {
    const bookings = await Booking.find({
      status: { $in: ['booked', 'in_progress', 'professional_completed'] },
      milestonePayments: { $elemMatch: { status: { $ne: 'paid' } } },
    }).select('_id').limit(200);

    for (const candidate of bookings) {
      try {
        const result = await notifyMilestonePaymentDue(String(candidate._id), { notifyProfessional: true });
        if (result.notified) counts.milestoneDue++;
      } catch (e: any) {
        counts.errors.push(`milestoneDue ${candidate._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`milestoneDue query: ${e?.message || e}`);
  }

  // --- Unread chat ≥ 24h (email mirror) ---
  try {
    const { sent, errors } = await processUnreadChatMirrorReminders();
    counts.unreadChat = sent;
    counts.errors.push(...errors);
  } catch (e: any) {
    counts.errors.push(`unreadChat query: ${e?.message || e}`);
  }

  // --- ID expiring within 30d, then every 15d ---
  try {
    const in30Days = new Date(Date.now() + 30 * DAY_MS);
    const professionals = await User.find({
      role: 'professional',
      idExpirationDate: { $exists: true, $ne: null, $lte: in30Days },
    }).select('_id idExpirationDate idExpiryReminderLastSentAt idExpiryReminderCount').limit(300);

    for (const user of professionals) {
      const exp = user.idExpirationDate ? new Date(user.idExpirationDate).getTime() : 0;
      if (!exp) continue;
      const count = user.idExpiryReminderCount ?? 0;
      const last = user.idExpiryReminderLastSentAt;
      const daysLeft = (exp - Date.now()) / DAY_MS;
      const firstDue = daysLeft <= 30 && count === 0;
      const followUpDue =
        count > 0 &&
        (!last || last.getTime() <= Date.now() - 15 * DAY_MS) &&
        count < MAX_REMINDERS;
      if (!firstDue && !followUpDue) continue;

      try {
        const eventKey = count === 0 ? 'professional.id_expiring' : 'professional.id_expiry_reminder';
        await notify({
          userId: user._id.toString(),
          eventKey,
          entityType: 'user',
          entityId: user._id.toString(),
          context: {},
        });
        await User.updateOne(
          { _id: user._id },
          {
            $set: { idExpiryReminderLastSentAt: now },
            $inc: { idExpiryReminderCount: 1 },
          },
        );
        counts.idExpiry++;
      } catch (e: any) {
        counts.errors.push(`idExpiry ${user._id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    counts.errors.push(`idExpiry query: ${e?.message || e}`);
  }

  console.log('[Notification Reminders] Done', counts);
  return counts;
}
