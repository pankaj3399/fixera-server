import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import LoyaltyConfig from "../../models/loyaltyConfig";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import { calculateLoyaltyStatusV2 } from "../../utils/loyaltySystemV2";
import mongoose from 'mongoose';

// Get current loyalty configuration
export const getLoyaltyConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.['auth-token'];

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    await connecToDatabase();
    const adminUser = await User.findById(decoded.id);

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        msg: "Admin access required"
      });
    }

    const config = await LoyaltyConfig.getCurrentConfig();

    console.log(`👑 Admin: Retrieved loyalty config for ${adminUser.email}`);

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
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve loyalty configuration"
    });
  }
};

// Update loyalty configuration
export const updateLoyaltyConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.['auth-token'];

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    const { globalSettings, tiers } = req.body;

    if (!globalSettings || !tiers || !Array.isArray(tiers)) {
      return res.status(400).json({
        success: false,
        msg: "Global settings and tiers are required"
      });
    }

    // Validate tiers
    if (tiers.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "At least one tier is required"
      });
    }

    // Validate tier data
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      
      if (!tier.name || typeof tier.minSpendingAmount !== 'number' || tier.minSpendingAmount < 0) {
        return res.status(400).json({
          success: false,
          msg: `Invalid tier data for tier ${i + 1}`
        });
      }

      if (typeof tier.pointsPercentage !== 'number' || tier.pointsPercentage < 0 || tier.pointsPercentage > 100) {
        return res.status(400).json({
          success: false,
          msg: `Points percentage must be between 0 and 100 for tier ${tier.name}`
        });
      }

      if (tier.discountPercentage !== undefined && tier.discountPercentage !== null) {
        if (typeof tier.discountPercentage !== 'number' || tier.discountPercentage < 0 || tier.discountPercentage > 50) {
          return res.status(400).json({
            success: false,
            msg: `Discount percentage must be between 0 and 50 for tier ${tier.name}`
          });
        }
      }

      if (tier.maxDiscountAmount !== undefined && tier.maxDiscountAmount !== null) {
        if (typeof tier.maxDiscountAmount !== 'number' || tier.maxDiscountAmount < 0) {
          return res.status(400).json({
            success: false,
            msg: `Max discount amount must be a positive number for tier ${tier.name}`
          });
        }
      }

      if (!Array.isArray(tier.benefits)) {
        return res.status(400).json({
          success: false,
          msg: `Benefits must be an array for tier ${tier.name}`
        });
      }
    }

    await connecToDatabase();
    const adminUser = await User.findById(decoded.id);

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        msg: "Admin access required"
      });
    }

    let config = await LoyaltyConfig.findOne();
    
    if (!config) {
      config = new LoyaltyConfig({
        globalSettings,
        tiers,
        lastModifiedBy: adminUser._id,
        lastModified: new Date(),
        version: 1
      });
    } else {
      config.globalSettings = globalSettings;
      config.tiers = tiers;
      config.lastModifiedBy = adminUser._id as mongoose.Types.ObjectId;
      config.lastModified = new Date();
    }

    await config.save();

    console.log(`✅ Admin: Updated loyalty config by ${adminUser.email}`);

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
    return res.status(500).json({
      success: false,
      msg: error.message || "Failed to update loyalty configuration"
    });
  }
};

// Recalculate all customer tiers (after config changes)
export const recalculateCustomerTiers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.['auth-token'];

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    await connecToDatabase();
    const adminUser = await User.findById(decoded.id);

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        msg: "Admin access required"
      });
    }

    const customers = await User.find({ role: 'customer' });
    let updated = 0;
    let errors = 0;

    console.log(`🔄 Admin: Recalculating tiers for ${customers.length} customers by ${adminUser.email}...`);

    for (const customer of customers) {
      try {
        const totalSpent = customer.totalSpent || 0;
        const loyaltyPoints = customer.loyaltyPoints || 0;
        
        // Calculate new tier based on spending
        const loyaltyStatus = await calculateLoyaltyStatusV2(totalSpent, loyaltyPoints);
        
        const oldLevel = customer.loyaltyLevel;
        customer.loyaltyLevel = loyaltyStatus.level as 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
        customer.lastLoyaltyUpdate = new Date();
        
        await customer.save();
        
        if (oldLevel !== loyaltyStatus.level) {
          console.log(`🎯 Tier Update: ${customer.email} - ${oldLevel} → ${loyaltyStatus.level} (spent: $${totalSpent})`);
        }
        
        updated++;
      } catch (error) {
        console.error(`❌ Failed to update ${customer.email}:`, error);
        errors++;
      }
    }

    console.log(`✅ Admin: Tier recalculation complete - Updated: ${updated}, Errors: ${errors}`);

    return res.status(200).json({
      success: true,
      msg: "Customer tiers recalculated successfully",
      data: {
        customersProcessed: customers.length,
        updated,
        errors
      }
    });

  } catch (error: any) {
    console.error('Recalculate tiers error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to recalculate customer tiers"
    });
  }
};

// Get loyalty system analytics/stats
export const getLoyaltyAnalytics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.['auth-token'];

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    await connecToDatabase();
    const adminUser = await User.findById(decoded.id);

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        msg: "Admin access required"
      });
    }

    // Get tier distribution
    const tierStats = await User.aggregate([
      { $match: { role: 'customer' } },
      {
        $group: {
          _id: '$loyaltyLevel',
          count: { $sum: 1 },
          totalSpent: { $sum: '$totalSpent' },
          totalPoints: { $sum: '$loyaltyPoints' },
          avgSpent: { $avg: '$totalSpent' },
          avgBookings: { $avg: '$totalBookings' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Total customer stats
    const totalStats = await User.aggregate([
      { $match: { role: 'customer' } },
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          totalRevenue: { $sum: '$totalSpent' },
          totalPointsIssued: { $sum: '$loyaltyPoints' },
          totalBookings: { $sum: '$totalBookings' },
          avgSpentPerCustomer: { $avg: '$totalSpent' }
        }
      }
    ]);

    // Top spenders
    const topSpenders = await User.find({ role: 'customer' })
      .select('name email totalSpent loyaltyLevel loyaltyPoints totalBookings')
      .sort({ totalSpent: -1 })
      .limit(10);

    console.log(`📊 Admin: Retrieved loyalty analytics for ${adminUser.email}`);

    return res.status(200).json({
      success: true,
      data: {
        tierDistribution: tierStats,
        overallStats: totalStats[0] || {
          totalCustomers: 0,
          totalRevenue: 0,
          totalPointsIssued: 0,
          totalBookings: 0,
          avgSpentPerCustomer: 0
        },
        topSpenders
      }
    });

  } catch (error: any) {
    console.error('Get loyalty analytics error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve loyalty analytics"
    });
  }
};

// Test loyalty system (simulate booking for testing)
export const testLoyaltySystem = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.['auth-token'];

    if (!token) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    const { customerId, bookingAmount } = req.body;

    if (!customerId || !bookingAmount || bookingAmount <= 0) {
      return res.status(400).json({
        success: false,
        msg: "Customer ID and positive booking amount are required"
      });
    }

    await connecToDatabase();
    const adminUser = await User.findById(decoded.id);

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({
        success: false,
        msg: "Admin access required"
      });
    }

    const customer = await User.findById(customerId);
    if (!customer || customer.role !== 'customer') {
      return res.status(404).json({
        success: false,
        msg: "Customer not found"
      });
    }

    // Import the simulate function
    const { simulateBookingPoints } = await import('../../utils/loyaltySystemV2');
    const result = await simulateBookingPoints(customerId, bookingAmount);

    console.log(`🧪 Admin: Tested loyalty system for customer ${customer.email} with booking $${bookingAmount} by ${adminUser.email}`);

    return res.status(200).json({
      success: true,
      msg: "Loyalty system test completed",
      data: result.data
    });

  } catch (error: any) {
    console.error('Test loyalty system error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to test loyalty system"
    });
  }
};