import CmsContent from "../../models/cmsContent";
import { deleteFromS3, parseS3KeyFromUrl } from "../s3Upload";

function mediaKey(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  return parseS3KeyFromUrl(url);
}

/**
 * True when a surviving CMS document still points at this S3 object.
 *
 * Translations copy the source's `coverImage` (and mirrored `seo.ogImage`), so
 * several documents can reference the same object. Deleting the object per
 * document would break every other locale that still renders it. References
 * are compared by S3 key so a signed/unsigned variant of the same URL counts.
 */
export async function isCmsMediaKeyReferenced(key: string): Promise<boolean> {
  if (!key) return false;

  const docs = (await CmsContent.find({
    $or: [
      { coverImage: { $exists: true, $ne: null } },
      { "seo.ogImage": { $exists: true, $ne: null } },
    ],
  })
    .select("coverImage seo.ogImage")
    .lean()) as Array<{ coverImage?: string; seo?: { ogImage?: string } }>;

  return docs.some(
    (doc) => mediaKey(doc.coverImage) === key || mediaKey(doc.seo?.ogImage) === key
  );
}

/**
 * Deletes a CMS cover/OG object only when no surviving CMS document references
 * it. A shared (source + translation) object is kept so the other locales keep
 * working; deleting the last referencing document still reclaims the object.
 *
 * Returns true when the object was deleted.
 */
export async function deleteCmsMediaIfUnreferenced(url?: string | null): Promise<boolean> {
  const key = mediaKey(url);
  if (!key || !key.startsWith("cms/")) return false;
  if (await isCmsMediaKeyReferenced(key)) return false;
  await deleteFromS3(key);
  return true;
}
