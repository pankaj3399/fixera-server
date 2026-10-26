import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscriberFind, subscriberCountDocuments, suppressionFind, userFind, leadFind, leadCountDocuments } = vi.hoisted(() => ({
  subscriberFind: vi.fn(),
  subscriberCountDocuments: vi.fn(),
  suppressionFind: vi.fn(),
  userFind: vi.fn(),
  leadFind: vi.fn(),
  leadCountDocuments: vi.fn(),
}));

function queryResult(rows: unknown[]) {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: async () => rows,
  };
  return query;
}

function isSuppressionSubscriberQuery(query: Record<string, any>): boolean {
  const json = JSON.stringify(query || {});
  return (
    json.includes('"unsubscribedAt":{"$ne":null}') ||
    json.includes('"brevoUnsubscribedAt":{"$ne":null}')
  );
}

vi.mock('../../../models/marketingSubscriber', () => ({
  default: { find: subscriberFind, countDocuments: subscriberCountDocuments },
}));
vi.mock('../../../models/marketingSuppression', () => ({
  default: { find: suppressionFind },
}));
vi.mock('../../../models/user', () => ({
  default: { find: userFind },
}));
vi.mock('../../../models/marketingLead', () => ({
  default: { find: leadFind, countDocuments: leadCountDocuments },
}));
vi.mock('../../../utils/marketing/audience', () => ({ MARKETING_AUDIENCE_LIMIT: 5000 }));

import { resolveMarketingAudience } from '../../../utils/marketing/audienceResolver';

describe('resolveMarketingAudience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberCountDocuments.mockResolvedValue(3);
    suppressionFind.mockReturnValue(queryResult([{ emailNormalized: 'optedout@example.com' }]));
    userFind.mockReturnValue(queryResult([]));
    leadFind.mockReturnValue(queryResult([]));
    leadCountDocuments.mockResolvedValue(0);
    subscriberFind.mockImplementation((query: Record<string, any>) => isSuppressionSubscriberQuery(query)
      ? queryResult([{ emailNormalized: 'legacy-optout@example.com', email: 'legacy-optout@example.com' }])
      : queryResult([
          {
            _id: 'subscriber-1',
            email: 'PERSON@example.com',
            emailNormalized: 'person@example.com',
            name: 'Person Example',
            locale: 'de',
            region: 'DE',
            role: 'professional',
            serviceKeys: ['plumbing'],
            consentVerifiedAt: new Date(),
            unsubscribedAt: null,
            brevoUnsubscribedAt: null,
          },
          {
            _id: 'subscriber-duplicate',
            email: 'person@example.com',
            emailNormalized: 'person@example.com',
            locale: 'de',
            region: 'DE',
            role: 'professional',
            consentVerifiedAt: new Date(),
            unsubscribedAt: null,
            brevoUnsubscribedAt: null,
          },
          {
            _id: 'subscriber-opted-out',
            email: 'optedout@example.com',
            emailNormalized: 'optedout@example.com',
            locale: 'de',
            region: 'DE',
            role: 'professional',
            consentVerifiedAt: new Date(),
            unsubscribedAt: null,
            brevoUnsubscribedAt: null,
          },
        ]));
  });

  it('deduplicates subscribers and reports exact language and account-type counts', async () => {
    const result = await resolveMarketingAudience({
      campaignType: 'newsletter',
      filters: { countries: ['DE'], interestedServices: [], serviceKeys: ['plumbing'], locales: ['de'], roles: ['professional'] },
      contentLocales: ['de'],
      limitMode: 'preview',
    });

    expect(result.exactTotal).toBe(1);
    expect(result.exactTotalIsEstimate).toBe(false);
    expect(result.byLocale).toEqual({ de: 1 });
    expect(result.byRole).toEqual({ customer: 0, professional: 1 });
    expect(result.deduplicated).toBe(1);
    expect(result.excluded.suppressed).toBe(1);
    expect(result.recipients[0]).toMatchObject({
      email: 'person@example.com',
      firstName: 'Person',
      subscriberId: 'subscriber-1',
    });
  });

  it('uses an explicit user language before the stored subscriber locale and reports mismatches', async () => {
    subscriberFind.mockImplementation((query: Record<string, any>) => isSuppressionSubscriberQuery(query)
      ? queryResult([])
      : queryResult([{
          _id: 'subscriber-2',
          userId: 'user-2',
          email: 'language@example.com',
          emailNormalized: 'language@example.com',
          name: 'Language Example',
          locale: 'nl',
          region: 'BE',
          role: 'customer',
          consentVerifiedAt: new Date(),
          unsubscribedAt: null,
          brevoUnsubscribedAt: null,
        }]));
    userFind.mockReturnValue(queryResult([{ _id: 'user-2', name: 'User Name', marketingLocale: 'fr' }]));

    const result = await resolveMarketingAudience({
      campaignType: 'newsletter',
      filters: { countries: ['BE'], interestedServices: [], serviceKeys: [], locales: ['fr'], roles: ['customer'] },
      contentLocales: ['fr'],
      limitMode: 'preview',
    });

    expect(result.recipients[0]).toMatchObject({ locale: 'fr', firstName: 'Language' });
    expect(result.byLocale).toEqual({ fr: 1 });
    expect(result.byRole).toEqual({ customer: 1, professional: 0 });
    expect(result.excluded.localeMismatch).toBe(0);
  });

  it('reports over-limit audiences while delivery mode caps recipients', async () => {
    const rows = Array.from({ length: 5001 }, (_, index) => ({
      _id: `subscriber-${index}`,
      email: `recipient-${index}@example.com`,
      emailNormalized: `recipient-${index}@example.com`,
      locale: 'en',
      region: 'BE',
      role: 'customer',
      consentVerifiedAt: new Date(),
      unsubscribedAt: null,
      brevoUnsubscribedAt: null,
    }));
    subscriberFind.mockImplementation((query: Record<string, any>) =>
      isSuppressionSubscriberQuery(query) ? queryResult([]) : queryResult(rows),
    );
    subscriberCountDocuments.mockResolvedValue(rows.length);

    const input = {
      campaignType: 'newsletter' as const,
      filters: { countries: ['BE'], interestedServices: [], serviceKeys: [], locales: ['en'], roles: ['customer'] as const },
      contentLocales: ['en'],
    };
    const preview = await resolveMarketingAudience({ ...input, limitMode: 'preview' });
    const delivery = await resolveMarketingAudience({ ...input, limitMode: 'delivery' });

    expect(preview.exactTotal).toBe(5001);
    expect(preview.exactTotalIsEstimate).toBe(true);
    expect(preview.overLimit).toBe(true);
    expect(preview.recipients).toHaveLength(5001);
    expect(delivery.exactTotal).toBe(5001);
    expect(delivery.exactTotalIsEstimate).toBe(true);
    expect(delivery.overLimit).toBe(true);
    expect(delivery.recipients).toHaveLength(5000);
  });
});
