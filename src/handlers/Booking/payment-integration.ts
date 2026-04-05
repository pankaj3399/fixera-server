/**
 * Booking Payment Integration
 * Extends booking handlers with Stripe payment functionality
 */

import { Request, Response } from 'express';
import Booking, { BookingStatus } from '../../models/booking';
import Payment from '../../models/payment';
import Project from '../../models/project';
import { createPaymentIntent, captureAndTransferPayment } from '../Stripe/payment';
import { stripe } from '../../services/stripe';
import { generateIdempotencyKey } from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import { addPoints } from '../../utils/pointsSystem';
import PointsConfig from '../../models/pointsConfig';
import PointTransaction from '../../models/pointTransaction';
import {
  buildProjectScheduleWindow,
  validateProjectScheduleSelection,
} from '../../utils/scheduleEngine';
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from '../../utils/warranty';

const BOOKING_STATUS_VALUES: BookingStatus[] = [
  'rfq',
  'rfq_accepted',
  'draft_quote',
  'quoted',
  'quote_accepted',
  'quote_rejected',
  'payment_pending',
  'booked',
  'in_progress',
  'completed',
  'cancelled',
  'dispute',
  'refunded',
];

const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  rfq: ['rfq_accepted', 'quoted', 'cancelled'],
  rfq_accepted: ['quoted', 'cancelled'],
  draft_quote: ['quoted', 'cancelled'],
  quoted: ['quote_accepted', 'quote_rejected', 'cancelled'],
  quote_accepted: ['payment_pending', 'booked', 'cancelled'],
  quote_rejected: ['quoted'],
  payment_pending: ['booked', 'cancelled'],
  booked: ['in_progress', 'completed', 'cancelled', 'dispute'],
  in_progress: ['completed', 'cancelled', 'dispute'],
  completed: [],
  cancelled: [],
  dispute: ['completed', 'cancelled', 'refunded'],
  refunded: [],
};

const resolveBookingSubprojectIndex = (projectDoc: any, requestedIndex: unknown) => {
  const subprojects = Array.isArray(projectDoc?.subprojects)
    ? projectDoc.subprojects
    : [];

  const parsedRequestedIndex =
    typeof requestedIndex === 'number'
      ? requestedIndex
      : typeof requestedIndex === 'string'
      ? Number.parseInt(requestedIndex, 10)
      : Number.NaN;

  if (
    Number.isInteger(parsedRequestedIndex) &&
    parsedRequestedIndex >= 0 &&
    parsedRequestedIndex < subprojects.length
  ) {
    return parsedRequestedIndex;
  }

  if (subprojects.length === 1) {
    return 0;
  }

  const rfqIndexes = subprojects.reduce((indexes: number[], subproject: any, index: number) => {
    if (subproject?.pricing?.type === 'rfq') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (rfqIndexes.length === 1) {
    return rfqIndexes[0];
  }

  return undefined;
};

const normalizeSelectedExtraOptions = (extraOptions: unknown, projectDoc: any): number[] => {
  if (!Array.isArray(extraOptions) || !Array.isArray(projectDoc?.extraOptions)) {
    return [];
  }

  return Array.from(
    new Set(
      extraOptions
        .map((value: unknown) =>
          typeof value === 'number'
            ? value
            : typeof value === 'string'
            ? Number.parseInt(value, 10)
            : Number.NaN
        )
        .filter(
          (index: number) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < projectDoc.extraOptions.length
        )
    )
  );
};

const isValidBookingStatus = (value: string): value is BookingStatus =>
  BOOKING_STATUS_VALUES.includes(value as BookingStatus);

const isTransitionAllowed = (current: BookingStatus, requested: BookingStatus): boolean =>
  current === requested || ALLOWED_TRANSITIONS[current]?.includes(requested) === true;

const markMilestonesCompleted = (booking: any, completedAt: Date) => {
  if (!Array.isArray(booking.milestonePayments) || booking.milestonePayments.length === 0) {
    return;
  }

  booking.milestonePayments.forEach((milestone: any) => {
    milestone.workStatus = 'completed';
    milestone.startedAt = milestone.startedAt || booking.actualStartDate || completedAt;
    milestone.completedAt = milestone.completedAt || completedAt;
  });
};

const ensureWarrantyCoverageSnapshot = async (booking: any) => {
  let source: 'quote' | 'project_subproject' = 'quote';
  let duration = normalizeWarrantyDuration(booking.warrantyCoverage?.duration)
    || getBookingWarrantyDuration(booking);

  if (!duration && booking.project) {
    const project = await Project.findById(booking.project).select('subprojects');
    const subprojects = Array.isArray((project as any)?.subprojects) ? (project as any).subprojects : [];
    if (
      typeof booking.selectedSubprojectIndex === 'number' &&
      booking.selectedSubprojectIndex >= 0 &&
      booking.selectedSubprojectIndex < subprojects.length
    ) {
      const selectedSubproject = subprojects[booking.selectedSubprojectIndex];
      duration = normalizeWarrantyDuration(selectedSubproject?.warrantyPeriod);
      if (duration) {
        source = 'project_subproject';
      }
    }
  }

  if (!duration) return;

  const startsAt =
    booking.warrantyCoverage?.startsAt instanceof Date
      ? booking.warrantyCoverage.startsAt
      : booking.actualEndDate || new Date();
  const endsAt =
    booking.warrantyCoverage?.endsAt instanceof Date
      ? booking.warrantyCoverage.endsAt
      : addWarrantyDuration(startsAt, duration);

  booking.warrantyCoverage = {
    duration,
    startsAt,
    endsAt,
    source: booking.warrantyCoverage?.source || source,
  };
};

const isDuplicateKeyError = (error: any): boolean => error?.code === 11000;
const COMPLETABLE_BOOKING_STATUSES: BookingStatus[] = ['booked', 'in_progress', 'dispute'];

const getProfessionalId = async (booking: any) => {
  if (booking.professional) return booking.professional;
  if (!booking.project) return undefined;

  const project = await Project.findById(booking.project).select('professionalId');
  return project?.professionalId;
};

const refundCapturedBookingOnConflict = async (
  bookingId: string,
  reason: string
): Promise<{ success: boolean; error?: { code: string; message: string } }> => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found for compensating refund' } };
  }
  if (
    !booking.payment?.stripePaymentIntentId ||
    !['captured', 'completed'].includes(String(booking.payment.status))
  ) {
    return { success: false, error: { code: 'INVALID_STATUS', message: 'Captured booking payment is not refundable in current state' } };
  }

  const totalWithVat = booking.payment.totalWithVat ?? booking.payment.amount ?? 0;
  const refund = await stripe.refunds.create({
    payment_intent: booking.payment.stripePaymentIntentId,
  }, {
    idempotencyKey: generateIdempotencyKey({
      bookingId: booking._id.toString(),
      operation: 'refund',
      version: `conflict-${booking.payment.stripePaymentIntentId}`,
    })
  });

  if (booking.payment.stripeTransferId) {
    try {
      await stripe.transfers.createReversal(
        booking.payment.stripeTransferId,
        { metadata: { reason, bookingId: booking._id.toString() } }
      );
      booking.payment.refundSource = 'professional';
    } catch (error) {
      console.error('Transfer reversal failed during completion conflict refund:', error);
      booking.payment.refundSource = 'platform';
      booking.payment.refundNotes = 'Platform-funded refund after booking completion conflict';
    }
  } else {
    booking.payment.refundSource = 'platform';
  }

  booking.payment.status = 'refunded';
  booking.payment.refundedAt = new Date();
  booking.payment.refundReason = reason;
  booking.status = 'refunded';
  await booking.save();

  await Payment.findOneAndUpdate(
    { booking: booking._id },
    {
      $set: {
        status: 'refunded',
        refundedAt: booking.payment.refundedAt,
      },
      $push: {
        refunds: {
          amount: totalWithVat,
          reason,
          refundId: refund.id,
          refundedAt: booking.payment.refundedAt || new Date(),
          source: booking.payment.refundSource || 'platform',
          notes: booking.payment.refundNotes,
        },
      },
    },
    { upsert: false }
  );

  return { success: true };
};

const awardBookingCompletionPointsToUser = async (
  userId: any,
  amount: number,
  bookingId: any,
  description: string
) => {
  if (!userId || amount <= 0) return;

  const existing = await PointTransaction.findOne({ userId, relatedBooking: bookingId, source: 'booking_completion' });
  if (existing) return;

  try {
    await addPoints(userId, amount, 'booking_completion', description, { relatedBooking: bookingId });
  } catch (error: any) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }
};

const awardBookingCompletionPoints = async (
  professionalId: any,
  customerId: any,
  bookingId: any
) => {
  const pointsConfig = await PointsConfig.getCurrentConfig();
  if (!pointsConfig.isEnabled) return;
  await awardBookingCompletionPointsToUser(
    professionalId,
    pointsConfig.professionalEarningPerBooking,
    bookingId,
    'Earned for completing booking'
  );
  await awardBookingCompletionPointsToUser(
    customerId,
    pointsConfig.customerEarningPerBooking,
    bookingId,
    'Earned for completed booking'
  );
};

/**
 * Enhanced respond to quote handler with payment integration
 * Call this after customer accepts a quote
 */
export const respondToQuoteWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { action, pointsToRedeem } = req.body; // 'accept' or 'reject', optional pointsToRedeem
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Verify customer
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // Verify status
    if (booking.status !== 'quoted') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Quote cannot be accepted in current status' }
      });
    }

    if (action === 'reject') {
      booking.status = 'quote_rejected';
      await booking.save();

      return res.json({
        success: true,
        data: { message: 'Quote rejected', booking }
      });
    }

    if (action === 'accept') {
      booking.status = 'quote_accepted';
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        status: 'quote_accepted',
        timestamp: new Date(),
        updatedBy: booking.customer,
        note: 'Customer accepted the quote',
      });
      await booking.save();

      return res.json({
        success: true,
        data: {
          message: 'Quote accepted. Please complete the booking wizard to proceed to payment.',
          booking,
          requiresBookingWizard: true,
        }
      });
    }

    res.status(400).json({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Action must be accept or reject' }
    });

  } catch (error: any) {
    console.error('Error responding to quote:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process request'
      }
    });
  }
};

/**
 * Enhanced update booking status with payment capture
 * Call this when booking status changes to 'completed'
 */
export const updateBookingStatusWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { status } = req.body;
    const authUser = (req as any).user;
    const userIdStr = authUser?._id?.toString();
    const requestedStatusRaw =
      typeof status === 'string' ? status.trim() : '';

    if (!userIdStr) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (!requestedStatusRaw) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Status is required' }
      });
    }

    if (!isValidBookingStatus(requestedStatusRaw)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Unsupported booking status: ${requestedStatusRaw}` }
      });
    }

    const requestedStatus: BookingStatus = requestedStatusRaw;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Authorization check (professional, customer, or admin)
    const bookingProfessionalId = booking.professional ? booking.professional.toString() : undefined;
    const bookingCustomerId = booking.customer.toString();
    const isAdmin = authUser?.role === 'admin' || authUser?.isAdmin === true;
    const isAuthorized =
      isAdmin ||
      bookingProfessionalId === userIdStr ||
      bookingCustomerId === userIdStr;

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    if (!isTransitionAllowed(booking.status as BookingStatus, requestedStatus)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `Transition from ${booking.status} to ${requestedStatus} is not allowed`
        }
      });
    }

    if (requestedStatus === 'completed') {
      const paymentStatus = booking.payment?.status;
      const paymentStatusValue = paymentStatus ? String(paymentStatus) : '';
      const isAlreadyCaptured =
        paymentStatusValue === 'captured' || paymentStatusValue === 'completed';
      const completionDate = booking.actualEndDate || new Date();

      const finalizeCompletedBooking = async () => {
        const atomicUpdate = await Booking.findOneAndUpdate(
          { _id: booking._id, status: { $in: COMPLETABLE_BOOKING_STATUSES } },
          { $set: { status: 'completed', actualEndDate: completionDate } },
          { new: true }
        );

        if (!atomicUpdate) {
          const currentBooking = await Booking.findById(booking._id).select('status actualEndDate');
          if (currentBooking?.status === 'completed') {
            booking.status = currentBooking.status;
            booking.actualEndDate = currentBooking.actualEndDate || booking.actualEndDate;
            return { alreadyCompleted: true as const };
          }

          return {
            conflictStatus: currentBooking?.status || booking.status,
            alreadyCompleted: false as const
          };
        }

        const refreshed = await Booking.findById(booking._id);
        if (refreshed) {
          booking.status = refreshed.status;
          booking.actualEndDate = refreshed.actualEndDate;
          booking.milestonePayments = refreshed.milestonePayments;
          booking.__v = refreshed.__v;
        }
        return { alreadyCompleted: false as const };
      };

      if (isAlreadyCaptured) {
        const finalizeResult = await finalizeCompletedBooking();
        if (finalizeResult.conflictStatus) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'BOOKING_STATUS_CONFLICT',
              message: `Cannot mark booking completed while booking status is "${finalizeResult.conflictStatus}"`
            }
          });
        }

        markMilestonesCompleted(booking, completionDate);
        await ensureWarrantyCoverageSnapshot(booking);
        await booking.save();

        // Process referral completion for the customer
        try {
          const bookingAmount = booking.payment?.amount || 0;
          await processReferralCompletion(booking.customer, booking._id, bookingAmount);
        } catch (e) {
          console.error('Error processing referral completion:', e);
        }

        // Update professional's level after booking completion
        const proId = await getProfessionalId(booking);
        try {
          if (proId) await updateProfessionalLevel(proId);
        } catch (e) {
          console.error('Error updating professional level:', e);
        }

        try {
          await awardBookingCompletionPoints(proId, booking.customer, booking._id);
        } catch (e) {
          console.error('Error awarding booking completion points:', e);
        }

        return res.json({
          success: true,
          data: {
            message: finalizeResult.alreadyCompleted ? 'Booking is already completed' : 'Booking completed',
            booking
          }
        });
      }

      if (paymentStatus === 'authorized') {
        const captureResult = await captureAndTransferPayment(booking._id.toString());

        if (!captureResult.success) {
          return res.status(400).json({
            success: false,
            error: captureResult.error
          });
        }

        const finalizeResult = await finalizeCompletedBooking();
        if (finalizeResult.conflictStatus) {
          const refundReason = `Booking completion conflict after capture: status=${finalizeResult.conflictStatus}`;
          const refundResult = await refundCapturedBookingOnConflict(booking._id.toString(), refundReason);
          if (!refundResult.success) {
            return res.status(500).json({
              success: false,
              error: {
                code: 'BOOKING_STATUS_CONFLICT_REFUND_FAILED',
                message: `Payment was captured but booking could not be completed because status is "${finalizeResult.conflictStatus}". Compensating refund failed: ${refundResult.error?.message || 'unknown error'}`
              }
            });
          }

          return res.status(409).json({
            success: false,
            error: {
              code: 'BOOKING_STATUS_CONFLICT',
              message: `Booking status changed to "${finalizeResult.conflictStatus}" before completion could be finalized. Payment was refunded.`
            }
          });
        }

        markMilestonesCompleted(booking, completionDate);
        await ensureWarrantyCoverageSnapshot(booking);
        await booking.save();

        // Process referral completion for the customer
        try {
          const bookingAmount = booking.payment?.amount || 0;
          await processReferralCompletion(booking.customer, booking._id, bookingAmount);
        } catch (e) {
          console.error('Error processing referral completion:', e);
        }

        // Update professional's level after booking completion
        const proId2 = await getProfessionalId(booking);
        try {
          if (proId2) await updateProfessionalLevel(proId2);
        } catch (e) {
          console.error('Error updating professional level:', e);
        }

        try {
          await awardBookingCompletionPoints(proId2, booking.customer, booking._id);
        } catch (e) {
          console.error('Error awarding booking completion points:', e);
        }

        return res.json({
          success: true,
          data: {
            message: finalizeResult.alreadyCompleted
              ? 'Booking is already completed'
              : 'Booking completed and payment transferred to professional',
            booking
          }
        });
      }

      return res.status(400).json({
        success: false,
        error: {
          code: 'PAYMENT_NOT_CAPTURABLE',
          message: `Cannot mark booking completed while payment status is "${paymentStatus || 'missing'}"`
        }
      });
    }

    // For other status updates, update normally after validation.
    booking.status = requestedStatus;

    // Set timestamps based on status
    if (requestedStatus === 'in_progress' && !booking.actualStartDate) {
      booking.actualStartDate = new Date();
    }

    await booking.save();

    res.json({
      success: true,
      data: { message: 'Booking status updated', booking }
    });

  } catch (error: any) {
    console.error('Error updating booking status:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process request'
      }
    });
  }
};

/**
 * Ensure a payment intent exists for a booking (customer-triggered)
 */
export const ensurePaymentIntent = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to initialize payment for this booking' }
      });
    }

    if (!booking.quote) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_QUOTE', message: 'Quote is required before initiating payment' }
      });
    }

    // If payment is already authorized or completed, redirect to success
    if (booking.payment?.status === 'authorized' || booking.payment?.status === 'completed') {
      return res.json({
        success: true,
        data: {
          message: 'Payment already processed',
          paymentStatus: booking.payment.status,
          booking,
          shouldRedirect: true,
          redirectTo: `/bookings/${bookingId}/payment/success`
        }
      });
    }

    // Only allow payment initialization for quote_accepted, payment_pending, or booked status
    if (!['quote_accepted', 'payment_pending', 'booked'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot initiate payment while booking is ${booking.status}`
        }
      });
    }

    // If client secret exists and payment is not failed or refunded, return existing secret
    if (booking.payment?.stripeClientSecret && !['failed', 'refunded'].includes(booking.payment.status)) {
      return res.json({
        success: true,
        data: {
          clientSecret: booking.payment.stripeClientSecret,
          booking
        }
      });
    }

    const { pointsToRedeem: pts } = req.body || {};
    const paymentResult = await createPaymentIntent(booking._id.toString(), userId, parseInt(pts) || 0);
    if (!paymentResult.success) {
      return res.status(400).json({
        success: false,
        error: paymentResult.error
      });
    }

    const refreshedBooking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    return res.json({
      success: true,
      data: {
        clientSecret: paymentResult.clientSecret,
        booking: refreshedBooking || booking
      }
    });
  } catch (error: any) {
    console.error('Error ensuring payment intent:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to process request'
      }
    });
  }
};

export const setBookingSchedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { scheduledStartDate, scheduledStartTime, additionalNotes, selectedExtraOptions } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!scheduledStartDate) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'Start date is required' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can set the schedule' } });
    }

    if (!['quote_accepted'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Schedule can only be set for accepted quotes' } });
    }

    if (booking.project) {
      const projectId = (booking.project as any)?._id?.toString?.() || String(booking.project);
      const projectDoc = await Project.findById(projectId).select('subprojects extraOptions');
      if (!projectDoc) {
        return res.status(404).json({ success: false, error: { code: 'PROJECT_NOT_FOUND', message: 'Linked project not found' } });
      }

      const resolvedSubprojectIndex = resolveBookingSubprojectIndex(
        projectDoc,
        booking.selectedSubprojectIndex
      );

      const validation = await validateProjectScheduleSelection({
        projectId,
        subprojectIndex: resolvedSubprojectIndex,
        startDate: scheduledStartDate,
        startTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      });

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_DATE',
            message: validation.reason || 'Selected schedule is not available',
          },
        });
      }

      const window = await buildProjectScheduleWindow({
        projectId,
        subprojectIndex: resolvedSubprojectIndex,
        startDate: scheduledStartDate,
        startTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      });

      if (!window) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_DATE', message: 'Unable to schedule the selected window' },
        });
      }

      booking.scheduledStartDate = window.scheduledStartDate;
      booking.scheduledExecutionEndDate = window.scheduledExecutionEndDate;
      booking.scheduledBufferStartDate = window.scheduledBufferStartDate;
      booking.scheduledBufferEndDate = window.scheduledBufferEndDate;
      booking.scheduledBufferUnit = window.scheduledBufferUnit;
      booking.scheduledStartTime = window.scheduledStartTime;
      booking.scheduledEndTime = window.scheduledEndTime;
      if (window.assignedTeamMembers?.length) {
        booking.assignedTeamMembers = window.assignedTeamMembers as any;
      }
      if (typeof resolvedSubprojectIndex === 'number') {
        booking.selectedSubprojectIndex = resolvedSubprojectIndex;
      }
      booking.selectedExtraOptions = normalizeSelectedExtraOptions(selectedExtraOptions, projectDoc);
    } else {
      const startDate = new Date(scheduledStartDate);
      if (isNaN(startDate.getTime()) || startDate < new Date()) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'Start date must be a valid future date' } });
      }
      booking.scheduledStartDate = startDate;
      booking.scheduledStartTime = typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined;
    }

    if (additionalNotes) {
      booking.rfqData = booking.rfqData || {};
      (booking.rfqData as any).additionalNotes = additionalNotes;
    }

    await booking.save();

    return res.json({
      success: true,
      data: { message: 'Schedule set successfully', booking }
    });
  } catch (error: any) {
    console.error('Error setting booking schedule:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to set schedule' } });
  }
};
