import type { NextFunction, Request, Response } from "express";
import { resolveMessageLocale, type MessageLocale } from "./locale";
import { localizeMessage, type LocalizedMessage } from "./translate";

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const MESSAGE_FIELDS = ["msg", "message", "error"] as const;

/**
 * Localizes the message fields of an API response body:
 *   - top-level `msg`, `message`, `error` strings
 *   - `error.{msg,message}` (the `{ error: { code, message } }` envelope)
 *   - `data.{msg,message}` of `{ success, data }` envelopes
 *
 * Only envelope-shaped bodies are touched (an error status, or a body carrying
 * `success`/`msg`), and only catalogued copy is replaced, so user content in
 * other payloads can never be rewritten. The original object is not mutated.
 *
 * When a message is localized the body also carries `messageKey` (stable
 * catalog key), `messageParams` (interpolated values, if any) and, for
 * non-English locales, `messageEn` (the English copy) so clients can keep
 * matching on stable identifiers.
 */
export function localizeResponseBody(body: unknown, locale: MessageLocale, statusCode: number): unknown {
  if (!isPlainObject(body)) return body;
  const isEnvelope = statusCode >= 400 || "success" in body || "msg" in body;
  if (!isEnvelope) return body;

  let primary: { source: string; localized: LocalizedMessage } | null = null;
  const note = (source: string, localized: LocalizedMessage) => {
    if (!primary) primary = { source, localized };
  };

  const localizeFields = (target: PlainObject): PlainObject | null => {
    let copy: PlainObject | null = null;
    for (const field of MESSAGE_FIELDS) {
      const value = target[field];
      if (typeof value !== "string") continue;
      const localized = localizeMessage(value, locale);
      if (!localized) continue;
      note(value, localized);
      if (localized.text !== value) {
        copy = copy ?? { ...target };
        copy[field] = localized.text;
      }
    }
    return copy;
  };

  let result: PlainObject = localizeFields(body) ?? body;
  if (isPlainObject(body.error)) {
    const nested = localizeFields(body.error);
    if (nested) result = { ...result, error: nested };
  }
  if ("success" in body && isPlainObject(body.data)) {
    const nested = localizeFields(body.data);
    if (nested) result = { ...result, data: nested };
  }

  const found = primary as { source: string; localized: LocalizedMessage } | null;
  if (!found) return result;
  if (result === body) result = { ...body };
  result.messageKey = found.localized.key;
  if (found.localized.params && Object.keys(found.localized.params).length) {
    result.messageParams = found.localized.params;
  }
  if (locale !== "en") result.messageEn = found.source.trim();
  return result;
}

/**
 * Express middleware: resolves the request's message locale from
 * `Accept-Language` and localizes every JSON response body sent afterwards
 * (including bodies produced by the shared error handler).
 */
export function localizeApiResponses(req: Request, res: Response, next: NextFunction) {
  const locale = resolveMessageLocale(req.headers["accept-language"]);
  if (!locale) return next();
  res.vary("Accept-Language");
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    let localizedBody = body;
    try {
      localizedBody = localizeResponseBody(body, locale, res.statusCode);
    } catch {
      // Localization must never break a response; fall back to English.
      localizedBody = body;
    }
    return originalJson(localizedBody);
  }) as Response["json"];
  next();
}
