import type { FilterQuery } from 'mongoose';
import type { ISiteAnnouncement } from '../../models/siteAnnouncement';
import { escapeRegExp } from '../escapeRegExp';
import type { AdminListFilters, PublicListFilters } from './types';
import { isAnnouncementTranslationLocale } from './translation';

export function buildAdminListQuery(
  filters: AdminListFilters,
  now: Date = new Date(),
): FilterQuery<ISiteAnnouncement> {
  const query: FilterQuery<ISiteAnnouncement> = {};

  if (filters.type) {
    query.type = filters.type;
  }

  if (filters.status === 'active') {
    query.isActive = true;
    query.startsAt = { $lte: now };
    query.endsAt = { $gte: now };
  } else if (filters.status === 'scheduled') {
    query.isActive = true;
    query.startsAt = { $gt: now };
  } else if (filters.status === 'expired') {
    query.isActive = true;
    query.endsAt = { $lt: now };
  } else if (filters.status === 'disabled') {
    query.isActive = false;
  }

  if (filters.search) {
    const safe = escapeRegExp(filters.search);
    query.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { title: { $regex: safe, $options: 'i' } },
    ];
  }

  return query;
}

export function buildPublicListQuery(
  filters: PublicListFilters,
  now: Date = new Date(),
): FilterQuery<ISiteAnnouncement> {
  const localeBase = filters.locale.split('-')[0] || filters.locale;
  const query: FilterQuery<ISiteAnnouncement> = {
    isActive: true,
    startsAt: { $lte: now },
    endsAt: { $gte: now },
  };

  const localeMatch: FilterQuery<ISiteAnnouncement>[] = [
    { locale: { $in: [...new Set([filters.locale, localeBase, 'en'])] } },
  ];
  // Auto-translated announcements: any source language with a translation
  // for the visitor's language is eligible too. Without translations (no
  // translator configured) this matches nothing extra.
  if (isAnnouncementTranslationLocale(localeBase)) {
    localeMatch.push({ [`translations.${localeBase}.title`]: { $exists: true } });
  }
  query.$and = [{ $or: localeMatch }];

  if (filters.type) {
    query.type = filters.type;
  }

  // Unknown country → global campaigns only (empty activeCountries).
  query.$or = filters.countryCode
    ? [{ activeCountries: { $size: 0 } }, { activeCountries: filters.countryCode }]
    : [{ activeCountries: { $size: 0 } }];

  return query;
}
