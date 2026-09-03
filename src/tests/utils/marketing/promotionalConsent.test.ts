import { describe, expect, it } from 'vitest';
import { promotionalEmailOptIn } from '../../../utils/marketing/promotionalConsent';

describe('promotional email opt-in', () => {
  it('requires a recorded consent timestamp when the promotional-email toggle is on', () => {
    const result = promotionalEmailOptIn({
      notificationPreferences: { promotions: { email: true, push: true } },
      marketingConsentAt: null,
    });
    expect(result.optedIn).toBe(false);
    expect(result.consentVerifiedAt).toBeUndefined();
  });

  it('accepts an ISO consent timestamp from a lean document', () => {
    const result = promotionalEmailOptIn({
      notificationPreferences: { promotions: { email: true } },
      marketingConsentAt: '2026-09-01T12:00:00.000Z',
    });
    expect(result.optedIn).toBe(true);
    expect(result.consentVerifiedAt?.toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });

  it('does not subscribe when promotional email is off', () => {
    expect(
      promotionalEmailOptIn({
        notificationPreferences: { promotions: { email: false } },
        marketingConsentAt: new Date(),
      }).optedIn,
    ).toBe(false);
  });
});
