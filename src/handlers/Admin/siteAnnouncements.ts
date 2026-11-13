import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import SiteAnnouncement, { type ISiteAnnouncement } from '../../models/siteAnnouncement';
import { params } from '../../utils/requestParams';
import { buildAdminListQuery } from '../../utils/siteAnnouncements/buildQueries';
import { parseAdminListFilters } from '../../utils/siteAnnouncements/parseListFilters';
import {
  parseIsActiveBody,
  parseSiteAnnouncementPatchBody,
  parseSiteAnnouncementWriteBody,
} from '../../utils/siteAnnouncements/parseWriteBody';
import type { SiteAnnouncementWriteInput } from '../../utils/siteAnnouncements/types';
import { isTranslatorConfigured } from '../../utils/cms/azureTranslator';
import {
  ANNOUNCEMENT_TRANSLATION_LIMITS,
  announcementTargetLocales,
  computeAnnouncementSourceHash,
  isAnnouncementTranslationLocale,
  loadAnnouncementTranslationStatus,
  requestAnnouncementTranslationRun,
  sourceLanguageOf,
  stripTranslationBookkeeping,
} from '../../utils/siteAnnouncements/translation';

const DEFAULT_ANNOUNCEMENT_FREQUENCY = 'once_pageview' as const;

function toWriteInput(doc: ISiteAnnouncement): SiteAnnouncementWriteInput {
  return {
    name: doc.name,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    ctaLabel: doc.ctaLabel,
    ctaUrl: doc.ctaUrl,
    discountCode: doc.discountCode,
    activeCountries: [...doc.activeCountries],
    locale: doc.locale,
    frequency: doc.frequency ?? DEFAULT_ANNOUNCEMENT_FREQUENCY,
    startsAt: doc.startsAt,
    endsAt: doc.endsAt,
    isActive: doc.isActive,
    priority: doc.priority,
    delaySeconds: doc.delaySeconds,
    dismissible: doc.dismissible,
    requireMarketingConsent: doc.requireMarketingConsent,
  };
}

function normalizeAnnouncementResponse<T extends Record<string, unknown>>(value: T): T & {
  frequency: string;
  impressions: number;
  clicks: number;
  dismissals: number;
} {
  return {
    ...stripTranslationBookkeeping(value),
    frequency: typeof value.frequency === 'string' ? value.frequency : DEFAULT_ANNOUNCEMENT_FREQUENCY,
    impressions: Number(value.impressions) || 0,
    clicks: Number(value.clicks) || 0,
    dismissals: Number(value.dismissals) || 0,
  } as T & {
    frequency: string;
    impressions: number;
    clicks: number;
    dismissals: number;
  };
}

export const listSiteAnnouncements = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const filters = parseAdminListFilters(req.query);
    const query = buildAdminListQuery(filters);

    const [total, announcements] = await Promise.all([
      SiteAnnouncement.countDocuments(query),
      SiteAnnouncement.find(query)
        .sort({ priority: -1, createdAt: -1 })
        .skip((filters.page - 1) * filters.limit)
        .limit(filters.limit)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        announcements: announcements.map((announcement) =>
          normalizeAnnouncementResponse(announcement as unknown as Record<string, unknown>),
        ),
        total,
        page: filters.page,
        limit: filters.limit,
      },
    });
  } catch (error: unknown) {
    console.error('List site announcements error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list announcements' });
  }
};

export const getSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const announcement = await SiteAnnouncement.findById(id).lean();
    if (!announcement) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    const translationStatus = await loadAnnouncementTranslationStatus(id).catch((err) => {
      console.error('Announcement translation status failed:', err);
      return null;
    });

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(announcement as unknown as Record<string, unknown>),
        ...(translationStatus ? { translationStatus } : {}),
      },
    });
  } catch (error: unknown) {
    console.error('Get site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load announcement' });
  }
};

export const createSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const adminId = req.admin?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const parsed = parseSiteAnnouncementWriteBody(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const created = await SiteAnnouncement.create({
      ...parsed.value,
      translationSourceHash: computeAnnouncementSourceHash(parsed.value),
      createdBy: adminId,
    });

    // Machine translation runs after the response (no-op without a translator key).
    await requestTranslationSafely(created._id);

    return res.status(201).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (created.toObject?.() ?? created) as unknown as Record<string, unknown>,
        ),
      },
    });
  } catch (error: unknown) {
    console.error('Create site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to create announcement' });
  }
};

export const setSiteAnnouncementActive = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const parsed = parseIsActiveBody(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const updated = await SiteAnnouncement.findByIdAndUpdate(
      id,
      { isActive: parsed.value },
      { new: true, runValidators: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (updated.toObject?.() ?? updated) as unknown as Record<string, unknown>,
        ),
      },
    });
  } catch (error: unknown) {
    console.error('Set site announcement active error:', error);
    return res
      .status(500)
      .json({ success: false, msg: 'Failed to update announcement status' });
  }
};

export const updateSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const existing = await SiteAnnouncement.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    const parsed = parseSiteAnnouncementPatchBody(req.body ?? {}, toWriteInput(existing));
    if (!parsed.ok) {
      return res.status(400).json({ success: false, msg: parsed.error });
    }

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    for (const [key, value] of Object.entries(parsed.value)) {
      if (value === null && (key === 'ctaLabel' || key === 'ctaUrl' || key === 'discountCode')) {
        $unset[key] = 1;
      } else if (value !== undefined) {
        $set[key] = value;
      }
    }

    const merged = { ...toWriteInput(existing), ...parsed.value };
    const nextHash = computeAnnouncementSourceHash({
      locale: merged.locale,
      title: merged.title,
      message: merged.message,
      ctaLabel: merged.ctaLabel ?? undefined,
      discountCode: merged.discountCode ?? undefined,
    });
    const sourceChanged = nextHash !== existing.translationSourceHash;
    if (sourceChanged) {
      $set.translationSourceHash = nextHash;
      // The new source language no longer needs a translation of its own.
      const newBase = sourceLanguageOf(merged.locale);
      if (isAnnouncementTranslationLocale(newBase) && existing.translations?.[newBase]) {
        $unset[`translations.${newBase}`] = 1;
      }
    }

    const updateDoc = {
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    };

    const scheduleGuard: Record<string, unknown> = { _id: id };
    if (parsed.value.startsAt && !parsed.value.endsAt) {
      scheduleGuard.endsAt = { $gt: parsed.value.startsAt };
    } else if (parsed.value.endsAt && !parsed.value.startsAt) {
      scheduleGuard.startsAt = { $lt: parsed.value.endsAt };
    }

    const updated = await SiteAnnouncement.findOneAndUpdate(scheduleGuard, updateDoc, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(409).json({
        success: false,
        msg: 'Announcement schedule changed; reload and try again',
      });
    }

    if (sourceChanged) await requestTranslationSafely(updated._id);

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (updated.toObject?.() ?? updated) as unknown as Record<string, unknown>,
        ),
      },
    });
  } catch (error: unknown) {
    console.error('Update site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update announcement' });
  }
};

export const deleteSiteAnnouncement = async (
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }

    const updated = await SiteAnnouncement.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true, runValidators: true },
    );
    if (!updated) {
      return res.status(404).json({ success: false, msg: 'Announcement not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        announcement: normalizeAnnouncementResponse(
          (updated.toObject?.() ?? updated) as unknown as Record<string, unknown>,
        ),
      },
    });
  } catch (error: unknown) {
    console.error('Delete site announcement error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete announcement' });
  }
};

/** Scheduling must never fail the admin's save. */
async function requestTranslationSafely(id: unknown): Promise<void> {
  try {
    await requestAnnouncementTranslationRun(String(id));
  } catch (err) {
    console.error('Could not schedule announcement translation:', err);
  }
}

function trimmedField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** GET /site-announcements/:id/translations — per-locale status (reconciles dead runs). */
export const getSiteAnnouncementTranslations = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }
    const status = await loadAnnouncementTranslationStatus(id);
    if (!status) return res.status(404).json({ success: false, msg: 'Announcement not found' });
    return res.status(200).json({ success: true, data: { translationStatus: status } });
  } catch (error: unknown) {
    console.error('Get announcement translations error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load translation status' });
  }
};

/**
 * POST /site-announcements/:id/translations/run
 * Body: { locales?: string[]; force?: boolean }
 * Without force: translates missing/stale/failed machine locales (retry).
 * With force: also overwrites the given (or all) locales, manual ones included.
 */
export const runSiteAnnouncementTranslations = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }
    if (!isTranslatorConfigured()) {
      return res.status(409).json({ success: false, msg: 'Auto-translation is not configured (AZURE_TRANSLATOR_KEY)' });
    }
    const existing = await SiteAnnouncement.findById(id).select('locale').lean();
    if (!existing) return res.status(404).json({ success: false, msg: 'Announcement not found' });
    const targets = announcementTargetLocales(existing.locale);
    if (targets.length === 0) {
      return res.status(400).json({ success: false, msg: 'This source language cannot be auto-translated' });
    }
    const rawLocales = req.body?.locales;
    if (rawLocales !== undefined && !Array.isArray(rawLocales)) {
      return res.status(400).json({ success: false, msg: 'locales must be an array' });
    }
    const requested: string[] = Array.isArray(rawLocales)
      ? rawLocales.map((value: unknown) => String(value).trim().toLowerCase())
      : [];
    const invalid = requested.filter((locale) => !targets.includes(locale as never));
    if (invalid.length > 0) {
      return res.status(400).json({ success: false, msg: `Not a translation target: ${invalid.join(', ')}` });
    }
    const force = req.body?.force === true;
    const forceLocales = force ? (requested.length ? requested : [...targets]) : [];

    await requestAnnouncementTranslationRun(id, { forceLocales });
    const status = await loadAnnouncementTranslationStatus(id);
    return res.status(202).json({ success: true, data: { translationStatus: status } });
  } catch (error: unknown) {
    console.error('Run announcement translations error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to start translation' });
  }
};

/**
 * PUT /site-announcements/:id/translations/:locale
 * Body: { title, message, ctaLabel? } — stores an admin-edited (manual)
 * translation that machine runs never overwrite unless forced.
 */
export const saveSiteAnnouncementTranslation = async (req: Request, res: Response, _next: NextFunction) => {
  try {
    const { id, locale: rawLocale } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid id' });
    }
    const locale = String(rawLocale || '').trim().toLowerCase();
    if (!isAnnouncementTranslationLocale(locale)) {
      return res.status(400).json({ success: false, msg: 'Unsupported translation locale' });
    }
    const existing = await SiteAnnouncement.findById(id);
    if (!existing) return res.status(404).json({ success: false, msg: 'Announcement not found' });
    if (sourceLanguageOf(existing.locale) === locale) {
      return res.status(400).json({ success: false, msg: 'This is the source language; edit the announcement itself' });
    }

    const title = trimmedField(req.body?.title);
    const message = trimmedField(req.body?.message);
    const ctaLabel = trimmedField(req.body?.ctaLabel);
    if (title.length < 2 || message.length < 2) {
      return res.status(400).json({ success: false, msg: 'Title and message are required' });
    }
    if (title.length > ANNOUNCEMENT_TRANSLATION_LIMITS.title) {
      return res.status(400).json({ success: false, msg: `Title must be at most ${ANNOUNCEMENT_TRANSLATION_LIMITS.title} characters` });
    }
    if (message.length > ANNOUNCEMENT_TRANSLATION_LIMITS.message) {
      return res.status(400).json({ success: false, msg: `Message must be at most ${ANNOUNCEMENT_TRANSLATION_LIMITS.message} characters` });
    }
    if (ctaLabel.length > ANNOUNCEMENT_TRANSLATION_LIMITS.ctaLabel) {
      return res.status(400).json({ success: false, msg: `Button label must be at most ${ANNOUNCEMENT_TRANSLATION_LIMITS.ctaLabel} characters` });
    }

    const sourceHash =
      existing.translationSourceHash ||
      computeAnnouncementSourceHash({
        locale: existing.locale,
        title: existing.title,
        message: existing.message,
        ctaLabel: existing.ctaLabel,
        discountCode: existing.discountCode,
      });
    await SiteAnnouncement.updateOne(
      { _id: id },
      {
        $set: {
          [`translations.${locale}`]: {
            title,
            message,
            ...(ctaLabel ? { ctaLabel } : {}),
            mode: 'manual',
            sourceHash,
            updatedAt: new Date(),
            ...(req.admin?._id ? { updatedBy: req.admin._id } : {}),
          },
          ...(existing.translationSourceHash ? {} : { translationSourceHash: sourceHash }),
        },
      },
      // A translation edit is a real content change for that language: bump
      // updatedAt so visitors' dismissal/frequency version follows it.
      { runValidators: true },
    );
    const status = await loadAnnouncementTranslationStatus(id);
    return res.status(200).json({ success: true, data: { translationStatus: status } });
  } catch (error: unknown) {
    console.error('Save announcement translation error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to save translation' });
  }
};
