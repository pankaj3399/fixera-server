/**
 * Discount Engine
 * Calculates auto-applied discounts based on loyalty tier, repeat-buyer settings, and points redemption
 */

import LoyaltyConfig from '../models/loyaltyConfig';
import Booking from '../models/booking';
import Project from '../models/project';
import PointsConfig from '../models/pointsConfig';
import User from '../models/user';
import DiscountCode from '../models/discountCode';
import DiscountCodeUsage from '../models/discountCodeUsage';
import { getCurrentTier } from './loyaltySystem';
import mongoose from 'mongoose';

export interface LoyaltyDiscountInfo {
  percentage: number;
  amount: number;
  tier: string;
  capped: boolean;
}

export interface RepeatBuyerDiscountInfo {
  percentage: number;
  amount: number;
  previousBookings: number;
  capped: boolean;
}

export interface PointsDiscountInfo {
  pointsUsed: number;
  discountAmount: number;
  conversionRate: number;
}

export interface CodeDiscountInfo {
  code: string;
  codeId: string;
  type: 'percentage' | 'fixed';
  value: number;
  amount: number;
}

export interface DiscountBreakdown {
  loyaltyDiscount: LoyaltyDiscountInfo;
  repeatBuyerDiscount: RepeatBuyerDiscountInfo;
  pointsDiscount: PointsDiscountInfo;
  codeDiscount?: CodeDiscountInfo;
  totalDiscount: number;
  originalAmount: number;
  finalAmount: number;
}

export interface CodeValidationResult {
  ok: boolean;
  error?: string;
  info?: CodeDiscountInfo;
}

export const validateDiscountCode = async (
  codeString: string,
  customerId: string,
  bookingAmount: number,
  customerCountry?: string,
  bookingService?: string
): Promise<CodeValidationResult> => {
  if (!codeString || typeof codeString !== 'string') {
    return { ok: false, error: 'Code is required' };
  }

  const normalized = codeString.trim().toUpperCase();
  const code = await DiscountCode.findOne({ code: normalized });
  if (!code) return { ok: false, error: 'Invalid code' };

  if (!code.isActive) return { ok: false, error: 'This code is no longer active' };

  const now = new Date();
  if (now < code.validFrom) return { ok: false, error: 'This code is not yet valid' };
  if (now > code.validUntil) return { ok: false, error: 'This code has expired' };

  if (code.minBookingAmount && bookingAmount < code.minBookingAmount) {
    return { ok: false, error: `Minimum booking amount is €${code.minBookingAmount}` };
  }

  if (code.usageLimit && code.usageCount >= code.usageLimit) {
    return { ok: false, error: 'This code has reached its usage limit' };
  }

  if (code.activeCountries.length > 0) {
    if (!customerCountry || !code.activeCountries.includes(customerCountry.toUpperCase())) {
      return { ok: false, error: 'This code is not valid in your region' };
    }
  }

  if (code.applicableServices.length > 0) {
    if (!bookingService || !code.applicableServices.includes(bookingService)) {
      return { ok: false, error: 'This code does not apply to this service' };
    }
  }

  const userUsageCount = await DiscountCodeUsage.countDocuments({
    code: code._id,
    user: new mongoose.Types.ObjectId(customerId)
  });
  if (userUsageCount >= code.perUserLimit) {
    return { ok: false, error: 'You have already used this code' };
  }

  let amount = code.type === 'percentage'
    ? Math.round(bookingAmount * (code.value / 100) * 100) / 100
    : code.value;

  if (code.maxDiscountAmount && amount > code.maxDiscountAmount) {
    amount = code.maxDiscountAmount;
  }

  if (amount > bookingAmount) amount = bookingAmount;

  return {
    ok: true,
    info: {
      code: code.code,
      codeId: (code._id as mongoose.Types.ObjectId).toString(),
      type: code.type,
      value: code.value,
      amount
    }
  };
};

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;
const hasNumericCap = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const MINIMUM_PAYMENT_AMOUNT = 0.50; // Stripe minimum in EUR

/**
 * Calculate how the discount affects commission and professional payout.
 *
 * Hybrid model:
 * - Platform absorbs loyalty discount -> professional gets full payout as if no loyalty discount
 * - Professional absorbs repeat-buyer discount -> professional payout reduced by their discount
 * - Platform absorbs points discount -> same as loyalty, professional unaffected
 *
 * Customer pays: originalAmount - totalDiscount
 * Platform commission: calculated on (originalAmount - repeatBuyerDiscount) then minus loyaltyDiscount minus pointsDiscount
 * Professional payout: calculated on (originalAmount - repeatBuyerDiscount)
 */
export function calculateDiscountedPayouts(
  discount: DiscountBreakdown,
  commissionPercent: number
): {
  customerPays: number;
  platformCommission: number;
  professionalPayout: number;
} {
  const { originalAmount, finalAmount, loyaltyDiscount, repeatBuyerDiscount, pointsDiscount, codeDiscount } = discount;

  // The amount the professional's world sees (before platform commission)
  // = original amount minus the repeat-buyer discount they offered
  const professionalBaseAmount = roundToTwo(originalAmount - repeatBuyerDiscount.amount);

  // Platform commission is on the professional's base amount
  const platformCommissionOnBase = roundToTwo((professionalBaseAmount * commissionPercent) / 100);

  // Professional payout = their base amount minus commission
  const professionalPayout = roundToTwo(professionalBaseAmount - platformCommissionOnBase);

  const codeAmount = codeDiscount?.amount || 0;
  const platformAbsorbed = roundToTwo(loyaltyDiscount.amount + pointsDiscount.discountAmount + codeAmount);
  const platformCommission = roundToTwo(platformCommissionOnBase - platformAbsorbed);

  // When loyalty+points absorption exceeds the base commission, platform subsidizes
  // the difference. Keep accounting identity: customerPays = platformCommission + professionalPayout
  return {
    customerPays: finalAmount,
    platformCommission,
    professionalPayout,
  };
}

/**
 * Calculate auto-discount for a booking based on loyalty tier, repeat-buyer config, and optional points
 */
export const calculateAutoDiscount = async (
  customerId: string,
  professionalId: string,
  projectId: string | null,
  quoteAmount: number,
  customerTotalSpent: number,
  pointsToRedeem: number = 0,
  codeInfo: CodeDiscountInfo | null = null
): Promise<DiscountBreakdown> => {
  const emptyLoyalty: LoyaltyDiscountInfo = { percentage: 0, amount: 0, tier: 'Bronze', capped: false };
  const emptyRepeat: RepeatBuyerDiscountInfo = { percentage: 0, amount: 0, previousBookings: 0, capped: false };
  const emptyPoints: PointsDiscountInfo = { pointsUsed: 0, discountAmount: 0, conversionRate: 1 };

  if (quoteAmount <= 0) {
    return {
      loyaltyDiscount: emptyLoyalty,
      repeatBuyerDiscount: emptyRepeat,
      pointsDiscount: emptyPoints,
      totalDiscount: 0,
      originalAmount: quoteAmount,
      finalAmount: quoteAmount,
    };
  }

  // 1. Calculate loyalty tier discount
  let loyaltyDiscount: LoyaltyDiscountInfo = { ...emptyLoyalty };
  try {
    const config = await LoyaltyConfig.getCurrentConfig();

    if (config.globalSettings.isEnabled) {
      const activeTiers = config.tiers.filter(t => t.isActive);

      if (activeTiers.length > 0) {
        const tier = getCurrentTier(activeTiers, customerTotalSpent);
        loyaltyDiscount.tier = tier.name;

        const discountPct = tier.discountPercentage || 0;
        if (discountPct > 0) {
          let discountAmount = roundToTwo(quoteAmount * (discountPct / 100));
          let capped = false;

          if (hasNumericCap(tier.maxDiscountAmount) && discountAmount > tier.maxDiscountAmount) {
            discountAmount = tier.maxDiscountAmount;
            capped = true;
          }

          loyaltyDiscount = {
            percentage: discountPct,
            amount: discountAmount,
            tier: tier.name,
            capped,
          };
        }
      }
    }
  } catch (error) {
    console.error('Discount Engine: Failed to calculate loyalty discount:', error);
    throw error;
  }

  // 2. Calculate repeat-buyer discount
  let repeatBuyerDiscount: RepeatBuyerDiscountInfo = { ...emptyRepeat };
  if (projectId) {
    try {
      const project = await Project.findById(projectId).select('repeatBuyerDiscount professionalId');

      if (project?.repeatBuyerDiscount?.enabled && project.repeatBuyerDiscount.percentage > 0) {
        const projectProfessionalId = project.professionalId?.toString();
        if (!projectProfessionalId || projectProfessionalId !== professionalId) {
          // Professional doesn't own this project — skip repeat discount
        } else {
          const previousBookings = await Booking.countDocuments({
            customer: customerId,
            professional: projectProfessionalId,
            status: 'completed',
          });

          if (previousBookings >= project.repeatBuyerDiscount.minPreviousBookings) {
            let discountAmount = roundToTwo(quoteAmount * (project.repeatBuyerDiscount.percentage / 100));
            let capped = false;

            if (hasNumericCap(project.repeatBuyerDiscount.maxDiscountAmount) &&
                discountAmount > project.repeatBuyerDiscount.maxDiscountAmount) {
              discountAmount = project.repeatBuyerDiscount.maxDiscountAmount;
              capped = true;
            }

            repeatBuyerDiscount = {
              percentage: project.repeatBuyerDiscount.percentage,
              amount: discountAmount,
              previousBookings,
              capped,
            };
          }
        }
      }
    } catch (error) {
      console.error('Discount Engine: Failed to calculate repeat-buyer discount:', error);
      throw error;
    }
  }

  // 3. Calculate points discount
  let pointsDiscount: PointsDiscountInfo = { ...emptyPoints };
  if (pointsToRedeem > 0) {
    try {
      const pointsConfig = await PointsConfig.getCurrentConfig();
      pointsDiscount.conversionRate = pointsConfig.conversionRate;

      if (pointsConfig.isEnabled) {
        const user = await User.findById(customerId).select('points pointsExpiry');

        if (user && (user.points || 0) > 0) {
          // Check expiry
          const isExpired = user.pointsExpiry && new Date() > user.pointsExpiry;
          if (!isExpired) {
            const available = user.points || 0;
            let redeemable = Math.min(pointsToRedeem, available);

            if (redeemable >= pointsConfig.minRedemptionPoints) {
              let discountAmount = roundToTwo(redeemable * pointsConfig.conversionRate);

              // Will be clamped below with the total — just set for now
              pointsDiscount = {
                pointsUsed: redeemable,
                discountAmount,
                conversionRate: pointsConfig.conversionRate,
              };
            }
          }
        }
      }
    } catch (error) {
      console.error('Discount Engine: Failed to calculate points discount:', error);
      throw error;
    }
  }

  // 4. Attach code discount (pre-validated by caller via validateDiscountCode)
  let codeDiscount: CodeDiscountInfo | undefined = codeInfo ? { ...codeInfo } : undefined;

  // 5. Combine discounts (additive)
  const codeAmount = codeDiscount?.amount || 0;
  const rawTotal = roundToTwo(loyaltyDiscount.amount + repeatBuyerDiscount.amount + pointsDiscount.discountAmount + codeAmount);
  let finalAmount = roundToTwo(Math.max(MINIMUM_PAYMENT_AMOUNT, quoteAmount - rawTotal));

  // If clamped to minimum, reconcile component amounts proportionally
  let totalDiscount = roundToTwo(quoteAmount - finalAmount);
  if (totalDiscount < rawTotal && rawTotal > 0) {
    const scale = totalDiscount / rawTotal;
    loyaltyDiscount.amount = roundToTwo(loyaltyDiscount.amount * scale);
    repeatBuyerDiscount.amount = roundToTwo(repeatBuyerDiscount.amount * scale);
    pointsDiscount.discountAmount = roundToTwo(pointsDiscount.discountAmount * scale);
    if (codeDiscount) codeDiscount.amount = roundToTwo(codeDiscount.amount * scale);
    if (pointsDiscount.conversionRate > 0) {
      const scaledPoints = Math.floor(pointsDiscount.discountAmount / pointsDiscount.conversionRate);
      pointsDiscount.pointsUsed = Math.min(pointsDiscount.pointsUsed, scaledPoints);
    }
    totalDiscount = roundToTwo(
      loyaltyDiscount.amount + repeatBuyerDiscount.amount + pointsDiscount.discountAmount + (codeDiscount?.amount || 0)
    );
    finalAmount = roundToTwo(quoteAmount - totalDiscount);
  }

  if (totalDiscount > 0) {
    console.log(
      `Discount Engine: Quote €${quoteAmount} → ` +
      `Loyalty (${loyaltyDiscount.tier} ${loyaltyDiscount.percentage}%): -€${loyaltyDiscount.amount} | ` +
      `Repeat (${repeatBuyerDiscount.percentage}%): -€${repeatBuyerDiscount.amount} | ` +
      `Points (${pointsDiscount.pointsUsed}pts): -€${pointsDiscount.discountAmount} | ` +
      `Total discount: -€${totalDiscount} → Final: €${finalAmount}`
    );
  }

  return {
    loyaltyDiscount,
    repeatBuyerDiscount,
    pointsDiscount,
    codeDiscount,
    totalDiscount,
    originalAmount: quoteAmount,
    finalAmount,
  };
};
