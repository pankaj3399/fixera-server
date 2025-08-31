import { Request, Response, NextFunction } from "express";
import User from "../../../../models/user";
import { generateOTP, sendOTPEmail } from "../../../../utils/emailService";

// Send OTP to user's email
export const sendEmailOTP = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Check if user is already verified
    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified"
      });
    }

    // Generate OTP
    const otp = generateOTP();
    console.log(`🔐 Generated EMAIL OTP for verification: ${otp} (${email})`);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Update user with OTP and expiry
    await User.findByIdAndUpdate(user._id, {
      verificationCode: otp,
      verificationCodeExpires: otpExpiry
    });

    // Send email
    const emailSent = await sendOTPEmail(email, otp, user.name);
    
    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send verification email"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Verification code sent to your email"
    });

  } catch (error) {
    next(error);
  }
};

// Verify email OTP
export const verifyEmailOTP = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required"
      });
    }

    // Find user by email
    const user = await User.findOne({ email }).select("+verificationCode +verificationCodeExpires");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Check if user is already verified
    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified"
      });
    }

    // Check if OTP exists and is not expired
    if (!user.verificationCode || !user.verificationCodeExpires) {
      return res.status(400).json({
        success: false,
        message: "No verification code found. Please request a new one"
      });
    }

    // Check if OTP is expired
    if (new Date() > user.verificationCodeExpires) {
      return res.status(400).json({
        success: false,
        message: "Verification code has expired. Please request a new one"
      });
    }

    // Verify OTP
    if (user.verificationCode !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification code"
      });
    }

    // Mark email as verified and clear verification code
    await User.findByIdAndUpdate(user._id, {
      isEmailVerified: true,
      verificationCode: undefined,
      verificationCodeExpires: undefined
    });

    return res.status(200).json({
      success: true,
      message: "Email verified successfully"
    });

  } catch (error) {
    next(error);
  }
};

// Resend OTP
export const resendEmailOTP = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }


    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Check if user is already verified
    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified"
      });
    }

    // Generate new OTP
    const otp = generateOTP();
    console.log(`🔐 Resend EMAIL OTP: ${otp} (${email})`);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Update user with new OTP and expiry
    await User.findByIdAndUpdate(user._id, {
      verificationCode: otp,
      verificationCodeExpires: otpExpiry
    });

    // Send new email
    const emailSent = await sendOTPEmail(email, otp, user.name);
    
    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send verification email"
      });
    }

    return res.status(200).json({
      success: true,
      message: "New verification code sent to your email"
    });

  } catch (error) {
    next(error);
  }
};



