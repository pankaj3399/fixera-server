/**
 * Supported CMS content locales, defined once for validation across admin and
 * public handlers. `en` is the source-of-truth locale: manual translations
 * always win over auto-generated ones, and public reads fall back to `en`.
 */
export const CMS_DEFAULT_LOCALE = "en";

export const CMS_LOCALES = ["en", "nl", "fr"] as const;

export type CmsLocale = (typeof CMS_LOCALES)[number];

/** All other CMS_LOCALES entries — the auto-translation targets for `en` docs. */
export const CMS_TRANSLATION_TARGET_LOCALES = CMS_LOCALES.filter(
  (locale) => locale !== CMS_DEFAULT_LOCALE
) as Exclude<CmsLocale, typeof CMS_DEFAULT_LOCALE>[];

export function isCmsLocale(value: unknown): value is CmsLocale {
  if (typeof value !== "string") return false;
  return (CMS_LOCALES as readonly string[]).includes(value.trim().toLowerCase());
}

/**
 * Normalizes a user-supplied locale string; anything outside CMS_LOCALES maps
 * to the default locale (en). Used by public reads so junk query params still
 * get served content instead of an empty list.
 */
export function resolveCmsLocale(value: unknown): CmsLocale {
  if (typeof value !== "string") return CMS_DEFAULT_LOCALE;
  const normalized = value.trim().toLowerCase();
  return isCmsLocale(normalized) ? (normalized as CmsLocale) : CMS_DEFAULT_LOCALE;
}
