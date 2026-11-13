import type { PipelineStage } from 'mongoose';
import { buildPublicListQuery } from './buildQueries';
import type { PublicListFilters } from './types';
import { isAnnouncementTranslationLocale } from './translation';

/** Mongo aggregation pipeline for one winner per announcement type. */
export function buildPublicAnnouncementAggregationPipeline(
  filters: PublicListFilters,
  now: Date = new Date(),
): PipelineStage[] {
  const query = buildPublicListQuery(filters, now);
  const localeBase = filters.locale.split('-')[0] || filters.locale;

  const sourceIsViewerLanguage = { $in: ['$locale', [filters.locale, localeBase]] };
  // A translation is served when it exists for the visitor's language and is
  // either admin-edited (manual) or a machine translation of the CURRENT
  // source text. Stale machine text falls back to the source.
  const servedTranslation = isAnnouncementTranslationLocale(localeBase)
    ? {
        $let: {
          vars: { t: `$translations.${localeBase}` },
          in: {
            $cond: [
              {
                $and: [
                  { $not: [sourceIsViewerLanguage] },
                  { $gt: ['$$t.title', null] },
                  {
                    $or: [
                      { $eq: ['$$t.mode', 'manual'] },
                      { $eq: ['$$t.sourceHash', '$translationSourceHash'] },
                    ],
                  },
                ],
              },
              '$$t',
              null,
            ],
          },
        },
      }
    : null;

  return [
    { $match: query },
    { $addFields: { servedTranslation } },
    // A foreign-language source is only eligible through a servable
    // translation (a stale machine translation does not qualify).
    {
      $match: {
        $or: [
          { locale: { $in: [...new Set([filters.locale, localeBase, 'en'])] } },
          { servedTranslation: { $ne: null } },
        ],
      },
    },
    {
      $addFields: {
        localeExact: {
          $cond: [
            { $or: [sourceIsViewerLanguage, { $ne: ['$servedTranslation', null] }] },
            1,
            0,
          ],
        },
      },
    },
    { $sort: { priority: -1, localeExact: -1, createdAt: -1 } },
    {
      $group: {
        _id: '$type',
        doc: { $first: '$$ROOT' },
      },
    },
    { $replaceRoot: { newRoot: '$doc' } },
    {
      $project: {
        name: 1,
        type: 1,
        title: { $ifNull: ['$servedTranslation.title', '$title'] },
        message: { $ifNull: ['$servedTranslation.message', '$message'] },
        ctaLabel: {
          $cond: [
            { $ne: ['$servedTranslation', null] },
            { $ifNull: ['$servedTranslation.ctaLabel', '$ctaLabel'] },
            '$ctaLabel',
          ],
        },
        ctaUrl: 1,
        discountCode: 1,
        activeCountries: 1,
        locale: {
          $cond: [{ $ne: ['$servedTranslation', null] }, localeBase, '$locale'],
        },
        sourceLocale: '$locale',
        translated: { $ne: ['$servedTranslation', null] },
        frequency: 1,
        priority: 1,
        delaySeconds: 1,
        dismissible: 1,
        requireMarketingConsent: 1,
        startsAt: 1,
        endsAt: 1,
        updatedAt: 1,
      },
    },
  ];
}
