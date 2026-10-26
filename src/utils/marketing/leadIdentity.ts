import crypto from 'crypto';

export type LeadIdentityInput = {
  emailNormalized: string;
  country: string;
  locale: string;
  serviceKeys: readonly string[];
};

/** Sorted, deduplicated canonical service keys. */
export function normalizeLeadServiceKeys(values: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    ),
  ).sort();
}

export function primaryLeadServiceKey(serviceKeys: readonly string[]): string {
  return normalizeLeadServiceKeys(serviceKeys)[0] || '';
}

export function leadIdentityHash(input: LeadIdentityInput): string {
  const payload = JSON.stringify([
    'v1',
    input.emailNormalized,
    input.country,
    input.locale,
    normalizeLeadServiceKeys(input.serviceKeys),
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Workbook/local duplicate identity. */
export function leadTupleKey(input: LeadIdentityInput): string {
  return leadIdentityHash(input);
}
