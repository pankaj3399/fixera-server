import { Request, Response, NextFunction } from "express";
import User, { IUser } from "../../models/user";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import generateToken from "../../utils/functions";
import { generateOTP, sendOTPEmail, sendWelcomeEmail } from "../../utils/emailService";
import twilio from 'twilio';
import mongoose from "mongoose";
import { buildBookingBlockedRanges } from "../../utils/bookingBlocks";
import { formatVATNumber, isValidVATFormat, validateVATNumber } from "../../utils/viesApi";
import { generateReferralCode, validateReferralCode, createReferral } from "../../utils/referralSystem";
import { sendIdExpiredEmail } from "../../utils/emailService";

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
      // Referral
      referralCode
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
        if (!companyName) {
          return res.status(400).json({
            success: false,
            msg: "Company name is required for business customers"
          });
        }

        // Store company name in businessInfo for consistency
        userData.businessInfo = {
          companyName: companyName.trim()
        };

        if (!vatNumber) {
          return res.status(400).json({
            success: false,
            msg: "VAT number is required for business customers"
          });
        }

        const formattedVAT = formatVATNumber(vatNumber);
        if (!isValidVATFormat(formattedVAT)) {
          return res.status(400).json({
            success: false,
            msg: "Invalid VAT number format"
          });
        }

        userData.vatNumber = formattedVAT;
        const viesValidationResult = await validateVATNumber(formattedVAT);
        userData.isVatVerified = viesValidationResult.valid;
      }
    }

    // Validate referral code before creating user (if provided)
    let referralValidation: { valid: boolean; referrer?: any; error?: string } | null = null;
    if (referralCode) {
      try {
        referralValidation = await validateReferralCode(referralCode);
        if (referralValidation.valid && referralValidation.referrer) {
          userData.referredBy = referralValidation.referrer._id;
        }
      } catch (e) {
        console.warn('Referral validation failed due to transient error, skipping referral:', e);
        referralValidation = null;
      }
    }

    // Create user with all fields
    const user = await User.create(userData);

    // Generate referral code for the new user with retry on duplicate key
    if (user.role === 'customer' || user.role === 'professional') {
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const userReferralCode = await generateReferralCode(user.name);
          user.referralCode = userReferralCode;
          await user.save();
          break;
        } catch (e: any) {
          if (e.code === 11000 && attempt < maxRetries - 1) {
            continue; // Duplicate key — retry with a new code
          }
          console.error('Error generating referral code during signup:', e);
          break;
        }
      }
    }

    // Create referral record if valid referral code was provided
    if (referralValidation?.valid && referralValidation.referrer) {
      try {
        const forwardedFor = req.headers['x-forwarded-for']?.toString();
        const ipAddress = (forwardedFor ? forwardedFor.split(',')[0].trim() : '') || req.ip;
        await createReferral(referralValidation.referrer._id, user._id, referralCode, ipAddress);
      } catch (e) {
        console.error('Error creating referral record during signup:', e);
      }
    }

    // Kick off OTP sends and send customer welcome emails after signup.
    let emailOtpSent = false;
    let phoneOtpSent = false;
    let welcomeEmailSent = false;

    try {
      console.log(`🔐 Generated EMAIL OTP for signup: ${emailOtp} (${user.email})`);
      emailOtpSent = await sendOTPEmail(user.email, emailOtp, user.name);
    } catch (e) {
      console.error('Error sending email OTP during signup:', e);
    }

    if (user.role !== 'professional') {
      try {
        welcomeEmailSent = await sendWelcomeEmail(user.email, user.name);
      } catch (e) {
        console.error('Error sending welcome email during signup:', e);
      }
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
      idCountryOfIssue: user.idCountryOfIssue,
      idExpirationDate: user.idExpirationDate,
      professionalStatus: user.professionalStatus,
      approvedBy: user.approvedBy,
      approvedAt: user.approvedAt,
      rejectionReason: user.rejectionReason,
      suspensionReason: user.suspensionReason,
      username: user.username,
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      blockedDates: user.blockedDates,
      blockedRanges: user.blockedRanges,
      bookingBlockedRanges,
      profileCompletedAt: user.profileCompletedAt,
      professionalOnboardingCompletedAt: user.professionalOnboardingCompletedAt,
      onboardingAgreements: user.onboardingAgreements,
      stripe: user.stripe,
      // Customer-specific fields
      customerType: user.customerType,
      location: user.location,
      // Referral fields
      referralCode: user.referralCode,
      referredBy: user.referredBy,
      points: user.points || 0,
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
    // Compare password first to avoid leaking account existence/status
    const checkPassword = await bcrypt.compare(password, userExists.password!);

    if (!checkPassword) {
      return res.status(401).json({
        success: false,
        msg: "Invalid email or password"
      });
    }

    if (userExists.deletedAt) {
      return res.status(403).json({
        success: false,
        msg: "This account has been deleted"
      });
    }
    if (userExists.accountStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        msg: "This account is suspended"
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
      idProofUrl: userExists.idProofUrl,
      idProofFileName: userExists.idProofFileName,
      idProofUploadedAt: userExists.idProofUploadedAt,
      isIdVerified: userExists.isIdVerified || false,
      idCountryOfIssue: userExists.idCountryOfIssue,
      idExpirationDate: userExists.idExpirationDate,
      professionalStatus: userExists.professionalStatus,
      username: userExists.username,
      businessInfo: userExists.businessInfo,
      professionalOnboardingCompletedAt: userExists.professionalOnboardingCompletedAt,
      onboardingAgreements: userExists.onboardingAgreements,
      stripe: userExists.stripe,
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

    const now = new Date();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const shouldSendIdExpiryReminder =
      user.role === "professional" &&
      user.idExpirationDate &&
      new Date(user.idExpirationDate) <= now &&
      (
        !user.idExpiryEmailSentAt ||
        (now.getTime() - new Date(user.idExpiryEmailSentAt).getTime()) >= sevenDaysMs
      );

    if (shouldSendIdExpiryReminder) {
      sendIdExpiredEmail(user.email, user.name)
        .then((sent) => {
          if (sent) {
            User.updateOne(
              { _id: user._id },
              { $set: { idExpiryEmailSentAt: new Date() } }
            ).exec();
          }
        })
        .catch((err) => console.error(`[ID Expiry] Failed for user ${user._id}:`, err));
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
      idCountryOfIssue: user.idCountryOfIssue,
      idExpirationDate: user.idExpirationDate,
      professionalStatus: user.professionalStatus,
      approvedBy: user.approvedBy,
      approvedAt: user.approvedAt,
      rejectionReason: user.rejectionReason,
      suspensionReason: user.suspensionReason,
      username: user.username,
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      blockedDates: user.blockedDates,
      blockedRanges: user.blockedRanges,
      companyAvailability: user.companyAvailability,
      companyBlockedDates: user.companyBlockedDates,
      companyBlockedRanges: user.companyBlockedRanges,
      bookingBlockedRanges,
      profileCompletedAt: user.profileCompletedAt,
      professionalOnboardingCompletedAt: user.professionalOnboardingCompletedAt,
      onboardingAgreements: user.onboardingAgreements,
      stripe: user.stripe,
      // Customer-specific fields
      customerType: user.customerType,
      businessName: user.businessName,
      companyAddress: user.companyAddress,
      location: user.location,
      // Referral fields
      referralCode: user.referralCode,
      referredBy: user.referredBy,
      points: user.points || 0,
      pointsExpiry: user.pointsExpiry,
      loyaltyLevel: user.loyaltyLevel,
      manualCustomerLevelOverride: user.manualCustomerLevelOverride,
      totalSpent: user.totalSpent || 0,
      totalBookings: user.totalBookings || 0,
      professionalLevel: user.professionalLevel,
      manualProfessionalLevelOverride: user.manualProfessionalLevelOverride,
      adminTags: user.adminTags || [],
      accountStatus: user.accountStatus || 'active',
      totalReferrals: user.totalReferrals || 0,
      completedReferrals: user.completedReferrals || 0,
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

