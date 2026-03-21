import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import LoyaltyConfig from "../../models/loyaltyConfig";
import PointsConfig from "../../models/pointsConfig";
import PointTransaction from "../../models/pointTransaction";
import ProfessionalLevelConfig from "../../models/professionalLevelConfig";
import { calculateLoyaltyStatus } from "../../utils/loyaltySystem";
import { addPoints, deductPoints } from "../../utils/pointsSystem";
import { updateProfessionalLevel } from "../../utils/professionalLevelSystem";
import mongoose from 'mongoose';

// Get current loyalty configuration
export const getLoyaltyConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

    const config = await LoyaltyConfig.getCurrentConfig();

    return res.status(200).json({
      success: true,
      data: {
        config: {
          id: config._id,
          globalSettings: config.globalSettings,
          tiers: config.tiers,
          lastModified: config.lastModified,
          version: config.version
        }
      }
    });
  } catch (error: any) {
    console.error('Get loyalty config error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve loyalty configuration" });
  }
};

// Update loyalty configuration
export const updateLoyaltyConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

    const { globalSettings, tiers } = req.body;

    if (!globalSettings || !tiers || !Array.isArray(tiers) || tiers.length === 0) {
      return res.status(400).json({ success: false, msg: "Global settings and at least one tier are required" });
    }

    // Validate tier data
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];

      if (!tier.name || typeof tier.minSpendingAmount !== 'number' || tier.minSpendingAmount < 0) {
        return res.status(400).json({ success: false, msg: `Invalid tier data for tier ${i + 1}` });
      }

      if (tier.discountPercentage !== undefined && tier.discountPercentage !== null) {
        if (typeof tier.discountPercentage !== 'number' || tier.discountPercentage < 0 || tier.discountPercentage > 50) {
          return res.status(400).json({ success: false, msg: `Discount percentage must be between 0 and 50 for tier ${tier.name}` });
        }
      }

      if (tier.maxDiscountAmount !== undefined && tier.maxDiscountAmount !== null) {
        if (typeof tier.maxDiscountAmount !== 'number' || tier.maxDiscountAmount < 0) {
          return res.status(400).json({ success: false, msg: `Max discount amount must be a positive number for tier ${tier.name}` });
        }
      }

      if (!Array.isArray(tier.benefits)) {
        return res.status(400).json({ success: false, msg: `Benefits must be an array for tier ${tier.name}` });
      }
    }

    let config = await LoyaltyConfig.findOne();

    if (!config) {
      config = new LoyaltyConfig({
        globalSettings,
        tiers,
        lastModifiedBy: userId,
        lastModified: new Date(),
        version: 1
      });
    } else {
      config.globalSettings = globalSettings;
      config.tiers = tiers;
      config.lastModifiedBy = userId;
      config.lastModified = new Date();
    }

    await config.save();

    return res.status(200).json({
      success: true,
      msg: "Loyalty configuration updated successfully",
      data: {
        config: {
          id: config._id,
          globalSettings: config.globalSettings,
          tiers: config.tiers,
          lastModified: config.lastModified,
          version: config.version
        }
      }
    });
  } catch (error: any) {
    console.error('Update loyalty config error:', error);
    return res.status(500).json({ success: false, msg: error.message || "Failed to update loyalty configuration" });
  }
};

// Recalculate all customer tiers
export const recalculateCustomerTiers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

    const customers = await User.find({ role: 'customer' });
    let updated = 0;
    let errors = 0;

    for (const customer of customers) {
      try {
        const totalSpent = customer.totalSpent || 0;
        const loyaltyStatus = await calculateLoyaltyStatus(totalSpent);

        const VALID_LEVELS = new Set(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);
        customer.loyaltyLevel = (VALID_LEVELS.has(loyaltyStatus.level) ? loyaltyStatus.level : 'Bronze') as any;
        customer.lastLoyaltyUpdate = new Date();

        await customer.save();
        updated++;
      } catch (error) {
        console.error(`Failed to update ${customer.email}:`, error);
        errors++;
      }
    }

    return res.status(200).json({
      success: true,
      msg: "Customer tiers recalculated successfully",
      data: { customersProcessed: customers.length, updated, errors }
    });
  } catch (error: any) {
    console.error('Recalculate tiers error:', error);
    return res.status(500).json({ success: false, msg: "Failed to recalculate customer tiers" });
  }
};

// Get loyalty analytics
export const getLoyaltyAnalytics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

    const tierStats = await User.aggregate([
      { $match: { role: 'customer' } },
      {
        $group: {
          _id: '$loyaltyLevel',
          count: { $sum: 1 },
          totalSpent: { $sum: '$totalSpent' },
          totalPoints: { $sum: '$points' },
          avgSpent: { $avg: '$totalSpent' },
          avgBookings: { $avg: '$totalBookings' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const totalStats = await User.aggregate([
      { $match: { role: 'customer' } },
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          totalRevenue: { $sum: '$totalSpent' },
          totalPoints: { $sum: '$points' },
          totalBookings: { $sum: '$totalBookings' },
          avgSpentPerCustomer: { $avg: '$totalSpent' }
        }
      }
    ]);

    const topSpenders = await User.find({ role: 'customer' })
      .select('name email totalSpent loyaltyLevel points totalBookings')
      .sort({ totalSpent: -1 })
      .limit(10);

    return res.status(200).json({
      success: true,
      data: {
        tierDistribution: tierStats,
        overallStats: totalStats[0] || {
          totalCustomers: 0,
          totalRevenue: 0,
          totalPoints: 0,
          totalBookings: 0,
          avgSpentPerCustomer: 0
        },
        topSpenders
      }
    });
  } catch (error: any) {
    console.error('Get loyalty analytics error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve loyalty analytics" });
  }
};

// ===================== POINTS CONFIG =====================

// Get points configuration
export const getPointsConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await PointsConfig.getCurrentConfig();
    return res.status(200).json({ success: true, data: { config } });
  } catch (error: any) {
    console.error('Get points config error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve points configuration" });
  }
};

// Update points configuration
export const updatePointsConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    const { isEnabled, conversionRate, expiryMonths, minRedemptionPoints } = req.body;

    const config = await PointsConfig.getCurrentConfig();

    if (isEnabled !== undefined) config.isEnabled = isEnabled;
    if (conversionRate !== undefined) config.conversionRate = conversionRate;
    if (expiryMonths !== undefined) config.expiryMonths = expiryMonths;
    if (minRedemptionPoints !== undefined) config.minRedemptionPoints = minRedemptionPoints;
    config.lastModifiedBy = userId;
    config.lastModified = new Date();

    await config.save();

    return res.status(200).json({
      success: true,
      msg: "Points configuration updated",
      data: { config }
    });
  } catch (error: any) {
    console.error('Update points config error:', error);
    return res.status(500).json({ success: false, msg: "Failed to update points configuration" });
  }
};

// Admin: adjust user points (add or remove)
export const adjustUserPoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as any).user?._id;
    const { userId, amount, reason } = req.body;

    if (!userId || !amount || !reason) {
      return res.status(400).json({ success: false, msg: "userId, amount, and reason are required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    let result;
    if (amount > 0) {
      result = await addPoints(userId, amount, 'admin-adjustment', `Admin adjustment: ${reason}`);
    } else if (amount < 0) {
      result = await deductPoints(userId, Math.abs(amount), 'admin-adjustment', `Admin adjustment: ${reason}`);
    } else {
      return res.status(400).json({ success: false, msg: "Amount cannot be zero" });
    }

    console.log(`Admin: Adjusted ${amount} points for user ${user.email} by admin ${adminId}. Reason: ${reason}`);

    return res.status(200).json({
      success: true,
      msg: `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} points`,
      data: { newBalance: result.newBalance }
    });
  } catch (error: any) {
    console.error('Adjust user points error:', error);
    return res.status(400).json({ success: false, msg: error.message || "Failed to adjust points" });
  }
};

// Points analytics
export const getPointsAnalytics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Total points in circulation
    const pointsStats = await User.aggregate([
      { $match: { points: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          totalActivePoints: { $sum: '$points' },
          usersWithPoints: { $sum: 1 },
          avgPointsPerUser: { $avg: '$points' }
        }
      }
    ]);

    // Points earned/spent breakdown by source
    const transactionStats = await PointTransaction.aggregate([
      {
        $group: {
          _id: { type: '$type', source: '$source' },
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Recent transactions
    const recentTransactions = await PointTransaction.find()
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .limit(20);

    return res.status(200).json({
      success: true,
      data: {
        pointsStats: pointsStats[0] || { totalActivePoints: 0, usersWithPoints: 0, avgPointsPerUser: 0 },
        transactionStats,
        recentTransactions
      }
    });
  } catch (error: any) {
    console.error('Get points analytics error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve points analytics" });
  }
};

// ===================== PROFESSIONAL LEVELS =====================

// Get professional level configuration
export const getProfessionalLevelConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await ProfessionalLevelConfig.getCurrentConfig();
    return res.status(200).json({ success: true, data: { config } });
  } catch (error: any) {
    console.error('Get professional level config error:', error);
    return res.status(500).json({ success: false, msg: "Failed to retrieve professional level configuration" });
  }
};

// Update professional level configuration
export const updateProfessionalLevelConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    const { levels } = req.body;

    if (!levels || !Array.isArray(levels) || levels.length === 0) {
      return res.status(400).json({ success: false, msg: "At least one level is required" });
    }

    let config = await ProfessionalLevelConfig.findOne();

    if (!config) {
      config = new ProfessionalLevelConfig({
        levels,
        lastModifiedBy: userId,
        lastModified: new Date(),
        version: 1
      });
    } else {
      config.levels = levels;
      config.lastModifiedBy = userId;
      config.lastModified = new Date();
    }

    await config.save();

    return res.status(200).json({
      success: true,
      msg: "Professional level configuration updated",
      data: { config }
    });
  } catch (error: any) {
    console.error('Update professional level config error:', error);
    return res.status(500).json({ success: false, msg: error.message || "Failed to update professional level configuration" });
  }
};

// Recalculate all professional levels
export const recalculateProfessionalLevels = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const professionals = await User.find({ role: 'professional', professionalStatus: 'approved' });
    let updated = 0;
    let levelChanges = 0;

    for (const professional of professionals) {
      try {
        const result = await updateProfessionalLevel(professional._id as mongoose.Types.ObjectId);
        updated++;
        if (result.levelChanged) levelChanges++;
      } catch (error) {
        console.error(`Failed to update level for ${professional.email}:`, error);
      }
    }

    return res.status(200).json({
      success: true,
      msg: "Professional levels recalculated",
      data: { professionalsProcessed: professionals.length, updated, levelChanges }
    });
  } catch (error: any) {
    console.error('Recalculate professional levels error:', error);
    return res.status(500).json({ success: false, msg: "Failed to recalculate professional levels" });
  }
};
