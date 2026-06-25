export interface NormaliseResult {
  normalizedUrl: string;
  domain: string;
}

/**
 * Canonicalise a URL for deduplication:
 *  - Lowercase host
 *  - Strip hash fragment
 *  - Remove trailing slash from path
 *  - Preserve query string (different queries = different pages)
 *
 * Throws a plain Error with a user-facing message on invalid input.
 */
export function normaliseSubmissionUrl(raw: string): NormaliseResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Invalid URL — please include http:// or https://');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }

  if (parsed.hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)) {
    throw new Error('localhost and IP addresses are not accepted');
  }

  if (raw.length > 2048) {
    throw new Error('URL exceeds maximum length of 2048 characters');
  }

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return {
    normalizedUrl: parsed.toString(),
    domain: parsed.hostname,
  };
}
