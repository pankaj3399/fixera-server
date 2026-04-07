import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import LoyaltyConfig from "../../models/loyaltyConfig";
import PointsConfig from "../../models/pointsConfig";
import PointTransaction from "../../models/pointTransaction";
import ProfessionalLevelConfig from "../../models/professionalLevelConfig";
import Payment from "../../models/payment";
import Booking from "../../models/booking";
import Project from "../../models/project";
import { calculateLoyaltyStatus } from "../../utils/loyaltySystem";
import { addPoints, deductPoints } from "../../utils/pointsSystem";
import { updateProfessionalLevel } from "../../utils/professionalLevelSystem";
import mongoose from 'mongoose';

const LOYALTY_LEVELS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"] as const;
const PROFESSIONAL_LEVELS = ["New", "Level 1", "Level 2", "Level 3", "Expert"] as const;

const appendQueryCondition = (query: Record<string, any>, condition: Record<string, any> | null) => {
  if (!condition) return;
  if (!Array.isArray(query.$and)) query.$and = [];
  query.$and.push(condition);
};

const buildAccountStatusCondition = (statuses: string[]) => {
  if (statuses.length === 0) return null;
  if (statuses.includes("active")) {
    return {
      $or: [
        { accountStatus: { $in: statuses } },
        { accountStatus: { $exists: false } }
      ]
    };
  }
  return { accountStatus: { $in: statuses } };
};

// Get current loyalty configuration
export const getLoyaltyConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).admin?._id;
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
    const userId = (req as any).admin?._id;
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
    const userId = (req as any).admin?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

    const customers = await User.find({ role: 'customer' });
    let updated = 0;
    let errors = 0;

    for (const customer of customers) {
      try {
        const totalSpent = customer.totalSpent || 0;
        const loyaltyStatus = await calculateLoyaltyStatus(totalSpent);

        const VALID_LEVELS = new Set(['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']);
        const computedLevel = (VALID_LEVELS.has(loyaltyStatus.level) ? loyaltyStatus.level : 'Bronze') as any;
        customer.loyaltyLevel = customer.manualCustomerLevelOverride || computedLevel;
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
    const userId = (req as any).admin?._id;
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
    const userId = (req as any).admin?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

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
    const userId = (req as any).admin?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

    const { isEnabled, conversionRate, expiryMonths, minRedemptionPoints, professionalEarningPerBooking, customerEarningPerBooking } = req.body;

    // Validate fields
    if (isEnabled !== undefined && typeof isEnabled !== 'boolean') {
      return res.status(400).json({ success: false, msg: "isEnabled must be a boolean" });
    }
    if (conversionRate !== undefined) {
      if (typeof conversionRate !== 'number' || !Number.isFinite(conversionRate) || conversionRate <= 0) {
        return res.status(400).json({ success: false, msg: "conversionRate must be a positive number" });
      }
    }
    if (expiryMonths !== undefined) {
      if (typeof expiryMonths !== 'number' || !Number.isInteger(expiryMonths) || expiryMonths < 0) {
        return res.status(400).json({ success: false, msg: "expiryMonths must be a non-negative integer" });
      }
    }
    if (minRedemptionPoints !== undefined) {
      if (typeof minRedemptionPoints !== 'number' || !Number.isInteger(minRedemptionPoints) || minRedemptionPoints < 0) {
        return res.status(400).json({ success: false, msg: "minRedemptionPoints must be a non-negative integer" });
      }
    }
    if (professionalEarningPerBooking !== undefined) {
      if (typeof professionalEarningPerBooking !== 'number' || !Number.isInteger(professionalEarningPerBooking) || professionalEarningPerBooking < 0) {
        return res.status(400).json({ success: false, msg: "professionalEarningPerBooking must be a non-negative integer" });
      }
    }
    if (customerEarningPerBooking !== undefined) {
      if (typeof customerEarningPerBooking !== 'number' || !Number.isInteger(customerEarningPerBooking) || customerEarningPerBooking < 0) {
        return res.status(400).json({ success: false, msg: "customerEarningPerBooking must be a non-negative integer" });
      }
    }

    const config = await PointsConfig.getCurrentConfig();

    if (isEnabled !== undefined) config.isEnabled = isEnabled;
    if (conversionRate !== undefined) config.conversionRate = conversionRate;
    if (expiryMonths !== undefined) config.expiryMonths = expiryMonths;
    if (minRedemptionPoints !== undefined) config.minRedemptionPoints = minRedemptionPoints;
    if (professionalEarningPerBooking !== undefined) config.professionalEarningPerBooking = professionalEarningPerBooking;
    if (customerEarningPerBooking !== undefined) config.customerEarningPerBooking = customerEarningPerBooking;
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
    const adminId = (req as any).admin?._id;
    if (!adminId) return res.status(401).json({ success: false, msg: "Authentication required" });

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
    const userId = (req as any).admin?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

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
    const userId = (req as any).admin?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

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
    const userId = (req as any).admin?._id;
    if (!userId) return res.status(401).json({ success: false, msg: "Authentication required" });

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

const parseCsv = (value: unknown): string[] =>
  typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const listProfessionalManagement = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) {
      return res.status(403).json({ success: false, msg: "Unauthorized" });
    }

    const page = Math.max(Number.parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || "20"), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const country = typeof req.query.country === "string" ? req.query.country.trim() : "";
    const levels = parseCsv(req.query.levels);
    const customerName = typeof req.query.customerName === "string" ? req.query.customerName.trim() : "";
    const tags = parseCsv(req.query.tags);
    const statuses = parseCsv(req.query.statuses);

    let customerNameProfessionalIds: string[] | null = null;
    if (customerName) {
      const nameRegex = new RegExp(escapeRegex(customerName), "i");
      const matchingCustomers = await User.find({ role: "customer", name: nameRegex }).select("_id").lean();
      const customerIds = matchingCustomers.map((c: any) => c._id);
      if (customerIds.length > 0) {
        const matchingBookings = await Booking.find({
          customer: { $in: customerIds },
          $or: [
            { professional: { $exists: true, $ne: null } },
            { project: { $exists: true, $ne: null } },
          ],
        }).select("professional project").lean();
        const directProfessionalIds = matchingBookings
          .filter((b: any) => b.professional)
          .map((b: any) => String(b.professional));
        const projectIds = [...new Set(
          matchingBookings
            .filter((b: any) => b.project)
            .map((b: any) => String(b.project))
        )];
        const projectProfessionals = projectIds.length > 0
          ? await Project.find({ _id: { $in: projectIds } }).select("professionalId").lean()
          : [];
        const projectProfessionalIds = projectProfessionals
          .filter((project: any) => project.professionalId)
          .map((project: any) => String(project.professionalId));
        customerNameProfessionalIds = [...new Set([...directProfessionalIds, ...projectProfessionalIds])];
      } else {
        customerNameProfessionalIds = [];
      }
    }

    const query: Record<string, any> = { role: "professional", deletedAt: { $exists: false } };
    if (customerNameProfessionalIds !== null) {
      query._id = { $in: customerNameProfessionalIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { name: regex },
        { email: regex },
        { username: regex },
        { "businessInfo.companyName": regex }
      ];
    }
    if (country) query["businessInfo.country"] = country;
    if (levels.length > 0) query.professionalLevel = { $in: levels };
    if (tags.length > 0) query.adminTags = { $in: tags };
    appendQueryCondition(query, buildAccountStatusCondition(statuses));

    const [professionals, total] = await Promise.all([
      User.find(query)
        .select("name email phone professionalStatus accountStatus professionalLevel manualProfessionalLevelOverride points adminTags businessInfo createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);

    const professionalIds = professionals.map((item: any) => item._id);
    const earnings = await Payment.aggregate([
      { $match: { professional: { $in: professionalIds }, status: "completed" } },
      { $group: { _id: "$professional", moneyEarned: { $sum: { $ifNull: ["$professionalPayout", 0] } } } }
    ]);
    const earningsMap = new Map(earnings.map((item) => [String(item._id), item.moneyEarned || 0]));

    return res.status(200).json({
      success: true,
      data: {
        professionals: professionals.map((item: any) => ({
          ...item,
          moneyEarned: earningsMap.get(String(item._id)) || 0
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error: any) {
    console.error("List professional management error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load professionals" });
  }
};

export const updateProfessionalManagement = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: `Admin authentication required to update professional management (adminId: ${String(adminId)})` });
    }

    const { professionalId } = req.params;
    const {
      professionalLevel,
      tags,
      action,
      reason
    } = req.body as {
      professionalLevel?: string;
      tags?: string[];
      action?: "suspend" | "reactivate";
      reason?: string;
    };

    const professional = await User.findOne({ _id: professionalId, role: "professional" });
    if (!professional) {
      return res.status(404).json({ success: false, msg: "Professional not found" });
    }

    if (professionalLevel) {
      if (!(PROFESSIONAL_LEVELS as readonly string[]).includes(professionalLevel)) {
        return res.status(400).json({ success: false, msg: `Invalid professional level. Allowed: ${PROFESSIONAL_LEVELS.join(", ")}` });
      }
      professional.manualProfessionalLevelOverride = professionalLevel as any;
      professional.professionalLevel = professionalLevel as any;
    }
    if (Array.isArray(tags)) {
      professional.adminTags = Array.from(new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))).slice(0, 10);
    }
    if (action === "suspend") {
      professional.accountStatus = "suspended";
      if (professional.professionalStatus !== "suspended" && !professional.previousProfessionalStatus) {
        professional.previousProfessionalStatus = professional.professionalStatus as any;
      }
      professional.professionalStatus = "suspended";
      if (reason?.trim()) professional.suspensionReason = reason.trim();
    }
    if (action === "reactivate") {
      professional.accountStatus = "active";
      if (professional.professionalStatus === "suspended") {
        professional.professionalStatus = (professional.previousProfessionalStatus as any) || "approved";
      }
      professional.previousProfessionalStatus = undefined;
      professional.suspensionReason = undefined;
    }

    await professional.save();

    return res.status(200).json({
      success: true,
      msg: "Professional updated",
      data: {
        professional: {
          _id: professional._id,
          professionalLevel: professional.professionalLevel,
          manualProfessionalLevelOverride: professional.manualProfessionalLevelOverride,
          adminTags: professional.adminTags || [],
          accountStatus: professional.accountStatus || "active"
        },
        updatedBy: adminId
      }
    });
  } catch (error: any) {
    console.error("Update professional management error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update professional" });
  }
};

export const listCustomerManagement = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) {
      return res.status(403).json({ success: false, msg: "Unauthorized" });
    }

    const page = Math.max(Number.parseInt(String(req.query.page || "1"), 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || "20"), 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const country = typeof req.query.country === "string" ? req.query.country.trim() : "";
    const address = typeof req.query.address === "string" ? req.query.address.trim() : "";
    const levels = parseCsv(req.query.levels);
    const statuses = parseCsv(req.query.statuses);

    let addressCustomerIds: string[] | null = null;
    if (address) {
      const addressRegex = new RegExp(escapeRegex(address), "i");
      const matchingBookings = await Booking.find({ "location.address": addressRegex }).select("customer").lean();
      addressCustomerIds = [...new Set(matchingBookings.map((b: any) => String(b.customer)))];
    }

    const query: Record<string, any> = { role: "customer", deletedAt: { $exists: false } };
    if (addressCustomerIds !== null) {
      query._id = { $in: addressCustomerIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }
    const searchOr = search
      ? (() => {
          const regex = new RegExp(escapeRegex(search), "i");
          return [{ name: regex }, { email: regex }, { businessName: regex }];
        })()
      : null;
    const countryOr = country
      ? [{ "location.country": country }, { "companyAddress.country": country }]
      : null;
    if (searchOr && countryOr) {
      query.$and = [{ $or: searchOr }, { $or: countryOr }];
    } else if (searchOr) {
      query.$or = searchOr;
    } else if (countryOr) {
      query.$or = countryOr;
    }
    if (levels.length > 0) query.loyaltyLevel = { $in: levels };
    appendQueryCondition(query, buildAccountStatusCondition(statuses));

    const [customers, total] = await Promise.all([
      User.find(query)
        .select("name email phone customerType businessName location companyAddress loyaltyLevel manualCustomerLevelOverride points totalSpent totalBookings accountStatus createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query)
    ]);

    const customerIds = customers.map((item: any) => item._id);
    const spendAgg = await Payment.aggregate([
      { $match: { customer: { $in: customerIds }, status: "completed" } },
      { $group: { _id: "$customer", moneySpent: { $sum: "$amount" } } }
    ]);
    const spendMap = new Map(spendAgg.map((item) => [String(item._id), item.moneySpent || 0]));

    return res.status(200).json({
      success: true,
      data: {
        customers: customers.map((item: any) => ({
          ...item,
          moneySpent: spendMap.get(String(item._id)) || item.totalSpent || 0
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error: any) {
    console.error("List customer management error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load customers" });
  }
};

export const updateCustomerManagement = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: `Admin authentication required to update customer management (adminId: ${String(adminId)})` });
    }

    const { customerId } = req.params;
    const {
      loyaltyLevel,
      action
    } = req.body as {
      loyaltyLevel?: string;
      action?: "suspend" | "reactivate" | "delete";
    };

    const customer = await User.findOne({ _id: customerId, role: "customer" });
    if (!customer) {
      return res.status(404).json({ success: false, msg: "Customer not found" });
    }

    if (loyaltyLevel) {
      if (!(LOYALTY_LEVELS as readonly string[]).includes(loyaltyLevel)) {
        return res.status(400).json({ success: false, msg: `Invalid loyalty level. Allowed: ${LOYALTY_LEVELS.join(", ")}` });
      }
      customer.manualCustomerLevelOverride = loyaltyLevel as any;
      customer.loyaltyLevel = loyaltyLevel as any;
    }
    if (action === "suspend") customer.accountStatus = "suspended";
    if (action === "reactivate") customer.accountStatus = "active";
    if (action === "delete") {
      customer.deletedAt = new Date();
      customer.deletedBy = adminId;
    }

    await customer.save();

    return res.status(200).json({
      success: true,
      msg: "Customer updated",
      data: {
        customer: {
          _id: customer._id,
          loyaltyLevel: customer.loyaltyLevel,
          manualCustomerLevelOverride: customer.manualCustomerLevelOverride,
          accountStatus: customer.accountStatus || "active",
          deletedAt: customer.deletedAt || null
        }
      }
    });
  } catch (error: any) {
    console.error("Update customer management error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update customer" });
  }
};
