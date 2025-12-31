import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { buildBookingBlockedRanges } from "../../utils/bookingBlocks";

// They can only block specific dates
export const updateEmployeeAvailabilityPreference = async (req: Request, res: Response, next: NextFunction) => {
  return res.status(400).json({
    success: false,
    msg: "Availability preference is no longer supported. Employees always follow the company's weekly schedule and can only block specific dates."
  });
};

export const updateEmployeeAvailability = async (req: Request, res: Response, next: NextFunction) => {
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

    if (!user || user.role !== 'employee') {
      return res.status(403).json({
        success: false,
        msg: "Employee access required"
      });
    }

    const { blockedDates, blockedRanges } = req.body;

    // Employees can only block dates, they follow the company's weekly schedule
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
      msg: "Blocked dates updated successfully",
      data: {
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

export const getEmployeeEffectiveAvailability = async (req: Request, res: Response, next: NextFunction) => {
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

    if (!user || user.role !== 'employee') {
      return res.status(403).json({
        success: false,
        msg: "Employee access required"
      });
    }

    // Employees always follow the company's weekly schedule
    // They can only block specific dates
    const professional = await User.findById(user.employee?.companyId);

    if (!professional) {
      return res.status(404).json({
        success: false,
        msg: "Company information not found"
      });
    }

    // Return company's weekly schedule + employee's personal blocked dates
    const bookingBlockedRanges = await buildBookingBlockedRanges(user._id as mongoose.Types.ObjectId);
    return res.status(200).json({
      success: true,
      data: {
        availability: professional.companyAvailability || {},
        blockedDates: user.blockedDates || [],
        blockedRanges: user.blockedRanges || [],
        bookingBlockedRanges,
        companyBlockedDates: professional.companyBlockedDates || [],
        companyBlockedRanges: professional.companyBlockedRanges || []
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

export const updateManagedEmployeeAvailability = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { employeeId } = req.params;
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

    // Find the employee
    const employee = await User.findOne({
      _id: employeeId,
      role: 'employee',
      'employee.companyId': (professional._id as mongoose.Types.ObjectId).toString()
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        msg: "Employee not found or not managed by you"
      });
    }

    const { blockedDates, blockedRanges } = req.body;

    // Check if the employee is managed by the company
    if (!employee.employee?.managedByCompany) {
      return res.status(403).json({
        success: false,
        msg: "This employee manages their own availability"
      });
    }

    // Employees can only have blocked dates, they follow the company's weekly schedule
    if (blockedDates !== undefined) {
      if (!Array.isArray(blockedDates)) {
        return res.status(400).json({
          success: false,
          msg: "Blocked dates must be an array"
        });
      }
      employee.blockedDates = blockedDates.map(item => {
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

      employee.blockedRanges = validatedRanges;
    }

    await employee.save();

    return res.status(200).json({
      success: true,
      msg: "Employee blocked dates updated successfully",
      data: {
        blockedDates: employee.blockedDates,
        blockedRanges: employee.blockedRanges
      }
    });

  } catch (error: any) {
    console.error(`❌ Error updating managed employee availability:`, error);
    return res.status(500).json({
      success: false,
      msg: "Server error while updating managed employee availability"
    });
  }
};
