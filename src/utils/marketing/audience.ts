import User from '../../models/user';
import Booking from '../../models/booking';
import MarketingSubscriber, {
  type MarketingLocale,
} from '../../models/marketingSubscriber';
import type { ICampaignAudience } from '../../models/marketingCampaign';
import { generateUnsubscribeToken } from './unsubscribeToken';
import { promotionalEmailOptIn, isPromotionalEmailEnabled, toConsentDate } from './promotionalConsent';
import {
  restoreBrevoMarketingContact,
  suppressBrevoMarketingContact,
} from './brevoMarketing';
import { normalizeEmail } from './normalizeEmail';
import {
  normalizeMarketingLanguage,
  resolveSubscriberLocale,
} from './marketingCatalog';
import { normalizeMarketingCountry } from './canonical';
import {
  canonicalizeServiceValues,
  indexMarketingServiceOptions,
  loadMarketingServiceOptions,
  type MarketingServiceIndex,
} from './serviceCatalog';
import { safeErrorSummary } from '../safeErrorLog';

export type AudienceMember = {
  email: string;
  name?: string;
  locale: MarketingLocale;
  region?: string;
  userId?: string;
  subscriberId?: string;
};

export type SubscriberProfile = {
  role?: 'customer' | 'professional';
  name?: string;
  firstName?: string;
  region?: string;
  interestedServices: string[];
  serviceKeys: string[];
  locale: MarketingLocale;
  localeSource: 'explicit' | 'country_default' | 'fallback';
};

export const MARKETING_AUDIENCE_LIMIT = 5000;

async function loadServiceIndexSafe(context: string): Promise<MarketingServiceIndex | undefined> {
  try {
    return indexMarketingServiceOptions(await loadMarketingServiceOptions());
  } catch (error) {
    // Consent must survive a catalog outage. Keep the raw profile; the next
    // successful sync repairs the canonical service keys.
    console.error(
      `[MARKETING] Service catalog unavailable during ${context}; keeping raw service values`,
      safeErrorSummary(error),
    );
    return undefined;
  }
}

function userCountry(user: any): string | undefined {
  return (
    normalizeMarketingCountry(user?.location?.country) ||
    normalizeMarketingCountry(user?.companyAddress?.country) ||
    normalizeMarketingCountry(user?.businessInfo?.country)
  );
}

/**
 * Canonical subscriber metadata for every opt-in path (profile toggle, signup,
 * and the user sync). Keeping this in one place prevents role/locale/service
 * drift between paths — the original bug that classified professionals as
 * customers and stored raw service labels as canonical keys.
 *
 * The caller supplies a catalog index when it has one. Without it this keeps
 * the historical raw-profile behavior and never fails the consent write.
 */
export function subscriberProfileForUser(
  user: any,
  extraServiceKeys: string[] = [],
  serviceIndex?: MarketingServiceIndex,
): SubscriberProfile {
  const region = userCountry(user);
  const fromUser = Array.isArray(user?.serviceCategories) ? user.serviceCategories : [];
  const rawServices = [...extraServiceKeys, ...fromUser].map(String).filter(Boolean);
  const { serviceKeys, interestedServices } = serviceIndex
    ? canonicalizeServiceValues(rawServices, serviceIndex, region)
    : {
        serviceKeys: Array.from(new Set(rawServices)),
        interestedServices: Array.from(new Set(rawServices)),
      };
  const resolvedLocale = resolveSubscriberLocale(user, region);
  const name = typeof user?.name === 'string' && user.name.trim() ? user.name.trim() : undefined;

  const profile: SubscriberProfile = {
    interestedServices,
    serviceKeys,
    locale: resolvedLocale.locale,
    localeSource: resolvedLocale.source,
  };
  if (user?.role === 'customer' || user?.role === 'professional') profile.role = user.role;
  if (name) {
    profile.name = name;
    profile.firstName = name.split(/\s+/)[0];
  }
  if (region) profile.region = region;
  return profile;
}

/**
 * Record consent and upsert the subscriber row with full profile metadata.
 * Local consent is authoritative immediately, while a previously blacklisted
 * Brevo contact remains outside campaign audiences until provider
 * reconciliation succeeds (or the daily retry does).
 */
export async function enablePromotionalEmail(
  user: any,
  source: 'user_sync' | 'signup' = 'user_sync',
): Promise<void> {
  const email = normalizeEmail(user?.email);
  if (!email) return;
  const now = new Date();
  const serviceIndex = await loadServiceIndexSafe('promotional opt-in');
  const profile = subscriberProfileForUser(user, [], serviceIndex);
  const consentFields: Record<string, unknown> = {
    userId: user._id,
    email,
    emailNormalized: email,
    unsubscribedAt: null,
    subscribedAt: now,
    consentVerifiedAt: now,
    ...profile,
  };
  try {
    await MarketingSubscriber.updateOne(
      { $or: [{ userId: user._id }, { email }, { emailNormalized: email }] },
      {
        $set: consentFields,
        $setOnInsert: { unsubscribeToken: generateUnsubscribeToken(), source },
      },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 11000) throw error;
    await MarketingSubscriber.updateOne(
      { $or: [{ userId: user._id }, { email }, { emailNormalized: email }] },
      { $set: consentFields },
    );
  }
}

function normalizeLocale(value: unknown): MarketingLocale {
  return normalizeMarketingLanguage(value) || 'en';
}

export type MarketingRoleCounts = { customer: number; professional: number };

/** Sync opted-in users into MarketingSubscriber collection. */
export async function syncSubscribersFromUsers(): Promise<{
  upserted: number;
  unsubscribed: number;
  eligibleByRole: MarketingRoleCounts;
  syncedByRole: MarketingRoleCounts;
  skippedByRole: MarketingRoleCounts;
}> {
  const SYNC_BATCH_SIZE = 500;
  const baseQuery = {
    email: { $exists: true, $nin: [null, ''] },
    role: { $in: ['customer', 'professional'] },
    deletedAt: null,
  };
  const serviceIndex = await loadServiceIndexSafe('subscriber sync');
  let lastUserId: unknown;
  let upserted = 0;
  let unsubscribed = 0;
  const eligibleByRole: MarketingRoleCounts = { customer: 0, professional: 0 };
  const syncedByRole: MarketingRoleCounts = { customer: 0, professional: 0 };

  // Stable _id keyset pagination bounds memory without permanently omitting users
  // beyond an arbitrary daily cap.
  while (true) {
    const users = await User.find(
      lastUserId ? { ...baseQuery, _id: { $gt: lastUserId } } : baseQuery,
    )
      .select(
        'email name role location companyAddress businessInfo notificationPreferences serviceCategories preferredLocale locale language marketingLocale updatedAt marketingConsentAt',
      )
      .sort({ _id: 1 })
      .limit(SYNC_BATCH_SIZE)
      .lean();

    if (users.length === 0) break;

    const serviceInterestByUser = new Map<string, string[]>();
    const userIds = users.map((u) => u._id);
    const bookingServices = await Booking.aggregate<{
      _id: unknown;
      services: string[];
    }>([
      { $match: { customer: { $in: userIds }, 'rfqData.serviceType': { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$customer',
          services: { $addToSet: '$rfqData.serviceType' },
        },
      },
    ]);
    for (const row of bookingServices) {
      serviceInterestByUser.set(String(row._id), (row.services || []).filter(Boolean));
    }
    const bookingActivity = await Booking.aggregate<{ _id: unknown; lastEngagedAt: Date }>([
      {
        $match: {
          $or: [{ customer: { $in: userIds } }, { professional: { $in: userIds } }],
        },
      },
      { $project: { actors: ['$customer', '$professional'], updatedAt: 1 } },
      { $unwind: '$actors' },
      { $match: { actors: { $in: userIds } } },
      { $group: { _id: '$actors', lastEngagedAt: { $max: '$updatedAt' } } },
    ]);
    const bookingActivityByUser = new Map(
      bookingActivity.map((row) => [String(row._id), row.lastEngagedAt]),
    );

    const emails = users
      .map((user) => String(user.email || '').toLowerCase().trim())
      .filter(Boolean);
    const existingSubscribers = await MarketingSubscriber.find({
      $or: [
        { email: { $in: emails } },
        { emailNormalized: { $in: emails } },
        { userId: { $in: userIds } },
      ],
    }).lean();
    const existingByEmail = new Map(
      existingSubscribers.map((sub) => [normalizeEmail(sub.emailNormalized || sub.email), sub]),
    );
    const existingByUserId = new Map(
      existingSubscribers
        .filter((sub) => sub.userId)
        .map((sub) => [String(sub.userId), sub]),
    );
    const expectedSyncs: Array<{ userId: string; email: string; role: keyof MarketingRoleCounts }> = [];
    const operations: Parameters<typeof MarketingSubscriber.bulkWrite>[0] = [];

    for (const user of users) {
      const email = normalizeEmail(user.email);
      if (!email) continue;
      const role: keyof MarketingRoleCounts | undefined =
        user.role === 'customer' || user.role === 'professional' ? user.role : undefined;
      if (!role) continue;

      const toggleOn = isPromotionalEmailEnabled(user.notificationPreferences);
      if (toggleOn) eligibleByRole[role] += 1;

      if (toggleOn && !toConsentDate(user.marketingConsentAt)) {
        const backfilled = new Date();
        await User.updateOne({ _id: user._id }, { $set: { marketingConsentAt: backfilled } });
        (user as { marketingConsentAt?: Date }).marketingConsentAt = backfilled;
      }

      const { optedIn, consentVerifiedAt } = promotionalEmailOptIn(user);
      const fromBookings = serviceInterestByUser.get(String(user._id)) || [];
      const profile = subscriberProfileForUser(user, fromBookings, serviceIndex);
      const existingByCurrentEmail = existingByEmail.get(email);
      const existingByUser = existingByUserId.get(String(user._id));
      const existing = existingByCurrentEmail || existingByUser;
      const bookingEngagement = bookingActivityByUser.get(String(user._id));
      const lastEngagedAt = bookingEngagement;

      if (!optedIn) {
        if (existing) {
          operations.push({
            updateMany: {
              filter: {
                $or: [
                  { userId: user._id },
                  { email },
                  { emailNormalized: email },
                ],
              },
              update: {
                $set: { unsubscribedAt: new Date() },
                $unset: { consentVerifiedAt: 1 },
              },
            },
          });
          unsubscribed += 1;
        }
        continue;
      }

      const metadata: Record<string, unknown> = {
        userId: user._id,
        emailNormalized: email,
        ...profile,
        lastEngagedAt,
        consentVerifiedAt,
      };
      const unset: Record<string, 1> = {};
      if (!profile.name) unset.name = 1;
      if (!profile.firstName) unset.firstName = 1;
      if (!profile.region) unset.region = 1;

      if (existing) {
        operations.push({
          updateOne: {
            filter: { _id: existing._id },
            update: {
              $set: { ...metadata, email, unsubscribedAt: null },
              ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
            },
          },
        });
        // Demote every other subscriber row owned by this user (not only the
        // email-collision match), so stale addresses cannot stay opted-in.
        operations.push({
          updateMany: {
            filter: { userId: user._id, _id: { $ne: existing._id } },
            update: { $set: { unsubscribedAt: new Date() }, $unset: { consentVerifiedAt: 1 } },
          },
        });
      } else {
        operations.push({
          updateOne: {
            filter: { email },
            update: {
              $set: { ...metadata, unsubscribedAt: null },
              ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
              $setOnInsert: {
                unsubscribeToken: generateUnsubscribeToken(),
                source: 'user_sync',
                subscribedAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
      expectedSyncs.push({ userId: String(user._id), email, role });
    }

    if (operations.length > 0) {
      const result = await MarketingSubscriber.bulkWrite(operations, { ordered: false });
      // Mongoose reports per-operation cast/default failures on the result
      // instead of rejecting the promise. Never claim a sync that wrote nothing.
      const validationErrors = (result as any)?.mongoose?.validationErrors;
      if (Array.isArray(validationErrors) && validationErrors.length > 0) {
        throw validationErrors[0];
      }
    }

    // Report persisted local subscriber rows, including a concurrent zero-match write.
    if (expectedSyncs.length > 0) {
      const persisted = await MarketingSubscriber.find({
        userId: { $in: expectedSyncs.map(row => row.userId) },
        consentVerifiedAt: { $type: 'date' },
        unsubscribedAt: null,
      }).select('userId emailNormalized email role').lean();
      const synced = new Set(persisted.map(row => `${row.userId}:${normalizeEmail(row.emailNormalized || row.email)}:${row.role}`));
      for (const row of expectedSyncs) {
        if (!synced.has(`${row.userId}:${row.email}:${row.role}`)) continue;
        syncedByRole[row.role] += 1;
        upserted += 1;
      }
    }

    lastUserId = users[users.length - 1]._id;
    if (users.length < SYNC_BATCH_SIZE) break;
  }

  return {
    upserted,
    unsubscribed,
    eligibleByRole,
    syncedByRole,
    skippedByRole: {
      customer: Math.max(0, eligibleByRole.customer - syncedByRole.customer),
      professional: Math.max(0, eligibleByRole.professional - syncedByRole.professional),
    },
  };
}

/**
 * Repair canonical metadata on an existing consented subscriber row after a
 * professional changes their country, service categories or language. Never
 * creates a row, never grants consent, and never touches a lead.
 */
export async function refreshSubscriberProfileFromUser(user: any): Promise<void> {
  const email = normalizeEmail(user?.email);
  if (!email) return;
  try {
    const existing = await MarketingSubscriber.findOne({
      $or: [
        ...(user?._id ? [{ userId: user._id }] : []),
        { email },
        { emailNormalized: email },
      ],
      unsubscribedAt: null,
      consentVerifiedAt: { $type: 'date' },
    })
      .select('_id')
      .lean();
    if (!existing) return;
    const serviceIndex = await loadServiceIndexSafe('profile update');
    if (!serviceIndex) return;
    const profile = subscriberProfileForUser(user, [], serviceIndex);
    const set: Record<string, unknown> = {
      emailNormalized: email,
      role: profile.role,
      locale: profile.locale,
      localeSource: profile.localeSource,
      interestedServices: profile.interestedServices,
      serviceKeys: profile.serviceKeys,
      name: profile.name,
      firstName: profile.firstName,
      region: profile.region,
    };
    const unset: Record<string, 1> = {};
    for (const key of ['role', 'name', 'firstName', 'region'] as const) {
      if (set[key] === undefined) {
        delete set[key];
        unset[key] = 1;
      }
    }
    await MarketingSubscriber.updateOne(
      { _id: existing._id },
      { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
    );
  } catch (error) {
    // The profile write already succeeded. Keep it and let the next sync repair.
    console.error('[MARKETING] Subscriber profile refresh failed', safeErrorSummary(error));
  }
}

/** Retry Brevo suppression for locally unsubscribed contacts. */
export async function syncPendingBrevoUnsubscribes(limit = 100, email?: string): Promise<{
  synced: number;
  pending: number;
}> {
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const subscribers = await MarketingSubscriber.find({
    unsubscribedAt: { $ne: null },
    brevoUnsubscribedAt: null,
    ...(email
          ? {
              $or: [
                { email: email.toLowerCase().trim() },
                { emailNormalized: normalizeEmail(email) },
              ],
            }
      : {
          $or: [
            { brevoUnsubscribeError: { $exists: false } },
            { brevoUnsubscribeError: null },
            { updatedAt: { $lt: startOfUtcDay } },
          ],
        }),
  })
    .select('email')
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean();
  let synced = 0;

  for (const subscriber of subscribers) {
    try {
      const suppressed = await suppressBrevoMarketingContact(subscriber.email);
      if (!suppressed) continue;
      const updated = await MarketingSubscriber.updateOne(
        { _id: subscriber._id, unsubscribedAt: { $ne: null } },
        { $set: { brevoUnsubscribedAt: new Date() }, $unset: { brevoUnsubscribeError: 1 } },
      );
      if (updated.matchedCount > 0) synced += 1;
    } catch (error) {
      await MarketingSubscriber.updateOne(
        { _id: subscriber._id, unsubscribedAt: { $ne: null } },
        {
          $set: {
            brevoUnsubscribeError:
              error instanceof Error ? error.message : 'Brevo suppression failed',
          },
        },
      );
    }
  }

  return { synced, pending: subscribers.length - synced };
}

/** Retry provider reactivation for users who explicitly restored consent. */
export async function syncPendingBrevoResubscribes(limit = 100, email?: string): Promise<{
  synced: number;
  pending: number;
}> {
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const subscribers = await MarketingSubscriber.find({
    unsubscribedAt: null,
    consentVerifiedAt: { $type: 'date' },
    brevoUnsubscribedAt: { $ne: null },
      ...(email
      ? {
          $or: [
            { email: email.toLowerCase().trim() },
            { emailNormalized: normalizeEmail(email) },
          ],
        }
      : {
          $or: [
            { brevoResubscribeError: { $exists: false } },
            { brevoResubscribeError: null },
            { updatedAt: { $lt: startOfUtcDay } },
          ],
        }),
  })
    .select('email')
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean();
  let synced = 0;

  for (const subscriber of subscribers) {
    try {
      const restored = await restoreBrevoMarketingContact(subscriber.email);
      if (!restored) continue;
      const updated = await MarketingSubscriber.updateOne(
        {
          _id: subscriber._id,
          unsubscribedAt: null,
          consentVerifiedAt: { $type: 'date' },
        },
        {
          $set: { brevoUnsubscribedAt: null },
          $unset: { brevoResubscribeError: 1, brevoUnsubscribeError: 1 },
        },
      );
      if (updated.matchedCount > 0) synced += 1;
    } catch (error) {
      await MarketingSubscriber.updateOne(
        {
          _id: subscriber._id,
          unsubscribedAt: null,
          consentVerifiedAt: { $type: 'date' },
        },
        {
          $set: {
            brevoResubscribeError:
              error instanceof Error ? error.message : 'Brevo reactivation failed',
          },
        },
      );
    }
  }

  return { synced, pending: subscribers.length - synced };
}

function audienceQuery(
  audience: ICampaignAudience,
  opts?: { inactiveDays?: number },
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [
    { unsubscribedAt: null },
    { consentVerifiedAt: { $type: 'date' } },
    // A contact that is still globally blacklisted at Brevo is not deliverable,
    // even if local consent has just been restored. The retry sync clears this.
    { brevoUnsubscribedAt: null },
  ];
  const countries = (audience.countries || []).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (countries.length > 0) clauses.push({ region: { $in: countries } });

  const locales = (audience.locales || []) as MarketingLocale[];
  if (locales.length > 0) clauses.push({ locale: { $in: locales } });

  const services = (audience.interestedServices || []).map((s) => s.trim()).filter(Boolean);
  if (services.length > 0) clauses.push({ interestedServices: { $in: services } });

  const roles = audience.roles?.length ? audience.roles : ['customer', 'professional'];
  if (!(roles.includes('customer') && roles.includes('professional'))) {
    clauses.push(
      roles.includes('customer')
        ? { $or: [{ role: 'customer' }, { role: null }, { role: { $exists: false } }] }
        : { role: 'professional' },
    );
  }

  if (opts?.inactiveDays && opts.inactiveDays > 0) {
    const cutoff = new Date(Date.now() - opts.inactiveDays * 24 * 60 * 60 * 1000);
    clauses.push({
      $or: [
        { lastEngagedAt: { $lte: cutoff } },
        { lastEngagedAt: null },
        { lastEngagedAt: { $exists: false } },
      ],
    });
    clauses.push({ subscribedAt: { $lte: cutoff } });
  }

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/** Resolve active subscribers matching campaign audience filters. */
export async function resolveCampaignAudience(
  audience: ICampaignAudience,
  opts?: { inactiveDays?: number; max?: number; rejectTruncated?: boolean },
): Promise<AudienceMember[]> {
  const query = audienceQuery(audience, opts);
  const limit = Math.min(Math.max(opts?.max || MARKETING_AUDIENCE_LIMIT, 1), 10000);
  if (opts?.rejectTruncated) {
    const count = await MarketingSubscriber.countDocuments(query);
    if (count > limit) {
      throw new Error(
        `Audience has ${count} recipients, exceeding the configured delivery limit of ${limit}`,
      );
    }
  }
  const subs = await MarketingSubscriber.find(query).sort({ _id: 1 }).limit(limit).lean();

  return subs.map((s) => ({
    email: s.email,
    name: s.name || undefined,
    locale: normalizeLocale(s.locale),
    region: s.region || undefined,
    userId: s.userId ? String(s.userId) : undefined,
    subscriberId: String(s._id),
  }));
}

export async function countCampaignAudience(
  audience: ICampaignAudience,
  opts?: { inactiveDays?: number },
): Promise<{ count: number; truncated: boolean }> {
  const count = await MarketingSubscriber.countDocuments(audienceQuery(audience, opts));
  return { count, truncated: count > MARKETING_AUDIENCE_LIMIT };
}
