import User, { IUser } from "../models/user";
import LoyaltyConfig, { ILoyaltyConfig, ILoyaltyTier } from "../models/loyaltyConfig";

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
  points: number;
  level: string;
  tierInfo: ILoyaltyTier;
  nextTier?: ILoyaltyTier;
  nextTierPoints?: number;
  progress?: number; // percentage to next tier
  pointsToNextTier?: number;
}

export interface PointsEarned {
  fromSpending: number;
  fromBooking: number;
  total: number;
  bookingAmount: number;
  tierUsed: string;
}

// Calculate loyalty points based on current tier configuration
export const calculateLoyaltyPoints = async (
  bookingAmount: number,
  totalSpent: number = 0,
  includeBookingBonus: boolean = true
): Promise<PointsEarned> => {
  try {
    const config = await LoyaltyConfig.getCurrentConfig();

    if (!config.globalSettings.isEnabled) {
      return {
        fromSpending: 0,
        fromBooking: 0,
        total: 0,
        bookingAmount,
        tierUsed: 'Disabled'
      };
    }

    // Check minimum booking amount
    if (bookingAmount < config.globalSettings.minBookingAmount) {
      return {
        fromSpending: 0,
        fromBooking: 0,
        total: 0,
        bookingAmount,
        tierUsed: 'Below Minimum'
      };
    }

    // Find current tier based on total spending
    const currentTier = getCurrentTier(config.tiers, totalSpent);

    // Apply rounding rule
    const roundedSpendingPoints = applyRoundingRule(
      bookingAmount * (currentTier.pointsPercentage / 100),
      config.globalSettings.roundingRule
    );

    // Booking bonus points
    const bookingPoints = includeBookingBonus ? currentTier.bookingBonus : 0;

    const totalPoints = roundedSpendingPoints + bookingPoints;

    console.log(`🏆 Loyalty: Calculated points - Amount: $${bookingAmount}, Tier: ${currentTier.name} (${currentTier.pointsPercentage}%), Spending: ${roundedSpendingPoints}pts, Booking: ${bookingPoints}pts, Total: ${totalPoints}pts`);

    return {
      fromSpending: roundedSpendingPoints,
      fromBooking: bookingPoints,
      total: totalPoints,
      bookingAmount,
      tierUsed: currentTier.name
    };

  } catch (error) {
    console.error('❌ Loyalty: Points calculation failed:', error);
    return {
      fromSpending: 0,
      fromBooking: 0,
      total: 0,
      bookingAmount,
      tierUsed: 'Error'
    };
  }
};

// Get current tier based on total spending amount
export const getCurrentTier = (tiers: ILoyaltyTier[], totalSpent: number): ILoyaltyTier => {
  // Find the highest tier the user qualifies for
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalSpent >= tiers[i].minSpendingAmount) {
      return tiers[i];
    }
  }

  // Default to first tier if no match
  return tiers[0];
};

// Get next tier information
export const getNextTierInfo = (tiers: ILoyaltyTier[], totalSpent: number): {
  nextTier?: ILoyaltyTier;
  amountNeeded?: number;
  progress?: number;
} => {
  const currentTier = getCurrentTier(tiers, totalSpent);

  // Find next tier
  const currentIndex = tiers.findIndex(tier => tier.name === currentTier.name);
  const nextTier = currentIndex < tiers.length - 1 ? tiers[currentIndex + 1] : null;

  if (!nextTier) {
    return {}; // Already at max tier
  }

  const amountNeeded = nextTier.minSpendingAmount - totalSpent;
  const progress = Math.min(100, Math.round((totalSpent / nextTier.minSpendingAmount) * 100));

  return {
    nextTier,
    amountNeeded,
    progress
  };
};

// Apply rounding rule to points
const applyRoundingRule = (points: number, rule: 'floor' | 'ceil' | 'round'): number => {
  switch (rule) {
    case 'ceil':
      return Math.ceil(points);
    case 'round':
      return Math.round(points);
    case 'floor':
    default:
      return Math.floor(points);
  }
};

// Full loyalty calculation with tier info
export const calculateLoyaltyStatus = async (
  totalSpent: number = 0,
  currentPoints: number = 0,
  totalBookings: number = 0
): Promise<LoyaltyCalculation> => {
  try {
    const config = await LoyaltyConfig.getCurrentConfig();
    const currentTier = getCurrentTier(config.tiers, totalSpent);
    const nextTierInfo = getNextTierInfo(config.tiers, totalSpent);

    return {
      points: currentPoints,
      level: currentTier.name,
      tierInfo: currentTier,
      nextTier: nextTierInfo.nextTier,
      nextTierPoints: nextTierInfo.nextTier?.minSpendingAmount,
      pointsToNextTier: nextTierInfo.amountNeeded,
      progress: nextTierInfo.progress
    };

  } catch (error) {
    console.error('❌ Loyalty: Status calculation failed:', error);

    // Fallback to Bronze tier
    return {
      points: currentPoints,
      level: 'Bronze',
      tierInfo: {
        name: 'Bronze',
        minSpendingAmount: 0,
        pointsPercentage: 1,
        bookingBonus: 25,
        benefits: ['Standard customer support'],
        color: '#CD7F32',
        icon: 'bronze-medal',
        isActive: true,
        order: 1
      } as ILoyaltyTier
    };
  }
};

// Update user's loyalty status
export const updateUserLoyalty = async (
  userId: string,
  bookingAmount: number,
  includeBookingBonus: boolean = true
): Promise<{ user: IUser | null; pointsEarned: PointsEarned; leveledUp: boolean; oldLevel: string }> => {
  try {
    const user = await User.findById(userId);
    if (!user) {
      console.error(`❌ Loyalty: User not found: ${userId}`);
      return {
        user: null,
        pointsEarned: {
          fromSpending: 0,
          fromBooking: 0,
          total: 0,
          bookingAmount,
          tierUsed: 'User Not Found'
        },
        leveledUp: false,
        oldLevel: 'Unknown'
      };
    }

    // Only update for customers
    if (user.role !== 'customer') {
      console.log(`ℹ️ Loyalty: Skipping loyalty update for ${user.role}: ${user.email}`);
      return {
        user,
        pointsEarned: {
          fromSpending: 0,
          fromBooking: 0,
          total: 0,
          bookingAmount,
          tierUsed: 'Non-Customer'
        },
        leveledUp: false,
        oldLevel: user.loyaltyLevel || 'Bronze'
      };
    }

    const currentPoints = user.loyaltyPoints || 0;
    const currentTotalSpent = user.totalSpent || 0;
    const oldLevel = user.loyaltyLevel || 'Bronze';

    // Calculate points earned from this booking (based on current tier from total spending)
    const pointsEarned = await calculateLoyaltyPoints(
      bookingAmount,
      currentTotalSpent,
      includeBookingBonus
    );

    // Update user totals
    const newTotalPoints = currentPoints + pointsEarned.total;
    const newTotalSpent = (user.totalSpent || 0) + bookingAmount;
    const newTotalBookings = (user.totalBookings || 0) + (includeBookingBonus ? 1 : 0);

    // Calculate new tier (based on spending amount, not points)
    const newLoyaltyStatus = await calculateLoyaltyStatus(
      newTotalSpent,
      newTotalPoints,
      newTotalBookings
    );

    const leveledUp = oldLevel !== newLoyaltyStatus.level;

    // Update user
    user.loyaltyPoints = newTotalPoints;
    user.loyaltyLevel = toValidLoyaltyLevel(newLoyaltyStatus.level);
    user.totalSpent = newTotalSpent;
    user.totalBookings = newTotalBookings;
    user.lastLoyaltyUpdate = new Date();

    await user.save();

    if (leveledUp) {
      console.log(`🎉 Loyalty: Level up! ${user.email} promoted from ${oldLevel} to ${newLoyaltyStatus.level}`);
    }

    console.log(`🏆 Loyalty: Updated ${user.email} - Booking: $${bookingAmount}, Points Earned: ${pointsEarned.total}, Total Points: ${newTotalPoints}, Level: ${newLoyaltyStatus.level}`);

    return {
      user,
      pointsEarned,
      leveledUp,
      oldLevel
    };

  } catch (error) {
    console.error('❌ Loyalty: Update failed:', error);
    return {
      user: null,
      pointsEarned: {
        fromSpending: 0,
        fromBooking: 0,
        total: 0,
        bookingAmount,
        tierUsed: 'Error'
      },
      leveledUp: false,
      oldLevel: 'Unknown'
    };
  }
};

// Get loyalty benefits for a user
export const getUserLoyaltyBenefits = async (userId: string): Promise<string[]> => {
  try {
    const user = await User.findById(userId);
    if (!user || user.role !== 'customer') {
      return [];
    }

    const loyaltyStatus = await calculateLoyaltyStatus(user.totalSpent || 0, user.loyaltyPoints || 0);
    return loyaltyStatus.tierInfo.benefits;

  } catch (error) {
    console.error('❌ Loyalty: Benefits lookup failed:', error);
    return [];
  }
};

// Preview what a booking would earn without writing to DB
export const previewBookingPoints = async (userId: string, bookingAmount: number): Promise<any> => {
  const user = await User.findById(userId);
  if (!user || user.role !== 'customer') {
    return { success: false, error: 'User not found or not a customer' };
  }

  const currentTotalSpent = user.totalSpent || 0;
  const pointsEarned = await calculateLoyaltyPoints(bookingAmount, currentTotalSpent, true);

  const newTotalSpent = currentTotalSpent + bookingAmount;
  const newTotalPoints = (user.loyaltyPoints || 0) + pointsEarned.total;
  const projectedStatus = await calculateLoyaltyStatus(newTotalSpent, newTotalPoints, (user.totalBookings || 0) + 1);

  return {
    success: true,
    data: {
      pointsEarned,
      wouldLevelUp: (user.loyaltyLevel || 'Bronze') !== projectedStatus.level,
      currentLevel: user.loyaltyLevel || 'Bronze',
      projectedLevel: projectedStatus.level,
      currentPoints: user.loyaltyPoints || 0,
      projectedPoints: newTotalPoints,
      currentSpent: currentTotalSpent,
      projectedSpent: newTotalSpent,
    }
  };
};

// Apply booking points — mutates user in DB (admin testing only)
export const simulateBookingPoints = async (userId: string, bookingAmount: number): Promise<any> => {
  if (process.env.NODE_ENV === 'production') {
    return { success: false, error: 'simulateBookingPoints is disabled in production' };
  }

  const result = await updateUserLoyalty(userId, bookingAmount, true);
  return {
    success: true,
    data: {
      pointsEarned: result.pointsEarned,
      leveledUp: result.leveledUp,
      oldLevel: result.oldLevel,
      newLevel: result.user?.loyaltyLevel,
      totalPoints: result.user?.loyaltyPoints,
      totalSpent: result.user?.totalSpent
    }
  };
};
