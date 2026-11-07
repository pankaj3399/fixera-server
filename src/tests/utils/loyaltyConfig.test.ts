import { afterEach, describe, expect, it, vi } from 'vitest';
import LoyaltyConfig, { defaultLoyaltyTiers } from '../../models/loyaltyConfig';
afterEach(() => vi.restoreAllMocks());
describe('explicit legacy loyalty repair', () => {
  it('never restores an admin-removed tier during reads', async () => {
    const config = { tiers: defaultLoyaltyTiers().slice(0, 3), save: vi.fn() };
    vi.spyOn(LoyaltyConfig, 'findOne').mockResolvedValue(config as any);
    expect(await LoyaltyConfig.getCurrentConfig()).toBe(config);
    expect(config.save).not.toHaveBeenCalled();
    expect(config.tiers).toHaveLength(3);
  });
  it('repairs only a confirmed legacy revision, bounds Gold and records completion atomically', async () => {
    const tiers = defaultLoyaltyTiers().slice(0, 3);
    delete tiers[2].maxSpendingAmount;
    const find = vi.spyOn(LoyaltyConfig, 'findOne').mockResolvedValue({ _id: 'confirmed', tiers } as any);
    const update = vi.spyOn(LoyaltyConfig, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as any);
    expect(await LoyaltyConfig.backfillConfirmedLegacyConfig('confirmed', 7)).toBe(true);
    expect(find).toHaveBeenCalledWith({ _id: 'confirmed', version: 7, legacyTierBackfilledAt: { $exists: false } });
    const mutation = update.mock.calls[0][1] as any;
    expect(mutation.$set.tiers.map((tier: any) => tier.name)).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum']);
    expect(mutation.$set.tiers[2].maxSpendingAmount).toBe(9999.99);
    expect(mutation.$set.legacyTierBackfilledAt).toBeInstanceOf(Date);
    find.mockResolvedValueOnce(null);
    expect(await LoyaltyConfig.backfillConfirmedLegacyConfig('confirmed', 8)).toBe(false);
    expect(update).toHaveBeenCalledOnce();
  });
  it('refuses customized or overlapping thresholds', async () => {
    const tiers = defaultLoyaltyTiers().slice(0, 3); tiers[2].minSpendingAmount = 12000;
    vi.spyOn(LoyaltyConfig, 'findOne').mockResolvedValue({ tiers } as any);
    const update = vi.spyOn(LoyaltyConfig, 'updateOne');
    await expect(LoyaltyConfig.backfillConfirmedLegacyConfig('confirmed', 1)).rejects.toThrow('reconciled');
    expect(update).not.toHaveBeenCalled();
  });
});
