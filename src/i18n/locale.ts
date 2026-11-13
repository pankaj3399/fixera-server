/**
 * Locale of user-facing API messages.
 *
 * The web app sends its active UI language as `Accept-Language` (en, nl or
 * fr) on every request to this API; browsers send the visitor's language
 * preferences otherwise. Requests without a supported language (scripts,
 * webhooks, tests) keep the English copy unchanged.
 */
export const MESSAGE_LOCALES = ["en", "nl", "fr"] as const;
export type MessageLocale = (typeof MESSAGE_LOCALES)[number];

function isMessageLocale(value: string): value is MessageLocale {
  return (MESSAGE_LOCALES as readonly string[]).includes(value);
}

/**
 * First supported language in `Accept-Language` preference order, or null
 * when the header is absent or names no supported language.
 */
export function resolveMessageLocale(header: unknown): MessageLocale | null {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 512) return null;
  const ranked = raw
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      let q = 1;
      for (const param of params) {
        const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
        if (match) q = Number(match[1]);
      }
      return { base: tag.trim().toLowerCase().split("-")[0], q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.base && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of ranked) {
    if (isMessageLocale(entry.base)) return entry.base;
  }
  return null;
}
