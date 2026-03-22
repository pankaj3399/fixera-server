import User, { IUser } from "../models/user";
import LoyaltyConfig, { ILoyaltyTier } from "../models/loyaltyConfig";

type LoyaltyLevel = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
const VALID_LOYALTY_LEVELS: Set<string> = new Set(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);

function toValidLoyaltyLevel(level: string): LoyaltyLevel {
  if (VALID_LOYALTY_LEVELS.has(level)) {
    return level as LoyaltyLevel;
  }
  console.warn(`Loyalty: Unknown tier "${level}" — defaulting to Bronze`);
  return 'Bronze';
}

export interface LoyaltyCalculation {
  level: string;
  tierInfo: ILoyaltyTier;
  nextTier?: ILoyaltyTier;
  amountToNextTier?: number;
  progress?: number; // percentage to next tier
}

// Get current tier based on total spending amount
export const getCurrentTier = (tiers: ILoyaltyTier[], totalSpent: number): ILoyaltyTier => {
  const orderedTiers = tiers.slice().sort((a, b) => a.minSpendingAmount - b.minSpendingAmount);
  for (let i = orderedTiers.length - 1; i >= 0; i--) {
    if (totalSpent >= orderedTiers[i].minSpendingAmount) {
      return orderedTiers[i];
    }
  }
  return orderedTiers[0];
};

// Get next tier information
export const getNextTierInfo = (tiers: ILoyaltyTier[], totalSpent: number): {
  nextTier?: ILoyaltyTier;
  amountNeeded?: number;
  progress?: number;
} => {
  const orderedTiers = tiers.slice().sort((a, b) => a.minSpendingAmount - b.minSpendingAmount);
  const currentTier = getCurrentTier(orderedTiers, totalSpent);
  const currentIndex = orderedTiers.findIndex(tier => tier.name === currentTier.name);
  const nextTier = currentIndex < orderedTiers.length - 1 ? orderedTiers[currentIndex + 1] : null;

  if (!nextTier) {
    return {};
  }

  const amountNeeded = nextTier.minSpendingAmount - totalSpent;
  const progress = Math.min(100, Math.round((totalSpent / nextTier.minSpendingAmount) * 100));

  return { nextTier, amountNeeded, progress };
};

// Full loyalty calculation with tier info
export const calculateLoyaltyStatus = async (
  totalSpent: number = 0
): Promise<LoyaltyCalculation> => {
  try {
    const config = await LoyaltyConfig.getCurrentConfig();
    const activeTiers = config.tiers.filter(t => t.isActive !== false);
    const currentTier = getCurrentTier(activeTiers, totalSpent);
    const nextTierInfo = getNextTierInfo(activeTiers, totalSpent);

    return {
      level: currentTier.name,
      tierInfo: currentTier,
      nextTier: nextTierInfo.nextTier,
      amountToNextTier: nextTierInfo.amountNeeded,
      progress: nextTierInfo.progress
    };
  } catch (error) {
    console.error('Loyalty: Status calculation failed:', error);
    return {
      level: 'Bronze',
      tierInfo: {
        name: 'Bronze',
        minSpendingAmount: 0,
        discountPercentage: 0,
        maxDiscountAmount: null,
        benefits: ['Standard customer support'],
        color: '#CD7F32',
        icon: 'bronze-medal',
        isActive: true,
        order: 1
      } as unknown as ILoyaltyTier
    };
  }
};

/**
 * Update user's loyalty tier after a booking.
 * Only updates spending totals and tier — no points.
 */
export const updateUserLoyalty = async (
  userId: string,
  bookingAmount: number,
  maxRetries: number = 3
): Promise<{ user: IUser | null; leveledUp: boolean; oldLevel: string; newLevel: string }> => {
  const validAmount = Number(bookingAmount);
  if (!Number.isFinite(validAmount) || validAmount <= 0) {
    const user = await User.findById(userId);
    return { user, leveledUp: false, oldLevel: user?.loyaltyLevel || 'Bronze', newLevel: user?.loyaltyLevel || 'Bronze' };
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        console.error(`Loyalty: User not found: ${userId}`);
        return { user: null, leveledUp: false, oldLevel: 'Unknown', newLevel: 'Unknown' };
      }

      if (user.role !== 'customer') {
        return { user, leveledUp: false, oldLevel: user.loyaltyLevel || 'Bronze', newLevel: user.loyaltyLevel || 'Bronze' };
      }

      const oldLevel = user.loyaltyLevel || 'Bronze';
      const newTotalSpent = (user.totalSpent || 0) + validAmount;
      const newTotalBookings = (user.totalBookings || 0) + 1;

      const newStatus = await calculateLoyaltyStatus(newTotalSpent);
      const newLevel = toValidLoyaltyLevel(newStatus.level);
      const leveledUp = oldLevel !== newLevel;

      const result = await User.findOneAndUpdate(
        { _id: userId, __v: user.__v },
        {
          $inc: { totalSpent: validAmount, totalBookings: 1, __v: 1 },
          $set: {
            loyaltyLevel: newLevel,
            lastLoyaltyUpdate: new Date()
          }
        },
        { new: true }
      );

      if (!result) {
        // Version conflict — another update happened concurrently, retry
        if (attempt < maxRetries - 1) {
          continue;
        }
        console.error(`Loyalty: Update failed after ${maxRetries} retries due to concurrent modifications for user ${userId}`);
        return { user: null, leveledUp: false, oldLevel: 'Unknown', newLevel: 'Unknown' };
      }

      if (leveledUp) {
        console.log(`Loyalty: Level up! ${result.email} ${oldLevel} → ${newLevel}`);
      }

      return { user: result, leveledUp, oldLevel, newLevel };
    } catch (error) {
      console.error('Loyalty: Update failed:', error);
      return { user: null, leveledUp: false, oldLevel: 'Unknown', newLevel: 'Unknown' };
    }
  }

  return { user: null, leveledUp: false, oldLevel: 'Unknown', newLevel: 'Unknown' };
};

// Get loyalty benefits for a user
export const getUserLoyaltyBenefits = async (userId: string): Promise<string[]> => {
  try {
    const user = await User.findById(userId);
    if (!user || user.role !== 'customer') {
      return [];
    }

    const loyaltyStatus = await calculateLoyaltyStatus(user.totalSpent || 0);
    return loyaltyStatus.tierInfo.benefits;
  } catch (error) {
    console.error('Loyalty: Benefits lookup failed:', error);
    return [];
  }
};
