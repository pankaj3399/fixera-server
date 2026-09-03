import { getFrontendUrl } from '../frontendUrl';
import { defaultMarketingLocaleForCountry, type MarketingLocale } from './marketingCatalog';

export type CampaignRenderContent = {
  subject: string;
  htmlContent: string;
  previewText?: string;
  brevoTemplateId?: number;
};

export class MarketingContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingContentError';
  }
}

const GENERIC_GREETING: Record<MarketingLocale, string> = {
  en: 'Hi there,',
  nl: 'Hallo,',
  fr: 'Bonjour,',
  de: 'Hallo,',
};

const UNSUBSCRIBE_COPY: Record<MarketingLocale, { optedIn: string; unsubscribe: string; preferences: string }> = {
  en: { optedIn: 'You received this because you opted in to Fixtract promotions.', unsubscribe: 'Unsubscribe', preferences: 'Notification preferences' },
  nl: { optedIn: 'Je ontvangt dit omdat je je hebt ingeschreven voor Fixtract-promoties.', unsubscribe: 'Uitschrijven', preferences: 'Meldingsvoorkeuren' },
  fr: { optedIn: 'Vous recevez cet e-mail parce que vous avez accepté les promotions Fixtract.', unsubscribe: 'Se désabonner', preferences: 'Préférences de notification' },
  de: { optedIn: 'Sie erhalten diese E-Mail, weil Sie Fixtract-Werbung abonniert haben.', unsubscribe: 'Abmelden', preferences: 'Benachrichtigungseinstellungen' },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const PREVIEW_PLACEHOLDER_RE = /\{\{\s*\.PreviewText\s*\}\}/gi;

function applyPreviewText(html: string, previewText?: string): string {
  const text = typeof previewText === 'string' ? previewText.trim() : '';
  const replaced = html.replace(PREVIEW_PLACEHOLDER_RE, () => escapeHtml(text));
  if (!text) return replaced;
  if (/data-fixera-preview-text\s*=/i.test(replaced)) return replaced;
  const preheader =
    `<div data-fixera-preview-text="true" style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(text)}</div>`;
  return `${preheader}${replaced}`;
}

function appendMarketingFooter(htmlContent: string, footer: string): string {
  return /data-fixera-marketing-footer\s*=\s*["']true["']/i.test(htmlContent)
    ? htmlContent
    : `${htmlContent}${footer}`;
}

export function resolveGreeting(firstName: unknown, locale: MarketingLocale): string {
  if (firstName === '{{ contact.FIRSTNAME }}') {
    const prefix = locale === 'nl' || locale === 'de' ? 'Hallo' : locale === 'fr' ? 'Bonjour' : 'Hi';
    return `${prefix} {{ contact.FIRSTNAME }},`;
  }
  const name = typeof firstName === 'string' ? firstName.trim().split(/\s+/)[0] : '';
  if (!name) return GENERIC_GREETING[locale] || GENERIC_GREETING.en;
  const prefix = locale === 'nl' || locale === 'de' ? 'Hallo' : locale === 'fr' ? 'Bonjour' : 'Hi';
  return `${prefix} ${escapeHtml(name)},`;
}

export function renderMarketingFooter(locale: MarketingLocale, unsubscribeToken = '{{ contact.UNSUB_TOKEN }}'): string {
  const copy = UNSUBSCRIBE_COPY[locale] || UNSUBSCRIBE_COPY.en;
  const base = getFrontendUrl();
  const unsubUrl = `${base}/unsubscribe?token=${unsubscribeToken}`;
  const prefsUrl = `${base}/profile?tab=notifications`;
  return `<div data-fixera-marketing-footer="true" style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:center;">` +
    `<p style="margin:0 0 8px 0;">${copy.optedIn}</p><p style="margin:0;">` +
    `<a href="${escapeHtml(unsubUrl)}" style="color:#6b7280;text-decoration:underline;">${copy.unsubscribe}</a>` +
    ` &nbsp;·&nbsp; <a href="${escapeHtml(prefsUrl)}" style="color:#6b7280;text-decoration:underline;">${copy.preferences}</a></p></div>`;
}

export function renderMarketingEmail(input: {
  content: CampaignRenderContent;
  locale?: MarketingLocale;
  firstName?: string;
  country?: string;
  unsubscribeToken?: string;
}): { subject: string; previewText?: string; htmlContent: string } {
  const locale = input.locale || defaultMarketingLocaleForCountry(input.country);
  const body = input.content.htmlContent || '';
  const greeting = `<p>${resolveGreeting(input.firstName, locale)}</p>`;
  return {
    subject: input.content.subject,
    previewText: input.content.previewText,
    htmlContent: applyPreviewText(
      appendMarketingFooter(`${greeting}${body}`, renderMarketingFooter(locale, input.unsubscribeToken)),
      input.content.previewText,
    ),
  };
}

/**
 * Render a remote Brevo template for a transactional test without trusting
 * user-supplied HTML. The template must already contain the localized
 * greeting contract; only the first-name token and the application footer
 * are rendered locally.
 */
export function renderMarketingTemplateEmail(input: {
  content: CampaignRenderContent;
  templateHtml: string;
  locale: MarketingLocale;
  firstName?: string;
  unsubscribeToken?: string;
}): { subject: string; previewText?: string; htmlContent: string } {
  assertTemplateGreetingContract(input.templateHtml, input.locale);
  const genericName: Record<MarketingLocale, string> = { en: 'there', nl: 'daar', fr: 'là', de: 'dort' };
  const name = typeof input.firstName === 'string' && input.firstName.trim()
    ? escapeHtml(input.firstName.trim().split(/\s+/)[0])
    : genericName[input.locale];
  const body = input.templateHtml.replace(/\{\{\s*contact\.FIRSTNAME\s*\}\}/gi, name);
  return {
    subject: input.content.subject,
    previewText: input.content.previewText,
    htmlContent: applyPreviewText(
      appendMarketingFooter(body, renderMarketingFooter(input.locale, input.unsubscribeToken)),
      input.content.previewText,
    ),
  };
}

/**
 * Brevo templates are rendered remotely, so the application cannot prepend the
 * personalized greeting itself. Require the template to put the greeting and
 * FIRSTNAME contact attribute at the beginning of its visible content.
 */
export function assertTemplateGreetingContract(htmlContent: string, locale: MarketingLocale): void {
  const visible = htmlContent
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const greetingByLocale: Record<MarketingLocale, RegExp> = {
    en: /^(?:hi|hello)(?:\s|,|!|<)/i,
    nl: /^hallo(?:\s|,|!|<)/i,
    fr: /^bonjour(?:\s|,|!|<)/i,
    de: /^hallo(?:\s|,|!|<)/i,
  };
  if (!greetingByLocale[locale].test(visible) || !/\{\{\s*contact\.FIRSTNAME\s*\}\}/i.test(htmlContent)) {
    throw new MarketingContentError(
      `Brevo template must begin with a localized ${locale} greeting using {{ contact.FIRSTNAME }}`,
    );
  }
}

export function assertInlineMarketingContent(content: CampaignRenderContent): void {
  if (content.brevoTemplateId && (!content.htmlContent || content.htmlContent.trim().length <= 10)) {
    throw new MarketingContentError('Test sends require inline HTML content so the greeting and footer can be verified');
  }
  if (!content.subject?.trim() || !content.htmlContent?.trim()) {
    throw new MarketingContentError('Campaign content requires a subject and HTML body');
  }
}
