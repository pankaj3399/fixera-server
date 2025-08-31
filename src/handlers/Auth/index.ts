import { Request, Response, NextFunction } from "express";
import User, { IUser } from "../../models/user";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import generateToken from "../../utils/functions";
import { generateOTP, sendOTPEmail } from "../../utils/emailService";
import twilio from 'twilio';
import mongoose from "mongoose";

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
    const { name, password, email, phone, role } = req.body;

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

    // Create user with email verification fields initialized
    const user = await User.create({
      name: name.trim(),
      password: hashedPassword,
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      role: role || 'customer',
      isEmailVerified: false,
      isPhoneVerified: false,
      verificationCode: emailOtp,
      verificationCodeExpires: otpExpiry
    });

    // Kick off OTP sends (email + SMS) in parallel, but await to report status
    let emailOtpSent = false;
    let phoneOtpSent = false;

    try {
      console.log(`🔐 Generated EMAIL OTP for signup: ${emailOtp} (${user.email})`);
      emailOtpSent = await sendOTPEmail(user.email, emailOtp, user.name);
    } catch (e) {
      console.error('Error sending email OTP during signup:', e);
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
      availability: user.availability,
      blockedDates: user.blockedDates,
      profileCompletedAt: user.profileCompletedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(201).json({
      success: true,
      msg: "Account created successfully",
      token, // Also send in response for compatibility
      user: userResponse,
      emailOtpSent,
      phoneOtpSent
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
    const userExists: IUser = await User.findOne({
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
    const token = req.cookies?.['auth-token'];

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
      availability: user.availability,
      blockedDates: user.blockedDates,
      profileCompletedAt: user.profileCompletedAt,
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

