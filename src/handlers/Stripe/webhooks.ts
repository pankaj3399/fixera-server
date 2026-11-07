import { releaseReferralReservation } from '../../utils/referralDiscount';
/**
 * Stripe Webhook Handlers
 * Processes Stripe webhook events
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import User from '../../models/user';
import StripeEvent from '../../models/stripeEvent';
import DiscountCode from '../../models/discountCode';
import DiscountCodeUsage from '../../models/discountCodeUsage';
import { recordPaymentDiscountSnapshot } from '../../utils/paymentDiscountLedger';
import { convertFromStripeAmount } from '../../utils/payment';
import { mapStripeAccountStatus } from '../../utils/stripeAccountStatus';
import { deductPoints } from '../../utils/pointsSystem';
import { notify } from '../../utils/notifications/notify';
import { paymentConfirmationAmount } from '../../utils/paymentConfirmationAmount';
import { notifyBookingPaymentConfirmed } from '../../utils/notifications/bookingPaymentNotify';
import { notifyMilestonePaymentDue } from '../../utils/notifications/milestonePaymentDue';
import { reconcileExtraCostPayment } from '../../services/extraCostPayment';
import { getProfessionalId } from '../../utils/bookingHelpers';
import {
  loadBasePaymentRows,
  recordBasePaymentRefund,
} from '../../utils/paymentRefundLedger';
import { refundCountsAsCash } from '../../utils/paymentRefunds';
import { SYSTEM_USER_ID } from '../../constants/system';
import { safeErrorSummary } from '../../utils/safeErrorLog';

const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const reserveWebhookEvent = async (event: Stripe.Event): Promise<{ shouldProcess: boolean }> => {
  const now = new Date();

  try {
    const insertResult = await StripeEvent.updateOne(
      { eventId: event.id },
      {
        $setOnInsert: {
          eventId: event.id,
          eventType: event.type,
          status: 'processing',
          attempts: 1,
          stripeCreatedAt: new Date(event.created * 1000),
          firstSeenAt: now,
          lastAttemptAt: now,
        },
      },
      { upsert: true }
    );

    if (insertResult.upsertedCount === 1) {
      return { shouldProcess: true };
    }

    const existing = await StripeEvent.findOne({ eventId: event.id }).lean();
    if (
      existing?.status === 'processing' &&
      (!existing.lastAttemptAt || existing.lastAttemptAt.getTime() < now.getTime() - WEBHOOK_PROCESSING_LEASE_MS)
    ) {
      const claimResult = await StripeEvent.updateOne(
        {
          eventId: event.id,
          status: 'processing',
          $or: [
            { lastAttemptAt: { $exists: false } },
            { lastAttemptAt: null },
            { lastAttemptAt: { $lt: new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS) } },
          ],
        },
        {
          $set: { lastAttemptAt: now },
          $unset: { lastError: 1 },
          $inc: { attempts: 1 },
        },
      );
      if (claimResult.modifiedCount === 1) {
        return { shouldProcess: true };
      }
    }
    if (existing?.status === 'failed') {
      const claimResult = await StripeEvent.updateOne(
        { eventId: event.id, status: 'failed' },
        {
          $set: { status: 'processing', lastAttemptAt: now },
          $unset: { lastError: 1 },
          $inc: { attempts: 1 },
        }
      );
      if (claimResult.modifiedCount === 1) {
        return { shouldProcess: true };
      }
    }

    return { shouldProcess: false };
  } catch (error: any) {
    if (error?.code === 11000) {
      return { shouldProcess: false };
    }
    throw error;
  }
};

const markWebhookEventProcessed = async (eventId: string) => {
  await StripeEvent.updateOne(
    { eventId },
    {
      $set: {
        status: 'processed',
        processedAt: new Date(),
        lastAttemptAt: new Date(),
        lastError: undefined,
      },
    }
  );
};

const markWebhookEventFailed = async (eventId: string, error: unknown) => {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  await StripeEvent.updateOne(
    { eventId },
    {
      $set: {
        status: 'failed',
        lastError: message,
        lastAttemptAt: new Date(),
      },
    }
  );
};

/**
 * Main webhook endpoint handler
 * POST /api/stripe/webhooks
 */
export const handleWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).send('No signature');
  }

  let event: Stripe.Event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_CONFIG.webhookSecret
    );
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: Invalid signature');
  }

  let reservation: { shouldProcess: boolean };
  try {
    reservation = await reserveWebhookEvent(event);
  } catch (reservationError: any) {
    console.error(`Failed to persist Stripe event ${event.id} before processing:`, safeErrorSummary(reservationError));
    return res.status(500).json({ received: false, error: 'Failed to reserve webhook event' });
  }

  if (!reservation.shouldProcess) {
    console.log(`Webhook duplicate skipped: ${event.id}`);
    return res.json({ received: true, duplicate: true });
  }

  console.log(`Webhook received: ${event.type} (${event.id})`);

  // Handle the event
  try {
    // Stripe's current Node typings do not include the Connect transfer.failed
    // event, but Stripe can still deliver it for older Connect integrations.
    // Switch on the runtime event name so it is handled rather than silently
    // acknowledged as an unknown event.
    switch (event.type as string) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent, event.id);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent,
          event.id,
        );
        break;

      case 'payment_intent.canceled':
        await handlePaymentIntentCanceled(event.data.object as Stripe.PaymentIntent);
        break;

      case 'charge.captured':
        await handleChargeCaptured(event.data.object as Stripe.Charge);
        break;

      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case 'charge.dispute.created':
        await handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      case 'charge.dispute.closed':
        await handleDisputeClosed(event.data.object as Stripe.Dispute);
        break;

      case 'transfer.created':
        await handleTransferCreated(event.data.object as Stripe.Transfer);
        break;

      case 'transfer.reversed':
        await handleTransferReversed(event.data.object as Stripe.Transfer);
        break;

      case 'transfer.failed':
        await handleTransferReversed(event.data.object as Stripe.Transfer, 'failed');
        break;

      case 'account.updated':
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;

      case 'account.application.deauthorized':
        await handleAccountDeauthorized(event.account ?? null);
        break;

      case 'payout.paid':
        await handlePayoutPaid(event.data.object as Stripe.Payout);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Mark as processed after successful handling
    await markWebhookEventProcessed(event.id);

    // Return 200 to acknowledge receipt
    res.json({ received: true });

  } catch (error: any) {
    await markWebhookEventFailed(event.id, error);
    console.error(`Error handling webhook ${event.type}:`, safeErrorSummary(error));
    // Return 500 so Stripe retries the webhook. Never echo provider/DB details;
    // Stripe acts on the status, and the raw error stays in logs/StripeEvent.
    res.status(500).json({ received: false, error: 'Webhook processing failed' });
  }
};

/**
 * Durable manual-reconciliation item for a succeeded PaymentIntent that is no
 * longer the booking's current intent (for example the cancel in
 * createPaymentIntent failed because the old intent was already processing).
 * The stale success is never applied to the current payment; this only makes
 * the possible charge operator-queryable. No refund, retry or provider call is
 * made here.
 *
 * Applied-intent check: an intent the booking already recorded as settled is
 * a redelivery of an applied payment, not a new charge, and needs no item.
 * The recorded facts are the per-payment ledger entry for the intent, or a
 * paid milestone that stores this intent id (both success paths persist it).
 * Older paid milestones without a stored intent id are not guessed: they get
 * an item, and the operator confirms the charge against the provider.
 *
 * One item per PaymentIntent, enforced by the database: the item is its own
 * StripeEvent document keyed by `reconciliationItemEventId(intent)` and
 * upserted under the existing unique `eventId` index, so concurrent
 * deliveries with different Stripe event ids cannot create two items (the
 * losing upsert is a no-op or a duplicate-key error, both "already marked").
 * The delivered event's own StripeEvent record keeps its normal dedup, status
 * and TTL. Items written before this keying (on the delivered event's own
 * record) still count as already marked and are never rewritten.
 * Returns true when this call created the item.
 */
export const reconciliationItemEventId = (paymentIntentId: string) =>
  `reconciliation:superseded_payment_intent_succeeded:${paymentIntentId}`;

async function recordSupersededIntentReconciliation(
  eventId: string,
  eventType: string,
  bookingId: mongoose.Types.ObjectId,
  paymentIntent: Stripe.PaymentIntent,
  currentIntentId: string,
): Promise<boolean> {
  const alreadyApplied = await Booking.exists({
    _id: bookingId,
    $or: [
      { 'paymentDiscountLedger.paymentIntentId': paymentIntent.id },
      { milestonePayments: { $elemMatch: { paidStripePaymentIntentId: paymentIntent.id, status: 'paid' } } },
    ],
  });
  if (alreadyApplied) return false;
  const itemEventId = reconciliationItemEventId(paymentIntent.id);
  // Legacy items (written on the delivered event's record) are no longer
  // created, so this read cannot race a new legacy write.
  const legacyItem = await StripeEvent.exists({
    eventId: { $ne: itemEventId },
    'reconciliation.required': true,
    'reconciliation.paymentIntentId': paymentIntent.id,
  });
  if (legacyItem) return false;
  const currency = (paymentIntent.currency || '').toUpperCase() || undefined;
  const amount = typeof paymentIntent.amount === 'number'
    ? convertFromStripeAmount(paymentIntent.amount, paymentIntent.currency || 'eur')
    : undefined;
  const latestCharge = paymentIntent.latest_charge;
  const chargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
  const now = new Date();
  try {
    const result = await StripeEvent.updateOne(
      { eventId: itemEventId },
      {
        $setOnInsert: {
          eventId: itemEventId,
          eventType,
          status: 'processed',
          attempts: 1,
          firstSeenAt: now,
          lastAttemptAt: now,
          processedAt: now,
          reconciliation: {
            required: true,
            reason: 'superseded_payment_intent_succeeded',
            bookingId,
            paymentIntentId: paymentIntent.id,
            currentPaymentIntentId: currentIntentId,
            ...(chargeId ? { chargeId } : {}),
            ...(amount !== undefined ? { amount } : {}),
            ...(currency ? { currency } : {}),
            sourceEventId: eventId,
            detectedAt: now,
            resolvedAt: null,
          },
        },
      },
      // No schema defaults on insert: the item must not get the 90-day
      // `expiresAt` that ordinary event records carry.
      { upsert: true, setDefaultsOnInsert: false },
    );
    return result.upsertedCount === 1;
  } catch (error: any) {
    // A concurrent delivery inserted the same item first.
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Handle payment_intent.succeeded event
 */
async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent, eventId: string) {
  if (paymentIntent.metadata.type === 'extra_cost') {
    await handleExtraCostPaymentSucceeded(paymentIntent);
    return;
  }
  const bookingId = paymentIntent.metadata.bookingId;
  if (!bookingId) return;

  const booking = await Booking.findById(bookingId);
  if (!booking || !booking.payment) return;

  try {
    // A late event for a superseded intent (e.g. milestone 1 delivered after
    // the milestone 2 checkout replaced booking.payment) must not mark the
    // current milestone paid or stamp its charge on the current payment.
    const currentIntentId = booking.payment.stripePaymentIntentId;
    if (currentIntentId && currentIntentId !== paymentIntent.id) {
      // Persist the operator marker before acknowledging: if this write fails
      // the event is marked failed and Stripe retries it.
      const marked = await recordSupersededIntentReconciliation(
        eventId,
        'payment_intent.succeeded',
        booking._id as mongoose.Types.ObjectId,
        paymentIntent,
        currentIntentId,
      );
      console.error(
        `[WEBHOOK] payment_intent.succeeded ${paymentIntent.id} is not booking ${bookingId}'s current intent ${currentIntentId}; not applied`
          + (marked ? `, reconciliation item ${reconciliationItemEventId(paymentIntent.id)} recorded` : ''),
      );
      return;
    }

    const now = new Date();
    const msIdx = (booking.payment as any).milestoneIndex;
    const isMilestone = typeof msIdx === 'number'
      && Array.isArray(booking.milestonePayments)
      && booking.milestonePayments[msIdx]
      && booking.milestonePayments[msIdx].status !== 'paid';

    if (booking.payment.status === 'pending' || isMilestone) {
      const updateFields: Record<string, any> = {};
      const filter: Record<string, any> = { _id: booking._id };

      if (booking.payment.status === 'pending') {
        updateFields['payment.status'] = 'authorized';
        updateFields['payment.authorizedAt'] = now;
        if (booking.status !== 'in_progress' && booking.status !== 'professional_completed' && booking.status !== 'completed') {
          updateFields.status = 'booked';
        }
        filter['payment.status'] = 'pending';
        if (paymentIntent.latest_charge) {
          updateFields['payment.stripeChargeId'] = paymentIntent.latest_charge as string;
        }
      }

      if (isMilestone) {
        updateFields[`milestonePayments.${msIdx}.status`] = 'paid';
        updateFields[`milestonePayments.${msIdx}.paidAt`] = now;
        // The paying intent is the milestone's settlement fact (read by the
        // superseded-intent reconciliation check).
        updateFields[`milestonePayments.${msIdx}.stripePaymentIntentId`] = paymentIntent.id;
        updateFields[`milestonePayments.${msIdx}.paidStripePaymentIntentId`] = paymentIntent.id;
        filter[`milestonePayments.${msIdx}.status`] = { $ne: 'paid' };
      }

      if (Object.keys(updateFields).length === 0) return;

      const statusChangedToBooked = updateFields.status === 'booked';
      const updateOperation: Record<string, any> = { $set: updateFields };
      if (statusChangedToBooked) {
        updateOperation.$push = {
          statusHistory: {
            status: 'booked',
            timestamp: now,
            // Stripe-driven transition: record the system actor so the timeline
            // never shows an unattributed status change.
            updatedBy: SYSTEM_USER_ID,
            note: 'Payment confirmed — booking confirmed',
          },
        };
      }

      const updated = await Booking.findOneAndUpdate(filter, updateOperation, { new: true });
      if (!updated) {
        // Lost the race with confirmPayment (or a duplicate delivery): the booking
        // is already authorized. Ensure post-payment notifications still go out
        // exactly once (deduped via deliveryKey).
        const fresh = await Booking.findById(bookingId).select(
          'payment.status payment.stripePaymentIntentId payment.amount payment.totalWithVat payment.milestoneIndex',
        );
        if (
          fresh?.payment &&
          fresh.payment.stripePaymentIntentId === paymentIntent.id &&
          (fresh.payment.status === 'authorized' || (fresh.payment as any).status === 'completed')
        ) {
          // VAT-inclusive amount actually paid, matching booking details.
          const amountPaid = paymentConfirmationAmount(fresh.payment, paymentIntent);
          await notifyBookingPaymentConfirmed({
            bookingId: String(fresh._id),
            paymentIntentId: paymentIntent.id,
            amount: typeof amountPaid === 'number' ? amountPaid : undefined,
            currency: (paymentIntent.currency || 'EUR').toUpperCase(),
          });
        }
        // The other writer may have stopped before the ledger write; this is
        // idempotent and only matches while booking.payment is this intent.
        await recordPaymentDiscountSnapshot(booking._id, booking.payment, paymentIntent.id, now);
        return;
      }

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        {
          status: 'authorized',
          authorizedAt: now,
          ...(paymentIntent.latest_charge ? { stripeChargeId: paymentIntent.latest_charge as string } : {}),
        }
      );

      const pointsRedeemed = (booking.payment as any)?.discount?.pointsRedeemed;
      if (pointsRedeemed > 0 && booking.customer) {
        try {
          await deductPoints(
            booking.customer,
            pointsRedeemed,
            'redemption',
            `Points redeemed for booking #${(booking as any).bookingNumber || bookingId}`,
            { relatedBooking: booking._id }
          );
        } catch (pointsError: any) {
          console.error(`Failed to deduct ${pointsRedeemed} points for booking ${bookingId}:`, pointsError);
        }
      }

      const codeId = (booking.payment as any)?.discount?.codeId;
      const codeAmount = (booking.payment as any)?.discount?.codeDiscountAmount;
      const codeLabel = (booking.payment as any)?.discount?.codeLabel;
      if (codeId && codeAmount > 0 && booking.customer) {
        const session = await mongoose.startSession();
        try {
          let limitReached: 'global' | 'perUser' | 'not_found' | null = null;
          await session.withTransaction(async () => {
            limitReached = null;
            const codeDoc = await DiscountCode.findById(codeId).session(session);
            if (!codeDoc) {
              limitReached = 'not_found';
              return;
            }
            const perUserLimit = Number(codeDoc.perUserLimit) > 0 ? Number(codeDoc.perUserLimit) : 1;
            const userUsage = await DiscountCodeUsage.countDocuments(
              { code: codeId, user: booking.customer },
              { session }
            );
            if (userUsage >= perUserLimit) {
              limitReached = 'perUser';
              return;
            }
            const incremented = await DiscountCode.findOneAndUpdate(
              {
                _id: codeId,
                $or: [
                  { usageLimit: { $exists: false } },
                  { usageLimit: null },
                  { $expr: { $lt: ['$usageCount', '$usageLimit'] } },
                ],
              },
              { $inc: { usageCount: 1 } },
              { new: true, session }
            );
            if (!incremented) {
              limitReached = 'global';
              return;
            }
            await DiscountCodeUsage.create([{
              code: codeId,
              codeString: codeLabel || '',
              user: booking.customer,
              booking: booking._id,
              amountDiscounted: codeAmount,
              redeemedAt: now,
            }], { session });
          });
          if (limitReached === 'global') {
            console.warn(`Discount code ${codeLabel || codeId} usageLimit already reached; skipping usage record for booking ${bookingId}`);
          } else if (limitReached === 'perUser') {
            console.warn(`Discount code ${codeLabel || codeId} perUserLimit already reached for customer ${booking.customer}; skipping usage record for booking ${bookingId}`);
          } else if (limitReached === 'not_found') {
            console.warn(`Discount code not found for id ${codeId} (label ${codeLabel || 'unknown'}); skipping usage record for booking ${bookingId}`);
          }
        } catch (codeError: any) {
          if (codeError?.code === 11000) {
            // Duplicate usage for this booking — already recorded by a prior webhook delivery; transaction rolled back, no-op
          } else {
            console.error(`Failed to record discount code usage for booking ${bookingId}:`, codeError);
          }
        } finally {
          await session.endSession();
        }
      }

      console.log(`Payment authorized via webhook for booking ${bookingId}`);

      if (booking.payment.status === 'pending') {
        // First payment for this booking — notify both sides exactly once.
        // Idempotent with confirmPayment via per-booking deliveryKey (never on
        // checkout-page forward, only after payment). VAT-inclusive paid amount.
        const amountPaid = paymentConfirmationAmount(booking.payment, paymentIntent);
        const currency = (paymentIntent.currency || 'EUR').toUpperCase();
        await notifyBookingPaymentConfirmed({
          bookingId: String(booking._id),
          paymentIntentId: paymentIntent.id,
          amount: typeof amountPaid === 'number' ? amountPaid : undefined,
          currency,
        });
      }

      // Keep this payment's discount after a later milestone checkout replaces
      // booking.payment. A failure here fails the event so Stripe retries; the
      // retry takes the branch below, which records the entry idempotently.
      await recordPaymentDiscountSnapshot(booking._id, booking.payment, paymentIntent.id, now);
    } else {
      // confirmPayment (sync frontend call) may have already flipped
      // pending->authorized before this webhook ran. Ensure the post-payment
      // notifications still go out exactly once (deduped via deliveryKey).
      const fresh = await Booking.findById(bookingId).select(
        'payment.status payment.stripePaymentIntentId payment.amount payment.totalWithVat payment.milestoneIndex status',
      );
      if (
        fresh?.payment &&
        fresh.payment.stripePaymentIntentId === paymentIntent.id &&
        (fresh.payment.status === 'authorized' || (fresh.payment as any).status === 'completed')
      ) {
        // VAT-inclusive amount actually paid, matching booking details.
        const amountPaid = paymentConfirmationAmount(fresh.payment, paymentIntent);
        const currency = (paymentIntent.currency || 'EUR').toUpperCase();
        await notifyBookingPaymentConfirmed({
          bookingId: String(fresh._id),
          paymentIntentId: paymentIntent.id,
          amount: typeof amountPaid === 'number' ? amountPaid : undefined,
          currency,
        });
      }
      // Duplicate delivery, Stripe retry or confirmPayment won the race: record
      // the discount snapshot if it is still missing (idempotent).
      await recordPaymentDiscountSnapshot(booking._id, booking.payment, paymentIntent.id, now);
    }
  } finally {
    // A previous writer or retry may already have settled this milestone.
    // This attempt survives payment-confirmation/ledger failure; the due
    // notifier owns its existing per-milestone delivery deduplication.
    try {
      const settled = await Booking.findById(bookingId).select('milestonePayments');
      if (settled?.milestonePayments?.some(milestone => milestone.status === 'paid'
        && (milestone.paidStripePaymentIntentId === paymentIntent.id
          || milestone.stripePaymentIntentId === paymentIntent.id))) {
        await notifyMilestonePaymentDue(String(bookingId));
      }
    } catch (error: any) {
      console.error(`Milestone-due notify failed for booking ${bookingId}:`, error?.message || error);
    }
  }

}

/**
 * Reconciles an extra-cost payment and notifies the customer. Stripe lookup
 * and persistence failures propagate so the webhook event can be retried.
 */
async function handleExtraCostPaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata.bookingId;
  if (!bookingId) return;
  const booking = await reconcileExtraCostPayment(bookingId, paymentIntent);
  if (!booking) return;

  if (booking.customer) {
    try {
      const professionalId =
        (booking.professional as any)?._id?.toString?.()
        || (booking.professional as any)?.toString?.()
        || await getProfessionalId(booking);
      await notify({
        userId: String(booking.customer),
        eventKey: 'customer.payment_confirmed',
        entityType: 'booking',
        entityId: String(booking._id),
        ...(professionalId ? { subjectUserId: String(professionalId) } : {}),
        idempotencyKey: `stripe:${paymentIntent.id}:extra_cost_payment_confirmed`,
        context: {
          bookingId: String(booking._id),
          amount: booking.payment?.extraCostAmount || convertFromStripeAmount(paymentIntent.amount, paymentIntent.currency),
          currency: (paymentIntent.currency || 'EUR').toUpperCase(),
        },
      });
    } catch (error: any) {
      console.error(`Failed to notify extra-cost payment for booking ${bookingId}:`, error?.message || error);
    }
  }
}

/**
 * Handle payment_intent.payment_failed event
 */
async function handlePaymentIntentFailed(
  paymentIntent: Stripe.PaymentIntent,
  stripeEventId: string,
) {
  if (paymentIntent.metadata.type === 'extra_cost') {
    await handleExtraCostPaymentFailed(paymentIntent);
    return;
  }
  const bookingId = paymentIntent.metadata.bookingId;
  if (!bookingId) return;

  const currentBooking = await Booking.findById(bookingId).select(
    'payment.stripePaymentIntentId payment.status payment.milestoneIndex status',
  );
  if (
    !currentBooking?.payment ||
    currentBooking.payment.stripePaymentIntentId !== paymentIntent.id
  ) {
    return;
  }

  const isMilestone = typeof currentBooking.payment.milestoneIndex === 'number';
  const failedAt = new Date();
  const booking = await Booking.findOneAndUpdate(
    {
      _id: currentBooking._id,
      'payment.stripePaymentIntentId': paymentIntent.id,
      'payment.status': { $in: ['pending', 'failed'] },
      ...(isMilestone
        ? {}
        : { status: { $in: ['quote_accepted', 'payment_pending'] } }),
    },
    {
      $set: {
        'payment.status': 'failed',
        'payment.failedAt': failedAt,
        ...(!isMilestone ? { status: 'payment_pending' } : {}),
      },
    },
    { new: true },
  );
  if (!booking) return;

  const payment = await Payment.findOneAndUpdate(
    {
      booking: booking._id,
      stripePaymentIntentId: paymentIntent.id,
      status: { $in: ['pending', 'failed'] },
    },
    { status: 'failed', failedAt },
    { new: true },
  );
  if (!payment) {
    // Booking was marked failed above; surface for ops/repair rather than
    // acknowledging an inconsistent Booking-only failure state as success.
    throw new Error(
      `Payment row missing for failed payment intent ${paymentIntent.id} on booking ${bookingId}`,
    );
  }

  const customerId = booking.customer?.toString();
  if (customerId) {
    // Notification is best-effort after payment state is persisted. Do not fail
    // the Stripe webhook on in_progress/failed delivery — that just causes retry noise.
    try {
      const notification = await notify({
        userId: customerId,
        eventKey: 'customer.payment_failed',
        entityType: 'booking',
        entityId: String(booking._id),
        idempotencyKey: `stripe:${stripeEventId}:customer.payment_failed`,
        context: {
          bookingId: String(booking._id),
          projectTitle: booking.rfqData?.serviceType,
        },
      });
      if (
        notification.emailOutcome === 'failed' ||
        notification.emailOutcome === 'in_progress' ||
        (!notification.emailOutcome && !notification.skipped)
      ) {
        console.error(
          `Failed-payment email not confirmed for booking ${bookingId}: ${notification.emailOutcome || 'unknown'}`,
        );
      }
    } catch (notifyError) {
      console.error(`Failed-payment notify error for booking ${bookingId}:`, notifyError);
    }
  }

  console.log(`Payment failed via webhook for booking ${bookingId}`);
}

async function handleExtraCostPaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata.bookingId;
  if (!bookingId) return;
  const now = new Date();
  await Booking.updateOne(
    {
      _id: bookingId,
      'payment.extraCostStripePaymentIntentId': paymentIntent.id,
      'payment.extraCostStatus': { $in: ['pending', 'failed'] },
    },
    {
      $set: {
        'payment.extraCostStatus': 'failed',
        'payment.extraCostPaymentSucceeded': false,
        'payment.extraCostFailedAt': now,
      },
    },
  );
  await Payment.updateOne(
    {
      booking: bookingId,
      extraCostStripePaymentIntentId: paymentIntent.id,
      extraCostStatus: { $in: ['pending', 'failed'] },
    },
    { $set: { extraCostStatus: 'failed', extraCostPaymentSucceeded: false, updatedAt: now } },
  );
}

/**
 * Handle payment_intent.canceled event
 */
async function handlePaymentIntentCanceled(paymentIntent: Stripe.PaymentIntent) {
  if (paymentIntent.metadata.type === 'extra_cost') {
    await handleExtraCostPaymentFailed(paymentIntent);
    return;
  }
  const bookingId = paymentIntent.metadata.bookingId;
  if (!bookingId) return;

  const booking = await Booking.findById(bookingId);
  if (!booking || !booking.payment) return;

  // Superseded-intent events must never release a newer checkout's benefit.
  if (booking.payment.stripePaymentIntentId !== paymentIntent.id) return;
  if (['pending', 'failed'].includes(booking.payment.status)) {
    const updated = await Booking.updateOne({
      _id: bookingId,
      'payment.stripePaymentIntentId': paymentIntent.id,
      'payment.status': { $in: ['pending', 'failed'] },
    }, { $set: { 'payment.status': 'failed', 'payment.canceledAt': new Date() } });
    if (updated.modifiedCount) await releaseReferralReservation(bookingId, booking.payment.discount?.referralReservationToken);
    return;
  }

  if (booking.payment.status === 'authorized') {
    const now = new Date();
    booking.payment.status = 'refunded';
    booking.payment.refundedAt = now;
    booking.payment.canceledAt = now;
    booking.status = 'cancelled';
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push({
      status: 'cancelled',
      timestamp: now,
      updatedBy: SYSTEM_USER_ID,
      note: 'Payment intent canceled — booking cancelled',
    });
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      { status: 'refunded', refundedAt: now, canceledAt: now }
    );

    console.log(`Payment cancelled via webhook for booking ${bookingId}`);
  }
}

/**
 * Handle charge.captured event
 */
async function handleChargeCaptured(charge: Stripe.Charge) {
  const paymentIntentId = charge.payment_intent as string;
  if (!paymentIntentId) return;

  const booking = await Booking.findOne({ 'payment.stripePaymentIntentId': paymentIntentId });
  if (!booking || !booking.payment) return;

  if (booking.payment.status === 'authorized') {
    booking.payment.capturedAt = new Date();
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      { capturedAt: booking.payment.capturedAt }
    );

    console.log(`Charge captured via webhook for booking ${booking._id}`);
  }
}

/**
 * Handle charge.refunded event
 */
async function handleChargeRefunded(charge: Stripe.Charge) {
  const paymentIntentId = charge.payment_intent as string;
  if (!paymentIntentId) return;

  const booking = await Booking.findOne({ 'payment.stripePaymentIntentId': paymentIntentId });
  if (!booking || !booking.payment) return;

  const refundAmount = convertFromStripeAmount(charge.amount_refunded, charge.currency);
  const totalAmount = convertFromStripeAmount(charge.amount, charge.currency);
  // Only the booking-level Payment row is this charge's ledger. A milestone
  // row belongs to a different PaymentIntent and must not absorb the base
  // refund or contribute its refunds to the base total.
  const basePaymentRows = await loadBasePaymentRows(booking as any, paymentIntentId);
  const existingRefunds = basePaymentRows.flatMap((row) =>
    Array.isArray((row as any)?.refunds) ? ((row as any).refunds as any[]) : [],
  );
  const existingRefundById = new Map(
    existingRefunds
      .filter((refund) => refund?.refundId)
      .map((refund) => [String(refund.refundId), refund]),
  );

  // From Stripe API 2022-11-15 a Charge carries `refunds` only when the request
  // expands it, and webhook payloads cannot. Fetch the authoritative list so a
  // refund is never missed because the event arrived without the expansion.
  let providerRefunds = Array.isArray((charge as any).refunds?.data)
    ? (charge as any).refunds.data as any[]
    : [];
  if (providerRefunds.length === 0 && (charge as any)?.id) {
    try {
      const listed = await stripe.refunds.list({ charge: String((charge as any).id), limit: 100 });
      providerRefunds = listed.data as any[];
    } catch (error) {
      console.error(
        'Stripe refund list fetch failed; falling back to recorded refunds:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  const refundIsExtraCost = (providerRefund: any): boolean => {
    const metadataKind =
      providerRefund?.metadata?.refundKind
      || providerRefund?.metadata?.kind
      || providerRefund?.metadata?.type;
    if (metadataKind === 'extra_cost') return true;
    if (metadataKind === 'booking') return false;
    const recorded = providerRefund?.id ? existingRefundById.get(String(providerRefund.id)) : null;
    return recorded?.kind === 'extra_cost';
  };

  let providerBookingRefundTotal = 0;
  let providerExtraCostRefundTotal = 0;
  let providerRefundTotal = 0;
  const providerRefundAmounts = new Map<string, number>();
  for (const providerRefund of providerRefunds) {
    if (!providerRefund?.id) continue;
    if (!refundCountsAsCash(providerRefund)) continue;
    const amount = convertFromStripeAmount(providerRefund.amount, charge.currency);
    if (!(amount > 0)) continue;
    providerRefundAmounts.set(String(providerRefund.id), amount);
    providerRefundTotal = roundMoney(providerRefundTotal + amount);
    if (refundIsExtraCost(providerRefund)) {
      providerExtraCostRefundTotal = roundMoney(providerExtraCostRefundTotal + amount);
    } else {
      providerBookingRefundTotal = roundMoney(providerBookingRefundTotal + amount);
    }
  }

  // Negative extra-cost refunds are created against the base PaymentIntent but
  // are not booking-price refunds. Keep them out of booking/payment refund
  // totals and status. Recorded Payment rows remain the fallback when Stripe's
  // refund list is truncated or absent.
  const recordedBookingRefundTotal = roundMoney(
    existingRefunds
      .filter((refund) => refundCountsAsCash(refund))
      .filter((refund) => refund?.kind !== 'extra_cost')
      .reduce((sum, refund) => sum + (Number(refund.amount) || 0), 0),
  );
  const recordedExtraCostRefundTotal = roundMoney(
    existingRefunds
      .filter((refund) => refundCountsAsCash(refund))
      .filter((refund) => refund?.kind === 'extra_cost')
      .reduce((sum, refund) => sum + (Number(refund.amount) || 0), 0),
  );
  const completeProviderList = providerRefunds.length > 0
    && Math.abs(providerRefundTotal - refundAmount) <= 0.01;
  const knownExtraCostTotal = Math.max(providerExtraCostRefundTotal, recordedExtraCostRefundTotal);
  const bookingRefundAmount = roundMoney(Math.min(
    refundAmount,
    Math.max(
      recordedBookingRefundTotal,
      completeProviderList ? providerBookingRefundTotal : refundAmount - knownExtraCostTotal,
    ),
  ));

  const hasBookingRefund = bookingRefundAmount > 0;
  const currentBookingRefundAmount = Number(booking.payment.refundAmount) || 0;
  const bookingRefundChanged = Math.abs(bookingRefundAmount - currentBookingRefundAmount) > 0.01;
  if (hasBookingRefund) {
    if (bookingRefundAmount >= totalAmount - 0.01) {
      booking.payment.status = 'refunded';
      booking.status = 'refunded';
    } else {
      booking.payment.status = 'partially_refunded';
      // Keep booking.status unchanged for partial refunds.
    }
    if (bookingRefundChanged || !booking.payment.refundedAt) {
      booking.payment.refundedAt = new Date();
    }
    booking.payment.refundAmount = bookingRefundAmount;
    await booking.save();

    // The authoritative aggregate refund lives in `booking.payment.refundAmount`
    // (historical + current). Payment rows hold the per-refund ledger only; a
    // top-level `refundAmount` is not part of the Payment schema and would be
    // silently stripped by strict Mongoose.
    await Payment.updateMany(
      { booking: booking._id, milestoneIndex: null },
      { $set: { status: booking.payment.status, refundedAt: booking.payment.refundedAt } },
    );
  }

  // Provider-dashboard refunds bypass executeRefund. Record each actual Stripe
  // refund row (amount/id/date only; no invented VAT split) idempotently by
  // provider refund id, creating the base Payment row from the recorded booking
  // payment facts when none exists (otherwise an extra-cost refund on a
  // legacy/no-row booking would be invisible in the ledger).
  const bookingRowSet = hasBookingRefund
    ? {
        status: booking.payment.status,
        ...(booking.payment.refundedAt ? { refundedAt: booking.payment.refundedAt } : {}),
      }
    : undefined;
  for (const providerRefund of providerRefunds) {
    if (!providerRefund?.id) continue;
    if (!refundCountsAsCash(providerRefund)) continue;
    // A provider refund without its own creation timestamp cannot be placed
    // truthfully on the timeline. Skip the row rather than stamping read time.
    if (typeof providerRefund.created !== 'number') continue;
    const amount = providerRefundAmounts.get(String(providerRefund.id));
    if (!(amount && amount > 0)) continue;
    const kind = refundIsExtraCost(providerRefund) ? 'extra_cost' : 'booking';
    const obligationId = kind === 'extra_cost'
      ? (typeof providerRefund?.metadata?.obligationId === 'string'
        ? providerRefund.metadata.obligationId
        : undefined)
      : undefined;
    const written = await recordBasePaymentRefund({
      booking,
      ...(bookingRowSet ? { set: bookingRowSet } : {}),
      refund: {
        amount,
        ...(typeof providerRefund.reason === 'string' && providerRefund.reason
          ? { reason: providerRefund.reason }
          : {}),
        refundId: providerRefund.id,
        refundedAt: new Date(providerRefund.created * 1000),
        source: booking.payment.refundSource || 'platform',
        notes: kind === 'extra_cost'
          ? `Provider extra-cost refund ${providerRefund.id}`
          : `Provider refund ${providerRefund.id}`,
        kind,
        ...(obligationId ? { obligationId } : {}),
        status: providerRefund.status || 'succeeded',
      },
    });
    if (written) existingRefundById.set(String(providerRefund.id), { refundId: providerRefund.id, kind });
  }

  console.log(`Charge refunded via webhook for booking ${booking._id}`);

  const shouldNotifyBookingRefund = hasBookingRefund
    && (providerBookingRefundTotal > 0 || bookingRefundChanged);

  try {
    if (shouldNotifyBookingRefund && booking.customer) {
      const customerUser = await User.findById(booking.customer).select('_id').lean();
      const isPartial = booking.payment.status === 'partially_refunded';
      if (customerUser?._id) {
        await notify({
          userId: customerUser._id.toString(),
          eventKey: 'customer.refund_processed',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            refundAmount: bookingRefundAmount,
            currency: (charge.currency || 'EUR').toUpperCase(),
            isPartialRefund: isPartial,
          },
        });
      }
    }
  } catch (emailError: any) {
    console.error('Failed to notify refund-processed:', emailError?.message || emailError);
  }

  if (shouldNotifyBookingRefund && (booking.payment.status === 'refunded' || booking.payment.status === 'partially_refunded')) {
    // Project bookings may carry the professional only on the project.
    const refundProfessionalId = await getProfessionalId(booking);
    try {
      if (booking.customer) {
        await notify({
          userId: String(booking.customer),
          eventKey: 'customer.booking_cancelled_refunded',
          entityType: 'booking',
          entityId: String(booking._id),
          ...(refundProfessionalId
            ? { subjectUserId: String(refundProfessionalId) }
            : {}),
          context: { bookingId: String(booking._id) },
          meta: { partial: booking.payment.status === 'partially_refunded' },
        });
      }
      if (refundProfessionalId) {
        await notify({
          userId: String(refundProfessionalId),
          eventKey: 'professional.booking_cancelled_refunded',
          entityType: 'booking',
          entityId: String(booking._id),
          ...(booking.customer
            ? { subjectUserId: String(booking.customer) }
            : {}),
          context: { bookingId: String(booking._id) },
          meta: { partial: booking.payment.status === 'partially_refunded' },
        });
      }
    } catch (notifyError: any) {
      console.error('Failed to notify refund:', notifyError?.message || notifyError);
    }
  }
}

/**
 * Handle charge.dispute.created event
 * A customer has opened a dispute/chargeback
 */
async function handleDisputeCreated(dispute: Stripe.Dispute) {
  const charge = dispute.charge as string;
  if (!charge) return;

  const booking = await Booking.findOne({ 'payment.stripeChargeId': charge });
  if (!booking || !booking.payment) {
    console.error(`Dispute created for unknown charge: ${charge}, dispute: ${dispute.id}`);
    return;
  }

  const disputeAmount = convertFromStripeAmount(dispute.amount, dispute.currency);

  // Record dispute metadata while preserving financial state until dispute resolution.
  booking.payment.status = 'disputed';
  booking.payment.disputeId = dispute.id;
  booking.payment.disputeReason = dispute.reason || 'unknown';
  booking.payment.disputeAmountPending = disputeAmount;
  booking.payment.disputeStatus = dispute.status;
  booking.payment.disputeOpenedAt = new Date();
  booking.payment.refundNotes = `Dispute ${dispute.id} opened. Amount pending: ${disputeAmount} ${String(dispute.currency).toUpperCase()}. Status: ${dispute.status}`;
  await booking.save();

  const existingPayment = await Payment.findOne({ booking: booking._id }).select("_id");
  if (existingPayment) {
    await Payment.findOneAndUpdate(
      { booking: booking._id },
      {
        $set: {
          status: 'disputed',
          metadata: {
            disputeId: dispute.id,
            disputeReason: dispute.reason || 'unknown',
            disputeAmountPending: disputeAmount,
            disputeStatus: dispute.status,
            disputeOpenedAt: booking.payment.disputeOpenedAt,
          },
        },
      }
    );
  } else {
    console.error(
      `[WEBHOOK][DISPUTE] Missing Payment record for booking ${booking._id}; skipped Payment update for dispute ${dispute.id}`
    );
  }

  console.error(
    `DISPUTE CREATED for booking ${booking._id}: ${dispute.id} - Amount pending: ${disputeAmount} ${String(dispute.currency).toUpperCase()} - Reason: ${dispute.reason}`
  );
}

/**
 * Handle charge.dispute.closed event
 * A dispute has been resolved (won or lost)
 */
async function handleDisputeClosed(dispute: Stripe.Dispute) {
  const charge = dispute.charge as string;
  if (!charge) return;

  const booking = await Booking.findOne({ 'payment.stripeChargeId': charge });
  if (!booking || !booking.payment) return;

  if (dispute.status === 'won') {
    // We won the dispute - restore payment status
    booking.payment.status = 'completed';
    booking.payment.refundNotes = `Dispute ${dispute.id} won. Funds restored.`;
    booking.payment.disputeStatus = dispute.status;
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      { status: 'completed' }
    );

    console.log(`Dispute WON for booking ${booking._id}: ${dispute.id}`);
  } else {
    // Dispute lost - funds are gone
    const disputeAmount = convertFromStripeAmount(dispute.amount, dispute.currency);
    booking.payment.status = 'refunded';
    booking.payment.refundedAt = new Date();
    booking.payment.refundAmount = disputeAmount;
    booking.payment.refundReason = `Dispute lost: ${dispute.reason || 'unknown'}`;
    booking.payment.refundSource = 'platform';
    booking.payment.refundNotes = `Dispute ${dispute.id} lost. Status: ${dispute.status}`;
    booking.payment.disputeStatus = dispute.status;
    const previousStatus = booking.status;
    booking.status = 'refunded';
    if (previousStatus !== 'refunded') {
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        status: 'refunded',
        timestamp: new Date(),
        updatedBy: SYSTEM_USER_ID,
        note: `Dispute lost (${dispute.reason || 'unknown'}) — booking refunded`,
      });
    }
    await booking.save();

    const existingPayment = await Payment.findOne({ booking: booking._id }).select("_id");
    if (existingPayment) {
      await Payment.findOneAndUpdate(
        { booking: booking._id },
        {
          $set: {
            status: 'refunded',
            refundedAt: booking.payment.refundedAt,
            metadata: {
              disputeId: dispute.id,
              disputeStatus: dispute.status,
            },
          },
          $push: {
            refunds: {
              amount: disputeAmount,
              reason: `Dispute lost: ${dispute.reason || 'unknown'}`,
              refundId: dispute.id,
              refundedAt: booking.payment.refundedAt || new Date(),
              source: 'platform',
              notes: `Dispute ${dispute.id} closed with status ${dispute.status}`,
              kind: 'booking',
            },
          },
        }
      );
    } else {
      console.error(
        `[WEBHOOK][DISPUTE] Missing Payment record for booking ${booking._id}; skipped refund record update for dispute ${dispute.id}`
      );
    }

    console.error(`DISPUTE LOST for booking ${booking._id}: ${dispute.id} - Status: ${dispute.status}`);
  }
}

/**
 * Handle transfer.created event
 */
async function handleTransferCreated(transfer: Stripe.Transfer) {
  const bookingId = transfer.metadata.bookingId;
  const sourceTransaction = typeof transfer.source_transaction === 'string' ? transfer.source_transaction : undefined;
  const booking = bookingId
    ? await Booking.findById(bookingId)
    : await Booking.findOne({
        $or: [
          { 'payment.stripeTransferId': transfer.id },
          { 'payment.extraCostTransferId': transfer.id },
          ...(sourceTransaction ? [{ 'payment.extraCostStripeChargeId': sourceTransaction }] : []),
        ],
      });
  if (!booking || !booking.payment) return;

  const isExtraCostTransfer = Boolean(
    booking.payment.extraCostTransferId === transfer.id ||
    (booking.payment.extraCostStripeChargeId && sourceTransaction === booking.payment.extraCostStripeChargeId),
  );
  if (isExtraCostTransfer) {
    booking.payment.extraCostTransferId = transfer.id;
    booking.payment.extraCostTransferStatus = 'succeeded';
    booking.payment.extraCostTransferFailureReason = undefined;
    booking.payment.extraCostTransferAttemptedAt = new Date();
    await booking.save();
    await Payment.findOneAndUpdate(
      { booking: booking._id },
      { $set: {
        extraCostTransferId: transfer.id,
        extraCostTransferStatus: 'succeeded',
        extraCostTransferAttemptedAt: new Date(),
      }, $unset: { extraCostTransferFailureReason: 1 } },
    );
    console.log(`Extra-cost transfer created via webhook for booking ${booking._id}: ${transfer.id}`);
    return;
  }

  booking.payment.stripeTransferId = transfer.id;
  booking.payment.transferredAt = new Date();
  booking.payment.transferStatus = 'succeeded';
  booking.payment.transferFailureReason = undefined;
  await booking.save();

  await Payment.findOneAndUpdate(
    { booking: booking._id },
    {
      $set: {
        stripeTransferId: transfer.id,
        transferredAt: new Date(),
        transferStatus: 'succeeded',
      },
      $unset: { transferFailureReason: 1 },
    },
  );

  console.log(`Transfer created via webhook for booking ${booking._id}: ${transfer.id}`);
}

/**
 * Handle transfer.reversed event
 */
async function handleTransferReversed(transfer: Stripe.Transfer, failureKind: 'reversed' | 'failed' = 'reversed') {
  const bookingId = transfer.metadata.bookingId;
  const sourceTransaction = typeof transfer.source_transaction === 'string' ? transfer.source_transaction : undefined;
  const booking = bookingId
    ? await Booking.findById(bookingId)
    : await Booking.findOne({
        $or: [
          { 'payment.stripeTransferId': transfer.id },
          { 'payment.extraCostTransferId': transfer.id },
          ...(sourceTransaction ? [{ 'payment.extraCostStripeChargeId': sourceTransaction }] : []),
        ],
      });
  if (!booking || !booking.payment) return;

  const isExtraCostTransfer = Boolean(
    booking.payment.extraCostTransferId === transfer.id ||
    (booking.payment.extraCostStripeChargeId && sourceTransaction === booking.payment.extraCostStripeChargeId),
  );
  if (isExtraCostTransfer) {
    booking.payment.extraCostTransferStatus = 'failed';
    booking.payment.extraCostTransferFailureReason = `Stripe extra-cost transfer ${transfer.id} ${failureKind}`;
    booking.payment.extraCostTransferAttemptedAt = new Date();
    await booking.save();
    await Payment.findOneAndUpdate(
      { booking: booking._id },
      { $set: {
        extraCostTransferStatus: 'failed',
        extraCostTransferFailureReason: `Stripe extra-cost transfer ${transfer.id} ${failureKind}`,
        extraCostTransferAttemptedAt: new Date(),
      } },
    );
    console.log(`Extra-cost transfer reversed via webhook for booking ${booking._id}: ${transfer.id}`);
    return;
  }

  // Stripe re-delivers webhooks and expired leases can re-run an event, so only
  // apply the failure transition once per transfer. Incrementing transferAttempt
  // again would rotate the retry idempotency key for the same logical payout.
  const failureReason = `Stripe transfer ${transfer.id} ${failureKind}`;
  const alreadyFailedForThisTransfer =
    booking.payment.transferStatus === 'failed' &&
    typeof booking.payment.transferFailureReason === 'string' &&
    booking.payment.transferFailureReason.includes(transfer.id);
  if (alreadyFailedForThisTransfer) {
    console.log(`Transfer ${failureKind} webhook for booking ${booking._id} was already recorded; skipping duplicate state change (${transfer.id})`);
    return;
  }

  const retryAttempt = (booking.payment.transferAttempt || 0) + 1;
  booking.payment.transferStatus = 'failed';
  booking.payment.transferFailureReason = failureReason;
  booking.payment.transferAttemptedAt = new Date();
  booking.payment.transferAttempt = retryAttempt;
  booking.payment.transferIdempotencyKey = undefined;
  await booking.save();
  await Payment.findOneAndUpdate(
    { booking: booking._id },
    {
      $set: {
        transferStatus: 'failed',
        transferFailureReason: failureReason,
        transferAttemptedAt: new Date(),
        transferAttempt: retryAttempt,
      },
      $unset: { transferIdempotencyKey: 1 },
    },
  );

  console.log(`Transfer reversed via webhook for booking ${booking._id}; retry attempt ${retryAttempt}`);
}

/**
 * Handle account.updated event.
 * Processes changes to a connected account and syncs status fields locally.
 */
async function handleAccountUpdated(account: Stripe.Account) {
  const userId = account.metadata?.userId;
  if (!userId) return;

  const user = await User.findById(userId);
  if (!user || !user.stripe) return;

  // Update user's Stripe account status
  user.stripe.onboardingCompleted = account.details_submitted || false;
  user.stripe.chargesEnabled = account.charges_enabled || false;
  user.stripe.payoutsEnabled = account.payouts_enabled || false;
  user.stripe.detailsSubmitted = account.details_submitted || false;
  user.stripe.accountStatus = mapStripeAccountStatus(
    account.charges_enabled,
    account.details_submitted
  );
  await user.save();

  console.log(`Account updated via webhook for user ${userId}`);
}

/**
 * Handle account.application.deauthorized event.
 * event.account contains the disconnected connected account ID.
 */
async function handleAccountDeauthorized(connectedAccountId: string | null) {
  if (!connectedAccountId) return;

  const user = await User.findOne({ 'stripe.accountId': connectedAccountId });
  const userId = user?._id?.toString();

  if (!user || !user.stripe) return;

  user.stripe.chargesEnabled = false;
  user.stripe.payoutsEnabled = false;
  user.stripe.accountStatus = 'restricted';
  await user.save();

  console.error(`Account DEAUTHORIZED for user ${userId}: ${connectedAccountId} - Professional disconnected Stripe`);
}

/**
 * Handle payout.paid event
 */
async function handlePayoutPaid(payout: Stripe.Payout) {
  const payoutAmount = convertFromStripeAmount(payout.amount, payout.currency);
  console.log(`Payout paid: ${payout.id} - Amount: ${payoutAmount} ${String(payout.currency).toUpperCase()}`);
}
