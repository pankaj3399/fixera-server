export type PrefCategory = 'booking_updates' | 'messages' | 'promotions' | 'system';

/** Tier 1: honor prefs · Tier 2: email forced · Tier 3: push+email forced */
export type ChannelTier = 'configurable' | 'email_always' | 'always_on';

export type NotificationAudience = 'customer' | 'professional' | 'either';

export type NotificationEntityType =
  | 'booking'
  | 'project'
  | 'conversation'
  | 'review'
  | 'referral'
  | 'user'
  | 'cancellation_request';

export interface ChannelPrefs {
  push?: boolean;
  email?: boolean;
}

export type NotificationPreferences = Partial<Record<PrefCategory, ChannelPrefs>>;

export interface ResolvedChannels {
  sendPush: boolean;
  sendEmail: boolean;
}

/**
 * Resolve whether push/email should fire for a registry event.
 * In-app inbox is always written by notify() regardless of this result.
 */
export function resolveChannels(
  tier: ChannelTier,
  category: PrefCategory,
  prefs: NotificationPreferences | null | undefined,
): ResolvedChannels {
  const pushPref = prefs?.[category]?.push !== false;
  const emailPref = prefs?.[category]?.email !== false;

  switch (tier) {
    case 'always_on':
      return { sendPush: true, sendEmail: true };
    case 'email_always':
      return { sendPush: pushPref, sendEmail: true };
    case 'configurable':
    default:
      return { sendPush: pushPref, sendEmail: emailPref };
  }
}
