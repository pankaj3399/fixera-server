import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import { upload, uploadToS3, deleteFromS3, generateFileName, validateFile } from "../../utils/s3Upload";
import mongoose from 'mongoose';
import { PhoneNumberUtil, PhoneNumberFormat } from 'google-libphonenumber';

const phoneUtil = PhoneNumberUtil.getInstance();
const maskEmail = (email: string): string => {
  if (!email) return 'Unknown';
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const maskedLocal = local.length > 2 
    ? local.substring(0, 2) + '*'.repeat(local.length - 2) 
    : local + '*';
  return `${maskedLocal}@${domain}`;
};

// Upload ID proof
export const uploadIdProof = async (req: Request, res: Response, next: NextFunction) => {
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

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional
    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "ID proof upload is only available for professionals"
      });
    }

    // Check if file exists
    if (!req.file) {
      return res.status(400).json({
        success: false,
        msg: "No file uploaded"
      });
    }

    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        msg: validation.error
      });
    }

    console.log(`📄 ID Proof: Processing upload for user ${user.email}`);
    
    // Delete existing file if any
    if (user.idProofUrl && user.idProofFileName) {
      try {
        // Extract key from URL or use filename
        const existingKey = user.idProofFileName.startsWith('id-proof/') 
          ? user.idProofFileName 
          : `id-proof/${user._id}/${user.idProofFileName}`;
        await deleteFromS3(existingKey);
        console.log(`🗑️ ID Proof: Deleted existing file for ${user.email}`);
      } catch (error) {
        console.warn(`⚠️ ID Proof: Could not delete existing file:`, error);
      }
    }

    // Generate unique filename
    const fileName = generateFileName(req.file.originalname, (user._id as mongoose.Types.ObjectId).toString(), 'id-proof');

    // Upload to S3
    const uploadResult = await uploadToS3(req.file, fileName);

    // Update user record
    user.idProofUrl = uploadResult.url;
    user.idProofFileName = uploadResult.key;
    user.idProofUploadedAt = new Date();
    user.isIdVerified = false; // Reset verification status when new file is uploaded
    await user.save();

    console.log(`✅ ID Proof: Successfully uploaded for ${user.email}`);

    // Return updated user data (without password)
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
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: "ID proof uploaded successfully",
      user: userResponse
    });

  } catch (error: any) {
    console.error('ID proof upload error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to upload ID proof"
    });
  }
};

// Update professional profile
export const updateProfessionalProfile = async (req: Request, res: Response, next: NextFunction) => {
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

    const {
      businessInfo,
      hourlyRate,
      currency,
      serviceCategories,
      blockedDates,
      blockedRanges,
      companyAvailability,
      companyBlockedDates,
      companyBlockedRanges
    } = req.body;

    await connecToDatabase();
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional
    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "Professional profile updates are only available for professionals"
      });
    }

    console.log(`👤 Profile: Updating professional profile for ${user.email}`);

    // Update fields if provided
    if (businessInfo) {
      user.businessInfo = {
        ...user.businessInfo,
        ...businessInfo
      };

    }

    if (hourlyRate !== undefined) {
      if (hourlyRate < 0 || hourlyRate > 10000) {
        return res.status(400).json({
          success: false,
          msg: "Hourly rate must be between 0 and 10000"
        });
      }
      user.hourlyRate = hourlyRate;
    }

    if (currency) {
      const allowedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
      if (!allowedCurrencies.includes(currency)) {
        return res.status(400).json({
          success: false,
          msg: "Invalid currency. Allowed: USD, EUR, GBP, CAD, AUD"
        });
      }
      user.currency = currency;
    }

    if (serviceCategories) {
      if (!Array.isArray(serviceCategories)) {
        return res.status(400).json({
          success: false,
          msg: "Service categories must be an array"
        });
      }
      user.serviceCategories = serviceCategories;
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

      const validatedRanges = blockedRanges.map((range, index) => {
        if (!range.startDate || !range.endDate) {
          throw new Error('Start date and end date are required for blocked ranges');
        }

        const startDate = new Date(range.startDate);
        const endDate = new Date(range.endDate);

        if (startDate > endDate) {
          throw new Error('Start date must be before or equal to end date');
        }

        const processedRange = {
          startDate,
          endDate,
          reason: range.reason || undefined,
          createdAt: new Date()
        };
        return processedRange;
      });

      user.blockedRanges = validatedRanges;
    }

    // Handle company availability (for team members to inherit)
    if (companyAvailability) {
      user.companyAvailability = {
        ...user.companyAvailability,
        ...companyAvailability
      };
    }

    if (companyBlockedDates !== undefined) {
      console.log('📅 Received companyBlockedDates:', companyBlockedDates);
      if (!Array.isArray(companyBlockedDates)) {
        return res.status(400).json({
          success: false,
          msg: "Company blocked dates must be an array"
        });
      }
      user.companyBlockedDates = companyBlockedDates.map(item => {
        if (typeof item === 'string') {
          return { date: new Date(item), isHoliday: false };
        } else {
          return {
            date: new Date(item.date),
            reason: item.reason || undefined,
            isHoliday: item.isHoliday || false
          };
        }
      });
      console.log('✅ Mapped companyBlockedDates:', user.companyBlockedDates);
    }

    if (companyBlockedRanges !== undefined) {
      if (!Array.isArray(companyBlockedRanges)) {
        return res.status(400).json({
          success: false,
          msg: "Company blocked ranges must be an array"
        });
      }

      const validatedCompanyRanges = companyBlockedRanges.map((range) => {
        if (!range.startDate || !range.endDate) {
          throw new Error('Start date and end date are required for company blocked ranges');
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
          isHoliday: range.isHoliday || false,
          createdAt: new Date()
        };
      });

      user.companyBlockedRanges = validatedCompanyRanges;
    }

    // Mark profile as completed if key fields are filled
    if (user.businessInfo?.companyName && user.hourlyRate && user.serviceCategories?.length) {
      user.profileCompletedAt = new Date();
    }

    await user.save();

    console.log(`✅ Profile: Successfully updated professional profile for ${user.email}`);
    console.log('💾 Saved companyBlockedDates:', user.companyBlockedDates);
    console.log('💾 Saved companyBlockedRanges:', user.companyBlockedRanges);

    // Return updated user data (without password)
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
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      blockedDates: user.blockedDates,
      blockedRanges: user.blockedRanges,
      companyAvailability: user.companyAvailability,
      companyBlockedDates: user.companyBlockedDates,
      companyBlockedRanges: user.companyBlockedRanges,
      profileCompletedAt: user.profileCompletedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: "Professional profile updated successfully",
      user: userResponse
    });

  } catch (error: any) {
    console.error('Professional profile update error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update professional profile"
    });
  }
};

// Send profile for verification - PHASE 3 implementation
export const submitForVerification = async (req: Request, res: Response, next: NextFunction) => {
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

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional
    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "Verification submission is only available for professionals"
      });
    }

    // Check current status
    if (user.professionalStatus === 'approved') {
      return res.status(400).json({
        success: false,
        msg: "Your profile is already approved"
      });
    }

    // Check if already pending (prevent multiple submissions)
    if (user.professionalStatus === 'pending') {
      return res.status(400).json({
        success: false,
        msg: "Your profile is already pending verification. You will be notified within 48 hours."
      });
    }

    console.log(`🔍 PHASE 3: Checking verification requirements for ${user.email}`);

    // Check minimum requirements for submission
    const missingRequirements = [];
    
    if (!user.vatNumber) {
      missingRequirements.push('VAT number');
    }
    
    if (!user.idProofUrl) {
      missingRequirements.push('ID proof upload');
    }

    if (!user.businessInfo?.companyName) {
      missingRequirements.push('Company name');
    }

    if (missingRequirements.length > 0) {
      return res.status(400).json({
        success: false,
        msg: `Cannot submit for verification. Please complete: ${missingRequirements.join(', ')}`,
        data: {
          missingRequirements,
          hasVat: !!user.vatNumber,
          hasIdProof: !!user.idProofUrl,
          hasCompanyName: !!user.businessInfo?.companyName
        }
      });
    }

    // Update status to pending
    user.professionalStatus = 'pending';
    user.rejectionReason = undefined; 
    await user.save();
    return res.status(200).json({
      success: true,
      msg: "Thanks for submitting. Your profile will be checked within 48 hours.",
      data: {
        professionalStatus: user.professionalStatus,
        submittedAt: new Date(),
        expectedReviewTime: "48 hours"
      }
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      msg: "Failed to submit profile for verification"
    });
  }
};

// Update phone number
export const updatePhoneNumber = async (req: Request, res: Response, next: NextFunction) => {
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
      console.error('Token verification error:', err);
      return res.status(401).json({
        success: false,
        msg: "Invalid authentication token"
      });
    }

    const rawPhone = req.body.phone;
    const phone = typeof rawPhone === 'string' ? rawPhone.trim() : String(rawPhone || '').trim();

    if (!phone) {
      return res.status(400).json({
        success: false,
        msg: "Phone number is required"
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

    // Determine default region for phone parsing
    const defaultRegion = user.businessInfo?.country || user.location?.country;

    // If no default region, require E.164 format (starts with '+')
    if (!defaultRegion && !phone.startsWith('+')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid phone number format"
      });
    }

    // Normalize and validate phone using google-libphonenumber
    let normalizedPhone: string;
    try {
      // Parse number with default region if available
      const number = phoneUtil.parseAndKeepRawInput(String(phone), defaultRegion);
      
      if (!phoneUtil.isValidNumber(number)) {
        return res.status(400).json({
          success: false,
          msg: "Invalid phone number format"
        });
      }
      
      normalizedPhone = phoneUtil.format(number, PhoneNumberFormat.E164);
    } catch (error) {
       return res.status(400).json({
        success: false,
        msg: "Invalid phone number format"
      });
    }
    
    // Check if phone is already in use by another user
    const existingUser = await User.findOne({ phone: normalizedPhone });
    if (existingUser && existingUser._id.toString() !== decoded.id) {
       return res.status(400).json({
        success: false,
        msg: "Phone number is already in use by another account"
      });
    }
    let phoneChanged = false;
    // Only update if phone number has changed
    if (user.phone !== normalizedPhone) {
      phoneChanged = true;
      user.phone = normalizedPhone;
      user.isPhoneVerified = false;
      
      try {
        await user.save();
      } catch (error: any) {
        // Handle concurrent duplicate key error
        if (error.code === 11000) {
           return res.status(409).json({
            success: false,
            msg: "Phone number already in use"
          });
        }
        throw error;
      }
      
      console.log(`📱 Phone: Updated phone number for ${maskEmail(user.email)}`);
    } else {
      console.log(`📱 Phone: No change in phone number for ${maskEmail(user.email)}`);
    }

    // Return updated user data
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
      businessInfo: user.businessInfo,
      hourlyRate: user.hourlyRate,
      currency: user.currency,
      serviceCategories: user.serviceCategories,
      blockedDates: user.blockedDates,
      blockedRanges: user.blockedRanges,
      companyAvailability: user.companyAvailability,
      companyBlockedDates: user.companyBlockedDates,
      companyBlockedRanges: user.companyBlockedRanges,
      profileCompletedAt: user.profileCompletedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: phoneChanged
        ? "Phone number updated successfully. Please verify your new number."
        : "No changes to phone number",
      user: userResponse
    });

  } catch (error: any) {
    console.error('Phone update error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update phone number"
    });
  }
};