import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import {
  calculateLoyaltyStatus,
  updateUserLoyalty,
  getUserLoyaltyBenefits
} from "../../utils/loyaltySystem";
import { getPointsBalance, getPointHistory } from "../../utils/pointsSystem";
import { calculateProfessionalLevel } from "../../utils/professionalLevelSystem";
import mongoose from 'mongoose';

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
    const benefits = await getUserLoyaltyBenefits((user._id as mongoose.Types.ObjectId).toString());
    const pointsBalance = await getPointsBalance(userId);

    return res.status(200).json({
      success: true,
      data: {
        loyaltyStatus: {
          level: loyaltyStatus.level,
          nextLevel: loyaltyStatus.nextTier?.name,
          amountToNextTier: loyaltyStatus.amountToNextTier,
          progress: loyaltyStatus.progress
        },
        points: pointsBalance,
        userStats: {
          totalSpent: user.totalSpent || 0,
          totalBookings: user.totalBookings || 0,
          memberSince: user.createdAt,
          lastUpdate: user.lastLoyaltyUpdate,
          tierInfo: loyaltyStatus.tierInfo
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

    const user = await User.findById(userId).select('role');
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role !== 'professional') {
      return res.status(403).json({ success: false, msg: "Professional levels are only available for professionals" });
    }

    const levelInfo = await calculateProfessionalLevel(userId);
    const pointsBalance = await getPointsBalance(userId);

    return res.status(200).json({
      success: true,
      data: {
        level: levelInfo,
        points: pointsBalance
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

    const { pointsToSpend } = req.body;
    if (!pointsToSpend || pointsToSpend <= 0) {
      return res.status(400).json({ success: false, msg: "Points amount must be positive" });
    }

    const user = await User.findById(userId).select('role');
    if (!user || user.role !== 'professional') {
      return res.status(403).json({ success: false, msg: "Only professionals can boost their level" });
    }

    const { applyPointsBoost } = await import('../../utils/professionalLevelSystem');
    const result = await applyPointsBoost(userId, pointsToSpend);

    return res.status(200).json({
      success: true,
      msg: result.levelChanged
        ? `Level upgraded to ${result.newLevel}!`
        : `${result.boostedBookings} booking credits added toward level progress`,
      data: result
    });
  } catch (error: any) {
    console.error('Boost professional level error:', error);
    return res.status(400).json({ success: false, msg: error.message || "Failed to boost level" });
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
