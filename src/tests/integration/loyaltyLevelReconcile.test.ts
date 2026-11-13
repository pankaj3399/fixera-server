import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FT3 #14a on real Mongo: a customer whose stored level is below what their
 * spend already qualifies for (Platinum added after their last booking) is
 * upgraded on read, notified once, and the progression is relative to the
 * level actually held. Manual overrides are never touched and report their
 * own source instead of "top level reached".
 */
const notifyAsync = vi.hoisted(() => vi.fn());
vi.mock('../../utils/notifications/notify', () => ({ notifyAsync, notify: vi.fn(async () => undefined) }));

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri && /test/i.test(testUri) ? describe : describe.skip;

import User from '../../models/user';
import LoyaltyConfig, { defaultLoyaltyTiers } from '../../models/loyaltyConfig';
import { getLoyaltyStatus } from '../../handlers/User/loyaltyManagement';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};
const statusFor = async (userId: Types.ObjectId) => {
  const res = response();
  await getLoyaltyStatus({ user: { _id: userId } } as any, res, vi.fn());
  expect(res.statusCode).toBe(200);
  return res.body.data.loyaltyStatus;
};

describeDb('loyalty level reconcile and progression (FT3 #14a)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft3_loyalty_reconcile_${process.pid}` });
    await User.init();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    notifyAsync.mockReset();
    await Promise.all([User.collection.deleteMany({}), LoyaltyConfig.collection.deleteMany({})]);
    await LoyaltyConfig.collection.insertOne({
      globalSettings: { isEnabled: true, minBookingAmount: 10, roundingRule: 'floor' },
      tiers: defaultLoyaltyTiers(),
      lastModifiedBy: new Types.ObjectId(),
      version: 1,
    } as any);
  });
  const customer = async (fields: Record<string, unknown>) => {
    const _id = new Types.ObjectId();
    await User.collection.insertOne({ _id, name: 'C', email: `${_id}@example.test`, role: 'customer', ...fields } as any);
    return _id;
  };

  it('upgrades a stale Gold to Platinum once and stops claiming Gold is the top', async () => {
    const id = await customer({ loyaltyLevel: 'Gold', totalSpent: 12_000 });
    const first = await statusFor(id);
    expect(first.level).toBe('Platinum');
    expect(first.levelSource).toBe('spend');
    expect((await User.findById(id).lean())?.loyaltyLevel).toBe('Platinum');
    expect(notifyAsync).toHaveBeenCalledTimes(1);
    expect(notifyAsync.mock.calls[0][0]).toMatchObject({ eventKey: 'customer.loyalty_tier_up', context: { levelName: 'Platinum' } });
    // A second read neither re-notifies nor changes anything.
    await statusFor(id);
    expect(notifyAsync).toHaveBeenCalledTimes(1);
  });

  it('progresses from Gold towards Platinum', async () => {
    const id = await customer({ loyaltyLevel: 'Gold', totalSpent: 6_000 });
    const status = await statusFor(id);
    expect(status).toMatchObject({ level: 'Gold', nextLevel: 'Platinum', amountToNextTier: 4_000, progress: 60 });
    expect(notifyAsync).not.toHaveBeenCalled();
  });

  it('never downgrades a stored level on read', async () => {
    const id = await customer({ loyaltyLevel: 'Gold', totalSpent: 500 });
    const status = await statusFor(id);
    expect(status.level).toBe('Gold');
    expect(status.nextLevel).toBe('Platinum');
    expect((await User.findById(id).lean())?.loyaltyLevel).toBe('Gold');
  });

  it('reports a manual override as such, without progression or an upgrade', async () => {
    const id = await customer({ loyaltyLevel: 'Silver', manualCustomerLevelOverride: 'Silver', totalSpent: 12_000 });
    const status = await statusFor(id);
    expect(status).toMatchObject({ level: 'Silver', levelSource: 'manual', nextLevel: null });
    expect((await User.findById(id).lean())?.loyaltyLevel).toBe('Silver');
    expect(notifyAsync).not.toHaveBeenCalled();
  });
});
