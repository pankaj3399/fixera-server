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
  buildPaymentIntentIdempotencyKey,
  buildTransferIdempotencyKey,
  generateIdempotencyKey,
  convertToStripeAmount,
  calculateProfessionalPayout,
  calculatePlatformCommission,
  calculateStripeFee,
  validatePaymentAmount,
  validateCurrency,
  buildPaymentMetadata,
  buildTransferMetadata,
  determineBookingCurrency,
  computeGrossBookingAmount,
  quoteAmountIncludesSelectedExtras,
} from '../../utils/payment';
import { buildMilestoneChargePlan } from '../../utils/milestoneCharges';
import { canRetryTransfer, getTransferStatus, requireProfessionalPayout } from '../../utils/paymentSafety';
import { calculateVAT } from '../../utils/vat';
import { calculateVatFromPricingLines } from '../../utils/vatLineCalculation';
import { parseVatCountryCode, requiresVatRfqReview } from '../../utils/vatManagement';
import PlatformSettings from '../../models/platformSettings';
import {
  loadBasePaymentRows,
  recordBasePaymentRefund,
} from '../../utils/paymentRefundLedger';
import { summarizeBaseRefunds } from '../../utils/paymentRefunds';
import { isPreCompletionStatus } from '../../utils/refundFinalization';
import { calculateAutoDiscount, validateDiscountCode } from '../../utils/discountEngine';
// deductPoints moved to webhook handler (handlePaymentIntentSucceeded)
import { calculateDiscountedPayouts } from '../../utils/discountEngine';
import { commissionedPricingLines, commissionedQuoteAmount } from '../../utils/customerPricing';
import { auditLog } from '../../utils/auditLogger';
import { notifyBookingPaymentConfirmed } from '../../utils/notifications/bookingPaymentNotify';

const extractParticipantIds = (booking: any, professionalOverride?: any) => {
  const customerId = (booking.customer as any)?._id || booking.customer;
  const professionalSource = professionalOverride || booking.professional;
  const professionalId = (professionalSource as any)?._id || professionalSource || undefined;
  return { customerId, professionalId };
};

/**
 * VAT-inclusive amount actually paid by the customer, matching what booking
 * details and the invoice show. `payment.amount` is the pre-VAT net and must
 * never be presented as the paid amount.
 */
const grossPaidAmount = (payment: any): number | undefined => {
  const gross = Number(payment?.totalWithVat);
  if (Number.isFinite(gross)) return gross;
  const net = Number(payment?.amount);
  return Number.isFinite(net) ? net : undefined;
};

const ALLOWED_PAYMENT_OVERRIDE_KEYS = new Set([
  'status',
  'method',
  'netAmount',
  'vatAmount',
  'vatRate',
  'totalWithVat',
  'reverseCharge',
  'vatBreakdown',
  'platformCommission',
  'professionalPayout',
  'stripePaymentIntentId',
  'stripeChargeId',
  'stripeTransferId',
  'stripeDestinationPayment',
  'transferStatus',
  'transferIdempotencyKey',
  'transferAttempt',
  'transferFailureReason',
  'transferAttemptedAt',
  'authorizedAt',
  'capturedAt',
  'transferredAt',
  'refundedAt',
  'canceledAt',
  'invoiceNumber',
  'invoiceUrl',
  'invoiceUblUrl',
  'invoiceGeneratedAt',
  'supplierInvoiceNumber',
  'supplierInvoiceUrl',
  'supplierInvoiceUblUrl',
  'supplierInvoiceGeneratedAt',
  'peppolDispatchStatus',
  'peppolDispatchReason',
  'peppolDispatchReference',
  'peppolDispatchedAt',
  'supplierPeppolDispatchStatus',
  'supplierPeppolDispatchReason',
  'supplierPeppolDispatchReference',
  'supplierPeppolDispatchedAt',
  'milestoneIndex',
  'metadata',
  'notes',
  'refundReason',
  'refundSource',
  'refundNotes',
  'extraCostAmount',
  'extraCostCustomerNetAmount',
  'extraCostVatAmount',
  'extraCostPlatformFee',
  'extraCostNetAmount',
  'extraCostCustomerDiscount',
  'extraCostPlatformCommission',
  'extraCostProfessionalPayout',
  'extraCostStatus',
  'extraCostPaymentSucceeded',
  'extraCostPaidAt',
  'extraCostStripePaymentIntentId',
  'extraCostStripeChargeId',
  'extraCostTransferId',
  'extraCostTransferStatus',
  'extraCostTransferFailureReason',
  'extraCostTransferAttemptedAt',
]);

const filterPaymentOverrides = (overrides: Record<string, any>) =>
  Object.entries(overrides).reduce((acc, [key, value]) => {
    if (ALLOWED_PAYMENT_OVERRIDE_KEYS.has(key)) {
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, any>);

/**
 * A transfer error is ambiguous when we cannot know whether Stripe created the
 * transfer: network-level failures (no HTTP status) and HTTP 5xx responses.
 */
const isAmbiguousTransferError = (error: any): boolean => {
  if (!error) return true;
  const status = typeof error.statusCode === 'number'
    ? error.statusCode
    : typeof error.response?.status === 'number'
      ? error.response.status
      : undefined;
  if (typeof status !== 'number') return true;
  return status >= 500;
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
    reverseCharge: paymentSummary.reverseCharge,
    vatBreakdown: paymentSummary.vatBreakdown,
    platformCommission: paymentSummary.platformCommission,
    professionalPayout: paymentSummary.professionalPayout,
    transferStatus: paymentSummary.transferStatus,
    transferIdempotencyKey: paymentSummary.transferIdempotencyKey,
    transferAttempt: paymentSummary.transferAttempt,
    transferFailureReason: paymentSummary.transferFailureReason,
    transferAttemptedAt: paymentSummary.transferAttemptedAt,
    invoiceNumber: paymentSummary.invoiceNumber,
    invoiceUrl: paymentSummary.invoiceUrl,
    invoiceUblUrl: paymentSummary.invoiceUblUrl,
    invoiceGeneratedAt: paymentSummary.invoiceGeneratedAt,
    supplierInvoiceNumber: paymentSummary.supplierInvoiceNumber,
    supplierInvoiceUrl: paymentSummary.supplierInvoiceUrl,
    supplierInvoiceUblUrl: paymentSummary.supplierInvoiceUblUrl,
    supplierInvoiceGeneratedAt: paymentSummary.supplierInvoiceGeneratedAt,
    peppolDispatchStatus: paymentSummary.peppolDispatchStatus,
    peppolDispatchReason: paymentSummary.peppolDispatchReason,
    peppolDispatchReference: paymentSummary.peppolDispatchReference,
    peppolDispatchedAt: paymentSummary.peppolDispatchedAt,
    supplierPeppolDispatchStatus: paymentSummary.supplierPeppolDispatchStatus,
    supplierPeppolDispatchReason: paymentSummary.supplierPeppolDispatchReason,
    supplierPeppolDispatchReference: paymentSummary.supplierPeppolDispatchReference,
    supplierPeppolDispatchedAt: paymentSummary.supplierPeppolDispatchedAt,
    extraCostAmount: paymentSummary.extraCostAmount,
    extraCostCustomerNetAmount: paymentSummary.extraCostCustomerNetAmount,
    extraCostVatAmount: paymentSummary.extraCostVatAmount,
    extraCostPlatformFee: paymentSummary.extraCostPlatformFee,
    extraCostNetAmount: paymentSummary.extraCostNetAmount,
    extraCostCustomerDiscount: paymentSummary.extraCostCustomerDiscount,
    extraCostPlatformCommission: paymentSummary.extraCostPlatformCommission,
    extraCostProfessionalPayout: paymentSummary.extraCostProfessionalPayout,
    extraCostStatus: paymentSummary.extraCostStatus,
    extraCostPaymentSucceeded: paymentSummary.extraCostPaymentSucceeded,
    extraCostPaidAt: paymentSummary.extraCostPaidAt,
    extraCostStripePaymentIntentId: paymentSummary.extraCostStripePaymentIntentId,
    extraCostStripeChargeId: paymentSummary.extraCostStripeChargeId,
    extraCostTransferId: paymentSummary.extraCostTransferId,
    extraCostTransferStatus: paymentSummary.extraCostTransferStatus,
    extraCostTransferFailureReason: paymentSummary.extraCostTransferFailureReason,
    extraCostTransferAttemptedAt: paymentSummary.extraCostTransferAttemptedAt,
    ...filterPaymentOverrides(overrides),
  };
};

const getQuotePricingVatCalculation = (booking: any, amount: number, commissionPercent: number) => {
  const quoteVersions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  const currentVersion = quoteVersions.find((version: any) => version.version === booking.currentQuoteVersion)
    || quoteVersions[quoteVersions.length - 1];
  const pricingLines = Array.isArray(currentVersion?.pricingLines)
    ? currentVersion.pricingLines
    : [];
  if (pricingLines.length === 0) {
    return null;
  }
  const hasCompleteVatMetadata = pricingLines.every((line: any) =>
    Number.isFinite(Number(line.price)) &&
    Number(line.price) > 0 &&
    Number.isFinite(Number(line.vatRate)) &&
    Number(line.vatRate) >= 0 &&
    Number(line.vatRate) <= 100
  );
  if (!hasCompleteVatMetadata) {
    return null;
  }
  // VAT is calculated on the price AFTER commission is included, mirroring
  // the recorded quote customer totals: commission each line first, then
  // allocate VAT across the customer-facing lines.
  const proTotal = pricingLines.reduce((sum: number, line: any) => sum + Number(line.price), 0);
  const customerNet = commissionedQuoteAmount(proTotal, (booking as any).checkoutSnapshot, commissionPercent);
  const commissionedLines = commissionedPricingLines(
    pricingLines.map((line: any) => ({
      description: String(line.description || ''),
      price: Number(line.price),
      vatRate: Number(line.vatRate),
      vatCountry: line.vatCountry,
      vatLabel: line.vatLabel,
    })),
    customerNet,
    commissionPercent,
  );
  const commissionedNet = commissionedLines.reduce((sum, line) => sum + Number(line.price), 0);
  const discountedNet = commissionedNet > 0 && amount > 0 && amount <= commissionedNet ? amount : undefined;
  return calculateVatFromPricingLines(commissionedLines, discountedNet);
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

type CreatePaymentIntentResult = {
  success: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
  milestoneIndex?: number | null;
  error?: any;
};

type NormalizedBookingMilestone = {
  amount: number;
  customDueDate?: Date | string;
  dueCondition?: string;
  order?: number;
  status?: string;
  workStatus?: string;
  _originalIndex: number;
};

const normalizeBookingMilestones = (milestones: any[]): NormalizedBookingMilestone[] =>
  milestones
    .map((milestone: any, idx: number) => ({
      ...(milestone?.toObject?.() || milestone),
      _originalIndex: idx,
    }))
    .sort((a: NormalizedBookingMilestone, b: NormalizedBookingMilestone) => (a.order ?? 0) - (b.order ?? 0));

const isMilestoneCurrentlyPayable = (
  milestone: NormalizedBookingMilestone,
  sortedMilestones: NormalizedBookingMilestone[]
): boolean => {
  if (milestone.status === 'paid') return false;

  const milestoneOrder = milestone.order ?? 0;
  const hasEarlierUnpaidMilestone = sortedMilestones.some(
    (candidate) => (candidate.order ?? 0) < milestoneOrder && candidate.status !== 'paid'
  );
  if (hasEarlierUnpaidMilestone) return false;

  const dueCondition = milestone.dueCondition;
  if (dueCondition === 'on_start') return true;
  if (dueCondition === 'on_milestone_start') {
    return milestone.workStatus === 'in_progress' || milestone.workStatus === 'completed';
  }
  if (dueCondition === 'on_milestone_completion') {
    return milestone.workStatus === 'completed';
  }
  if (dueCondition === 'custom_date') {
    if (milestone.workStatus === 'completed') return true;
    return !!milestone.customDueDate && new Date(milestone.customDueDate) <= new Date();
  }

  return false;
};

/**
 * Create Payment Intent when customer accepts quote
 * Called from booking respond endpoint
 */
export const createPaymentIntent = async (
  bookingId: string,
  userId: string,
  pointsToRedeem: number = 0,
  requestedMilestoneIndex?: number,
  discountCode?: string
): Promise<CreatePaymentIntentResult> => {
  try {
    const booking = await Booking.findById(bookingId)
      .populate('customer')
      .populate('professional')
      .populate('project', 'professionalId title extraOptions');

    if (!booking) {
      return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } };
    }

    // Verify customer
    if (booking.customer._id.toString() !== userId) {
      return { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authorized' } };
    }

    const hasUnpaidMilestones = Array.isArray(booking.milestonePayments)
      && booking.milestonePayments.length > 0
      && booking.milestonePayments.some((m: any) => m.status !== 'paid');

    const allowedStatuses = hasUnpaidMilestones
      ? ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed']
      : ['quote_accepted', 'payment_pending', 'booked'];
    if (!booking.quote || !allowedStatuses.includes(booking.status)) {
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
    const selectedExtraOptionsTotal = Array.isArray(booking.selectedExtraOptions)
      ? booking.selectedExtraOptions.reduce(
          (sum: number, entry: any) => (typeof entry?.bookedPrice === 'number' ? sum + entry.bookedPrice : sum),
          0
        )
      : 0;

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

    // Fetch commission rate from DB early so milestone amounts include it
    let commissionPercent: number;
    try {
      const platformConfig = await PlatformSettings.getCurrentConfig();
      commissionPercent = platformConfig.commissionPercent;
    } catch (configError) {
      console.warn('Failed to fetch platform config from DB, falling back to env var:', configError);
      const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
      commissionPercent = Number.isFinite(parsed) ? parsed : 0;
    }

    // Determine currency
    const currency = determineBookingCurrency(
      booking.quote.currency,
      professional.currency,
      customer.location?.country
    );

    let chargeAmount = commissionedQuoteAmount(booking.quote.amount, (booking as any).checkoutSnapshot, commissionPercent);
    let milestoneIndex: number | null = null;
    if (Array.isArray(booking.milestonePayments) && booking.milestonePayments.length > 0) {
      const sorted = normalizeBookingMilestones(booking.milestonePayments as any[]);
      const nextPayable = sorted.find((milestone) => isMilestoneCurrentlyPayable(milestone, sorted));
      if (nextPayable) {
        if (
          typeof requestedMilestoneIndex === 'number'
          && nextPayable._originalIndex !== requestedMilestoneIndex
        ) {
          return {
            success: false,
            error: {
              code: 'MILESTONE_NOT_DUE',
              message: 'The selected milestone is not currently due for payment.'
            }
          };
        }
        chargeAmount = +(nextPayable.amount * (1 + commissionPercent / 100)).toFixed(2);
        milestoneIndex = nextPayable._originalIndex;
      } else {
        return {
          success: false,
          error: {
            code: 'NO_MILESTONE_DUE',
            message: 'No milestone is currently due for payment.'
          }
        };
      }
    }
    // Client bug list #19b: options are charged in full with the first
    // milestone via the shared charge plan — never split across milestones.
    if (milestoneIndex !== null) {
      const planEntry = buildMilestoneChargePlan(booking, commissionPercent)
        .find((entry) => entry.index === milestoneIndex) || null;
      if (planEntry) chargeAmount = planEntry.expectedCustomerGross;
    } else if (selectedExtraOptionsTotal > 0 && !quoteAmountIncludesSelectedExtras(booking)) {
      chargeAmount += +(selectedExtraOptionsTotal * (1 + commissionPercent / 100)).toFixed(2);
    }

    if (booking.payment?.stripePaymentIntentId && booking.payment?.stripeClientSecret) {
      if (['authorized', 'completed'].includes(booking.payment.status) && !hasUnpaidMilestones) {
        return {
          success: false,
          error: {
            code: 'PAYMENT_ALREADY_PROCESSED',
            message: 'Payment has already been processed for this booking'
          }
        };
      }
      const isMatchingPendingMilestoneIntent =
        typeof requestedMilestoneIndex === 'number'
          ? booking.payment.milestoneIndex === requestedMilestoneIndex
          : true;
      const storedCodeLabel = (booking.payment as any)?.discount?.codeLabel;
      const requestedCodeLabel = discountCode ? discountCode.trim().toUpperCase() : undefined;
      const codeMatches = (storedCodeLabel || undefined) === (requestedCodeLabel || undefined);
      const storedPoints = Number((booking.payment as any)?.discount?.pointsRedeemed) || 0;
      const pointsMatch = storedPoints === (Number(pointsToRedeem) || 0);

      // Verify that the charge amount matches the original amount of the pending payment intent
      const existingOriginalAmount = booking.payment?.discount?.originalAmount ?? booking.payment?.netAmount ?? 0;
      const amountMatches = Math.abs(chargeAmount - existingOriginalAmount) < 0.01;

      if (booking.payment.status === 'pending' && isMatchingPendingMilestoneIntent && codeMatches && pointsMatch && amountMatches) {
        console.log(`♻️  Reusing existing PaymentIntent for booking ${booking._id}: ${booking.payment.stripePaymentIntentId}`);
        return {
          success: true,
          clientSecret: booking.payment.stripeClientSecret,
          paymentIntentId: booking.payment.stripePaymentIntentId,
          milestoneIndex: typeof booking.payment.milestoneIndex === 'number' ? booking.payment.milestoneIndex : null,
        };
      }
      if (booking.payment.status === 'pending') {
        try {
          await stripe.paymentIntents.cancel(booking.payment.stripePaymentIntentId);
          console.log(`🗑️  Cancelled superseded PaymentIntent ${booking.payment.stripePaymentIntentId} for booking ${booking._id}`);
        } catch (cancelErr: any) {
          if (cancelErr?.code !== 'payment_intent_unexpected_state' && cancelErr?.code !== 'resource_missing') {
            console.warn(`Failed to cancel superseded PaymentIntent: ${cancelErr?.message || cancelErr}`);
          }
        }
      }
    }

    const fullBookingAmount = computeGrossBookingAmount(booking, commissionPercent);

    let codeInfo: any = null;
    if (discountCode) {
      const validation = await validateDiscountCode(
        discountCode,
        customer._id.toString(),
        fullBookingAmount,
        customer.location?.country,
        (booking as any).rfqData?.serviceType
      );
      if (!validation.ok) {
        return { success: false, error: { code: 'INVALID_DISCOUNT_CODE', message: validation.error || 'Invalid discount code' } };
      }
      codeInfo = validation.info;
    }


    const fullDiscountBreakdown = await calculateAutoDiscount(
      customer._id.toString(),
      professional._id.toString(),
      booking.project ? (booking.project as any)._id?.toString() || booking.project.toString() : null,
      fullBookingAmount,
      customer.totalSpent || 0,
      pointsToRedeem,
      codeInfo
    );

    let discountBreakdown = fullDiscountBreakdown;
    if (fullBookingAmount > 0 && chargeAmount < fullBookingAmount) {
      const ratio = chargeAmount / fullBookingAmount;
      const proratedLoyalty = Math.round(fullDiscountBreakdown.loyaltyDiscount.amount * ratio * 100) / 100;
      const proratedRepeat = Math.round(fullDiscountBreakdown.repeatBuyerDiscount.amount * ratio * 100) / 100;
      const proratedPoints = Math.round(fullDiscountBreakdown.pointsDiscount.discountAmount * ratio * 100) / 100;
      const proratedCode = fullDiscountBreakdown.codeDiscount
        ? Math.round(fullDiscountBreakdown.codeDiscount.amount * ratio * 100) / 100
        : 0;
      const proratedTotal = proratedLoyalty + proratedRepeat + proratedPoints + proratedCode;
      discountBreakdown = {
        ...fullDiscountBreakdown,
        loyaltyDiscount: { ...fullDiscountBreakdown.loyaltyDiscount, amount: proratedLoyalty },
        repeatBuyerDiscount: { ...fullDiscountBreakdown.repeatBuyerDiscount, amount: proratedRepeat },
        pointsDiscount: { ...fullDiscountBreakdown.pointsDiscount, discountAmount: proratedPoints },
        codeDiscount: fullDiscountBreakdown.codeDiscount
          ? { ...fullDiscountBreakdown.codeDiscount, amount: proratedCode }
          : undefined,
        totalDiscount: proratedTotal,
        originalAmount: chargeAmount,
        finalAmount: chargeAmount - proratedTotal,
      };
    }

    // Use discounted amount for VAT and payment calculations
    const discountedQuoteAmount = discountBreakdown.finalAmount;

    // Calculate VAT on the discounted amount. Prefer the booking's service-level VAT
    // decision when the booking wizard already evaluated a configured rule.
    const configuredVatDecision = (booking as any).vatDecision;
    // A professional may enter a provisional/custom rate while preparing a
    // quotation. Once the booking wizard has resolved reverse charge, that
    // customer-side decision is authoritative and must not be overridden by
    // quotation line metadata.
    const quotePricingVatCalculation = configuredVatDecision?.reverseCharge
      ? null
      : getQuotePricingVatCalculation(booking, discountedQuoteAmount, commissionPercent);
    const vatCountry = parseVatCountryCode(
      configuredVatDecision?.country || booking.location?.country || customer.location?.country,
    );
    if (!vatCountry) {
      return {
        success: false,
        error: {
          code: 'VAT_COUNTRY_REQUIRED',
          message: 'A valid service or place-of-supply country is required before payment can be created.',
        },
      };
    }

    const vatCalculation = quotePricingVatCalculation
      ? quotePricingVatCalculation
      : configuredVatDecision && !requiresVatRfqReview(configuredVatDecision)
        ? (() => {
            const vatRate = Number(configuredVatDecision.appliedRate) || 0;
            const vatAmount = Math.round(((discountedQuoteAmount * vatRate) / 100) * 100) / 100;
            return {
              vatRate,
              vatAmount,
              total: Math.round((discountedQuoteAmount + vatAmount) * 100) / 100,
              reverseCharge: Boolean(configuredVatDecision.reverseCharge),
            };
          })()
        : calculateVAT({
          amount: discountedQuoteAmount,
          customerCountry: vatCountry,
          customerVATNumber: customer.isVatVerified ? customer.vatNumber || null : null,
          customerVatVerified: customer.isVatVerified === true,
          professionalCountry: professional.businessInfo?.country,
          customerType: customer.customerType || 'individual',
          propertyNature: configuredVatDecision?.propertyNature === 'immovable' ? 'immovable' : 'movable',
          exemptFromBelgianReverseCharge: Boolean(configuredVatDecision?.exemptFromBelgianReverseCharge),
        });

    // Calculate amounts
    const netAmount = discountedQuoteAmount;
    const vatAmount = vatCalculation.vatAmount;
    const totalAmount = vatCalculation.total;

    // Validate payment amount against Stripe minimums/maximums
    const amountValidation = validatePaymentAmount(totalAmount, currency);
    if (!amountValidation.valid) {
      return { success: false, error: { code: 'INVALID_AMOUNT', message: amountValidation.error! } };
    }

    // Use hybrid discount absorption model
    // A charge covering the whole booking pays the professional their own
    // price; a milestone share is derived from what it charges.
    const professionalBookingAmount = fullBookingAmount > 0 && chargeAmount >= fullBookingAmount
      ? Number(booking.quote.amount || 0) + (quoteAmountIncludesSelectedExtras(booking) ? 0 : selectedExtraOptionsTotal)
      : undefined;
    const discountedPayouts = calculateDiscountedPayouts(discountBreakdown, commissionPercent, professionalBookingAmount);
    const platformCommission = discountedPayouts.platformCommission;
    const professionalPayout = discountedPayouts.professionalPayout;
    const stripeFee = calculateStripeFee(totalAmount, currency);

    if (discountBreakdown.totalDiscount > 0) {
      console.log(`Discount applied for booking ${booking._id}: loyalty=${discountBreakdown.loyaltyDiscount.amount}, repeat=${discountBreakdown.repeatBuyerDiscount.amount}, points=${discountBreakdown.pointsDiscount.discountAmount}, total=${discountBreakdown.totalDiscount}`);
    }

    // Capture the card payment immediately. The platform's payout transfer is
    // the escrow/release boundary and is handled separately at completion.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: convertToStripeAmount(totalAmount, currency),
      currency: currency.toLowerCase(),
      payment_method_types: ['card'],
      capture_method: 'automatic',
      metadata: buildPaymentMetadata(
        booking._id.toString(),
        booking.bookingNumber || '',
        customer._id.toString(),
        professional._id.toString(),
        professional.stripe.accountId,
        STRIPE_CONFIG.environment as 'production' | 'test'
      ),
      description: `Fixtract Booking #${booking.bookingNumber} - ${projectInfo?.title || 'Service'}`,
    }, {
      idempotencyKey: buildPaymentIntentIdempotencyKey({
        bookingId: booking._id.toString(),
        amount: totalAmount,
        currency,
        milestoneIndex,
        pointsToRedeem,
        discountCode,
        quoteVersion: booking.currentQuoteVersion,
      })
    });

    // Update booking with payment info
    booking.payment = {
      amount: netAmount,
      currency: currency,
      method: 'card',
      status: 'pending',
      transferStatus: 'pending',
      stripePaymentIntentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret || undefined,
      stripeFeeAmount: stripeFee,
      platformCommission,
      professionalPayout,
      netAmount,
      vatAmount,
      vatRate: vatCalculation.vatRate,
      totalWithVat: totalAmount,
      reverseCharge: vatCalculation.reverseCharge,
      vatBreakdown: (vatCalculation as any).vatBreakdown,
      ...(milestoneIndex !== null && { milestoneIndex }),
      ...(discountBreakdown.totalDiscount > 0 && {
        discount: {
          loyaltyTier: discountBreakdown.loyaltyDiscount.tier,
          loyaltyPercentage: discountBreakdown.loyaltyDiscount.percentage,
          loyaltyAmount: discountBreakdown.loyaltyDiscount.amount,
          repeatBuyerPercentage: discountBreakdown.repeatBuyerDiscount.percentage,
          repeatBuyerAmount: discountBreakdown.repeatBuyerDiscount.amount,
          pointsRedeemed: discountBreakdown.pointsDiscount.pointsUsed,
          pointsDiscountAmount: discountBreakdown.pointsDiscount.discountAmount,
          codeDiscountAmount: discountBreakdown.codeDiscount?.amount || 0,
          codeId: discountBreakdown.codeDiscount?.codeId
            ? new mongoose.Types.ObjectId(discountBreakdown.codeDiscount.codeId)
            : undefined,
          codeLabel: discountBreakdown.codeDiscount?.code || undefined,
          totalDiscount: discountBreakdown.totalDiscount,
          originalAmount: discountBreakdown.originalAmount,
        },
      }),
    };
    if (!hasUnpaidMilestones || ['quote_accepted', 'payment_pending'].includes(booking.status)) {
      booking.status = 'payment_pending';
    }
    await booking.save();

    // Points deduction is handled in the payment success webhook (handlePaymentIntentSucceeded)
    // to avoid permanently consuming points if the payment is abandoned or fails.
    // The booking.payment.discount.pointsRedeemed field tells the webhook how much to deduct.

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      buildPaymentUpsertBase(
        booking,
        {
          status: 'pending',
          transferStatus: 'pending',
          method: 'card',
          currency,
          amount: netAmount,
          netAmount,
          vatAmount,
          vatRate: vatCalculation.vatRate,
          totalWithVat: totalAmount,
          reverseCharge: vatCalculation.reverseCharge,
          vatBreakdown: (vatCalculation as any).vatBreakdown,
          platformCommission,
          professionalPayout,
          stripePaymentIntentId: paymentIntent.id,
          ...(milestoneIndex !== null && { milestoneIndex }),
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
      paymentIntentId: paymentIntent.id,
      milestoneIndex,
    };

  } catch (error: any) {
    console.error('Error creating payment intent:', error);
    return {
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: "We couldn't start the payment. Please try again."
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
      // Webhook may not have run yet — ensure post-payment notifications go out
      // exactly once (deduped via deliveryKey).
      try {
        await notifyBookingPaymentConfirmed({
          bookingId: String(booking._id),
          paymentIntentId: typeof paymentIntentId === 'string' ? paymentIntentId : undefined,
          // VAT-inclusive amount actually paid, matching booking details.
          amount: grossPaidAmount(booking.payment),
          currency: (booking.payment as any)?.currency || 'EUR',
        });
      } catch (notifyError: any) {
        console.error(`[PAYMENT CONFIRM] Post-payment notify failed for booking ${booking._id}:`, notifyError?.message || notifyError);
      }
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
      // Payment charged successfully — funds in Fixtract's Stripe account
      console.log(`[PAYMENT CONFIRM] PaymentIntent status is succeeded, updating booking`);

      const now = new Date();
      const msIdx = booking.payment!.milestoneIndex;
      const updateFields: Record<string, any> = {
        'payment.status': 'authorized',
        'payment.authorizedAt': now,
        'payment.capturedAt': now,
      };
      if (booking.status === 'quote_accepted' || booking.status === 'payment_pending') {
        updateFields.status = 'booked';
      }
      if (paymentIntent.latest_charge) {
        updateFields['payment.stripeChargeId'] = paymentIntent.latest_charge as string;
      }
      if (typeof msIdx === 'number' && Array.isArray(booking.milestonePayments) && booking.milestonePayments[msIdx]) {
        updateFields[`milestonePayments.${msIdx}.status`] = 'paid';
        updateFields[`milestonePayments.${msIdx}.paidAt`] = now;
      }

      const milestoneFilter: Record<string, any> = { _id: booking._id };
      if (typeof msIdx === 'number') {
        milestoneFilter[`milestonePayments.${msIdx}.status`] = { $ne: 'paid' };
      }
      const flipsToBooked = updateFields.status === 'booked';
      if (flipsToBooked) {
        milestoneFilter.status = { $in: ['quote_accepted', 'payment_pending'] };
      }

      const updateOperation: Record<string, any> = { $set: updateFields };
      if (flipsToBooked) {
        updateOperation.$push = {
          statusHistory: {
            status: 'booked',
            timestamp: now,
            note: 'Payment confirmed — booking confirmed',
          },
        };
      }
      const updated = await Booking.findOneAndUpdate(milestoneFilter, updateOperation, { new: true });
      if (!updated && flipsToBooked) {
        // Another writer (usually the webhook) already flipped the status.
        // Still persist the payment fields without appending a second history row.
        const { status, ...paymentFields } = updateFields;
        await Booking.findOneAndUpdate({ _id: booking._id }, { $set: paymentFields });
      }
      const refreshed = await Booking.findById(booking._id);
      if (refreshed) {
        booking.payment = refreshed.payment;
        booking.status = refreshed.status;
        booking.milestonePayments = refreshed.milestonePayments;
      }

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

      // Notify both sides exactly once after payment (idempotent with webhook
      // via per-booking deliveryKey — never on checkout-page forward).
      try {
        await notifyBookingPaymentConfirmed({
          bookingId: String(booking._id),
          paymentIntentId: paymentIntent.id,
          // VAT-inclusive amount actually paid, matching booking details.
          amount: grossPaidAmount(booking.payment),
          currency: (paymentIntent.currency || (booking.payment as any)?.currency || 'EUR').toUpperCase(),
        });
        // A settled milestone can make the next one payable; the per-milestone
        // delivery key dedupes this with the webhook and the reminder sweep.
        if (typeof msIdx === 'number') {
          try {
            const { notifyMilestonePaymentDue } = await import('../../utils/notifications/milestonePaymentDue');
            await notifyMilestonePaymentDue(String(booking._id));
          } catch (milestoneDueError: any) {
            console.error(`[PAYMENT CONFIRM] Milestone-due notify failed for booking ${booking._id}:`, milestoneDueError?.message || milestoneDueError);
          }
        }
      } catch (notifyError: any) {
        console.error(`[PAYMENT CONFIRM] Post-payment notify failed for booking ${booking._id}:`, notifyError?.message || notifyError);
      }

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

    const transferStatus = getTransferStatus({
      transferStatus: booking.payment.transferStatus,
      stripeTransferId: booking.payment.stripeTransferId,
      metadata: (booking.payment as any).metadata,
    });
    const isTransferRetry = canRetryTransfer({
      status: booking.payment.status,
      transferStatus,
      stripeTransferId: booking.payment.stripeTransferId,
      metadata: (booking.payment as any).metadata,
    });
    if (booking.payment.status !== 'authorized' && !isTransferRetry) {
      return { success: false, error: { code: 'INVALID_STATUS', message: 'Payment not authorized' } };
    }

    if (booking.payment.stripeTransferId && transferStatus === 'succeeded') {
      return { success: true };
    }

    const professional = booking.professional as any;

    // Payment already captured (automatic capture) — proceed to transfer
    let latestChargeId = booking.payment.stripeChargeId;
    if (!latestChargeId) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(booking.payment.stripePaymentIntentId, {
          expand: ['latest_charge'],
        });
        const latestCharge = paymentIntent.latest_charge;
        latestChargeId = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
        if (latestChargeId) {
          booking.payment.stripeChargeId = latestChargeId;
        }
      } catch (paymentIntentError: any) {
        return {
          success: false,
          error: {
            code: 'CHARGE_RECONCILIATION_FAILED',
            message: 'The captured payment could not be reconciled before transfer. Review the payment in Stripe and retry.',
          },
        };
      }
    }
    if (!latestChargeId) {
      return {
        success: false,
        error: {
          code: 'CHARGE_RECONCILIATION_REQUIRED',
          message: 'The Stripe charge is not available yet; the professional transfer is blocked until settlement is reconciled.',
        },
      };
    }

    console.log(`Transferring payment for booking ${booking._id} (already captured)`);

    // Step 2: Transfer to professional (money goes from Fixtract -> Professional)
    let payoutMajorAmount: number;
    try {
      payoutMajorAmount = requireProfessionalPayout(booking.payment);
    } catch (payoutError: any) {
      return {
        success: false,
        error: {
          code: 'PAYOUT_AMOUNT_MISSING',
          message: payoutError?.message || 'Professional payout is missing or invalid; transfer is blocked.',
        },
      };
    }
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
    let sourceTransaction = latestChargeId;

    // If Stripe settled the charge in another currency (e.g., USD), source_transaction transfers
    // must use that settlement currency. We compute payout proportionally in minor units.
    if (latestChargeId) {
      sourceTransaction = latestChargeId;
      try {
        const charge = await stripe.charges.retrieve(latestChargeId, {
          expand: ['balance_transaction'],
        });

        let balanceTransaction: Stripe.BalanceTransaction | null =
          typeof charge.balance_transaction === 'string'
            ? await stripe.balanceTransactions.retrieve(charge.balance_transaction)
            : (charge.balance_transaction as Stripe.BalanceTransaction);

        if (balanceTransaction?.currency) {
          transferCurrency = balanceTransaction.currency.toLowerCase();
        } else if (charge.currency) {
          transferCurrency = charge.currency.toLowerCase();
        }

        if (typeof balanceTransaction?.amount !== 'number' || balanceTransaction.amount <= 0) {
          throw new Error('Stripe balance transaction amount is unavailable');
        }
        const bookingTotal = Number(booking.payment.totalWithVat);
        if (!Number.isFinite(bookingTotal) || bookingTotal <= 0) {
          throw new Error('Reconciled booking total is missing or invalid');
        }
        const payoutRatio = payoutMajorAmount / bookingTotal;
        transferAmount = Math.round(balanceTransaction.amount * payoutRatio);
        if (transferAmount <= 0 || transferAmount > balanceTransaction.amount) {
          throw new Error('Professional payout does not reconcile to a valid settled Stripe amount');
        }
      } catch (chargeInspectError: any) {
        return {
          success: false,
          error: {
            code: 'CHARGE_RECONCILIATION_FAILED',
            message: 'The payment settlement could not be reconciled before transfer. Review the payment in Stripe and retry.',
          },
        };
      }
    }

    if (!validateCurrency(transferCurrency.toUpperCase())) {
      return {
        success: false,
        error: {
          code: 'UNSUPPORTED_TRANSFER_CURRENCY',
          message: `Stripe settlement currency ${transferCurrency.toUpperCase()} is not supported for professional transfers.`,
        },
      };
    }

    const transferIdempotencyKey = buildTransferIdempotencyKey({
      bookingId: booking._id.toString(),
      amountMinor: transferAmount,
      currency: transferCurrency,
      destination: destinationAccountId,
      sourceTransaction,
      attempt: booking.payment.transferAttempt || 0,
    });
    const transferAttemptedAt = booking.payment.transferAttemptedAt || new Date();
    booking.payment.transferAttemptedAt = transferAttemptedAt;
    booking.payment.transferIdempotencyKey = transferIdempotencyKey;
    booking.payment.stripeChargeId = latestChargeId;
    await booking.save();

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
            '',
            STRIPE_CONFIG.environment as 'production' | 'test'
          ),
          bookingCurrency,
          transferCurrency,
        },
        description: `Payout for Booking #${booking.bookingNumber}`,
      }, {
        idempotencyKey: transferIdempotencyKey
      });
    } catch (transferError: any) {
      // Capture succeeded but transfer failed — record the state for manual recovery
      console.error(`Transfer FAILED after capture for booking ${booking._id}:`, transferError.message);

      // A network error or HTTP 5xx can happen after Stripe actually created the
      // transfer. For those ambiguous outcomes keep the same attempt number and
      // idempotency key so a retry replays the original request instead of
      // creating a duplicate transfer. Only definitive rejections rotate the key.
      const ambiguousTransferFailure = isAmbiguousTransferError(transferError);
      const failedTransferAttempt = ambiguousTransferFailure
        ? (booking.payment.transferAttempt || 0)
        : (booking.payment.transferAttempt || 0) + 1;
      booking.payment.status = 'completed'; // Money is captured; transfer remains recoverable.
      booking.payment.transferStatus = 'failed';
      booking.payment.transferAttempt = failedTransferAttempt;
      if (!ambiguousTransferFailure) {
        booking.payment.transferIdempotencyKey = undefined;
      }
      booking.payment.transferFailureReason = 'Professional transfer failed. Review the payment in the payment provider and retry the transfer.';
      booking.payment.transferAttemptedAt = new Date();
      booking.payment.refundNotes = 'Transfer failed after capture. Funds are held in the platform account.';
      await booking.save();

      await Payment.findOneAndUpdate(
        { booking: booking._id },
        buildPaymentUpsertBase(booking, {
          status: 'completed',
          transferStatus: 'failed',
          transferAttempt: failedTransferAttempt,
          transferIdempotencyKey: ambiguousTransferFailure
            ? booking.payment.transferIdempotencyKey
            : undefined,
          transferFailureReason: 'Professional transfer failed. Review the payment in the payment provider and retry the transfer.',
          transferAttemptedAt: booking.payment.transferAttemptedAt,
          capturedAt: booking.payment.capturedAt,
          stripeChargeId: booking.payment.stripeChargeId,
          metadata: {
            transferFailed: true,
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
          message: 'Payment captured but transfer to professional failed. Retry the transfer after correcting the issue.'
        }
      };
    }

    console.log(`Transfer created for booking ${booking._id}: ${transfer.id}`);

    // Update booking with full completion
    booking.payment.status = 'completed';
    booking.payment.stripeTransferId = transfer.id;
    booking.payment.stripeDestinationPayment = transfer.destination_payment as string;
    booking.payment.transferCurrency = transferCurrency.toUpperCase();
    booking.payment.transferAmount = transferAmount;
    booking.payment.transferStatus = 'succeeded';
    booking.payment.transferFailureReason = undefined;
    booking.payment.transferAttemptedAt = new Date();
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
        transferStatus: 'succeeded',
        transferIdempotencyKey,
        transferFailureReason: undefined,
        transferAttemptedAt: booking.payment.transferAttemptedAt,
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
        message: "We couldn't complete the payment. Check the payment status before retrying."
      }
    };
  }
};

/**
 * Reusable refund core. Throws RefundError on validation/state failures so callers
 * can map to HTTP responses or other flows (e.g., admin-approved cancellation).
 */
export class RefundError extends Error {
  constructor(public code: string, message: string, public httpStatus: number = 400) {
    super(message);
  }
}

export interface RefundResult {
  refundId: string;
  amount: number;
  status?: string;
  refundSource: 'platform' | 'professional' | 'mixed';
}

export const executeRefund = async (
  bookingId: string,
  opts: { amount?: number; reason?: string; actorId?: string | mongoose.Types.ObjectId | null }
): Promise<RefundResult> => {
  const { amount, reason } = opts;
  const refundActorId = opts.actorId && mongoose.Types.ObjectId.isValid(String(opts.actorId))
    ? new mongoose.Types.ObjectId(String(opts.actorId))
    : undefined;

  if (typeof bookingId !== 'string' || !bookingId.trim() || !mongoose.Types.ObjectId.isValid(bookingId)) {
    throw new RefundError('INVALID_BOOKING_ID', 'bookingId must be a valid non-empty ID');
  }

  let normalizedAmount: number | undefined;
  if (amount !== undefined && amount !== null) {
    const parsedAmount = typeof amount === 'string' ? Number.parseFloat(amount as any) : Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new RefundError('INVALID_AMOUNT', 'amount must be a number greater than 0');
    }
    normalizedAmount = parsedAmount;
  }

  const booking = await Booking.findById(bookingId).populate('professional');
  if (!booking) {
    throw new RefundError('BOOKING_NOT_FOUND', 'Booking not found', 404);
  }

  if (!booking.payment?.stripePaymentIntentId) {
    throw new RefundError('NO_PAYMENT', 'No payment to refund');
  }

  const totalWithVat = booking.payment?.totalWithVat ?? 0;
  const roundMoneyLocal = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

  // Cash already returned by every actual refund on this base PaymentIntent:
  // booking-price refunds AND negative extra-cost refunds share the same
  // charge. The booking aggregate is only a booking-price fact, so it is
  // reduced by booking-kind rows (never by extra rows) to avoid double count.
  // Milestone/other Payment rows are excluded by loadBasePaymentRows.
  const basePaymentRows = await loadBasePaymentRows(
    booking,
    booking.payment.stripePaymentIntentId,
  );
  const baseRefunds = summarizeBaseRefunds(basePaymentRows);
  const existingBookingRefunds = baseRefunds.refunds.filter(
    (refund: any) => refund?.kind !== 'extra_cost',
  );
  const aggregateRefundTotal = Number(booking.payment?.refundAmount);
  const aggregateBookingRefund = Number.isFinite(aggregateRefundTotal) && aggregateRefundTotal > 0
    ? roundMoneyLocal(aggregateRefundTotal)
    : 0;
  const aggregateResidual = Math.max(
    0,
    roundMoneyLocal(aggregateBookingRefund - baseRefunds.bookingTotal),
  );
  const previousBookingRefundTotal = roundMoneyLocal(baseRefunds.bookingTotal + aggregateResidual);
  // Refundable capacity must include extra-cost refunds because Stripe will
  // reject a later refund that would take the charge above its original
  // amount. Booking totals/status below still use only booking-price facts.
  const previousRefundTotal = roundMoneyLocal(baseRefunds.allTotal + aggregateResidual);
  const remainingRefundable = Math.max(0, roundMoneyLocal(totalWithVat - previousRefundTotal));
  if (remainingRefundable <= 0) {
    throw new RefundError(
      'REFUND_EXCEEDS_TOTAL',
      `No refundable amount remaining. Already refunded: ${previousRefundTotal}, original: ${totalWithVat}`
    );
  }
  if (normalizedAmount && normalizedAmount > remainingRefundable) {
    throw new RefundError(
      'REFUND_EXCEEDS_TOTAL',
      `Refund of ${normalizedAmount} would exceed remaining refundable. Already refunded: ${previousRefundTotal}, original: ${totalWithVat}`
    );
  }
  const refundAmount = normalizedAmount ?? remainingRefundable;
  const refundIntentVersion = normalizedAmount
    ? `partial-${booking.payment.stripePaymentIntentId}-${previousRefundTotal}-${normalizedAmount}`
    : `full-${booking.payment.stripePaymentIntentId}-${previousRefundTotal}`;
  // The only stored authoritative split is the payment-level net/VAT. When
  // earlier partial refunds each recorded their split, the remaining split is
  // arithmetic over those recorded facts. Never proportionally invent a split
  // for a legacy/partial row: an unknown earlier split suppresses the copy.
  // Extra-cost refunds are excluded from this booking VAT arithmetic.
  const refundVatSplit: { netAmount?: number; vatAmount?: number; vatRate?: number } = (() => {
    if (Math.abs(refundAmount - remainingRefundable) >= 0.01) return {};
    if (typeof booking.payment.netAmount !== 'number' || typeof booking.payment.vatAmount !== 'number') {
      return {};
    }
    if (previousRefundTotal <= 0.005) {
      return {
        netAmount: booking.payment.netAmount,
        vatAmount: booking.payment.vatAmount,
        ...(typeof booking.payment.vatRate === 'number' ? { vatRate: booking.payment.vatRate } : {}),
      };
    }
    const priorSplitsRecorded = existingBookingRefunds.every(
      (refund: any) => typeof refund.netAmount === 'number' && typeof refund.vatAmount === 'number',
    );
    if (!priorSplitsRecorded) return {};
    const priorNet = existingBookingRefunds.reduce(
      (sum: number, refund: any) => sum + Number(refund.netAmount),
      0,
    );
    const priorVat = existingBookingRefunds.reduce(
      (sum: number, refund: any) => sum + Number(refund.vatAmount),
      0,
    );
    const remainingNet = roundMoneyLocal(booking.payment.netAmount - priorNet);
    const remainingVat = roundMoneyLocal(booking.payment.vatAmount - priorVat);
    if (remainingNet < -0.005 || remainingVat < -0.005) return {};
    if (Math.abs(remainingNet + remainingVat - refundAmount) > 0.02) return {};
    return {
      netAmount: Math.max(0, remainingNet),
      vatAmount: Math.max(0, remainingVat),
      ...(typeof booking.payment.vatRate === 'number' ? { vatRate: booking.payment.vatRate } : {}),
    };
  })();

  if (booking.payment.status === 'authorized') {
    const refund = await stripe.refunds.create(
      {
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, booking.payment.currency || 'EUR'),
        metadata: {
          bookingId: booking._id.toString(),
          refundKind: 'booking',
        },
      },
      {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'refund',
          version: refundIntentVersion,
        }),
      }
    );

    const isPartial = !!normalizedAmount && normalizedAmount < remainingRefundable;
    const refundCreatedAt = typeof (refund as any).created === 'number'
      ? new Date((refund as any).created * 1000)
      : new Date();
    booking.payment.status = isPartial ? 'partially_refunded' : 'refunded';
    booking.payment.refundedAt = refundCreatedAt;
    // The booking aggregate is a booking-price fact; extra-cost refunds stay
    // out of it even though they reduced the cash refundable capacity above.
    booking.payment.refundAmount = roundMoneyLocal(previousBookingRefundTotal + refundAmount);
    booking.payment.refundReason = reason;
    booking.payment.refundSource = 'platform';
    if (!isPartial) {
      booking.status = 'cancelled';
    } else if (isPreCompletionStatus(booking.status)) {
      // A partial refund ends the booking as well: only the remaining amount
      // stays billable, so the booking must read 'cancelled', not 'Booked'.
      // Paths that manage the status themselves (dispute 'refunded', already
      // terminal states) are left untouched.
      booking.status = 'cancelled';
    }
    await booking.save();

    await recordBasePaymentRefund({
      booking,
      set: {
        status: booking.payment.status,
        refundedAt: booking.payment.refundedAt,
      },
      refund: {
        amount: refundAmount,
        reason,
        refundId: refund.id,
        refundedAt: refundCreatedAt,
        source: 'platform',
        notes: 'Refund issued before transfer to professional',
        kind: 'booking',
        status: refund.status || undefined,
        ...(refundActorId ? { refundedBy: refundActorId } : {}),
        ...refundVatSplit,
      },
    });

    console.log(`✅ Payment refunded for booking ${booking._id}: ${refund.id}`);

    return { refundId: refund.id, amount: refundAmount, status: refund.status || undefined, refundSource: 'platform' };
  }

  if (['completed', 'partially_refunded', 'captured'].includes(String(booking.payment.status))) {
    const refund = await stripe.refunds.create(
      {
        payment_intent: booking.payment.stripePaymentIntentId,
        amount: convertToStripeAmount(refundAmount, booking.payment.currency || 'EUR'),
        metadata: {
          bookingId: booking._id.toString(),
          refundKind: 'booking',
        },
      },
      {
        idempotencyKey: generateIdempotencyKey({
          bookingId: booking._id.toString(),
          operation: 'refund',
          version: refundIntentVersion,
        }),
      }
    );

    if (booking.payment.stripeTransferId) {
      try {
        const reversalCurrency =
          booking.payment.transferCurrency || booking.payment.currency || 'EUR';
        const storedTransferAmount = booking.payment.transferAmount;
        let reversalMinorAmount: number | undefined;
        if (typeof storedTransferAmount === 'number' && storedTransferAmount > 0 && totalWithVat > 0) {
          if (normalizedAmount && normalizedAmount < totalWithVat) {
            reversalMinorAmount = Math.min(
              storedTransferAmount,
              Math.max(1, Math.round(storedTransferAmount * (normalizedAmount / totalWithVat)))
            );
          } else {
            reversalMinorAmount = storedTransferAmount;
          }
        } else if (normalizedAmount) {
          reversalMinorAmount = convertToStripeAmount(normalizedAmount, reversalCurrency);
        }
        await stripe.transfers.createReversal(booking.payment.stripeTransferId, {
          amount: reversalMinorAmount,
          metadata: { reason: reason || '', bookingId: booking._id.toString() },
        });
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
      normalizedAmount && normalizedAmount < remainingRefundable ? 'partially_refunded' : 'refunded';
    const refundCreatedAt = typeof (refund as any).created === 'number'
      ? new Date((refund as any).created * 1000)
      : new Date();
    booking.payment.refundedAt = refundCreatedAt;
    // Keep the historical aggregate limited to booking-price refunds.
    booking.payment.refundAmount = roundMoneyLocal(previousBookingRefundTotal + refundAmount);
    booking.payment.refundReason = reason;
    if (booking.payment.status === 'refunded') {
      booking.status = 'refunded';
    } else if (isPreCompletionStatus(booking.status)) {
      // Partial refund on a live booking: the remainder stays billable, so the
      // booking must read 'cancelled' instead of staying open.
      booking.status = 'cancelled';
    }
    await booking.save();

    await recordBasePaymentRefund({
      booking,
      set: {
        status: booking.payment.status,
        refundedAt: booking.payment.refundedAt,
      },
      refund: {
        amount: refundAmount,
        reason,
        refundId: refund.id,
        refundedAt: refundCreatedAt,
        source: booking.payment.refundSource || 'platform',
        notes: booking.payment.refundNotes,
        kind: 'booking',
        status: refund.status || undefined,
        ...(refundActorId ? { refundedBy: refundActorId } : {}),
        ...refundVatSplit,
      },
    });

    console.log(`✅ Refund processed for booking ${booking._id}: ${refund.id}`);

    return {
      refundId: refund.id,
      amount: refundAmount,
      status: refund.status || undefined,
      refundSource: booking.payment.refundSource || 'platform',
    };
  }

  throw new RefundError('INVALID_STATUS', 'Payment cannot be refunded in current status');
};

export interface ExtraCostRefundFact {
  refundId: string;
  amount: number;
  status?: string;
  refundedAt?: Date;
  obligationId?: string;
  reason?: string;
  notes?: string;
}

/**
 * Persist one actual extra-cost refund fact (created here or reconciled from
 * the provider). The ledger write dedupes by provider refund id.
 */
export const recordExtraCostRefundFact = async (params: {
  booking: any;
  fact: ExtraCostRefundFact;
  actorId?: string | mongoose.Types.ObjectId | null;
}): Promise<void> => {
  const { booking, fact } = params;
  if (!fact?.refundId) return;
  const refundActorId = params.actorId && mongoose.Types.ObjectId.isValid(String(params.actorId))
    ? new mongoose.Types.ObjectId(String(params.actorId))
    : undefined;
  await recordBasePaymentRefund({
    booking,
    refund: {
      amount: fact.amount,
      ...(fact.reason ? { reason: fact.reason } : {}),
      refundId: fact.refundId,
      refundedAt: fact.refundedAt || new Date(),
      source: 'platform',
      notes: fact.notes || 'Refund of unused negative extra-cost work; recorded separately from booking-price refunds.',
      kind: 'extra_cost',
      ...(fact.status ? { status: fact.status as any } : {}),
      ...(fact.obligationId ? { obligationId: fact.obligationId } : {}),
      ...(refundActorId ? { refundedBy: refundActorId } : {}),
    },
  });
};

/**
 * Refund a negative extra-cost adjustment against the base PaymentIntent.
 *
 * This is deliberately not a booking-price refund: it must carry the
 * `refundKind:"extra_cost"` provider metadata (so webhooks classify it
 * correctly) and write a `kind:"extra_cost"` ledger row, but it must never
 * change booking.payment.status/refundAmount or the booking VAT split. Both
 * the customer-confirmation and automatic-acceptance completion paths use
 * this one operation.
 *
 * `obligationId` is the logical completion-refund identity carried in provider
 * metadata so a later reconciliation can recognise this obligation without
 * relying on the provider's finite idempotency-key window.
 */
export const refundExtraCostAdjustment = async (params: {
  booking: any;
  amount: number;
  reason: string;
  actorId?: string | mongoose.Types.ObjectId | null;
  obligationId?: string;
  attempt?: number;
  claimId?: string;
}): Promise<{ refundId: string; amount: number; status?: string }> => {
  const { booking, reason } = params;
  const paymentIntentId = booking?.payment?.stripePaymentIntentId;
  if (!paymentIntentId) {
    throw new RefundError('NO_PAYMENT', 'No payment to refund');
  }
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RefundError('INVALID_AMOUNT', 'extra-cost refund amount must be greater than 0');
  }
  const currency = (booking.payment.currency || 'EUR').toLowerCase();
  const amountMinor = convertToStripeAmount(amount, currency);
  const obligationId = typeof params.obligationId === 'string' && params.obligationId.trim()
    ? params.obligationId.trim()
    : undefined;
  const attempt = Number(params.attempt) > 0 ? Math.floor(Number(params.attempt)) : 0;
  // A legacy marker without an obligation id keeps the historical key; new
  // obligations include their logical id. A retry after a recorded
  // failed/canceled refund needs a distinct key because the provider would
  // otherwise replay the failed refund forever; reconciliation must have
  // proven no successful/pending refund exists before this version is used.
  const baseVersion = obligationId
    ? `${paymentIntentId}:${amountMinor}:${obligationId}`
    : `${paymentIntentId}:${amountMinor}`;
  const keyVersion = attempt > 0 ? `${baseVersion}:retry-${attempt}` : baseVersion;

  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: amountMinor,
      metadata: {
        bookingId: booking._id.toString(),
        refundKind: 'extra_cost',
        ...(obligationId ? { obligationId } : {}),
      },
    },
    {
      idempotencyKey: generateIdempotencyKey({
        bookingId: booking._id.toString(),
        operation: 'unit-underuse-refund',
        version: keyVersion,
      }),
    },
  );

  const refundCreatedAt = typeof (refund as any).created === 'number'
    ? new Date((refund as any).created * 1000)
    : new Date();

  // Persist the accepted provider id on the fenced marker before the ledger
  // write. If the write fails, the retry can retrieve this exact refund instead
  // of guessing or creating another one.
  if (params.claimId) {
    await Booking.updateOne(
      {
        _id: booking._id,
        'payment.extraCostRefundPending.amount': { $gt: 0 },
        'payment.extraCostRefundPending.claimId': params.claimId,
      },
      {
        $set: {
          'payment.extraCostRefundPending.providerRefundId': refund.id,
          ...(obligationId ? { 'payment.extraCostRefundPending.obligationId': obligationId } : {}),
        },
      },
    ).catch(() => undefined);
  }

  await recordExtraCostRefundFact({
    booking,
    fact: {
      refundId: refund.id,
      amount,
      status: refund.status || undefined,
      refundedAt: refundCreatedAt,
      obligationId,
      reason,
    },
    actorId: params.actorId,
  });

  console.log(`✅ Extra-cost adjustment refunded for booking ${booking._id}: ${refund.id}`);
  return { refundId: refund.id, amount, status: refund.status || undefined };
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

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    const user = await User.findById(userId);
    const isAuthorized = user?.role === 'admin' || booking.customer.toString() === userId;
    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to refund' }
      });
    }

    const result = await executeRefund(bookingId, { amount, reason, actorId: userId });

    // A partial refund on a live booking closes it with a billable remainder:
    // generate the FIX/SUP invoices from the remaining amount when missing.
    try {
      const refreshed = await Booking.findById(bookingId).select('payment.status payment.totalWithVat');
      if (refreshed?.payment?.status === 'partially_refunded') {
        const { ensureRefundInvoices } = await import('../../utils/refundFinalization');
        void ensureRefundInvoices(bookingId);
      }
    } catch (invoiceTriggerError: any) {
      console.error(`Refund invoice trigger failed for booking ${bookingId}:`, invoiceTriggerError?.message || invoiceTriggerError);
    }

    if (user?.role === 'admin') {
      await auditLog({
        req,
        action: 'admin.payment.refund',
        targetType: 'Booking',
        targetId: bookingId,
        details: {
          refundId: result.refundId,
          amount: result.amount,
          status: result.status,
          refundSource: result.refundSource,
          reason,
          requestedAmount: typeof amount === 'number' ? amount : undefined,
        },
        status: 'success',
        statusCode: 200,
      });
    }

    return res.json({
      success: true,
      data: {
        refundId: result.refundId,
        amount: result.amount,
        status: result.status,
        refundSource: result.refundSource,
      },
    });
  } catch (error: any) {
    if (error instanceof RefundError) {
      const userRole = (req as any).user?.role;
      if (userRole === 'admin') {
        await auditLog({
          req,
          action: 'admin.payment.refund',
          targetType: 'Booking',
          targetId: req.body?.bookingId,
          status: 'failure',
          statusCode: error.httpStatus,
          errorMessage: `${error.code}: ${error.message}`,
        });
      }
      return res.status(error.httpStatus).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
    }
    console.error('Error processing refund:', error);
    const userRole = (req as any).user?.role;
    if (userRole === 'admin') {
      await auditLog({
        req,
        action: 'admin.payment.refund',
        targetType: 'Booking',
        targetId: req.body?.bookingId,
        status: 'failure',
        statusCode: 500,
        errorMessage: error?.message || 'unknown',
      });
    }
    res.status(500).json({
      success: false,
      error: { code: 'STRIPE_ERROR', message: "We couldn't process the refund. Check the payment status before retrying." }
    });
  }
};
