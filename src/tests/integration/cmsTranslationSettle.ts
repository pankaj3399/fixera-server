/**
 * Integration-test helper for the async CMS translation design.
 *
 * Admin saves and retries answer before the provider work: locales that need
 * text come back `pending` and a background run (translationQueue) writes the
 * result onto the source's `translationResults`. `settleCmsResponse` waits for
 * every background run of this process to finish, keeps the immediate results
 * on `body.immediate`, and replaces each `pending` entry of
 * `body.translations` with that locale's final background outcome, so the
 * existing per-locale assertions check what the run actually did.
 */
import CmsContent from '../../models/cmsContent';
import { translatorTiming } from '../../utils/cms/azureTranslator';
import { waitForCmsTranslationJobs } from '../../utils/cms/translationQueue';

type Result = { locale: string; status: string; errorCode?: string; error?: string };

/** Retries back off for real seconds in production; tests never wait. */
export function skipTranslatorBackoff(): () => void {
  const original = translatorTiming.sleep;
  translatorTiming.sleep = async () => undefined;
  return () => {
    translatorTiming.sleep = original;
  };
}

export async function settleCmsResponse(body: any): Promise<any> {
  await waitForCmsTranslationJobs();
  const translations: Result[] | undefined = body?.translations;
  if (!Array.isArray(translations) || !translations.some((t) => t.status === 'pending')) return body;

  const sourceId = body.data?.translationStatus?.sourceId ?? body.data?.sourceId;
  if (!sourceId) throw new Error('pending translations without a source id in the response');
  const source = (await CmsContent.findById(sourceId).select('translationResults').lean()) as any;
  const final = new Map<string, Result>(
    ((source?.translationResults ?? []) as Result[]).map((r) => [
      r.locale,
      {
        locale: r.locale,
        status: r.status,
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        ...(r.error ? { error: r.error } : {}),
      },
    ]),
  );
  return {
    ...body,
    immediate: translations,
    translations: translations.map((t) =>
      t.status === 'pending' ? final.get(t.locale) ?? { locale: t.locale, status: 'pending (no run result)' } : t,
    ),
  };
}
