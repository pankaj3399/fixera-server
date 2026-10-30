import { describe, expect, it } from 'vitest';
import {
  resolveSubscriberLocale,
  subscriberCountryFromUser,
} from '../../utils/marketing/marketingCatalog';

/**
 * Notification GET display-default contract: explicit stored locale (or
 * legacy choice) always wins; otherwise the country default is surfaced
 * display-only (NL -> nl, BE stays neutral en). The GET never writes back,
 * so these cases pin the resolver the handler relies on.
 */
describe('notification marketing-locale display default', () => {
  it('resolves missing locale for NL users to nl via country default', () => {
    const user = { location: { country: 'NL' } };
    expect(subscriberCountryFromUser(user)).toBe('NL');
    expect(resolveSubscriberLocale(user, subscriberCountryFromUser(user))).toEqual({
      locale: 'nl',
      source: 'country_default',
    });
  });

  it('keeps an explicit stored locale even when the country disagrees', () => {
    const user = { marketingLocale: 'en', location: { country: 'NL' } };
    expect(resolveSubscriberLocale(user, subscriberCountryFromUser(user))).toEqual({
      locale: 'en',
      source: 'explicit',
    });
  });

  it('treats legacy preference fields as an explicit manual choice', () => {
    const user = { preferredLocale: 'Nederlands', location: { country: 'BE' } };
    expect(resolveSubscriberLocale(user, subscriberCountryFromUser(user))).toEqual({
      locale: 'nl',
      source: 'explicit',
    });
  });

  it('stays neutral en for BE with no other context (prior multilingual policy)', () => {
    const user = { location: { country: 'BE' } };
    expect(resolveSubscriberLocale(user, subscriberCountryFromUser(user))).toEqual({
      locale: 'en',
      source: 'fallback',
    });
  });

  it('falls back to en when no country is known', () => {
    const user = {};
    expect(subscriberCountryFromUser(user)).toBeUndefined();
    expect(resolveSubscriberLocale(user, subscriberCountryFromUser(user))).toEqual({
      locale: 'en',
      source: 'fallback',
    });
  });

  it('prefers location over company and business-info countries', () => {
    const user = {
      location: { country: 'FR' },
      companyAddress: { country: 'NL' },
      businessInfo: { country: 'DE' },
    };
    expect(subscriberCountryFromUser(user)).toBe('FR');
    expect(
      resolveSubscriberLocale(user, subscriberCountryFromUser(user)).locale,
    ).toBe('fr');
  });
});
