import { Request, Response, NextFunction } from 'express';
import ReferralConfig from '../../models/referralConfig';
import Referral from '../../models/referral';
import User from '../../models/user';

/**
 * GET /api/admin/referral/config
 */
export const getReferralConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await ReferralConfig.getCurrentConfig();
    return res.status(200).json({ success: true, data: config });
  } catch (error) {
    console.error('Get referral config error:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/referral/config
 */
export const updateReferralConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    const {
      isEnabled,
      referrerRewardAmount,
      referredCustomerDiscountType,
      referredCustomerDiscountValue,
      referredCustomerDiscountMaxAmount,
      referredProfessionalCommissionReduction,
      referredProfessionalBenefitBookings,
      referralExpiryDays,
      creditExpiryMonths,
      maxReferralsPerUser,
      minBookingAmountForTrigger
    } = req.body;

    let config = await ReferralConfig.getCurrentConfig();

    if (typeof isEnabled === 'boolean') config.isEnabled = isEnabled;
    if (referrerRewardAmount !== undefined) config.referrerRewardAmount = referrerRewardAmount;
    if (referredCustomerDiscountType) config.referredCustomerDiscountType = referredCustomerDiscountType;
    if (referredCustomerDiscountValue !== undefined) config.referredCustomerDiscountValue = referredCustomerDiscountValue;
    if (referredCustomerDiscountMaxAmount !== undefined) config.referredCustomerDiscountMaxAmount = referredCustomerDiscountMaxAmount;
    if (referredProfessionalCommissionReduction !== undefined) config.referredProfessionalCommissionReduction = referredProfessionalCommissionReduction;
    if (referredProfessionalBenefitBookings !== undefined) config.referredProfessionalBenefitBookings = referredProfessionalBenefitBookings;
    if (referralExpiryDays !== undefined) config.referralExpiryDays = referralExpiryDays;
    if (creditExpiryMonths !== undefined) config.creditExpiryMonths = creditExpiryMonths;
    if (maxReferralsPerUser !== undefined) config.maxReferralsPerUser = maxReferralsPerUser;
    if (minBookingAmountForTrigger !== undefined) config.minBookingAmountForTrigger = minBookingAmountForTrigger;

    config.lastModifiedBy = userId;
    config.lastModified = new Date();

    await config.save();

    return res.status(200).json({
      success: true,
      msg: 'Referral configuration updated',
      data: config
    });
  } catch (error) {
    console.error('Update referral config error:', error);
    next(error);
  }
};

/**
 * GET /api/admin/referral/analytics
 */
export const getReferralAnalytics = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalReferrals,
      thisMonthReferrals,
      pendingReferrals,
      completedReferrals,
      expiredReferrals,
      revokedReferrals,
      totalCreditsIssued,
      totalCurrentCredits,
      topReferrers
    ] = await Promise.all([
      Referral.countDocuments(),
      Referral.countDocuments({ createdAt: { $gte: thisMonthStart } }),
      Referral.countDocuments({ status: 'pending' }),
      Referral.countDocuments({ status: 'completed' }),
      Referral.countDocuments({ status: 'expired' }),
      Referral.countDocuments({ status: 'revoked' }),
      Referral.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$referrerRewardAmount' } } }
      ]),
      User.aggregate([
        { $match: { referralCredits: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$referralCredits' } } }
      ]),
      Referral.aggregate([
        { $group: { _id: '$referrer', total: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } },
        { $sort: { completed: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user'
          }
        },
        { $unwind: '$user' },
        {
          $project: {
            _id: 1,
            name: '$user.name',
            email: '$user.email',
            role: '$user.role',
            totalReferrals: '$total',
            completedReferrals: '$completed'
          }
        }
      ])
    ]);

    const conversionRate = totalReferrals > 0
      ? ((completedReferrals / totalReferrals) * 100).toFixed(1)
      : '0';

    return res.status(200).json({
      success: true,
      data: {
        totalReferrals,
        thisMonthReferrals,
        pendingReferrals,
        completedReferrals,
        expiredReferrals,
        revokedReferrals,
        conversionRate: parseFloat(conversionRate),
        totalCreditsIssued: totalCreditsIssued[0]?.total || 0,
        currentCreditsBalance: totalCurrentCredits[0]?.total || 0,
        topReferrers
      }
    });
  } catch (error) {
    console.error('Get referral analytics error:', error);
    next(error);
  }
};

/**
 * GET /api/admin/referral/list
 * List all referrals with pagination and filtering
 */
export const getReferralList = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;
    let page = parseInt(req.query.page as string, 10);
    let limit = parseInt(req.query.limit as string, 10);
    if (isNaN(page) || page < 1) page = 1;
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (status && ['pending', 'completed', 'expired', 'revoked'].includes(status as string)) {
      filter.status = status;
    }

    const [referrals, total] = await Promise.all([
      Referral.find(filter)
        .populate('referrer', 'name email role')
        .populate('referredUser', 'name email role createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Referral.countDocuments(filter)
    ]);

    return res.status(200).json({
      success: true,
      data: {
        referrals,
        total,
        page,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get referral list error:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/referral/:referralId/revoke
 */
export const revokeReferral = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?._id;
    const { referralId } = req.params;
    const { reason } = req.body;

    const referral = await Referral.findById(referralId);
    if (!referral) {
      return res.status(404).json({ success: false, msg: 'Referral not found' });
    }

    if (referral.status === 'revoked') {
      return res.status(400).json({ success: false, msg: 'Referral is already revoked' });
    }

    // If referral was completed, claw back the credits safely
    if (referral.status === 'completed' && referral.referrerRewardAmount > 0) {
      const updated = await User.findOneAndUpdate(
        {
          _id: referral.referrer,
          referralCredits: { $gte: referral.referrerRewardAmount }
        },
        {
          $inc: {
            referralCredits: -referral.referrerRewardAmount,
            completedReferrals: -1
          }
        },
        { new: true }
      );

      if (!updated) {
        // Insufficient credits — set to 0 and still decrement completedReferrals
        await User.findByIdAndUpdate(referral.referrer, {
          $set: { referralCredits: 0 },
          $inc: { completedReferrals: -1 }
        });
      }
    }

    referral.status = 'revoked';
    referral.revokedReason = reason || 'Revoked by admin';
    referral.revokedAt = new Date();
    referral.revokedBy = userId;
    await referral.save();

    return res.status(200).json({
      success: true,
      msg: 'Referral revoked successfully'
    });
  } catch (error) {
    console.error('Revoke referral error:', error);
    next(error);
  }
};
