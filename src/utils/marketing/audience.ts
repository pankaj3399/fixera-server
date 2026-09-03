import User from '../../models/user';
import Booking from '../../models/booking';
import MarketingSubscriber, {
  type IMarketingSubscriber,
  type MarketingLocale,
  MARKETING_LOCALES,
} from '../../models/marketingSubscriber';
import type { ICampaignAudience } from '../../models/marketingCampaign';
import { generateUnsubscribeToken } from './unsubscribeToken';
import { promotionalEmailOptIn, isPromotionalEmailEnabled, toConsentDate } from './promotionalConsent';
import {
  restoreBrevoMarketingContact,
  suppressBrevoMarketingContact,
} from './brevoMarketing';
import { normalizeEmail } from './normalizeEmail';
import { normalizeMarketingLocale, resolveSubscriberLocale } from './marketingCatalog';

export type AudienceMember = {
  email: string;
  name?: string;
  locale: MarketingLocale;
  region?: string;
  userId?: string;
  subscriberId?: string;
};

export const MARKETING_AUDIENCE_LIMIT = 5000;

function normalizeCountry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed || undefined;
}

function userCountry(user: any): string | undefined {
  return (
    normalizeCountry(user?.location?.country) ||
    normalizeCountry(user?.companyAddress?.country) ||
    normalizeCountry(user?.businessInfo?.country)
  );
}

function normalizeLocale(value: unknown): MarketingLocale {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase().slice(0, 2);
    if ((MARKETING_LOCALES as readonly string[]).includes(lower)) {
      return lower as MarketingLocale;
    }
  }
  return 'en';
}

/** Sync opted-in users into MarketingSubscriber collection. */
export async function syncSubscribersFromUsers(): Promise<{
  upserted: number;
  unsubscribed: number;
}> {
  const SYNC_BATCH_SIZE = 500;
  const baseQuery = {
    email: { $exists: true, $nin: [null, ''] },
    role: { $in: ['customer', 'professional'] },
    deletedAt: null,
  };
  let lastUserId: unknown;
  let upserted = 0;
  let unsubscribed = 0;

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
    const operations: Parameters<typeof MarketingSubscriber.bulkWrite>[0] = [];

    for (const user of users) {
      const email = normalizeEmail(user.email);
      if (!email) continue;

      if (isPromotionalEmailEnabled(user.notificationPreferences) && !toConsentDate(user.marketingConsentAt)) {
        const backfilled = new Date();
        await User.updateOne({ _id: user._id }, { $set: { marketingConsentAt: backfilled } });
        (user as { marketingConsentAt?: Date }).marketingConsentAt = backfilled;
      }

      const { optedIn, consentVerifiedAt } = promotionalEmailOptIn(user);
      const region = userCountry(user);
      const fromBookings = serviceInterestByUser.get(String(user._id)) || [];
      const fromPro =
        Array.isArray((user as any).serviceCategories) ? (user as any).serviceCategories : [];
      const interestedServices = Array.from(new Set([...fromBookings, ...fromPro].map(String)));
      // Seed locale from explicit user preference, then country default, then English.
      const resolvedLocale = resolveSubscriberLocale(user, region);
      const locale = resolvedLocale.locale;
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
        role: user.role,
        interestedServices,
        serviceKeys: interestedServices,
        locale,
        localeSource: resolvedLocale.source,
        lastEngagedAt,
        consentVerifiedAt,
      };
      if (typeof user.name === 'string' && user.name.trim()) metadata.name = user.name.trim();
      if (typeof user.name === 'string' && user.name.trim()) metadata.firstName = user.name.trim().split(/\s+/)[0];
      if (region) metadata.region = region;
      const unset: Record<string, 1> = {};
      if (!metadata.name) unset.name = 1;
      if (!region) unset.region = 1;

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
      upserted += 1;
    }

    if (operations.length > 0) {
      await MarketingSubscriber.bulkWrite(operations, { ordered: false });
    }

    lastUserId = users[users.length - 1]._id;
    if (users.length < SYNC_BATCH_SIZE) break;
  }

  return { upserted, unsubscribed };
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
