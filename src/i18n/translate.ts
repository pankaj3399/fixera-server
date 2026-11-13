import { en, type MessageKey } from "./messages/en";
import { nl } from "./messages/nl";
import { fr } from "./messages/fr";
import type { MessageLocale } from "./locale";

/**
 * Server-side message catalog.
 *
 * Every user-facing API message has a stable key in `messages/en.ts`; the
 * English copy written at the call site is the lookup source, so handlers keep
 * throwing/returning plain English and existing clients/tests see no change.
 * Interpolated messages are catalogued as templates (`{name}` holes) and
 * matched against the rendered text. Unknown text falls back to English.
 */
export type LocalizedMessage = {
  text: string;
  key: string;
  params?: Record<string, string>;
};

const CATALOGS: Record<MessageLocale, Record<MessageKey, string>> = { en, nl, fr };

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

type Template = {
  key: MessageKey;
  regex: RegExp;
  names: string[];
  literalLength: number;
};

const exact = new Map<string, MessageKey>();
const templates: Template[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const key of Object.keys(en) as MessageKey[]) {
  const source = en[key];
  const names = [...source.matchAll(PLACEHOLDER_RE)].map((match) => match[1]);
  if (names.length === 0) {
    if (!exact.has(source)) exact.set(source, key);
    continue;
  }
  const literals = source.split(PLACEHOLDER_RE).filter((_, index) => index % 2 === 0);
  const pattern = literals.map(escapeRegExp).join("([\\s\\S]+?)");
  templates.push({
    key,
    regex: new RegExp(`^${pattern}$`),
    names,
    literalLength: literals.join("").replace(/\s+/g, "").length,
  });
}
// Most specific template first, so "{a} must be at least {b}" never shadows a
// longer sentence that happens to share its literals.
templates.sort((a, b) => b.literalLength - a.literalLength);

/** Templates need real literal content to be matched against free text. */
const MIN_TEMPLATE_LITERAL = 6;

function fill(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] : whole,
  );
}

function lookupExact(text: string, locale: MessageLocale): LocalizedMessage | null {
  const key = exact.get(text);
  if (!key) return null;
  return { text: CATALOGS[locale][key] || en[key], key };
}

/**
 * Interpolated values are mostly numbers, ids, dates and status codes. When a
 * value is itself catalogued copy (a label such as "Subject", a weekday, or a
 * comma-separated list of catalogued items) it is translated too.
 */
function localizeParam(value: string, locale: MessageLocale): string {
  const trimmed = value.trim();
  const direct = lookupExact(trimmed, locale);
  if (direct) return direct.text;
  if (trimmed.includes(", ")) {
    const parts = trimmed.split(", ").map((part) => lookupExact(part, locale));
    if (parts.every(Boolean)) return parts.map((part) => part!.text).join(", ");
  }
  return value;
}

function lookupTemplate(text: string, locale: MessageLocale, depth: number): LocalizedMessage | null {
  for (const template of templates) {
    if (template.literalLength < MIN_TEMPLATE_LITERAL) continue;
    const match = template.regex.exec(text);
    if (!match) continue;
    const params: Record<string, string> = {};
    template.names.forEach((name, index) => {
      params[name] = match[index + 1];
    });
    const localizedParams: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) {
      // A nested sentence (e.g. "Refund failed: {message}") is localized too.
      const nested = depth < 1 ? localizeText(value, locale, depth + 1) : null;
      localizedParams[name] = nested ? nested.text : localizeParam(value, locale);
    }
    const target = CATALOGS[locale][template.key] || en[template.key];
    return { text: fill(target, localizedParams), key: template.key, params };
  }
  return null;
}

function localizeText(text: string, locale: MessageLocale, depth: number): LocalizedMessage | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  return lookupExact(trimmed, locale) ?? lookupTemplate(trimmed, locale, depth);
}

/**
 * Localizes one message. Returns null for text that is not catalogued (the
 * caller then keeps the English text). Joined Mongoose validator messages
 * ("A, B") are localized part by part.
 */
export function localizeMessage(text: string, locale: MessageLocale): LocalizedMessage | null {
  const direct = localizeText(text, locale, 0);
  if (direct) return direct;
  if (text.includes(", ")) {
    const parts = text.split(", ").map((part) => localizeText(part, locale, 0));
    if (parts.length > 1 && parts.every(Boolean)) {
      return {
        text: parts.map((part) => part!.text).join(", "),
        key: parts.map((part) => part!.key).join("+"),
      };
    }
  }
  return null;
}

/** Catalog accessors for tests and tooling. */
export const messageCatalogs = CATALOGS;
