import mongoose from "mongoose";

import CmsContent from "../../models/cmsContent";
import { CMS_DEFAULT_LOCALE } from "./locales";
import { filterCmsDocsVisibleThroughSource } from "./publicVisibility";

/** Card fields resolved for public "related reading" sections. */
const RELATED_DOC_FIELDS =
  "type title slug locale excerpt coverImage coverImageAlt publishedAt activeCountries status translatedFrom";

type RelatedDoc = Record<string, any>;

interface SlugPair {
  type: string;
  slug: string;
}

interface LocaleLookup {
  bySource: Map<string, RelatedDoc[]>;
  byId: Map<string, RelatedDoc>;
  byTypeSlug: Map<string, RelatedDoc>;
}

interface RelatedChoice {
  candidates: RelatedDoc[];
}

function toId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw =
    typeof value === "object" && value !== null && "_id" in (value as Record<string, unknown>)
      ? (value as Record<string, unknown>)._id
      : value;
  const id = String(raw);
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupeDocs(docs: RelatedDoc[]): RelatedDoc[] {
  const seen = new Set<string>();
  const out: RelatedDoc[] = [];
  for (const doc of docs) {
    const id = String(doc._id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(doc);
  }
  return out;
}

function buildLookup(docs: RelatedDoc[]): LocaleLookup {
  const bySource = new Map<string, RelatedDoc[]>();
  const byId = new Map<string, RelatedDoc>();
  const byTypeSlug = new Map<string, RelatedDoc>();

  for (const doc of docs) {
    byId.set(String(doc._id), doc);
    if (doc.translatedFrom) {
      const sourceId = String(doc.translatedFrom);
      const list = bySource.get(sourceId);
      if (list) list.push(doc);
      else bySource.set(sourceId, [doc]);
    }
    byTypeSlug.set(`${doc.type}:${doc.slug}`, doc);
  }

  return { bySource, byId, byTypeSlug };
}

/**
 * Finds the same logical article in `locale`: prefer the managed translation
 * (`translatedFrom`), then a same-slug document (the same fallback the
 * translation sync uses), preserving the source/slug semantics.
 */
function pickLocaleCandidate(source: RelatedDoc, lookup: LocaleLookup): RelatedDoc | null {
  const familySourceId = String(source.translatedFrom ?? source._id);
  const linked = lookup.bySource.get(familySourceId) ?? [];
  const sameSlug = linked.find((doc) => doc.slug === source.slug);
  return (
    sameSlug ??
    linked[0] ??
    lookup.byId.get(familySourceId) ??
    lookup.byTypeSlug.get(`${source.type}:${source.slug}`) ??
    null
  );
}

async function findLocaleCandidates(
  sourceIds: string[],
  slugPairs: SlugPair[],
  locale: string
): Promise<RelatedDoc[]> {
  const or: Array<Record<string, unknown>> = [];
  if (sourceIds.length > 0) {
    or.push({ translatedFrom: { $in: sourceIds } });
    // The family origin itself (manual translations may keep a different slug,
    // so the origin id is the reliable English fallback).
    or.push({ _id: { $in: sourceIds } });
  }
  for (const pair of slugPairs) or.push({ type: pair.type, slug: pair.slug });
  if (or.length === 0) return [];

  const docs = (await CmsContent.find({ locale, status: "published", $or: or })
    .select(RELATED_DOC_FIELDS)
    .lean()) as RelatedDoc[];
  return docs;
}

function toRelatedCard(doc: RelatedDoc) {
  return {
    _id: doc._id,
    title: doc.title,
    slug: doc.slug,
    type: doc.type,
    locale: doc.locale,
    excerpt: doc.excerpt,
    coverImage: doc.coverImage,
    coverImageAlt: doc.coverImageAlt,
    publishedAt: doc.publishedAt,
    activeCountries: doc.activeCountries,
  };
}

/**
 * Resolves the related-content ids stored on a CMS document into cards in the
 * requested locale.
 *
 * Related ids are copied from the source to every translation, so they usually
 * point at English documents. For each id this resolves:
 *   1. the requested-locale document (managed translation or same slug),
 *   2. the English source/target as fallback,
 * and then keeps the first candidate that is published, country-eligible and
 * whose translation source (if any) is still public. Order follows the stored
 * relatedContent order; draft/ineligible documents are dropped.
 */
export async function resolveLocalizedRelatedContent(
  relatedIds: unknown,
  locale: string,
  countryCode?: string
): Promise<ReturnType<typeof toRelatedCard>[]> {
  if (!Array.isArray(relatedIds) || relatedIds.length === 0) return [];

  const ids = uniqueStrings(
    relatedIds.map(toId).filter((id): id is string => Boolean(id))
  );
  if (ids.length === 0) return [];

  const referenced = (await CmsContent.find({ _id: { $in: ids } })
    .select(RELATED_DOC_FIELDS)
    .lean()) as RelatedDoc[];
  const referencedById = new Map(referenced.map((doc) => [String(doc._id), doc]));

  const needsLocale = referenced.filter((doc) => doc.locale !== locale);
  // Family origins come from every referenced doc, not only translations in
  // another locale: when the stored id is already the requested-locale row, the
  // English origin is still needed as fallback if that row is hidden.
  const sourceIds = uniqueStrings([
    ...referenced
      .filter((doc) => Boolean(doc.translatedFrom))
      .map((doc) => String(doc.translatedFrom)),
    ...needsLocale
      .filter((doc) => !doc.translatedFrom)
      .map((doc) => String(doc._id)),
  ]);
  const slugPairs: SlugPair[] = [];
  const seenPairs = new Set<string>();
  for (const doc of needsLocale) {
    const key = `${doc.type}:${doc.slug}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    slugPairs.push({ type: doc.type, slug: doc.slug });
  }

  const [localeDocs, englishDocs] = await Promise.all([
    findLocaleCandidates(sourceIds, slugPairs, locale),
    locale === CMS_DEFAULT_LOCALE
      ? Promise.resolve([] as RelatedDoc[])
      : findLocaleCandidates(sourceIds, slugPairs, CMS_DEFAULT_LOCALE),
  ]);
  const localeLookup = buildLookup(localeDocs);
  const englishLookup = buildLookup(englishDocs);

  const choices: RelatedChoice[] = [];
  for (const id of ids) {
    const source = referencedById.get(id);
    if (!source) continue;

    const localized =
      source.locale === locale ? source : pickLocaleCandidate(source, localeLookup);
    const english =
      source.locale === CMS_DEFAULT_LOCALE
        ? source
        : pickLocaleCandidate(source, englishLookup);

    choices.push({
      candidates: dedupeDocs(
        [localized, english].filter((doc): doc is RelatedDoc => Boolean(doc))
      ),
    });
  }

  const allCandidates = dedupeDocs(choices.flatMap((choice) => choice.candidates));
  const visible = await filterCmsDocsVisibleThroughSource(allCandidates, countryCode);
  const visibleIds = new Set(visible.map((doc) => String(doc._id)));

  const resolved: RelatedDoc[] = [];
  for (const choice of choices) {
    const match = choice.candidates.find((doc) => visibleIds.has(String(doc._id)));
    if (match) resolved.push(match);
  }

  return resolved.map(toRelatedCard);
}
