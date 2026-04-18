import { Request, Response } from 'express';
import Booking, { BookingStatus, ExtraCostType } from '../../models/booking';
import User from '../../models/user';
import PlatformSettings from '../../models/platformSettings';
import { uploadToS3, generateFileName, deleteFromS3 } from '../../utils/s3Upload';
import { captureAndTransferPayment } from '../Stripe/payment';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import {
  calculatePlatformCommission,
  generateIdempotencyKey,
  convertToStripeAmount,
  buildPaymentMetadata,
} from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import Payment from '../../models/payment';
import {
  awardBookingCompletionPoints,
  countUnpaidMilestones,
  ensureWarrantyCoverageSnapshot,
  getProfessionalId,
  markMilestonesCompleted,
} from '../../utils/bookingHelpers';

const PROFESSIONAL_COMPLETION_PENDING_STATUS: BookingStatus = 'professional_completed';
const COMPLETED_BOOKING_STATUS: BookingStatus = 'completed';

const getPlatformCommissionPercent = async () => {
  try {
    const platformConfig = await PlatformSettings.getCurrentConfig();
    return platformConfig.commissionPercent;
  } catch (configError) {
    console.warn('Failed to fetch platform commission for extra-cost payment, falling back to env var:', configError);
    const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
    return Number.isFinite(parsed) ? parsed : 0;
  }
};

export const professionalCompleteBooking = async (req: Request, res: Response) => {
  let attachmentUrls: string[] = [];
  let completionSaved = false;
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

    const unpaidMilestoneCount = countUnpaidMilestones(booking);
    if (unpaidMilestoneCount > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MILESTONES_UNPAID',
          message: `Cannot confirm completion: ${unpaidMilestoneCount} milestone payment(s) are still unpaid.`
        }
      });
    }

    const { notes, extraCosts: extraCostsRaw } = req.body;
    let extraCostsInput = extraCostsRaw;
    if (typeof extraCostsRaw === 'string') {
      const rawValue = extraCostsRaw.trim();
      if (!rawValue) {
        extraCostsInput = undefined;
      } else {
        try {
          extraCostsInput = JSON.parse(rawValue);
        } catch (error: any) {
          console.error('Invalid extra costs JSON during professional completion:', {
            bookingId,
            userId,
            extraCostsRaw,
            error: error?.message || error,
          });
          return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Invalid extraCosts payload' }
          });
        }
      }
    }
    const files = (req as any).files as Express.Multer.File[] | undefined;

    let validatedExtraCosts: any[] = [];
    let extraCostTotal = 0;

    if (Array.isArray(extraCostsInput) && extraCostsInput.length > 0) {
      const project = booking.project as any;
      const commissionPercent = await getPlatformCommissionPercent();
      const applyCommission = (net: number) => net * (1 + (commissionPercent || 0) / 100);

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
          if (!condition) {
            return res.status(400).json({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid condition at index ${cost.referenceIndex}` }
            });
          }
          const conditionNet = Number(condition.additionalCost) || 0;
          const conditionGross = applyCommission(conditionNet);
          validatedExtraCosts.push({
            type: 'condition',
            name: condition.name,
            justification: cost.justification,
            amount: conditionGross,
            referenceIndex: cost.referenceIndex,
          });
          extraCostTotal += conditionGross;
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
          const optionNet = Number(option.price) || 0;
          const optionGross = applyCommission(optionNet);
          validatedExtraCosts.push({
            type: 'option',
            name: option.name,
            justification: cost.justification,
            amount: optionGross,
            referenceIndex: cost.referenceIndex,
          });
          extraCostTotal += optionGross;
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

    if (files && files.length > 0) {
      try {
        for (const file of files) {
          const fileName = generateFileName(file.originalname, userId, 'completion-attachments');
          const result = await uploadToS3(file, fileName);
          attachmentUrls.push(result.key);
        }
      } catch (error) {
        await Promise.allSettled(attachmentUrls.map((key) => deleteFromS3(key)));
        attachmentUrls = [];
        throw error;
      }
    }

    const completionConfirmedAt = new Date();
    const statusHistoryNote = validatedExtraCosts.length > 0
      ? `Professional confirmed completion with ${validatedExtraCosts.length} extra cost(s) totaling ${extraCostTotal}`
      : 'Professional confirmed completion';

    const updateDoc: any = {
      $set: {
        status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
        completionAttestation: {
          confirmedAt: completionConfirmedAt,
          confirmedBy: authUser._id,
          attachments: attachmentUrls,
          notes: notes || undefined,
        },
      },
      $push: {
        statusHistory: {
          status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
          timestamp: completionConfirmedAt,
          updatedBy: authUser._id,
          note: statusHistoryNote,
        }
      }
    };

    if (validatedExtraCosts.length > 0) {
      updateDoc.$set.extraCosts = validatedExtraCosts;
      updateDoc.$set.extraCostStatus = 'pending';
      updateDoc.$set.extraCostTotal = extraCostTotal;
    }

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: 'in_progress' as BookingStatus },
      updateDoc,
      { new: true }
    ).populate('project');

    if (!updatedBooking) {
      if (attachmentUrls.length > 0) {
        await Promise.allSettled(attachmentUrls.map((key) => deleteFromS3(key)));
        attachmentUrls = [];
      }

      const currentBooking = await Booking.findById(booking._id).select('status');
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot confirm completion while booking is "${currentBooking?.status || booking.status}"`
        }
      });
    }

    completionSaved = true;

    return res.json({
      success: true,
      data: {
        message: 'Completion confirmed. Awaiting customer confirmation.',
        booking: updatedBooking,
        extraCostTotal,
      }
    });
  } catch (error: any) {
    if (!completionSaved && attachmentUrls.length > 0) {
      await Promise.allSettled(attachmentUrls.map((key) => deleteFromS3(key)));
      attachmentUrls = [];
    }
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
    const commissionPercent = await getPlatformCommissionPercent();
    const applicationFeeAmount = convertToStripeAmount(
      calculatePlatformCommission(extraCostTotal, commissionPercent),
      currency
    );

    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(extraCostTotal, currency),
      currency,
      payment_method_types: ['card'],
      transfer_data: {
        destination: professional.stripe.accountId,
      },
      ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
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
        version: `${convertToStripeAmount(extraCostTotal, currency)}:${booking.extraCosts?.length || 0}`,
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

    const unpaidMilestoneCount = countUnpaidMilestones(booking);
    if (unpaidMilestoneCount > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MILESTONES_UNPAID',
          message: `Cannot confirm completion: ${unpaidMilestoneCount} milestone payment(s) are still unpaid.`
        }
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

    const completionDate = new Date();
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
            updatedBy: authUser._id,
            note: extraCostTotal !== 0
              ? `Customer confirmed completion with extra costs of ${extraCostTotal}`
              : 'Customer confirmed completion'
          }
        }
      },
      { new: true }
    );

    if (!completedBooking) {
      const currentBooking = await Booking.findById(booking._id).select('status');
      if (currentBooking?.status === COMPLETED_BOOKING_STATUS) {
        return res.json({
          success: true,
          data: {
            message: 'Booking is already completed',
            booking: currentBooking,
          }
        });
      }

      return res.status(409).json({
        success: false,
        error: {
          code: 'BOOKING_STATUS_CONFLICT',
          message: `Booking status changed to "${currentBooking?.status || booking.status}" before completion could be finalized`
        }
      });
    }

    const transferResult = await captureAndTransferPayment(completedBooking._id.toString());
    const refreshedBooking = await Booking.findById(completedBooking._id);
    const paymentStatus = refreshedBooking?.payment?.status ? String(refreshedBooking.payment.status) : '';

    if (!transferResult.success) {
      if (paymentStatus !== 'completed' && paymentStatus !== 'captured') {
        await Booking.findOneAndUpdate(
          { _id: completedBooking._id, status: COMPLETED_BOOKING_STATUS },
          {
            $set: {
              status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
            },
            $unset: {
              actualEndDate: 1,
            },
            $push: {
              statusHistory: {
                status: PROFESSIONAL_COMPLETION_PENDING_STATUS,
                timestamp: new Date(),
                updatedBy: authUser._id,
                note: `Reverted completion after payment failure: ${transferResult.error?.message || 'unknown payment error'}`
              }
            }
          }
        );

        return res.status(400).json({
          success: false,
          error: transferResult.error
        });
      }
    }

    const finalizedBooking = refreshedBooking || completedBooking;

    markMilestonesCompleted(finalizedBooking, completionDate);
    await ensureWarrantyCoverageSnapshot(finalizedBooking);

    if (extraCostTotal < 0 && finalizedBooking.payment?.stripePaymentIntentId) {
      const refundAmount = Math.abs(extraCostTotal);
      const currency = (finalizedBooking.payment.currency || 'EUR').toLowerCase();
      await stripe.refunds.create({
        payment_intent: finalizedBooking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, currency),
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: finalizedBooking._id.toString(),
          operation: 'unit-underuse-refund',
          version: `${finalizedBooking.payment.stripePaymentIntentId}:${convertToStripeAmount(refundAmount, currency)}`,
        })
      });
    }

    await finalizedBooking.save();

    try {
      const bookingAmount = (finalizedBooking.payment?.amount || 0) + Math.max(0, extraCostTotal);
      await processReferralCompletion(finalizedBooking.customer, finalizedBooking._id, bookingAmount);
    } catch (e) {
      console.error('Error processing referral completion:', e);
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

    return res.json({
      success: true,
      data: {
        message: 'Booking completed successfully',
        booking: finalizedBooking,
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

    const disputedAt = new Date();
    const disputedBooking = await Booking.findOneAndUpdate(
      { _id: booking._id, status: PROFESSIONAL_COMPLETION_PENDING_STATUS },
      {
        $set: {
          status: 'dispute' as BookingStatus,
          ...(booking.extraCosts && booking.extraCosts.length > 0 ? { extraCostStatus: 'disputed' } : {}),
          dispute: {
            raisedBy: authUser._id,
            reason,
            description: description || '',
            raisedAt: disputedAt,
          }
        },
        $push: {
          statusHistory: {
            status: 'dispute' as BookingStatus,
            timestamp: disputedAt,
            updatedBy: authUser._id,
            note: `Customer disputed: ${reason}`
          }
        }
      },
      { new: true }
    );

    if (!disputedBooking) {
      const currentBooking = await Booking.findById(booking._id).select('status');
      return res.status(409).json({
        success: false,
        error: {
          code: 'BOOKING_STATUS_CONFLICT',
          message: `Booking status changed to "${currentBooking?.status || booking.status}" before the dispute could be recorded`
        }
      });
    }

    return res.json({
      success: true,
      data: {
        message: 'Dispute has been raised. An admin will review your case.',
        booking: disputedBooking,
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
