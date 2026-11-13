import { describe, expect, it } from 'vitest';
import { buildPublicAnnouncementAggregationPipeline } from '../../../utils/siteAnnouncements/publicAggregation';
import { selectPublicAnnouncementWinners } from '../../../utils/siteAnnouncements/selectPublicWinners';
import type { PublicAnnouncementCandidate } from '../../../utils/siteAnnouncements/selectPublicWinners';

const now = new Date('2026-07-15T12:00:00.000Z');

function candidate(
  overrides: Partial<PublicAnnouncementCandidate> & Pick<PublicAnnouncementCandidate, 'type' | 'title'>,
): PublicAnnouncementCandidate {
  return {
    _id: overrides._id ?? `${overrides.type}-${overrides.title}`,
    locale: overrides.locale ?? 'en',
    priority: overrides.priority ?? 0,
    createdAt: overrides.createdAt ?? new Date('2026-07-01T00:00:00.000Z'),
    activeCountries: overrides.activeCountries ?? [],
    startsAt: overrides.startsAt ?? new Date('2026-07-01T00:00:00.000Z'),
    endsAt: overrides.endsAt ?? new Date('2026-08-01T23:59:59.999Z'),
    isActive: overrides.isActive ?? true,
    ...overrides,
  };
}

describe('buildPublicAnnouncementAggregationPipeline', () => {
  it('sorts by priority, exact locale, and createdAt before grouping by type', () => {
    const pipeline = buildPublicAnnouncementAggregationPipeline(
      { locale: 'fr', countryCode: 'BE' },
      now,
    );

    expect(pipeline[0]).toMatchObject({
      $match: {
        isActive: true,
        $and: [
          {
            $or: [
              { locale: { $in: ['fr', 'en'] } },
              { 'translations.fr.title': { $exists: true } },
            ],
          },
        ],
        $or: [{ activeCountries: { $size: 0 } }, { activeCountries: 'BE' }],
      },
    });
    expect(pipeline[4]).toEqual({
      $sort: { priority: -1, localeExact: -1, createdAt: -1 },
    });
    expect(pipeline[5]).toEqual({
      $group: { _id: '$type', doc: { $first: '$$ROOT' } },
    });
  });

  it('restricts unknown country to global campaigns in the match stage', () => {
    const pipeline = buildPublicAnnouncementAggregationPipeline({ locale: 'en' }, now);
    expect(pipeline[0]).toMatchObject({
      $match: {
        $or: [{ activeCountries: { $size: 0 } }],
      },
    });
  });
});

describe('selectPublicAnnouncementWinners', () => {
  const fixtures: PublicAnnouncementCandidate[] = [
    candidate({
      type: 'top_bar',
      title: 'BE only',
      activeCountries: ['BE'],
      priority: 10,
    }),
    candidate({
      type: 'top_bar',
      title: 'Global',
      activeCountries: [],
      priority: 1,
    }),
    candidate({
      type: 'modal',
      title: 'FR exact',
      locale: 'fr',
      priority: 5,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
    }),
    candidate({
      type: 'modal',
      title: 'EN fallback newer',
      locale: 'en',
      priority: 5,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
    }),
    candidate({
      type: 'exit_intent',
      title: 'Expired',
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
    }),
  ];

  it('returns one winner per type with country and schedule filtering', () => {
    const winners = selectPublicAnnouncementWinners(
      fixtures,
      { locale: 'fr', countryCode: 'BE' },
      now,
    );

    expect(winners.map((w) => w.title).sort()).toEqual(['BE only', 'FR exact']);
  });

  it('prefers exact locale over English at equal priority', () => {
    const winners = selectPublicAnnouncementWinners(
      fixtures,
      { locale: 'fr', countryCode: 'BE' },
      now,
    );
    expect(winners.find((w) => w.type === 'modal')?.title).toBe('FR exact');
  });

  it('treats base-language locale as exact for region-tagged requests', () => {
    const winners = selectPublicAnnouncementWinners(
      [
        candidate({
          type: 'modal',
          title: 'NL base',
          locale: 'nl',
          priority: 5,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
        candidate({
          type: 'modal',
          title: 'EN newer',
          locale: 'en',
          priority: 5,
          createdAt: new Date('2026-07-20T00:00:00.000Z'),
        }),
      ],
      { locale: 'nl-be' },
      now,
    );
    expect(winners.find((w) => w.type === 'modal')?.title).toBe('NL base');
  });

  it('returns only global campaigns when country is unknown', () => {
    const winners = selectPublicAnnouncementWinners(fixtures, { locale: 'en' }, now);
    expect(winners.map((w) => w.title).sort()).toEqual(['EN fallback newer', 'Global']);
  });
});
