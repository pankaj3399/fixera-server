import { describe, expect, it } from 'vitest';
import { getEventDef } from '../../../utils/notifications/registry';
import { defaultLoyaltyTiers } from '../../../models/loyaltyConfig';
import { getCurrentTier, getNextTierInfo } from '../../../utils/loyaltySystem';

const activeTiers = (tiers: any[]) => tiers.filter((tier) => tier.isActive !== false);

describe('level-up inbox + email wiring (client bug list #11)', () => {
  it('emits a customer loyalty email for popup-capable delivery', async () => {
    const def = getEventDef('customer.loyalty_tier_up');
    expect(def).toBeDefined();
    const built = def!.build({ levelName: 'Platinum' });
    expect(built.title).toMatch(/level up/i);
    expect(built.body).toContain('Platinum');
    expect(built.clickUrl).toContain('/dashboard/benefits');
    expect(typeof built.sendEmail).toBe('function');
  });

  it('emits a professional level-up email for popup-capable delivery', async () => {
    const def = getEventDef('professional.leveling_up');
    expect(def).toBeDefined();
    const built = def!.build({ levelName: 'Expert' });
    expect(built.title).toMatch(/level up/i);
    expect(built.body).toContain('Expert');
    expect(built.clickUrl).toContain('/dashboard/benefits');
    expect(typeof built.sendEmail).toBe('function');
  });

  it('notifies the professional when a warranty proposal is declined, with the clarification', () => {
    const def = getEventDef('professional.warranty_proposal_declined');
    expect(def).toBeDefined();
    const built = def!.build({
      bookingId: 'booking-1',
      customerName: 'Carla',
      claimNumber: 'WC-1',
      clarification: 'The date does not work',
    });
    expect(built.title).toMatch(/declined/i);
    expect(built.body).toContain('The date does not work');
    expect(built.clickUrl).toContain('/bookings/booking-1');
    expect(typeof built.sendEmail).toBe('function');
  });

  it('words the professional RFQ notification as a quotation request (client bug list #17)', () => {
    const received = getEventDef('professional.rfq_received')!.build({
      bookingId: 'booking-1',
      customerName: 'Carla',
    });
    expect(received.title).toMatch(/quotation request/i);
    expect(received.title).not.toMatch(/booking request/i);
    expect(received.body).toMatch(/quotation request/i);
    const reminder = getEventDef('professional.rfq_reminder')!.build({ bookingId: 'booking-1' });
    expect(reminder.body).toMatch(/quotation request/i);
  });

  it('words the customer RFQ accepted/rejected notifications as quotation requests (review should-fix #2)', () => {
    const accepted = getEventDef('customer.rfq_accepted')!.build({
      bookingId: 'booking-1',
      customerName: 'Carla',
    });
    expect(accepted.body).toMatch(/quotation request/i);
    expect(accepted.body).not.toMatch(/booking request/i);
    const acceptedNamed = getEventDef('customer.rfq_accepted')!.build({
      bookingId: 'booking-1',
      professionalName: 'Piet',
    });
    expect(acceptedNamed.body).toMatch(/quotation request/i);

    const rejected = getEventDef('customer.rfq_rejected')!.build({ bookingId: 'booking-1' });
    expect(rejected.body).toMatch(/quotation request/i);
    expect(rejected.body).not.toMatch(/booking request/i);
  });
});

describe('platinum progression (client bug list #14a)', () => {
  it('ships Platinum in the standard tier ladder above Gold', () => {
    const tiers = defaultLoyaltyTiers();
    const names = tiers.map((tier: any) => tier.name);
    expect(names).toEqual(['Bronze', 'Silver', 'Gold', 'Platinum']);
    const gold = tiers.find((tier: any) => tier.name === 'Gold');
    const platinum = tiers.find((tier: any) => tier.name === 'Platinum');
    expect(platinum.minSpendingAmount).toBeGreaterThan(gold.minSpendingAmount);
    expect(platinum.isActive).toBe(true);
  });

  it('runs progression at Gold instead of stopping', () => {
    const tiers = activeTiers(defaultLoyaltyTiers().map((tier: any) => ({ ...tier })));
    expect(getCurrentTier(tiers, 9999).name).toBe('Gold');
    const next = getNextTierInfo(tiers, 7500);
    expect(next.nextTier?.name).toBe('Platinum');
    expect(next.amountNeeded).toBe(2500);
    expect(next.progress).toBeGreaterThan(0);
    expect(next.progress).toBeLessThanOrEqual(100);
  });

  it('reaches Platinum at the threshold', () => {
    const tiers = activeTiers(defaultLoyaltyTiers().map((tier: any) => ({ ...tier })));
    expect(getCurrentTier(tiers, 10000).name).toBe('Platinum');
    expect(getNextTierInfo(tiers, 10000).nextTier).toBeUndefined();
  });
});
