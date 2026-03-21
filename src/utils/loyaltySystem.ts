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
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalSpent >= tiers[i].minSpendingAmount) {
      return tiers[i];
    }
  }
  return tiers[0];
};

// Get next tier information
export const getNextTierInfo = (tiers: ILoyaltyTier[], totalSpent: number): {
  nextTier?: ILoyaltyTier;
  amountNeeded?: number;
  progress?: number;
} => {
  const currentTier = getCurrentTier(tiers, totalSpent);
  const currentIndex = tiers.findIndex(tier => tier.name === currentTier.name);
  const nextTier = currentIndex < tiers.length - 1 ? tiers[currentIndex + 1] : null;

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
    const currentTier = getCurrentTier(config.tiers, totalSpent);
    const nextTierInfo = getNextTierInfo(config.tiers, totalSpent);

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
  bookingAmount: number
): Promise<{ user: IUser | null; leveledUp: boolean; oldLevel: string; newLevel: string }> => {
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
    const newTotalSpent = (user.totalSpent || 0) + bookingAmount;
    const newTotalBookings = (user.totalBookings || 0) + 1;

    const newStatus = await calculateLoyaltyStatus(newTotalSpent);
    const leveledUp = oldLevel !== newStatus.level;

    user.loyaltyLevel = toValidLoyaltyLevel(newStatus.level);
    user.totalSpent = newTotalSpent;
    user.totalBookings = newTotalBookings;
    user.lastLoyaltyUpdate = new Date();

    await user.save();

    if (leveledUp) {
      console.log(`Loyalty: Level up! ${user.email} ${oldLevel} → ${newStatus.level}`);
    }

    return { user, leveledUp, oldLevel, newLevel: newStatus.level };
  } catch (error) {
    console.error('Loyalty: Update failed:', error);
    return { user: null, leveledUp: false, oldLevel: 'Unknown', newLevel: 'Unknown' };
  }
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
