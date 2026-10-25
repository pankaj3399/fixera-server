import { waitUntil } from '@vercel/functions';
import Booking, { BookingStatus } from '../../models/booking';
import Payment from '../../models/payment';
import { SYSTEM_USER_ID } from '../../constants/system';
import { captureAndTransferPayment } from '../../handlers/Stripe/payment';
import {
  buildPendingExtraCostRefund,
  claimPendingExtraCostRefund,
  clearPersistedPendingExtraCostRefund,
  getPendingExtraCostRefund,
  releasePendingExtraCostRefundClaim,
  settlePendingExtraCostRefund,
} from '../completionRefund';
import { getTransferStatus } from '../../utils/paymentSafety';
import { stripe } from '../../services/stripe';
import { processReferralCompletion } from '../referralSystem';
import { updateProfessionalLevel } from '../professionalLevelSystem';
import { updateUserLoyalty } from '../loyaltySystem';
import PlatformSettings from '../../models/platformSettings';
import {
  awardBookingCompletionPoints,
  ensureWarrantyCoverageSnapshot,
  getProfessionalId,
  getUnpaidMilestoneCount,
  markMilestonesCompleted,
} from '../bookingHelpers';
import { ensureBookingInvoiceArtifacts } from '../../services/invoiceArtifacts';
import User from '../../models/user';
import { notifyAsync } from './notify';
import { isEligibleForAutoAccept } from './autoAcceptEligibility';
import { reconcileExtraCostPayment } from '../../services/extraCostPayment';

const PROFESSIONAL_COMPLETION_PENDING_STATUS: BookingStatus = 'professional_completed';
const COMPLETED_BOOKING_STATUS: BookingStatus = 'completed';

async function getPlatformCommissionPercent() {
  try {
    const platformConfig = await PlatformSettings.getCurrentConfig();
    return platformConfig.commissionPercent;
  } catch {
    return 0;
  }
}

/**
 * Commit a booking whose financial completion (payout + required refund) has
 * succeeded, then run the completion side effects once. The pending refund
 * marker is cleared only by the current claim owner, so a stale retry cannot
 * resend completion notifications or re-run loyalty/referral/points work.
 */
async function finishCompletedBooking(
  finalizedBooking: any,
  opts: { completionDate: Date; notifyAutoAccept?: boolean; claimId?: string },
): Promise<FinalizeResult> {
  const marker = getPendingExtraCostRefund(finalizedBooking);
  const claimId = opts.claimId || marker?.claimId;
  try {
    markMilestonesCompleted(finalizedBooking, opts.completionDate);
    await ensureWarrantyCoverageSnapshot(finalizedBooking);
    await finalizedBooking.save();
    if (marker) {
      // Only the attempt that still owns the claim may run the completion side
      // effects. A stale attempt whose lease was replaced clears nothing and
      // returns without repeating loyalty/referral/notification work.
      const cleared = await clearPersistedPendingExtraCostRefund(finalizedBooking._id, claimId);
      if (!cleared) {
        return { ok: false, reason: 'completion_claim_lost', skipped: true };
      }
    }
  } catch (error) {
    // The refund (or the marker) is still persisted if this save failed. Allow
    // an immediate retry instead of waiting for the lease to expire.
    await releasePendingExtraCostRefundClaim(finalizedBooking._id, claimId).catch(() => undefined);
    throw error;
  }

  const extraCostTotal = Number(finalizedBooking.extraCostTotal || 0);

  try {
    const bookingAmount = (finalizedBooking.payment?.amount || 0) + Math.max(0, extraCostTotal);
    await processReferralCompletion(finalizedBooking.customer, finalizedBooking._id, bookingAmount);
  } catch (e) {
    console.error('Error processing referral completion:', e);
  }

  try {
    const bookingAmount = (finalizedBooking.payment?.amount || 0) + Math.max(0, extraCostTotal);
    await updateUserLoyalty(String(finalizedBooking.customer), bookingAmount);
  } catch (e) {
    console.error('Error updating customer loyalty:', e);
  }

  const proId = await getProfessionalId(finalizedBooking);
  try {
    if (proId) await updateProfessionalLevel(proId);
  } catch (e) {
    console.error('Error updating professional level:', e);
  }

  try {
    await awardBookingCompletionPoints(proId, finalizedBooking.customer, finalizedBooking._id);
  } catch (e) {
    console.error('Error awarding booking completion points:', e);
  }

  // The Odoo Peppol send takes well over the time Vercel keeps running
  // work it was not told about once the response is out; unfinished, it
  // left drafts in Odoo that were never posted or sent.
  waitUntil(ensureBookingInvoiceArtifacts(finalizedBooking._id.toString()).catch((invoiceError: unknown) => {
    console.error(
      'Failed to generate booking invoice artifacts:',
      invoiceError instanceof Error ? invoiceError.message : invoiceError,
    );
  }));

  try {
    const [customerUser, professionalUser] = await Promise.all([
      User.findById(finalizedBooking.customer).select('email name').lean(),
      proId ? User.findById(proId).select('email name businessInfo').lean() : null,
    ]);

    if (opts.notifyAutoAccept) {
      if (customerUser?._id) {
        notifyAsync({
          userId: customerUser._id.toString(),
          eventKey: 'customer.completion_auto_accepted',
          entityType: 'booking',
          entityId: String(finalizedBooking._id),
          context: { bookingId: String(finalizedBooking._id) },
        });
      }
      if (proId) {
        notifyAsync({
          userId: proId,
          eventKey: 'professional.completion_auto_accepted',
          entityType: 'booking',
          entityId: String(finalizedBooking._id),
          context: { bookingId: String(finalizedBooking._id) },
        });
      }
    } else if (proId) {
      notifyAsync({
        userId: proId,
        eventKey: 'professional.completion_confirmed_by_customer',
        entityType: 'booking',
        entityId: String(finalizedBooking._id),
        context: {
          bookingId: String(finalizedBooking._id),
          customerName: customerUser?.name,
        },
      });
    }

    if (customerUser?._id) {
      notifyAsync({
        userId: customerUser._id.toString(),
        eventKey: 'customer.review_request',
        entityType: 'booking',
        entityId: String(finalizedBooking._id),
        context: { bookingId: String(finalizedBooking._id) },
      });
    }
    if (proId) {
      notifyAsync({
        userId: proId,
        eventKey: 'professional.review_request',
        entityType: 'booking',
        entityId: String(finalizedBooking._id),
        context: { bookingId: String(finalizedBooking._id) },
      });
    }
  } catch (emailError: any) {
    console.error('Failed to send completion notifications:', emailError?.message || emailError);
  }

  return { ok: true, bookingId: String(finalizedBooking._id) };
}

export type FinalizeResult =
  | { ok: true; bookingId: string }
  | { ok: false; reason: string; skipped?: boolean };

/**
 * Finalize a booking that is already in `professional_completed`.
 * Used by customer confirm and system auto-accept.
 */
export async function finalizeBookingCompletion(args: {
  bookingId: string;
  actorId?: string;
  note?: string;
  notifyAutoAccept?: boolean;
}): Promise<FinalizeResult> {
  const booking = await Booking.findById(args.bookingId);
  if (!booking) return { ok: false, reason: 'not_found' };

  const existingPendingRefund = getPendingExtraCostRefund(booking);
  if (booking.status === COMPLETED_BOOKING_STATUS) {
    if (!existingPendingRefund) {
      return { ok: false, reason: `invalid_status:${booking.status}`, skipped: true };
    }
    return recoverPendingCompletionRefund(booking, existingPendingRefund);
  }

  if (booking.status !== PROFESSIONAL_COMPLETION_PENDING_STATUS) {
    return { ok: false, reason: `invalid_status:${booking.status}`, skipped: true };
  }

  const unpaidMilestoneCount = getUnpaidMilestoneCount(booking.milestonePayments);
  if (unpaidMilestoneCount > 0) {
    return { ok: false, reason: 'milestones_unpaid', skipped: true };
  }

  const extraCostTotal = booking.extraCostTotal || 0;
  if (extraCostTotal > 0) {
    const extraCostPiId = booking.payment?.extraCostStripePaymentIntentId;
    if (!extraCostPiId) {
      return { ok: false, reason: 'extra_cost_unpaid', skipped: true };
    }
    const pi = await stripe.paymentIntents.retrieve(extraCostPiId);
    if (pi.status !== 'succeeded') {
      return { ok: false, reason: `extra_cost_status:${pi.status}`, skipped: true };
    }
    if (!await reconcileExtraCostPayment(booking._id.toString(), pi)) {
      return { ok: false, reason: 'extra_cost_payment_conflict', skipped: true };
    }
  }

  const actorId = args.actorId || SYSTEM_USER_ID.toString();
  const completionDate = new Date();
  const note =
    args.note ||
    (extraCostTotal !== 0
      ? `Completion finalized with extra costs of ${extraCostTotal}`
      : 'Completion finalized');

  const pendingRefund = buildPendingExtraCostRefund({
    booking,
    commissionPercent: extraCostTotal < 0 ? await getPlatformCommissionPercent() : 0,
    actorId,
    notifyAutoAccept: args.notifyAutoAccept === true,
    requestedAt: completionDate,
  });

  const completedBooking = await Booking.findOneAndUpdate(
    { _id: booking._id, status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
    {
      $set: {
        status: COMPLETED_BOOKING_STATUS,
        actualStartDate: booking.actualStartDate || completionDate,
        actualEndDate: completionDate,
        ...(booking.extraCosts && booking.extraCosts.length > 0 ? { extraCostStatus: 'confirmed' } : {}),
        ...(pendingRefund ? { 'payment.extraCostRefundPending': pendingRefund } : {}),
      },
      $push: {
        statusHistory: {
          status: COMPLETED_BOOKING_STATUS,
          timestamp: completionDate,
          updatedBy: actorId,
          note,
        },
      },
    },
    { new: true },
  );

  if (!completedBooking) {
    return { ok: false, reason: 'status_conflict', skipped: true };
  }

  const transferResult = await captureAndTransferPayment(completedBooking._id.toString());
  const refreshedBooking = await Booking.findById(completedBooking._id);
  const paymentStatus = refreshedBooking?.payment?.status
    ? String(refreshedBooking.payment.status)
    : '';

  if (!transferResult.success) {
    // captureAndTransferPayment persists payout failures on both records:
    // booking.payment.transferStatus first, then the Payment document. A
    // stale or failed Payment upsert must not hide a failed payout, so treat
    // either persisted record reporting failed as a payout failure.
    // milestoneIndex: null selects the booking-level payment; a milestone
    // payment's transfer state must not drive base-booking payout recovery.
    const paymentRecord = await Payment.findOne({
      booking: completedBooking._id,
      milestoneIndex: null,
    })
      .select('transferStatus stripeTransferId metadata')
      .lean();
    const bookingTransferFailed = getTransferStatus({
      transferStatus: refreshedBooking?.payment?.transferStatus,
      stripeTransferId: refreshedBooking?.payment?.stripeTransferId,
    }) === 'failed';
    const paymentTransferFailed = getTransferStatus({
      transferStatus: paymentRecord?.transferStatus,
      stripeTransferId: paymentRecord?.stripeTransferId,
      metadata: paymentRecord?.metadata as { transferFailed?: boolean } | undefined,
    }) === 'failed';
    const transferFailed = paymentTransferFailed || bookingTransferFailed;
    if (transferFailed) {
      await Booking.findOneAndUpdate(
        {
          _id: completedBooking._id,
          status: COMPLETED_BOOKING_STATUS,
          ...(pendingRefund?.claimId
            ? { 'payment.extraCostRefundPending.claimId': pendingRefund.claimId }
            : {}),
        },
        {
          $set: { status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
          $unset: { actualEndDate: 1, 'payment.extraCostRefundPending': 1 },
          $push: {
            statusHistory: {
              status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
              timestamp: new Date(),
              updatedBy: actorId,
              note: 'Completion is awaiting professional payout recovery.',
            },
          },
        },
      );
      return { ok: false, reason: 'payout_recovery_required', skipped: true };
    }
    if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
      await Booking.findOneAndUpdate(
        {
          _id: completedBooking._id,
          status: COMPLETED_BOOKING_STATUS,
          ...(pendingRefund?.claimId
            ? { 'payment.extraCostRefundPending.claimId': pendingRefund.claimId }
            : {}),
        },
        {
          $set: { status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
          $unset: { actualEndDate: 1, 'payment.extraCostRefundPending': 1 },
          $push: {
            statusHistory: {
              status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
              timestamp: new Date(),
              updatedBy: actorId,
              note: 'Reverted completion after payment failure.',
            },
          },
        },
      );
      return { ok: false, reason: transferResult.error?.message || 'payment_failed' };
    }
  }

  const finalizedBooking = refreshedBooking || completedBooking;
  let settledClaimId: string | undefined = pendingRefund?.claimId;
  if (pendingRefund) {
    const settlement = await settlePendingExtraCostRefund(finalizedBooking, {
      alreadyClaimed: true,
      claimId: pendingRefund.claimId,
    });
    if (!settlement.ok) {
      if (settlement.reason === 'refund_failed' || settlement.reason === 'refund_pending') {
        console.error(
          `Extra-cost refund ${settlement.reason === 'refund_pending' ? 'is pending' : 'failed'} for completed booking ${finalizedBooking._id}; retry remains pending:`,
          settlement.error instanceof Error ? settlement.error.message : settlement.error,
        );
        return { ok: false, reason: 'refund_recovery_required' };
      }
      return { ok: false, reason: settlement.reason, skipped: true };
    }
    settledClaimId = settlement.claimId;
  }

  return finishCompletedBooking(finalizedBooking, {
    completionDate: finalizedBooking.actualEndDate || completionDate,
    notifyAutoAccept: args.notifyAutoAccept === true,
    claimId: settledClaimId,
  });
}

/**
 * Retry a completion whose booking-level payout/refund already reached
 * `completed`, but whose mandatory extra-cost refund did not settle. The
 * refund marker and provider idempotency key are reused; the completion status
 * history is not rewritten.
 */
async function recoverPendingCompletionRefund(
  booking: any,
  pendingRefund: ReturnType<typeof getPendingExtraCostRefund>,
): Promise<FinalizeResult> {
  if (!pendingRefund) {
    return { ok: false, reason: 'refund_not_pending', skipped: true };
  }
  const actorId = pendingRefund.actorId
    ? String(pendingRefund.actorId)
    : SYSTEM_USER_ID.toString();

  // Claim before touching the payout. A recent lease means another completion
  // attempt still owns this booking's finalize/refund sequence, so this caller
  // must not race it with a second transfer attempt.
  const claimed = await claimPendingExtraCostRefund(booking._id);
  if (!claimed) {
    return { ok: false, reason: 'refund_in_progress', skipped: true };
  }

  let currentBooking = claimed;
  const claimedPendingRefund = getPendingExtraCostRefund(claimed) || pendingRefund;
  const claimId = claimedPendingRefund.claimId;

  const transferStatus = getTransferStatus({
    transferStatus: currentBooking.payment?.transferStatus,
    stripeTransferId: currentBooking.payment?.stripeTransferId,
  });
  if (transferStatus !== 'succeeded' || !currentBooking.payment?.stripeTransferId) {
    const transferResult = await captureAndTransferPayment(currentBooking._id.toString());
    const refreshedBooking = await Booking.findById(currentBooking._id);
    const paymentStatus = refreshedBooking?.payment?.status
      ? String(refreshedBooking.payment.status)
      : '';
    currentBooking = refreshedBooking || currentBooking;

    if (!transferResult.success) {
      const failedTransferStatus = getTransferStatus({
        transferStatus: currentBooking.payment?.transferStatus,
        stripeTransferId: currentBooking.payment?.stripeTransferId,
      });
      if (failedTransferStatus === 'failed') {
        await Booking.findOneAndUpdate(
          {
            _id: currentBooking._id,
            status: COMPLETED_BOOKING_STATUS,
            ...(claimId ? { 'payment.extraCostRefundPending.claimId': claimId } : {}),
          },
          {
            $set: { status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
            $unset: { actualEndDate: 1, 'payment.extraCostRefundPending': 1 },
            $push: {
              statusHistory: {
                status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
                timestamp: new Date(),
                updatedBy: actorId,
                note: 'Completion is awaiting professional payout recovery.',
              },
            },
          },
        );
        return { ok: false, reason: 'payout_recovery_required', skipped: true };
      }
      if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
        await Booking.findOneAndUpdate(
          {
            _id: currentBooking._id,
            status: COMPLETED_BOOKING_STATUS,
            ...(claimId ? { 'payment.extraCostRefundPending.claimId': claimId } : {}),
          },
          {
            $set: { status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
            $unset: { actualEndDate: 1, 'payment.extraCostRefundPending': 1 },
            $push: {
              statusHistory: {
                status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
                timestamp: new Date(),
                updatedBy: actorId,
                note: 'Reverted completion after payment failure.',
              },
            },
          },
        );
        return { ok: false, reason: transferResult.error?.message || 'payment_failed' };
      }
    }
  }

  const settlement = await settlePendingExtraCostRefund(currentBooking, {
    alreadyClaimed: true,
    claimId,
  });
  if (!settlement.ok) {
    if (settlement.reason === 'refund_failed' || settlement.reason === 'refund_pending') {
      console.error(
        `Completion refund ${settlement.reason === 'refund_pending' ? 'is pending' : 'retry failed'} for booking ${currentBooking._id}; retry remains pending:`,
        settlement.error instanceof Error ? settlement.error.message : settlement.error,
      );
      return { ok: false, reason: 'refund_recovery_required' };
    }
    return { ok: false, reason: settlement.reason, skipped: true };
  }

  return finishCompletedBooking(settlement.booking, {
    completionDate: settlement.booking.actualEndDate || new Date(),
    notifyAutoAccept: claimedPendingRefund.notifyAutoAccept === true,
    claimId: settlement.claimId,
  });
}

export async function runCompletionAutoAccept(): Promise<{
  autoAccepted: number;
  recovered: number;
  skipped: number;
  errors: string[];
}> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - 10 * DAY_MS);
  const result = { autoAccepted: 0, recovered: 0, skipped: 0, errors: [] as string[] };

  const MAX_TRANSFER_RECOVERY_ATTEMPTS = 3;
  const candidates = await Booking.find({
    $or: [
      {
        status: 'professional_completed',
        professionalCompletedAt: { $lte: cutoff },
      },
      {
        status: 'completed',
        'payment.extraCostRefundPending.amount': { $gt: 0 },
      },
    ],
  })
    .select('_id status extraCostTotal extraCostStatus payment milestonePayments professionalCompletedAt')
    .limit(100);

  console.log(`[Completion Auto-Accept] Found ${candidates.length} candidate(s)`);

  for (const booking of candidates) {
    try {
      if (booking.status === COMPLETED_BOOKING_STATUS) {
        const pendingRefund = getPendingExtraCostRefund(booking);
        if (!pendingRefund) {
          result.skipped++;
          continue;
        }
        const finalize = await finalizeBookingCompletion({
          bookingId: String(booking._id),
          actorId: SYSTEM_USER_ID.toString(),
        });
        if (finalize.ok) {
          result.recovered++;
        } else if (finalize.skipped) {
          if (finalize.reason === 'payout_recovery_required') {
            result.errors.push(`${booking._id}: ${finalize.reason}`);
          } else {
            result.skipped++;
          }
        } else {
          result.errors.push(`${booking._id}: ${finalize.reason}`);
        }
        continue;
      }

      const transferAttempt = Number(booking.payment?.transferAttempt || 0);
      if (transferAttempt >= MAX_TRANSFER_RECOVERY_ATTEMPTS) {
        result.errors.push(`${booking._id}: payout recovery exhausted after ${transferAttempt} attempts`);
        continue;
      }
      const unpaidMilestoneCount = getUnpaidMilestoneCount(booking.milestonePayments);
      const extraCostTotal = Number(booking.extraCostTotal || 0);
      let extraCostPaymentSucceeded = extraCostTotal <= 0;
      if (extraCostTotal > 0) {
        const piId = booking.payment?.extraCostStripePaymentIntentId;
        if (!piId) {
          result.skipped++;
          continue;
        }
        const pi = await stripe.paymentIntents.retrieve(piId);
        extraCostPaymentSucceeded = pi.status === 'succeeded';
        if (!extraCostPaymentSucceeded) {
          result.skipped++;
          continue;
        }
      }

      const eligibility = isEligibleForAutoAccept({
        status: String(booking.status),
        professionalCompletedAt: booking.professionalCompletedAt,
        unpaidMilestoneCount,
        extraCostTotal,
        extraCostPaymentSucceeded,
      });
      if (!eligibility.eligible) {
        result.skipped++;
        continue;
      }

      const finalize = await finalizeBookingCompletion({
        bookingId: String(booking._id),
        actorId: SYSTEM_USER_ID.toString(),
        note: 'System auto-accepted completion after 10 days without customer response',
        notifyAutoAccept: true,
      });

      if (finalize.ok) {
        result.autoAccepted++;
      } else if (finalize.skipped) {
        if (finalize.reason === 'payout_recovery_required') {
          result.errors.push(`${booking._id}: ${finalize.reason}`);
        } else {
          result.skipped++;
        }
      } else {
        result.errors.push(`${booking._id}: ${finalize.reason}`);
      }
    } catch (e: any) {
      result.errors.push(`${booking._id}: ${e?.message || e}`);
    }
  }

  console.log('[Completion Auto-Accept] Done', result);
  return result;
}
