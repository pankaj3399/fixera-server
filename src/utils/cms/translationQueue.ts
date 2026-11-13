/**
 * Background CMS translation runs.
 *
 * Saves never wait for Azure. The request mirrors control fields inline
 * (`syncCmsTranslations(..., { translate: false })`), then calls
 * {@link requestCmsTranslationRun}, which marks the SOURCE doc as wanting a run
 * and processes it after the response through Vercel `waitUntil` (post-response
 * work without it is frozen on Vercel).
 *
 * Concurrency: one worker per source at a time, via a lease on
 * `translationRun.runId/leaseUntil` claimed with an atomic findOneAndUpdate.
 * A save while a run is in flight only sets `translationRun.requested`; the
 * lease holder re-checks it after finishing and runs again on the fresh
 * source, so overlapping saves coalesce and the last text always wins. A
 * worker that dies (function timeout) leaves an expiring lease; the status
 * endpoint reports it as `interrupted` and re-schedules pending work.
 *
 * All bookkeeping writes use `timestamps: false`: the source's updatedAt (used
 * for the sitemap lastmod and admin ordering) only changes on real edits.
 */
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import type { Types } from "mongoose";

import CmsContent from "../../models/cmsContent";
import {
  deleteAutoTranslatedSiblings,
  failedResult,
  isTranslationSource,
  syncCmsTranslations,
  targetLocalesFor,
  TranslationResult,
} from "./syncTranslations";

/** Longer than the function's maxDuration (300s), so a live worker never loses it. */
export const TRANSLATION_LEASE_MS = 330_000;
/** Total time one invocation may spend starting provider requests. */
export const TRANSLATION_INVOCATION_BUDGET_MS = 240_000;
/** Coalesced re-runs handled by one invocation before leaving the rest to the next trigger. */
const MAX_RUNS_PER_INVOCATION = 3;

const NO_TIMESTAMPS = { timestamps: false } as const;

type Id = Types.ObjectId | string;

/** In-flight background jobs; awaited by tests through {@link waitForCmsTranslationJobs}. */
const inFlight = new Set<Promise<void>>();

/** Resolves once every scheduled background run (including ones they start) has settled. */
export async function waitForCmsTranslationJobs(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

/** Starts background processing for a source, kept alive past the response by waitUntil. */
export function scheduleCmsTranslationProcessing(sourceId: Id): Promise<void> {
  const job = processCmsTranslationQueue(sourceId).catch((err) => {
    console.error(`[cmsTranslations] background run crashed for ${String(sourceId)}:`, err);
  });
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
  try {
    waitUntil(job);
  } catch (err) {
    // Outside a Vercel request context waitUntil may be a no-op or throw;
    // the job is already running either way.
    console.warn("[cmsTranslations] waitUntil unavailable; background run continues unmanaged:", err);
  }
  return job;
}

/**
 * Marks the source as wanting a translation run (merging any forced locales)
 * and schedules processing. Cheap and safe to call repeatedly.
 */
export async function requestCmsTranslationRun(
  sourceId: Id,
  options: { forceLocales?: string[] } = {}
): Promise<void> {
  const forceLocales = Array.from(new Set(options.forceLocales ?? []));
  await CmsContent.updateOne(
    { _id: sourceId },
    {
      $set: { "translationRun.requested": true, "translationRun.requestedAt": new Date() },
      ...(forceLocales.length
        ? { $addToSet: { "translationRun.forceLocales": { $each: forceLocales } } }
        : {}),
    },
    NO_TIMESTAMPS
  );
  scheduleCmsTranslationProcessing(sourceId);
}

/**
 * Claims the lease and runs until no request is pending (bounded). Returns
 * silently when nothing is requested or another worker holds the lease (that
 * worker will see the request when it finishes).
 */
export async function processCmsTranslationQueue(
  sourceId: Id,
  options: { maxRuns?: number; budgetMs?: number } = {}
): Promise<void> {
  const invocationDeadline = Date.now() + (options.budgetMs ?? TRANSLATION_INVOCATION_BUDGET_MS);
  const maxRuns = options.maxRuns ?? MAX_RUNS_PER_INVOCATION;

  for (let run = 0; run < maxRuns; run += 1) {
    if (Date.now() >= invocationDeadline) return;
    const now = new Date();
    const runId = randomUUID();
    const claimed = (await CmsContent.findOneAndUpdate(
      {
        _id: sourceId,
        "translationRun.requested": true,
        $or: [
          { "translationRun.leaseUntil": null },
          { "translationRun.leaseUntil": { $lte: now } },
        ],
      },
      // Pipeline update: the claim moves the requested forced locales to
      // `activeForceLocales` in the same atomic write, so a status read never
      // sees a claimed run without them.
      [
        {
          $set: {
            "translationRun.requested": false,
            "translationRun.runId": runId,
            "translationRun.leaseUntil": new Date(now.getTime() + TRANSLATION_LEASE_MS),
            "translationRun.startedAt": now,
            "translationRun.activeForceLocales": { $ifNull: ["$translationRun.forceLocales", []] },
          },
        },
        { $unset: "translationRun.forceLocales" },
      ],
      { returnDocument: "before", ...NO_TIMESTAMPS }
    ).lean()) as Record<string, any> | null;
    if (!claimed) return;

    const forceLocales: string[] = claimed.translationRun?.forceLocales ?? [];

    const holdsLease = async () =>
      Boolean(await CmsContent.exists({ _id: sourceId, "translationRun.runId": runId }));

    let results: TranslationResult[] = [];
    if (isTranslationSource(claimed)) {
      try {
        results = await syncCmsTranslations(claimed, {
          translate: true,
          forceLocales,
          deadline: invocationDeadline,
          guard: holdsLease,
          reloadSource: true,
        });
      } catch (err) {
        console.error(`[cmsTranslations] sync crashed for ${String(sourceId)}:`, err);
        results = targetLocalesFor(claimed.locale).map((locale) => failedResult(locale, "internal"));
      }
    }

    const at = new Date();
    const released = await CmsContent.updateOne(
      { _id: sourceId, "translationRun.runId": runId },
      {
        $set: {
          translationResults: results.map((result) => ({ ...result, at })),
          "translationRun.finishedAt": at,
        },
        $unset: {
          "translationRun.runId": 1,
          "translationRun.leaseUntil": 1,
          "translationRun.activeForceLocales": 1,
        },
      },
      NO_TIMESTAMPS
    );
    if (released.matchedCount === 0) {
      // Lease lost. If the source was deleted mid-run, remove any machine
      // translation this run created after the delete handler's cleanup.
      if (!(await CmsContent.exists({ _id: sourceId }))) {
        await deleteAutoTranslatedSiblings({ _id: sourceId });
      }
      return;
    }
  }
}

/**
 * Repairs run state seen by a status read:
 * - a lease that expired while still set means the worker died: record
 *   `interrupted` for every target locale and release it;
 * - a pending request with no live worker is (re)scheduled.
 * Returns true when it changed anything (callers re-read the source).
 */
export async function reconcileCmsTranslationRun(source: Record<string, any>): Promise<boolean> {
  const run = source.translationRun as Record<string, any> | undefined;
  if (!run) return false;
  const now = new Date();
  const leaseExpired = run.leaseUntil ? new Date(run.leaseUntil).getTime() <= now.getTime() : true;
  let changed = false;

  if (run.runId && leaseExpired) {
    const released = await CmsContent.updateOne(
      { _id: source._id, "translationRun.runId": run.runId, "translationRun.leaseUntil": { $lte: now } },
      {
        $set: {
          translationResults: targetLocalesFor(source.locale).map((locale) => ({
            ...failedResult(locale, "interrupted"),
            at: now,
          })),
          "translationRun.finishedAt": now,
        },
        $unset: {
          "translationRun.runId": 1,
          "translationRun.leaseUntil": 1,
          "translationRun.activeForceLocales": 1,
        },
      },
      NO_TIMESTAMPS
    );
    changed = released.matchedCount > 0;
  }

  if (run.requested && (leaseExpired || changed)) {
    scheduleCmsTranslationProcessing(source._id);
    changed = true;
  }
  return changed;
}
