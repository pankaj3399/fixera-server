import { Request, Response, NextFunction } from "express";
import { validateVATNumber, isValidVATFormat, formatVATNumber } from "../../utils/viesApi";
import User, { IUser } from "../../models/user";
import connecToDatabase from "../../config/db";
import jwt from 'jsonwebtoken';

export const validateVAT = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { vatNumber } = req.body;

    if (!vatNumber) {
      return res.status(400).json({
        success: false,
        msg: "VAT number is required"
      });
    }

    const formattedVAT = formatVATNumber(vatNumber);

    // Basic format validation
    if (!isValidVATFormat(formattedVAT)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid VAT number format. Must be 2-letter country code followed by 4-15 alphanumeric characters"
      });
    }

    // Validate with VIES API
    const validationResult = await validateVATNumber(formattedVAT);

    // Parse and clean up company address for auto-population
    let cleanedAddress = null;
    if (validationResult.companyAddress) {
      const addressLines = validationResult.companyAddress.split('\n').filter(line => line.trim());
      cleanedAddress = {
        fullAddress: validationResult.companyAddress,
        streetAddress: addressLines[0] || '',
        city: addressLines[addressLines.length - 1]?.match(/\d{4,5}\s+(.+)$/)?.[1] || '',
        postalCode: addressLines[addressLines.length - 1]?.match(/(\d{4,5})/)?.[1] || '',
        country: formattedVAT.substring(0, 2)
      };
    }

    return res.status(200).json({
      success: true,
      data: {
        vatNumber: formattedVAT,
        valid: validationResult.valid,
        companyName: validationResult.companyName,
        companyAddress: validationResult.companyAddress,
        parsedAddress: cleanedAddress,
        error: validationResult.error,
        autoPopulateRecommended: validationResult.valid && (validationResult.companyName || validationResult.companyAddress)
      }
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      msg: "Failed to validate VAT number"
    });
  }
};

// New endpoint for VAT validation with auto-population
export const validateAndPopulateVAT = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    const { vatNumber, autoPopulate = false } = req.body;

    if (!vatNumber) {
      return res.status(400).json({
        success: false,
        msg: "VAT number is required"
      });
    }

    console.log(`💼 PHASE 2: Validating and updating VAT for user - VAT: ${vatNumber}, Auto-populate: ${autoPopulate}`);

    await connecToDatabase();
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    if (user.role !== 'professional') {
      console.log(`⚠️ PHASE 2: Non-professional user attempting VAT validation - Role: ${user.role}`);
    }

    const formattedVAT = formatVATNumber(vatNumber);

    // Basic format validation
    if (!isValidVATFormat(formattedVAT)) {
      console.log(`❌ PHASE 2: VAT format validation failed for user ${user.email}`);
      return res.status(400).json({
        success: false,
        msg: "Invalid VAT number format"
      });
    }

    // Validate with VIES API
    const validationResult = await validateVATNumber(formattedVAT);
    
    // Update VAT information
    user.vatNumber = formattedVAT;
    user.isVatVerified = validationResult.valid;

    // Auto-populate company information if requested and available
    if (autoPopulate && validationResult.valid && user.role === 'professional') {
      
      if (!user.businessInfo) {
        user.businessInfo = {};
      }

      if (validationResult.companyName && !user.businessInfo.companyName) {
        user.businessInfo.companyName = validationResult.companyName;
      }

      if (validationResult.companyAddress) {
        // Parse address components
        const addressLines = validationResult.companyAddress.split('\n').filter(line => line.trim());
        
        if (!user.businessInfo.address && addressLines[0]) {
          user.businessInfo.address = addressLines[0];
        }

        // Extract postal code and city from last line (common EU format)
        const lastLine = addressLines[addressLines.length - 1];
        if (lastLine) {
          const postalMatch = lastLine.match(/(\d{4,5})/);
          const cityMatch = lastLine.match(/\d{4,5}\s+(.+)$/);
          
          if (postalMatch && !user.businessInfo.postalCode) {
            user.businessInfo.postalCode = postalMatch[1];
          }
          
          if (cityMatch && !user.businessInfo.city) {
            user.businessInfo.city = cityMatch[1].trim();
          }
        }

        // Set country from VAT number
        if (!user.businessInfo.country) {
          user.businessInfo.country = formattedVAT.substring(0, 2);
        }
      }
    }

    // Auto-populate company address for business customers
    if (autoPopulate && validationResult.valid && user.role === 'customer' && user.customerType === 'business') {
      if (validationResult.companyName && !user.businessName) {
        user.businessName = validationResult.companyName;
      }

      if (!user.companyAddress) {
        user.companyAddress = {};
      }

      if (validationResult.companyAddress) {
        const addressLines = validationResult.companyAddress.split('\n').filter((line: string) => line.trim());

        if (!user.companyAddress.address && addressLines[0]) {
          user.companyAddress.address = addressLines[0];
        }

        const lastLine = addressLines[addressLines.length - 1];
        if (lastLine) {
          const postalMatch = lastLine.match(/(\d{4,5})/);
          const cityMatch = lastLine.match(/\d{4,5}\s+(.+)$/);

          if (postalMatch && !user.companyAddress.postalCode) {
            user.companyAddress.postalCode = postalMatch[1];
          }

          if (cityMatch && !user.companyAddress.city) {
            user.companyAddress.city = cityMatch[1].trim();
          }
        }

        if (!user.companyAddress.country) {
          user.companyAddress.country = formattedVAT.substring(0, 2);
        }
      }
    }

    await user.save();
    return res.status(200).json({
      success: true,
      msg: "VAT validated and information updated successfully",
      data: {
        vatNumber: formattedVAT,
        isVatVerified: validationResult.valid,
        companyName: validationResult.companyName,
        companyAddress: validationResult.companyAddress,
        autoPopulated: autoPopulate && validationResult.valid,
        businessInfo: user.businessInfo,
        customerBusinessName: user.businessName,
        customerCompanyAddress: user.companyAddress
      }
    });

  } catch (error: any) {
    return res.status(500).json({
      success: false,
      msg: "Failed to validate VAT number"
    });
  }
};

export const updateUserVAT = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        msg: "Authentication required"
      });
    }

    const { vatNumber } = req.body;

    await connecToDatabase();
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    // Check if user is a professional or customer
    if (user.role !== 'professional' && user.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "VAT number can only be added by professionals and customers"
      });
    }

    let isVatVerified = false;
    let formattedVAT = '';

    if (vatNumber) {
      formattedVAT = formatVATNumber(vatNumber);

      // Basic format validation
      if (!isValidVATFormat(formattedVAT)) {
        return res.status(400).json({
          success: false,
          msg: "Invalid VAT number format"
        });
      }

      // Validate with VIES API (but don't prevent saving if it fails)
      const validationResult = await validateVATNumber(formattedVAT);
      isVatVerified = validationResult.valid;

      console.log(`💾 VAT Save: VAT ${formattedVAT} - Format valid, VIES verified: ${isVatVerified}`);
    }

    // Update user
    console.log(`💾 VAT Save: Updating user ${user.email} - VAT: ${formattedVAT || 'REMOVED'}, Verified: ${isVatVerified}`);
    user.vatNumber = formattedVAT || undefined;
    user.isVatVerified = isVatVerified;
    await user.save();
    console.log(`✅ VAT Save: User updated successfully`);

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
      isVatVerified: user.isVatVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };

    return res.status(200).json({
      success: true,
      msg: vatNumber ? "VAT number updated successfully" : "VAT number removed successfully",
      user: userResponse
    });

  } catch (error: any) {
    console.error('Update VAT error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update VAT number"
    });
  }
};