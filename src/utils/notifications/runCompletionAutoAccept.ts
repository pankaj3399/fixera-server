import Booking, { BookingStatus } from '../../models/booking';
import { SYSTEM_USER_ID } from '../../constants/system';
import { captureAndTransferPayment } from '../../handlers/Stripe/payment';
import { stripe } from '../../services/stripe';
import {
  generateIdempotencyKey,
  convertToStripeAmount,
} from '../payment';
import { processReferralCompletion } from '../referralSystem';
import { updateProfessionalLevel } from '../professionalLevelSystem';
import PlatformSettings from '../../models/platformSettings';
import {
  awardBookingCompletionPoints,
  ensureWarrantyCoverageSnapshot,
  getProfessionalId,
  getUnpaidMilestoneCount,
  markMilestonesCompleted,
} from '../bookingHelpers';
import { sendCustomerConfirmedCompletionEmail } from '../emailService';
import { getProfessionalDisplayName } from '../displayName';
import { ensureBookingInvoiceArtifacts } from '../../services/invoiceArtifacts';
import User from '../../models/user';
import { notifyAsync } from './notify';
import { isEligibleForAutoAccept } from './autoAcceptEligibility';

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
  }

  const actorId = args.actorId || SYSTEM_USER_ID.toString();
  const completionDate = new Date();
  const note =
    args.note ||
    (extraCostTotal !== 0
      ? `Completion finalized with extra costs of ${extraCostTotal}`
      : 'Completion finalized');

  const completedBooking = await Booking.findOneAndUpdate(
    { _id: booking._id, status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
    {
      $set: {
        status: COMPLETED_BOOKING_STATUS,
        actualEndDate: completionDate,
        ...(booking.extraCosts && booking.extraCosts.length > 0 ? { extraCostStatus: 'confirmed' } : {}),
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
    if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
      await Booking.findOneAndUpdate(
        { _id: completedBooking._id, status: COMPLETED_BOOKING_STATUS },
        {
          $set: { status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
          $unset: { actualEndDate: 1 },
          $push: {
            statusHistory: {
              status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
              timestamp: new Date(),
              updatedBy: actorId,
              note: `Reverted completion after payment failure: ${transferResult.error?.message || 'unknown payment error'}`,
            },
          },
        },
      );
      return { ok: false, reason: transferResult.error?.message || 'payment_failed' };
    }
  }

  const finalizedBooking = refreshedBooking || completedBooking;
  markMilestonesCompleted(finalizedBooking, completionDate);
  await ensureWarrantyCoverageSnapshot(finalizedBooking);

  if (extraCostTotal < 0 && finalizedBooking.payment?.stripePaymentIntentId) {
    const commissionPercent = await getPlatformCommissionPercent();
    const refundAmount =
      Math.round(Math.abs(extraCostTotal) * (1 + commissionPercent / 100) * 100) / 100;
    const currency = (finalizedBooking.payment.currency || 'EUR').toLowerCase();
    await stripe.refunds.create(
      {
        payment_intent: finalizedBooking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, currency),
      },
      {
        idempotencyKey: generateIdempotencyKey({
          bookingId: finalizedBooking._id.toString(),
          operation: 'unit-underuse-refund',
          version: `${finalizedBooking.payment.stripePaymentIntentId}:${convertToStripeAmount(refundAmount, currency)}`,
        }),
      },
    );
  }

  await finalizedBooking.save();

  try {
    const bookingAmount = (finalizedBooking.payment?.amount || 0) + Math.max(0, extraCostTotal);
    await processReferralCompletion(finalizedBooking.customer, finalizedBooking._id, bookingAmount);
  } catch (e) {
    console.error('Error processing referral completion:', e);
  }

  try {
    const { updateUserLoyalty } = await import('../loyaltySystem');
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

  void ensureBookingInvoiceArtifacts(finalizedBooking._id.toString()).catch((invoiceError: unknown) => {
    console.error(
      'Failed to generate booking invoice artifacts:',
      invoiceError instanceof Error ? invoiceError.message : invoiceError,
    );
  });

  try {
    const [customerUser, professionalUser] = await Promise.all([
      User.findById(finalizedBooking.customer).select('email name').lean(),
      proId ? User.findById(proId).select('email name businessInfo').lean() : null,
    ]);

    if (args.notifyAutoAccept) {
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
    } else if (professionalUser?.email) {
      await sendCustomerConfirmedCompletionEmail(
        professionalUser.email,
        getProfessionalDisplayName(professionalUser),
        customerUser?.name || 'Customer',
        String(finalizedBooking._id),
      );
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

export async function runCompletionAutoAccept(): Promise<{
  autoAccepted: number;
  skipped: number;
  errors: string[];
}> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - 10 * DAY_MS);
  const result = { autoAccepted: 0, skipped: 0, errors: [] as string[] };

  const candidates = await Booking.find({
    status: 'professional_completed',
    professionalCompletedAt: { $lte: cutoff },
  })
    .select('_id extraCostTotal extraCostStatus payment milestonePayments professionalCompletedAt')
    .limit(100);

  console.log(`[Completion Auto-Accept] Found ${candidates.length} candidate(s)`);

  for (const booking of candidates) {
    try {
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
        result.skipped++;
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
