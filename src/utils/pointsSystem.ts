import mongoose from 'mongoose';
import User from '../models/user';
import PointTransaction from '../models/pointTransaction';
import PointsConfig from '../models/pointsConfig';
import type { PointSource } from '../models/pointTransaction';

/**
 * Add points to a user's balance with transaction logging.
 */
export const addPoints = async (
  userId: mongoose.Types.ObjectId | string,
  amount: number,
  source: PointSource,
  description: string,
  opts?: {
    relatedBooking?: mongoose.Types.ObjectId;
    relatedReferral?: mongoose.Types.ObjectId;
    session?: mongoose.ClientSession;
    metadata?: Record<string, any>;
  }
): Promise<{ newBalance: number; transaction: any }> => {
  if (amount <= 0) {
    throw new Error('Points amount must be positive');
  }

  const config = await PointsConfig.getCurrentConfig();

  // Calculate expiry
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + config.expiryMonths);

  const ownedSession = !opts?.session;
  const session = opts?.session || await mongoose.startSession();
  const manageTransaction = !session.inTransaction();

  try {
    if (manageTransaction) {
      session.startTransaction();
    }

    const prevUser = await User.findOneAndUpdate(
      { _id: userId, role: { $ne: 'employee' } },
      { $inc: { points: amount }, $max: { pointsExpiry: expiresAt } },
      { returnDocument: 'before' as const, session }
    );
    if (!prevUser) {
      const exists = await User.findById(userId).select('_id role').session(session);
      if (!exists) throw new Error('User not found');
      if (exists.role === 'employee') throw new Error('Employees cannot earn or spend points');
      throw new Error('User not found');
    }

    const balanceBefore = prevUser.points || 0;
    const balanceAfter = balanceBefore + amount;

    const txData = {
      userId,
      type: 'earn' as const,
      source,
      amount,
      balanceBefore,
      balanceAfter,
      description,
      expiresAt,
      relatedBooking: opts?.relatedBooking,
      relatedReferral: opts?.relatedReferral,
      metadata: opts?.metadata
    };

    const [transaction] = await PointTransaction.create([{ ...txData }], { session });

    if (manageTransaction) {
      await session.commitTransaction();
    }

    console.log(`Points: +${amount} to user=${userId} (${source}): ${description}. Balance: ${balanceBefore} -> ${balanceAfter}`);

    return { newBalance: balanceAfter, transaction };
  } catch (error) {
    if (manageTransaction && session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    if (ownedSession) {
      await session.endSession();
    }
  }
};

/**
 * Deduct points from a user's balance with transaction logging.
 */
export const deductPoints = async (
  userId: mongoose.Types.ObjectId | string,
  amount: number,
  source: PointSource,
  description: string,
  opts?: {
    relatedBooking?: mongoose.Types.ObjectId;
    session?: mongoose.ClientSession;
    metadata?: Record<string, any>;
  }
): Promise<{ newBalance: number; transaction: any }> => {
  if (amount <= 0) {
    throw new Error('Points amount must be positive');
  }

  // Atomically decrement with guard and return the previous document
  const updateOpts: Record<string, any> = { returnDocument: 'before' as const };
  if (opts?.session) updateOpts.session = opts.session;

  const prevUser = await User.findOneAndUpdate(
    { _id: userId, points: { $gte: amount }, role: { $ne: 'employee' } },
    { $inc: { points: -amount } },
    updateOpts
  );

  if (!prevUser) {
    // Distinguish between user-not-found, employee, and insufficient balance
    const exists = await User.findById(userId).select('_id role points');
    if (!exists) throw new Error('User not found');
    if (exists.role === 'employee') throw new Error('Employees cannot earn or spend points');
    throw new Error(`Insufficient points: has ${exists.points || 0}, needs ${amount}`);
  }

  const balanceBefore = prevUser.points || 0;
  const balanceAfter = balanceBefore - amount;

  // Create transaction record
  const txData = {
    userId,
    type: 'spend' as const,
    source,
    amount,
    balanceBefore,
    balanceAfter,
    description,
    relatedBooking: opts?.relatedBooking,
    metadata: opts?.metadata
  };

  const createOpts = opts?.session ? { session: opts.session } : {};
  const [transaction] = await PointTransaction.create([txData], createOpts);

  console.log(`Points: -${amount} from user=${userId} (${source}): ${description}. Balance: ${balanceBefore} -> ${balanceAfter}`);

  return { newBalance: balanceAfter, transaction };
};

/**
 * Preview points redemption for a booking.
 * Returns how much discount the points would provide.
 */
export const previewPointsRedemption = async (
  userId: mongoose.Types.ObjectId | string,
  pointsToRedeem: number,
  bookingAmount: number
): Promise<{
  pointsToRedeem: number;
  discountAmount: number;
  newBalance: number;
  conversionRate: number;
}> => {
  const config = await PointsConfig.getCurrentConfig();

  if (!config.isEnabled) {
    return { pointsToRedeem: 0, discountAmount: 0, newBalance: 0, conversionRate: config.conversionRate };
  }

  const user = await User.findById(userId).select('points pointsExpiry');
  if (!user) {
    throw new Error('User not found');
  }

  const available = user.points || 0;

  // Check expiry
  if (user.pointsExpiry && new Date() > user.pointsExpiry) {
    return { pointsToRedeem: 0, discountAmount: 0, newBalance: 0, conversionRate: config.conversionRate };
  }

  // Cap to what user has
  let redeemable = Math.min(pointsToRedeem, available);

  // Must meet minimum
  if (redeemable < config.minRedemptionPoints) {
    return { pointsToRedeem: 0, discountAmount: 0, newBalance: available, conversionRate: config.conversionRate };
  }

  // Calculate discount value
  let discountAmount = redeemable * config.conversionRate;

  // Don't let discount exceed booking amount (leave at least EUR0.50 for Stripe)
  const maxDiscount = Math.max(0, bookingAmount - 0.50);
  if (discountAmount > maxDiscount) {
    redeemable = Math.floor(maxDiscount / config.conversionRate);
    discountAmount = redeemable * config.conversionRate;
  }

  return {
    pointsToRedeem: redeemable,
    discountAmount: Math.round(discountAmount * 100) / 100,
    newBalance: available - redeemable,
    conversionRate: config.conversionRate
  };
};

/**
 * Expire points for all users whose points have passed the expiry date.
 * Should be called periodically (e.g., daily cron job).
 */
export const expirePoints = async (): Promise<number> => {
  const now = new Date();

  const expiredUsers = await User.find({
    points: { $gt: 0 },
    pointsExpiry: { $lte: now }
  }).select('_id points');

  let count = 0;
  for (const user of expiredUsers) {
    const amount = user.points || 0;
    if (amount <= 0) continue;

    try {
      await User.findByIdAndUpdate(user._id, {
        $set: { points: 0, pointsExpiry: undefined }
      });

      await PointTransaction.create({
        userId: user._id,
        type: 'spend',
        source: 'expiry',
        amount,
        balanceBefore: amount,
        balanceAfter: 0,
        description: 'Points expired'
      });

      count++;
    } catch (err) {
      console.error(`Points: Failed to expire points for user=${user._id}:`, err);
    }
  }

  if (count > 0) {
    console.log(`Points: Expired points for ${count} users`);
  }

  return count;
};

/**
 * Get a user's point transaction history.
 */
export const getPointHistory = async (
  userId: mongoose.Types.ObjectId | string,
  limit: number = 20,
  offset: number = 0
): Promise<{ transactions: any[]; total: number }> => {
  const [transactions, total] = await Promise.all([
    PointTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit),
    PointTransaction.countDocuments({ userId })
  ]);

  return { transactions, total };
};

/**
 * Get a user's current points balance and config info.
 */
export const getPointsBalance = async (
  userId: mongoose.Types.ObjectId | string
): Promise<{
  points: number;
  pointsExpiry: Date | null;
  conversionRate: number;
  euroValue: number;
  isExpired: boolean;
}> => {
  const [user, config] = await Promise.all([
    User.findById(userId).select('points pointsExpiry'),
    PointsConfig.getCurrentConfig()
  ]);

  if (!user) {
    throw new Error('User not found');
  }

  const points = user.points || 0;
  const isExpired = !!(user.pointsExpiry && new Date() > user.pointsExpiry);
  const activePoints = isExpired ? 0 : points;

  return {
    points: activePoints,
    pointsExpiry: user.pointsExpiry || null,
    conversionRate: config.conversionRate,
    euroValue: Math.round(activePoints * config.conversionRate * 100) / 100,
    isExpired
  };
};
