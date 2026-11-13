/**
 * Machine translation that never touches merge tags / placeholders.
 *
 * Used by site announcements and email campaigns. Everything is sent to the
 * provider as HTML (plain fields are escaped first) so protected spans can be
 * marked `translate="no"`, which Azure Translator leaves untouched. Each
 * protected value is replaced by an opaque token before sending and restored
 * afterwards; if any token or merge tag is lost or duplicated by the provider
 * the whole field fails with `placeholder_lost` instead of storing broken copy.
 *
 * Protected:
 * - merge tags `{{ ... }}` (Brevo `{{ contact.FIRSTNAME }}`, `{{firstName}}`,
 *   `{{ params.X }}`, `{{ unsubscribe }}` ...), template blocks `{% ... %}`,
 *   Mailchimp-style `*|FNAME|*`;
 * - caller supplied literals (e.g. a discount code shown in the message).
 *
 * Merge tags inside HTML attributes (href="...{{ contact.UNSUB_TOKEN }}") are
 * left in place: attribute values are not translated, and the final check
 * still verifies they survived.
 */
import { translateTexts } from "../cms/azureTranslator";

const MERGE_TAG_SOURCE = String.raw`\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\*\|[A-Za-z0-9_:]+\|\*`;

export class PlaceholderLostError extends Error {
  code = "placeholder_lost" as const;
  constructor(message = "Translation lost or altered a merge tag/placeholder") {
    super(message);
    this.name = "PlaceholderLostError";
  }
}

export interface ProtectedText {
  html: string;
  tokens: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function protectionRegex(literals: readonly string[]): RegExp {
  const cleaned = Array.from(
    new Set(literals.map((literal) => (typeof literal === "string" ? literal.trim() : "")).filter((l) => l.length >= 2))
  ).sort((a, b) => b.length - a.length);
  const parts = [MERGE_TAG_SOURCE, ...cleaned.map(escapeRegExp)];
  return new RegExp(parts.join("|"), "g");
}

/** All merge tags in a string, sorted (multiset comparison). */
export function extractMergeTags(text: string): string[] {
  return (text.match(new RegExp(MERGE_TAG_SOURCE, "g")) ?? []).slice().sort();
}

function tokenSpan(index: number): string {
  return `<span translate="no" class="notranslate">__FXMT${index}__</span>`;
}

/** Wraps protected values in HTML TEXT segments only (never inside tags). */
export function protectHtml(html: string, literals: readonly string[] = []): ProtectedText {
  const tokens: string[] = [];
  const segments = html.split(/(<[^>]*>)/);
  const out = segments.map((segment, index) => {
    // split() with a capture group puts tags at odd indices.
    if (index % 2 === 1) return segment;
    return segment.replace(protectionRegex(literals), (match) => {
      tokens.push(match);
      return tokenSpan(tokens.length - 1);
    });
  });
  return { html: out.join(""), tokens };
}

export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function decodeHtmlText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&amp;/g, "&");
}

/** Plain text → escaped HTML with protected spans. */
export function protectPlain(text: string, literals: readonly string[] = []): ProtectedText {
  // Escaping cannot create or break a merge tag ({, }, %, *, | are untouched).
  return protectHtml(escapeHtmlText(text), literals);
}

/** Restores tokens; throws PlaceholderLostError unless each token appears exactly once. */
export function restoreTokens(translated: string, tokens: readonly string[]): string {
  const seen = new Array<number>(tokens.length).fill(0);
  const replaceToken = (_match: string, rawIndex: string) => {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= tokens.length) {
      throw new PlaceholderLostError("Translation produced an unknown placeholder token");
    }
    seen[index] += 1;
    return tokens[index];
  };
  let out = translated.replace(
    /<span\b[^>]*\btranslate\s*=\s*["']?no["']?[^>]*>\s*__FXMT(\d+)__\s*<\/span>/gi,
    replaceToken
  );
  // Fallback: a provider that dropped the wrapper but kept the token.
  out = out.replace(/__FXMT(\d+)__/g, replaceToken);
  if (seen.some((count) => count !== 1)) {
    throw new PlaceholderLostError();
  }
  return out;
}

export interface ProtectedField {
  text: string;
  kind: "html" | "plain";
}

/**
 * Translates fields from one language into one target language, protecting
 * merge tags and the given literals. Empty fields come back empty.
 */
export async function translateProtectedFields(
  fields: readonly ProtectedField[],
  opts: {
    from: string;
    to: string;
    literals?: readonly string[];
    deadline?: number;
    languages?: readonly string[];
  }
): Promise<string[]> {
  const prepared = fields.map((field) =>
    field.kind === "html" ? protectHtml(field.text || "", opts.literals) : protectPlain(field.text || "", opts.literals)
  );
  const translated = await translateTexts(
    prepared.map((p) => p.html),
    { from: opts.from, to: opts.to, html: true, deadline: opts.deadline, languages: opts.languages }
  );
  return fields.map((field, index) => {
    if (!field.text || !field.text.trim()) return "";
    const restored = restoreTokens(translated[index] ?? "", prepared[index].tokens);
    const result = field.kind === "html" ? restored : decodeHtmlText(restored).trim();
    const before = extractMergeTags(field.text);
    const after = extractMergeTags(result);
    if (before.length !== after.length || before.some((tag, i) => tag !== after[i])) {
      throw new PlaceholderLostError();
    }
    return result;
  });
}
