import { Request, Response, NextFunction } from "express";
import { IUser } from "../models/user";
// Handler to get current authenticated user
export const GetCurrentUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // User should be attached to req by protect middleware
    const user = req.user as IUser;

    if (!user) {
      return res.status(401).json({
        success: false,
        msg: "User not found. Please authenticate."
      });
    }

    // Return user data without sensitive information
    return res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isEmailVerified: user.isEmailVerified || false,
        isPhoneVerified: user.isPhoneVerified || false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });

  } catch (error: any) {
    console.error('GetCurrentUser error:', error);
    return res.status(500).json({
      success: false,
      msg: "Server error while fetching user data."
    });
  }
};