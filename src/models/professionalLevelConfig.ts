import mongoose, { Document, Schema, Model } from 'mongoose';

export type ProfessionalLevelName = 'New' | 'Rising' | 'Level 1' | 'Level 2' | 'Expert';

export interface IProfessionalLevel {
  name: ProfessionalLevelName;
  order: number;
  criteria: {
    minCompletedBookings: number;
    minDaysActive: number;
    minAvgRating: number;
    minOnTimePercentage: number;
    minResponseRate: number;
  };
  perks: {
    badge: string;
    commissionReduction: number; // percentage points off normal commission
    searchRankingBoost: number; // multiplier e.g. 1.2
  };
  pointsBoostRatio: number; // how many points = 1 extra booking credit toward level
  isActive: boolean;
  color: string;
  icon: string;
}

export interface IProfessionalLevelConfig extends Document {
  levels: IProfessionalLevel[];
  lastModifiedBy: mongoose.Types.ObjectId;
  lastModified: Date;
  version: number;
}

export interface IProfessionalLevelConfigModel extends Model<IProfessionalLevelConfig> {
  getCurrentConfig(): Promise<IProfessionalLevelConfig>;
}

const professionalLevelSchema = new Schema({
  name: {
    type: String,
    required: true,
    enum: ['New', 'Rising', 'Level 1', 'Level 2', 'Expert']
  },
  order: {
    type: Number,
    required: true
  },
  criteria: {
    minCompletedBookings: { type: Number, required: true, min: 0 },
    minDaysActive: { type: Number, required: true, min: 0 },
    minAvgRating: { type: Number, required: true, min: 0, max: 5 },
    minOnTimePercentage: { type: Number, required: true, min: 0, max: 100 },
    minResponseRate: { type: Number, required: true, min: 0, max: 100 }
  },
  perks: {
    badge: { type: String, required: true },
    commissionReduction: { type: Number, required: true, min: 0, max: 100, default: 0 },
    searchRankingBoost: { type: Number, required: true, min: 1, default: 1 }
  },
  pointsBoostRatio: {
    type: Number,
    required: true,
    min: 1,
    default: 100 // 100 points = 1 extra booking credit
  },
  isActive: {
    type: Boolean,
    default: true
  },
  color: {
    type: String,
    required: true,
    default: '#6B7280'
  },
  icon: {
    type: String,
    required: true,
    default: 'star'
  }
}, { _id: false });

const professionalLevelConfigSchema = new Schema<IProfessionalLevelConfig>({
  levels: [professionalLevelSchema],
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  lastModified: {
    type: Date,
    default: Date.now
  },
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

professionalLevelConfigSchema.pre('save', function(next) {
  this.levels.sort((a, b) => a.order - b.order);
  this.version += 1;
  this.lastModified = new Date();
  next();
});

professionalLevelConfigSchema.statics.getCurrentConfig = async function(): Promise<IProfessionalLevelConfig> {
  const defaultLevels = [
    {
      name: 'New', order: 1,
      criteria: { minCompletedBookings: 0, minDaysActive: 0, minAvgRating: 0, minOnTimePercentage: 0, minResponseRate: 0 },
      perks: { badge: 'new-badge', commissionReduction: 0, searchRankingBoost: 1 },
      pointsBoostRatio: 100, isActive: true, color: '#6B7280', icon: 'user'
    },
    {
      name: 'Rising', order: 2,
      criteria: { minCompletedBookings: 5, minDaysActive: 60, minAvgRating: 4.0, minOnTimePercentage: 80, minResponseRate: 80 },
      perks: { badge: 'rising-badge', commissionReduction: 1, searchRankingBoost: 1.1 },
      pointsBoostRatio: 100, isActive: true, color: '#10B981', icon: 'trending-up'
    },
    {
      name: 'Level 1', order: 3,
      criteria: { minCompletedBookings: 15, minDaysActive: 120, minAvgRating: 4.3, minOnTimePercentage: 85, minResponseRate: 90 },
      perks: { badge: 'level-1-badge', commissionReduction: 2, searchRankingBoost: 1.2 },
      pointsBoostRatio: 100, isActive: true, color: '#3B82F6', icon: 'award'
    },
    {
      name: 'Level 2', order: 4,
      criteria: { minCompletedBookings: 40, minDaysActive: 250, minAvgRating: 4.5, minOnTimePercentage: 90, minResponseRate: 95 },
      perks: { badge: 'top-professional', commissionReduction: 3, searchRankingBoost: 1.4 },
      pointsBoostRatio: 100, isActive: true, color: '#8B5CF6', icon: 'shield'
    },
    {
      name: 'Expert', order: 5,
      criteria: { minCompletedBookings: 80, minDaysActive: 365, minAvgRating: 4.7, minOnTimePercentage: 95, minResponseRate: 95 },
      perks: { badge: 'expert-badge', commissionReduction: 5, searchRankingBoost: 1.6 },
      pointsBoostRatio: 100, isActive: true, color: '#F59E0B', icon: 'crown'
    }
  ];

  const defaultAdmin = await mongoose.model('User').findOne({ role: 'admin' }).select('_id');

  const config = await this.findOneAndUpdate(
    {},
    {
      $setOnInsert: {
        levels: defaultLevels,
        lastModifiedBy: defaultAdmin?._id,
        lastModified: new Date(),
        version: 1
      }
    },
    { upsert: true, new: true }
  );

  return config;
};

const ProfessionalLevelConfig = mongoose.model('ProfessionalLevelConfig', professionalLevelConfigSchema) as unknown as IProfessionalLevelConfigModel;

export default ProfessionalLevelConfig;
