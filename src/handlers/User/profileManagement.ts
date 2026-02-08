import { Request, Response, NextFunction } from "express";
import User from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';
import { upload, uploadToS3, deleteFromS3, generateFileName, validateFile } from "../../utils/s3Upload";
import mongoose from 'mongoose';

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

    // Track if this is a re-upload for an already-approved professional
    const wasApproved = user.professionalStatus === 'approved';
    const hadPreviousId = !!user.idProofUrl;

    // Update user record
    user.idProofUrl = uploadResult.url;
    user.idProofFileName = uploadResult.key;
    user.idProofUploadedAt = new Date();
    user.isIdVerified = false; // Reset verification status when new file is uploaded

    // If re-uploading ID while approved, trigger re-verification
    if (wasApproved && hadPreviousId) {
      user.professionalStatus = 'pending';
      if (!user.pendingIdChanges) user.pendingIdChanges = [];
      user.pendingIdChanges.push({
        field: 'idProofDocument',
        oldValue: 'Previous document',
        newValue: 'New document uploaded'
      });
      user.rejectionReason = undefined;
    }

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
export const updatePhone = async (req: Request, res: Response, next: NextFunction) => {
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

    const { phone } = req.body;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({
        success: false,
        msg: "Phone number is required"
      });
    }

    const trimmedPhone = phone.trim();

    // Basic phone format validation (international format)
    if (!/^\+?[1-9]\d{6,14}$/.test(trimmedPhone)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid phone number format. Use international format (e.g., +32123456789)"
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

    // Only allow customer, professional, and employee roles
    if (!['customer', 'professional', 'employee'].includes(user.role)) {
      return res.status(403).json({
        success: false,
        msg: "Phone update is not available for this role"
      });
    }

    // Check if same as current
    if (user.phone === trimmedPhone) {
      return res.status(400).json({
        success: false,
        msg: "New phone number is the same as the current one"
      });
    }

    // Check uniqueness
    const existingUser = await User.findOne({ phone: trimmedPhone, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        msg: "This phone number is already in use by another account"
      });
    }

    user.phone = trimmedPhone;
    user.isPhoneVerified = false;
    await user.save();

    console.log(`📱 Phone: Updated phone for ${user.email} to ${trimmedPhone}`);

    return res.status(200).json({
      success: true,
      msg: "Phone number updated successfully. Please verify your new phone number.",
      data: {
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified
      }
    });

  } catch (error: any) {
    console.error('Update phone error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update phone number"
    });
  }
};

// Update customer profile (address, business name for business customers)
export const updateCustomerProfile = async (req: Request, res: Response, next: NextFunction) => {
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

    const { address, city, country, postalCode, businessName } = req.body;

    await connecToDatabase();
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    if (user.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Customer profile updates are only available for customers"
      });
    }

    // Update location fields
    if (!user.location) {
      user.location = {
        type: 'Point',
        coordinates: [0, 0]
      };
    }

    if (address !== undefined) user.location.address = address;
    if (city !== undefined) user.location.city = city;
    if (country !== undefined) user.location.country = country;
    if (postalCode !== undefined) user.location.postalCode = postalCode;

    // Business name only for business customers
    if (businessName !== undefined) {
      if (user.customerType !== 'business') {
        return res.status(400).json({
          success: false,
          msg: "Business name can only be set for business customers"
        });
      }
      user.businessName = businessName;
    }

    await user.save();

    console.log(`🏠 Customer Profile: Updated for ${user.email}`);

    return res.status(200).json({
      success: true,
      msg: "Customer profile updated successfully",
      data: {
        location: user.location,
        businessName: user.businessName,
        customerType: user.customerType
      }
    });

  } catch (error: any) {
    console.error('Update customer profile error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update customer profile"
    });
  }
};

// Update ID information (triggers re-verification for professionals)
export const updateIdInfo = async (req: Request, res: Response, next: NextFunction) => {
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

    const { idCountryOfIssue, idExpirationDate } = req.body;

    await connecToDatabase();
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        msg: "ID info updates are only available for professionals"
      });
    }

    // Track changes for admin review
    const changes: { field: string; oldValue: string; newValue: string }[] = [];

    if (idCountryOfIssue !== undefined && idCountryOfIssue !== (user.idCountryOfIssue || '')) {
      changes.push({
        field: 'idCountryOfIssue',
        oldValue: user.idCountryOfIssue || '',
        newValue: idCountryOfIssue
      });
    }

    if (idExpirationDate !== undefined) {
      const oldDate = user.idExpirationDate ? user.idExpirationDate.toISOString().split('T')[0] : '';
      const newDate = idExpirationDate ? new Date(idExpirationDate).toISOString().split('T')[0] : '';
      if (oldDate !== newDate) {
        changes.push({
          field: 'idExpirationDate',
          oldValue: oldDate,
          newValue: newDate
        });
      }
    }

    if (changes.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "No changes detected"
      });
    }

    // Apply changes
    if (idCountryOfIssue !== undefined) user.idCountryOfIssue = idCountryOfIssue;
    if (idExpirationDate !== undefined) user.idExpirationDate = new Date(idExpirationDate);

    // Store pending changes for admin review
    user.pendingIdChanges = changes;

    // Trigger re-verification: set status to pending
    const wasApproved = user.professionalStatus === 'approved';
    user.professionalStatus = 'pending';
    user.isIdVerified = false;
    user.rejectionReason = undefined;

    await user.save();

    console.log(`🔄 ID Info: Updated for ${user.email}, re-verification triggered. Changes: ${JSON.stringify(changes)}`);

    return res.status(200).json({
      success: true,
      msg: wasApproved
        ? "ID information updated. Your professional status has been set to pending for re-verification."
        : "ID information updated. Your profile is pending verification.",
      data: {
        changes,
        professionalStatus: user.professionalStatus,
        isIdVerified: user.isIdVerified
      }
    });

  } catch (error: any) {
    console.error('Update ID info error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update ID information"
    });
  }
};