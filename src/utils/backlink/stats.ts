import mongoose from 'mongoose';
import User from '../../models/user';
import BacklinkConfig from '../../models/backlinkConfig';
import BacklinkSubmission from '../../models/backlinkSubmission';
import { rewardPointsForRole } from './rewards';

/** Aggregate backlink stats for the benefits dashboard. */
export async function getUserBacklinkStats(userId: mongoose.Types.ObjectId) {
  const config = await BacklinkConfig.getCurrentConfig();
  const user = await User.findById(userId).select('role');

  const [submissions, verifiedCount, pointsAgg] = await Promise.all([
    BacklinkSubmission.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select(
        'submittedUrl domain status rewardPoints rewardIssuedAt rejectionReason lastRejectedAt revokedAt createdAt',
      ),
    BacklinkSubmission.countDocuments({ userId, status: 'verified' }),
    BacklinkSubmission.aggregate([
      { $match: { userId, status: 'verified' } },
      { $group: { _id: null, total: { $sum: '$rewardPoints' } } },
    ]),
  ]);

  const totalPointsEarned = pointsAgg[0]?.total ?? 0;

  const rewardPoints = user
    ? rewardPointsForRole(config, user.role)
    : config.customerRewardPoints;

  return {
    programEnabled: config.isEnabled,
    rewardPoints,
    resubmitCooldownHours: config.resubmitCooldownHours,
    verifiedCount,
    totalPointsEarned,
    submissions: submissions.map((s) => ({
      _id: s._id,
      submittedUrl: s.submittedUrl,
      domain: s.domain,
      status: s.status,
      rewardPoints: s.rewardPoints,
      rewardIssuedAt: s.rewardIssuedAt,
      rejectionReason: s.rejectionReason,
      lastRejectedAt: s.lastRejectedAt,
      revokedAt: s.revokedAt,
      createdAt: s.createdAt,
    })),
  };
}
