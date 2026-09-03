/**
 * Persist CMS media as unsigned S3 URLs.
 *
 * Admin GET/upload return presigned URLs for the editor preview. If those
 * signed strings are saved back on update, string inequality looks like a
 * replacement and the original object is deleted — the cover goes blank.
 */

import { isAllowedS3Url, parseS3KeyFromUrl } from "./s3Upload";

export type CoverImageUpdate = {
  applied: boolean;
  coverImage: string | undefined;
  previousToCleanup?: string;
};

/** Strip S3 signatures so the stored URL is a stable object locator. */
export function canonicalizeCmsMediaUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (!isAllowedS3Url(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function sameCmsAsset(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (isAllowedS3Url(a) && isAllowedS3Url(b)) {
    return parseS3KeyFromUrl(a) === parseS3KeyFromUrl(b);
  }
  return canonicalizeCmsMediaUrl(a) === canonicalizeCmsMediaUrl(b);
}

function rewriteImgSrcAttributes(attrs: string, rewriteSrc: (src: string) => string): string {
  let out = "";
  let i = 0;
  while (i < attrs.length) {
    const ch = attrs[i];
    if (ch === '"' || ch === "'") {
      const end = attrs.indexOf(ch, i + 1);
      const take = end === -1 ? attrs.length : end + 1;
      out += attrs.slice(i, take);
      i = take;
      continue;
    }

    const rest = attrs.slice(i);
    const m = rest.match(/^(src)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+))/i);
    const prev = i === 0 ? " " : attrs[i - 1];
    if (m && /[\s/]/.test(prev)) {
      const raw = m[3] ?? m[4] ?? m[5] ?? "";
      const next = rewriteSrc(raw);
      const quote = m[3] !== undefined ? '"' : m[4] !== undefined ? "'" : "";
      out += `src${m[2]}${quote}${next}${quote}`;
      i += m[0].length;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** Value to persist on create. Signed upload URLs are stored unsigned. */
export function coverImageForCreate(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  return canonicalizeCmsMediaUrl(input) || undefined;
}

/**
 * Apply an update patch to coverImage.
 * Same S3 object (including a presigned echo) is not a replacement.
 */
export function applyCoverImageUpdate(
  existing: string | undefined,
  incoming: unknown
): CoverImageUpdate {
  if (typeof incoming !== "string") {
    return { applied: false, coverImage: existing };
  }

  const nextCover = canonicalizeCmsMediaUrl(incoming) || undefined;

  if (sameCmsAsset(existing, nextCover || incoming)) {
    return {
      applied: true,
      coverImage: canonicalizeCmsMediaUrl(existing || "") || nextCover,
    };
  }

  return {
    applied: true,
    coverImage: nextCover,
    previousToCleanup: existing || undefined,
  };
}

/** Rewrite standalone img src attributes in HTML to unsigned S3 URLs before persist. */
function replaceImgTags(html: string, rewriteAttrs: (attrs: string) => string): string {
  let result = "";
  let i = 0;
  const needle = "<img";
  const lower = html.toLowerCase();
  while (i < html.length) {
    const start = lower.indexOf(needle, i);
    if (start === -1) {
      result += html.slice(i);
      break;
    }
    result += html.slice(i, start);
    let j = start + needle.length;
    let quote: '"' | "'" | null = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        const attrs = html.slice(start + needle.length, j);
        result += `<img${rewriteAttrs(attrs)}>`;
        i = j + 1;
        break;
      }
      j += 1;
    }
    if (j >= html.length) {
      result += html.slice(start);
      break;
    }
  }
  return result;
}

export function canonicalizeCmsHtmlImages(html: string): string {
  if (!html || typeof html !== "string") return html;
  if (!/<img\b/i.test(html)) return html;

  return replaceImgTags(html, (attrs) =>
    rewriteImgSrcAttributes(attrs, (src) => canonicalizeCmsMediaUrl(src) || src),
  );
}
