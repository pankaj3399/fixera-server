import { Schema, model, Document } from "mongoose";

export type UserRole = "admin" | "visitor" | "customer" | "professional" | "employee";
export type CustomerType = "individual" | "business";

export interface IUser extends Document {
    name: string;
    password?: string;
    email: string;
    phone: string;
    isPhoneVerified: boolean;
    isEmailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
    role: UserRole;
    verificationCode?: string;
    verificationCodeExpires?: Date;
    vatNumber?: string;
    isVatVerified?: boolean;
    idProofUrl?: string;
    idProofFileName?: string;
    idProofUploadedAt?: Date;
    isIdVerified?: boolean;
    professionalId?: string;
    // Professional approval fields
    professionalStatus?: 'pending' | 'approved' | 'rejected' | 'suspended';
    approvedBy?: string; // Admin user ID who approved
    approvedAt?: Date;
    rejectionReason?: string;
    // Customer-specific fields
    customerType?: CustomerType;
    location?: {
        type: 'Point';
        coordinates: [number, number]; // [longitude, latitude]
        address?: string;
        city?: string;
        country?: string;
        postalCode?: string;
    };
    // Professional-specific fields
    businessInfo?: {
        companyName?: string;
        description?: string;
        website?: string;
        address?: string;
        city?: string;
        country?: string;
        postalCode?: string;
        timezone?: string;
    };
    hourlyRate?: number;
    currency?: string;
    serviceCategories?: string[];
    // Personal availability (professional's own working schedule)
    availability?: {
        monday?: { available: boolean; startTime?: string; endTime?: string; };
        tuesday?: { available: boolean; startTime?: string; endTime?: string; };
        wednesday?: { available: boolean; startTime?: string; endTime?: string; };
        thursday?: { available: boolean; startTime?: string; endTime?: string; };
        friday?: { available: boolean; startTime?: string; endTime?: string; };
        saturday?: { available: boolean; startTime?: string; endTime?: string; };
        sunday?: { available: boolean; startTime?: string; endTime?: string; };
    };
    blockedDates?: {
        date: Date;
        reason?: string;
    }[];
    blockedRanges?: {
        startDate: Date;
        endDate: Date;
        reason?: string;
        createdAt?: Date;
    }[];
    // Company-wide availability (for team members to inherit)
    companyAvailability?: {
        monday?: { available: boolean; startTime?: string; endTime?: string; };
        tuesday?: { available: boolean; startTime?: string; endTime?: string; };
        wednesday?: { available: boolean; startTime?: string; endTime?: string; };
        thursday?: { available: boolean; startTime?: string; endTime?: string; };
        friday?: { available: boolean; startTime?: string; endTime?: string; };
        saturday?: { available: boolean; startTime?: string; endTime?: string; };
        sunday?: { available: boolean; startTime?: string; endTime?: string; };
    };
    companyBlockedDates?: {
        date: Date;
        reason?: string;
        isHoliday?: boolean;
    }[];
    companyBlockedRanges?: {
        startDate: Date;
        endDate: Date;
        reason?: string;
        isHoliday?: boolean;
        createdAt?: Date;
    }[];
    profileCompletedAt?: Date;
    // Loyalty system fields
    loyaltyPoints?: number;
    loyaltyLevel?: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
    totalSpent?: number;
    totalBookings?: number;
    lastLoyaltyUpdate?: Date;
    employee?: {
        companyId?: string;
        invitedBy?: string;
        invitedAt?: Date;
        acceptedAt?: Date;
        isActive?: boolean;
        hasEmail?: boolean;
        availabilityPreference?: 'personal' | 'same_as_company';
        managedByCompany?: boolean;
    };
}

const UserSchema = new Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        unique: true,
    },
    isPhoneVerified: {
        type: Boolean,
        default: false
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    password: {
        type: String,
        required: [true, 'Password is required'],
        minlength: [6, 'Password must be at least 6 characters long'],
        select: false
    },
    role: {
        type: String,
        enum: ['admin', 'visitor', 'customer', 'professional', 'employee'],
        default: 'customer'
    },

    verificationCode: {
        type: String,
        select: false 
    },
    verificationCodeExpires: {
        type: Date,
        select: false 
    },
    vatNumber: {
        type: String,
        required: false,
        trim: true,
        validate: {
            validator: function(v: string) {
                if (!v) return true; // VAT number is optional
                // Basic VAT number format validation (2-letter country code + 4-15 digits/letters)
                return /^[A-Z]{2}[A-Z0-9]{4,15}$/.test(v);
            },
            message: 'Invalid VAT number format'
        }
    },
    isVatVerified: {
        type: Boolean,
        default: false
    },
    idProofUrl: {
        type: String,
        required: false
    },
    idProofFileName: {
        type: String,
        required: false
    },
    idProofUploadedAt: {
        type: Date,
        required: false
    },
    isIdVerified: {
        type: Boolean,
        default: false
    },
    // Professional approval fields
    professionalStatus: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'suspended'],
        default: function(this: IUser) {
            return this.role === 'professional' ? 'pending' : undefined;
        },
        required: function(this: IUser) {
            return this.role === 'professional';
        }
    },
    approvedBy: {
        type: String,
        required: false
    },
    approvedAt: {
        type: Date,
        required: false
    },
    rejectionReason: {
        type: String,
        required: false,
        maxlength: 500
    },
    // Professional-specific fields
    businessInfo: {
        companyName: { type: String, required: false },
        description: { type: String, required: false, maxlength: 1000 },
        website: { type: String, required: false },
        address: { type: String, required: false },
        city: { type: String, required: false },
        country: { type: String, required: false },
        postalCode: { type: String, required: false },
        timezone: { type: String, required: false, default: 'UTC' }
    },
    hourlyRate: {
        type: Number,
        required: false,
        min: 0,
        max: 10000
    },
    currency: {
        type: String,
        required: false,
        default: 'USD',
        enum: ['USD', 'EUR', 'GBP', 'CAD', 'AUD']
    },
    serviceCategories: [{
        type: String,
        required: false
    }],
    availability: {
        monday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        tuesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        wednesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        thursday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        friday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        saturday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        sunday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        }
    },
    blockedDates: [{
        date: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 }
    }],
    blockedRanges: [{
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 },
        createdAt: { type: Date, default: Date.now }
    }],
    companyAvailability: {
        monday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        tuesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        wednesday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        thursday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        friday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        saturday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        },
        sunday: {
            available: { type: Boolean, default: false },
            startTime: { type: String, required: false },
            endTime: { type: String, required: false }
        }
    },
    companyBlockedDates: [{
        date: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 },
        isHoliday: { type: Boolean, default: false }
    }],
    companyBlockedRanges: [{
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        reason: { type: String, required: false, maxlength: 200 },
        isHoliday: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    }],
    profileCompletedAt: {
        type: Date,
        required: false
    },
    // Loyalty system fields
    loyaltyPoints: {
        type: Number,
        default: 0,
        min: 0
    },
    loyaltyLevel: {
        type: String,
        enum: ['Bronze', 'Silver', 'Gold', 'Platinum'],
        default: 'Bronze'
    },
    totalSpent: {
        type: Number,
        default: 0,
        min: 0
    },
    totalBookings: {
        type: Number,
        default: 0,
        min: 0
    },
    lastLoyaltyUpdate: {
        type: Date,
        default: Date.now
    },
    employee: {
        companyId: { type: String, required: false },
        invitedBy: { type: String, required: false },
        invitedAt: { type: Date, required: false },
        acceptedAt: { type: Date, required: false },
        isActive: { type: Boolean, default: true },
        hasEmail: { type: Boolean, default: true },
        availabilityPreference: {
            type: String,
            enum: ['personal', 'same_as_company'],
            default: 'personal',
            required: function(this: IUser) {
                return this.role === 'employee';
            }
        },
        managedByCompany: { type: Boolean, default: false }
    },
    // Customer-specific fields
    customerType: {
        type: String,
        enum: ['individual', 'business'],
        required: function(this: IUser) {
            return this.role === 'customer';
        },
        default: function(this: IUser) {
            return this.role === 'customer' ? 'individual' : undefined;
        }
    },
    location: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: false,
            validate: {
                validator: function(v: number[]) {
                    if (!v || v.length === 0) return true; // Allow empty
                    // Validate longitude and latitude ranges
                    return v.length === 2 &&
                           v[0] >= -180 && v[0] <= 180 && // longitude
                           v[1] >= -90 && v[1] <= 90;     // latitude
                },
                message: 'Invalid coordinates format. Expected [longitude, latitude]'
            }
        },
        address: { type: String, required: false },
        city: { type: String, required: false },
        country: { type: String, required: false },
        postalCode: { type: String, required: false }
    }
}, {
    timestamps: true
});

UserSchema.pre("save", function (next) {
    if (this.role === "professional") {
        this.set("availability", undefined);
    }

    // Clear fields that employees don't need - they only need:
    // basic auth fields, employee.*, blockedDates, blockedRanges
    if (this.role === "employee") {
        // Professional-only fields
        this.set("businessInfo", undefined);
        this.set("hourlyRate", undefined);
        this.set("currency", undefined);
        this.set("serviceCategories", undefined);
        this.set("availability", undefined);
        this.set("companyAvailability", undefined);
        this.set("companyBlockedDates", undefined);
        this.set("companyBlockedRanges", undefined);

        // Professional verification/approval fields
        this.set("vatNumber", undefined);
        this.set("isVatVerified", undefined);
        this.set("idProofUrl", undefined);
        this.set("idProofFileName", undefined);
        this.set("idProofUploadedAt", undefined);
        this.set("isIdVerified", undefined);
        this.set("professionalStatus", undefined);
        this.set("approvedBy", undefined);
        this.set("approvedAt", undefined);
        this.set("rejectionReason", undefined);

        // Customer-only fields
        this.set("customerType", undefined);
        this.set("location", undefined);
        this.set("loyaltyPoints", undefined);
        this.set("loyaltyLevel", undefined);
        this.set("totalSpent", undefined);
        this.set("totalBookings", undefined);
        this.set("lastLoyaltyUpdate", undefined);

        this.set("profileCompletedAt", undefined);
    }
    next();
});

UserSchema.index({ role: 1, professionalStatus: 1 });
UserSchema.index({ role: 1 });
UserSchema.index({ role: 1, loyaltyPoints: 1 });
UserSchema.index({ role: 1, totalSpent: -1 });
UserSchema.index({ 'employee.companyId': 1 });
UserSchema.index({ email: 1 });
UserSchema.index({ phone: 1 });
// Text indexes for search functionality
UserSchema.index({ name: 'text', 'businessInfo.companyName': 'text' });
UserSchema.index({ serviceCategories: 1 });
UserSchema.index({ 'businessInfo.city': 1, 'businessInfo.country': 1 });
UserSchema.index({ hourlyRate: 1 });
// Customer-specific indexes
UserSchema.index({ customerType: 1 });
UserSchema.index({ 'location.coordinates': '2dsphere' }); // Geospatial index for location-based queries
UserSchema.index({ 'location.city': 1, 'location.country': 1 });

const User = model<IUser>('User', UserSchema);

export default User;
