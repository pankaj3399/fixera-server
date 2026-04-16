import mongoose, { Document, Schema } from 'mongoose';

export type ReferralStatus = 'pending' | 'completed' | 'expired' | 'revoked';

export interface IReferral extends Document {
  referrer: mongoose.Types.ObjectId; // user who referred
  referredUser: mongoose.Types.ObjectId; // user who was referred
  referralCode: string; // the code used
  status: ReferralStatus;
  referrerRewardAmount: number; // credit amount awarded to referrer
  referrerRewardType?: 'customer_credit' | 'professional_level_boost';
  referrerRewardIssuedAt?: Date;
  referredUserDiscountApplied: boolean;
  qualifyingBooking?: mongoose.Types.ObjectId; // the booking that triggered completion
  expiresAt: Date; // when this referral expires if not completed
  revokedReason?: string;
  revokedAt?: Date;
  revokedBy?: mongoose.Types.ObjectId;
  ipAddress?: string; // for abuse detection
  createdAt: Date;
  updatedAt: Date;
}

const referralSchema = new Schema<IReferral>({
  referrer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  referredUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  referralCode: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'expired', 'revoked'],
    default: 'pending',
    index: true
  },
  referrerRewardAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  referrerRewardType: {
    type: String,
    enum: ['customer_credit', 'professional_level_boost'],
    required: false
  },
  referrerRewardIssuedAt: {
    type: Date,
    required: false
  },
  referredUserDiscountApplied: {
    type: Boolean,
    default: false
  },
  qualifyingBooking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: false
  },
  expiresAt: {
    type: Date,
    required: true
  },
  revokedReason: {
    type: String,
    required: false,
    maxlength: 500
  },
  revokedAt: {
    type: Date,
    required: false
  },
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  ipAddress: {
    type: String,
    required: false
  }
}, {
  timestamps: true
});

// Compound indexes
referralSchema.index({ referrer: 1, status: 1 });
referralSchema.index({ referredUser: 1, status: 1 });
referralSchema.index({ expiresAt: 1, status: 1 });
// Prevent duplicate referral pairs (excluding cancelled/revoked)
referralSchema.index(
  { referrer: 1, referredUser: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'completed'] } } }
);

const Referral = mongoose.model<IReferral>('Referral', referralSchema);

export default Referral;
