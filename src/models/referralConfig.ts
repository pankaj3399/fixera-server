import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IReferralConfig extends Document {
  isEnabled: boolean;
  referrerRewardAmount: number; // e.g., 15 = €15 credit
  referredCustomerDiscountType: 'percentage' | 'fixed';
  referredCustomerDiscountValue: number; // e.g., 10 = 10% or €10
  referredCustomerDiscountMaxAmount: number; // max discount cap (e.g., €25)
  referredProfessionalCommissionReduction: number; // e.g., 50 = 50% off commission
  referredProfessionalBenefitBookings: number; // number of bookings with reduced commission
  referralExpiryDays: number; // days for referred user to complete qualifying action
  creditExpiryMonths: number; // how long earned credits last
  maxReferralsPerUser: number; // annual cap
  minBookingAmountForTrigger: number; // minimum first booking value to qualify
  lastModifiedBy: mongoose.Types.ObjectId;
  lastModified: Date;
}

export interface IReferralConfigModel extends Model<IReferralConfig> {
  getCurrentConfig(): Promise<IReferralConfig>;
}

export const DEFAULT_REFERRAL_CONFIG = {
  isEnabled: false,
  referrerRewardAmount: 15,
  referredCustomerDiscountType: 'percentage' as const,
  referredCustomerDiscountValue: 10,
  referredCustomerDiscountMaxAmount: 25,
  referredProfessionalCommissionReduction: 50,
  referredProfessionalBenefitBookings: 3,
  referralExpiryDays: 90,
  creditExpiryMonths: 6,
  maxReferralsPerUser: 50,
  minBookingAmountForTrigger: 25,
};

const referralConfigSchema = new Schema<IReferralConfig>({
  isEnabled: {
    type: Boolean,
    default: DEFAULT_REFERRAL_CONFIG.isEnabled
  },
  referrerRewardAmount: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.referrerRewardAmount,
    min: 0
  },
  referredCustomerDiscountType: {
    type: String,
    enum: ['percentage', 'fixed'],
    default: DEFAULT_REFERRAL_CONFIG.referredCustomerDiscountType
  },
  referredCustomerDiscountValue: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.referredCustomerDiscountValue,
    min: 0
  },
  referredCustomerDiscountMaxAmount: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.referredCustomerDiscountMaxAmount,
    min: 0
  },
  referredProfessionalCommissionReduction: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.referredProfessionalCommissionReduction,
    min: 0,
    max: 100
  },
  referredProfessionalBenefitBookings: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.referredProfessionalBenefitBookings,
    min: 0
  },
  referralExpiryDays: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.referralExpiryDays,
    min: 1
  },
  creditExpiryMonths: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.creditExpiryMonths,
    min: 1
  },
  maxReferralsPerUser: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.maxReferralsPerUser,
    min: 1
  },
  minBookingAmountForTrigger: {
    type: Number,
    default: DEFAULT_REFERRAL_CONFIG.minBookingAmountForTrigger,
    min: 0
  },
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastModified: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Singleton: use findOneAndUpdate with upsert instead of relying on index

referralConfigSchema.statics.getCurrentConfig = async function(): Promise<IReferralConfig> {
  const config = await this.findOneAndUpdate(
    {},
    { $setOnInsert: { ...DEFAULT_REFERRAL_CONFIG, lastModified: new Date() } },
    { upsert: true, new: true }
  );

  return config;
};

const ReferralConfig = mongoose.model('ReferralConfig', referralConfigSchema) as unknown as IReferralConfigModel;

export default ReferralConfig;
