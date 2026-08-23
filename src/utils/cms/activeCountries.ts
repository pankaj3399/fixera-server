export function parseCmsCountryCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

export function sanitizeCmsActiveCountries(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toUpperCase();
    if (!code || !/^[A-Z]{2}$/.test(code)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out.slice(0, 50);
}

export function isCmsContentVisibleForCountry(
  activeCountries: string[] | undefined | null,
  countryCode?: string,
): boolean {
  const countries = activeCountries || [];
  if (countries.length === 0) return true;
  if (!countryCode) return false;
  return countries.includes(countryCode);
}

/** Empty activeCountries = global; otherwise match visitor country or show global-only when unknown. */
export function cmsCountryVisibilityFilter(countryCode?: string): Record<string, unknown> {
  if (countryCode) {
    return {
      $or: [{ activeCountries: { $size: 0 } }, { activeCountries: countryCode }],
    };
  }
  return { activeCountries: { $size: 0 } };
}

export const CMS_COUNTRY_TARGETED_TYPES = new Set(["blog", "news", "faq"]);
