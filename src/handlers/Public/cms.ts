import { Request, Response } from "express";
import CmsContent, {
  CMS_CONTENT_TYPES,
  CmsContentType,
  FAQ_CATEGORIES,
  FAQ_CATEGORY_SLUGS,
} from "../../models/cmsContent";
import connectDB from "../../config/db";
import User from "../../models/user";
import { presignCmsDoc, presignCmsDocs } from "../../utils/cmsPresign";
import { toSlug } from "../../utils/slug";
import { param } from "../../utils/requestParams";
import {
  CMS_COUNTRY_TARGETED_TYPES,
  cmsCountryVisibilityFilter,
  parseCmsCountryCode,
} from "../../utils/cms/activeCountries";
import { CMS_DEFAULT_LOCALE, resolveCmsLocale } from "../../utils/cms/locales";
import {
  filterCmsDocsVisibleThroughSource,
  filterCmsDocsWithPublishedSource,
  isCmsDocPubliclyVisible,
} from "../../utils/cms/publicVisibility";
import { resolveLocalizedRelatedContent } from "../../utils/cms/relatedContent";

const LISTING_FIELDS =
  "type title slug locale excerpt coverImage coverImageAlt tags publishedAt seo category author authorOverride relatedServiceSlug updatedAt translatedFrom";

const BOT_UA_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegram|prerender|headlesschrome|lighthouse/i;

/**
 * First-party content-country header set by the frontend middleware: the
 * effective auto-conversion country (visitor geo inside the roll-out, else the
 * admin default country). The frontend deletes any client-supplied value first.
 */
export const CMS_CONTENT_COUNTRY_HEADER = "x-fixera-content-country";

/**
 * Country used to choose which country-targeted CMS content is shown.
 * Display filtering only, not authorization: any caller can already pick a
 * country through these headers, and every country sees global content.
 * Precedence: x-fixera-content-country, then the platform geo headers
 * (x-vercel-ip-country, cf-ipcountry). Each must be a valid ISO 3166-1 alpha-2
 * code; an invalid value falls through to the next header. The first-party
 * header comes first because the backend's own edge may replace an inbound
 * x-vercel-ip-country with the calling frontend function's geo.
 */
export function requestCountryCode(req: Pick<Request, "get">): string | undefined {
  return (
    parseCmsCountryCode(req.get(CMS_CONTENT_COUNTRY_HEADER)) ??
    parseCmsCountryCode(req.get("x-vercel-ip-country")) ??
    parseCmsCountryCode(req.get("cf-ipcountry"))
  );
}

/**
 * Merges en fallback docs into a requested-locale list for slugs that have no
 * doc in the requested locale (so nl/fr visitors still see everything).
 */
function mergeLocaleFallback(primary: any[], fallback: any[]): any[] {
  const coveredSlugs = new Set(primary.map((doc) => doc.slug));
  // A manual translation may carry a different slug than its source; treat a
  // fallback doc as covered when it is the English origin of a primary doc.
  const coveredSources = new Set(
    primary.filter((doc) => doc.translatedFrom).map((doc) => String(doc.translatedFrom))
  );
  return [
    ...primary,
    ...fallback.filter(
      (doc) => !coveredSlugs.has(doc.slug) && !coveredSources.has(String(doc._id))
    ),
  ];
}

/**
 * Batch-resolves author display names for a page slice. Listing queries
 * intentionally skip populate() so per-request DB work stays bounded (two
 * light queries + one small author lookup); this restores the same
 * `{ _id, name }` shape populate() produced, but only for the returned page.
 */
async function attachListingAuthorNames(items: any[]): Promise<void> {
  const ids = [
    ...new Set(
      items
        .map((doc) => doc?.author)
        .filter(
          (author) => author != null && (typeof author !== "object" || !(author as any).name)
        )
        .map((author) => String((author as any)?._id ?? author))
    ),
  ];
  if (ids.length === 0) return;
  const users = await User.find({ _id: { $in: ids } })
    .select("name")
    .lean();
  const names = new Map(
    (users as Array<{ _id: unknown; name?: string }>).map((user) => [String(user._id), user.name])
  );
  for (const doc of items) {
    if (doc?.author == null) continue;
    const key = String(doc.author?._id ?? doc.author);
    if (names.has(key)) doc.author = { _id: doc.author, name: names.get(key) };
  }
}

/** Sorts merged listings by publishedAt desc; ties put the requested locale first. */
function compareByPublishedDesc(locale: string): (a: any, b: any) => number {
  return (a, b) => {
    const aTime = a?.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b?.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    if (a.locale === locale && b.locale !== locale) return -1;
    if (b.locale === locale && a.locale !== locale) return 1;
    return 0;
  };
}

/**
 * Internal translation bookkeeping never served publicly. `autoTranslated`
 * stays (the site may show a "machine translated" note).
 */
const INTERNAL_TRANSLATION_FIELDS = ["sourceHash", "translationRun", "translationResults"] as const;

function stripInternalTranslationFields<T extends Record<string, any>>(doc: T): T {
  const copy = { ...doc };
  for (const field of INTERNAL_TRANSLATION_FIELDS) delete copy[field];
  return copy;
}

/** Removes internal translation metadata added only to evaluate visibility. */
function stripListingVisibilityMetadata<T extends Record<string, any>>(docs: T[]): T[] {
  return docs.map((doc) => {
    const copy = { ...doc };
    delete copy.translatedFrom;
    return copy;
  });
}

export const listPublicCmsContent = async (req: Request, res: Response) => {
  try {
    const type = param(req.params.type) as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(404).json({ success: false, msg: "Unknown content type" });
    }

    const rawPage = Number((req.query.page as string) ?? "1");
    const page = Math.max(1, Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1);
    const rawLimit = Number((req.query.limit as string) ?? "12");
    const limit = Math.min(
      50,
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 12)
    );
    const skip = (page - 1) * limit;

    const locale = resolveCmsLocale(req.query.locale);
    const countryCode = requestCountryCode(req);

    const tag = typeof req.query.tag === "string" ? req.query.tag.toLowerCase() : "";
    const serviceSlug =
      typeof req.query.serviceSlug === "string" ? toSlug(req.query.serviceSlug) : "";

    await connectDB();

    const baseFilter = CMS_COUNTRY_TARGETED_TYPES.has(type)
      ? cmsCountryVisibilityFilter(countryCode)
      : {};
    const buildFilter = (docLocale: string): Record<string, unknown> => ({
      type,
      status: "published",
      locale: docLocale,
      ...baseFilter,
      ...(tag ? { tags: tag } : {}),
      ...(serviceSlug && (type === "blog" || type === "news") ? { relatedServiceSlug: serviceSlug } : {}),
    });

    // Bulk fetch without populate: author names are resolved below for the
    // page slice only, so per-request DB work stays bounded (two light
    // queries + one small author lookup) instead of populating every
    // matching document. Merge/sort/pagination keep exact in-memory
    // semantics because hybrid locale lists cannot page correctly from a
    // single DB query (fallbacks fill gaps left by the requested locale).
    const [primary, fallback] = await Promise.all([
      CmsContent.find(buildFilter(locale))
        .select(LISTING_FIELDS)
        .lean(),
      locale === CMS_DEFAULT_LOCALE
        ? Promise.resolve([])
        : CmsContent.find(buildFilter(CMS_DEFAULT_LOCALE))
            .select(LISTING_FIELDS)
            .lean(),
    ]);

    // A translation may only be listed while its source is still public
    // (legacy/manual rows can predate control-field mirroring). Filter before
    // merging so a hidden translation does not suppress the en fallback.
    const [visiblePrimary, visibleFallback] = await Promise.all([
      filterCmsDocsVisibleThroughSource(primary as any[], countryCode),
      filterCmsDocsVisibleThroughSource(fallback as any[], countryCode),
    ]);

    // Merge requested-locale docs with en fallbacks, then paginate in memory
    // so hybrid lists keep stable sort + pagination semantics. Merge before
    // stripping: translatedFrom is needed to suppress a source whose slug
    // differs from its manual translation.
    const merged = stripListingVisibilityMetadata(
      mergeLocaleFallback(visiblePrimary, visibleFallback)
    ).sort(compareByPublishedDesc(locale));
    const total = merged.length;
    const items = merged.slice(skip, skip + limit);

    // Resolve author names for the page slice only (bounded $in query).
    await attachListingAuthorNames(items);

    const presigned = await presignCmsDocs(items);

    return res.status(200).json({
      success: true,
      data: {
        items: presigned,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("Public list CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load content" });
  }
};

export const getPublicCmsContentBySlug = async (req: Request, res: Response) => {
  try {
    const type = param(req.params.type) as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(404).json({ success: false, msg: "Unknown content type" });
    }

    const slug = param(req.params.slug).toLowerCase();
    if (!slug) return res.status(404).json({ success: false, msg: "Not found" });

    const locale = resolveCmsLocale(req.query.locale);
    const countryCode = requestCountryCode(req);

    await connectDB();

    const populateOptions = [
      { path: "author", select: "name" },
      { path: "relatedServices", select: "name slug" },
    ] as const;

    const lookup = async (docLocale: string, { requireVisible = true } = {}) => {
      const candidateDoc = await CmsContent.findOne({
        type,
        slug,
        locale: docLocale,
        status: "published",
      })
        .populate(populateOptions as any)
        .lean();
      if (!candidateDoc) return null;
      if (
        requireVisible &&
        !(await isCmsDocPubliclyVisible(candidateDoc as any, countryCode))
      ) {
        return null;
      }
      return candidateDoc;
    };

    // Requested locale first; fall back to the en source doc when missing
    // (the response includes the doc's actual locale so the frontend knows it
    // served a fallback).
    const doc = (await lookup(locale)) ?? (locale === CMS_DEFAULT_LOCALE ? null : await lookup(CMS_DEFAULT_LOCALE));

    if (!doc) return res.status(404).json({ success: false, msg: "Not found" });

    const ua = req.get("user-agent") || "";
    if (!BOT_UA_RE.test(ua)) {
      CmsContent.updateOne({ _id: doc._id }, { $inc: { viewCount: 1 } }).catch((err) =>
        console.error("CMS viewCount increment failed:", err)
      );
    }

    // Related ids are copied from the source, so resolve them to the requested
    // locale (with en fallback) and drop anything not publicly eligible.
    (doc as Record<string, any>).relatedContent = await resolveLocalizedRelatedContent(
      (doc as Record<string, any>).relatedContent,
      locale,
      countryCode
    );

    const presigned = await presignCmsDoc(stripInternalTranslationFields(doc as Record<string, any>));
    return res.status(200).json({ success: true, data: presigned });
  } catch (error) {
    console.error("Public get CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load content" });
  }
};

export const listPublicPolicyLinks = async (req: Request, res: Response) => {
  try {
    const locale = resolveCmsLocale(req.query.locale);

    await connectDB();

    const [rawItems, rawEnItems] = await Promise.all([
      CmsContent.find({ type: "policy", status: "published", locale })
        .select("title slug locale updatedAt publishedAt translatedFrom")
        .sort({ title: 1 })
        .lean(),
      locale === CMS_DEFAULT_LOCALE
        ? Promise.resolve([])
        : CmsContent.find({ type: "policy", status: "published", locale: CMS_DEFAULT_LOCALE })
            .select("title slug locale updatedAt publishedAt translatedFrom")
            .sort({ title: 1 })
            .lean(),
    ]);

    // Hide translations whose source was unpublished/removed; filter before
    // merging so the en fallback still covers slugs the hidden row blocked.
    const [items, enItems] = await Promise.all([
      filterCmsDocsVisibleThroughSource(rawItems as any[]),
      filterCmsDocsVisibleThroughSource(rawEnItems as any[]),
    ]);

    // Stubs without a published translation in the requested locale still
    // show up, sourced from en.
    const merged = mergeLocaleFallback(items, enItems);

    const RESERVED: Record<string, string> = { "privacy-policy": "/privacy-policy" };
    const payload = merged
      .sort((a, b) => a.title.localeCompare(b.title, locale))
      .map((i) => ({
        title: i.title,
        slug: i.slug,
        locale: i.locale,
        path: RESERVED[i.slug] || `/pages/${i.slug}`,
      }));

    return res.status(200).json({ success: true, data: { items: payload } });
  } catch (error) {
    console.error("Public policy-links error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load policy links" });
  }
};

export const listPublicFaq = async (req: Request, res: Response) => {
  try {
    const locale = resolveCmsLocale(req.query.locale);
    const countryCode = requestCountryCode(req);

    await connectDB();

    const faqFilter = cmsCountryVisibilityFilter(countryCode);

    const [rawItems, rawEnItems] = await Promise.all([
      CmsContent.find({
        type: "faq",
        status: "published",
        locale,
        ...faqFilter,
      })
        .select("title slug locale body category publishedAt updatedAt translatedFrom")
        .sort({ category: 1, publishedAt: -1 })
        .lean(),
      locale === CMS_DEFAULT_LOCALE
        ? Promise.resolve([])
        : CmsContent.find({
            type: "faq",
            status: "published",
            locale: CMS_DEFAULT_LOCALE,
            ...faqFilter,
          })
            .select("title slug locale body category publishedAt updatedAt translatedFrom")
            .sort({ category: 1, publishedAt: -1 })
            .lean(),
    ]);

    // Filter before merging so a hidden translation does not suppress the en
    // fallback for the same slug.
    const [visibleItems, visibleEnItems] = await Promise.all([
      filterCmsDocsVisibleThroughSource(rawItems as any[], countryCode),
      filterCmsDocsVisibleThroughSource(rawEnItems as any[], countryCode),
    ]);
    const items = visibleItems;
    const enItems = visibleEnItems;

    // Merge before stripping: translatedFrom is needed to suppress a source
    // whose slug differs from its manual translation.
    const merged = stripListingVisibilityMetadata(
      mergeLocaleFallback(items, enItems)
    ).sort((a, b) => {
      const byCategory = String(a.category ?? "").localeCompare(String(b.category ?? ""));
      if (byCategory !== 0) return byCategory;
      return compareByPublishedDesc(locale)(a, b);
    });

    const byCategory: Record<string, any[]> = {};
    for (const slug of FAQ_CATEGORY_SLUGS) byCategory[slug] = [];
    for (const item of merged) {
      const cat = item.category && FAQ_CATEGORY_SLUGS.includes(item.category) ? item.category : "general";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    }

    const groups = FAQ_CATEGORIES.map((c) => ({
      slug: c.slug,
      name: c.name,
      items: byCategory[c.slug] || [],
    })).filter((g) => g.items.length > 0);

    return res.status(200).json({ success: true, data: { groups, categories: FAQ_CATEGORIES } });
  } catch (error) {
    console.error("Public FAQ error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load FAQ" });
  }
};

const SITEMAP_MAX_LIMIT = 50000;
const SITEMAP_DEFAULT_LIMIT = 1000;

export const listCmsSitemapEntries = async (req: Request, res: Response) => {
  try {
    await connectDB();

    const rawLimit = Number((req.query.limit as string) ?? String(SITEMAP_DEFAULT_LIMIT));
    const limit = Math.min(
      SITEMAP_MAX_LIMIT,
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : SITEMAP_DEFAULT_LIMIT)
    );
    const rawPage = Number((req.query.page as string) ?? "1");
    const page = Math.max(1, Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1);
    const skip = (page - 1) * limit;

    const filter = { status: "published" };

    const [rawItems, total] = await Promise.all([
      CmsContent.find(filter)
        .select("type slug locale updatedAt publishedAt translatedFrom")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CmsContent.countDocuments(filter),
    ]);

    // The sitemap is global and deliberately country-agnostic, so country
    // targeting must not hide valid entries. A linked translation must still
    // not be advertised after its source was unpublished or removed: the URL
    // would 404 on the public detail endpoint and only leak a stale path.
    const items = stripListingVisibilityMetadata(
      await filterCmsDocsWithPublishedSource(rawItems as any[])
    );

    if (rawItems.length >= SITEMAP_MAX_LIMIT) {
      console.warn(
        `CMS sitemap response truncated at SITEMAP_MAX_LIMIT=${SITEMAP_MAX_LIMIT}; clients must paginate`
      );
    }

    const hasMore = skip + rawItems.length < total;
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, totalPages, hasMore },
      },
    });
  } catch (error) {
    console.error("CMS sitemap entries error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load sitemap entries" });
  }
};
