import { createHash } from "crypto";

import CmsContent, { ICmsContent } from "../../models/cmsContent";
import { CMS_LOCALES } from "./locales";
import { isTranslatorConfigured, translateTexts, TranslatorError } from "./azureTranslator";

export type TranslationStatus =
  | "created"
  | "updated"
  | "synced"
  | "pending"
  | "skipped_manual"
  | "failed"
  | "disabled";

/** Machine-readable failure class for `failed` results (see API contract). */
export type TranslationErrorCode =
  | "rate_limited"
  | "quota_exceeded"
  | "auth"
  | "timeout"
  | "provider_error"
  | "budget_exceeded"
  | "slug_conflict"
  | "changed_during_run"
  | "interrupted"
  | "internal";

export interface TranslationResult {
  locale: string;
  status: TranslationStatus;
  errorCode?: TranslationErrorCode;
  error?: string;
}

export interface SyncTranslationOptions {
  /** Replace every LINKED manual translation with machine text. */
  force?: boolean;
  /** Replace the LINKED manual translations of only these locales. */
  forceLocales?: string[];
  /**
   * false = request-time pass: mirror control/non-text fields only and report
   * locales whose text needs the provider as `pending` (never calls Azure).
   * Defaults to true (the background run).
   */
  translate?: boolean;
  /** Epoch ms after which no new provider request is started. */
  deadline?: number;
  /**
   * Checked before each locale and before each translated write; false aborts
   * the rest of the run (the source was deleted or the run lost its lease).
   */
  guard?: () => Promise<boolean>;
  /**
   * Re-read the source from the database before each locale and again right
   * before each translated write (background runs). A run translates a
   * snapshot for seconds to minutes; without this its write would put back
   * the snapshot's publication, cover, countries or slug over a newer save
   * that the request-time pass already mirrored.
   */
  reloadSource?: boolean;
}

/** Schema maxlength of each translated plain field (French runs ~20% longer than English). */
export const TRANSLATED_FIELD_MAX_LENGTH: Record<string, number> = {
  title: 300,
  excerpt: 500,
  coverImageAlt: 200,
  "seo.titleTag": 120,
  "seo.metaDescription": 300,
  "seo.ogTitle": 120,
};

/**
 * Fits a translated plain field into its schema maxlength: cut at the last
 * word boundary that leaves room for an ellipsis. Without this a longer
 * translation fails validation on create, and leaves the doc unsaveable from
 * the admin form on update.
 */
export function clampTranslatedText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const room = trimmed.slice(0, maxLength - 1);
  const lastSpace = room.lastIndexOf(" ");
  const cut = lastSpace > maxLength * 0.6 ? room.slice(0, lastSpace) : room;
  return `${cut.replace(/[\s.,;:!?-]+$/, "")}…`;
}

const ERROR_MESSAGES: Record<TranslationErrorCode, string> = {
  rate_limited: "The translation service is rate limiting requests. Retry in a minute.",
  quota_exceeded: "The monthly translation quota is used up.",
  auth: "The translation service rejected the server's credentials.",
  timeout: "The translation service did not answer in time. Retry later.",
  provider_error: "The translation service returned an error. Retry later.",
  budget_exceeded: "The translation run ran out of time. Retry to continue.",
  slug_conflict: "Another document already uses this slug in that locale.",
  changed_during_run: "The translation changed while it was being translated. Retry.",
  interrupted: "The translation run was interrupted. Retry.",
  internal: "Translation failed. Check server logs for details.",
};

export function translationErrorMessage(code: TranslationErrorCode): string {
  return ERROR_MESSAGES[code];
}

export function failedResult(
  locale: string,
  errorCode: TranslationErrorCode,
  error: string = ERROR_MESSAGES[errorCode]
): TranslationResult {
  return { locale, status: "failed", errorCode, error };
}

function resultForError(err: any, source: Record<string, any>, locale: string): TranslationResult {
  if (err?.code === 11000) {
    return failedResult(
      locale,
      "slug_conflict",
      `A ${String(source.type)} with slug "${String(source.slug)}" already exists in locale ${locale}.`
    );
  }
  if (err instanceof TranslatorError && err.code !== "not_configured") {
    return failedResult(locale, err.code);
  }
  return failedResult(locale, "internal");
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

/**
 * Source safety controls for a linked MANUAL translation. Unlike text, these
 * are never "manual copy", but they only ever restrict:
 *
 * - `activeCountries` always mirrors the source, so geo-restricting the source
 *   restricts the translation too.
 * - Publication can only be taken away, never granted. When the source is not
 *   published, a published manual translation is demoted to the source's
 *   status and its `publishedAt` cleared (the model's draft invariant). When
 *   the source is published, the manual translation keeps its own `status`
 *   and `publishedAt`: an editor who left it as a draft decides when it goes
 *   live, and a published one keeps its own publication date.
 *
 * Machine translations are different: they follow the source's publication
 * status and date through {@link copiedFields}.
 */
export function manualTranslationControlUpdate(
  source: Record<string, any>,
  translation: Record<string, any>
): { $set: Record<string, unknown>; $unset: Record<string, unknown> } {
  const countries = buildUpdate({ activeCountries: source.activeCountries });
  const $set: Record<string, unknown> = { ...countries.$set };
  const $unset: Record<string, unknown> = { ...countries.$unset };
  if (source.status !== "published" && translation.status === "published") {
    $set.status = source.status || "draft";
    $unset.publishedAt = 1;
  }
  return { $set, $unset };
}

/**
 * Translates the source's text fields into `targetLocale`. Missing/blank
 * source values come back as undefined so callers can clear stale text.
 */
async function translateSourceFields(
  source: Record<string, any>,
  targetLocale: string,
  deadline?: number
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
      { from, to: targetLocale, html: false, deadline }
    );
    present.forEach((field, index) => {
      const max = TRANSLATED_FIELD_MAX_LENGTH[field.name];
      const value = results[index] ?? "";
      translated[field.name] = max ? clampTranslatedText(value, max) : value;
    });
  }

  const body = typeof source.body === "string" ? source.body : "";
  if (body.trim()) {
    const [translatedBody] = await translateTexts([body], {
      from,
      to: targetLocale,
      html: true,
      deadline,
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
 * Runs in two modes:
 * - `translate: false` (inside the admin request): never calls the provider.
 *   Mirrors control/non-text fields onto existing translations right away and
 *   reports every locale whose text must be (re)translated as `pending`
 *   (`disabled` when no translator is configured).
 * - `translate: true` (default; the background run): does the same and also
 *   translates and writes the pending locales.
 *
 * Rules:
 * - Only originals (autoTranslated !== true and no translatedFrom) are sources;
 *   every other doc returns [] (even with force), so a translation can never
 *   overwrite the locale it came from.
 * - A same-slug machine translation managed by another live original is left
 *   alone (reported skipped_manual), even with force.
 * - A same-slug MANUAL document not linked to this source (no translatedFrom,
 *   or translatedFrom pointing elsewhere) is never touched, even with force
 *   (reported skipped_manual). Only machine rows without a live owner may be
 *   adopted.
 * - Manual translations (autoTranslated: false) always win for text, unless
 *   forced for their locale. A manual translation LINKED to this source
 *   (translatedFrom) still receives the restricting source controls
 *   ({@link manualTranslationControlUpdate}): country targeting is mirrored
 *   and an unpublished source demotes it to draft, but publishing the source
 *   never publishes it or changes its own publishedAt. These controls apply
 *   before the force/translator checks, so they hold even when the provider
 *   is unconfigured or fails.
 * - Machine translations follow the source's status, publishedAt and the
 *   other copied non-text fields.
 * - force replaces a LINKED manual translation's text with machine text and
 *   turns it into a machine translation, which from then on follows the
 *   source's publication like any other machine translation.
 * - Unchanged sourceHash → sync non-text fields only; no translator call.
 * - New/stale → translate and upsert with the SAME type/slug as the source
 *   (the frontend switches language on one URL, so slugs stay identical).
 * - Translated writes are conditional: a machine row an admin took over while
 *   the provider call was in flight (autoTranslated flipped to false), or a
 *   forced manual row edited meanwhile, is never overwritten.
 * - Missing AZURE_TRANSLATOR_KEY → text locales "disabled"; never throws.
 * - Per-locale failures surface as `failed` with an errorCode.
 *
 * Returns one result per target locale; never throws.
 */
export async function syncCmsTranslations(
  sourceArg: ICmsContent | Record<string, any>,
  options: SyncTranslationOptions = {}
): Promise<TranslationResult[]> {
  const source = toPlain(sourceArg as Record<string, any>);

  if (!isTranslationSource(source)) return [];

  const targetLocales = targetLocalesFor(source.locale);
  const translate = options.translate !== false;
  const isForced = (locale: string) =>
    options.force === true || (options.forceLocales ?? []).includes(locale);

  const translatorEnabled = isTranslatorConfigured();
  const results: TranslationResult[] = [];
  const reload = async (): Promise<Record<string, any> | null> =>
    options.reloadSource && source._id
      ? ((await CmsContent.findById(source._id).lean()) as Record<string, any> | null)
      : source;

  for (const locale of targetLocales) {
    if (options.guard && !(await options.guard().catch(() => false))) {
      results.push(failedResult(locale, "interrupted"));
      continue;
    }
    try {
      // The latest saved source (see `reloadSource`). Gone or no longer an
      // original: stop managing its translations from this run.
      const current = await reload();
      if (!current || !isTranslationSource(current) || current.locale !== source.locale) {
        results.push(failedResult(locale, "interrupted"));
        continue;
      }
      const sourceHash = computeSourceHash(current);

      // Prefer the managed sibling (translatedFrom); otherwise same-slug doc.
      const managed = current._id
        ? await CmsContent.findOne({
            type: current.type,
            locale,
            translatedFrom: current._id,
          }).lean()
        : null;
      const sibling =
        managed ??
        (await CmsContent.findOne({
          type: current.type,
          locale,
          slug: current.slug,
        }).lean());

      // A same-slug machine translation managed by ANOTHER live original
      // (e.g. a legacy manual nl original and the en original share a slug)
      // belongs to that original. Never re-translate or re-link it from here,
      // even with force: otherwise each save of either original would flip
      // its text and its publication/country controls between the two.
      if (
        !managed &&
        sibling &&
        sibling.autoTranslated === true &&
        sibling.translatedFrom &&
        String(sibling.translatedFrom) !== String(current._id) &&
        (await CmsContent.exists({ _id: sibling.translatedFrom }))
      ) {
        results.push({ locale, status: "skipped_manual" });
        continue;
      }

      const isManual = Boolean(sibling) && sibling!.autoTranslated !== true;
      const linkedToSource =
        Boolean(sibling?.translatedFrom) &&
        String(sibling!.translatedFrom) === String(current._id);

      // A same-slug MANUAL document that is not explicitly linked to this
      // source (an independent original, another original's manual
      // translation, or a manual row with a dangling link) is someone else's
      // human-written content. It is never managed from here, even with
      // force: no text, publication, country, cover or hash change, no
      // re-link and no provider call. The force confirmation only names this
      // source's linked translations, so only those may be overwritten.
      if (isManual && !linkedToSource) {
        results.push({ locale, status: "skipped_manual" });
        continue;
      }

      if (isManual) {
        // A linked manual translation keeps its human-written text, but the
        // restricting source controls always apply (countries mirrored; an
        // unpublished source demotes it). A source publish never promotes it.
        const controls = manualTranslationControlUpdate(current, sibling!);
        await CmsContent.updateOne(
          { _id: sibling!._id, autoTranslated: { $ne: true } },
          {
            $set: { ...controls.$set, translatedFrom: current._id },
            ...(Object.keys(controls.$unset).length ? { $unset: controls.$unset } : {}),
          }
        );
        if (!isForced(locale)) {
          results.push({ locale, status: "skipped_manual" });
          continue;
        }
      }

      const forced = isManual && isForced(locale);
      const machineSibling = sibling && sibling.autoTranslated === true ? sibling : null;
      const needsText =
        !sibling ||
        isForced(locale) ||
        (machineSibling !== null && machineSibling.sourceHash !== sourceHash);

      // Machine translations mirror non-text fields immediately, even when
      // their text has to wait for the provider (or the provider is off).
      // Skipped when this pass is about to rewrite the row anyway.
      if (machineSibling && !(needsText && translate && translatorEnabled)) {
        const copied = buildUpdate(copiedFields(current));
        await CmsContent.updateOne(
          { _id: machineSibling._id, autoTranslated: true },
          {
            $set: {
              ...copied.$set,
              type: current.type,
              slug: current.slug,
              translatedFrom: current._id,
              autoTranslated: true,
            },
            ...(Object.keys(copied.$unset).length ? { $unset: copied.$unset } : {}),
          }
        );
      }

      if (!needsText) {
        results.push({ locale, status: "synced" });
        continue;
      }
      if (!translatorEnabled) {
        // No translator: text cannot be created or refreshed, but control and
        // non-text fields were already mirrored above.
        results.push({ locale, status: "disabled" });
        continue;
      }
      if (!translate) {
        results.push({ locale, status: "pending" });
        continue;
      }

      // A forced manual row is overwritten only if nobody edits it while the
      // provider call runs. Read its updatedAt AFTER the control update above
      // (which bumps it) so that update does not count as an edit.
      let forcedUpdatedAt: unknown;
      if (forced) {
        const fresh = (await CmsContent.findById(sibling!._id).select("updatedAt").lean()) as
          | Record<string, any>
          | null;
        forcedUpdatedAt = fresh?.updatedAt ?? sibling!.updatedAt;
      }

      const translatedFields = await translateSourceFields(current, locale, options.deadline);

      if (options.guard && !(await options.guard().catch(() => false))) {
        results.push(failedResult(locale, "interrupted"));
        continue;
      }

      // Text comes from the snapshot that was translated (its hash is
      // recorded, so a newer text edit shows as stale and is re-run); control
      // fields, type and slug come from the source as it is now.
      const latest = await reload();
      if (!latest || !isTranslationSource(latest) || latest.locale !== source.locale) {
        results.push(failedResult(locale, "interrupted"));
        continue;
      }

      const copied = buildUpdate(copiedFields(latest));
      const meta = {
        autoTranslated: true,
        sourceHash,
        translatedFrom: current._id,
      };

      if (sibling) {
        const translated = buildUpdate(translatedFields);
        // Conditional write: a machine row must still be machine (an admin
        // may have taken it over during the provider call); a forced manual
        // row must not have been edited since it was read.
        const filter: Record<string, unknown> = forced
          ? {
              _id: sibling._id,
              autoTranslated: { $ne: true },
              ...(forcedUpdatedAt ? { updatedAt: forcedUpdatedAt } : {}),
            }
          : { _id: sibling._id, autoTranslated: true };
        const write = await CmsContent.updateOne(filter, {
          $set: {
            ...copied.$set,
            ...translated.$set,
            type: latest.type,
            slug: latest.slug,
            ...meta,
          },
          ...(Object.keys(copied.$unset).length || Object.keys(translated.$unset).length
            ? { $unset: { ...copied.$unset, ...translated.$unset } }
            : {}),
        });
        if (write && typeof write.matchedCount === "number" && write.matchedCount === 0) {
          const now = await CmsContent.findById(sibling._id).select("autoTranslated").lean();
          results.push(
            now && now.autoTranslated !== true && !forced
              ? { locale, status: "skipped_manual" }
              : failedResult(locale, "changed_during_run")
          );
          continue;
        }
        results.push({ locale, status: "updated" });
      } else {
        // canonical is per-locale; intentionally not set on fresh translations.
        // One flat insert so copied `seo.ogImage`/`noindex` and translated
        // `seo.titleTag`/… land in the same nested seo object.
        await CmsContent.create({
          ...buildInsert({ ...copiedFields(latest), ...translatedFields }),
          type: latest.type,
          slug: latest.slug, // same slug across locales
          locale,
          ...meta,
        });
        results.push({ locale, status: "created" });
      }
    } catch (err: any) {
      console.error(
        `[cmsTranslations] sync failed for locale ${locale} (slug ${source.slug}):`,
        err instanceof TranslatorError ? `${err.code}: ${err.message}` : err
      );
      results.push(resultForError(err, source, locale));
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
      if (err?.code !== 11000) {
        console.error(`[cmsTranslations] slug move failed for locale ${locale}:`, err);
      }
      results.push(
        err?.code === 11000
          ? failedResult(locale, "slug_conflict", `Slug "${String(source.slug)}" already exists in locale ${locale}.`)
          : failedResult(locale, "internal")
      );
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
