import { Request, Response } from "express";
import CmsContent, {
  CMS_CONTENT_TYPES,
  CmsContentType,
  FAQ_CATEGORIES,
  FAQ_CATEGORY_SLUGS,
} from "../../models/cmsContent";
import connectDB from "../../config/db";
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

function requestCountryCode(req: Request): string | undefined {
  return parseCmsCountryCode(req.get("x-vercel-ip-country") || req.get("cf-ipcountry"));
}

/**
 * Merges en fallback docs into a requested-locale list for slugs that have no
 * doc in the requested locale (so nl/fr visitors still see everything).
 */
function mergeLocaleFallback(primary: any[], fallback: any[]): any[] {
  const coveredSlugs = new Set(primary.map((doc) => doc.slug));
  return [...primary, ...fallback.filter((doc) => !coveredSlugs.has(doc.slug))];
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

    const [primary, fallback] = await Promise.all([
      CmsContent.find(buildFilter(locale))
        .select(LISTING_FIELDS)
        .populate("author", "name")
        .lean(),
      locale === CMS_DEFAULT_LOCALE
        ? Promise.resolve([])
        : CmsContent.find(buildFilter(CMS_DEFAULT_LOCALE))
            .select(LISTING_FIELDS)
            .populate("author", "name")
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
    // so hybrid lists keep stable sort + pagination semantics.
    const merged = mergeLocaleFallback(
      stripListingVisibilityMetadata(visiblePrimary),
      stripListingVisibilityMetadata(visibleFallback)
    ).sort(compareByPublishedDesc(locale));
    const total = merged.length;
    const items = merged.slice(skip, skip + limit);

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

    const presigned = await presignCmsDoc(doc);
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
    const items = stripListingVisibilityMetadata(visibleItems);
    const enItems = stripListingVisibilityMetadata(visibleEnItems);

    const merged = mergeLocaleFallback(items, enItems).sort((a, b) => {
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
