import { parseVatCountryCode } from '../vatCountries';

/**
 * Canonical marketing country. Accepts ISO codes and localized country names
 * through the same parser used by VAT and address flows, so "Belgium",
 * "België" and "BE" all become "BE" everywhere (subscribers, leads, import).
 */
export function normalizeMarketingCountry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return parseVatCountryCode(trimmed) || undefined;
}
