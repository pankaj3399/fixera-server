/**
 * Read/write contract for project media (wizard images and videos).
 *
 * Uploaded project media lives in the private S3 bucket, so the stored
 * object URL returns 403 when a browser loads it directly. Every response
 * that carries project media signs eligible URLs; every save strips S3
 * signatures again so only the stable object URL is persisted.
 *
 * Signatures use a signing date aligned to fixed six-day windows, so the
 * same object yields the same URL for six days and the URL always stays valid
 * for at least one more day after it is served (seven-day expiry, the SigV4
 * maximum). A stable URL matters for cost: the frontend shows these images
 * through next/image, and every new signature is a new /_next/image cache key
 * that Vercel downloads from S3 and optimizes again.
 */

import { getPresignedUrl, isAllowedS3Url, parseS3KeyFromUrl } from "./s3Upload";

export const PROJECT_MEDIA_SIGNING_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;
/** 7 days: the longest expiry SigV4 allows. Keep it one day above the window. */
export const PROJECT_MEDIA_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

const LEGACY_MEDIA_ROOTS = new Set(["project-images", "project-videos"]);
const PROJECT_MEDIA_KINDS = new Set(["image", "video"]);

const idText = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "object") {
    const nested = (value as { _id?: unknown })._id;
    if (nested != null && nested !== value) return idText(nested);
  }
  const text = String(value);
  return text && text !== "[object Object]" ? text : null;
};

/**
 * Returns the S3 key when `url` is project media the owner uploaded, else
 * null. Only project image/video keys qualify, so a project can never be
 * used to obtain read access to ID proofs, certifications, attachments or
 * another professional's uploads.
 */
export const projectMediaKeyFor = (url: unknown, ownerId: unknown): string | null => {
  if (typeof url !== "string" || !url.trim()) return null;
  const owner = idText(ownerId);
  if (!owner) return null;
  const trimmed = url.trim();
  if (!isAllowedS3Url(trimmed)) return null;
  const key = parseS3KeyFromUrl(trimmed);
  if (!key) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return null;
  }
  // Decoding turns %2F into "/", so check every decoded segment: an empty,
  // "." or ".." segment never belongs to a key this module signs.
  const segments = decoded.split("/");
  if (segments.length < 3 || segments.some((s) => !s || s === "." || s === "..")) return null;
  const [root] = segments;
  if (root === "projects") {
    // projects/<projectId|temp>/<image|video>/<uploaderId>/<file>
    if (segments.length < 5 || !PROJECT_MEDIA_KINDS.has(segments[2])) return null;
    if (segments[3] !== owner) return null;
    return decoded;
  }
  if (LEGACY_MEDIA_ROOTS.has(root)) {
    return segments.slice(1, -1).includes(owner) ? decoded : null;
  }
  return null;
};

/** Strip S3 signature/query parameters so the stored value is a stable object URL. */
export const canonicalizeProjectMediaUrl = <T>(value: T): T => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !isAllowedS3Url(trimmed)) return value;
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString() as unknown as T;
  } catch {
    return value;
  }
};

/** Canonicalize `images`, `videos` and `video` of an incoming media payload. */
export const canonicalizeProjectMedia = <T>(media: T): T => {
  if (!media || typeof media !== "object" || Array.isArray(media)) return media;
  const next: Record<string, unknown> = { ...(media as Record<string, unknown>) };
  for (const field of ["images", "videos"] as const) {
    if (Array.isArray(next[field])) {
      next[field] = (next[field] as unknown[]).map(canonicalizeProjectMediaUrl);
    }
  }
  if ("video" in next) next.video = canonicalizeProjectMediaUrl(next.video);
  return next as T;
};

const signingDateFor = (now: Date) =>
  new Date(Math.floor(now.getTime() / PROJECT_MEDIA_SIGNING_WINDOW_MS) * PROJECT_MEDIA_SIGNING_WINDOW_MS);

/** When URLs signed at `now` stop working (always at least one day later). */
export const projectMediaSignatureExpiresAt = (now: Date = new Date()): Date =>
  new Date(signingDateFor(now).getTime() + PROJECT_MEDIA_URL_TTL_SECONDS * 1000);

/**
 * Sign one media URL for display. Ineligible values (data URLs, external
 * URLs, other owners' or non-media keys) are returned unchanged. Signing
 * failures also fall back to the stored value instead of failing the page.
 */
export const signProjectMediaUrl = async (
  url: unknown,
  ownerId: unknown,
  now: Date = new Date(),
): Promise<unknown> => {
  const key = projectMediaKeyFor(canonicalizeProjectMediaUrl(url), ownerId);
  if (!key) return url;
  try {
    return await getPresignedUrl(key, PROJECT_MEDIA_URL_TTL_SECONDS, {
      signingDate: signingDateFor(now),
    });
  } catch {
    return url;
  }
};

const plainOf = (project: any) =>
  project && typeof project.toObject === "function" ? project.toObject() : project;

/**
 * Return a plain copy of `project` whose media URLs are signed for display.
 * The owner defaults to `project.professionalId` (populated or not).
 */
export const withSignedProjectMedia = async <T = any>(
  project: T,
  options: { ownerId?: unknown; now?: Date } = {},
): Promise<T> => {
  const plain = plainOf(project);
  if (!plain || typeof plain !== "object" || !plain.media || typeof plain.media !== "object") {
    return plain;
  }
  const ownerId = options.ownerId ?? plain.professionalId;
  const now = options.now ?? new Date();
  const media: Record<string, unknown> = { ...plain.media };
  for (const field of ["images", "videos"] as const) {
    if (Array.isArray(media[field])) {
      media[field] = await Promise.all(
        (media[field] as unknown[]).map((url) => signProjectMediaUrl(url, ownerId, now)),
      );
    }
  }
  if (typeof media.video === "string") {
    media.video = await signProjectMediaUrl(media.video, ownerId, now);
  }
  return { ...plain, media } as T;
};

/**
 * Returns the S3 key when `url` is a question attachment the project owner
 * uploaded (`projects/<projectId|temp>/attachment/<ownerId>/<file>`, written
 * by uploadQuestionAttachment, or a legacy `project-attachments/` key that
 * carries the owner segment), else null. Customer answers, ID proofs and other
 * professionals' files are never signed through a project.
 */
export const projectQuestionAttachmentKeyFor = (url: unknown, ownerId: unknown): string | null => {
  if (typeof url !== "string" || !url.trim()) return null;
  const owner = idText(ownerId);
  if (!owner) return null;
  const trimmed = canonicalizeProjectMediaUrl(url.trim());
  if (!isAllowedS3Url(trimmed)) return null;
  const key = parseS3KeyFromUrl(trimmed);
  if (!key) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return null;
  }
  const segments = decoded.split("/");
  if (segments.length < 3 || segments.some((s) => !s || s === "." || s === "..")) return null;
  if (segments[0] === "projects") {
    if (segments.length < 5 || segments[2] !== "attachment" || segments[3] !== owner) return null;
    return decoded;
  }
  if (segments[0] === "project-attachments") {
    return segments.slice(1, -1).includes(owner) ? decoded : null;
  }
  return null;
};

const signQuestionAttachment = async (attachment: unknown, ownerId: unknown, now: Date): Promise<unknown> => {
  const url = typeof attachment === "string"
    ? attachment
    : attachment && typeof attachment === "object" ? (attachment as { url?: unknown }).url : null;
  const key = projectQuestionAttachmentKeyFor(url, ownerId);
  if (!key) return attachment;
  let signed: string;
  try {
    signed = await getPresignedUrl(key, PROJECT_MEDIA_URL_TTL_SECONDS, { signingDate: signingDateFor(now) });
  } catch {
    return attachment;
  }
  return typeof attachment === "string" ? signed : { ...(attachment as object), url: signed };
};

/**
 * FT1-RFQ: professional files attached to RFQ / post-booking questions live in
 * the private bucket like project media, so the stored object URL answers 403
 * when the customer opens it in the booking wizard. Sign them for display
 * (same stable six-day window as media). Only for read-only payloads: the
 * professional's editor must keep the stored object URLs.
 */
export const withSignedQuestionAttachments = async <T = any>(
  project: T,
  options: { ownerId?: unknown; now?: Date } = {},
): Promise<T> => {
  const plain = plainOf(project);
  if (!plain || typeof plain !== "object") return plain;
  const ownerId = options.ownerId ?? plain.professionalId;
  const now = options.now ?? new Date();
  const next: Record<string, unknown> = { ...plain };
  for (const field of ["rfqQuestions", "postBookingQuestions"] as const) {
    if (!Array.isArray(plain[field])) continue;
    next[field] = await Promise.all(
      (plain[field] as any[]).map(async (question) => {
        if (!question || typeof question !== "object" || !Array.isArray(question.professionalAttachments)) {
          return question;
        }
        return {
          ...question,
          professionalAttachments: await Promise.all(
            question.professionalAttachments.map((attachment: unknown) =>
              signQuestionAttachment(attachment, ownerId, now)),
          ),
        };
      }),
    );
  }
  return next as T;
};

export const withSignedProjectMediaList = async <T = any>(
  projects: T[],
  options: { now?: Date } = {},
): Promise<T[]> => {
  const now = options.now ?? new Date();
  return Promise.all(projects.map((project) => withSignedProjectMedia(project, { now })));
};
