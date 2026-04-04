import { Request, Response } from 'express';
import Booking, { BookingStatus, ExtraCostType } from '../../models/booking';
import Project from '../../models/project';
import User from '../../models/user';
import { uploadToS3, generateFileName } from '../../utils/s3Upload';
import { captureAndTransferPayment } from '../Stripe/payment';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import {
  generateIdempotencyKey,
  convertToStripeAmount,
  buildPaymentMetadata,
} from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import { addPoints } from '../../utils/pointsSystem';
import PointsConfig from '../../models/pointsConfig';
import PointTransaction from '../../models/pointTransaction';
import Payment from '../../models/payment';
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

export const professionalCompleteBooking = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId).populate('project');
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    const professionalId = booking.professional?.toString()
      || (booking.project as any)?.professionalId?.toString();

    if (professionalId !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can confirm completion' }
      });
    }

    if (booking.status !== 'in_progress') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot confirm completion while booking is "${booking.status}"` }
      });
    }

    const { notes, extraCosts: extraCostsRaw } = req.body;
    const extraCostsInput = typeof extraCostsRaw === 'string' ? JSON.parse(extraCostsRaw) : extraCostsRaw;
    const files = (req as any).files as Express.Multer.File[] | undefined;

    let attachmentUrls: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const fileName = generateFileName(file.originalname, userId, 'completion-attachments');
        const result = await uploadToS3(file, fileName);
        attachmentUrls.push(result.key);
      }
    }

    let validatedExtraCosts: any[] = [];
    let extraCostTotal = 0;

    if (Array.isArray(extraCostsInput) && extraCostsInput.length > 0) {
      const project = booking.project as any;

      for (const cost of extraCostsInput) {
        if (!cost.type || !cost.justification) {
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Each extra cost requires a type and justification' }
          });
        }

        const costType = cost.type as ExtraCostType;

        if (costType === 'unit_adjustment') {
          if (cost.actualUnits == null || cost.estimatedUnits == null || cost.unitPrice == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Unit adjustment requires actualUnits, estimatedUnits, and unitPrice' }
            });
          }
          const diff = cost.actualUnits - cost.estimatedUnits;
          const amount = diff * cost.unitPrice;
          validatedExtraCosts.push({
            type: 'unit_adjustment',
            name: cost.name || 'Unit-based adjustment',
            justification: cost.justification,
            amount,
            estimatedUnits: cost.estimatedUnits,
            actualUnits: cost.actualUnits,
            unitPrice: cost.unitPrice,
          });
          extraCostTotal += amount;
        } else if (costType === 'condition') {
          if (cost.referenceIndex == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Condition extra cost requires referenceIndex' }
            });
          }
          const condition = project?.termsConditions?.[cost.referenceIndex];
          if (!condition || !condition.additionalCost) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid condition at index ${cost.referenceIndex} or no additional cost configured` }
            });
          }
          validatedExtraCosts.push({
            type: 'condition',
            name: condition.name,
            justification: cost.justification,
            amount: condition.additionalCost,
            referenceIndex: cost.referenceIndex,
          });
          extraCostTotal += condition.additionalCost;
        } else if (costType === 'option') {
          if (cost.referenceIndex == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Option extra cost requires referenceIndex' }
            });
          }
          const option = project?.extraOptions?.[cost.referenceIndex];
          if (!option) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid option at index ${cost.referenceIndex}` }
            });
          }
          validatedExtraCosts.push({
            type: 'option',
            name: option.name,
            justification: cost.justification,
            amount: option.price,
            referenceIndex: cost.referenceIndex,
          });
          extraCostTotal += option.price;
        } else if (costType === 'other') {
          if (cost.amount == null || cost.name == null) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Other extra cost requires name and amount' }
            });
          }
          validatedExtraCosts.push({
            type: 'other',
            name: cost.name,
            justification: cost.justification,
            amount: cost.amount,
          });
          extraCostTotal += cost.amount;
        } else {
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: `Invalid extra cost type: ${cost.type}` }
          });
        }
      }
    }

    booking.completionAttestation = {
      confirmedAt: new Date(),
      confirmedBy: authUser._id,
      attachments: attachmentUrls,
      notes: notes || undefined,
    };

    if (validatedExtraCosts.length > 0) {
      booking.extraCosts = validatedExtraCosts;
      booking.extraCostStatus = 'pending';
      booking.extraCostTotal = extraCostTotal;
    }

    booking.status = 'professional_completed' as BookingStatus;
    booking.statusHistory.push({
      status: 'professional_completed' as BookingStatus,
      timestamp: new Date(),
      updatedBy: authUser._id,
      note: validatedExtraCosts.length > 0
        ? `Professional confirmed completion with ${validatedExtraCosts.length} extra cost(s) totaling ${extraCostTotal}`
        : 'Professional confirmed completion'
    });

    await booking.save();

    return res.json({
      success: true,
      data: {
        message: 'Completion confirmed. Awaiting customer confirmation.',
        booking,
        extraCostTotal,
      }
    });
  } catch (error: any) {
    console.error('Error in professional completion:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to process completion' }
    });
  }
};

export const createExtraCostPaymentIntent = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer')
      .populate('professional')
      .populate('project', 'professionalId title');
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the customer can pay extra costs' }
      });
    }

    if (booking.status !== 'professional_completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot pay extra costs while booking is "${booking.status}"` }
      });
    }

    const extraCostTotal = booking.extraCostTotal || 0;
    if (extraCostTotal <= 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_EXTRA_COSTS', message: 'No positive extra costs to pay' }
      });
    }

    const existingExtraCostPiId = booking.payment?.extraCostStripePaymentIntentId;
    const existingExtraCostSecret = booking.payment?.extraCostClientSecret;
    if (existingExtraCostPiId && existingExtraCostSecret) {
      return res.json({
        success: true,
        data: {
          clientSecret: existingExtraCostSecret,
          extraCostTotal,
        }
      });
    }

    let professional = booking.professional as any;
    if (!professional && booking.project && (booking.project as any).professionalId) {
      professional = await User.findById((booking.project as any).professionalId);
    }

    if (!professional?.stripe?.accountId) {
      return res.status(400).json({
        success: false,
        error: { code: 'PROFESSIONAL_NO_STRIPE', message: 'Professional Stripe account not available' }
      });
    }

    const currency = (booking.payment?.currency || 'EUR').toLowerCase();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(extraCostTotal, currency),
      currency,
      payment_method_types: ['card'],
      metadata: {
        ...buildPaymentMetadata(
          booking._id.toString(),
          booking.bookingNumber || '',
          (booking.customer as any)._id.toString(),
          professional._id.toString(),
          professional.stripe.accountId,
          STRIPE_CONFIG.environment as 'production' | 'test'
        ),
        type: 'extra_cost',
      },
      description: `Extra costs for Booking #${booking.bookingNumber}`,
    }, {
      idempotencyKey: generateIdempotencyKey({
        bookingId: booking._id.toString(),
        operation: 'extra-cost-payment-intent',
        timestamp: Date.now(),
      })
    });

    booking.set('payment.extraCostStripePaymentIntentId', paymentIntent.id);
    booking.set('payment.extraCostClientSecret', paymentIntent.client_secret);
    booking.set('payment.extraCostAmount', extraCostTotal);
    await booking.save();

    return res.json({
      success: true,
      data: {
        clientSecret: paymentIntent.client_secret,
        extraCostTotal,
      }
    });
  } catch (error: any) {
    console.error('Error creating extra cost payment intent:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to create extra cost payment' }
    });
  }
};

export const customerConfirmCompletion = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

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
        error: { code: 'UNAUTHORIZED', message: 'Only the customer can confirm completion' }
      });
    }

    if (booking.status !== 'professional_completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot confirm completion while booking is "${booking.status}"` }
      });
    }

    const extraCostTotal = booking.extraCostTotal || 0;

    if (extraCostTotal > 0) {
      const extraCostPiId = booking.payment?.extraCostStripePaymentIntentId;
      if (!extraCostPiId) {
        return res.status(400).json({
          success: false,
          error: { code: 'EXTRA_COST_NOT_PAID', message: 'Extra costs must be paid before confirming completion. Call the extra-cost-payment-intent endpoint first.' }
        });
      }
      const pi = await stripe.paymentIntents.retrieve(extraCostPiId);
      if (pi.status !== 'succeeded') {
        return res.status(400).json({
          success: false,
          error: { code: 'EXTRA_COST_NOT_PAID', message: `Extra cost payment has not succeeded yet (status: ${pi.status})` }
        });
      }
    }

    const transferResult = await captureAndTransferPayment(booking._id.toString());
    if (!transferResult.success) {
      const paymentStatus = booking.payment?.status ? String(booking.payment.status) : '';
      if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
        return res.status(400).json({
          success: false,
          error: transferResult.error
        });
      }
    }

    if (extraCostTotal < 0 && booking.payment?.stripePaymentIntentId) {
      const refundAmount = Math.abs(extraCostTotal);
      const currency = (booking.payment.currency || 'EUR').toLowerCase();
      await stripe.refunds.create({
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, currency),
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'unit-underuse-refund',
          version: Date.now().toString(),
        })
      });
    }

    if (booking.extraCosts && booking.extraCosts.length > 0) {
      booking.extraCostStatus = 'confirmed';
    }

    const completionDate = new Date();
    booking.status = 'completed' as BookingStatus;
    booking.actualEndDate = completionDate;
    booking.statusHistory.push({
      status: 'completed' as BookingStatus,
      timestamp: completionDate,
      updatedBy: authUser._id,
      note: extraCostTotal !== 0
        ? `Customer confirmed completion with extra costs of ${extraCostTotal}`
        : 'Customer confirmed completion'
    });

    markMilestonesCompleted(booking, completionDate);
    await ensureWarrantyCoverageSnapshot(booking);
    await booking.save();

    try {
      const bookingAmount = (booking.payment?.amount || 0) + Math.max(0, extraCostTotal);
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
        message: 'Booking completed successfully',
        booking,
      }
    });
  } catch (error: any) {
    console.error('Error in customer confirm completion:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to process completion confirmation' }
    });
  }
};

export const customerDisputeExtraCosts = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const authUser = (req as any).user;
    const userId = authUser?._id?.toString();

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
        error: { code: 'UNAUTHORIZED', message: 'Only the customer can dispute' }
      });
    }

    if (booking.status !== 'professional_completed') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot dispute while booking is "${booking.status}"` }
      });
    }

    const { reason, description } = req.body;
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Dispute reason is required' }
      });
    }

    booking.status = 'dispute' as BookingStatus;
    if (booking.extraCosts && booking.extraCosts.length > 0) {
      booking.extraCostStatus = 'disputed';
    }
    booking.dispute = {
      raisedBy: authUser._id,
      reason,
      description: description || '',
      raisedAt: new Date(),
    };
    booking.statusHistory.push({
      status: 'dispute' as BookingStatus,
      timestamp: new Date(),
      updatedBy: authUser._id,
      note: `Customer disputed: ${reason}`
    });

    await booking.save();

    return res.json({
      success: true,
      data: {
        message: 'Dispute has been raised. An admin will review your case.',
        booking,
      }
    });
  } catch (error: any) {
    console.error('Error in customer dispute:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to process dispute' }
    });
  }
};
