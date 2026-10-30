import PlatformSettings from "../models/platformSettings";

const roundMoney = (value: number): number =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Final amount for the dispute-resolved email, or undefined when it cannot be
 * computed. A failure must omit the amount line rather than fall back to the
 * bare net delta, which would contradict the "never the bare net" rule.
 */
export const resolveDisputeEmailAmount = async (
  booking: any,
  originalExtraCostTotal: number,
  finalExtraCostAmount: number,
): Promise<number | undefined> => {
  try {
    return await resolveDisputeExtraCostFinalCharge(booking, originalExtraCostTotal, finalExtraCostAmount);
  } catch (error) {
    console.error(
      "Failed to resolve dispute final charge; omitting the amount from the resolution email:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
};

/**
 * Final customer-facing amount for an extra-costs dispute resolution. The
 * stored decision amount is a net delta; the customer email must show what is
 * actually paid, including commission, VAT and discount, and must never
 * mention the platform percentage. When the decision scales the original
 * charge, the persisted VAT-inclusive charge scales with it so every
 * component stays included.
 */
export const resolveDisputeExtraCostFinalCharge = async (
  booking: any,
  originalExtraCostTotal: number,
  finalExtraCostAmount: number,
): Promise<number> => {
  if (!booking) throw new Error("Booking is required to resolve the dispute final charge.");
  if (!(finalExtraCostAmount > 0)) return 0;
  const originalCharge = Number(booking?.payment?.extraCostAmount);
  if (originalExtraCostTotal > 0 && Number.isFinite(originalCharge) && originalCharge > 0) {
    return roundMoney((originalCharge * finalExtraCostAmount) / originalExtraCostTotal);
  }
  let commissionPercent = 0;
  try {
    commissionPercent = (await PlatformSettings.getCurrentConfig()).commissionPercent || 0;
  } catch {
    // Best-effort: without the platform config the commission share is 0.
  }
  const reverseCharge = Boolean(booking?.payment?.reverseCharge);
  const vatRate = reverseCharge ? 0 : Math.max(0, Number(booking?.payment?.vatRate) || 0);
  const net = finalExtraCostAmount * (1 + Math.max(0, commissionPercent) / 100);
  return roundMoney(net + (reverseCharge ? 0 : (net * vatRate) / 100));
};
