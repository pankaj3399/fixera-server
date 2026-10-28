/**
 * Thin Azure AI Translator client built on global fetch (Node 18+/Vercel).
 *
 * This is the ONLY file that knows which translation provider we use: the rest
 * of the CMS code talks to `translateTexts` / `isTranslatorConfigured`, so
 * swapping providers means replacing this file.
 *
 * Env:
 * - AZURE_TRANSLATOR_KEY      required; unset disables CMS auto-translation.
 * - AZURE_TRANSLATOR_REGION   optional; sent as Ocp-Apim-Subscription-Region
 *                             only when set and not "global".
 * - AZURE_TRANSLATOR_ENDPOINT optional; defaults to the public Azure endpoint.
 *
 * Service limits (see Azure docs):
 * - 50,000 characters per request (all target languages, one per request).
 * - 1,000 array elements per request.
 * - 50,000 characters per element.
 *
 * We keep ONE target language per request and pack elements up to
 * MAX_CHARS_PER_REQUEST. Oversized HTML is split at top-level block boundaries
 * and re-joined in order; the client never splits inside a tag.
 *
 * The API key is never logged and never included in error messages.
 */

import { CMS_LOCALES, isCmsLocale } from "./locales";

const DEFAULT_ENDPOINT = "https://api.cognitive.microsofttranslator.com";
const REQUEST_TIMEOUT_MS = 25_000;

/** Azure's hard limit is 50k chars/request; keep a 5k safety margin. */
export const MAX_CHARS_PER_REQUEST = 45_000;
export const MAX_ELEMENTS_PER_REQUEST = 1_000;

/**
 * Closing tags that mark a safe place to split a TipTap HTML body.
 * Splitting after these keeps every chunk's tags balanced in practice.
 */
const BLOCK_BOUNDARY_SOURCE = "</(?:p|h[1-6]|ul|ol|table|blockquote|pre|figure)>";

export class TranslatorError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TranslatorError";
    this.status = status;
  }
}

export class TranslatorNotConfiguredError extends TranslatorError {
  constructor() {
    super("AZURE_TRANSLATOR_KEY is not configured");
    this.name = "TranslatorNotConfiguredError";
  }
}

export function isTranslatorConfigured(): boolean {
  return Boolean((process.env.AZURE_TRANSLATOR_KEY || "").trim());
}

export function translatorEndpoint(): string {
  const raw = (process.env.AZURE_TRANSLATOR_ENDPOINT || "").trim();
  return (raw || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

/** Region header value; undefined when unset or the global endpoint region. */
export function translatorRegion(): string | undefined {
  const region = (process.env.AZURE_TRANSLATOR_REGION || "").trim();
  if (!region || region.toLowerCase() === "global") return undefined;
  return region;
}

/**
 * Azure language codes. For our supported locales the Azure code is the same
 * two-letter code, validated against the single source of truth.
 */
function normalizeLanguage(value: string, field: "from" | "to"): string {
  if (!isCmsLocale(value)) {
    throw new TranslatorError(
      `Unsupported translation language "${value}" for ${field} (supported: ${CMS_LOCALES.join(", ")})`
    );
  }
  return value.trim().toLowerCase();
}

/**
 * Splits HTML at top-level block boundaries into chunks of at most maxChars.
 * Never cuts inside a tag. The returned chunks concatenate back to the input.
 */
export function splitHtmlIntoChunks(
  html: string,
  maxChars: number = MAX_CHARS_PER_REQUEST
): string[] {
  if (!html) return [""];
  if (html.length <= maxChars) return [html];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const block of topLevelBlocks(html)) {
    if (block.length > maxChars) {
      flush();
      for (const piece of splitTagSafe(block, maxChars)) chunks.push(piece);
      continue;
    }
    if (current.length + block.length > maxChars) flush();
    current += block;
  }
  flush();

  return chunks.length ? chunks : [html];
}

/**
 * Splits one top-level block that alone exceeds the limit. Prefers the last
 * closing tag, then the last whitespace, and only falls back to a hard cut if
 * the block has neither (never expected for real HTML).
 */
function splitTagSafe(block: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = block;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(">", maxChars - 1);
    if (cut <= 0) cut = rest.lastIndexOf(" ", maxChars - 1);
    if (cut <= 0) cut = maxChars - 1;
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Splits plain text at the last whitespace inside the limit; join restores it. */
function splitPlainText(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = Math.max(rest.lastIndexOf(" ", maxChars - 1), rest.lastIndexOf("\n", maxChars - 1));
    if (cut <= 0) cut = maxChars - 1;
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Groups the HTML into top-level blocks, each ending after a closing block tag. */
function topLevelBlocks(html: string): string[] {
  // Fresh RegExp per call: no shared mutable lastIndex state between calls.
  const boundaryRe = new RegExp(BLOCK_BOUNDARY_SOURCE, "gi");
  const blocks: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = boundaryRe.exec(html)) !== null) {
    const end = match.index + match[0].length;
    blocks.push(html.slice(cursor, end));
    cursor = end;
  }
  if (cursor < html.length) blocks.push(html.slice(cursor));
  return blocks.filter((block) => block.length > 0);
}

interface TranslationUnit {
  /** Index in the caller's `texts` array. */
  index: number;
  /** Chunks sent as separate elements and re-joined in order. */
  parts: string[];
}

/** Greedily packs parts into requests respecting the per-request limits. */
function packRequests(units: TranslationUnit[]): Array<Array<{ unit: number; part: number }>> {
  const requests: Array<Array<{ unit: number; part: number }>> = [];
  let batch: Array<{ unit: number; part: number }> = [];
  let batchChars = 0;

  units.forEach((unit, unitIndex) => {
    unit.parts.forEach((part, partIndex) => {
      const size = part.length;
      if (
        batch.length > 0 &&
        (batch.length >= MAX_ELEMENTS_PER_REQUEST || batchChars + size > MAX_CHARS_PER_REQUEST)
      ) {
        requests.push(batch);
        batch = [];
        batchChars = 0;
      }
      batch.push({ unit: unitIndex, part: partIndex });
      batchChars += size;
    });
  });

  if (batch.length > 0) requests.push(batch);
  return requests;
}

interface AzureTranslationResult {
  translations?: Array<{ text?: string; to?: string }>;
}

interface AzureErrorBody {
  error?: { code?: number | string; message?: string };
}

/** One Azure request for one target language. Returns texts in input order. */
async function requestTranslations(
  texts: string[],
  from: string,
  to: string,
  html: boolean
): Promise<string[]> {
  const key = (process.env.AZURE_TRANSLATOR_KEY || "").trim();
  if (!key) throw new TranslatorNotConfiguredError();

  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  if (texts.length > MAX_ELEMENTS_PER_REQUEST) {
    throw new TranslatorError(
      `Azure Translator request has ${texts.length} elements (max ${MAX_ELEMENTS_PER_REQUEST})`
    );
  }
  if (totalChars > MAX_CHARS_PER_REQUEST) {
    throw new TranslatorError(
      `Azure Translator request has ${totalChars} characters (max ${MAX_CHARS_PER_REQUEST})`
    );
  }

  const query = new URLSearchParams({
    "api-version": "3.0",
    from,
    to,
    textType: html ? "html" : "plain",
  });

  const headers: Record<string, string> = {
    "Ocp-Apim-Subscription-Key": key,
    "Content-Type": "application/json",
  };
  const region = translatorRegion();
  if (region) headers["Ocp-Apim-Subscription-Region"] = region;

  let response: Response;
  try {
    response = await fetch(`${translatorEndpoint()}/translate?${query.toString()}`, {
      method: "POST",
      headers,
      body: JSON.stringify(texts.map((text) => ({ Text: text }))),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    // Timeout / abort / DNS — never include the key in the message.
    const reason = err?.name === "TimeoutError" ? "timeout" : err?.message ?? "network error";
    throw new TranslatorError(`Azure Translator request failed: ${reason}`);
  }

  const rawBody = await response.text().catch(() => "");
  let parsed: unknown;
  if (rawBody) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const errorBody = parsed as AzureErrorBody | undefined;
    const code = errorBody?.error?.code;
    const message = errorBody?.error?.message;
    const detail =
      code !== undefined || message !== undefined
        ? ` - ${[code, message].filter((v) => v !== undefined && v !== "").join(": ")}`
        : rawBody
          ? ` - ${rawBody.slice(0, 300)}`
          : "";
    throw new TranslatorError(
      `Azure Translator request failed with HTTP status ${response.status}${detail}`,
      response.status
    );
  }

  const results = parsed as AzureTranslationResult[] | undefined;
  if (!Array.isArray(results) || results.length !== texts.length) {
    throw new TranslatorError(
      `Azure Translator returned ${Array.isArray(results) ? results.length : 0} results for ${texts.length} input text(s)`
    );
  }

  return results.map((result) => {
    const translated = result?.translations?.[0]?.text;
    if (typeof translated !== "string") {
      throw new TranslatorError("Azure Translator returned a result without translated text");
    }
    return translated;
  });
}

/**
 * Translates a list of texts, mapping results back by index.
 *
 * - Empty / whitespace-only inputs are skipped and returned as "".
 * - Plain fields are batched into as few requests as the limits allow.
 * - HTML bodies that exceed the request cap are split at block boundaries,
 *   translated in order, and re-joined.
 * - One target language per request (`from`/`to` must be en, nl or fr).
 */
export async function translateTexts(
  texts: string[],
  opts: { from: string; to: string; html: boolean }
): Promise<string[]> {
  const from = normalizeLanguage(opts.from, "from");
  const to = normalizeLanguage(opts.to, "to");

  if (!isTranslatorConfigured()) throw new TranslatorNotConfiguredError();

  const output = texts.map(() => "");
  const units: TranslationUnit[] = [];

  texts.forEach((text, index) => {
    if (typeof text !== "string" || !text.trim()) return;
    const parts =
      text.length > MAX_CHARS_PER_REQUEST
        ? opts.html
          ? splitHtmlIntoChunks(text)
          : splitPlainText(text, MAX_CHARS_PER_REQUEST)
        : [text];
    units.push({ index, parts });
  });

  if (units.length === 0) return output;

  const translatedParts: string[][] = units.map((unit) => unit.parts.map(() => ""));

  for (const batch of packRequests(units)) {
    const batchTexts = batch.map(({ unit, part }) => units[unit].parts[part]);
    const translated = await requestTranslations(batchTexts, from, to, opts.html);
    batch.forEach(({ unit, part }, i) => {
      translatedParts[unit][part] = translated[i] ?? "";
    });
  }

  units.forEach((unit, unitIndex) => {
    output[unit.index] = translatedParts[unitIndex].join("");
  });

  return output;
}
