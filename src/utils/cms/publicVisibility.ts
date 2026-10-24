import CmsContent from "../../models/cmsContent";
import {
  CMS_COUNTRY_TARGETED_TYPES,
  isCmsContentVisibleForCountry,
} from "./activeCountries";

/**
 * Fields that decide whether a CMS document may be served publicly. For a
 * translation the source's publication/visibility controls always win: a manual
 * translation keeps its own text, but must not stay public after the source is
 * unpublished or restricted to other countries.
 */
export interface CmsVisibilityDoc {
  type?: string;
  status?: string;
  activeCountries?: string[];
  translatedFrom?: unknown;
}

export interface CmsSourceVisibilityOptions {
  /**
   * Apply visitor-country targeting. Global endpoints such as the CMS sitemap
   * pass false because they intentionally list content for every country.
   * Defaults to true.
   */
  applyCountry?: boolean;
}

/** True when the document's own country targeting hides it from this visitor. */
export function isCmsDocHiddenForCountry(
  doc: Pick<CmsVisibilityDoc, "type" | "activeCountries">,
  countryCode?: string
): boolean {
  return (
    CMS_COUNTRY_TARGETED_TYPES.has(String(doc.type || "")) &&
    !isCmsContentVisibleForCountry(doc.activeCountries, countryCode)
  );
}

function sourceIdOf(doc: CmsVisibilityDoc): string | null {
  if (!doc.translatedFrom) return null;
  return String(doc.translatedFrom);
}

/**
 * Filters documents to the ones that are safe to expose publicly, resolving
 * translation sources in one batch. A document whose `translatedFrom` source is
 * missing, unpublished, or country-ineligible is hidden even if its own status
 * and `activeCountries` still say published/global (e.g. a manual translation
 * saved before control fields were mirrored).
 *
 * Documents without `translatedFrom` are independent originals and are judged
 * by their own fields only.
 */
export async function filterCmsDocsVisibleThroughSource<T extends CmsVisibilityDoc>(
  docs: T[],
  countryCode?: string,
  options: CmsSourceVisibilityOptions = {}
): Promise<T[]> {
  if (!Array.isArray(docs) || docs.length === 0) return [];

  const applyCountry = options.applyCountry !== false;
  const sourceIds = Array.from(
    new Set(docs.map(sourceIdOf).filter((id): id is string => Boolean(id)))
  );

  const sources =
    sourceIds.length > 0
      ? ((await CmsContent.find({ _id: { $in: sourceIds } })
          .select("type status activeCountries")
          .lean()) as Array<CmsVisibilityDoc & { _id: unknown }>)
      : [];
  const sourceById = new Map(sources.map((source) => [String(source._id), source]));

  return docs.filter((doc) => {
    if (doc.status !== undefined && doc.status !== "published") return false;
    if (applyCountry && isCmsDocHiddenForCountry(doc, countryCode)) return false;

    const sourceId = sourceIdOf(doc);
    if (!sourceId) return true;

    const source = sourceById.get(sourceId);
    if (!source) return false;
    return (
      source.status === "published" &&
      (!applyCountry || !isCmsDocHiddenForCountry(source, countryCode))
    );
  });
}

/**
 * Publication-only variant for global, country-agnostic endpoints (the CMS
 * sitemap and landing view tracker). Visitor-country targeting is deliberately
 * not applied, but a linked translation must still not outlive an unpublished
 * or missing source.
 */
export async function filterCmsDocsWithPublishedSource<T extends CmsVisibilityDoc>(
  docs: T[]
): Promise<T[]> {
  return filterCmsDocsVisibleThroughSource(docs, undefined, { applyCountry: false });
}

/** Single-document variant of {@link filterCmsDocsVisibleThroughSource}. */
export async function isCmsDocPubliclyVisible(
  doc: CmsVisibilityDoc | null | undefined,
  countryCode?: string
): Promise<boolean> {
  if (!doc) return false;
  const [visible] = await filterCmsDocsVisibleThroughSource([doc], countryCode);
  return Boolean(visible);
}
