export const MARKETING_LOCALES = ['en', 'nl', 'fr', 'de'] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

export const MARKETING_LANGUAGE_CATALOG: ReadonlyArray<{
  code: MarketingLocale;
  name: string;
  countries: readonly string[];
}> = [
  { code: 'en', name: 'English', countries: ['BE', 'NL', 'FR', 'DE'] },
  { code: 'nl', name: 'Nederlands', countries: ['BE', 'NL'] },
  { code: 'fr', name: 'Français', countries: ['BE', 'FR'] },
  { code: 'de', name: 'Deutsch', countries: ['DE'] },
];

/**
 * Belgium is multilingual. Never infer Dutch or French from the country alone:
 * an explicit stored language wins, otherwise English is the neutral default.
 */
const DEFAULT_LOCALE_BY_COUNTRY: Record<string, MarketingLocale> = {
  BE: 'en',
  NL: 'nl',
  FR: 'fr',
  DE: 'de',
};

const LANGUAGE_ALIASES: Record<string, MarketingLocale> = {
  en: 'en',
  eng: 'en',
  english: 'en',
  engels: 'en',
  anglais: 'en',
  englisch: 'en',
  nl: 'nl',
  dutch: 'nl',
  nederlands: 'nl',
  flemish: 'nl',
  vlaams: 'nl',
  neerlandais: 'nl',
  niederlandisch: 'nl',
  fr: 'fr',
  french: 'fr',
  francais: 'fr',
  frans: 'fr',
  franzosisch: 'fr',
  de: 'de',
  german: 'de',
  duits: 'de',
  deutsch: 'de',
  allemand: 'de',
};

function languageKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isMarketingLocale(value: unknown): value is MarketingLocale {
  return typeof value === 'string' && (MARKETING_LOCALES as readonly string[]).includes(value.toLowerCase());
}

/** Accept a locale code only. */
export function normalizeMarketingLocale(value: unknown): MarketingLocale | undefined {
  if (!isMarketingLocale(value)) return undefined;
  return String(value).toLowerCase() as MarketingLocale;
}

/**
 * Accept codes and localized/English language names. Used by lead import,
 * subscriber sync and legacy preference fields so `Nederlands` and `Dutch`
 * are treated as an explicit `nl` choice.
 */
export function normalizeMarketingLanguage(value: unknown): MarketingLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const key = languageKey(value);
  if (!key) return undefined;
  return LANGUAGE_ALIASES[key] || normalizeMarketingLocale(key);
}

export function defaultMarketingLocaleForCountry(country: unknown): MarketingLocale {
  const code = typeof country === 'string' ? country.trim().toUpperCase() : '';
  return DEFAULT_LOCALE_BY_COUNTRY[code] || 'en';
}

export function resolveSubscriberLocale(
  user: any,
  country?: string,
): { locale: MarketingLocale; source: 'explicit' | 'country_default' | 'fallback' } {
  const explicitLocale = normalizeMarketingLanguage(user?.marketingLocale);
  if (explicitLocale) return { locale: explicitLocale, source: 'explicit' };

  // Keep legacy preference fields readable while the canonical marketingLocale
  // field rolls out. They still represent an explicit user choice, including
  // localized names such as "Nederlands" or "Français".
  const legacyLocale = normalizeMarketingLanguage(
    user?.preferredLocale ?? user?.locale ?? user?.language,
  );
  if (legacyLocale) return { locale: legacyLocale, source: 'explicit' };

  if (country) {
    const canonicalCountry =
      typeof country === 'string' ? country.trim().toUpperCase() : '';
    if (canonicalCountry === 'BE') {
      // Belgium is multilingual; do not guess Dutch versus French.
      return { locale: 'en', source: 'fallback' };
    }
    return {
      locale: defaultMarketingLocaleForCountry(canonicalCountry),
      source: 'country_default',
    };
  }
  return { locale: 'en', source: 'fallback' };
}

/**
 * Country precedence for display-locale resolution: explicit location first,
 * then company address, then business info. Used by the notification
 * preferences GET so the UI can show the country default (NL -> nl) without
 * ever writing it back or treating it as consent.
 */
export function subscriberCountryFromUser(user: any): string | undefined {
  const candidates = [
    user?.location?.country,
    user?.companyAddress?.country,
    user?.businessInfo?.country,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function marketingLanguagesForCountries(countries: readonly string[]): MarketingLocale[] {
  if (countries.length === 0) return [...MARKETING_LOCALES];
  const normalized = new Set(countries.map((country) => country.trim().toUpperCase()));
  return MARKETING_LANGUAGE_CATALOG
    .filter((language) => language.countries.some((country) => normalized.has(country)))
    .map((language) => language.code);
}
