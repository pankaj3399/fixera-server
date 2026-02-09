import { Request, Response, NextFunction } from "express";
import User, { IUser } from "../../models/user";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import generateToken from "../../utils/functions";
import { normalizeBlockedRangesForShortBookings } from "../../utils/blockedRanges";
import { generateOTP, sendOTPEmail, sendWelcomeEmail, sendPasswordResetEmail } from "../../utils/emailService";
import twilio from 'twilio';
import mongoose from "mongoose";
import { buildBookingBlockedRanges } from "../../utils/bookingBlocks";

// Helper function to set secure cookie
const setTokenCookie = (res: Response, token: string) => {
  const isProduction = process.env.NODE_ENV === 'production';

  res.cookie('auth-token', token, {
    httpOnly:true,
    secure: isProduction, // must be true when SameSite=None
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
};

export const SignUp = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      name,
      password,
      email,
      phone,
      role,
      // Customer-specific fields
      customerType,
      address,
      city,
      country,
      postalCode,
      latitude,
      longitude,
      companyName,
      vatNumber,
      isVatValidated
    } = req.body;

    // Comprehensive validation
    if (!name || !password || !email || !phone) {
      return res.status(400).json({
        success: false,
        msg: "Please provide all required fields: name, email, phone, and password"
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        msg: "Please provide a valid email address"
      });
    }

    // Validate password strength
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        msg: "Password must be at least 6 characters long"
      });
    }

    // Validate phone number (basic validation)
    if (phone.length < 10) {
      return res.status(400).json({
        success: false,
        msg: "Please provide a valid phone number"
      });
    }

    // Validate role
    const validRoles = ['customer', 'professional', 'admin'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid role. Must be one of: customer, professional"
      });
    }

    // Check for existing email
    const existingEmailAddress = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (existingEmailAddress) {
      return res.status(409).json({
        success: false,
        msg: "An account with this email already exists"
      });
    }

    // Check for existing phone
    const existingPhone = await User.findOne({
      phone: phone.trim()
    });

    if (existingPhone) {
      return res.status(409).json({
        success: false,
        msg: "An account with this phone number already exists"
      });
    }

    // Hash password
    const saltRounds = 12; // Increased for better security
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Prepare verification artifacts
    const emailOtp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Prepare user data
    const userData: any = {
      name: name.trim(),
      password: hashedPassword,
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      role: role || 'customer',
      isEmailVerified: false,
      isPhoneVerified: false,
      verificationCode: emailOtp,
      verificationCodeExpires: otpExpiry
    };

    // Add customer-specific fields if role is customer
    if (role === 'customer') {
      // Customer type
      if (customerType) {
        userData.customerType = customerType;
      }

      // Location data
      if (address && city && country && postalCode) {
        userData.location = {
          address: address.trim(),
          city: city.trim(),
          country: country.trim(),
          postalCode: postalCode.trim()
        };

        // Add coordinates if provided (from geocoding)
        if (latitude !== undefined && longitude !== undefined) {
          userData.location.type = 'Point';
          userData.location.coordinates = [parseFloat(longitude), parseFloat(latitude)]; // [lng, lat]
        }
      }

      // Business customer fields
      if (customerType === 'business') {
        if (companyName) {
          // Store company name in businessInfo for consistency
          userData.businessInfo = {
            companyName: companyName.trim()
          };
        }

        if (vatNumber) {
          userData.vatNumber = vatNumber.trim().toUpperCase();
          userData.isVatVerified = isVatValidated || false;
        }
      }
    }

    // Create user with all fields
    const user = await User.create(userData);

    // Kick off OTP sends (email + SMS) and welcome email in parallel, but await to report status
    let emailOtpSent = false;
    let phoneOtpSent = false;
    let welcomeEmailSent = false;

    try {
      console.log(`🔐 Generated EMAIL OTP for signup: ${emailOtp} (${user.email})`);
      emailOtpSent = await sendOTPEmail(user.email, emailOtp, user.name);
    } catch (e) {
      console.error('Error sending email OTP during signup:', e);
    }

    // Send welcome email after account creation
    try {
      welcomeEmailSent = await sendWelcomeEmail(user.email, user.name);
    } catch (e) {
      console.error('Error sending welcome email during signup:', e);
    }

    try {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

      if (accountSid && authToken && verifyServiceSid) {
        const twilioClient = twilio(accountSid, authToken);
        await twilioClient.verify.v2.services(verifyServiceSid).verifications.create({
          channel: 'sms',
          to: user.phone
        });
        phoneOtpSent = true;
      }
    } catch (e) {
      console.error('Error sending phone OTP during signup:', e);
    }

    // Generate token
    const token = generateToken(user._id as mongoose.Types.ObjectId);

    // Set httpOnly cookie
    setTokenCookie(res, token);

    // Prepare user response (remove password)
    let bookingBlockedRanges: Array<{ startDate: string; endDate: string; reason?: string }> = [];
    if (user.role === "professional" || user.role === "employee") {
      bookingBlockedRanges = await buildBookingBlockedRanges(user._id as mongoose.Types.ObjectId);
    }

    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified || false,
      isPhoneVerified: user.isPhoneVerified || false,
      vatNumber: user.vatNumber,
      isVatVerified: user.isVatVerified || false,
      idProofUrl: user.idProofUrl,
      idProofFileName: user.idProofFileName,
      idProofUploadedAt: user.idProofUploadedAt,
      isIdVerified: user.isIdVerified || false,
      professionalStatus: user.professionalStatus,
      approvedBy: user.approvedBy,
      approvedAt: user.approvedAt,
      rejectionReason: user.rejectionReason,
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      blockedDates: user.blockedDates,
      blockedRanges: user.blockedRanges,
      bookingBlockedRanges,
      profileCompletedAt: user.profileCompletedAt,
      // Customer-specific fields
      customerType: user.customerType,
      location: user.location,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(201).json({
      success: true,
      msg: "Account created successfully",
      token, // Also send in response for compatibility
      user: userResponse,
      emailOtpSent,
      phoneOtpSent,
      welcomeEmailSent
    });

  } catch (error: any) {
    console.error('SignUp error:', error);
    
    // Handle mongoose validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({
        success: false,
        msg: messages.join(', ')
      });
    }

    // Handle duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        msg: `An account with this ${field} already exists`
      });
    }

    next(error);
  }
};

export const LogIn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        msg: "Please provide both email and password"
      });
    }


    // Find user with password field
    const userExists = await User.findOne({
      email: email.toLowerCase().trim()
    }).select("+password");

    if (!userExists) {
      return res.status(401).json({
        success: false,
        msg: "Invalid email or password"
      });
    }

    // Compare password
    const checkPassword = await bcrypt.compare(password, userExists.password!);

    if (!checkPassword) {
      return res.status(401).json({
        success: false,
        msg: "Invalid email or password"
      });
    }

    // Generate token
    const token = generateToken(userExists._id as mongoose.Types.ObjectId);

    // Set httpOnly cookie
    setTokenCookie(res, token);

    // Prepare user response (remove password)
    const userResponse = {
      _id: userExists._id,
      name: userExists.name,
      email: userExists.email,
      phone: userExists.phone,
      role: userExists.role,
      isEmailVerified: userExists.isEmailVerified || false,
      isPhoneVerified: userExists.isPhoneVerified || false,
      vatNumber: userExists.vatNumber,
      isVatVerified: userExists.isVatVerified || false,
      createdAt: userExists.createdAt,
      updatedAt: userExists.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: "Login successful",
      token, // Also send in response for compatibility
      user: userResponse
    });

  } catch (error: any) {
    console.error('Login error:', error);
    next(error);
  }
};

// Add logout endpoint
export const LogOut = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Clear the httpOnly cookie with same settings used when setting it
    res.clearCookie('auth-token', {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      path: '/'
    });

    return res.status(200).json({
      success: true,
      msg: "Logged out successfully"
    });

  } catch (error: any) {
    console.error('Logout error:', error);
    next(error);
  }
};

// Get current user endpoint
export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check for token in cookies first, then Authorization header
    let token: string | undefined = req.cookies?.['auth-token'];

    // If no cookie token, check Authorization header (Bearer token)
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.substring(7);
    }

    if (!token) {
      return res.status(200).json({ success: true, authenticated: false, user: null });
    }

    let decoded: { id: string } | null = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    } catch (err) {
      // Invalid token: clear cookie and return unauthenticated
      const isProduction = process.env.NODE_ENV === 'production';
      res.clearCookie('auth-token', {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/'
      });
      return res.status(200).json({ success: true, authenticated: false, user: null });
    }

    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      // No user for token: clear cookie and return unauthenticated
      const isProduction = process.env.NODE_ENV === 'production';
      res.clearCookie('auth-token', {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/'
      });
      return res.status(200).json({ success: true, authenticated: false, user: null });
    }

    // Build booking blocked ranges for professionals/employees
    let bookingBlockedRanges: Array<{ startDate: string; endDate: string; reason?: string }> = [];
    if (user.role === "professional" || user.role === "employee") {
      bookingBlockedRanges = await buildBookingBlockedRanges(user._id as mongoose.Types.ObjectId);
    }

    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      isEmailVerified: user.isEmailVerified || false,
      isPhoneVerified: user.isPhoneVerified || false,
      vatNumber: user.vatNumber,
      isVatVerified: user.isVatVerified || false,
      idProofUrl: user.idProofUrl,
      idProofFileName: user.idProofFileName,
      idProofUploadedAt: user.idProofUploadedAt,
      isIdVerified: user.isIdVerified || false,
      professionalStatus: user.professionalStatus,
      approvedBy: user.approvedBy,
      approvedAt: user.approvedAt,
      rejectionReason: user.rejectionReason,
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      blockedDates: user.blockedDates,
      blockedRanges: normalizeBlockedRangesForShortBookings(user.blockedRanges),
      companyAvailability: user.companyAvailability,
      companyBlockedDates: user.companyBlockedDates,
      companyBlockedRanges: user.companyBlockedRanges,
      bookingBlockedRanges,
      profileCompletedAt: user.profileCompletedAt,
      // Customer-specific fields
      customerType: user.customerType,
      location: user.location,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({ success: true, authenticated: true, user: userResponse });

  } catch (error: any) {
    console.error('GetMe error:', error);
    // On server error, do not leak details; treat as unauthenticated but with success=false
    return res.status(200).json({ success: false, authenticated: false, user: null });
  }
};

// Forgot password endpoint
export const ForgotPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;

    // Validation
    if (!email) {
      return res.status(400).json({
        success: false,
        msg: "Please provide an email address"
      });
    }

    // Find user by email
    const user = await User.findOne({
      email: email.toLowerCase().trim()
    });

    // Always return success message for security (don't reveal if email exists)
    if (!user) {
      return res.status(200).json({
        success: true,
        msg: "If that email address is in our database, we will send you an email to reset your password"
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Save hashed token and expiry to user
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    // Send password reset email
    try {
      await sendPasswordResetEmail(user.email, user.name, resetToken);
    } catch (error) {
      console.error('Error sending password reset email:', error);
      // Reset the token fields if email fails
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();

      return res.status(500).json({
        success: false,
        msg: "Failed to send password reset email. Please try again later."
      });
    }

    return res.status(200).json({
      success: true,
      msg: "If that email address is in our database, we will send you an email to reset your password"
    });

  } catch (error: any) {
    console.error('Forgot password error:', error);
    next(error);
  }
};

// Reset password endpoint
export const ResetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = req.body;

    // Validation
    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        msg: "Please provide token and new password"
      });
    }

    // Validate password strength
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        msg: "Password must be at least 6 characters long"
      });
    }

    // Hash the token from URL to compare with DB
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with valid reset token
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() }
    }).select('+resetPasswordToken +resetPasswordExpires');

    if (!user) {
      return res.status(400).json({
        success: false,
        msg: "Invalid or expired password reset token"
      });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password and clear reset token fields
    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.status(200).json({
      success: true,
      msg: "Password has been reset successfully. You can now log in with your new password."
    });

  } catch (error: any) {
    console.error('Reset password error:', error);
    next(error);
  }
};

