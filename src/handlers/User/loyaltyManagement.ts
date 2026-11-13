import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import {
  calculateLoyaltyStatus,
  updateUserLoyalty,
  getUserLoyaltyBenefits,
  nextTierAfterLevel,
  reconcileLoyaltyLevelUpgrade,
} from "../../utils/loyaltySystem";
import { getPointsBalance, getPointHistory } from "../../utils/pointsSystem";
import { calculateProfessionalLevel } from "../../utils/professionalLevelSystem";
import { applyPointsBoost } from '../../utils/professionalLevelSystem';
import LoyaltyConfig from "../../models/loyaltyConfig";
import ProfessionalLevelConfig from "../../models/professionalLevelConfig";
import mongoose from 'mongoose';
import { sendHandlerError } from '../../utils/handlerErrors';

// Get user's loyalty status (tier info + points)
export const getLoyaltyStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role !== 'customer') {
      return res.status(403).json({ success: false, msg: "Loyalty system is only available for customers" });
    }

    const loyaltyStatus = await calculateLoyaltyStatus(user.totalSpent || 0);
    const hasManualOverride = !!user.manualCustomerLevelOverride;
    // FT3 #14a: a stored level below what the spend already qualifies for
    // (e.g. Platinum added after the last booking) is upgraded now, so the
    // level shown, the discount applied and the progression agree.
    let storedLevel: string | undefined = user.loyaltyLevel;
    if (!hasManualOverride) {
      try {
        storedLevel = await reconcileLoyaltyLevelUpgrade(user, loyaltyStatus.level);
      } catch (reconcileError) {
        console.warn('Loyalty: level reconcile failed:', reconcileError);
      }
    }
    const effectiveLevel = user.manualCustomerLevelOverride || storedLevel || loyaltyStatus.level;
    const benefits = await getUserLoyaltyBenefits((user._id as mongoose.Types.ObjectId).toString());
    const pointsBalance = await getPointsBalance(userId);

    let effectiveTierInfo = loyaltyStatus.tierInfo;
    // Progress is relative to the level actually held.
    let progression: ReturnType<typeof nextTierAfterLevel> = null;
    try {
      const config = await LoyaltyConfig.getCurrentConfig();
      if (effectiveLevel && effectiveLevel !== loyaltyStatus.tierInfo?.name) {
        const match = config.tiers.find(t => t.isActive !== false && t.name === effectiveLevel);
        if (match) effectiveTierInfo = match;
      }
      progression = nextTierAfterLevel(config.tiers, effectiveLevel, user.totalSpent || 0);
    } catch (lookupError) {
      console.warn('Loyalty: tier lookup failed:', lookupError);
    }
    const nextLevel = progression ? progression.nextTier?.name ?? null : loyaltyStatus.nextTier?.name ?? null;

    return res.status(200).json({
      success: true,
      data: {
        loyaltyStatus: {
          level: effectiveLevel,
          // 'manual': an admin set this level, so there is no spend-based
          // progression to show (distinct from reaching the top tier).
          levelSource: hasManualOverride ? 'manual' : 'spend',
          nextLevel: hasManualOverride ? null : nextLevel,
          amountToNextTier: hasManualOverride ? null : (progression ? progression.amountNeeded ?? null : loyaltyStatus.amountToNextTier),
          progress: hasManualOverride ? null : (progression ? progression.progress ?? null : loyaltyStatus.progress)
        },
        points: pointsBalance,
        userStats: {
          totalSpent: user.totalSpent || 0,
          totalBookings: user.totalBookings || 0,
          memberSince: user.createdAt,
          lastUpdate: user.lastLoyaltyUpdate,
          tierInfo: effectiveTierInfo
        },
        benefits
      }
    });
  } catch (error: any) {
    console.error('Get loyalty status error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve loyalty status" });
  }
};

// Get user's points balance
export const getUserPointsBalance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const balance = await getPointsBalance(userId);

    return res.status(200).json({
      success: true,
      data: balance
    });
  } catch (error: any) {
    console.error('Get points balance error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve points balance" });
  }
};

// Get user's points transaction history
export const getUserPointsHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const history = await getPointHistory(userId, limit, offset);

    return res.status(200).json({
      success: true,
      data: history
    });
  } catch (error: any) {
    console.error('Get points history error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve points history" });
  }
};

// Get professional's level info
export const getProfessionalLevelStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const user = await User.findById(userId).select('role professionalLevel');
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role !== 'professional') {
      return res.status(403).json({ success: false, msg: "Professional levels are only available for professionals" });
    }

    const levelInfo = await calculateProfessionalLevel(userId);
    const pointsBalance = await getPointsBalance(userId);
    // FT3 #12: how many points buy one booking credit at the current level
    // (the same ratio applyPointsBoost uses), so the benefits page can offer it.
    let pointsBoostRatio = 100;
    try {
      const config = await ProfessionalLevelConfig.getCurrentConfig();
      // Same lookup as applyPointsBoost: the stored level, else 'New'.
      const currentName = (user as any).professionalLevel || 'New';
      const current = config.levels.find((l: any) => l.isActive && l.name === currentName);
      pointsBoostRatio = current?.pointsBoostRatio || 100;
    } catch (configError) {
      console.warn('Professional level: boost ratio lookup failed:', configError);
    }

    return res.status(200).json({
      success: true,
      data: {
        level: levelInfo,
        points: pointsBalance,
        pointsBoostRatio,
      }
    });
  } catch (error: any) {
    console.error('Get professional level error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve professional level" });
  }
};

// Professional uses points to boost level progress
export const boostProfessionalLevel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const pointsToSpend = Number(req.body?.pointsToSpend);
    // Whole, positive points only: a non-numeric value must never reach the
    // ledger as NaN.
    if (!Number.isInteger(pointsToSpend) || pointsToSpend <= 0) {
      return res.status(400).json({ success: false, msg: "Points amount must be a positive whole number" });
    }

    const user = await User.findById(userId).select('role');
    if (!user || user.role !== 'professional') {
      return res.status(403).json({ success: false, msg: "Only professionals can boost their level" });
    }

    const result = await applyPointsBoost(userId, pointsToSpend);

    return res.status(200).json({
      success: true,
      // Only an upward change is an upgrade (a recalculation can also lower it).
      msg: result.leveledUp
        ? `Level upgraded to ${result.newLevel}!`
        : `${result.boostedBookings} booking credits added toward level progress`,
      data: result
    });
  } catch (error: any) {
    console.error('Boost professional level error:', error);
    return sendHandlerError(res, error, "We couldn't boost your level. Please try again.");
  }
};

// Add spending to user (for testing/admin)
export const addSpending = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, msg: "Amount must be a positive number" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role !== 'customer') {
      return res.status(403).json({ success: false, msg: "Only customers can add spending" });
    }

    const result = await updateUserLoyalty((user._id as mongoose.Types.ObjectId).toString(), amount);

    if (!result.user) {
      return res.status(500).json({ success: false, msg: "Failed to update loyalty" });
    }

    return res.status(200).json({
      success: true,
      msg: result.leveledUp
        ? `Congratulations! You've been promoted to ${result.newLevel}!`
        : "Loyalty updated successfully",
      data: {
        loyaltyStatus: {
          level: result.user.loyaltyLevel,
          totalSpent: result.user.totalSpent,
          totalBookings: result.user.totalBookings
        },
        leveledUp: result.leveledUp,
        oldLevel: result.oldLevel,
        newLevel: result.newLevel
      }
    });
  } catch (error: any) {
    console.error('Add spending error:', error);
    return res.status(500).json({ success: false, msg: "Failed to add spending" });
  }
};

// Get loyalty leaderboard
export const getLeaderboard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const limit = parseInt(req.query.limit as string) || 10;

    const currentUser = await User.findById(userId).select('name loyaltyLevel totalSpent');
    if (!currentUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    // Leaderboard by total spent (drives tier)
    const topCustomers = await User.find({
      role: 'customer',
      totalSpent: { $gt: 0 }
    })
    .select('name loyaltyLevel totalSpent createdAt')
    .sort({ totalSpent: -1 })
    .limit(limit);

    const currentUserRank = await User.countDocuments({
      role: 'customer',
      totalSpent: { $gt: currentUser.totalSpent || 0 }
    }) + 1;

    const leaderboard = topCustomers.map((customer, index) => ({
      rank: index + 1,
      name: customer.name,
      level: customer.loyaltyLevel || 'Bronze',
      totalSpent: customer.totalSpent || 0,
      memberSince: customer.createdAt,
      isCurrentUser: (customer._id as mongoose.Types.ObjectId).toString() === (currentUser._id as mongoose.Types.ObjectId).toString()
    }));

    return res.status(200).json({
      success: true,
      data: {
        leaderboard,
        currentUser: {
          rank: currentUserRank,
          name: currentUser.name,
          level: currentUser.loyaltyLevel || 'Bronze',
          totalSpent: currentUser.totalSpent || 0
        },
        totalCustomers: await User.countDocuments({ role: 'customer' })
      }
    });
  } catch (error: any) {
    console.error('Get leaderboard error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve leaderboard" });
  }
};
