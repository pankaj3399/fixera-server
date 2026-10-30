import MarketingLead from '../../models/marketingLead';
import MarketingSubscriber, { type MarketingLocale } from '../../models/marketingSubscriber';
import User from '../../models/user';
import {
  campaignAudienceType,
  type MarketingAudienceType,
  type MarketingCampaignType,
  type ICampaignAudience,
} from '../../models/marketingCampaign';
import { MARKETING_AUDIENCE_LIMIT } from './audience';
import { isValidEmail, normalizeEmail } from './normalizeEmail';
import {
  MARKETING_LOCALES,
  defaultMarketingLocaleForCountry,
  normalizeMarketingLanguage,
} from './marketingCatalog';
import { loadSuppressedEmailSet } from './suppression';

export type ResolvedMarketingRecipient = {
  email: string;
  firstName?: string;
  locale: MarketingLocale;
  country?: string;
  serviceKeys: string[];
  role?: 'customer' | 'professional';
  source: 'subscriber' | 'lead';
  subscriberId?: string;
  leadId?: string;
  userId?: string;
};

export type MarketingAudienceResolution = {
  recipients: ResolvedMarketingRecipient[];
  exactTotal: number;
  exactTotalIsEstimate: boolean;
  bySource: { subscribers: number; leads: number };
  byLocale: Record<string, number>;
  byRole: { customer: number; professional: number };
  deduplicated: number;
  // Diagnostic counts for fetched candidates, after source-query eligibility filters.
  excluded: {
    suppressed: number;
    invalidEmail: number;
    missingLocale: number;
    roleMismatch: number;
    localeMismatch: number;
  };
  fallbackLocaleCount: number;
  overLimit: boolean;
  criteriaHash: string;
};

export type ResolveMarketingAudienceInput = {
  campaignType: MarketingCampaignType;
  audienceType?: MarketingAudienceType;
  filters: ICampaignAudience;
  contentLocales?: readonly string[];
  inactiveDays?: number;
  limitMode?: 'delivery' | 'preview';
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalFilters(filters: ICampaignAudience) {
  return {
    countries: [...(filters.countries || [])].map((v) => clean(v).toUpperCase()).filter(Boolean).sort(),
    interestedServices: [...(filters.interestedServices || [])].map(clean).filter(Boolean).sort(),
    serviceKeys: [...(filters.serviceKeys || [])].map(clean).filter(Boolean).sort(),
    locales: [...(filters.locales || [])].map((v) => clean(v).toLowerCase()).filter(Boolean).sort(),
    roles: [...(filters.roles || [])].sort(),
  };
}

function hashCriteria(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function inactiveClauses(inactiveDays?: number): Record<string, unknown>[] {
  if (!inactiveDays || inactiveDays <= 0) return [];
  const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
  return [
    { subscribedAt: { $lte: cutoff } },
    { $or: [{ lastEngagedAt: { $lte: cutoff } }, { lastEngagedAt: null }, { lastEngagedAt: { $exists: false } }] },
  ];
}

function subscriberQuery(filters: ICampaignAudience, inactiveDays?: number): Record<string, unknown> {
  const normalized = canonicalFilters(filters);
  const clauses: Record<string, unknown>[] = [
    { unsubscribedAt: null },
    { consentVerifiedAt: { $type: 'date' } },
    { brevoUnsubscribedAt: null },
  ];
  if (normalized.countries.length) clauses.push({ region: { $in: normalized.countries } });
  if (normalized.serviceKeys.length && normalized.interestedServices.length) {
    clauses.push({ $or: [{ serviceKeys: { $in: normalized.serviceKeys } }, { interestedServices: { $in: normalized.interestedServices } }] });
  } else if (normalized.serviceKeys.length) {
    clauses.push({ serviceKeys: { $in: normalized.serviceKeys } });
  } else if (normalized.interestedServices.length) {
    clauses.push({ interestedServices: { $in: normalized.interestedServices } });
  }
  const roles = normalized.roles.length ? normalized.roles : ['customer', 'professional'];
  if (roles.length === 1) {
    clauses.push({ $or: [{ role: roles[0] }, ...(roles[0] === 'customer' ? [{ role: null }, { role: { $exists: false } }] : [])] });
  }
  clauses.push(...inactiveClauses(inactiveDays));
  return { $and: clauses };
}

function leadQuery(filters: ICampaignAudience): Record<string, unknown> {
  const normalized = canonicalFilters(filters);
  // Do not pre-filter unsubscribedAt: the resolver must count those rows in
  // excluded.suppressed and must not fall through to another row for a mailbox
  // that has opted out.
  const clauses: Record<string, unknown>[] = [
    { status: 'active' },
    { identityHash: { $exists: true } },
  ];
  if (normalized.countries.length) clauses.push({ country: { $in: normalized.countries } });
  if (normalized.locales.length) clauses.push({ locale: { $in: normalized.locales } });
  if (normalized.serviceKeys.length && normalized.interestedServices.length) {
    clauses.push({
      $or: [
        { serviceKeys: { $in: normalized.serviceKeys } },
        { interestedServices: { $in: normalized.interestedServices } },
      ],
    });
  } else if (normalized.serviceKeys.length) {
    clauses.push({ serviceKeys: { $in: normalized.serviceKeys } });
  } else if (normalized.interestedServices.length) {
    clauses.push({ interestedServices: { $in: normalized.interestedServices } });
  }
  return { $and: clauses };
}

function firstNameForSubscriber(subscriber: any, user?: any): string | undefined {
  if (typeof subscriber.firstName === 'string' && subscriber.firstName.trim()) return subscriber.firstName.trim();
  if (typeof subscriber.name === 'string' && subscriber.name.trim()) return subscriber.name.trim().split(/\s+/)[0];
  if (typeof user?.name === 'string' && user.name.trim()) return user.name.trim().split(/\s+/)[0];
  return undefined;
}

function resolvedLocale(
  raw: unknown,
  country: unknown,
  contentLocales: Set<MarketingLocale>,
  userLocale?: unknown,
): { locale?: MarketingLocale; fallback: boolean } {
  const explicit =
    normalizeMarketingLanguage(userLocale) || normalizeMarketingLanguage(raw);
  const countryDefault = defaultMarketingLocaleForCountry(country);
  const candidate = explicit || countryDefault;
  if (contentLocales.has(candidate)) return { locale: candidate, fallback: !explicit };
  if (contentLocales.has('en')) return { locale: 'en', fallback: true };
  return { locale: undefined, fallback: true };
}

/**
 * Active consented subscriber mailboxes among the candidate lead emails. This
 * is source precedence, not a filter: a subscriber row is authoritative for
 * the mailbox even when it is ineligible for the selected role or locale.
 */
async function activeConsentedSubscriberEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await MarketingSubscriber.find({
    $and: [
      {
        $or: [
          { emailNormalized: { $in: emails } },
          { email: { $in: emails } },
        ],
      },
      { unsubscribedAt: null },
      { consentVerifiedAt: { $type: 'date' } },
      { brevoUnsubscribedAt: null },
    ],
  })
    .select('emailNormalized email')
    .lean();
  return new Set(
    rows
      .map((row) => normalizeEmail(row.emailNormalized || row.email))
      .filter(Boolean),
  );
}

export async function resolveMarketingAudience(
  input: ResolveMarketingAudienceInput,
): Promise<MarketingAudienceResolution> {
  const audienceType = campaignAudienceType(input.audienceType);
  if (!audienceType) {
    throw new Error('Audience type must be one of: subscribers, both, leads');
  }
  const requestedRoles = input.filters.roles?.length
    ? input.filters.roles
    : (['customer', 'professional'] as const);
  if (audienceType !== 'subscribers') {
    if (input.campaignType !== 'invitation') {
      throw new Error('Lead audiences are only available for invitation campaigns');
    }
    if (!requestedRoles.includes('professional')) {
      throw new Error('Lead audiences require the professional role');
    }
  }

  const filters = canonicalFilters(input.filters);
  const contentLocales = new Set(
    (input.contentLocales && input.contentLocales.length ? input.contentLocales : MARKETING_LOCALES)
      .map((locale) => normalizeMarketingLanguage(locale))
      .filter((locale): locale is MarketingLocale => Boolean(locale)),
  );
  const wantSubscribers = audienceType !== 'leads';
  const wantLeads = audienceType !== 'subscribers';
  const subscriberSelector = subscriberQuery(input.filters, input.inactiveDays);
  const leadSelector = leadQuery(input.filters);

  const [subscribers, matchedSubscriberCount, leads, matchedLeadCount] = await Promise.all([
    wantSubscribers
      ? MarketingSubscriber.find(subscriberSelector)
          .sort({ _id: 1 })
          .limit(MARKETING_AUDIENCE_LIMIT + 1)
          .lean()
      : Promise.resolve([] as any[]),
    wantSubscribers ? MarketingSubscriber.countDocuments(subscriberSelector) : Promise.resolve(0),
    wantLeads
      ? MarketingLead.find(leadSelector)
          .sort({ _id: 1 })
          .limit(MARKETING_AUDIENCE_LIMIT + 1)
          .lean()
      : Promise.resolve([] as any[]),
    wantLeads ? MarketingLead.countDocuments(leadSelector) : Promise.resolve(0),
  ]);

  const leadEmails = leads
    .map((row: any) => normalizeEmail(row.emailNormalized || row.email))
    .filter(Boolean);
  // A lead opt-out is a mailbox opt-out for the lead source, even if the
  // opt-out row has a different country/language/service dimension and was
  // filtered out of this preview.
  const leadOptOutEmails = new Set<string>(
    leadEmails.length === 0
      ? []
      : (
          await MarketingLead.find({
            emailNormalized: { $in: leadEmails },
            unsubscribedAt: { $ne: null },
          })
            .select('emailNormalized')
            .lean()
        )
          .map((row) => normalizeEmail(row.emailNormalized))
          .filter(Boolean),
  );
  const subscriberAuthoritativeEmails =
    audienceType === 'both'
      ? await activeConsentedSubscriberEmails(leadEmails)
      : new Set<string>();

  const candidateEmails = [
    ...subscribers.map((row: any) => normalizeEmail(row.emailNormalized || row.email)),
    ...leadEmails,
  ].filter(Boolean);
  const suppressed = await loadSuppressedEmailSet(candidateEmails);

  const userIds = subscribers.map((row: any) => row.userId).filter(Boolean);
  const users = userIds.length > 0
    ? await User.find({ _id: { $in: userIds } }).select('name marketingLocale').lean()
    : [];
  const usersById = new Map(users.map((user: any) => [String(user._id), user]));

  const seen = new Set<string>();
  const recipients: ResolvedMarketingRecipient[] = [];
  const bySource = { subscribers: 0, leads: 0 };
  const byLocale: Record<string, number> = {};
  const byRole = { customer: 0, professional: 0 };
  let invalidEmail = 0;
  let missingLocale = 0;
  let suppressedCount = 0;
  let roleMismatch = 0;
  let localeMismatch = 0;
  let deduplicated = 0;
  let fallbackLocaleCount = 0;

  const add = (row: any, source: 'subscriber' | 'lead') => {
    const email = normalizeEmail(row.emailNormalized || row.email);
    if (!isValidEmail(email)) {
      invalidEmail += 1;
      return;
    }
    if (
      suppressed.has(email) ||
      row.unsubscribedAt ||
      (source === 'lead' && leadOptOutEmails.has(email))
    ) {
      suppressedCount += 1;
      return;
    }
    if (source === 'lead' && subscriberAuthoritativeEmails.has(email)) {
      // Subscriber precedence: the mailbox belongs to a consented subscriber.
      deduplicated += 1;
      return;
    }
    const user = source === 'subscriber' && row.userId
      ? usersById.get(String(row.userId))
      : undefined;
    const role = source === 'lead' ? 'professional' : row.role;
    if (role && !requestedRoles.includes(role)) {
      roleMismatch += 1;
      return;
    }
    const locale = resolvedLocale(
      row.locale,
      source === 'lead' ? row.country : row.region,
      contentLocales,
      user?.marketingLocale,
    );
    if (!locale.locale) {
      missingLocale += 1;
      return;
    }
    if (filters.locales.length > 0 && !filters.locales.includes(locale.locale)) {
      localeMismatch += 1;
      return;
    }
    if (seen.has(email)) {
      deduplicated += 1;
      return;
    }
    seen.add(email);
    if (locale.fallback) fallbackLocaleCount += 1;
    const resolvedRole = role === 'professional' ? 'professional' : 'customer';
    byLocale[locale.locale] = (byLocale[locale.locale] || 0) + 1;
    byRole[resolvedRole] += 1;
    bySource[source === 'subscriber' ? 'subscribers' : 'leads'] += 1;
    recipients.push({
      email,
      firstName: source === 'subscriber' ? firstNameForSubscriber(row, user) : undefined,
      locale: locale.locale,
      country: source === 'lead' ? row.country : row.region,
      serviceKeys: Array.isArray(row.serviceKeys) && row.serviceKeys.length
        ? row.serviceKeys
        : (row.interestedServices || []),
      role: resolvedRole,
      source,
      subscriberId: source === 'subscriber' ? String(row._id) : undefined,
      leadId: source === 'lead' ? String(row._id) : undefined,
      userId: source === 'subscriber' && row.userId ? String(row.userId) : undefined,
    });
  };

  for (const row of subscribers) add(row, 'subscriber');
  for (const row of leads) add(row, 'lead');

  const overLimit =
    matchedSubscriberCount > MARKETING_AUDIENCE_LIMIT ||
    matchedLeadCount > MARKETING_AUDIENCE_LIMIT ||
    recipients.length > MARKETING_AUDIENCE_LIMIT;
  const exactTotalIsEstimate =
    matchedSubscriberCount > MARKETING_AUDIENCE_LIMIT ||
    matchedLeadCount > MARKETING_AUDIENCE_LIMIT;
  const exactTotal = exactTotalIsEstimate
    ? Math.max(0, matchedSubscriberCount + matchedLeadCount - deduplicated)
    : recipients.length;
  const criteriaHash = hashCriteria({
    campaignType: input.campaignType,
    // Subscribers is the legacy default. Omitting it from the serialized hash
    // keeps retry compatibility with partially delivered pre-audience-type
    // campaigns while still distinguishing every lead-inclusive audience.
    audienceType: audienceType === 'subscribers' ? undefined : audienceType,
    filters,
    contentLocales: [...contentLocales],
    inactiveDays: input.inactiveDays || null,
  });
  return {
    recipients: input.limitMode === 'delivery'
      ? recipients.slice(0, MARKETING_AUDIENCE_LIMIT)
      : recipients,
    exactTotal,
    exactTotalIsEstimate,
    bySource,
    byLocale,
    byRole,
    deduplicated,
    excluded: { suppressed: suppressedCount, invalidEmail, missingLocale, roleMismatch, localeMismatch },
    fallbackLocaleCount,
    overLimit,
    criteriaHash,
  };
}
