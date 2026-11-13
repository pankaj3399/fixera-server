import { Request, Response, NextFunction } from "express";

import mongoose from "mongoose";
import CmsContent, {
  CMS_CONTENT_TYPES,
  CMS_CONTENT_STATUSES,
  CmsContentType,
  CmsContentStatus,
  FAQ_CATEGORIES,
  FAQ_CATEGORY_SLUGS,
} from "../../models/cmsContent";
import ServiceConfiguration from "../../models/serviceConfiguration";
import connecToDatabase from "../../config/db";
import { IUser } from "../../models/user";
import {
  uploadToS3,
  generateFileName,
  validateImageFileBuffer,
  presignS3Url,
} from "../../utils/s3Upload";
import { presignCmsDoc, presignCmsDocs } from "../../utils/cmsPresign";
import { toSlug } from "../../utils/slug";
import { param, params } from "../../utils/requestParams";
import {
  applyCoverImageAltUpdate,
  coverImageAltForCreate,
} from "../../utils/cmsCoverImageAlt";
import {
  applyCoverImageUpdate,
  canonicalizeCmsHtmlImages,
  canonicalizeCmsMediaUrl,
  coverImageForCreate,
} from "../../utils/cmsCoverImage";
import { sanitizeCmsActiveCountries } from "../../utils/cms/activeCountries";
import { deleteCmsMediaIfUnreferenced } from "../../utils/cms/coverImageCleanup";
import {
  CMS_LOCALES,
  isCmsLocale,
} from "../../utils/cms/locales";
import {
  deleteAutoTranslatedSiblings,
  failedResult,
  isTranslationSource,
  mergeTranslationResults,
  moveAutoTranslatedSiblings,
  syncCmsTranslations,
  targetLocalesFor,
  TranslationResult,
} from "../../utils/cms/syncTranslations";
import { requestCmsTranslationRun } from "../../utils/cms/translationQueue";
import { loadCmsTranslationStatus, tryLoadCmsTranslationStatus } from "../../utils/cms/translationStatus";

const isValidObjectId = (id: string): boolean => mongoose.Types.ObjectId.isValid(id);

/**
 * Request-time translation step for a saved source doc. Never calls the
 * provider: it mirrors control/non-text fields onto existing translations
 * right away (`translate: false`) and, when any locale needs new text, queues
 * a background run (see utils/cms/translationQueue) that translates after the
 * response. A translation failure never fails or rolls back the admin's save.
 */
async function runTranslationSync(
  doc: Record<string, any>,
  options: { forceLocales?: string[] } = {}
): Promise<TranslationResult[]> {
  let results: TranslationResult[];
  try {
    results = await syncCmsTranslations(doc, {
      translate: false,
      forceLocales: options.forceLocales,
    });
  } catch (err) {
    console.error("CMS translation sync crashed (save kept, continuing):", err);
    return [failedResult("*", "internal", "Translation sync crashed")];
  }

  if (results.some((result) => result.status === "pending")) {
    try {
      await requestCmsTranslationRun(doc._id, { forceLocales: options.forceLocales });
    } catch (err) {
      console.error("Queueing the CMS translation run failed (save kept):", err);
      return results.map((result) =>
        result.status === "pending" ? failedResult(result.locale, "internal") : result
      );
    }
  }
  return results;
}

const sanitizeStringArray = (input: unknown, max = 20): string[] => {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        .filter((v) => v.length > 0 && v.length <= 60)
    )
  ).slice(0, max);
};

const sanitizeObjectIdArray = (input: unknown, max = 20): mongoose.Types.ObjectId[] => {
  if (!Array.isArray(input)) return [];
  const out: mongoose.Types.ObjectId[] = [];
  for (const v of input) {
    if (typeof v === "string" && isValidObjectId(v)) {
      out.push(new mongoose.Types.ObjectId(v));
    }
    if (out.length >= max) break;
  }
  return out;
};

const pickSeo = (input: any) => {
  if (!input || typeof input !== "object") return {};
  const seo: Record<string, unknown> = {};
  if (typeof input.titleTag === "string") seo.titleTag = input.titleTag.trim().slice(0, 120);
  if (typeof input.metaDescription === "string")
    seo.metaDescription = input.metaDescription.trim().slice(0, 300);
  if (typeof input.ogTitle === "string") seo.ogTitle = input.ogTitle.trim().slice(0, 120);
  if (typeof input.ogImage === "string") seo.ogImage = canonicalizeCmsMediaUrl(input.ogImage);
  if (typeof input.canonical === "string") seo.canonical = input.canonical.trim();
  if (typeof input.noindex === "boolean") seo.noindex = input.noindex;
  return seo;
};

/** Best-effort populate after a successful write — never fail the request if this read fails. */
async function loadCmsDocForResponse(
  id: mongoose.Types.ObjectId | string,
  fallback: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const populated = await CmsContent.findById(id)
      .populate("author", "name email")
      .populate("relatedContent", "title slug type")
      .populate("relatedServices", "name slug")
      .lean();
    return (populated as Record<string, any> | null) || fallback;
  } catch (err) {
    console.error("CMS response populate failed; returning unpopulated doc:", err);
    return fallback;
  }
}

/** One other-locale document of a translation family, as the admin UI links it. */
export interface CmsLocaleVariantSummary {
  _id: string;
  locale: string;
  slug: string;
  title: string;
  status: string;
  autoTranslated: boolean;
  translatedFrom?: string;
  updatedAt?: Date;
}

const refIdOf = (value: unknown): string | undefined => {
  if (!value) return undefined;
  if (typeof value === "object" && value !== null && "_id" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)._id);
  }
  return String(value);
};

/**
 * The other-locale documents of `doc`'s translation family, found by the
 * actual `translatedFrom` link (not by slug), so a manual translation saved
 * under its own slug stays discoverable. The family is the origin
 * (`translatedFrom ?? _id`) plus every same-type doc translated from it.
 * Never includes `doc` itself or another doc in `doc`'s own locale; one entry
 * per locale, the origin first, then the most recently updated.
 *
 * Best-effort: on a read failure the field is omitted and the admin UI falls
 * back to its slug search, so the save/read itself never fails because of it.
 */
export async function loadCmsLocaleVariants(
  doc: Record<string, any>
): Promise<CmsLocaleVariantSummary[] | undefined> {
  try {
    const selfId = refIdOf(doc._id);
    const originId = refIdOf(doc.translatedFrom) ?? selfId;
    if (!selfId || !originId || !isValidObjectId(originId)) return undefined;
    const rows = (await CmsContent.find({
      type: doc.type,
      _id: { $ne: selfId },
      $or: [{ _id: originId }, { translatedFrom: originId }],
    })
      .select("locale slug title status autoTranslated translatedFrom updatedAt")
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean()) as Array<Record<string, any>>;

    const selfLocale = String(doc.locale || "");
    const byLocale = new Map<string, CmsLocaleVariantSummary>();
    const ordered = [
      ...rows.filter((row) => String(row._id) === originId),
      ...rows.filter((row) => String(row._id) !== originId),
    ];
    for (const row of ordered) {
      const locale = String(row.locale || "");
      if (!locale || locale === selfLocale || byLocale.has(locale)) continue;
      byLocale.set(locale, {
        _id: String(row._id),
        locale,
        slug: String(row.slug || ""),
        title: String(row.title || ""),
        status: String(row.status || "draft"),
        autoTranslated: row.autoTranslated === true,
        ...(row.translatedFrom ? { translatedFrom: String(row.translatedFrom) } : {}),
        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      });
    }
    return CMS_LOCALES.flatMap((locale) => {
      const variant = byLocale.get(locale);
      return variant ? [variant] : [];
    });
  } catch (err) {
    console.error("CMS locale variant lookup failed; omitting localeVariants:", err);
    return undefined;
  }
}

/**
 * Adds `localeVariants` and `translationStatus` to an admin response doc.
 * Both are best-effort: a failed lookup omits the field, never the response.
 */
async function withTranslationInfo(doc: Record<string, any>): Promise<Record<string, any>> {
  const [localeVariants, translationStatus] = await Promise.all([
    loadCmsLocaleVariants(doc),
    tryLoadCmsTranslationStatus(doc._id),
  ]);
  return {
    ...doc,
    ...(localeVariants ? { localeVariants } : {}),
    ...(translationStatus ? { translationStatus } : {}),
  };
}

export const listFaqCategories = async (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, data: FAQ_CATEGORIES });
};

async function loadServiceSlugOptions(): Promise<Array<{ slug: string; label: string }>> {
  const configs = await ServiceConfiguration.find({}).select("service").lean();
  const seen = new Set<string>();
  const items: Array<{ slug: string; label: string }> = [];
  for (const c of configs) {
    const name = (c.service || "").trim();
    if (!name) continue;
    const slug = toSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    items.push({ slug, label: name });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

export const listCmsServiceOptions = async (_req: Request, res: Response) => {
  try {
    await connecToDatabase();
    const items = await loadServiceSlugOptions();
    return res.status(200).json({ success: true, data: { items } });
  } catch (error) {
    console.error("List CMS service options error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load service options" });
  }
};

const RESERVED_LANDING_SLOTS: Array<{ slug: string; label: string; usedFor: string }> = [
  { slug: "about", label: "About", usedFor: "About page (overrides hardcoded content)" },
];

async function buildLandingSlotDefs() {
  const configs = await ServiceConfiguration.find({}).select("service category").lean();
  const seen = new Set<string>();
  const services: Array<{ slug: string; label: string; category?: string }> = [];
  for (const c of configs) {
    const name = (c.service || "").trim();
    if (!name) continue;
    const slug = toSlug(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    services.push({ slug, label: name, category: (c.category || "").trim() || undefined });
  }
  services.sort((a, b) => a.label.localeCompare(b.label));

  const reservedSlugs = new Set(RESERVED_LANDING_SLOTS.map((r) => r.slug));
  return [
    ...RESERVED_LANDING_SLOTS.map((r) => ({ ...r, category: undefined as string | undefined, reserved: true })),
    ...services
      .filter((s) => !reservedSlugs.has(s.slug))
      .map((s) => ({
        slug: s.slug,
        label: s.label,
        usedFor: s.category ? `Service · ${s.category}` : "Service",
        category: s.category,
        reserved: false,
      })),
  ];
}

export const listCmsLandingSlots = async (_req: Request, res: Response) => {
  try {
    await connecToDatabase();
    const slotDefs = await buildLandingSlotDefs();
    const slugs = slotDefs.map((s) => s.slug);
    const existing = await CmsContent.find({ type: "landing", slug: { $in: slugs }, locale: "en" }).lean();
    const bySlug = new Map(existing.map((doc) => [doc.slug, doc]));

    const slots = slotDefs.map((s) => {
      const item = bySlug.get(s.slug);
      return {
        slug: s.slug,
        label: s.label,
        usedFor: s.usedFor,
        category: s.category,
        reserved: s.reserved,
        item: item
          ? {
              _id: String(item._id),
              status: item.status,
              title: item.title,
              updatedAt: item.updatedAt,
            }
          : null,
      };
    });

    return res.status(200).json({ success: true, data: { slots } });
  } catch (error) {
    console.error("List CMS landing slots error:", error);
    return res.status(500).json({ success: false, msg: "Failed to list landing slots" });
  }
};

export const syncCmsLandingSlots = async (req: Request, res: Response) => {
  try {
    const admin = (req as Request & { admin?: IUser }).admin;
    await connecToDatabase();
    const slotDefs = await buildLandingSlotDefs();
    const slugs = slotDefs.map((s) => s.slug);
    const existing = await CmsContent.find({ type: "landing", slug: { $in: slugs }, locale: "en" }).select("slug").lean();
    const existingSlugs = new Set(existing.map((d) => d.slug));
    const missing = slotDefs.filter((s) => !existingSlugs.has(s.slug));

    const attempted = missing.length;
    if (attempted === 0) {
      return res.status(200).json({ success: true, data: { attempted: 0, created: 0 } });
    }

    const docsToCreate = missing.map((s) => ({
      type: "landing" as const,
      title: s.label,
      slug: s.slug,
      locale: "en",
      body: "",
      status: "draft" as const,
      author: admin?._id,
      tags: [],
      seo: {},
    }));

    let created = 0;
    try {
      const result = await CmsContent.insertMany(docsToCreate, { ordered: false });
      created = Array.isArray(result) ? result.length : 0;
    } catch (err: any) {
      const writeErrors: any[] | undefined = Array.isArray(err?.writeErrors) ? err.writeErrors : undefined;
      const allDuplicates = writeErrors && writeErrors.length > 0
        ? writeErrors.every((e: any) => (e?.code ?? e?.err?.code) === 11000)
        : err?.code === 11000;
      if (!allDuplicates) {
        console.error("[syncCmsLandingSlots] insertMany failed with non-duplicate errors:", err);
        throw err;
      }
      const insertedCount = typeof err?.result?.insertedCount === "number"
        ? err.result.insertedCount
        : typeof err?.insertedDocs?.length === "number"
          ? err.insertedDocs.length
          : Math.max(0, attempted - (writeErrors?.length ?? 0));
      created = insertedCount;
    }

    return res.status(200).json({ success: true, data: { attempted, created } });
  } catch (error) {
    console.error("Sync CMS landing slots error:", error);
    return res.status(500).json({ success: false, msg: "Failed to sync landing slots" });
  }
};

export const listCmsContent = async (req: Request, res: Response) => {
  try {
    await connecToDatabase();

    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    const { type, status, search, category, tag, locale } = req.query as Record<string, string>;

    if (type && CMS_CONTENT_TYPES.includes(type as CmsContentType)) filter.type = type;
    if (status && CMS_CONTENT_STATUSES.includes(status as CmsContentStatus)) filter.status = status;
    if (category) filter.category = category.toLowerCase();
    if (tag) filter.tags = tag.toLowerCase();
    if (locale) filter.locale = locale.toLowerCase();
    if (search && search.trim()) {
      const term = search.trim();
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { $text: { $search: term } },
        { slug: new RegExp("^" + escaped, "i") },
      ];
    }

    const [items, total] = await Promise.all([
      CmsContent.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author", "name email")
        .lean(),
      CmsContent.countDocuments(filter),
    ]);

    const presigned = await presignCmsDocs(items);

    return res.status(200).json({
      success: true,
      data: {
        items: presigned,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error("List CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to list CMS content" });
  }
};

export const getCmsContentById = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const doc = await CmsContent.findById(id)
      .populate("author", "name email")
      .populate("relatedContent", "title slug type")
      .populate("relatedServices", "name slug")
      .lean();

    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    const presigned = await presignCmsDoc(doc);
    return res.status(200).json({ success: true, data: await withTranslationInfo(presigned) });
  } catch (error) {
    console.error("Get CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch content" });
  }
};

export const createCmsContent = async (req: Request, res: Response) => {
  try {
    const admin = req.admin as IUser;
    const body = req.body || {};

    const type = body.type as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(400).json({ success: false, msg: "Invalid or missing type" });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return res.status(400).json({ success: false, msg: "Title is required" });
    }

    const slug = toSlug(typeof body.slug === "string" && body.slug.trim() ? body.slug : title);
    if (!slug) {
      return res.status(400).json({ success: false, msg: "Slug is required" });
    }

    const rawLocale =
      typeof body.locale === "string" && body.locale.trim() ? body.locale.trim().toLowerCase() : "en";
    if (!isCmsLocale(rawLocale)) {
      return res.status(400).json({
        success: false,
        msg: `Unsupported locale: ${rawLocale}. Supported locales: ${CMS_LOCALES.join(", ")}`,
      });
    }
    const locale = rawLocale;
    const status: CmsContentStatus = CMS_CONTENT_STATUSES.includes(body.status)
      ? body.status
      : "draft";

    const coverImage = coverImageForCreate(body.coverImage) || "";
    if ((type === "blog" || type === "news") && !coverImage) {
      return res.status(400).json({ success: false, msg: "Cover image is required for blog and news" });
    }

    let category: string | undefined;
    if (type === "faq") {
      const cat = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
      if (!cat || !FAQ_CATEGORY_SLUGS.includes(cat)) {
        return res.status(400).json({ success: false, msg: "FAQ category is required and must be valid" });
      }
      category = cat;
    }

    await connecToDatabase();

    const existing = await CmsContent.findOne({ type, slug, locale });
    if (existing) {
      return res.status(409).json({ success: false, msg: "Slug already exists for this type and locale" });
    }

    const authorOverride =
      typeof body.authorOverride === "string" && body.authorOverride.trim()
        ? body.authorOverride.trim().slice(0, 120)
        : undefined;

    let relatedServiceSlug: string | undefined;
    if ((type === "blog" || type === "news") && typeof body.relatedServiceSlug === "string") {
      const candidate = toSlug(body.relatedServiceSlug);
      if (candidate) {
        const allowed = new Set((await loadServiceSlugOptions()).map((s) => s.slug));
        if (!allowed.has(candidate)) {
          return res.status(400).json({ success: false, msg: "Invalid related service" });
        }
        relatedServiceSlug = candidate;
      }
    }

    const coverImageAlt = coverImageAltForCreate(body.coverImageAlt);

    const doc = await CmsContent.create({
      type,
      title,
      slug,
      locale,
      body: typeof body.body === "string" ? canonicalizeCmsHtmlImages(body.body) : "",
      excerpt: typeof body.excerpt === "string" ? body.excerpt.trim().slice(0, 500) : undefined,
      coverImage: coverImage || undefined,
      coverImageAlt,
      category,
      tags: type === "blog" || type === "news" ? sanitizeStringArray(body.tags) : [],
      status,
      author: admin._id,
      authorOverride,
      seo: pickSeo(body.seo),
      relatedContent: sanitizeObjectIdArray(body.relatedContent),
      relatedServices: sanitizeObjectIdArray(body.relatedServices),
      relatedServiceSlug,
      activeCountries: sanitizeCmsActiveCountries(body.activeCountries),
    });

    // Mirrors nothing yet (a new doc has no translations) and queues the
    // background run that creates the machine translations after the response.
    const translations = await runTranslationSync(doc);

    const fallback = doc.toObject() as Record<string, any>;
    const populated = await loadCmsDocForResponse(doc._id, fallback);
    const presigned = await presignCmsDoc(populated);
    return res
      .status(201)
      .json({ success: true, translations, data: await withTranslationInfo(presigned) });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, msg: "Slug already exists for this type and locale" });
    }
    console.error("Create CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to create content" });
  }
};

export const updateCmsContent = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const doc = await CmsContent.findById(id);
    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    const body = req.body || {};

    if (typeof body.title === "string" && body.title.trim()) doc.title = body.title.trim();

    const finalSlug =
      typeof body.slug === "string" && body.slug.trim() ? toSlug(body.slug) : doc.slug;
    const rawFinalLocale =
      typeof body.locale === "string" && body.locale.trim() ? body.locale.trim().toLowerCase() : doc.locale;
    if (!isCmsLocale(rawFinalLocale)) {
      return res.status(400).json({
        success: false,
        msg: `Unsupported locale: ${rawFinalLocale}. Supported locales: ${CMS_LOCALES.join(", ")}`,
      });
    }
    const finalLocale = rawFinalLocale;

    if (!finalSlug) {
      return res.status(400).json({ success: false, msg: "Slug is required" });
    }

    const slugChanged = finalSlug !== doc.slug;

    if (finalSlug !== doc.slug || finalLocale !== doc.locale) {
      const clash = await CmsContent.findOne({
        type: doc.type,
        slug: finalSlug,
        locale: finalLocale,
        _id: { $ne: doc._id },
      });
      if (clash) {
        const localeChanged = finalLocale !== doc.locale;
        const detail = slugChanged && localeChanged ? "slug and locale" : slugChanged ? "slug" : "locale";
        return res.status(409).json({
          success: false,
          msg: `Another ${doc.type} already uses this ${detail} (${finalSlug} / ${finalLocale})`,
        });
      }
      doc.slug = finalSlug;
      doc.locale = finalLocale;
    }

    if (typeof body.body === "string") doc.body = canonicalizeCmsHtmlImages(body.body);
    if (typeof body.excerpt === "string") doc.excerpt = body.excerpt.trim().slice(0, 500);

    let previousCoverToCleanup: string | undefined;
    if (typeof body.coverImage === "string") {
      const cover = canonicalizeCmsMediaUrl(body.coverImage);
      if ((doc.type === "blog" || doc.type === "news") && !cover) {
        return res.status(400).json({ success: false, msg: "Cover image is required for blog and news" });
      }
      const coverUpdate = applyCoverImageUpdate(doc.coverImage, body.coverImage);
      doc.coverImage = coverUpdate.coverImage;
      previousCoverToCleanup = coverUpdate.previousToCleanup;
      if (
        previousCoverToCleanup &&
        typeof body.coverImageAlt !== "string" &&
        body.coverImageAlt !== null
      ) {
        doc.coverImageAlt = undefined;
      }
    }

    if (
      typeof body.coverImageAlt === "string" ||
      body.coverImageAlt === null
    ) {
      doc.coverImageAlt = applyCoverImageAltUpdate(doc.coverImageAlt, body.coverImageAlt);
    }

    if (doc.type === "faq" && typeof body.category === "string") {
      const cat = body.category.trim().toLowerCase();
      if (!FAQ_CATEGORY_SLUGS.includes(cat)) {
        return res.status(400).json({ success: false, msg: "Invalid FAQ category" });
      }
      doc.category = cat;
    }

    if (Array.isArray(body.tags) && (doc.type === "blog" || doc.type === "news")) {
      doc.tags = sanitizeStringArray(body.tags);
    }

    if (body.status && CMS_CONTENT_STATUSES.includes(body.status)) {
      doc.status = body.status;
    }

    if (body.seo !== undefined) {
      doc.seo = { ...(doc.seo || {}), ...pickSeo(body.seo) };
    }

    if (Array.isArray(body.relatedContent)) doc.relatedContent = sanitizeObjectIdArray(body.relatedContent);
    if (Array.isArray(body.relatedServices)) doc.relatedServices = sanitizeObjectIdArray(body.relatedServices);

    if (typeof body.authorOverride === "string") {
      const v = body.authorOverride.trim().slice(0, 120);
      doc.authorOverride = v || undefined;
    }

    if (body.relatedServiceSlug === null) {
      doc.relatedServiceSlug = undefined;
    } else if (typeof body.relatedServiceSlug === "string") {
      if (doc.type === "blog" || doc.type === "news") {
        const trimmed = body.relatedServiceSlug.trim();
        if (!trimmed) {
          doc.relatedServiceSlug = undefined;
        } else {
          const candidate = toSlug(trimmed);
          if (!candidate) {
            doc.relatedServiceSlug = undefined;
          } else {
            const allowed = new Set((await loadServiceSlugOptions()).map((s) => s.slug));
            if (!allowed.has(candidate)) {
              return res.status(400).json({ success: false, msg: "Invalid related service" });
            }
            doc.relatedServiceSlug = candidate;
          }
        }
      } else {
        doc.relatedServiceSlug = undefined;
      }
    }

    if (Array.isArray(body.activeCountries)) {
      doc.activeCountries = sanitizeCmsActiveCountries(body.activeCountries);
    }

    // An admin directly editing a machine translation demotes it to a manual
    // translation: manual translations always win, and they never act as
    // translation sources (so the human en source is never overwritten).
    if (doc.autoTranslated === true) doc.autoTranslated = false;

    await doc.save();

    // Control fields are mirrored inside the request; new text is queued for
    // the background run. A failure here is reported in the response; the
    // admin's save is never rolled back. Only originals are sources; a manual
    // translation (translatedFrom set) is a no-op here, whatever the edit changed.
    let translations: TranslationResult[] = [];
    if (isTranslationSource(doc)) {
      try {
        // Repoint machine-managed siblings to the new slug first so the
        // per-locale upserts below update the right docs.
        const moveResults = slugChanged ? await moveAutoTranslatedSiblings(doc) : [];
        const syncResults = await runTranslationSync(doc);
        translations = mergeTranslationResults(moveResults, syncResults);
      } catch (err) {
        console.error("CMS translation sync/move crashed after save (save kept):", err);
        translations = [failedResult("*", "internal", "Translation sync crashed")];
      }
    }

    // Drop the replaced object only after the sync: auto siblings have moved
    // to the new cover by now, while manual survivors still reference the old
    // one and must keep it. A failed sync also leaves references in place, so
    // the reference check preserves the object instead of breaking those docs.
    if (previousCoverToCleanup) {
      try {
        await deleteCmsMediaIfUnreferenced(previousCoverToCleanup);
      } catch (err) {
        console.error("Failed to delete replaced CMS cover image:", err);
      }
    }

    const fallback = doc.toObject() as Record<string, any>;
    const populated = await loadCmsDocForResponse(doc._id, fallback);
    const presigned = await presignCmsDoc(populated);
    return res
      .status(200)
      .json({ success: true, translations, data: await withTranslationInfo(presigned) });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, msg: "Slug already exists for this type and locale" });
    }
    console.error("Update CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to update content" });
  }
};

export const deleteCmsContent = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const doc = await CmsContent.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    // Await synchronously: delete machine translations of this source, keep
    // manual ones and detach them (translatedFrom unset). Never fails the delete.
    let translationCleanup: { deleted: number; detached: number } = { deleted: 0, detached: 0 };
    try {
      translationCleanup = await deleteAutoTranslatedSiblings(doc);
    } catch (siblingError) {
      console.error("Failed to clean up auto-translated CMS siblings:", siblingError);
    }

    // The deleted doc is gone; auto siblings were deleted above and manual
    // survivors detached. Only remove the shared S3 object when nothing that
    // remains (including manual translations kept on purpose) references it.
    if (doc.coverImage) {
      try {
        await deleteCmsMediaIfUnreferenced(doc.coverImage);
      } catch (err) {
        console.error("Failed to delete CMS cover image:", err);
      }
    }

    return res.status(200).json({ success: true, msg: "Content deleted", translationCleanup });
  } catch (error) {
    console.error("Delete CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Failed to delete content" });
  }
};

/**
 * POST /api/admin/cms/:id/translate — retry / re-sync / force.
 * body { force?: boolean, locales?: CmsLocale[] }:
 * - default: re-run the sync (creates missing, refreshes stale, retries
 *   failed; manual translations preserved). Up-to-date locales cost nothing.
 * - force: also replace this source's LINKED manual translations
 *   (translatedFrom = source) with machine text, limited to `locales` when
 *   given. A same-slug document not linked to the source is never overwritten.
 *
 * Only originals are translation sources. When the id points at a translation
 * (translatedFrom set), the sync is re-run from its origin instead, so force
 * never overwrites the human source locale with machine text. If the origin no
 * longer exists, the doc is promoted to a manual original first.
 *
 * The provider work runs in the background; `translations` are the immediate
 * results (`pending` while queued) and `data` is the current status.
 */
export const translateCmsContent = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    const body = req.body || {};
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return res.status(400).json({ success: false, msg: "force must be a boolean" });
    }
    const force = body.force === true;

    let requestedLocales: string[] | undefined;
    if (body.locales !== undefined && body.locales !== null) {
      if (
        !Array.isArray(body.locales) ||
        !body.locales.every((locale: unknown) => typeof locale === "string" && isCmsLocale(locale))
      ) {
        return res.status(400).json({
          success: false,
          msg: `locales must be a list of supported locales (${CMS_LOCALES.join(", ")})`,
        });
      }
      requestedLocales = Array.from(new Set(body.locales as string[]));
    }

    await connecToDatabase();
    const doc = await CmsContent.findById(id);
    if (!doc) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }

    let sourceDoc: Record<string, any> = doc;
    if (doc.translatedFrom) {
      const origin = await CmsContent.findById(doc.translatedFrom);
      if (origin) {
        sourceDoc = origin;
      } else {
        // Orphaned translation: promote it to a manual original so the sync
        // runs from a real source instead of a document that no longer exists.
        doc.translatedFrom = undefined;
        doc.autoTranslated = false;
        doc.sourceHash = undefined;
        await doc.save();
      }
    }

    const targets = targetLocalesFor(String(sourceDoc.locale));
    const forceLocales = force
      ? targets.filter((locale) => !requestedLocales || requestedLocales.includes(locale))
      : [];

    const translations = await runTranslationSync(sourceDoc, { forceLocales });
    const status = await loadCmsTranslationStatus(sourceDoc._id);
    return res.status(200).json({ success: true, translations, data: status ?? undefined });
  } catch (error) {
    console.error("Translate CMS content error:", error);
    return res.status(500).json({ success: false, msg: "Translation sync failed" });
  }
};

/**
 * GET /api/admin/cms/:id/translations — translation status of the family the
 * doc belongs to (`:id` may be the source or any translation). Polled by the
 * admin UI while a background run is pending; each read also re-schedules a
 * run whose worker died.
 */
export const getCmsTranslationStatus = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, msg: "Invalid content ID" });
    }

    await connecToDatabase();
    const status = await loadCmsTranslationStatus(id);
    if (!status) {
      return res.status(404).json({ success: false, msg: "Content not found" });
    }
    return res.status(200).json({ success: true, data: status });
  } catch (error) {
    console.error("Get CMS translation status error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load translation status" });
  }
};

export const getCmsPreviewBySlug = async (req: Request, res: Response) => {
  try {
    const type = param(req.params.type) as CmsContentType;
    if (!CMS_CONTENT_TYPES.includes(type)) {
      return res.status(404).json({ success: false, msg: "Unknown content type" });
    }
    const slug = param(req.params.slug).toLowerCase();
    if (!slug) return res.status(404).json({ success: false, msg: "Not found" });

    const locale = typeof req.query.locale === "string" ? req.query.locale.toLowerCase() : "en";

    await connecToDatabase();
    const doc = await CmsContent.findOne({ type, slug, locale })
      .populate("author", "name email")
      .populate({
        path: "relatedContent",
        select: "title slug type excerpt coverImage coverImageAlt publishedAt",
      })
      .populate("relatedServices", "name slug")
      .lean();

    if (!doc) return res.status(404).json({ success: false, msg: "Not found" });

    const presigned = await presignCmsDoc(doc);
    return res.status(200).json({ success: true, data: presigned });
  } catch (error) {
    console.error("Admin CMS preview error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load preview" });
  }
};

export const uploadCmsImage = async (req: Request, res: Response) => {
  try {
    const admin = req.admin as IUser;
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, msg: "No image file provided" });
    }

    const validation = await validateImageFileBuffer(file, 5 * 1024 * 1024);
    if (!validation.valid) {
      return res.status(400).json({ success: false, msg: validation.error });
    }
    if (validation.detectedMime) file.mimetype = validation.detectedMime;

    const fileName = generateFileName(file.originalname, admin._id.toString(), "cms");
    const result = await uploadToS3(file, fileName);

    let signedUrl: string | null = null;
    try {
      signedUrl = await presignS3Url(result.url);
    } catch (presignError) {
      console.error("Upload CMS image presign error:", { url: result.url, error: presignError });
      return res.status(500).json({ success: false, msg: "We couldn't prepare the uploaded image. Please try again." });
    }
    if (!signedUrl) {
      console.error("Upload CMS image presign error: presignS3Url returned null", { url: result.url });
      return res.status(500).json({ success: false, msg: "We couldn't prepare the uploaded image. Please try again." });
    }

    return res.status(200).json({ success: true, data: { url: signedUrl, key: result.key } });
  } catch (error) {
    console.error("Upload CMS image error:", error);
    return res.status(500).json({ success: false, msg: "We couldn't upload the image. Please try again." });
  }
};
