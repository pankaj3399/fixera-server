import { Request, Response } from 'express';
import mongoose from 'mongoose';
import MarketingCampaign, {
  MARKETING_AUDIENCE_TYPES,
  MARKETING_CAMPAIGN_TYPES,
  MARKETING_CAMPAIGN_STATUSES,
  MARKETING_LOCALES,
  campaignAudienceType,
  isLeadAudienceType,
  type MarketingAudienceType,
  type MarketingCampaignType,
  type MarketingLocale,
} from '../../models/marketingCampaign';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import { params } from '../../utils/requestParams';
import { syncSubscribersFromUsers } from '../../utils/marketing/audience';
import { refreshCampaignStats, sendMarketingCampaign } from '../../utils/marketing/sendCampaign';
import { getBrevoMarketingTemplateHtml, listActiveBrevoTemplates } from '../../utils/marketing/brevoMarketing';
import { sendBrevoTransactionalMarketingEmail } from '../../utils/marketing/brevoMarketing';
import { resolveMarketingAudience } from '../../utils/marketing/audienceResolver';
import {
  assertInlineMarketingContent,
  MarketingContentError,
  renderMarketingEmail,
  renderMarketingTemplateEmail,
} from '../../utils/marketing/renderCampaign';
import { isValidEmail, normalizeEmail } from '../../utils/marketing/normalizeEmail';
import { signUnsubscribePayload } from '../../utils/marketing/unsubscribeToken';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

class MarketingInputError extends Error {}

function configuredInactiveDays(): number {
  const value = Math.floor(Number(process.env.MARKETING_REENGAGEMENT_INACTIVE_DAYS));
  return Number.isFinite(value) && value > 0 ? value : 60;
}

function parseAudienceType(
  value: unknown,
  fallback: MarketingAudienceType,
): MarketingAudienceType {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new MarketingInputError('Audience type must be one of: subscribers, both, leads');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (!(MARKETING_AUDIENCE_TYPES as readonly string[]).includes(normalized)) {
    throw new MarketingInputError('Audience type must be one of: subscribers, both, leads');
  }
  return normalized as MarketingAudienceType;
}

function assertAudiencePolicy(
  campaignType: MarketingCampaignType,
  audienceType: MarketingAudienceType,
  roles: Array<'customer' | 'professional'>,
  opts?: { typeChangedAwayFromLeads?: boolean },
): void {
  if (audienceType === 'subscribers') return;
  if (campaignType !== 'invitation') {
    throw new MarketingInputError(
      opts?.typeChangedAwayFromLeads
        ? 'Select Subscribers before changing this campaign type'
        : 'Lead audiences are only available for invitation campaigns',
    );
  }
  if (!roles.includes('professional')) {
    throw new MarketingInputError('Lead audiences require the professional role');
  }
}

function parseAudience(body: any, existing?: {
  countries?: string[];
  interestedServices?: string[];
  serviceKeys?: string[];
  locales?: string[];
  roles?: Array<'customer' | 'professional'>;
}) {
  const source = body && typeof body === 'object' ? body : {};
  if (Array.isArray(source.locales) && source.locales.length === 0) {
    throw new MarketingInputError('Select at least one campaign locale');
  }
  if (Array.isArray(source.roles) && source.roles.length === 0) {
    throw new MarketingInputError('Select at least one audience role');
  }
  if (
    Array.isArray(source.locales) &&
    source.locales.some(
      (locale: unknown) =>
        typeof locale !== 'string' ||
        !(MARKETING_LOCALES as readonly string[]).includes(locale.trim().toLowerCase()),
    )
  ) {
    throw new MarketingInputError('locales contain an unsupported marketing language');
  }
  if (
    Array.isArray(source.roles) &&
    source.roles.some((role: unknown) => role !== 'customer' && role !== 'professional')
  ) {
    throw new MarketingInputError('roles may only contain customer or professional');
  }
  if (
    Array.isArray(source.countries) &&
    source.countries.some(
      (country: unknown) =>
        typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country.trim()),
    )
  ) {
    throw new MarketingInputError('countries must contain two-letter ISO country codes');
  }
  const countries = Array.isArray(source.countries)
    ? source.countries.map((c: any) => String(c).trim().toUpperCase()).filter(Boolean)
    : existing?.countries
      ? [...existing.countries]
      : [];
  const interestedServices = Array.isArray(source.interestedServices)
    ? source.interestedServices.map((s: any) => String(s).trim()).filter(Boolean)
    : existing?.interestedServices
      ? [...existing.interestedServices]
      : [];
  const serviceKeys = Array.isArray(source.serviceKeys)
    ? source.serviceKeys.map((s: any) => String(s).trim()).filter(Boolean)
    : existing?.serviceKeys
      ? [...existing.serviceKeys]
      : [];
  const locales = Array.isArray(source.locales)
    ? source.locales
        .map((l: any) => String(l).trim().toLowerCase())
        .filter((l: string) => (MARKETING_LOCALES as readonly string[]).includes(l))
    : existing?.locales
      ? [...existing.locales]
      : [];
  const roles = Array.isArray(source.roles)
    ? source.roles.filter((r: any) => r === 'customer' || r === 'professional')
    : existing?.roles?.length
      ? [...existing.roles]
      : ['customer', 'professional'];
  return { countries, interestedServices, serviceKeys, locales, roles };
}

function parseContent(body: any): Record<string, { subject: string; htmlContent: string; previewText?: string; brevoTemplateId?: number }> {
  const out: Record<string, any> = {};
  const raw = body?.content && typeof body.content === 'object' ? body.content : {};
  for (const locale of MARKETING_LOCALES) {
    const block = raw[locale];
    if (!block || typeof block !== 'object') continue;
    const subject = typeof block.subject === 'string' ? block.subject.trim() : '';
    const htmlContent = typeof block.htmlContent === 'string' ? block.htmlContent : '';
    const previewText =
      typeof block.previewText === 'string' ? block.previewText.trim() : undefined;
    const brevoTemplateId =
      block.brevoTemplateId != null &&
      Number.isInteger(Number(block.brevoTemplateId)) &&
      Number(block.brevoTemplateId) > 0
        ? Number(block.brevoTemplateId)
        : undefined;
    if (!subject) continue;
    if ((!htmlContent || htmlContent.trim().length <= 10) && !brevoTemplateId) continue;
    out[locale] = { subject, htmlContent: htmlContent || '<p></p>', previewText, brevoTemplateId };
  }
  return out;
}

function validateLocaleContent(
  content: Record<string, { subject: string; htmlContent: string; brevoTemplateId?: number }>,
  audience: { locales?: string[] },
): void {
  const missing = (audience.locales || []).filter((locale) => !content[locale]);
  if (missing.length > 0) {
    throw new MarketingInputError(
      `Provide campaign content for every selected locale: ${missing.join(', ')}`,
    );
  }
}

function serializeCampaign(doc: any) {
  const obj = doc.toObject ? doc.toObject() : doc;
  const { audienceTypeInvalid: _ignoredAudienceTypeInvalid, ...campaign } = obj;
  const audienceType = campaignAudienceType(obj.audienceType);
  const rawAudienceType =
    typeof obj.audienceType === 'string' && obj.audienceType.trim()
      ? obj.audienceType.trim()
      : null;
  return {
    ...campaign,
    _id: String(obj._id),
    createdBy: obj.createdBy ? String(obj.createdBy) : undefined,
    // Missing legacy values behave as subscribers. A recognized value is
    // preserved. An unknown stored value stays visible so it is never silently
    // relabeled, and send/preview refuse it until an admin corrects it.
    audienceType: audienceType ?? rawAudienceType,
    ...(audienceType === undefined ? { audienceTypeInvalid: true } : {}),
  };
}

export const listMarketingCampaigns = async (req: Request, res: Response) => {
  try {
    const { type, status, page, limit, q } = req.query;
    if (typeof type === 'string' && !(MARKETING_CAMPAIGN_TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign type filter' });
    }
    if (typeof status === 'string' && !(MARKETING_CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign status filter' });
    }
    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, unknown> = {};
    if (typeof type === 'string' && (MARKETING_CAMPAIGN_TYPES as readonly string[]).includes(type)) {
      query.type = type;
    } else {
      // Invitation campaigns are part of the active UI, including recognized
      // legacy invitation campaigns. No type is hidden by the list.
      query.type = { $in: MARKETING_CAMPAIGN_TYPES };
    }
    if (typeof status === 'string' && status.trim()) query.status = status.trim();
    if (typeof q === 'string' && q.trim().length >= 2) {
      query.name = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const [rows, total] = await Promise.all([
      MarketingCampaign.find(query).sort({ updatedAt: -1 }).skip(skip).limit(limitNumber).lean(),
      MarketingCampaign.countDocuments(query),
    ]);

    return res.json({
      success: true,
      data: {
        campaigns: rows.map((r) => serializeCampaign(r)),
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total,
          totalPages: Math.max(1, Math.ceil(total / limitNumber)),
        },
      },
    });
  } catch (error: any) {
    console.error('listMarketingCampaigns:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list campaigns' });
  }
};

export const getMarketingCampaign = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign id' });
    }
    const campaign = await MarketingCampaign.findById(id);
    if (!campaign) return res.status(404).json({ success: false, msg: 'Campaign not found' });
    return res.json({ success: true, data: serializeCampaign(campaign) });
  } catch (error: any) {
    console.error('getMarketingCampaign:', error);
    return res.status(500).json({ success: false, msg: 'Failed to get campaign' });
  }
};

export const listMarketingTemplates = async (_req: Request, res: Response) => {
  try {
    const templates = await listActiveBrevoTemplates();
    return res.json({ success: true, data: { templates } });
  } catch (error: unknown) {
    console.error(
      'listMarketingTemplates:',
      error instanceof Error ? error.message : 'Brevo template lookup failed',
    );
    return res.status(502).json({ success: false, msg: 'Failed to load active Brevo templates' });
  }
};

export const createMarketingCampaign = async (req: Request, res: Response) => {
  try {
    const { name, type, scheduledAt, inactiveDays, autoSend, utmCampaign } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ success: false, msg: 'Name is required' });
    }
    if (!(MARKETING_CAMPAIGN_TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign type' });
    }
    const content = parseContent(req.body);
    if (Object.keys(content).length === 0) {
      return res.status(400).json({
        success: false,
        msg: 'Provide content for at least one supported locale with subject + htmlContent or brevoTemplateId',
      });
    }

    const audienceType = parseAudienceType(req.body?.audienceType, 'subscribers');
    const audience = parseAudience(req.body?.audience || req.body);
    assertAudiencePolicy(type as MarketingCampaignType, audienceType, audience.roles);
    validateLocaleContent(content, audience);
    let scheduled: Date | null = null;
    if (scheduledAt) {
      const d = new Date(scheduledAt);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, msg: 'Invalid scheduledAt' });
      }
      scheduled = d;
    }

    const campaign = await MarketingCampaign.create({
      name: name.trim(),
      type: type as MarketingCampaignType,
      audienceType,
      status: scheduled && scheduled.getTime() > Date.now() ? 'scheduled' : 'draft',
      content,
      audience,
      inactiveDays:
        type === 'reengagement' && Number.isFinite(Number(inactiveDays))
          ? Math.max(1, Math.floor(Number(inactiveDays)))
          : type === 'reengagement'
            ? configuredInactiveDays()
            : undefined,
      autoSend: type === 'reengagement' ? Boolean(autoSend) : false,
      scheduledAt: scheduled,
      utmCampaign: typeof utmCampaign === 'string' ? utmCampaign.trim() : undefined,
      createdBy: (req as any).admin?._id ?? (req as any).user?._id,
      deliveries: [],
    });

    return res.status(201).json({ success: true, data: serializeCampaign(campaign) });
  } catch (error: any) {
    if (error instanceof MarketingInputError) {
      return res.status(400).json({ success: false, msg: error.message });
    }
    console.error('createMarketingCampaign:', error);
    return res.status(500).json({ success: false, msg: 'Failed to create campaign' });
  }
};

export const updateMarketingCampaign = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign id' });
    }
    const campaign = await MarketingCampaign.findById(id);
    if (!campaign) return res.status(404).json({ success: false, msg: 'Campaign not found' });
    if (['sending', 'sent'].includes(campaign.status)) {
      return res.status(400).json({ success: false, msg: 'Sent campaigns cannot be edited' });
    }
    if (campaign.deliveries.some((delivery) => delivery.brevoCampaignId || delivery.brevoListId)) {
      return res.status(400).json({
        success: false,
        msg: 'Partially delivered campaigns are immutable; create a new campaign instead',
      });
    }
    const wasFailed = campaign.status === 'failed';

    const { name, scheduledAt, inactiveDays, autoSend, utmCampaign } = req.body || {};
    if (typeof name === 'string' && name.trim().length >= 2) campaign.name = name.trim();

    let nextAudience = campaign.audience as any;
    if (
      req.body?.audience ||
      req.body?.countries ||
      req.body?.interestedServices ||
      req.body?.serviceKeys ||
      req.body?.locales ||
      req.body?.roles
    ) {
      // Merge partial audience updates so unspecified filters are preserved
      nextAudience = parseAudience(req.body?.audience || req.body, campaign.audience as any);
    }

    let nextType = campaign.type;
    let typeChanged = false;
    if (req.body?.type !== undefined) {
      if (!(MARKETING_CAMPAIGN_TYPES as readonly string[]).includes(req.body.type)) {
        return res.status(400).json({ success: false, msg: 'Invalid campaign type' });
      }
      nextType = req.body.type as MarketingCampaignType;
      typeChanged = nextType !== campaign.type;
    }

    const existingAudienceType = campaignAudienceType(campaign.audienceType);
    const nextAudienceType =
      req.body?.audienceType !== undefined
        ? parseAudienceType(req.body.audienceType, 'subscribers')
        : existingAudienceType;
    if (!nextAudienceType) {
      throw new MarketingInputError('Select an audience type: subscribers, both, leads');
    }
    assertAudiencePolicy(
      nextType,
      nextAudienceType,
      nextAudience.roles || ['customer', 'professional'],
      {
        typeChangedAwayFromLeads:
          typeChanged &&
          nextType !== 'invitation' &&
          isLeadAudienceType(existingAudienceType) &&
          req.body?.audienceType === undefined,
      },
    );

    campaign.audience = nextAudience;
    campaign.audienceType = nextAudienceType;
    if (typeChanged) {
      campaign.type = nextType;
      if (campaign.type === 'reengagement') {
        if (!Number.isFinite(Number(campaign.inactiveDays)) || Number(campaign.inactiveDays) <= 0) {
          campaign.inactiveDays = configuredInactiveDays();
        }
      } else {
        campaign.inactiveDays = undefined;
        campaign.autoSend = false;
      }
    }
    if (req.body?.content) {
      const content = parseContent(req.body);
      if (Object.keys(content).length === 0) {
        return res.status(400).json({ success: false, msg: 'Content update cleared all locales' });
      }
      campaign.content = content as any;
    }
    if (scheduledAt !== undefined) {
      if (scheduledAt === null || scheduledAt === '') {
        campaign.scheduledAt = null;
        if (campaign.status === 'scheduled') campaign.status = 'draft';
      } else {
        const d = new Date(scheduledAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ success: false, msg: 'Invalid scheduledAt' });
        }
        campaign.scheduledAt = d;
        campaign.status = d.getTime() > Date.now() ? 'scheduled' : campaign.status;
      }
    }
    if (campaign.type === 'reengagement') {
      if (inactiveDays !== undefined) {
        const parsed = Number(inactiveDays);
        campaign.inactiveDays =
          Number.isFinite(parsed) && parsed > 0
            ? Math.max(1, Math.floor(parsed))
            : configuredInactiveDays();
      }
      if (autoSend !== undefined) campaign.autoSend = Boolean(autoSend);
    }
    if (typeof utmCampaign === 'string') campaign.utmCampaign = utmCampaign.trim();
    if (wasFailed) {
      campaign.sendAttempts = 0;
      campaign.nextRetryAt = null;
      if (campaign.status === 'failed') {
        campaign.status =
          campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now()
            ? 'scheduled'
            : 'draft';
      }
    }

    validateLocaleContent(campaign.content as any, campaign.audience as any);
    await campaign.save();
    return res.json({ success: true, data: serializeCampaign(campaign) });
  } catch (error: any) {
    if (error instanceof MarketingInputError) {
      return res.status(400).json({ success: false, msg: error.message });
    }
    console.error('updateMarketingCampaign:', error);
    return res.status(500).json({ success: false, msg: 'Failed to update campaign' });
  }
};

export const deleteMarketingCampaign = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign id' });
    }
    const campaign = await MarketingCampaign.findById(id);
    if (!campaign) return res.status(404).json({ success: false, msg: 'Campaign not found' });
    if (
      ['sending', 'sent'].includes(campaign.status) ||
      campaign.deliveries.some((delivery) => delivery.brevoCampaignId || delivery.brevoListId)
    ) {
      return res.status(400).json({
        success: false,
        msg: 'Started campaigns are retained for delivery audit history',
      });
    }
    await campaign.deleteOne();
    return res.json({ success: true, msg: 'Campaign deleted' });
  } catch (error: any) {
    console.error('deleteMarketingCampaign:', error);
    return res.status(500).json({ success: false, msg: 'Failed to delete campaign' });
  }
};

export const previewMarketingAudience = async (req: Request, res: Response) => {
  try {
    const requestedType = req.body?.type ?? 'newsletter';
    if (
      typeof requestedType !== 'string' ||
      !(MARKETING_CAMPAIGN_TYPES as readonly string[]).includes(requestedType)
    ) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign type' });
    }
    const campaignType = requestedType as MarketingCampaignType;
    const audience = parseAudience(req.body?.audience || req.body);
    const audienceType = parseAudienceType(req.body?.audienceType, 'subscribers');
    assertAudiencePolicy(campaignType, audienceType, audience.roles);

    const hasInactiveDays = req.body?.inactiveDays != null;
    const rawInactive = hasInactiveDays ? Number(req.body.inactiveDays) : NaN;
    if (hasInactiveDays && (!Number.isFinite(rawInactive) || rawInactive <= 0)) {
      return res.status(400).json({ success: false, msg: 'inactiveDays must be a positive number' });
    }
    const inactiveDays =
      Number.isFinite(rawInactive) && rawInactive > 0
        ? Math.max(1, Math.floor(rawInactive))
        : undefined;
    const resolution = await resolveMarketingAudience({
      campaignType,
      audienceType,
      filters: audience,
      contentLocales: Array.isArray(req.body?.contentLocales)
        ? req.body.contentLocales
        : Object.keys(req.body?.content || {}),
      inactiveDays,
      limitMode: 'preview',
    });
    const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId : '';
    if (mongoose.Types.ObjectId.isValid(campaignId)) {
      await MarketingCampaign.updateOne(
        { _id: campaignId },
        {
          $set: {
            lastPreviewCount: resolution.exactTotal,
            lastPreviewAt: new Date(),
            lastPreviewCriteriaHash: resolution.criteriaHash,
          },
        },
      );
    }
    return res.json({
      success: true,
      data: {
        audienceType,
        includesLeads: audienceType !== 'subscribers',
        exactTotal: resolution.exactTotal,
        exactTotalIsEstimate: resolution.exactTotalIsEstimate,
        bySource: resolution.bySource,
        byLocale: resolution.byLocale,
        byRole: resolution.byRole,
        deduplicated: resolution.deduplicated,
        excluded: resolution.excluded,
        fallbackLocaleCount: resolution.fallbackLocaleCount,
        overLimit: resolution.overLimit,
        criteriaHash: resolution.criteriaHash,
        count: resolution.exactTotal,
        truncated: resolution.overLimit,
        audience,
      },
    });
  } catch (error: any) {
    if (error instanceof MarketingInputError) {
      return res.status(400).json({ success: false, msg: error.message });
    }
    console.error('previewMarketingAudience:', error);
    return res.status(500).json({ success: false, msg: 'Failed to preview audience' });
  }
};

/** Send the current editor payload without creating or mutating a campaign. */
export const sendMarketingCampaignTestEmail = async (req: Request, res: Response) => {
  try {
    const to = normalizeEmail(req.body?.to);
    if (!isValidEmail(to)) {
      return res.status(400).json({ success: false, msg: 'A valid test recipient email is required' });
    }
    const locale = typeof req.body?.locale === 'string' ? req.body.locale.trim().toLowerCase() : 'en';
    if (!(MARKETING_LOCALES as readonly string[]).includes(locale)) {
      return res.status(400).json({ success: false, msg: 'Unsupported test email locale' });
    }
    const rawContent = req.body?.campaign?.content?.[locale];
    if (!rawContent || typeof rawContent !== 'object') {
      return res.status(400).json({ success: false, msg: `Campaign content is missing for ${locale}` });
    }
    const content = {
      subject: typeof rawContent.subject === 'string' ? rawContent.subject.trim() : '',
      htmlContent: typeof rawContent.htmlContent === 'string' ? rawContent.htmlContent : '',
      previewText: typeof rawContent.previewText === 'string' ? rawContent.previewText.trim() : undefined,
      brevoTemplateId: Number.isInteger(Number(rawContent.brevoTemplateId)) && Number(rawContent.brevoTemplateId) > 0
        ? Number(rawContent.brevoTemplateId)
        : undefined,
    };
    const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName : undefined;
    if (!content.subject) {
      return res.status(400).json({ success: false, msg: `Campaign subject is missing for ${locale}` });
    }
    const audienceType = parseAudienceType(
      req.body?.audienceType ?? req.body?.campaign?.audienceType,
      'subscribers',
    );
    const footerVariant = audienceType === 'subscribers' ? 'subscriber' : 'invitation';
    const rendered = content.brevoTemplateId
      ? renderMarketingTemplateEmail({
        content,
        templateHtml: await getBrevoMarketingTemplateHtml(content.brevoTemplateId, locale as any),
        locale: locale as any,
        firstName,
        unsubscribeToken: signUnsubscribePayload(to),
        footerVariant,
      })
      : (() => {
        assertInlineMarketingContent(content);
        return renderMarketingEmail({
          content,
          locale: locale as any,
          firstName,
          unsubscribeToken: signUnsubscribePayload(to),
          footerVariant,
        });
      })();
    await sendBrevoTransactionalMarketingEmail({
      to,
      subject: `[TEST] ${rendered.subject}`,
      htmlContent: rendered.htmlContent,
      previewText: rendered.previewText,
    });
    return res.json({ success: true, data: { to, locale, audienceType } });
  } catch (error: any) {
    if (error instanceof MarketingContentError || error instanceof MarketingInputError) {
      return res.status(400).json({ success: false, msg: error.message });
    }
    console.error('sendMarketingCampaignTestEmail:', error);
    return res.status(502).json({ success: false, msg: 'Failed to send test email' });
  }
};

export const sendMarketingCampaignNow = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign id' });
    }
    const result = await sendMarketingCampaign(id, { forceNow: true });
    if (!result.ok) {
      return res.status(400).json({ success: false, msg: result.error });
    }
    return res.json({ success: true, data: serializeCampaign(result.campaign) });
  } catch (error: any) {
    console.error('sendMarketingCampaignNow:', error);
    return res.status(500).json({ success: false, msg: 'Failed to send campaign' });
  }
};

export const refreshMarketingCampaignStats = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid campaign id' });
    }
    const campaign = await refreshCampaignStats(id);
    if (!campaign) return res.status(404).json({ success: false, msg: 'Campaign not found' });
    return res.json({ success: true, data: serializeCampaign(campaign) });
  } catch (error: any) {
    console.error('refreshMarketingCampaignStats:', error);
    return res.status(500).json({ success: false, msg: 'Failed to refresh stats' });
  }
};

export const syncMarketingSubscribers = async (_req: Request, res: Response) => {
  try {
    const result = await syncSubscribersFromUsers();
    return res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('syncMarketingSubscribers:', error);
    return res.status(500).json({ success: false, msg: 'Failed to sync subscribers' });
  }
};

export const listMarketingSubscribers = async (req: Request, res: Response) => {
  try {
    const { page, limit, q, region, locale, status } = req.query;
    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, unknown> = {};
    if (typeof region === 'string' && region.trim()) query.region = region.trim().toUpperCase();
    if (typeof locale === 'string' && (MARKETING_LOCALES as readonly string[]).includes(locale)) {
      query.locale = locale;
    }
    if (typeof req.query.serviceKey === 'string' && req.query.serviceKey.trim()) {
      query.$or = [
        { serviceKeys: req.query.serviceKey.trim() },
        { interestedServices: req.query.serviceKey.trim() },
      ];
    }
    if (status === 'active') query.unsubscribedAt = null;
    if (status === 'unsubscribed') query.unsubscribedAt = { $ne: null };
    if (typeof q === 'string' && q.trim().length >= 2) {
      query.email = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const [rows, total] = await Promise.all([
      MarketingSubscriber.find(query)
        .select('-unsubscribeToken')
        .sort({ subscribedAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      MarketingSubscriber.countDocuments(query),
    ]);

    const normalizedEmails = rows
      .map((row) => normalizeEmail(row.emailNormalized || row.email))
      .filter(Boolean);
    const suppressions = normalizedEmails.length > 0
      ? await MarketingSuppression.find({ emailNormalized: { $in: normalizedEmails } })
        .select('emailNormalized reason')
        .lean()
      : [];
    const suppressionByEmail = new Map(
      suppressions.map((suppression) => [normalizeEmail(suppression.emailNormalized), suppression]),
    );
    const subscribers = rows.map((row) => {
      const suppression = suppressionByEmail.get(normalizeEmail(row.emailNormalized || row.email));
      return {
        ...row,
        suppressed: Boolean(suppression || row.unsubscribedAt || row.brevoUnsubscribedAt),
        suppressionReason: suppression?.reason || (row.brevoUnsubscribedAt ? 'provider' : undefined),
      };
    });

    return res.json({
      success: true,
      data: {
        subscribers,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total,
          totalPages: Math.max(1, Math.ceil(total / limitNumber)),
        },
      },
    });
  } catch (error: any) {
    console.error('listMarketingSubscribers:', error);
    return res.status(500).json({ success: false, msg: 'Failed to list subscribers' });
  }
};

// silence unused type import in some TS configs
void 0 as unknown as MarketingLocale;
