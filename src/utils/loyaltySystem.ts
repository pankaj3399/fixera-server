import User, { IUser } from "../models/user";
import LoyaltyConfig, { ILoyaltyTier } from "../models/loyaltyConfig";
import { notifyAsync } from './notifications/notify';

type LoyaltyLevel = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';
const VALID_LOYALTY_LEVELS: Set<string> = new Set(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);
const LOYALTY_RANK: Record<LoyaltyLevel, number> = {
  Bronze: 0,
  Silver: 1,
  Gold: 2,
  Platinum: 3,
  Diamond: 4,
};

function isLoyaltyUpgrade(oldLevel: string, newLevel: string): boolean {
  const oldRank = LOYALTY_RANK[toValidLoyaltyLevel(oldLevel)];
  const newRank = LOYALTY_RANK[toValidLoyaltyLevel(newLevel)];
  return newRank > oldRank;
}

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

// Sort tiers by minSpendingAmount ascending
const sortTiers = (tiers: ILoyaltyTier[]): ILoyaltyTier[] =>
  tiers.slice().sort((a, b) => a.minSpendingAmount - b.minSpendingAmount);

// Get current tier based on total spending amount (internal, expects pre-sorted tiers)
const getCurrentTierFromSorted = (orderedTiers: ILoyaltyTier[], totalSpent: number): ILoyaltyTier => {
  for (let i = orderedTiers.length - 1; i >= 0; i--) {
    if (totalSpent >= orderedTiers[i].minSpendingAmount) {
      return orderedTiers[i];
    }
  }
  return orderedTiers[0];
};

// Get current tier based on total spending amount
export const getCurrentTier = (tiers: ILoyaltyTier[], totalSpent: number): ILoyaltyTier => {
  if (!tiers || tiers.length === 0) {
    throw new Error('No loyalty tiers available');
  }
  return getCurrentTierFromSorted(sortTiers(tiers), totalSpent);
};

// Get next tier information
export const getNextTierInfo = (tiers: ILoyaltyTier[], totalSpent: number): {
  nextTier?: ILoyaltyTier;
  amountNeeded?: number;
  progress?: number;
} => {
  if (!tiers || tiers.length === 0) {
    return {};
  }
  const orderedTiers = sortTiers(tiers);
  const currentTier = getCurrentTierFromSorted(orderedTiers, totalSpent);
  const currentIndex = orderedTiers.findIndex(tier => tier.name === currentTier.name);
  const nextTier = currentIndex < orderedTiers.length - 1 ? orderedTiers[currentIndex + 1] : null;

  if (!nextTier) {
    return {};
  }

  const amountNeeded = nextTier.minSpendingAmount - totalSpent;
  const progress = Math.min(100, Math.round((totalSpent / nextTier.minSpendingAmount) * 100));

  return { nextTier, amountNeeded, progress };
};

/**
 * Next tier after the level the customer actually holds (FT3 #14a). The
 * progress card must be relative to the displayed level, not to a level
 * recomputed from spend: otherwise a stored Gold with Platinum-level spend
 * read "already at the top configured level".
 */
export const nextTierAfterLevel = (
  tiers: ILoyaltyTier[],
  level: string | null | undefined,
  totalSpent: number,
): { nextTier?: ILoyaltyTier; amountNeeded?: number; progress?: number } | null => {
  const ordered = sortTiers((tiers || []).filter((tier) => tier.isActive !== false));
  const index = ordered.findIndex((tier) => tier.name === level);
  if (index < 0) return null;
  const nextTier = ordered[index + 1];
  if (!nextTier) return {};
  const spent = Math.max(0, Number(totalSpent) || 0);
  return {
    nextTier,
    amountNeeded: Math.max(0, nextTier.minSpendingAmount - spent),
    progress: nextTier.minSpendingAmount > 0 ? Math.min(100, Math.round((spent / nextTier.minSpendingAmount) * 100)) : 100,
  };
};

/**
 * Brings a stale stored level up to the tier the customer's spend already
 * qualifies for (e.g. a tier added to the config after their last booking,
 * which is when levels are normally recomputed). Upgrades only, never on a
 * manual override, atomic on the stored level so concurrent reads notify the
 * tier-up once. Returns the level now stored.
 */
export const reconcileLoyaltyLevelUpgrade = async (
  user: Pick<IUser, '_id' | 'loyaltyLevel' | 'manualCustomerLevelOverride' | 'role'>,
  qualifiedLevel: string,
): Promise<string | undefined> => {
  const storedLevel = user.loyaltyLevel || 'Bronze';
  if (user.role !== 'customer' || user.manualCustomerLevelOverride) return user.loyaltyLevel;
  if (!VALID_LOYALTY_LEVELS.has(qualifiedLevel) || !isLoyaltyUpgrade(storedLevel, qualifiedLevel)) return user.loyaltyLevel;
  const updated = await User.findOneAndUpdate(
    {
      _id: user._id,
      ...(user.loyaltyLevel ? { loyaltyLevel: user.loyaltyLevel } : { loyaltyLevel: { $in: [null, 'Bronze'] } }),
      manualCustomerLevelOverride: { $in: [null, ''] },
    },
    { $set: { loyaltyLevel: qualifiedLevel, lastLoyaltyUpdate: new Date() } },
    { new: true },
  );
  if (!updated) {
    // Another request changed it first; report what is stored now.
    const current = await User.findById(user._id).select('loyaltyLevel');
    return current?.loyaltyLevel || user.loyaltyLevel;
  }
  try {
    notifyAsync({
      userId: String(updated._id),
      eventKey: 'customer.loyalty_tier_up',
      entityType: 'user',
      entityId: String(updated._id),
      context: { levelName: qualifiedLevel },
    });
  } catch (notifyErr) {
    console.error('Failed to notify loyalty tier-up:', notifyErr);
  }
  return qualifiedLevel;
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
      if (user.manualCustomerLevelOverride) {
        const overrideLevel = toValidLoyaltyLevel(user.manualCustomerLevelOverride);
        const result = await User.findOneAndUpdate(
          { _id: userId, __v: user.__v },
          {
            $inc: { totalSpent: validAmount, totalBookings: 1, __v: 1 },
            $set: {
              loyaltyLevel: overrideLevel,
              lastLoyaltyUpdate: new Date()
            }
          },
          { new: true }
        );

        if (!result) {
          if (attempt < maxRetries - 1) {
            continue;
          }
          console.error(`Loyalty: Override update failed after ${maxRetries} retries for user ${userId}`);
          return { user: null, leveledUp: false, oldLevel: 'Unknown', newLevel: 'Unknown' };
        }

        const overrideLeveledUp = isLoyaltyUpgrade(oldLevel, overrideLevel);
        if (overrideLeveledUp) {
          try {
            notifyAsync({
              userId: String(result._id),
              eventKey: 'customer.loyalty_tier_up',
              entityType: 'user',
              entityId: String(result._id),
              context: { levelName: overrideLevel },
            });
          } catch (notifyErr) {
            console.error('Failed to notify loyalty tier-up:', notifyErr);
          }
        }

        return {
          user: result,
          leveledUp: overrideLeveledUp,
          oldLevel,
          newLevel: overrideLevel
        };
      }
      const newTotalSpent = (user.totalSpent || 0) + validAmount;
      const newTotalBookings = (user.totalBookings || 0) + 1;

      const newStatus = await calculateLoyaltyStatus(newTotalSpent);
      const newLevel = toValidLoyaltyLevel(newStatus.level);
      const leveledUp = isLoyaltyUpgrade(oldLevel, newLevel);

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
        try {
          notifyAsync({
            userId: String(result._id),
            eventKey: 'customer.loyalty_tier_up',
            entityType: 'user',
            entityId: String(result._id),
            context: { levelName: newLevel },
          });
        } catch (notifyErr) {
          console.error('Failed to notify loyalty tier-up:', notifyErr);
        }
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
