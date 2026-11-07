import mongoose, { Document, Schema, Model } from 'mongoose';

export interface ILoyaltyTier extends Document {
  name: string; // Bronze, Silver, Gold, Platinum
  minSpendingAmount: number; // minimum total booking amount to reach this tier
  maxSpendingAmount?: number; // null for highest tier
  discountPercentage: number; // auto-discount percentage for this tier (e.g., 5 = 5% off bookings)
  maxDiscountAmount?: number; // maximum discount per booking in currency (null = no cap)
  benefits: string[]; // list of benefits for this tier
  color: string; // hex color for UI
  icon: string; // icon name for UI
  isActive: boolean;
  order: number; // display order
}

export interface ILoyaltyConfig extends Document {
  globalSettings: {
    isEnabled: boolean;
    minBookingAmount: number; // minimum booking amount to earn points
    pointsExpiryMonths?: number; // points expire after X months (null = never)
    roundingRule: 'floor' | 'ceil' | 'round'; // how to round partial points
  };
  tiers: ILoyaltyTier[];
  lastModifiedBy: mongoose.Types.ObjectId;
  lastModified: Date;
  legacyTierBackfilledAt?: Date;
  version: number; // for tracking config changes
}

export interface ILoyaltyConfigModel extends Model<ILoyaltyConfig> {
  getCurrentConfig(): Promise<ILoyaltyConfig>;
  backfillConfirmedLegacyConfig(id: string, expectedVersion: number): Promise<boolean>;
}

const loyaltyTierSchema = new Schema<ILoyaltyTier>({
  name: {
    type: String,
    required: true,
    enum: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']
  },
  minSpendingAmount: {
    type: Number,
    required: true,
    min: 0
  },
  maxSpendingAmount: {
    type: Number,
    default: null
  },
  discountPercentage: {
    type: Number,
    required: true,
    min: 0,
    max: 50,
    default: 0
  },
  maxDiscountAmount: {
    type: Number,
    min: 0,
    default: null
  },
  benefits: [{
    type: String,
    required: true
  }],
  color: {
    type: String,
    required: true,
    default: '#6B7280' // gray
  },
  icon: {
    type: String,
    required: true,
    default: 'star'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    required: true
  },
});

const loyaltyConfigSchema = new Schema<ILoyaltyConfig>({
  globalSettings: {
    isEnabled: {
      type: Boolean,
      default: true
    },
    minBookingAmount: {
      type: Number,
      default: 10, // $10 minimum
      min: 0
    },
    pointsExpiryMonths: {
      type: Number,
      default: null // points never expire by default
    },
    roundingRule: {
      type: String,
      enum: ['floor', 'ceil', 'round'],
      default: 'floor'
    }
  },
  tiers: [loyaltyTierSchema],
  lastModifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  lastModified: {
    type: Date,
    default: Date.now
  },
  legacyTierBackfilledAt: { type: Date },
  version: {
    type: Number,
    default: 1
  }
}, {
  timestamps: true
});

loyaltyConfigSchema.index({ 'tiers.minSpendingAmount': 1 });
loyaltyConfigSchema.index({}, { unique: true });

// Pre-save middleware to validate tier structure
loyaltyConfigSchema.pre('save', function(next) {
  // Sort tiers by minSpendingAmount
  this.tiers.sort((a, b) => a.minSpendingAmount - b.minSpendingAmount);
  
  // Validate tier ranges don't overlap
  for (let i = 0; i < this.tiers.length - 1; i++) {
    const current = this.tiers[i];
    const nextTier = this.tiers[i + 1];
    
    if (current.maxSpendingAmount && current.maxSpendingAmount >= nextTier.minSpendingAmount) {
      return next(new Error(`Tier ${current.name} maxSpendingAmount ($${current.maxSpendingAmount}) overlaps with ${nextTier.name} minSpendingAmount ($${nextTier.minSpendingAmount})`));
    }
    
    // Set maxSpendingAmount for current tier if not set
    if (!current.maxSpendingAmount) {
      current.maxSpendingAmount = nextTier.minSpendingAmount - 0.01;
    }
  }
  
  // Last tier should have no maxSpendingAmount (unlimited)
  if (this.tiers.length > 0) {
    this.tiers[this.tiers.length - 1].maxSpendingAmount = undefined;
  }
  
  // Increment version
  this.version += 1;
  this.lastModified = new Date();
  
  next();
});

// Standard tier ladder for new configurations and explicit legacy repair.
export const defaultLoyaltyTiers = () => [
  {
    name: 'Bronze',
    minSpendingAmount: 0,
    maxSpendingAmount: 999.99,
    discountPercentage: 0,
    maxDiscountAmount: null,
    benefits: [
      'Standard customer support',
      'Basic booking features',
      'Email notifications'
    ],
    color: '#CD7F32',
    icon: 'bronze-medal',
    isActive: true,
    order: 1,
  },
  {
    name: 'Silver',
    minSpendingAmount: 1000,
    maxSpendingAmount: 4999.99,
    discountPercentage: 2,
    maxDiscountAmount: 25,
    benefits: [
      '2% booking discount',
      'Priority customer support',
      'Early access to new professionals',
      'Extended booking window'
    ],
    color: '#C0C0C0',
    icon: 'silver-medal',
    isActive: true,
    order: 2,
  },
  {
    name: 'Gold',
    minSpendingAmount: 5000,
    maxSpendingAmount: 9999.99,
    discountPercentage: 5,
    maxDiscountAmount: 75,
    benefits: [
      '5% booking discount',
      'Free service call fees',
      'Dedicated account manager',
      'Booking priority scheduling'
    ],
    color: '#FFD700',
    icon: 'gold-medal',
    isActive: true,
    order: 3,
  },
  {
    name: 'Platinum',
    minSpendingAmount: 10000,
    discountPercentage: 10,
    maxDiscountAmount: 150,
    benefits: [
      '10% booking discount',
      'Free cancellations up to 2 hours before',
      'Premium support line',
      'Exclusive seasonal offers',
      'VIP badge and profile highlight'
    ],
    color: '#E5E4E2',
    icon: 'crown',
    isActive: true,
    order: 4,
  }
];

// Static method to get current config or create default
loyaltyConfigSchema.statics.getCurrentConfig = async function(): Promise<ILoyaltyConfig> {
  let config = await this.findOne();

  if (!config) {
    // Create default configuration
    const defaultAdmin = await mongoose.model('User').findOne({ role: 'admin' });

    config = await this.create({
      globalSettings: {
        isEnabled: true,
        minBookingAmount: 10,
        pointsExpiryMonths: null,
        roundingRule: 'floor'
      },
      tiers: defaultLoyaltyTiers(),
      lastModifiedBy: defaultAdmin?._id,
      lastModified: new Date(),
      version: 1
    });
  }

  return config;
};

/** One-off repair only after an operator confirms this exact legacy id/version.
 * Reads never restore tiers. Customized thresholds require explicit admin
 * reconciliation; the durable marker preserves later intentional removals.
 */
loyaltyConfigSchema.statics.backfillConfirmedLegacyConfig = async function(
  id: string, expectedVersion: number,
): Promise<boolean> {
  const config = await this.findOne({ _id: id, version: expectedVersion,
    legacyTierBackfilledAt: { $exists: false } });
  if (!config) return false;
  const defaults = defaultLoyaltyTiers();
  const tiers = [...config.tiers].sort((a, b) => a.minSpendingAmount - b.minSpendingAmount);
  if (tiers.length !== 3 || tiers.some((tier, index) => {
    const expected = defaults[index];
    return tier.name !== expected.name || tier.minSpendingAmount !== expected.minSpendingAmount
      || (index < 2 ? tier.maxSpendingAmount !== expected.maxSpendingAmount
        : tier.maxSpendingAmount != null && tier.maxSpendingAmount !== expected.maxSpendingAmount);
  })) throw new Error('Legacy tier thresholds must be reconciled before backfill.');
  const planned = tiers.map((tier: any, index) => ({ ...(tier.toObject?.() || tier),
    maxSpendingAmount: defaults[index].maxSpendingAmount }));
  planned.push(defaults[3]);
  for (let index = 0; index < planned.length - 1; index++) {
    if (planned[index].maxSpendingAmount >= planned[index + 1].minSpendingAmount) {
      throw new Error('Legacy tier ranges overlap.');
    }
  }
  const result = await this.updateOne({ _id: config._id, version: expectedVersion,
    tiers: config.tiers, legacyTierBackfilledAt: { $exists: false } }, {
    $set: { tiers: planned, legacyTierBackfilledAt: new Date(), lastModified: new Date() },
    $inc: { version: 1 },
  }, { runValidators: true });
  return result.modifiedCount === 1;
};

const LoyaltyConfig = mongoose.model('LoyaltyConfig', loyaltyConfigSchema) as unknown as ILoyaltyConfigModel;

export default LoyaltyConfig;
