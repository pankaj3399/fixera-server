/**
 * Stripe Payment Handlers
 * Handles payment intent creation, capture, transfer, and refunds
 */

import { Request, Response } from 'express';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import Booking from '../../models/booking';
import User from '../../models/user';
import Payment from '../../models/payment';
import {
  generateIdempotencyKey,
  convertToStripeAmount,
  calculateProfessionalPayout,
  buildPaymentMetadata,
  buildTransferMetadata,
  determineBookingCurrency,
} from '../../utils/payment';
import { calculateVAT } from '../../utils/vat';

const extractParticipantIds = (booking: any, professionalOverride?: any) => {
  const customerId = (booking.customer as any)?._id || booking.customer;
  const professionalSource = professionalOverride || booking.professional;
  const professionalId = (professionalSource as any)?._id || professionalSource || undefined;
  return { customerId, professionalId };
};

const buildPaymentUpsertBase = (booking: any, overrides: Record<string, any> = {}, professionalOverride?: any) => {
  const { customerId, professionalId } = extractParticipantIds(booking, professionalOverride);
  const paymentSummary = booking.payment || {};
  const quoteSummary = booking.quote || {};

  const currency = paymentSummary.currency || quoteSummary.currency || 'EUR';
  const amount = paymentSummary.amount || quoteSummary.amount || 0;

  return {
    booking: booking._id,
    bookingNumber: booking.bookingNumber,
    customer: customerId,
    professional: professionalId,
    method: paymentSummary.method || 'card',
    currency,
    amount,
    netAmount: paymentSummary.netAmount || amount,
    vatAmount: paymentSummary.vatAmount,
    vatRate: paymentSummary.vatRate,
    totalWithVat: paymentSummary.totalWithVat || amount,
    platformCommission: paymentSummary.platformCommission,
    professionalPayout: paymentSummary.professionalPayout,
    ...overrides,
  };
};

/**
 * Create Payment Intent when customer accepts quote
 * Called from booking respond endpoint
 */
export const createPaymentIntent = async (
  bookingId: string,
  userId: string
): Promise<{ success: boolean; clientSecret?: string; error?: any }> => {
  try {
    const booking = await Booking.findById(bookingId)
      .populate('customer')
      .populate('professional')
      .populate('project', 'professionalId title');

    if (!booking) {
      return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } };
    }

    // Verify customer
    if (booking.customer._id.toString() !== userId) {
      return { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorized' } };
    }

    // Check if payment intent already exists and is valid
    if (booking.payment?.stripePaymentIntentId && booking.payment?.stripeClientSecret) {
      // If payment is already authorized or completed, don't create new intent
      if (['authorized', 'completed'].includes(booking.payment.status)) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ALREADY_PROCESSED',
            message: 'Payment has already been processed for this booking'
          }
        };
      }
      // If payment is pending and has a valid client secret, return existing one
      if (booking.payment.status === 'pending') {
        console.log(`♻️  Reusing existing PaymentIntent for booking ${booking._id}: ${booking.payment.stripePaymentIntentId}`);
        return {
          success: true,
          clientSecret: booking.payment.stripeClientSecret,
        };
      }
    }

    // Verify quote exists and status allows payment initialization
    if (
      !booking.quote ||
      !['quote_accepted', 'payment_pending', 'booked'].includes(booking.status)
    ) {
      return { success: false, error: { code: 'NO_QUOTE', message: 'No quote to pay for' } };
    }

    // Get professional (direct booking or project owner)
    let professional = booking.professional as any;
    if (!professional && booking.project && (booking.project as any).professionalId) {
      professional = await User.findById((booking.project as any).professionalId);
    }

    if (!professional) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_NOT_FOUND',
          message: 'No professional assigned to this booking'
        }
      };
    }
    const customer = booking.customer as any;
    const projectInfo = booking.project as any;

    // Check if professional has Stripe connected
    if (!professional.stripe?.accountId) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_NO_STRIPE',
          message: 'Professional hasn\'t connected their Stripe account yet. Payment cannot proceed.'
        }
      };
    }

    if (!professional.stripe.chargesEnabled) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_STRIPE_NOT_READY',
          message: 'Professional\'s Stripe account is not fully set up yet.'
        }
      };
    }

    // Determine currency
    const currency = determineBookingCurrency(
      booking.quote.currency,
      professional.currency,
      customer.location?.country
    );

    // Calculate VAT
    const vatCalculation = calculateVAT({
      amount: booking.quote.amount,
      customerCountry: customer.location?.country || 'BE',
      customerVATNumber: customer.vatNumber || null,
      professionalCountry: professional.businessInfo?.country || 'BE',
      customerType: customer.customerType || 'individual',
    });

    // Calculate amounts
    const netAmount = booking.quote.amount;
    const vatAmount = vatCalculation.vatAmount;
    const totalAmount = vatCalculation.total;
    const platformCommission = (totalAmount * STRIPE_CONFIG.commissionPercent) / 100;
    const professionalPayout = totalAmount - platformCommission;

    // Create Payment Intent with manual capture (escrow mode)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(totalAmount),
      currency: currency.toLowerCase(),
      capture_method: 'manual', // ESCROW MODE - hold funds until capture
      payment_method_types: ['card'],
      metadata: buildPaymentMetadata(
        booking._id.toString(),
        booking.bookingNumber || '',
        customer._id.toString(),
        professional._id.toString(),
        professional.stripe.accountId,
        STRIPE_CONFIG.environment as 'production' | 'test'
      ),
      description: `Fixera Booking #${booking.bookingNumber} - ${projectInfo?.title || 'Service'}`,
    }, {
      idempotencyKey: generateIdempotencyKey({
        bookingId: booking._id.toString(),
        operation: 'payment-intent',
        timestamp: Date.now(), // Add timestamp to ensure fresh PaymentIntent
      })
    });

    // Update booking with payment info
    booking.payment = {
      amount: netAmount,
      currency: currency,
      method: 'card',
      status: 'pending',
      stripePaymentIntentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret || undefined,
      platformCommission,
      professionalPayout,
      netAmount,
      vatAmount,
      vatRate: vatCalculation.vatRate,
      totalWithVat: totalAmount,
    };
    booking.status = 'payment_pending';
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      buildPaymentUpsertBase(
        booking,
        {
          status: 'pending',
          method: 'card',
          currency,
          amount: netAmount,
          netAmount,
          vatAmount,
          vatRate: vatCalculation.vatRate,
          totalWithVat: totalAmount,
          platformCommission,
          professionalPayout,
          stripePaymentIntentId: paymentIntent.id,
          stripeClientSecret: paymentIntent.client_secret || undefined,
          metadata: {
            environment: STRIPE_CONFIG.environment,
            projectId: projectInfo?._id?.toString?.(),
          },
        },
        professional
      ),
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Payment Intent created for booking ${booking._id}: ${paymentIntent.id}`);

    return {
      success: true,
      clientSecret: paymentIntent.client_secret || undefined,
    };

  } catch (error: any) {
    console.error('Error creating payment intent:', error);
    return {
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to create payment intent'
      }
    };
  }
};

/**
 * Confirm payment after customer completes payment on frontend
 * POST /api/stripe/payment/confirm
 */
export const confirmPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId, paymentIntentId } = req.body;
    const userId = (req as any).user._id;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Verify customer
    if (booking.customer.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // Check if payment is already authorized or completed
    if (booking.payment?.status === 'authorized' || booking.payment?.status === 'completed') {
      console.log(`[PAYMENT CONFIRM] Payment already ${booking.payment.status} for booking ${booking._id}`);
      return res.json({
        success: true,
        data: {
          status: booking.payment.status,
          bookingId: booking._id,
          message: `Payment already ${booking.payment.status}`,
          alreadyProcessed: true
        }
      });
    }

    // Verify the payment intent ID matches the booking
    if (booking.payment?.stripePaymentIntentId && booking.payment.stripePaymentIntentId !== paymentIntentId) {
      console.warn(`[PAYMENT CONFIRM] PaymentIntent mismatch: expected ${booking.payment.stripePaymentIntentId}, got ${paymentIntentId}`);
      return res.status(400).json({
        success: false,
        error: { code: 'PAYMENT_INTENT_MISMATCH', message: 'Payment intent does not match this booking' }
      });
    }

    // Retrieve payment intent from Stripe
    console.log(`[PAYMENT CONFIRM] Retrieving PaymentIntent ${paymentIntentId} from Stripe`);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'requires_capture') {
      // Payment authorized successfully
      console.log(`[PAYMENT CONFIRM] PaymentIntent status is requires_capture, updating booking`);

      booking.payment!.status = 'authorized';
      booking.payment!.authorizedAt = new Date();
      if (paymentIntent.latest_charge) {
        booking.payment!.stripeChargeId = paymentIntent.latest_charge as string;
      }
      booking.status = 'booked';

      await booking.save();

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        buildPaymentUpsertBase(booking, {
          status: 'authorized',
          stripePaymentIntentId: paymentIntent.id,
          stripeChargeId: (paymentIntent.latest_charge as string) || booking.payment!.stripeChargeId,
          authorizedAt: booking.payment!.authorizedAt || new Date(),
        })
      );

      console.log(`✅ Payment authorized for booking ${booking._id}`);

      return res.json({
        success: true,
        data: {
          status: 'authorized',
          bookingId: booking._id,
          message: 'Payment authorized successfully'
        }
      });
    }

    // Handle other statuses
    res.json({
      success: true,
      data: {
        status: paymentIntent.status,
        message: 'Payment confirmation received, awaiting webhook'
      }
    });

  } catch (error: any) {
    console.error('Error confirming payment:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to confirm payment'
      }
    });
  }
};

/**
 * Capture payment and transfer to professional on booking completion
 */
export const captureAndTransferPayment = async (bookingId: string): Promise<{ success: boolean; error?: any }> => {
  try {
    const booking = await Booking.findById(bookingId).populate('professional');
    if (!booking) {
      return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } };
    }

    if (!booking.payment?.stripePaymentIntentId) {
      return { success: false, error: { code: 'NO_PAYMENT', message: 'No payment to capture' } };
    }

    if (booking.payment.status !== 'authorized') {
      return { success: false, error: { code: 'INVALID_STATUS', message: 'Payment not authorized' } };
    }

    const professional = booking.professional as any;

    // Step 1: Capture the payment (money goes to Fixera's Stripe balance)
    const paymentIntent = await stripe.paymentIntents.capture(
      booking.payment.stripePaymentIntentId,
      {},
      {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'capture',
        })
      }
    );

    console.log(`✅ Payment captured for booking ${booking._id}`);

    // Step 2: Transfer to professional (money goes from Fixera → Professional)
    const transfer = await stripe.transfers.create({
      amount: convertToStripeAmount(booking.payment.professionalPayout),
      currency: booking.payment.currency.toLowerCase(),
      destination: professional.stripe.accountId,
      source_transaction: (paymentIntent.latest_charge as string) || undefined,
      metadata: buildTransferMetadata(
        booking._id.toString(),
        booking.bookingNumber || '',
        new Date().toISOString(),
        STRIPE_CONFIG.environment as 'production' | 'test'
      ),
      description: `Payout for Booking #${booking.bookingNumber}`,
    }, {
      idempotencyKey: generateIdempotencyKey({
        bookingId: booking._id.toString(),
        operation: 'transfer',
      })
    });

    console.log(`✅ Transfer created for booking ${booking._id}: ${transfer.id}`);

    // Update booking
    booking.payment.status = 'completed';
    booking.payment.capturedAt = new Date();
    booking.payment.stripeTransferId = transfer.id;
    booking.payment.stripeDestinationPayment = transfer.destination_payment as string;
    booking.payment.transferredAt = new Date();
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      buildPaymentUpsertBase(booking, {
        status: 'completed',
        stripePaymentIntentId: booking.payment.stripePaymentIntentId,
        stripeChargeId: (paymentIntent.latest_charge as string) || booking.payment.stripeChargeId,
        stripeTransferId: transfer.id,
        stripeDestinationPayment: transfer.destination_payment as string,
        capturedAt: booking.payment.capturedAt,
        transferredAt: booking.payment.transferredAt,
        professionalPayout: booking.payment.professionalPayout,
      }, professional),
      { upsert: true }
    );

    return { success: true };

  } catch (error: any) {
    console.error('Error capturing and transferring payment:', error);
    return {
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to capture payment'
      }
    };
  }
};

/**
 * Refund payment
 * POST /api/stripe/payment/refund
 */
export const refundPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId, reason, amount } = req.body;
    const userId = (req as any).user._id;

    const booking = await Booking.findById(bookingId).populate('professional');
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Authorization check (admin or customer)
    const user = await User.findById(userId);
    const isAuthorized = user?.role === 'admin' || booking.customer.toString() === userId;
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to refund' }
      });
    }

    if (!booking.payment?.stripePaymentIntentId) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_PAYMENT', message: 'No payment to refund' }
      });
    }

    const refundAmount = amount || booking.payment.totalWithVat;

    // Scenario A: Payment authorized but not captured yet
    if (booking.payment.status === 'authorized') {
      await stripe.paymentIntents.cancel(booking.payment.stripePaymentIntentId);

      booking.payment.status = 'refunded';
      booking.payment.refundedAt = new Date();
      booking.payment.refundReason = reason;
      booking.payment.refundSource = 'platform';
      booking.status = 'cancelled';
      await booking.save();

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        {
          $set: buildPaymentUpsertBase(booking, {
            status: 'refunded',
            refundedAt: booking.payment.refundedAt,
            canceledAt: booking.payment.refundedAt,
          }),
          $push: {
            refunds: {
              amount: refundAmount,
              reason,
              refundId: undefined,
              refundedAt: booking.payment.refundedAt || new Date(),
              source: 'platform',
              notes: 'Payment authorization cancelled before capture',
            },
          },
        },
        { upsert: true }
      );

      console.log(`✅ Payment cancelled for booking ${booking._id}`);

      return res.json({
        success: true,
        data: { message: 'Payment authorization cancelled', refundAmount }
      });
    }

    // Scenario B & C: Payment captured
    if (booking.payment.status === 'completed') {
      // Create refund
      const refund = await stripe.refunds.create({
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: amount ? convertToStripeAmount(amount) : undefined,
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'refund',
          timestamp: Date.now(),
        })
      });

      // If transfer already happened, reverse it
      if (booking.payment.stripeTransferId) {
        try {
          await stripe.transfers.createReversal(
            booking.payment.stripeTransferId,
            {
              amount: amount ? convertToStripeAmount(amount) : undefined,
              metadata: { reason, bookingId: booking._id.toString() }
            }
          );
          booking.payment.refundSource = 'professional';
        } catch (error) {
          console.error('Transfer reversal failed:', error);
          booking.payment.refundSource = 'platform';
          booking.payment.refundNotes = 'Platform-funded refund (transfer reversal failed)';
        }
      } else {
        booking.payment.refundSource = 'platform';
      }

      booking.payment.status = amount && amount < booking.payment.totalWithVat ? 'partially_refunded' : 'refunded';
      booking.payment.refundedAt = new Date();
      booking.payment.refundReason = reason;
      booking.status = 'refunded';
      await booking.save();

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        {
          $set: buildPaymentUpsertBase(booking, {
            status: booking.payment.status,
            refundedAt: booking.payment.refundedAt,
          }),
          $push: {
            refunds: {
              amount: refundAmount,
              reason,
              refundId: refund.id,
              refundedAt: booking.payment.refundedAt || new Date(),
              source: booking.payment.refundSource || 'platform',
              notes: booking.payment.refundNotes,
            },
          },
        },
        { upsert: true }
      );

      console.log(`✅ Refund processed for booking ${booking._id}: ${refund.id}`);

      return res.json({
        success: true,
        data: {
          refundId: refund.id,
          amount: refundAmount,
          status: refund.status,
          refundSource: booking.payment.refundSource
        }
      });
    }

    res.status(400).json({
      success: false,
      error: { code: 'INVALID_STATUS', message: 'Payment cannot be refunded in current status' }
    });

  } catch (error: any) {
    console.error('Error processing refund:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to process refund'
      }
    });
  }
};
