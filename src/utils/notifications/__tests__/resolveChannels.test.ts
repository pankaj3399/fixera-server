import { describe, expect, it } from 'vitest';
import { resolveChannels, type NotificationPreferences } from '../types';

const allOff: NotificationPreferences = {
  booking_updates: { push: false, email: false },
  messages: { push: false, email: false },
  promotions: { push: false, email: false },
  system: { push: false, email: false },
};

const allOn: NotificationPreferences = {
  booking_updates: { push: true, email: true },
  messages: { push: true, email: true },
  promotions: { push: true, email: true },
  system: { push: true, email: true },
};

describe('resolveChannels', () => {
  it('always_on forces push and email even when prefs are off', () => {
    expect(resolveChannels('always_on', 'booking_updates', allOff)).toEqual({
      sendPush: true,
      sendEmail: true,
    });
  });

  it('email_always forces email but honors push pref', () => {
    expect(resolveChannels('email_always', 'booking_updates', allOff)).toEqual({
      sendPush: false,
      sendEmail: true,
    });
    expect(resolveChannels('email_always', 'booking_updates', allOn)).toEqual({
      sendPush: true,
      sendEmail: true,
    });
  });

  it('configurable honors both prefs', () => {
    expect(resolveChannels('configurable', 'promotions', allOff)).toEqual({
      sendPush: false,
      sendEmail: false,
    });
    expect(resolveChannels('configurable', 'promotions', {
      promotions: { push: true, email: false },
    })).toEqual({
      sendPush: true,
      sendEmail: false,
    });
  });

  it('defaults missing prefs to allowed (true)', () => {
    expect(resolveChannels('configurable', 'messages', undefined)).toEqual({
      sendPush: true,
      sendEmail: true,
    });
    expect(resolveChannels('configurable', 'messages', {})).toEqual({
      sendPush: true,
      sendEmail: true,
    });
  });
});
