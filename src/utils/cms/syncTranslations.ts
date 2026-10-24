import { createHash } from "crypto";

import CmsContent, { ICmsContent } from "../../models/cmsContent";
import { CMS_LOCALES } from "./locales";
import { isTranslatorConfigured, translateTexts } from "./azureTranslator";

export type TranslationStatus =
  | "created"
  | "updated"
  | "synced"
  | "skipped_manual"
  | "failed"
  | "disabled";

export interface TranslationResult {
  locale: string;
  status: TranslationStatus;
  error?: string;
}

/** Plain-text fields translated in one batched request (all go as textType=plain). */
const PLAIN_FIELD_SPECS: Array<{ name: string; get: (d: Record<string, any>) => string | undefined }> = [
  { name: "title", get: (d) => d.title },
  { name: "excerpt", get: (d) => d.excerpt },
  { name: "coverImageAlt", get: (d) => d.coverImageAlt },
  { name: "seo.titleTag", get: (d) => d.seo?.titleTag },
  { name: "seo.metaDescription", get: (d) => d.seo?.metaDescription },
  { name: "seo.ogTitle", get: (d) => d.seo?.ogTitle },
];

/**
 * Translated fields (source value empty ⇒ the translation field is cleared).
 * `body` is TipTap HTML (textType=html); everything else is plain text.
 */
const TRANSLATED_FIELD_PATHS = [
  "title",
  "body",
  "excerpt",
  "coverImageAlt",
  "seo.titleTag",
  "seo.metaDescription",
  "seo.ogTitle",
] as const;

/** Non-text fields mirrored from the source to every (auto) translation. */
const COPYABLE_TOP_LEVEL_FIELDS = [
  "status",
  "publishedAt",
  "coverImage",
  "category",
  "tags",
  "activeCountries",
  "relatedContent",
  "relatedServices",
  "relatedServiceSlug",
  "author",
  "authorOverride",
] as const;

/** Non-text SEO fields mirrored from the source (canonical is per-locale, never copied). */
const COPYABLE_SEO_FIELDS = ["ogImage", "noindex"] as const;

/**
 * Publication/visibility controls. Unlike text, these are never "manual copy":
 * a translation must stop being public when its source is unpublished or its
 * country targeting changes, even when an admin replaced the machine text.
 */
const CONTROL_FIELDS = ["status", "publishedAt", "activeCountries"] as const;

/**
 * Hash inputs that define whether translated text fields are stale. Only
 * translatable text goes in, so a slug/status/non-text-only change never
 * triggers a translator call.
 */
function translatableSourceSubset(doc: Record<string, any>) {
  return {
    title: doc.title,
    body: doc.body,
    excerpt: doc.excerpt,
    coverImageAlt: doc.coverImageAlt,
    seoTitleTag: doc.seo?.titleTag,
    seoMetaDescription: doc.seo?.metaDescription,
    seoOgTitle: doc.seo?.ogTitle,
  };
}

export function computeSourceHash(doc: Record<string, any>): string {
  return createHash("sha256").update(JSON.stringify(translatableSourceSubset(doc))).digest("hex");
}

/** Normalizes a mongoose Document or plain object into a plain record. */
function toPlain(doc: Record<string, any>): Record<string, any> {
  if (doc && typeof doc.toObject === "function") return doc.toObject() as Record<string, any>;
  return doc;
}

export function targetLocalesFor(sourceLocale: string): string[] {
  return CMS_LOCALES.filter((locale) => locale !== sourceLocale);
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof cur[part] !== "object" || cur[part] === null || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Builds a mongoose `$set` / `$unset` pair; undefined values clear the path. */
function buildUpdate(fields: Record<string, unknown>): {
  $set: Record<string, unknown>;
  $unset: Record<string, unknown>;
} {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    if (value === undefined || value === null) $unset[path] = 1;
    else $set[path] = value;
  }
  return { $set, $unset };
}

/** Builds the insert payload for a fresh translation (undefined fields omitted). */
function buildInsert(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    setNested(out, path, value);
  }
  return out;
}

/** Copyable non-text fields as a flat path → value map. */
function copiedFields(source: Record<string, any>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of COPYABLE_TOP_LEVEL_FIELDS) fields[field] = source[field];
  for (const key of COPYABLE_SEO_FIELDS) fields[`seo.${key}`] = source.seo?.[key];
  return fields;
}

/** Source publication/visibility controls as a flat path → value map. */
function controlFields(source: Record<string, any>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of CONTROL_FIELDS) fields[field] = source[field];
  return fields;
}

/**
 * Translates the source's text fields into `targetLocale`. Missing/blank
 * source values come back as undefined so callers can clear stale text.
 */
async function translateSourceFields(
  source: Record<string, any>,
  targetLocale: string
): Promise<Record<string, unknown>> {
  const from = String(source.locale);
  const translated: Record<string, unknown> = {};

  const present = PLAIN_FIELD_SPECS.map((spec) => ({
    name: spec.name,
    value: spec.get(source),
  })).filter((field): field is { name: string; value: string } =>
    typeof field.value === "string" && field.value.trim().length > 0
  );

  if (present.length > 0) {
    const results = await translateTexts(
      present.map((field) => field.value),
      { from, to: targetLocale, html: false }
    );
    present.forEach((field, index) => {
      translated[field.name] = results[index] ?? "";
    });
  }

  const body = typeof source.body === "string" ? source.body : "";
  if (body.trim()) {
    const [translatedBody] = await translateTexts([body], {
      from,
      to: targetLocale,
      html: true,
    });
    translated.body = translatedBody ?? "";
  } else {
    translated.body = "";
  }

  // Every translatable path must be present in the update so cleared source
  // values also clear the translation instead of leaving stale text behind.
  const complete: Record<string, unknown> = {};
  for (const path of TRANSLATED_FIELD_PATHS) complete[path] = translated[path];
  return complete;
}

/**
 * Only "originals" act as translation sources: a doc that is neither a machine
 * translation nor a translation of another doc (auto or manual). Any doc with
 * `translatedFrom` set — including a manual translation an admin edited — is
 * never a source, so translations can never ping-pong between locales.
 */
export function isTranslationSource(
  sourceArg: ICmsContent | Record<string, any>
): boolean {
  const source = toPlain(sourceArg as Record<string, any>);
  return source.autoTranslated !== true && !source.translatedFrom;
}

/**
 * Syncs a saved source CMS document into every other CMS_LOCALES entry.
 *
 * Rules:
 * - Only originals (autoTranslated !== true and no translatedFrom) are sources;
 *   every other doc returns [] (even with force), so a translation can never
 *   overwrite the locale it came from.
 * - Manual translations (autoTranslated: false) always win for text, unless
 *   force=true. Publication controls (status, publishedAt, activeCountries)
 *   are still mirrored from the source when the translation is linked to it,
 *   so unpublishing/geo-restricting the source hides the translation too.
 * - Unchanged sourceHash → sync non-text fields only; no translator call.
 * - New/stale → translate and upsert with the SAME type/slug as the source
 *   (the frontend switches language on one URL, so slugs stay identical).
 * - Missing AZURE_TRANSLATOR_KEY → every target "disabled"; logs once, never throws.
 * - Per-locale failures (e.g. unique-index conflicts) surface as `failed`.
 *
 * Returns one result per target locale; never throws.
 */
export async function syncCmsTranslations(
  sourceArg: ICmsContent | Record<string, any>,
  options: { force?: boolean } = {}
): Promise<TranslationResult[]> {
  const source = toPlain(sourceArg as Record<string, any>);

  if (!isTranslationSource(source)) return [];

  const targetLocales = targetLocalesFor(source.locale);

  if (!isTranslatorConfigured()) {
    console.warn(
      "[cmsTranslations] AZURE_TRANSLATOR_KEY not set; CMS auto-translation disabled"
    );
    return targetLocales.map((locale) => ({ locale, status: "disabled" as const }));
  }

  const sourceHash = computeSourceHash(source);
  const results: TranslationResult[] = [];

  for (const locale of targetLocales) {
    try {
      // Prefer the managed sibling (translatedFrom); otherwise same-slug doc.
      const managed = source._id
        ? await CmsContent.findOne({
            type: source.type,
            locale,
            translatedFrom: source._id,
          }).lean()
        : null;
      const sibling =
        managed ??
        (await CmsContent.findOne({
          type: source.type,
          locale,
          slug: source.slug,
        }).lean());

      if (sibling && sibling.autoTranslated !== true && !options.force) {
        // Manual translations keep their human-written text, but publication
        // and country visibility are source controls: unpublishing or
        // geo-restricting the source must hide the translation too. Only a
        // sibling explicitly linked to this source is managed; a same-slug
        // independent manual original is left completely untouched.
        if (
          sibling.translatedFrom &&
          String(sibling.translatedFrom) === String(source._id)
        ) {
          const controls = buildUpdate(controlFields(source));
          await CmsContent.updateOne(
            { _id: sibling._id },
            {
              $set: { ...controls.$set, translatedFrom: source._id },
              ...(Object.keys(controls.$unset).length ? { $unset: controls.$unset } : {}),
            }
          );
        }
        results.push({ locale, status: "skipped_manual" });
        continue;
      }

      if (
        !options.force &&
        sibling &&
        sibling.autoTranslated === true &&
        sibling.sourceHash === sourceHash
      ) {
        // Text unchanged — mirror non-text fields only, never call the provider.
        const copied = buildUpdate(copiedFields(source));
        await CmsContent.updateOne(
          { _id: sibling._id },
          {
            $set: {
              ...copied.$set,
              type: source.type,
              slug: source.slug,
              translatedFrom: source._id,
              autoTranslated: true,
              sourceHash,
            },
            ...(Object.keys(copied.$unset).length ? { $unset: copied.$unset } : {}),
          }
        );
        results.push({ locale, status: "synced" });
        continue;
      }

      const translatedFields = await translateSourceFields(source, locale);
      const copied = buildUpdate(copiedFields(source));
      const meta = {
        autoTranslated: true,
        sourceHash,
        translatedFrom: source._id,
      };

      if (sibling) {
        const translated = buildUpdate(translatedFields);
        await CmsContent.updateOne(
          { _id: sibling._id },
          {
            $set: {
              ...copied.$set,
              ...translated.$set,
              type: source.type,
              slug: source.slug,
              ...meta,
            },
            ...(Object.keys(copied.$unset).length || Object.keys(translated.$unset).length
              ? { $unset: { ...copied.$unset, ...translated.$unset } }
              : {}),
          }
        );
        results.push({ locale, status: "updated" });
      } else {
        // canonical is per-locale; intentionally not set on fresh translations.
        // One flat insert so copied `seo.ogImage`/`noindex` and translated
        // `seo.titleTag`/… land in the same nested seo object.
        await CmsContent.create({
          ...buildInsert({ ...copiedFields(source), ...translatedFields }),
          type: source.type,
          slug: source.slug, // same slug across locales
          locale,
          ...meta,
        });
        results.push({ locale, status: "created" });
      }
    } catch (err: any) {
      const isDuplicateKey = err?.code === 11000;
      const message = isDuplicateKey
        ? `A ${String(source.type)} with slug "${String(source.slug)}" already exists in locale ${locale}`
        : err?.message ?? String(err);
      console.error(`[cmsTranslations] sync failed for locale ${locale} (slug ${source.slug}):`, err);
      results.push({ locale, status: "failed", error: message });
    }
  }

  return results;
}

/**
 * After a source slug change, repoint its auto-translated siblings
 * (found by translatedFrom) to the new slug so frontend language switching
 * on the same URL keeps working. Returns per-locale results; unique-index
 * conflicts surface as `failed` instead of crashing.
 */
export async function moveAutoTranslatedSiblings(
  sourceArg: ICmsContent | Record<string, any>
): Promise<TranslationResult[]> {
  const source = toPlain(sourceArg as Record<string, any>);
  const siblings = await CmsContent.find({ translatedFrom: source._id }).lean();
  const results: TranslationResult[] = [];

  for (const siblingDoc of siblings) {
    const locale: string = siblingDoc.locale;
    if (!siblingDoc.autoTranslated) continue; // manual translations keep their own slug
    try {
      await CmsContent.updateOne(
        { _id: siblingDoc._id },
        { $set: { slug: source.slug, type: source.type } }
      );
      results.push({ locale, status: "updated" });
    } catch (err: any) {
      const message =
        err?.code === 11000
          ? `Slug "${String(source.slug)}" already exists in locale ${locale}`
          : err?.message ?? String(err);
      results.push({ locale, status: "failed", error: message });
    }
  }
  return results;
}

/**
 * After a source delete: delete auto-translated siblings, keep manual ones
 * and unset their translatedFrom link so future source ops can't touch them.
 */
export async function deleteAutoTranslatedSiblings(
  sourceArg: ICmsContent | Record<string, any>
): Promise<{ deleted: number; detached: number }> {
  const source = toPlain(sourceArg as Record<string, any>);
  const deleted = await CmsContent.deleteMany({
    translatedFrom: source._id,
    autoTranslated: true,
  });
  const detached = await CmsContent.updateMany(
    { translatedFrom: source._id },
    { $unset: { translatedFrom: 1 } }
  );
  return {
    deleted: deleted?.deletedCount ?? 0,
    detached: detached?.modifiedCount ?? 0,
  };
}

/**
 * Merges sync result groups into one entry per locale, never losing a
 * `failed` status (e.g. a slug-move conflict stays visible even when the
 * subsequent sync reports something else for the same locale).
 */
export function mergeTranslationResults(
  ...groups: TranslationResult[][]
): TranslationResult[] {
  const byLocale = new Map<string, TranslationResult>();
  for (const group of groups) {
    for (const result of group) {
      const existing = byLocale.get(result.locale);
      if (!existing || existing.status !== "failed") byLocale.set(result.locale, result);
    }
  }
  return Array.from(byLocale.values());
}
