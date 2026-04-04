import { Request, Response } from 'express';
import Booking, { BookingStatus } from '../../models/booking';
import Project from '../../models/project';
import { captureAndTransferPayment } from '../Stripe/payment';
import { stripe } from '../../services/stripe';
import { generateIdempotencyKey, convertToStripeAmount } from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import { addPoints } from '../../utils/pointsSystem';
import PointsConfig from '../../models/pointsConfig';
import PointTransaction from '../../models/pointTransaction';
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from '../../utils/warranty';

const isDuplicateKeyError = (error: any): boolean => error?.code === 11000;

const getProfessionalId = async (booking: any) => {
  if (booking.professional) return booking.professional;
  if (!booking.project) return undefined;
  const project = await Project.findById(booking.project).select('professionalId');
  return project?.professionalId;
};

const markMilestonesCompleted = (booking: any, completedAt: Date) => {
  if (!Array.isArray(booking.milestonePayments) || booking.milestonePayments.length === 0) return;
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
      if (duration) source = 'project_subproject';
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

const awardBookingCompletionPoints = async (
  professionalId: any,
  customerId: any,
  bookingId: any
) => {
  const pointsConfig = await PointsConfig.getCurrentConfig();
  if (!pointsConfig.isEnabled) return;

  const award = async (userId: any, amount: number, desc: string) => {
    if (!userId || amount <= 0) return;
    const existing = await PointTransaction.findOne({ userId, relatedBooking: bookingId, source: 'booking_completion' });
    if (existing) return;
    try {
      await addPoints(userId, amount, 'booking_completion', desc, { relatedBooking: bookingId });
    } catch (error: any) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  };

  await award(professionalId, pointsConfig.professionalEarningPerBooking, 'Earned for completing booking');
  await award(customerId, pointsConfig.customerEarningPerBooking, 'Earned for completed booking');
};

export const getDisputes = async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 20));

    const filter: any = { status: 'dispute' };
    if (status === 'resolved') {
      filter['dispute.resolvedAt'] = { $ne: null };
    } else if (status === 'open') {
      filter['dispute.resolvedAt'] = null;
    }

    const [disputes, total] = await Promise.all([
      Booking.find(filter)
        .populate('customer', 'name email phone')
        .populate('professional', 'name email username')
        .populate('project', 'title category service')
        .sort({ 'dispute.raisedAt': -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        disputes,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        }
      }
    });
  } catch (error: any) {
    console.error('Error fetching disputes:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch disputes' }
    });
  }
};

export const getDisputeDetails = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType')
      .populate('professional', 'name email username businessInfo')
      .populate('project', 'title category service extraOptions termsConditions subprojects');

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    return res.json({
      success: true,
      data: { booking }
    });
  } catch (error: any) {
    console.error('Error fetching dispute details:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch dispute details' }
    });
  }
};

export const resolveDispute = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const adminUser = (req as any).user;
    const { action, adjustedAmount, resolution } = req.body;

    if (!action || !['accept_professional', 'reject_extra_costs', 'adjust'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Action must be accept_professional, reject_extra_costs, or adjust' }
      });
    }

    if (!resolution) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Resolution notes are required' }
      });
    }

    if (action === 'adjust' && (adjustedAmount == null || adjustedAmount < 0)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Adjusted amount is required for adjust action and must be >= 0' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.status !== 'dispute') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Booking is not in dispute status (current: ${booking.status})` }
      });
    }

    let finalExtraCostAmount = 0;

    if (action === 'accept_professional') {
      finalExtraCostAmount = booking.extraCostTotal || 0;
      booking.extraCostStatus = 'confirmed';
    } else if (action === 'reject_extra_costs') {
      finalExtraCostAmount = 0;
      booking.extraCostStatus = 'confirmed';
      booking.extraCostTotal = 0;
    } else if (action === 'adjust') {
      finalExtraCostAmount = adjustedAmount;
      booking.extraCostStatus = 'confirmed';
      booking.extraCostTotal = adjustedAmount;
      if (booking.dispute) {
        booking.dispute.adminAdjustedAmount = adjustedAmount;
      }
    }

    const transferResult = await captureAndTransferPayment(booking._id.toString());
    if (!transferResult.success) {
      const paymentStatus = booking.payment?.status ? String(booking.payment.status) : '';
      if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
        console.error('Transfer failed during dispute resolution:', transferResult.error);
      }
    }

    if (finalExtraCostAmount < 0 && booking.payment?.stripePaymentIntentId) {
      const refundAmount = Math.abs(finalExtraCostAmount);
      const currency = (booking.payment.currency || 'EUR').toLowerCase();
      await stripe.refunds.create({
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, currency),
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'dispute-resolution-refund',
          version: Date.now().toString(),
        })
      });
    }

    if (booking.dispute) {
      booking.dispute.resolvedAt = new Date();
      booking.dispute.resolution = resolution;
      booking.dispute.resolvedBy = adminUser._id;
    }

    const completionDate = new Date();
    booking.status = 'completed' as BookingStatus;
    booking.actualEndDate = completionDate;
    booking.statusHistory.push({
      status: 'completed' as BookingStatus,
      timestamp: completionDate,
      updatedBy: adminUser._id,
      note: `Admin resolved dispute (${action}): ${resolution}`
    });

    markMilestonesCompleted(booking, completionDate);
    await ensureWarrantyCoverageSnapshot(booking);
    await booking.save();

    try {
      const bookingAmount = (booking.payment?.amount || 0) + Math.max(0, finalExtraCostAmount);
      await processReferralCompletion(booking.customer, booking._id, bookingAmount);
    } catch (e) {
      console.error('Error processing referral completion:', e);
    }

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
        message: `Dispute resolved: ${action}`,
        booking,
      }
    });
  } catch (error: any) {
    console.error('Error resolving dispute:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to resolve dispute' }
    });
  }
};

export const getDisputeAnalytics = async (_req: Request, res: Response) => {
  try {
    const [
      totalOpen,
      totalResolved,
      totalDisputes,
    ] = await Promise.all([
      Booking.countDocuments({ status: 'dispute', 'dispute.resolvedAt': null }),
      Booking.countDocuments({ status: 'dispute', 'dispute.resolvedAt': { $ne: null } }),
      Booking.countDocuments({ status: 'dispute' }),
    ]);

    return res.json({
      success: true,
      data: {
        totalOpen,
        totalResolved,
        totalDisputes,
      }
    });
  } catch (error: any) {
    console.error('Error fetching dispute analytics:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to fetch dispute analytics' }
    });
  }
};
