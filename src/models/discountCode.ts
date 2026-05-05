import mongoose, { Document, Schema } from 'mongoose';

export type DiscountCodeType = 'percentage' | 'fixed';

export interface IDiscountCode extends Document {
  code: string;
  type: DiscountCodeType;
  value: number;
  maxDiscountAmount?: number;
  minBookingAmount?: number;
  activeCountries: string[];
  applicableServices: string[];
  validFrom: Date;
  validUntil: Date;
  usageLimit?: number;
  perUserLimit: number;
  usageCount: number;
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const discountCodeSchema = new Schema<IDiscountCode>({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true
  },
  type: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true
  },
  value: {
    type: Number,
    required: true,
    min: 0
  },
  maxDiscountAmount: {
    type: Number,
    min: 0
  },
  minBookingAmount: {
    type: Number,
    min: 0
  },
  activeCountries: {
    type: [String],
    default: []
  },
  applicableServices: {
    type: [String],
    default: []
  },
  validFrom: {
    type: Date,
    required: true
  },
  validUntil: {
    type: Date,
    required: true
  },
  usageLimit: {
    type: Number,
    min: 1
  },
  perUserLimit: {
    type: Number,
    default: 1,
    min: 1
  },
  usageCount: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  description: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

discountCodeSchema.index({ isActive: 1, validFrom: 1, validUntil: 1 });
discountCodeSchema.index({ createdAt: -1 });

const DiscountCode = mongoose.model<IDiscountCode>('DiscountCode', discountCodeSchema);

export default DiscountCode;
