import User from '../models/user';
import Referral from '../models/referral';
import ReferralConfig from '../models/referralConfig';
import mongoose from 'mongoose';

/**
 * Generate a unique referral code for a user.
 * Format: FIXERA-{NAME}-{4-CHAR-ID}
 */
export const generateReferralCode = async (userName: string): Promise<string> => {
  const namePart = userName
    .trim()
    .split(/\s+/)[0] // first name only
    .toUpperCase()
    .replace(/[^A-Z]/g, '') // only letters
    .substring(0, 8); // max 8 chars

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude confusing chars (0,O,I,1)
  let code: string;
  let attempts = 0;

  let isUnique = false;
  do {
    let randomPart = '';
    for (let i = 0; i < 4; i++) {
      randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    code = `FIXERA-${namePart}-${randomPart}`;
    attempts++;

    const existing = await User.findOne({ referralCode: code });
    if (!existing) {
      isUnique = true;
      break;
    }
  } while (attempts < 10);

  if (!isUnique) {
    throw new Error('Unable to generate unique referral code after 10 attempts');
  }

  return code;
};

/**
 * Validate a referral code and return the referrer user.
 */
export const validateReferralCode = async (code: string): Promise<{
  valid: boolean;
  referrer?: any;
  error?: string;
}> => {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'Invalid referral code' };
  }

  const config = await ReferralConfig.getCurrentConfig();
  if (!config.isEnabled) {
    return { valid: false, error: 'Referral program is currently disabled' };
  }

  const normalizedCode = code.trim().toUpperCase();
  const referrer = await User.findOne({ referralCode: normalizedCode });

  if (!referrer) {
    return { valid: false, error: 'Referral code not found' };
  }

  if (!['customer', 'professional'].includes(referrer.role)) {
    return { valid: false, error: 'Invalid referral code' };
  }

  // Check annual referral cap
  const yearStart = new Date();
  yearStart.setMonth(0, 1);
  yearStart.setHours(0, 0, 0, 0);

  const yearlyReferrals = await Referral.countDocuments({
    referrer: referrer._id,
    createdAt: { $gte: yearStart }
  });

  if (yearlyReferrals >= config.maxReferralsPerUser) {
    return { valid: false, error: 'This referral code has reached its annual limit' };
  }

  return { valid: true, referrer };
};

/**
 * Create a referral record when a new user signs up with a referral code.
 */
export const createReferral = async (
  referrerId: mongoose.Types.ObjectId,
  referredUserId: mongoose.Types.ObjectId,
  referralCode: string,
  ipAddress?: string,
  session?: mongoose.ClientSession
): Promise<any> => {
  const config = await ReferralConfig.getCurrentConfig();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.referralExpiryDays);

  const createOpts = session ? { session } : {};
  const [referral] = await Referral.create([{
    referrer: referrerId,
    referredUser: referredUserId,
    referralCode: referralCode.trim().toUpperCase(),
    status: 'pending',
    referrerRewardAmount: 0,
    referredUserDiscountApplied: false,
    expiresAt,
    ipAddress
  }], createOpts);

  // Update referrer's total referrals count
  await User.findByIdAndUpdate(referrerId, {
    $inc: { totalReferrals: 1 }
  }, session ? { session } : {});

  return referral;
};

/**
 * Process referral completion when a referred user completes their first qualifying booking.
 * Called from the booking completion flow.
 */
export const processReferralCompletion = async (
  userId: mongoose.Types.ObjectId,
  bookingId: mongoose.Types.ObjectId,
  bookingAmount: number
): Promise<{ completed: boolean; error?: string }> => {
  const config = await ReferralConfig.getCurrentConfig();
  if (!config.isEnabled) {
    return { completed: false, error: 'Referral program disabled' };
  }

  // Check minimum booking amount
  if (bookingAmount < config.minBookingAmountForTrigger) {
    return { completed: false, error: 'Booking amount below minimum threshold' };
  }

  // Atomically claim the pending referral to prevent duplicate processing
  const referral = await Referral.findOneAndUpdate(
    {
      referredUser: userId,
      status: 'pending',
      expiresAt: { $gt: new Date() }
    },
    {
      $set: {
        status: 'completed',
        qualifyingBooking: bookingId,
        referrerRewardAmount: config.referrerRewardAmount,
        referrerRewardIssuedAt: new Date()
      }
    },
    { new: true }
  );

  if (!referral) {
    return { completed: false, error: 'No pending referral found' };
  }

  // Check if referrer account still exists and is active
  const referrer = await User.findById(referral.referrer);
  if (!referrer) {
    return { completed: true };
  }

  // Issue reward to referrer — use $max for expiry so we never shorten an existing later expiry
  const creditExpiryDate = new Date();
  creditExpiryDate.setMonth(creditExpiryDate.getMonth() + config.creditExpiryMonths);

  await User.findByIdAndUpdate(referral.referrer, {
    $inc: {
      referralCredits: config.referrerRewardAmount,
      completedReferrals: 1
    },
    $max: {
      referralCreditsExpiry: creditExpiryDate
    }
  });

  console.log(`Referral completed: referrer=${referral.referrer} earned €${config.referrerRewardAmount} for referred user=${userId}`);

  return { completed: true };
};

/**
 * Get referral stats for a user (for dashboard display).
 */
export const getUserReferralStats = async (userId: mongoose.Types.ObjectId) => {
  const user = await User.findById(userId).select('referralCode referralCredits referralCreditsExpiry totalReferrals completedReferrals name');
  if (!user) return null;

  const referrals = await Referral.find({ referrer: userId })
    .populate('referredUser', 'name createdAt')
    .sort({ createdAt: -1 })
    .limit(50);

  const pendingCount = referrals.filter(r => r.status === 'pending').length;
  const completedCount = referrals.filter(r => r.status === 'completed').length;
  const totalCreditsEarned = referrals
    .filter(r => r.status === 'completed')
    .reduce((sum, r) => sum + r.referrerRewardAmount, 0);

  return {
    referralCode: user.referralCode,
    referralCredits: user.referralCredits || 0,
    referralCreditsExpiry: user.referralCreditsExpiry,
    totalReferrals: user.totalReferrals || 0,
    pendingReferrals: pendingCount,
    completedReferrals: completedCount,
    totalCreditsEarned,
    referrals: referrals.map(r => ({
      _id: r._id,
      referredUser: r.referredUser,
      status: r.status,
      rewardAmount: r.referrerRewardAmount,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt
    }))
  };
};

/**
 * Expire pending referrals that have passed their expiry date.
 * Should be called periodically (e.g., daily cron job).
 */
export const expirePendingReferrals = async (): Promise<number> => {
  const result = await Referral.updateMany(
    {
      status: 'pending',
      expiresAt: { $lte: new Date() }
    },
    {
      $set: { status: 'expired' }
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`Expired ${result.modifiedCount} pending referrals`);
  }

  return result.modifiedCount;
};
