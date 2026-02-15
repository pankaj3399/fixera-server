/**
 * Stripe Payment Handlers
 * Handles payment intent creation, capture, transfer, and refunds
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import Booking from '../../models/booking';
import User from '../../models/user';
import Payment from '../../models/payment';
import {
  generateIdempotencyKey,
  convertToStripeAmount,
  calculateProfessionalPayout,
  calculateStripeFee,
  validatePaymentAmount,
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

const ALLOWED_PAYMENT_OVERRIDE_KEYS = new Set([
  'status',
  'method',
  'netAmount',
  'vatAmount',
  'vatRate',
  'totalWithVat',
  'platformCommission',
  'professionalPayout',
  'stripePaymentIntentId',
  'stripeChargeId',
  'stripeTransferId',
  'stripeDestinationPayment',
  'authorizedAt',
  'capturedAt',
  'transferredAt',
  'refundedAt',
  'canceledAt',
  'invoiceNumber',
  'invoiceUrl',
  'invoiceGeneratedAt',
  'metadata',
  'notes',
  'refundReason',
  'refundSource',
  'refundNotes',
]);

const filterPaymentOverrides = (overrides: Record<string, any>) =>
  Object.entries(overrides).reduce((acc, [key, value]) => {
    if (ALLOWED_PAYMENT_OVERRIDE_KEYS.has(key)) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, any>);

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
    ...filterPaymentOverrides(overrides),
  };
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

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

    // Validate payment amount against Stripe minimums/maximums
    const amountValidation = validatePaymentAmount(totalAmount, currency);
    if (!amountValidation.valid) {
      return { success: false, error: { code: 'INVALID_AMOUNT', message: amountValidation.error! } };
    }

    const platformCommission = (totalAmount * STRIPE_CONFIG.commissionPercent) / 100;
    const professionalPayout = totalAmount - platformCommission;
    const stripeFee = calculateStripeFee(totalAmount, currency);

    // Create Payment Intent with immediate charge
    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(totalAmount, currency),
      currency: currency.toLowerCase(),
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
        timestamp: Date.now(),
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
      stripeFeeAmount: stripeFee,
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
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (typeof bookingId !== 'string' || !bookingId.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_BOOKING_ID', message: 'bookingId must be a non-empty string' }
      });
    }

    if (typeof paymentIntentId !== 'string' || !paymentIntentId.trim()) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PAYMENT_INTENT_ID', message: 'paymentIntentId must be a non-empty string' }
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

    if (paymentIntent.status === 'succeeded') {
      // Payment charged successfully — funds in Fixera's Stripe account
      console.log(`[PAYMENT CONFIRM] PaymentIntent status is succeeded, updating booking`);

      booking.payment!.status = 'authorized';
      booking.payment!.authorizedAt = new Date();
      booking.payment!.capturedAt = new Date();
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
          capturedAt: booking.payment!.capturedAt || new Date(),
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
        message: 'Failed to confirm payment'
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

    // Payment already captured (automatic capture) — proceed to transfer
    const latestChargeId = booking.payment.stripeChargeId;

    console.log(`Transferring payment for booking ${booking._id} (already captured)`);

    // Step 2: Transfer to professional (money goes from Fixera -> Professional)
    const payoutMajorAmount = Number(
      booking.payment.professionalPayout ?? booking.payment.totalWithVat ?? booking.payment.amount ?? 0
    );
    const bookingCurrency = (booking.payment.currency || 'EUR').toLowerCase();
    const destinationAccountId = professional?.stripe?.accountId;
    if (!destinationAccountId) {
      return {
        success: false,
        error: {
          code: 'PROFESSIONAL_STRIPE_ACCOUNT_MISSING',
          message: 'Professional Stripe account missing or deauthorized',
        },
      };
    }

    let transferCurrency = bookingCurrency;
    let transferAmount = convertToStripeAmount(payoutMajorAmount, transferCurrency);
    let sourceTransaction: string | undefined;

    // If Stripe settled the charge in another currency (e.g., USD), source_transaction transfers
    // must use that settlement currency. We compute payout proportionally in minor units.
    if (latestChargeId) {
      sourceTransaction = latestChargeId;
      try {
        const charge = await stripe.charges.retrieve(latestChargeId, {
          expand: ['balance_transaction'],
        });

        const balanceTransaction =
          typeof charge.balance_transaction === 'string'
            ? null
            : (charge.balance_transaction as Stripe.BalanceTransaction);

        if (balanceTransaction?.currency) {
          transferCurrency = balanceTransaction.currency.toLowerCase();
        } else if (charge.currency) {
          transferCurrency = charge.currency.toLowerCase();
        }

        if (typeof balanceTransaction?.amount === 'number' && balanceTransaction.amount > 0) {
          const bookingTotal = Number(booking.payment.totalWithVat ?? booking.payment.amount ?? payoutMajorAmount);
          const payoutRatio = bookingTotal > 0 ? clamp(payoutMajorAmount / bookingTotal, 0, 1) : 1;
          transferAmount = Math.max(1, Math.round(balanceTransaction.amount * payoutRatio));
        }
      } catch (chargeInspectError: any) {
        console.warn(
          `[TRANSFER] Could not inspect charge ${latestChargeId} for booking ${booking._id}. Falling back to booking currency.`,
          chargeInspectError?.message || chargeInspectError
        );
      }
    }

    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: transferAmount,
        currency: transferCurrency,
        destination: destinationAccountId,
        source_transaction: sourceTransaction,
        metadata: {
          ...buildTransferMetadata(
            booking._id.toString(),
            booking.bookingNumber || '',
            new Date().toISOString(),
            STRIPE_CONFIG.environment as 'production' | 'test'
          ),
          bookingCurrency,
          transferCurrency,
        },
        description: `Payout for Booking #${booking.bookingNumber}`,
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'transfer',
        })
      });
    } catch (transferError: any) {
      // Capture succeeded but transfer failed — record the state for manual recovery
      console.error(`Transfer FAILED after capture for booking ${booking._id}:`, transferError.message);

      booking.payment.status = 'completed'; // Money is captured
      booking.payment.refundNotes = `Transfer failed after capture: ${transferError.message}. Funds held in platform account.`;
      await booking.save();

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        buildPaymentUpsertBase(booking, {
          status: 'completed',
          capturedAt: booking.payment.capturedAt,
          stripeChargeId: booking.payment.stripeChargeId,
          metadata: {
            transferFailed: true,
            transferError: transferError.message,
            attemptedTransferCurrency: transferCurrency,
            attemptedTransferAmount: transferAmount,
            bookingCurrency,
          },
        }, professional),
        { upsert: true }
      );

      return {
        success: false,
        error: {
          code: 'TRANSFER_FAILED',
          message: 'Payment captured but transfer to professional failed. Admin will handle manually.'
        }
      };
    }

    console.log(`Transfer created for booking ${booking._id}: ${transfer.id}`);

    // Update booking with full completion
    booking.payment.status = 'completed';
    booking.payment.stripeTransferId = transfer.id;
    booking.payment.stripeDestinationPayment = transfer.destination_payment as string;
    booking.payment.transferredAt = new Date();
    await booking.save();

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      buildPaymentUpsertBase(booking, {
        status: 'completed',
        stripePaymentIntentId: booking.payment.stripePaymentIntentId,
        stripeChargeId: booking.payment.stripeChargeId,
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
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (typeof bookingId !== 'string' || !bookingId.trim() || !mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_BOOKING_ID', message: 'bookingId must be a valid non-empty ID' }
      });
    }

    let normalizedAmount: number | undefined;
    if (amount !== undefined && amount !== null) {
      const parsedAmount =
        typeof amount === 'string' ? Number.parseFloat(amount) : Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_AMOUNT', message: 'amount must be a number greater than 0' }
        });
      }
      normalizedAmount = parsedAmount;
    }

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

    const totalWithVat = booking.payment?.totalWithVat ?? 0;
    const refundAmount = normalizedAmount ?? totalWithVat;

    // Validate refund amount doesn't exceed remaining refundable amount
    if (
      normalizedAmount &&
      ['completed', 'authorized'].includes(booking.payment.status)
    ) {
      const existingPayment = await Payment.findOne({ booking: booking._id });
      if (existingPayment) {
        const previousRefundTotal = (existingPayment.refunds || []).reduce(
          (sum: number, r: any) => sum + (r.amount || 0), 0
        );
        if (previousRefundTotal + normalizedAmount > totalWithVat) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'REFUND_EXCEEDS_TOTAL',
              message: `Refund of ${normalizedAmount} would exceed total payment. Already refunded: ${previousRefundTotal}, original: ${totalWithVat}`
            }
          });
        }
      }
    }

    // Scenario A: Payment authorized (charged but not yet transferred to professional)
    if (booking.payment.status === 'authorized') {
      const refund = await stripe.refunds.create({
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: normalizedAmount
          ? convertToStripeAmount(normalizedAmount, booking.payment.currency || 'EUR')
          : undefined,
      }, {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'refund',
          timestamp: Date.now(),
        })
      });

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
          }),
          $push: {
            refunds: {
              amount: refundAmount,
              reason,
              refundId: refund.id,
              refundedAt: booking.payment.refundedAt || new Date(),
              source: 'platform',
              notes: 'Refund issued before transfer to professional',
            },
          },
        },
        { upsert: true }
      );

      console.log(`✅ Payment refunded for booking ${booking._id}: ${refund.id}`);

      return res.json({
        success: true,
        data: { message: 'Payment refunded', refundId: refund.id, refundAmount }
      });
    }

    // Scenario B & C: Payment captured
    if (booking.payment.status === 'completed') {
      // Create refund
      const refund = await stripe.refunds.create({
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: normalizedAmount
          ? convertToStripeAmount(normalizedAmount, booking.payment.currency || 'EUR')
          : undefined,
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
              amount: normalizedAmount
                ? convertToStripeAmount(normalizedAmount, booking.payment.currency || 'EUR')
                : undefined,
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

      booking.payment.status =
        normalizedAmount && normalizedAmount < totalWithVat ? 'partially_refunded' : 'refunded';
      booking.payment.refundedAt = new Date();
      booking.payment.refundReason = reason;
      if (booking.payment.status === 'refunded') {
        booking.status = 'refunded';
      }
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
        message: 'Failed to refund payment'
      }
    });
  }
};
