import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IPointsConfig extends Document {
  isEnabled: boolean;
  conversionRate: number; // 1 point = X EUR (default 1)
  expiryMonths: number; // points expire after X months
  minRedemptionPoints: number; // minimum points to redeem
  professionalEarningPerBooking: number; // points earned by professional per completed booking
  customerEarningPerBooking: number; // points earned by customer per completed booking
  lastModifiedBy: mongoose.Types.ObjectId;
  lastModified: Date;
}

export interface IPointsConfigModel extends Model<IPointsConfig> {
  getCurrentConfig(): Promise<IPointsConfig>;
}

export const DEFAULT_POINTS_CONFIG = {
  isEnabled: true,
  conversionRate: 1,
  expiryMonths: 6,
  minRedemptionPoints: 1,
  professionalEarningPerBooking: 10,
  customerEarningPerBooking: 5,
};

const pointsConfigSchema = new Schema<IPointsConfig>({
  isEnabled: {
    type: Boolean,
    default: DEFAULT_POINTS_CONFIG.isEnabled
  },
  conversionRate: {
    type: Number,
    default: DEFAULT_POINTS_CONFIG.conversionRate,
    min: 0.01
  },
  expiryMonths: {
    type: Number,
    default: DEFAULT_POINTS_CONFIG.expiryMonths,
    min: 1
  },
  minRedemptionPoints: {
    type: Number,
    default: DEFAULT_POINTS_CONFIG.minRedemptionPoints,
    min: 1
  },
  professionalEarningPerBooking: {
    type: Number,
    default: DEFAULT_POINTS_CONFIG.professionalEarningPerBooking,
    min: 0
  },
  customerEarningPerBooking: {
    type: Number,
    default: DEFAULT_POINTS_CONFIG.customerEarningPerBooking,
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

pointsConfigSchema.statics.getCurrentConfig = async function(): Promise<IPointsConfig> {
  const config = await this.findOneAndUpdate(
    {},
    { $setOnInsert: { ...DEFAULT_POINTS_CONFIG, lastModified: new Date() } },
    { upsert: true, new: true }
  );
  let needsSave = false;
  if (config.professionalEarningPerBooking == null) {
    config.professionalEarningPerBooking = DEFAULT_POINTS_CONFIG.professionalEarningPerBooking;
    needsSave = true;
  }
  if (config.customerEarningPerBooking == null) {
    config.customerEarningPerBooking = DEFAULT_POINTS_CONFIG.customerEarningPerBooking;
    needsSave = true;
  }
  if (needsSave) await config.save();
  return config;
};

const PointsConfig = mongoose.model('PointsConfig', pointsConfigSchema) as unknown as IPointsConfigModel;

export default PointsConfig;
