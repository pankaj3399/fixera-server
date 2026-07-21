const PROFESSIONAL_COMPLETION_PENDING_STATUS = 'professional_completed';
export const AUTO_ACCEPT_AGE_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Pure eligibility rules for completion auto-accept (shared by runner + tests).
 */
export function isEligibleForAutoAccept(input: {
  status: string;
  professionalCompletedAt?: Date | null;
  unpaidMilestoneCount: number;
  extraCostTotal: number;
  extraCostPaymentSucceeded: boolean;
  now?: Date;
}): { eligible: boolean; reason?: string } {
  if (input.status !== PROFESSIONAL_COMPLETION_PENDING_STATUS) {
    return { eligible: false, reason: 'invalid_status' };
  }
  const completedAt = input.professionalCompletedAt;
  if (!completedAt) return { eligible: false, reason: 'missing_completed_at' };
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - completedAt.getTime();
  if (ageMs < AUTO_ACCEPT_AGE_MS) {
    return { eligible: false, reason: 'too_recent' };
  }
  if (input.unpaidMilestoneCount > 0) {
    return { eligible: false, reason: 'milestones_unpaid' };
  }
  if (input.extraCostTotal > 0 && !input.extraCostPaymentSucceeded) {
    return { eligible: false, reason: 'extra_cost_unpaid' };
  }
  return { eligible: true };
}
