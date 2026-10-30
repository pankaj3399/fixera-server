import ServiceConfiguration from '../../models/serviceConfiguration';

export type MarketingServiceOption = {
  key: string;
  label: string;
  countries: string[];
};

export type MarketingServiceIndex = {
  byKey: Map<string, MarketingServiceOption>;
  byLabel: Map<string, MarketingServiceOption>;
};

/** Canonical service slug shared by import, filters, sync and backfill. */
export function marketingServiceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function loadMarketingServiceOptions(
  countries: string[] = [],
): Promise<MarketingServiceOption[]> {
  const normalizedCountries = countries
    .map((country) => String(country).trim().toUpperCase())
    .filter(Boolean);
  const query: Record<string, unknown> = { isActive: true };
  if (normalizedCountries.length > 0) query.activeCountries = { $in: normalizedCountries };
  const configs = await ServiceConfiguration.find(query).select('service activeCountries').lean();
  const byKey = new Map<string, MarketingServiceOption>();
  for (const config of configs) {
    const label = String(config.service || '').trim();
    if (!label) continue;
    const key = marketingServiceKey(label);
    if (!key) continue;
    const activeCountries = Array.isArray(config.activeCountries)
      ? config.activeCountries.map((country) => String(country).trim().toUpperCase()).filter(Boolean)
      : [];
    const existing = byKey.get(key);
    if (existing) {
      existing.countries = Array.from(
        new Set([...existing.countries, ...activeCountries]),
      ).sort();
    } else {
      byKey.set(key, { key, label, countries: activeCountries });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function indexMarketingServiceOptions(
  options: readonly MarketingServiceOption[],
): MarketingServiceIndex {
  const byKey = new Map<string, MarketingServiceOption>();
  const byLabel = new Map<string, MarketingServiceOption>();
  for (const option of options) {
    byKey.set(option.key, option);
    byLabel.set(option.label.trim().toLowerCase(), option);
  }
  return { byKey, byLabel };
}

export type ServiceResolution =
  | { option: MarketingServiceOption; reason?: 'unavailable' }
  | { option?: undefined; reason: 'unknown' };

/**
 * Resolve one display label or key. Country availability is checked only when
 * a country is supplied; subscriber sync can repair keys before a country is
 * known without dropping the value.
 */
export function resolveMarketingService(
  value: string,
  country: string | undefined,
  index: MarketingServiceIndex,
): ServiceResolution {
  const raw = value.trim();
  if (!raw) return { reason: 'unknown' };
  const option =
    index.byKey.get(marketingServiceKey(raw)) || index.byLabel.get(raw.toLowerCase());
  if (!option) return { reason: 'unknown' };
  if (
    country &&
    option.countries.length > 0 &&
    !option.countries.includes(country.trim().toUpperCase())
  ) {
    return { option, reason: 'unavailable' };
  }
  return { option };
}

export function splitServiceCell(value: string): string[] {
  return value
    .split(/[;,\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Import/edit cell resolution: try the whole cell first so service names that
 * contain commas stay intact, then split on semicolons, commas or newlines.
 */
export function resolveServiceCell(
  value: string,
  country: string,
  index: MarketingServiceIndex,
): { options: MarketingServiceOption[]; unknown: string[]; unavailable: string[] } {
  const raw = value.trim();
  if (!raw) return { options: [], unknown: [], unavailable: [] };

  const whole = resolveMarketingService(raw, country, index);
  if (whole.reason === 'unavailable') {
    return { options: [], unknown: [], unavailable: [raw] };
  }
  if (whole.option) {
    return { options: [whole.option], unknown: [], unavailable: [] };
  }

  const options = new Map<string, MarketingServiceOption>();
  const unknown: string[] = [];
  const unavailable: string[] = [];
  for (const part of splitServiceCell(raw)) {
    const resolved = resolveMarketingService(part, country, index);
    if (resolved.reason === 'unavailable') unavailable.push(part);
    else if (resolved.option) options.set(resolved.option.key, resolved.option);
    else unknown.push(part);
  }
  return { options: Array.from(options.values()), unknown, unavailable };
}

/**
 * Canonicalize a list of individual profile values (service labels, keys, or
 * booking-derived interests) into aligned keys and labels. Unknown values are
 * preserved in both arrays so a catalog failure or an old custom label does not
 * lose data; the next sync repairs known values.
 */
export function canonicalizeServiceValues(
  values: readonly string[],
  index: MarketingServiceIndex | undefined,
  country?: string,
): { serviceKeys: string[]; interestedServices: string[] } {
  const keyToLabel = new Map<string, string>();
  for (const value of values) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    if (index) {
      const resolved = resolveMarketingService(raw, country, index);
      if (resolved.option) {
        keyToLabel.set(resolved.option.key, resolved.option.label);
        continue;
      }
    }
    keyToLabel.set(raw, raw);
  }
  return {
    serviceKeys: Array.from(keyToLabel.keys()),
    interestedServices: Array.from(keyToLabel.values()),
  };
}
