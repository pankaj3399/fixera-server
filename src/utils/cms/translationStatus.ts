/**
 * Per-locale translation status of a CMS translation family, for the admin UI.
 * Derived from the documents themselves (is there a row, is it machine or
 * manual, does its sourceHash match the source) plus the last background run's
 * outcome and lease, so it stays correct even when a run never reported back.
 */
import CmsContent from "../../models/cmsContent";
import { isTranslatorConfigured } from "./azureTranslator";
import { CMS_LOCALES } from "./locales";
import { computeSourceHash, targetLocalesFor, TranslationResult } from "./syncTranslations";
import { reconcileCmsTranslationRun } from "./translationQueue";

export type LocaleTranslationState =
  | "source"
  | "pending"
  | "up_to_date"
  | "stale"
  | "missing"
  | "failed"
  | "manual"
  | "blocked";

export interface TranslationLocaleDocument {
  _id: string;
  slug: string;
  title: string;
  status: string;
  autoTranslated: boolean;
  translatedFrom?: string;
  updatedAt?: Date;
}

export interface TranslationLocaleStatus {
  locale: string;
  state: LocaleTranslationState;
  document?: TranslationLocaleDocument;
  lastResult?: TranslationResult & { at: Date };
}

export interface CmsTranslationStatus {
  enabled: boolean;
  sourceId: string;
  sourceLocale: string;
  running: boolean;
  queued: boolean;
  lastRunAt?: Date;
  locales: TranslationLocaleStatus[];
}

const ROW_FIELDS = "type locale slug title status autoTranslated translatedFrom sourceHash updatedAt";
const SOURCE_FIELDS = `${ROW_FIELDS} body excerpt coverImageAlt seo translationRun translationResults`;

function summarize(row: Record<string, any>): TranslationLocaleDocument {
  return {
    _id: String(row._id),
    slug: String(row.slug || ""),
    title: String(row.title || ""),
    status: String(row.status || "draft"),
    autoTranslated: row.autoTranslated === true,
    ...(row.translatedFrom ? { translatedFrom: String(row.translatedFrom) } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  };
}

function lastResultOf(source: Record<string, any>, locale: string) {
  const entry = (source.translationResults as Array<Record<string, any>> | undefined)?.find(
    (result) => result.locale === locale
  );
  if (!entry) return undefined;
  return {
    locale: entry.locale,
    status: entry.status,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    at: entry.at,
  } as TranslationResult & { at: Date };
}

/**
 * Status of the family `docId` belongs to (`docId` may be the source or any of
 * its translations). Returns null when the doc does not exist. May repair a
 * dead run (see reconcileCmsTranslationRun) as a side effect.
 */
export async function loadCmsTranslationStatus(docId: unknown): Promise<CmsTranslationStatus | null> {
  const doc = (await CmsContent.findById(docId).select(SOURCE_FIELDS).lean()) as Record<string, any> | null;
  if (!doc) return null;

  let source = doc;
  if (doc.translatedFrom) {
    const origin = (await CmsContent.findById(doc.translatedFrom).select(SOURCE_FIELDS).lean()) as
      | Record<string, any>
      | null;
    if (origin) source = origin;
  }

  if (await reconcileCmsTranslationRun(source)) {
    source = ((await CmsContent.findById(source._id).select(SOURCE_FIELDS).lean()) as Record<string, any> | null) ?? source;
  }

  const targets = targetLocalesFor(source.locale);
  const rows = (await CmsContent.find({
    type: source.type,
    locale: { $in: targets },
    $or: [{ translatedFrom: source._id }, { slug: source.slug }],
  })
    .select(ROW_FIELDS)
    .lean()) as Array<Record<string, any>>;

  const run = (source.translationRun || {}) as Record<string, any>;
  const now = Date.now();
  const running = Boolean(run.runId && run.leaseUntil && new Date(run.leaseUntil).getTime() > now);
  const queued = run.requested === true;
  // Forced locales still to do: queued with the request, or held by the running worker.
  const forceLocales: string[] = [
    ...(queued && Array.isArray(run.forceLocales) ? run.forceLocales : []),
    ...(running && Array.isArray(run.activeForceLocales) ? run.activeForceLocales : []),
  ];
  const hash = computeSourceHash(source);
  const sourceId = String(source._id);

  const byLocale = new Map<string, TranslationLocaleStatus>();
  byLocale.set(source.locale, { locale: source.locale, state: "source", document: summarize(source) });

  for (const locale of targets) {
    const linked = rows.find(
      (row) => row.locale === locale && row.translatedFrom && String(row.translatedFrom) === sourceId
    );
    const sameSlug = rows.find((row) => row.locale === locale && row.slug === source.slug);
    const row = linked ?? sameSlug;

    let state: LocaleTranslationState;
    if (!row) {
      state = "missing";
    } else if (linked) {
      state = linked.autoTranslated === true ? (linked.sourceHash === hash ? "up_to_date" : "stale") : "manual";
    } else if (
      row.autoTranslated === true &&
      (!row.translatedFrom || !(await CmsContent.exists({ _id: row.translatedFrom })))
    ) {
      // Orphan machine row: the next run adopts and refreshes it.
      state = "stale";
    } else {
      state = "blocked";
    }

    const lastResult = lastResultOf(source, locale);
    const inFlight = running || queued;
    if (inFlight && (state === "missing" || state === "stale")) state = "pending";
    else if (inFlight && state === "manual" && forceLocales.includes(locale)) state = "pending";
    else if (lastResult?.status === "failed" && (state === "missing" || state === "stale")) state = "failed";

    byLocale.set(locale, {
      locale,
      state,
      ...(row ? { document: summarize(row) } : {}),
      ...(lastResult ? { lastResult } : {}),
    });
  }

  return {
    enabled: isTranslatorConfigured(),
    sourceId,
    sourceLocale: source.locale,
    running,
    queued,
    ...(run.finishedAt ? { lastRunAt: run.finishedAt } : {}),
    locales: CMS_LOCALES.flatMap((locale) => {
      const entry = byLocale.get(locale);
      return entry ? [entry] : [];
    }),
  };
}

/** Best-effort variant for embedding in other responses: undefined on failure. */
export async function tryLoadCmsTranslationStatus(docId: unknown): Promise<CmsTranslationStatus | undefined> {
  try {
    return (await loadCmsTranslationStatus(docId)) ?? undefined;
  } catch (err) {
    console.error("CMS translation status lookup failed; omitting translationStatus:", err);
    return undefined;
  }
}
