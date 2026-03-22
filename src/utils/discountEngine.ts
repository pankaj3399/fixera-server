/**
 * Discount Engine
 * Calculates auto-applied discounts based on loyalty tier and repeat-buyer settings
 */

import LoyaltyConfig from '../models/loyaltyConfig';
import Booking from '../models/booking';
import Project from '../models/project';
import { getCurrentTier } from './loyaltySystem';

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

export interface DiscountBreakdown {
  loyaltyDiscount: LoyaltyDiscountInfo;
  repeatBuyerDiscount: RepeatBuyerDiscountInfo;
  totalDiscount: number;
  originalAmount: number;
  finalAmount: number;
}

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
 *
 * Customer pays: originalAmount - totalDiscount
 * Platform commission: calculated on (originalAmount - repeatBuyerDiscount) then minus loyaltyDiscount
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
  const { originalAmount, finalAmount, loyaltyDiscount, repeatBuyerDiscount } = discount;

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
    customerPays: finalAmount,
    platformCommission: Math.max(0, platformCommission),
    professionalPayout: Math.max(0, professionalPayout),
  };
}

/**
 * Calculate auto-discount for a booking based on loyalty tier and repeat-buyer config
 */
export const calculateAutoDiscount = async (
  customerId: string,
  professionalId: string,
  projectId: string | null,
  quoteAmount: number,
  customerTotalSpent: number
): Promise<DiscountBreakdown> => {
  const emptyLoyalty: LoyaltyDiscountInfo = { percentage: 0, amount: 0, tier: 'Bronze', capped: false };
  const emptyRepeat: RepeatBuyerDiscountInfo = { percentage: 0, amount: 0, previousBookings: 0, capped: false };

  if (quoteAmount <= 0) {
    return {
      loyaltyDiscount: emptyLoyalty,
      repeatBuyerDiscount: emptyRepeat,
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
        // Use the project's own professionalId for the booking count
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

  // 3. Combine discounts (additive)
  const rawTotal = roundToTwo(loyaltyDiscount.amount + repeatBuyerDiscount.amount);
  let finalAmount = roundToTwo(Math.max(MINIMUM_PAYMENT_AMOUNT, quoteAmount - rawTotal));

  // If clamped to minimum, reconcile component amounts proportionally
  let totalDiscount = roundToTwo(quoteAmount - finalAmount);
  if (totalDiscount < rawTotal && rawTotal > 0) {
    const scale = totalDiscount / rawTotal;
    loyaltyDiscount.amount = roundToTwo(loyaltyDiscount.amount * scale);
    repeatBuyerDiscount.amount = roundToTwo(repeatBuyerDiscount.amount * scale);
    // Ensure rounding doesn't drift
    totalDiscount = roundToTwo(loyaltyDiscount.amount + repeatBuyerDiscount.amount);
    finalAmount = roundToTwo(quoteAmount - totalDiscount);
  }

  if (totalDiscount > 0) {
    console.log(
      `💰 Discount Engine: Quote €${quoteAmount} → ` +
      `Loyalty (${loyaltyDiscount.tier} ${loyaltyDiscount.percentage}%): -€${loyaltyDiscount.amount} | ` +
      `Repeat (${repeatBuyerDiscount.percentage}%): -€${repeatBuyerDiscount.amount} | ` +
      `Total discount: -€${totalDiscount} → Final: €${finalAmount}`
    );
  }

  return {
    loyaltyDiscount,
    repeatBuyerDiscount,
    totalDiscount,
    originalAmount: quoteAmount,
    finalAmount,
  };
};
