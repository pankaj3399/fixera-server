/**
 * Discount Calculation System for Fixera
 *
 * Two discount sources that stack additively:
 * 1. Platform Loyalty Discount — based on customer's loyalty tier (absorbed by platform)
 * 2. Professional Repeat-Buyer Discount — set by professional per project (absorbed by professional)
 */

import mongoose from 'mongoose';
import LoyaltyConfig, { ILoyaltyTier } from '../models/loyaltyConfig';
import Booking from '../models/booking';
import Project from '../models/project';
import User from '../models/user';

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

const MINIMUM_PAYMENT_AMOUNT = 0.50; // Stripe minimum in EUR

export interface IDiscountBreakdown {
  loyaltyDiscount: {
    tierName: string;
    percentage: number;
    amount: number;
    absorbedBy: 'platform';
  };
  repeatBuyerDiscount: {
    percentage: number;
    amount: number;
    completedBookings: number;
    absorbedBy: 'professional';
  };
  totalDiscount: number;
  originalAmount: number;
  discountedAmount: number;
}

/**
 * Calculate the loyalty tier discount for a customer
 */
async function calculateLoyaltyDiscount(
  customerId: string | mongoose.Types.ObjectId,
  quoteAmount: number
): Promise<{ tierName: string; percentage: number; amount: number }> {
  const config = await LoyaltyConfig.getCurrentConfig();

  if (!config.globalSettings.isEnabled) {
    return { tierName: '', percentage: 0, amount: 0 };
  }

  const customer = await User.findById(customerId).select('loyaltyLevel');
  if (!customer || !customer.loyaltyLevel) {
    return { tierName: 'Bronze', percentage: 0, amount: 0 };
  }

  const tier = config.tiers.find(
    (t: ILoyaltyTier) => t.name === customer.loyaltyLevel && t.isActive
  );

  if (!tier || !tier.discountPercentage || tier.discountPercentage === 0) {
    return { tierName: customer.loyaltyLevel || 'Bronze', percentage: 0, amount: 0 };
  }

  let discountAmount = roundToTwo((quoteAmount * tier.discountPercentage) / 100);

  // Apply cap if configured
  if (tier.maxDiscountAmount && discountAmount > tier.maxDiscountAmount) {
    discountAmount = tier.maxDiscountAmount;
  }

  return {
    tierName: tier.name,
    percentage: tier.discountPercentage,
    amount: discountAmount,
  };
}

/**
 * Calculate the repeat-buyer discount for a customer with a specific professional
 */
async function calculateRepeatBuyerDiscount(
  customerId: string | mongoose.Types.ObjectId,
  professionalId: string | mongoose.Types.ObjectId,
  projectId: string | mongoose.Types.ObjectId | undefined,
  quoteAmount: number
): Promise<{ percentage: number; amount: number; completedBookings: number }> {
  if (!projectId) {
    return { percentage: 0, amount: 0, completedBookings: 0 };
  }

  const project = await Project.findById(projectId).select('repeatBuyerDiscount professionalId');
  if (!project || !project.repeatBuyerDiscount?.enabled) {
    return { percentage: 0, amount: 0, completedBookings: 0 };
  }

  // Count completed bookings this customer has with this professional
  const completedBookings = await Booking.countDocuments({
    customer: customerId,
    professional: professionalId,
    status: 'completed',
  });

  if (completedBookings < project.repeatBuyerDiscount.minPreviousBookings) {
    return { percentage: 0, amount: 0, completedBookings };
  }

  const percentage = project.repeatBuyerDiscount.percentage;
  let discountAmount = roundToTwo((quoteAmount * percentage) / 100);

  // Apply cap if configured
  if (project.repeatBuyerDiscount.maxDiscountAmount && discountAmount > project.repeatBuyerDiscount.maxDiscountAmount) {
    discountAmount = project.repeatBuyerDiscount.maxDiscountAmount;
  }

  return {
    percentage,
    amount: discountAmount,
    completedBookings,
  };
}

/**
 * Calculate the full discount breakdown for a booking
 */
export async function calculateDiscountBreakdown(
  customerId: string | mongoose.Types.ObjectId,
  professionalId: string | mongoose.Types.ObjectId,
  projectId: string | mongoose.Types.ObjectId | undefined,
  quoteAmount: number
): Promise<IDiscountBreakdown> {
  const [loyaltyResult, repeatResult] = await Promise.all([
    calculateLoyaltyDiscount(customerId, quoteAmount),
    calculateRepeatBuyerDiscount(customerId, professionalId, projectId, quoteAmount),
  ]);

  const totalDiscount = roundToTwo(loyaltyResult.amount + repeatResult.amount);
  let discountedAmount = roundToTwo(quoteAmount - totalDiscount);

  // Ensure minimum payment threshold
  if (discountedAmount < MINIMUM_PAYMENT_AMOUNT) {
    discountedAmount = MINIMUM_PAYMENT_AMOUNT;
  }

  return {
    loyaltyDiscount: {
      tierName: loyaltyResult.tierName,
      percentage: loyaltyResult.percentage,
      amount: loyaltyResult.amount,
      absorbedBy: 'platform',
    },
    repeatBuyerDiscount: {
      percentage: repeatResult.percentage,
      amount: repeatResult.amount,
      completedBookings: repeatResult.completedBookings,
      absorbedBy: 'professional',
    },
    totalDiscount: roundToTwo(quoteAmount - discountedAmount),
    originalAmount: quoteAmount,
    discountedAmount,
  };
}

/**
 * Calculate how the discount affects commission and professional payout.
 *
 * Hybrid model:
 * - Platform absorbs loyalty discount → professional gets full payout as if no loyalty discount
 * - Professional absorbs repeat-buyer discount → professional payout reduced by their discount
 *
 * Customer pays: originalAmount - totalDiscount
 * Platform commission: calculated on (originalAmount - repeatBuyerDiscount) then minus loyaltyDiscount
 * Professional payout: calculated on (originalAmount - repeatBuyerDiscount)
 */
export function calculateDiscountedPayouts(
  discount: IDiscountBreakdown,
  commissionPercent: number
): {
  customerPays: number;
  platformCommission: number;
  professionalPayout: number;
} {
  const { originalAmount, discountedAmount, loyaltyDiscount, repeatBuyerDiscount } = discount;

  // The amount the professional's world sees (before platform commission)
  // = original amount minus the repeat-buyer discount they offered
  const professionalBaseAmount = roundToTwo(originalAmount - repeatBuyerDiscount.amount);

  // Platform commission is on the professional's base amount
  const platformCommissionOnBase = roundToTwo((professionalBaseAmount * commissionPercent) / 100);

  // Professional payout = their base amount minus commission
  const professionalPayout = roundToTwo(professionalBaseAmount - platformCommissionOnBase);

  // Platform commission after absorbing loyalty discount
  // Platform earns: platformCommissionOnBase - loyaltyDiscount.amount
  const platformCommission = roundToTwo(platformCommissionOnBase - loyaltyDiscount.amount);

  return {
    customerPays: discountedAmount,
    platformCommission: Math.max(0, platformCommission),
    professionalPayout: Math.max(0, professionalPayout),
  };
}
