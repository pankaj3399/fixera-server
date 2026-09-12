import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../models/user', () => ({
  default: { find: vi.fn(), updateOne: vi.fn() },
}));

vi.mock('../../../models/booking', () => ({
  default: { aggregate: vi.fn() },
}));

vi.mock('../../../models/marketingSubscriber', () => ({
  default: { find: vi.fn(), updateOne: vi.fn(), bulkWrite: vi.fn() },
  MARKETING_LOCALES: ['en', 'nl', 'fr'],
}));

vi.mock('../../../utils/marketing/brevoMarketing', () => ({
  restoreBrevoMarketingContact: vi.fn(),
  suppressBrevoMarketingContact: vi.fn(),
}));

import { subscriberProfileForUser } from '../../../utils/marketing/audience';

describe('subscriber profile metadata', () => {
  it('records a professional with role, locale, region, and services', () => {
    const profile = subscriberProfileForUser({
      role: 'professional',
      name: 'Ada Lovelace',
      serviceCategories: ['solar', 'roofing', 'solar'],
      location: { country: 'be' },
    });

    expect(profile).toEqual({
      role: 'professional',
      name: 'Ada Lovelace',
      firstName: 'Ada',
      region: 'BE',
      interestedServices: ['solar', 'roofing'],
      serviceKeys: ['solar', 'roofing'],
      locale: 'nl',
      localeSource: 'country_default',
    });
  });

  it('prefers an explicit marketing locale over the country default', () => {
    const profile = subscriberProfileForUser({
      role: 'customer',
      marketingLocale: 'fr',
      location: { country: 'BE' },
    });

    expect(profile.role).toBe('customer');
    expect(profile.locale).toBe('fr');
    expect(profile.localeSource).toBe('explicit');
  });

  it('merges booking-derived interests with the user categories', () => {
    const profile = subscriberProfileForUser(
      { role: 'customer', serviceCategories: ['plumbing'] },
      ['electrical', 'plumbing'],
    );

    expect(profile.interestedServices).toEqual(['electrical', 'plumbing']);
  });

  it('omits the role for non customer/professional accounts', () => {
    const profile = subscriberProfileForUser({ role: 'employee', name: '' });

    expect(profile.role).toBeUndefined();
    expect(profile.name).toBeUndefined();
    expect(profile.locale).toBe('en');
    expect(profile.localeSource).toBe('fallback');
  });
});
