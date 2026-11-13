/**
 * "Auto-translate" for email campaign drafts.
 *
 * Stateless: translates the admin's current source-language draft (subject,
 * preview text, HTML body) into the requested draft languages and returns the
 * result. Nothing is saved or sent here; the admin reviews/edits the filled
 * fields and saves the draft as usual.
 *
 * Merge tags ({{ contact.FIRSTNAME }}, {{firstName}}, {% ... %}, *|FNAME|*)
 * are protected and verified (translation/protectedTranslate.ts); a locale
 * whose translation would alter one fails instead of returning broken copy.
 */
import { MARKETING_LOCALES, type MarketingLocale } from './marketingCatalog';
import { TranslatorError } from '../cms/azureTranslator';
import { PlaceholderLostError, translateProtectedFields } from '../translation/protectedTranslate';

export const CAMPAIGN_TRANSLATION_BUDGET_MS = 45_000;
/** Body limit for one draft (Azure splits HTML > 45k chars itself). */
export const CAMPAIGN_TRANSLATION_MAX_HTML = 200_000;

export interface CampaignDraftContent {
  subject: string;
  htmlContent: string;
  previewText?: string;
}

export type CampaignTranslationOutcome =
  | { locale: MarketingLocale; status: 'translated'; content: CampaignDraftContent }
  | { locale: MarketingLocale; status: 'failed'; errorCode: string; error: string };

export class CampaignTranslationInputError extends Error {}

function isMarketingLocale(value: unknown): value is MarketingLocale {
  return typeof value === 'string' && (MARKETING_LOCALES as readonly string[]).includes(value);
}

export function campaignTranslationErrorMessage(code: string): string {
  switch (code) {
    case 'placeholder_lost':
      return 'The translation altered a merge tag, so this language was left unchanged.';
    case 'rate_limited':
      return 'The translation service is busy. Retry in a minute.';
    case 'quota_exceeded':
      return 'The translation quota is exhausted.';
    case 'auth':
      return 'The translation service rejected the credentials.';
    case 'timeout':
    case 'budget_exceeded':
      return 'The translation service did not answer in time. Retry.';
    default:
      return 'Translation failed for this language.';
  }
}

/** Validates the request body; throws CampaignTranslationInputError with an admin-facing message. */
export function parseCampaignTranslationRequest(body: unknown): {
  sourceLocale: MarketingLocale;
  targetLocales: MarketingLocale[];
  content: CampaignDraftContent;
} {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const sourceLocale = typeof raw.sourceLocale === 'string' ? raw.sourceLocale.trim().toLowerCase() : '';
  if (!isMarketingLocale(sourceLocale)) {
    throw new CampaignTranslationInputError('Choose a supported source language');
  }
  const targetsRaw = Array.isArray(raw.targetLocales) ? raw.targetLocales : [];
  const targetLocales = Array.from(
    new Set(targetsRaw.map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))),
  );
  if (targetLocales.length === 0) {
    throw new CampaignTranslationInputError('Select at least one language to translate into');
  }
  if (!targetLocales.every(isMarketingLocale)) {
    throw new CampaignTranslationInputError('Target languages contain an unsupported marketing language');
  }
  if (targetLocales.includes(sourceLocale)) {
    throw new CampaignTranslationInputError('The source language cannot also be a target');
  }
  const content = (raw.content && typeof raw.content === 'object' ? raw.content : {}) as Record<string, unknown>;
  const subject = typeof content.subject === 'string' ? content.subject.trim() : '';
  const htmlContent = typeof content.htmlContent === 'string' ? content.htmlContent : '';
  const previewText = typeof content.previewText === 'string' ? content.previewText.trim() : '';
  if (!subject) throw new CampaignTranslationInputError('The source language needs a subject');
  if (!htmlContent.replace(/<[^>]*>/g, '').trim()) {
    throw new CampaignTranslationInputError('The source language needs body content (Brevo templates cannot be auto-translated)');
  }
  if (htmlContent.length > CAMPAIGN_TRANSLATION_MAX_HTML) {
    throw new CampaignTranslationInputError('The email body is too large to auto-translate');
  }
  return {
    sourceLocale,
    targetLocales: targetLocales as MarketingLocale[],
    content: { subject, htmlContent, ...(previewText ? { previewText } : {}) },
  };
}

/** Translates the draft into each target; failures are per locale. */
export async function translateCampaignDraft(input: {
  sourceLocale: MarketingLocale;
  targetLocales: MarketingLocale[];
  content: CampaignDraftContent;
  deadline?: number;
}): Promise<CampaignTranslationOutcome[]> {
  const deadline = input.deadline ?? Date.now() + CAMPAIGN_TRANSLATION_BUDGET_MS;
  const outcomes: CampaignTranslationOutcome[] = [];
  for (const locale of input.targetLocales) {
    try {
      const [subject, previewText, htmlContent] = await translateProtectedFields(
        [
          { text: input.content.subject, kind: 'plain' },
          { text: input.content.previewText || '', kind: 'plain' },
          { text: input.content.htmlContent, kind: 'html' },
        ],
        { from: input.sourceLocale, to: locale, deadline, languages: MARKETING_LOCALES },
      );
      if (!subject.trim() || !htmlContent.trim()) {
        throw new TranslatorError('Empty translation', undefined, 'provider_error');
      }
      outcomes.push({
        locale,
        status: 'translated',
        content: { subject, htmlContent, ...(previewText ? { previewText } : {}) },
      });
    } catch (err) {
      const code =
        err instanceof PlaceholderLostError ? 'placeholder_lost' : err instanceof TranslatorError ? err.code : 'internal';
      if (code === 'internal') console.error(`[campaignTranslate] ${locale} failed:`, err);
      if (code === 'not_configured') throw err;
      outcomes.push({ locale, status: 'failed', errorCode: code, error: campaignTranslationErrorMessage(code) });
    }
  }
  return outcomes;
}
