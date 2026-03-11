/**
 * Discount Engine
 * Calculates auto-applied discounts based on loyalty tier and repeat-buyer settings
 */

import LoyaltyConfig from '../models/loyaltyConfig';
import Booking from '../models/booking';
import Project from '../models/project';
import { getCurrentTier } from './loyaltySystemV2';

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
      const tier = getCurrentTier(config.tiers, customerTotalSpent);
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
  } catch (error) {
    console.error('Discount Engine: Failed to calculate loyalty discount:', error);
    throw error;
  }

  // 2. Calculate repeat-buyer discount
  let repeatBuyerDiscount: RepeatBuyerDiscountInfo = { ...emptyRepeat };
  if (projectId) {
    try {
      const project = await Project.findById(projectId);

      if (project?.repeatBuyerDiscount?.enabled && project.repeatBuyerDiscount.percentage > 0) {
        // Count completed bookings between this customer and professional
        const previousBookings = await Booking.countDocuments({
          customer: customerId,
          professional: professionalId,
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
    } catch (error) {
      console.error('Discount Engine: Failed to calculate repeat-buyer discount:', error);
      throw error;
    }
  }

  // 3. Combine discounts (additive)
  const totalDiscount = roundToTwo(loyaltyDiscount.amount + repeatBuyerDiscount.amount);
  const finalAmount = roundToTwo(Math.max(0, quoteAmount - totalDiscount));

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
