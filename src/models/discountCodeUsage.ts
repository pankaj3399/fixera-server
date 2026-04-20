import mongoose, { Document, Schema } from 'mongoose';

export interface IDiscountCodeUsage extends Document {
  code: mongoose.Types.ObjectId;
  codeString: string;
  user: mongoose.Types.ObjectId;
  booking: mongoose.Types.ObjectId;
  amountDiscounted: number;
  redeemedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const discountCodeUsageSchema = new Schema<IDiscountCodeUsage>({
  code: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DiscountCode',
    required: true,
    index: true
  },
  codeString: {
    type: String,
    required: true,
    uppercase: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  booking: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking',
    required: true
  },
  amountDiscounted: {
    type: Number,
    required: true,
    min: 0
  },
  redeemedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

discountCodeUsageSchema.index({ code: 1, user: 1 });
discountCodeUsageSchema.index({ booking: 1 }, { unique: true });

const DiscountCodeUsage = mongoose.model<IDiscountCodeUsage>('DiscountCodeUsage', discountCodeUsageSchema);

export default DiscountCodeUsage;
