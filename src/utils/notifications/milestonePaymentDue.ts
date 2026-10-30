import Booking from "../../models/booking";
import PlatformSettings from "../../models/platformSettings";
import { buildMilestoneChargePlan, toMilestoneCustomerGross } from "../milestoneCharges";
import { notify } from "./notify";

export type PayableMilestone = {
  title?: string;
  amount: number;
  order: number;
  dueCondition?: string;
  customDueDate?: Date | string;
  workStatus?: string;
  status?: string;
};

const NOTIFIABLE_STATUSES = new Set(["booked", "in_progress", "professional_completed"]);

const sortedMilestones = (booking: any): PayableMilestone[] =>
  (Array.isArray(booking?.milestonePayments) ? booking.milestonePayments : [])
    .map((milestone: any) => ({ ...milestone }))
    .sort((a: PayableMilestone, b: PayableMilestone) => (a.order ?? 0) - (b.order ?? 0));

/**
 * First milestone the customer can currently pay. Mirrors the charge-side
 * gating in Stripe/payment (isMilestoneCurrentlyPayable): earlier milestones
 * must be settled first, and the due condition must be met. Pure and exported
 * for tests.
 */
export const findPayableMilestone = (booking: any, now: Date = new Date()): PayableMilestone | null => {
  const milestones = sortedMilestones(booking);
  if (milestones.length === 0) return null;
  const payable = milestones.find((milestone) => {
    if (milestone.status === "paid") return false;
    const order = milestone.order ?? 0;
    const hasEarlierUnpaid = milestones.some(
      (candidate) => (candidate.order ?? 0) < order && candidate.status !== "paid",
    );
    if (hasEarlierUnpaid) return false;
    switch (milestone.dueCondition) {
      case "on_start":
        return true;
      case "on_milestone_start":
        return milestone.workStatus === "in_progress" || milestone.workStatus === "completed";
      case "on_milestone_completion":
        return milestone.workStatus === "completed";
      case "custom_date": {
        if (milestone.workStatus === "completed") return true;
        if (!milestone.customDueDate) return false;
        return new Date(milestone.customDueDate).getTime() <= now.getTime();
      }
      default:
        return false;
    }
  });
  return payable || null;
};

const customerChargeForMilestone = async (booking: any, milestone: PayableMilestone): Promise<number | undefined> => {
  try {
    const config = await PlatformSettings.getCurrentConfig();
    const commissionPercent = Number(config?.commissionPercent) || 0;
    // Client bug list #19b: same shared plan as the charge path, so the
    // notified amount always matches what paying this milestone charges.
    const entry = buildMilestoneChargePlan(booking, commissionPercent)
      .find((candidate) => candidate.order === (milestone.order ?? 0));
    if (entry) return entry.expectedCustomerGross;
    return toMilestoneCustomerGross(Number(milestone.amount) || 0, commissionPercent);
  } catch {
    return undefined;
  }
};

/**
 * Notify (inbox + email, deduplicated by a stable per-milestone delivery key)
 * that a milestone payment is due. The professional is only pinged when they
 * did not trigger the transition themselves (cron sweep), never as an echo of
 * their own milestone start/complete action.
 */
export async function notifyMilestonePaymentDue(
  bookingId: string,
  opts?: { notifyProfessional?: boolean },
): Promise<{ notified: boolean; order?: number }> {
  const booking = await Booking.findById(bookingId).select(
    "customer professional status milestonePayments selectedExtraOptions checkoutSnapshot quote payment.currency",
  );
  if (!booking || !NOTIFIABLE_STATUSES.has(String(booking.status))) return { notified: false };
  const milestone = findPayableMilestone(booking);
  if (!milestone) return { notified: false };
  const order = milestone.order ?? 0;
  const customerId = booking.customer?.toString?.() || String(booking.customer);
  if (!customerId) return { notified: false };
  const milestoneAmount = await customerChargeForMilestone(booking, milestone);
  const context = {
    bookingId: String(booking._id),
    milestoneTitle: milestone.title || `Milestone ${order + 1}`,
    ...(milestoneAmount !== undefined ? { milestoneAmount } : {}),
    milestoneOrder: order,
    currency: (booking as any).payment?.currency || "EUR",
  };
  await notify({
    userId: customerId,
    eventKey: "customer.milestone_payment_due",
    entityType: "booking",
    entityId: String(booking._id),
    idempotencyKey: `milestone-due:${booking._id}:${order}`,
    context,
  });
  if (opts?.notifyProfessional) {
    const professionalId = (booking as any).professional?._id?.toString?.()
      || (booking as any).professional?.toString?.();
    if (professionalId) {
      await notify({
        userId: professionalId,
        eventKey: "professional.milestone_payment_due",
        entityType: "booking",
        entityId: String(booking._id),
        idempotencyKey: `milestone-due-pro:${booking._id}:${order}`,
        context,
      });
    }
  }
  return { notified: true, order };
}
