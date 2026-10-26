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
import { indexMarketingServiceOptions } from '../../../utils/marketing/serviceCatalog';

const serviceIndex = indexMarketingServiceOptions([
  { key: 'plumbing', label: 'Plumbing', countries: ['BE'] },
  { key: 'painting', label: 'Painting', countries: ['BE'] },
]);

describe('subscriber profile metadata', () => {
  it('records a professional with canonical country, explicit language, labels and service keys', () => {
    const profile = subscriberProfileForUser(
      {
        role: 'professional',
        name: 'Ada Lovelace',
        marketingLocale: 'nl',
        businessInfo: { country: 'Belgium' },
        serviceCategories: ['Plumbing'],
      },
      [],
      serviceIndex,
    );

    expect(profile).toEqual({
      role: 'professional',
      name: 'Ada Lovelace',
      firstName: 'Ada',
      region: 'BE',
      interestedServices: ['Plumbing'],
      serviceKeys: ['plumbing'],
      locale: 'nl',
      localeSource: 'explicit',
    });
  });

  it('uses a localized legacy language name as an explicit choice', () => {
    const profile = subscriberProfileForUser({
      role: 'professional',
      preferredLocale: 'Nederlands',
      businessInfo: { country: 'België' },
      serviceCategories: ['Plumbing'],
    });

    expect(profile.region).toBe('BE');
    expect(profile.locale).toBe('nl');
    expect(profile.localeSource).toBe('explicit');
  });

  it('does not infer Dutch or French from Belgium without an explicit language', () => {
    const profile = subscriberProfileForUser({
      role: 'professional',
      businessInfo: { country: 'Belgium' },
      serviceCategories: ['Plumbing'],
    });

    expect(profile.region).toBe('BE');
    expect(profile.locale).toBe('en');
    expect(profile.localeSource).toBe('fallback');
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
