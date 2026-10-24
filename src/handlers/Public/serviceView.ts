import { Request, Response } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import ServiceView from '../../models/serviceView';
import User from '../../models/user';
import CmsContent from '../../models/cmsContent';
import { param } from '../../utils/requestParams';
import {
  filterCmsDocsWithPublishedSource,
  type CmsVisibilityDoc,
} from '../../utils/cms/publicVisibility';

const hashVisitor = (ip: string, userAgent: string): string =>
  crypto.createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);

const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9\-_]{0,80}$/i;

const pickTrimmed = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

export const recordServiceView = async (req: Request, res: Response) => {
  try {
    const rawServiceId = param(req.params.serviceId).trim();
    if (!rawServiceId || !SERVICE_ID_PATTERN.test(rawServiceId)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_SERVICE_ID', message: 'Invalid service id' } });
    }
    const serviceId = rawServiceId.toLowerCase();

    const knownLandings = (await CmsContent.find({
      type: 'landing',
      slug: serviceId,
      status: 'published',
    })
      .select('type status activeCountries translatedFrom')
      .lean()) as CmsVisibilityDoc[];

    // Landings are country-agnostic, so only publication matters here: a
    // translation whose source is draft/missing must not record a view for a
    // page the public detail endpoint would not serve. Any visible locale for
    // the slug is enough (public reads fall back to English).
    const visibleLandings = await filterCmsDocsWithPublishedSource(knownLandings);
    if (visibleLandings.length === 0) {
      return res.json({ success: true, data: { recorded: false, reason: 'unknown_service' } });
    }

    const viewerId = (req as any).user?._id ? new mongoose.Types.ObjectId((req as any).user._id) : undefined;

    let city: string | null = null;
    let country: string | null = null;
    if (viewerId) {
      const user = await User.findById(viewerId)
        .select('location.city location.country companyAddress.city companyAddress.country businessInfo.city businessInfo.country')
        .lean();
      const u: any = user;
      city = pickTrimmed(u?.location?.city, u?.companyAddress?.city, u?.businessInfo?.city);
      country = pickTrimmed(u?.location?.country, u?.companyAddress?.country, u?.businessInfo?.country);
    }

    const ip = req.ip || 'unknown';
    const ua = (req.headers['user-agent'] as string) || 'unknown';
    const visitorKey = viewerId ? `u:${viewerId.toString()}` : `ip:${hashVisitor(ip, ua)}`;
    const dayKey = new Date().toISOString().slice(0, 10);

    try {
      await ServiceView.create({
        serviceId,
        viewer: viewerId,
        visitorKey,
        dayKey,
        city,
        country,
      });
      return res.json({ success: true, data: { recorded: true } });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.json({ success: true, data: { recorded: false, reason: 'duplicate' } });
      }
      throw err;
    }
  } catch (error: any) {
    console.error('Error recording service view:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to record view' } });
  }
};
