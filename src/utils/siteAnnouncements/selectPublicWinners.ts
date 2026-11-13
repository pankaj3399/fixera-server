import type { AnnouncementType } from '../../models/siteAnnouncement';

export type PublicAnnouncementCandidate = {
  _id: string;
  type: AnnouncementType;
  locale: string;
  priority: number;
  createdAt: Date;
  title: string;
  activeCountries: string[];
  startsAt: Date;
  endsAt: Date;
  isActive: boolean;
  message?: string;
  translationSourceHash?: string;
  translations?: Partial<
    Record<string, { title: string; message: string; ctaLabel?: string; mode: 'machine' | 'manual'; sourceHash: string }>
  >;
};

/** Translation served to a visitor (mirrors servedTranslation in publicAggregation). */
export function servedAnnouncementTranslation(
  item: Pick<PublicAnnouncementCandidate, 'locale' | 'translations' | 'translationSourceHash'>,
  viewerLocale: string,
) {
  const base = viewerLocale.split('-')[0] || viewerLocale;
  if (item.locale === viewerLocale || item.locale === base) return null;
  const translation = item.translations?.[base];
  if (!translation?.title) return null;
  if (translation.mode !== 'manual' && translation.sourceHash !== item.translationSourceHash) return null;
  return translation;
}

/** Mirrors the aggregation winner selection for in-memory tests. */
export function selectPublicAnnouncementWinners(
  candidates: PublicAnnouncementCandidate[],
  filters: { locale: string; countryCode?: string; type?: AnnouncementType },
  now: Date = new Date(),
): PublicAnnouncementCandidate[] {
  const localeBase = filters.locale.split('-')[0] || filters.locale;
  const locales = new Set([filters.locale, localeBase, 'en']);

  const eligible = candidates.filter((item) => {
    if (!item.isActive) return false;
    if (filters.type && item.type !== filters.type) return false;
    if (!item.startsAt || !item.endsAt) return false;
    if (item.startsAt > now || item.endsAt < now) return false;
    if (!locales.has(item.locale) && !servedAnnouncementTranslation(item, filters.locale)) return false;
    if (filters.countryCode) {
      if (item.activeCountries.length > 0 && !item.activeCountries.includes(filters.countryCode)) {
        return false;
      }
    } else if (item.activeCountries.length > 0) {
      return false;
    }
    return true;
  });

  const sorted = [...eligible].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const aExact =
      a.locale === filters.locale || a.locale === localeBase || servedAnnouncementTranslation(a, filters.locale) ? 1 : 0;
    const bExact =
      b.locale === filters.locale || b.locale === localeBase || servedAnnouncementTranslation(b, filters.locale) ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const byType = new Map<AnnouncementType, PublicAnnouncementCandidate>();
  for (const item of sorted) {
    if (!byType.has(item.type)) {
      byType.set(item.type, item);
    }
  }
  return Array.from(byType.values());
}
