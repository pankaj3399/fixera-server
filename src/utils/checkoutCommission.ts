import PlatformSettings from '../models/platformSettings';

/** Current checkout terms for an unpaid charge, shared by charging and previews.
 * Issued invoices and settled totals always use their recorded payment facts.
 */
export const getCheckoutCommissionPercent = async (): Promise<number> => {
  const config = await PlatformSettings.getCurrentConfig();
  const value = Number(config.commissionPercent);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};
