import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

export const updateTeamMemberAvailabilityPreference = async (req: Request, res: Response, next: NextFunction) => {
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
    const user = await User.findById(decoded.id);

    if (!user || user.role !== 'team_member') {
      return res.status(403).json({
        success: false,
        msg: "Team member access required"
      });
    }

    const { availabilityPreference } = req.body;

    if (!availabilityPreference || !['personal', 'same_as_company'].includes(availabilityPreference)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid availability preference. Must be 'personal' or 'same_as_company'"
      });
    }

    // Update the team member's availability preference
    if (!user.teamMember) {
      user.teamMember = {};
    }
    user.teamMember.availabilityPreference = availabilityPreference;
    await user.save();

    return res.status(200).json({
      success: true,
      msg: "Availability preference updated successfully",
      data: {
        availabilityPreference: user.teamMember.availabilityPreference
      }
    });

  } catch (error: any) {
    console.error(`❌ Error updating availability preference:`, error);
    return res.status(500).json({
      success: false,
      msg: "Server error while updating availability preference"
    });
  }
};

export const updateTeamMemberAvailability = async (req: Request, res: Response, next: NextFunction) => {
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
    const user = await User.findById(decoded.id);

    if (!user || user.role !== 'team_member') {
      return res.status(403).json({
        success: false,
        msg: "Team member access required"
      });
    }

    const { availability, blockedDates, blockedRanges } = req.body;

    // Update team member's personal availability
    if (availability) {
      user.availability = {
        ...user.availability,
        ...availability
      };
    }

    if (blockedDates !== undefined) {
      if (!Array.isArray(blockedDates)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked dates must be an array"
        });
      }
      user.blockedDates = blockedDates.map(item => {
        if (typeof item === 'string') {
          return { date: new Date(item) };
        } else {
          return {
            date: new Date(item.date),
            reason: item.reason || undefined
          };
        }
      });
    }

    if (blockedRanges !== undefined) {
      if (!Array.isArray(blockedRanges)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked ranges must be an array"
        });
      }

      const validatedRanges = blockedRanges.map((range) => {
        if (!range.startDate || !range.endDate) {
          throw new Error('Start date and end date are required for blocked ranges');
        }

        const startDate = new Date(range.startDate);
        const endDate = new Date(range.endDate);

        if (startDate > endDate) {
          throw new Error('Start date must be before or equal to end date');
        }

        return {
          startDate,
          endDate,
          reason: range.reason || undefined,
          createdAt: new Date()
        };
      });

      user.blockedRanges = validatedRanges;
    }

    await user.save();

    return res.status(200).json({
      success: true,
      msg: "Availability updated successfully",
      data: {
        availability: user.availability,
        blockedDates: user.blockedDates,
        blockedRanges: user.blockedRanges
      }
    });

  } catch (error: any) {
    console.error(`❌ Error updating availability:`, error);
    return res.status(500).json({
      success: false,
      msg: "Server error while updating availability"
    });
  }
};

export const getTeamMemberEffectiveAvailability = async (req: Request, res: Response, next: NextFunction) => {
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
    const user = await User.findById(decoded.id);

    if (!user || user.role !== 'team_member') {
      return res.status(403).json({
        success: false,
        msg: "Team member access required"
      });
    }

    // Get effective availability based on preference
    const preference = user.teamMember?.availabilityPreference || 'personal';

    let effectiveAvailability;
    let effectiveBlockedDates;
    let effectiveBlockedRanges;

    if (preference === 'same_as_company') {
      // Fetch professional's company availability
      const professional = await User.findById(user.teamMember?.companyId);

      if (!professional) {
        return res.status(404).json({
          success: false,
          msg: "Company information not found"
        });
      }

      effectiveAvailability = professional.companyAvailability || {};
      effectiveBlockedDates = professional.companyBlockedDates || [];
      effectiveBlockedRanges = professional.companyBlockedRanges || [];
    } else {
      // Use team member's personal availability
      effectiveAvailability = user.availability || {};
      effectiveBlockedDates = user.blockedDates || [];
      effectiveBlockedRanges = user.blockedRanges || [];
    }

    return res.status(200).json({
      success: true,
      data: {
        availabilityPreference: preference,
        availability: effectiveAvailability,
        blockedDates: effectiveBlockedDates,
        blockedRanges: effectiveBlockedRanges
      }
    });

  } catch (error: any) {
    console.error(`❌ Error getting effective availability:`, error);
    return res.status(500).json({
      success: false,
      msg: "Server error while getting effective availability"
    });
  }
};

export const updateManagedTeamMemberAvailability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { teamMemberId } = req.params;
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
    const professional = await User.findById(decoded.id);

    if (!professional || professional.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "Professional access required"
      });
    }

    // Find the team member
    const teamMember = await User.findOne({
      _id: teamMemberId,
      role: 'team_member',
      'teamMember.companyId': (professional._id as mongoose.Types.ObjectId).toString()
    });

    if (!teamMember) {
      return res.status(404).json({
        success: false,
        msg: "Team member not found or not managed by you"
      });
    }

    const { availability, blockedDates, blockedRanges } = req.body;

    // Check if the team member is managed by the company
    if (!teamMember.teamMember?.managedByCompany) {
      return res.status(403).json({
        success: false,
        msg: "This team member manages their own availability"
      });
    }

    // Update team member's availability
    if (availability) {
      teamMember.availability = {
        ...teamMember.availability,
        ...availability
      };
    }

    if (blockedDates !== undefined) {
      if (!Array.isArray(blockedDates)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked dates must be an array"
        });
      }
      teamMember.blockedDates = blockedDates.map(item => {
        if (typeof item === 'string') {
          return { date: new Date(item) };
        } else {
          return {
            date: new Date(item.date),
            reason: item.reason || undefined
          };
        }
      });
    }

    if (blockedRanges !== undefined) {
      if (!Array.isArray(blockedRanges)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked ranges must be an array"
        });
      }

      const validatedRanges = blockedRanges.map((range) => {
        if (!range.startDate || !range.endDate) {
          throw new Error('Start date and end date are required for blocked ranges');
        }

        const startDate = new Date(range.startDate);
        const endDate = new Date(range.endDate);

        if (startDate > endDate) {
          throw new Error('Start date must be before or equal to end date');
        }

        return {
          startDate,
          endDate,
          reason: range.reason || undefined,
          createdAt: new Date()
        };
      });

      teamMember.blockedRanges = validatedRanges;
    }

    await teamMember.save();

    return res.status(200).json({
      success: true,
      msg: "Team member availability updated successfully",
      data: {
        availability: teamMember.availability,
        blockedDates: teamMember.blockedDates,
        blockedRanges: teamMember.blockedRanges
      }
    });

  } catch (error: any) {
    console.error(`❌ Error updating managed team member availability:`, error);
    return res.status(500).json({
      success: false,
      msg: "Server error while updating managed team member availability"
    });
  }
};