import { Request, Response, NextFunction } from "express";
import User, { IUser } from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import {
  calculateLoyaltyStatus,
  updateUserLoyalty,
  getUserLoyaltyBenefits
} from "../../utils/loyaltySystem";
import LoyaltyConfig from "../../models/loyaltyConfig";
import mongoose from 'mongoose';

// Get user's loyalty status
export const getLoyaltyStatus = async (req: Request, res: Response, next: NextFunction) => {
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
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Only customers have loyalty status
    if (user.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Loyalty system is only available for customers"
      });
    }

    // Calculate current loyalty status based on spending, points, and bookings
    const loyaltyStatus = await calculateLoyaltyStatus(user.totalSpent || 0, user.loyaltyPoints || 0, user.totalBookings || 0);
    const benefits = await getUserLoyaltyBenefits((user._id as mongoose.Types.ObjectId).toString());

    console.log(`🏆 Loyalty: Retrieved status for ${user.email} - ${loyaltyStatus.level} (${loyaltyStatus.points} points)`);

    return res.status(200).json({
      success: true,
      data: {
        loyaltyStatus: {
          points: loyaltyStatus.points,
          level: loyaltyStatus.level,
          nextLevel: loyaltyStatus.nextTier?.name,
          nextLevelPoints: loyaltyStatus.nextTierPoints,
          progress: loyaltyStatus.progress
        },
        userStats: {
          totalSpent: user.totalSpent || 0,
          totalBookings: user.totalBookings || 0,
          memberSince: user.createdAt,
          lastUpdate: user.lastLoyaltyUpdate,
          tierInfo: loyaltyStatus.tierInfo
        },
        benefits,
        tierBenefits: benefits
      }
    });

  } catch (error: any) {
    console.error('Get loyalty status error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve loyalty status"
    });
  }
};

// Add spending to user (simulate booking completion)
export const addSpending = async (req: Request, res: Response, next: NextFunction) => {
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

    const { amount, bookingCompleted } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        msg: "Amount must be a positive number"
      });
    }

    await connecToDatabase();
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Only customers earn loyalty points
    if (user.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Only customers can earn loyalty points"
      });
    }

    const oldLevel = user.loyaltyLevel || 'Bronze';

    // Update user loyalty
    const result = await updateUserLoyalty((user._id as mongoose.Types.ObjectId).toString(), amount, bookingCompleted);

    if (!result.user) {
      return res.status(500).json({
        success: false,
        msg: "Failed to update loyalty points"
      });
    }

    const leveledUp = result.leveledUp;

    console.log(`💰 Loyalty: Added spending for ${user.email} - $${amount}, booking: ${bookingCompleted}, level up: ${leveledUp}`);

    return res.status(200).json({
      success: true,
      msg: leveledUp 
        ? `Congratulations! You've been promoted to ${result.user.loyaltyLevel}!`
        : "Loyalty points updated successfully",
      data: {
        pointsEarned: result.pointsEarned,
        loyaltyStatus: {
          points: result.user.loyaltyPoints,
          level: result.user.loyaltyLevel,
          totalSpent: result.user.totalSpent,
          totalBookings: result.user.totalBookings
        },
        leveledUp,
        oldLevel: result.oldLevel,
        newLevel: result.user.loyaltyLevel
      }
    });

  } catch (error: any) {
    console.error('Add spending error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to add spending"
    });
  }
};

// Get loyalty leaderboard (for gamification)
export const getLeaderboard = async (req: Request, res: Response, next: NextFunction) => {
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

    const limit = parseInt(req.query.limit as string) || 10;

    await connecToDatabase();
    
    // Get current user
    const currentUser = await User.findById(decoded.id).select('name loyaltyPoints loyaltyLevel');
    if (!currentUser) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Get top customers by loyalty points
    const topCustomers = await User.find({ 
      role: 'customer',
      loyaltyPoints: { $gt: 0 }
    })
    .select('name loyaltyPoints loyaltyLevel createdAt')
    .sort({ loyaltyPoints: -1 })
    .limit(limit);

    // Find current user's rank
    const currentUserRank = await User.countDocuments({
      role: 'customer',
      loyaltyPoints: { $gt: currentUser.loyaltyPoints || 0 }
    }) + 1;

    const leaderboard = topCustomers.map((customer, index) => ({
      rank: index + 1,
      name: customer.name,
      points: customer.loyaltyPoints || 0,
      level: customer.loyaltyLevel || 'Bronze',
      memberSince: customer.createdAt,
      isCurrentUser: (customer._id as mongoose.Types.ObjectId).toString() === (currentUser._id as mongoose.Types.ObjectId).toString()
    }));

    console.log(`🏆 Loyalty: Retrieved leaderboard for ${currentUser.name}`);

    return res.status(200).json({
      success: true,
      data: {
        leaderboard,
        currentUser: {
          rank: currentUserRank,
          name: currentUser.name,
          points: currentUser.loyaltyPoints || 0,
          level: currentUser.loyaltyLevel || 'Bronze'
        },
        totalCustomers: await User.countDocuments({ role: 'customer' })
      }
    });

  } catch (error: any) {
    console.error('Get leaderboard error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve leaderboard"
    });
  }
};