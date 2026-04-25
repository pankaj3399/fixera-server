import { presignS3Url } from "./s3Upload";

const IMG_SRC_RE = /<img\b([^>]*?)(?<!-)src=(["'])([^"']+)\2([^>]*)>/gi;

const presignOrKeep = async (url?: string | null, expiresIn?: number): Promise<string | undefined> => {
  if (!url) return url ?? undefined;
  const signed = await presignS3Url(url, expiresIn);
  return signed ?? url;
};

export async function presignBodyImages(html: string, expiresIn?: number): Promise<string> {
  if (!html || typeof html !== "string") return html;
  if (!/<img\b/i.test(html)) return html;

  const matches: Array<{ full: string; before: string; quote: string; src: string; after: string }> = [];
  IMG_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_SRC_RE.exec(html)) !== null) {
    matches.push({ full: m[0], before: m[1], quote: m[2], src: m[3], after: m[4] });
  }
  if (matches.length === 0) return html;

  const signedSrcs = await Promise.all(
    matches.map((entry) => presignS3Url(entry.src, expiresIn).then((s) => s ?? entry.src))
  );

  let result = "";
  let cursor = 0;
  IMG_SRC_RE.lastIndex = 0;
  let i = 0;
  let next: RegExpExecArray | null;
  while ((next = IMG_SRC_RE.exec(html)) !== null) {
    const entry = matches[i];
    const replacementSrc = signedSrcs[i];
    result += html.slice(cursor, next.index);
    result += `<img${entry.before}src=${entry.quote}${replacementSrc}${entry.quote}${entry.after}>`;
    cursor = next.index + next[0].length;
    i += 1;
  }
  result += html.slice(cursor);
  return result;
}

export async function presignCmsDoc<T extends Record<string, any>>(doc: T, expiresIn?: number): Promise<T> {
  if (!doc || typeof doc !== "object") return doc;

  const cloned: Record<string, any> = { ...doc };

  if (typeof cloned.coverImage === "string" && cloned.coverImage) {
    cloned.coverImage = await presignOrKeep(cloned.coverImage, expiresIn);
  }

  if (cloned.seo && typeof cloned.seo === "object") {
    const seoSource = cloned.seo as Record<string, any>;
    if (typeof seoSource.ogImage === "string" && seoSource.ogImage) {
      cloned.seo = { ...seoSource, ogImage: await presignOrKeep(seoSource.ogImage, expiresIn) };
    }
  }

  if (typeof cloned.body === "string" && cloned.body) {
    cloned.body = await presignBodyImages(cloned.body, expiresIn);
  }

  return cloned as T;
}

export async function presignCmsDocs<T extends Record<string, any>>(docs: T[], expiresIn?: number): Promise<T[]> {
  if (!Array.isArray(docs) || docs.length === 0) return docs;
  return Promise.all(docs.map((doc) => presignCmsDoc(doc, expiresIn)));
}
