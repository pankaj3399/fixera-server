/**
 * Site announcement auto-translation (Azure Translator, optional).
 *
 * The admin writes an announcement once in its source language (`locale`).
 * After the response, a background run (Vercel `waitUntil`, same pattern as
 * the CMS queue in utils/cms/translationQueue.ts) machine-translates the
 * visitor-facing text (title, message, ctaLabel) into the other app locales
 * and stores it under `translations.<locale>`.
 *
 * - Without AZURE_TRANSLATOR_KEY nothing is ever scheduled and public
 *   selection behaves exactly as before (no translations exist).
 * - An admin-edited translation (`mode: "manual"`) is never overwritten unless
 *   the admin forces that locale.
 * - A machine translation whose `sourceHash` no longer matches the source is
 *   stale: it is not served (visitors get the source text) and the next run
 *   refreshes it.
 * - Concurrency: one worker per announcement via a lease on
 *   `translationRun.runId/leaseUntil`; saves during a run only set
 *   `translationRun.requested`, so overlapping saves coalesce.
 * - Writes are conditional on the run still holding the lease AND the source
 *   text being unchanged (`translationSourceHash`), so a slow run never writes
 *   a translation of outdated text.
 * - Every bookkeeping write uses `timestamps: false`: `updatedAt` is the
 *   visitor-side version used for dismissal/frequency storage and must only
 *   change on real edits.
 */
import { createHash, randomUUID } from 'crypto';
import { waitUntil } from '@vercel/functions';
import type { Types } from 'mongoose';

import SiteAnnouncement, {
  type ISiteAnnouncementTranslation,
  type ISiteAnnouncementTranslationResult,
} from '../../models/siteAnnouncement';
import { isTranslatorConfigured, TranslatorError } from '../cms/azureTranslator';
import { PlaceholderLostError, translateProtectedFields } from '../translation/protectedTranslate';

/** App locales visitors can be served in (translation targets). */
export const ANNOUNCEMENT_TRANSLATION_LOCALES = ['en', 'nl', 'fr'] as const;
export type AnnouncementTranslationLocale = (typeof ANNOUNCEMENT_TRANSLATION_LOCALES)[number];

/** Source languages the translator accepts for announcements. */
export const ANNOUNCEMENT_SOURCE_LANGUAGES = ['en', 'nl', 'fr', 'de'] as const;

/** Stored limits for translated text (translations may run longer than the source). */
export const ANNOUNCEMENT_TRANSLATION_LIMITS = { title: 320, message: 1000, ctaLabel: 120 } as const;

export const ANNOUNCEMENT_TRANSLATION_LEASE_MS = 120_000;
export const ANNOUNCEMENT_TRANSLATION_BUDGET_MS = 60_000;
const MAX_RUNS_PER_INVOCATION = 3;
const NO_TIMESTAMPS = { timestamps: false } as const;

type Id = Types.ObjectId | string;

export function isAnnouncementTranslationLocale(value: unknown): value is AnnouncementTranslationLocale {
  return typeof value === 'string' && (ANNOUNCEMENT_TRANSLATION_LOCALES as readonly string[]).includes(value);
}

export interface AnnouncementSourceText {
  locale?: string | null;
  title?: string | null;
  message?: string | null;
  ctaLabel?: string | null;
  discountCode?: string | null;
}

/** Stable hash of the translatable source text; changes whenever a translation must be redone. */
export function computeAnnouncementSourceHash(source: AnnouncementSourceText): string {
  const payload = JSON.stringify([
    String(source.locale || 'en').toLowerCase(),
    String(source.title || ''),
    String(source.message || ''),
    String(source.ctaLabel || ''),
    String(source.discountCode || ''),
  ]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Base language of a stored locale ("nl-BE" → "nl"). */
export function sourceLanguageOf(locale: unknown): string {
  return String(locale || 'en').trim().toLowerCase().split('-')[0] || 'en';
}

export function isTranslatableSource(locale: unknown): boolean {
  return (ANNOUNCEMENT_SOURCE_LANGUAGES as readonly string[]).includes(sourceLanguageOf(locale));
}

/** Locales to translate into: every app locale except the source language. */
export function announcementTargetLocales(locale: unknown): AnnouncementTranslationLocale[] {
  if (!isTranslatableSource(locale)) return [];
  const base = sourceLanguageOf(locale);
  return ANNOUNCEMENT_TRANSLATION_LOCALES.filter((target) => target !== base);
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max).trimEnd() : value;
}

function errorCodeOf(err: unknown): string {
  if (err instanceof PlaceholderLostError) return 'placeholder_lost';
  if (err instanceof TranslatorError) return err.code;
  return 'internal';
}

/** Fixed admin-facing copy per error code (never raw provider text). */
export function announcementTranslationErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'rate_limited':
      return 'The translation service is busy (rate limited). Retry in a minute.';
    case 'quota_exceeded':
      return 'The translation quota is exhausted.';
    case 'auth':
      return 'The translation service rejected the credentials.';
    case 'timeout':
      return 'The translation service did not answer in time.';
    case 'budget_exceeded':
      return 'The translation run ran out of time. Retry.';
    case 'not_configured':
      return 'Auto-translation is not configured.';
    case 'placeholder_lost':
      return 'The translation altered a code or merge tag, so it was not saved.';
    case 'changed_during_run':
      return 'The announcement changed during translation; a new run was queued.';
    case 'interrupted':
      return 'The translation run was interrupted. Retry.';
    default:
      return 'Translation failed.';
  }
}

function failed(locale: string, code: string): Omit<ISiteAnnouncementTranslationResult, 'at'> {
  return { locale, status: 'failed', errorCode: code, error: announcementTranslationErrorMessage(code) };
}

// ---------------------------------------------------------------- scheduling

const inFlight = new Set<Promise<void>>();

/** Resolves once every scheduled background run has settled (tests). */
export async function waitForAnnouncementTranslationJobs(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

export function scheduleAnnouncementTranslationProcessing(id: Id): Promise<void> {
  const job = processAnnouncementTranslationQueue(id).catch((err) => {
    console.error(`[announcementTranslations] background run crashed for ${String(id)}:`, err);
  });
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
  try {
    waitUntil(job);
  } catch (err) {
    console.warn('[announcementTranslations] waitUntil unavailable; run continues unmanaged:', err);
  }
  return job;
}

/**
 * Marks the announcement as wanting a run (merging forced locales) and
 * schedules processing. No-op (returns false) when the translator is not
 * configured or the source language cannot be translated.
 */
export async function requestAnnouncementTranslationRun(
  id: Id,
  options: { forceLocales?: string[] } = {},
): Promise<boolean> {
  if (!isTranslatorConfigured()) return false;
  const forceLocales = Array.from(new Set((options.forceLocales ?? []).filter(isAnnouncementTranslationLocale)));
  const updated = await SiteAnnouncement.updateOne(
    { _id: id },
    {
      $set: { 'translationRun.requested': true, 'translationRun.requestedAt': new Date() },
      ...(forceLocales.length ? { $addToSet: { 'translationRun.forceLocales': { $each: forceLocales } } } : {}),
    },
    NO_TIMESTAMPS,
  );
  if (updated.matchedCount === 0) return false;
  scheduleAnnouncementTranslationProcessing(id);
  return true;
}

/**
 * Translates one claimed announcement into every target locale that needs it.
 * Returns one result per target locale.
 */
async function runAnnouncementTranslation(
  doc: Record<string, any>,
  runId: string,
  forceLocales: string[],
  deadline: number,
): Promise<Array<Omit<ISiteAnnouncementTranslationResult, 'at'>>> {
  const hash: string = doc.translationSourceHash || computeAnnouncementSourceHash(doc);
  const from = sourceLanguageOf(doc.locale);
  const results: Array<Omit<ISiteAnnouncementTranslationResult, 'at'>> = [];

  for (const locale of announcementTargetLocales(doc.locale)) {
    const existing = doc.translations?.[locale] as ISiteAnnouncementTranslation | undefined;
    const forced = forceLocales.includes(locale);
    if (existing?.mode === 'manual' && !forced) {
      results.push({ locale, status: 'skipped_manual' });
      continue;
    }
    if (existing?.mode === 'machine' && existing.sourceHash === hash && !forced) {
      results.push({ locale, status: 'unchanged' });
      continue;
    }
    if (Date.now() >= deadline) {
      results.push(failed(locale, 'budget_exceeded'));
      continue;
    }

    let translated: string[];
    try {
      translated = await translateProtectedFields(
        [
          { text: String(doc.title || ''), kind: 'plain' },
          { text: String(doc.message || ''), kind: 'plain' },
          { text: String(doc.ctaLabel || ''), kind: 'plain' },
        ],
        {
          from,
          to: locale,
          deadline,
          literals: doc.discountCode ? [String(doc.discountCode)] : [],
          languages: ANNOUNCEMENT_SOURCE_LANGUAGES,
        },
      );
    } catch (err) {
      if (!(err instanceof TranslatorError) && !(err instanceof PlaceholderLostError)) {
        console.error(`[announcementTranslations] ${locale} failed for ${String(doc._id)}:`, err);
      }
      results.push(failed(locale, errorCodeOf(err)));
      continue;
    }

    const [title, message, ctaLabel] = translated;
    if (!title.trim() || !message.trim()) {
      results.push(failed(locale, 'provider_error'));
      continue;
    }

    const translation: ISiteAnnouncementTranslation = {
      title: clamp(title, ANNOUNCEMENT_TRANSLATION_LIMITS.title),
      message: clamp(message, ANNOUNCEMENT_TRANSLATION_LIMITS.message),
      ...(ctaLabel.trim() ? { ctaLabel: clamp(ctaLabel, ANNOUNCEMENT_TRANSLATION_LIMITS.ctaLabel) } : {}),
      mode: 'machine',
      sourceHash: hash,
      updatedAt: new Date(),
    };

    const filter: Record<string, unknown> = {
      _id: doc._id,
      'translationRun.runId': runId,
      translationSourceHash: hash,
    };
    if (!forced) filter[`translations.${locale}.mode`] = { $ne: 'manual' };

    const written = await SiteAnnouncement.updateOne(
      filter,
      { $set: { [`translations.${locale}`]: translation } },
      NO_TIMESTAMPS,
    );
    if (written.matchedCount > 0) {
      results.push({ locale, status: 'translated' });
      continue;
    }
    // Lost the race: an admin made it manual, or the source text changed.
    const fresh = (await SiteAnnouncement.findById(doc._id)
      .select('translations translationSourceHash')
      .lean()) as Record<string, any> | null;
    if (fresh?.translations?.[locale]?.mode === 'manual' && !forced) {
      results.push({ locale, status: 'skipped_manual' });
    } else {
      results.push(failed(locale, 'changed_during_run'));
    }
  }
  return results;
}

/**
 * Claims the lease and runs until no request is pending (bounded). Returns
 * silently when nothing is requested or another worker holds the lease.
 */
export async function processAnnouncementTranslationQueue(
  id: Id,
  options: { maxRuns?: number; budgetMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.budgetMs ?? ANNOUNCEMENT_TRANSLATION_BUDGET_MS);
  const maxRuns = options.maxRuns ?? MAX_RUNS_PER_INVOCATION;

  for (let run = 0; run < maxRuns; run += 1) {
    if (Date.now() >= deadline) return;
    const now = new Date();
    const runId = randomUUID();
    const claimed = (await SiteAnnouncement.findOneAndUpdate(
      {
        _id: id,
        'translationRun.requested': true,
        $or: [{ 'translationRun.leaseUntil': null }, { 'translationRun.leaseUntil': { $lte: now } }],
      },
      [
        {
          $set: {
            'translationRun.requested': false,
            'translationRun.runId': runId,
            'translationRun.leaseUntil': new Date(now.getTime() + ANNOUNCEMENT_TRANSLATION_LEASE_MS),
            'translationRun.startedAt': now,
            'translationRun.activeForceLocales': { $ifNull: ['$translationRun.forceLocales', []] },
          },
        },
        { $unset: 'translationRun.forceLocales' },
      ],
      { new: true, ...NO_TIMESTAMPS },
    ).lean()) as Record<string, any> | null;
    if (!claimed) return;

    // Legacy announcements (created before translation support) have no hash yet.
    if (!claimed.translationSourceHash) {
      const hash = computeAnnouncementSourceHash(claimed);
      await SiteAnnouncement.updateOne(
        { _id: id, translationSourceHash: { $exists: false } },
        { $set: { translationSourceHash: hash } },
        NO_TIMESTAMPS,
      );
      const fresh = (await SiteAnnouncement.findById(id).lean()) as Record<string, any> | null;
      if (!fresh) return;
      Object.assign(claimed, fresh);
    }

    const forceLocales: string[] = Array.isArray(claimed.translationRun?.activeForceLocales)
      ? claimed.translationRun.activeForceLocales
      : [];

    let results: Array<Omit<ISiteAnnouncementTranslationResult, 'at'>>;
    try {
      results = await runAnnouncementTranslation(claimed, runId, forceLocales, deadline);
    } catch (err) {
      console.error(`[announcementTranslations] run crashed for ${String(id)}:`, err);
      results = announcementTargetLocales(claimed.locale).map((locale) => failed(locale, 'internal'));
    }

    const at = new Date();
    const released = await SiteAnnouncement.updateOne(
      { _id: id, 'translationRun.runId': runId },
      {
        $set: {
          translationResults: results.map((result) => ({ ...result, at })),
          'translationRun.finishedAt': at,
        },
        $unset: {
          'translationRun.runId': 1,
          'translationRun.leaseUntil': 1,
          'translationRun.activeForceLocales': 1,
        },
      },
      NO_TIMESTAMPS,
    );
    if (released.matchedCount === 0) return;
  }
}

/**
 * Repairs run state seen by a status read: an expired lease means the worker
 * died (record `interrupted`, release); a pending request without a live
 * worker is (re)scheduled. Returns true when it changed anything.
 */
export async function reconcileAnnouncementTranslationRun(doc: Record<string, any>): Promise<boolean> {
  const run = doc.translationRun as Record<string, any> | undefined;
  if (!run) return false;
  const now = new Date();
  const leaseExpired = run.leaseUntil ? new Date(run.leaseUntil).getTime() <= now.getTime() : true;
  let changed = false;

  if (run.runId && leaseExpired) {
    const released = await SiteAnnouncement.updateOne(
      { _id: doc._id, 'translationRun.runId': run.runId, 'translationRun.leaseUntil': { $lte: now } },
      {
        $set: {
          translationResults: announcementTargetLocales(doc.locale).map((locale) => ({
            ...failed(locale, 'interrupted'),
            at: now,
          })),
          'translationRun.finishedAt': now,
        },
        $unset: {
          'translationRun.runId': 1,
          'translationRun.leaseUntil': 1,
          'translationRun.activeForceLocales': 1,
        },
      },
      NO_TIMESTAMPS,
    );
    changed = released.matchedCount > 0;
  }

  if (run.requested && (leaseExpired || changed) && isTranslatorConfigured()) {
    scheduleAnnouncementTranslationProcessing(doc._id);
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------- status

export type AnnouncementLocaleState =
  | 'source'
  | 'pending'
  | 'up_to_date'
  | 'stale'
  | 'missing'
  | 'failed'
  | 'manual';

export interface AnnouncementLocaleStatus {
  locale: string;
  state: AnnouncementLocaleState;
  /** Manual translation made from an older version of the source text. */
  sourceChanged?: boolean;
  translation?: {
    title: string;
    message: string;
    ctaLabel?: string;
    mode: 'machine' | 'manual';
    updatedAt?: Date;
  };
  lastResult?: { status: string; errorCode?: string; error?: string; at?: Date };
}

export interface AnnouncementTranslationStatus {
  enabled: boolean;
  /** False when the source language cannot be machine-translated. */
  supported: boolean;
  sourceLocale: string;
  running: boolean;
  queued: boolean;
  lastRunAt?: Date;
  locales: AnnouncementLocaleStatus[];
}

/** Pure status derivation (no I/O). */
export function deriveAnnouncementTranslationStatus(
  doc: Record<string, any>,
  options: { enabled?: boolean; now?: Date } = {},
): AnnouncementTranslationStatus {
  const enabled = options.enabled ?? isTranslatorConfigured();
  const now = (options.now ?? new Date()).getTime();
  const run = (doc.translationRun || {}) as Record<string, any>;
  const running = Boolean(run.runId && run.leaseUntil && new Date(run.leaseUntil).getTime() > now);
  const queued = run.requested === true;
  const forceLocales: string[] = [
    ...(queued && Array.isArray(run.forceLocales) ? run.forceLocales : []),
    ...(running && Array.isArray(run.activeForceLocales) ? run.activeForceLocales : []),
  ];
  const hash: string = doc.translationSourceHash || computeAnnouncementSourceHash(doc);
  const base = sourceLanguageOf(doc.locale);
  const supported = isTranslatableSource(doc.locale);

  const locales: AnnouncementLocaleStatus[] = [];
  for (const locale of ANNOUNCEMENT_TRANSLATION_LOCALES) {
    if (locale === base) {
      locales.push({ locale, state: 'source' });
      continue;
    }
    const translation = doc.translations?.[locale] as ISiteAnnouncementTranslation | undefined;
    const lastEntry = (doc.translationResults as Array<Record<string, any>> | undefined)?.find(
      (entry) => entry.locale === locale,
    );
    let state: AnnouncementLocaleState;
    let sourceChanged: boolean | undefined;
    if (!translation) state = 'missing';
    else if (translation.mode === 'manual') {
      state = 'manual';
      if (translation.sourceHash !== hash) sourceChanged = true;
    } else state = translation.sourceHash === hash ? 'up_to_date' : 'stale';

    const inFlightRun = running || queued;
    if (inFlightRun && (state === 'missing' || state === 'stale')) state = 'pending';
    else if (inFlightRun && state === 'manual' && forceLocales.includes(locale)) state = 'pending';
    else if (lastEntry?.status === 'failed' && (state === 'missing' || state === 'stale')) state = 'failed';

    locales.push({
      locale,
      state,
      ...(sourceChanged ? { sourceChanged } : {}),
      ...(translation
        ? {
            translation: {
              title: translation.title,
              message: translation.message,
              ...(translation.ctaLabel ? { ctaLabel: translation.ctaLabel } : {}),
              mode: translation.mode,
              updatedAt: translation.updatedAt,
            },
          }
        : {}),
      ...(lastEntry
        ? {
            lastResult: {
              status: String(lastEntry.status),
              ...(lastEntry.errorCode ? { errorCode: String(lastEntry.errorCode) } : {}),
              ...(lastEntry.errorCode ? { error: announcementTranslationErrorMessage(lastEntry.errorCode) } : {}),
              ...(lastEntry.at ? { at: lastEntry.at } : {}),
            },
          }
        : {}),
    });
  }

  return {
    enabled,
    supported,
    sourceLocale: String(doc.locale || 'en'),
    running,
    queued,
    ...(run.finishedAt ? { lastRunAt: run.finishedAt } : {}),
    locales,
  };
}

/** Loads (and reconciles) the status of one announcement; null when it does not exist. */
export async function loadAnnouncementTranslationStatus(id: Id): Promise<AnnouncementTranslationStatus | null> {
  let doc = (await SiteAnnouncement.findById(id).lean()) as Record<string, any> | null;
  if (!doc) return null;
  if (await reconcileAnnouncementTranslationRun(doc)) {
    doc = ((await SiteAnnouncement.findById(id).lean()) as Record<string, any> | null) ?? doc;
  }
  return deriveAnnouncementTranslationStatus(doc);
}

/** Fields that are internal bookkeeping and never belong in an API response. */
export function stripTranslationBookkeeping<T extends Record<string, unknown>>(value: T): T {
  const { translationRun: _run, translationResults: _results, ...rest } = value as Record<string, unknown>;
  return rest as T;
}
