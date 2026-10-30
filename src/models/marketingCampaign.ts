import mongoose, { Document, Schema } from 'mongoose';
import { MARKETING_LOCALES, type MarketingLocale } from '../utils/marketing/marketingCatalog';
export { MARKETING_LOCALES } from '../utils/marketing/marketingCatalog';

export const MARKETING_CAMPAIGN_TYPES = ['newsletter', 'promotion', 'reengagement', 'invitation'] as const;
export type MarketingCampaignType = (typeof MARKETING_CAMPAIGN_TYPES)[number];

export const MARKETING_AUDIENCE_TYPES = ['subscribers', 'both', 'leads'] as const;
export type MarketingAudienceType = (typeof MARKETING_AUDIENCE_TYPES)[number];

/**
 * Missing/null/empty means subscribers. Unknown stored values return undefined
 * so callers can fail safely instead of silently widening a legacy campaign.
 */
export function campaignAudienceType(value: unknown): MarketingAudienceType | undefined {
  if (value === undefined || value === null) return 'subscribers';
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'subscribers';
  return (MARKETING_AUDIENCE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as MarketingAudienceType)
    : undefined;
}

export function isLeadAudienceType(value: unknown): boolean {
  const audienceType = campaignAudienceType(value);
  return audienceType === 'leads' || audienceType === 'both';
}

export const MARKETING_CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const;
export type MarketingCampaignStatus = (typeof MARKETING_CAMPAIGN_STATUSES)[number];

export interface ICampaignLocaleContent {
  subject: string;
  htmlContent: string;
  previewText?: string;
  brevoTemplateId?: number;
}

export interface ICampaignAudience {
  /** ISO country codes; empty = all regions */
  countries: string[];
  /** Service interest strings; empty = all services */
  interestedServices: string[];
  /** Canonical service identifiers; legacy interestedServices remains readable. */
  serviceKeys: string[];
  /** Locales to send; empty = all locales that have content */
  locales: MarketingLocale[];
  /** Include customers / professionals; defaults both true via empty = both */
  roles: Array<'customer' | 'professional'>;
}

export interface ICampaignLocaleDelivery {
  locale: MarketingLocale;
  brevoListId?: number;
  brevoCampaignId?: number;
  brevoStatus?: 'created' | 'sent';
  recipientCount: number;
  subscriberCount?: number;
  leadCount?: number;
  deduplicatedRecipientCount?: number;
  criteriaHash?: string;
  stats?: {
    sent: number;
    delivered: number;
    uniqueViews: number;
    uniqueClicks: number;
    unsubscriptions: number;
    softBounces: number;
    hardBounces: number;
  };
  error?: string;
}

export interface IMarketingCampaign extends Document {
  name: string;
  type: MarketingCampaignType;
  status: MarketingCampaignStatus;
  /** Subscribers only, or an invitation campaign that also targets leads. */
  audienceType: MarketingAudienceType;
  /** Content keyed by locale */
  content: Partial<Record<string, ICampaignLocaleContent>>;
  audience: ICampaignAudience;
  /** For reengagement auto-sends: inactive for this many days */
  inactiveDays?: number;
  /** When true, daily cron may pick this draft/scheduled reengagement campaign */
  autoSend: boolean;
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  createdBy?: mongoose.Types.ObjectId;
  deliveries: ICampaignLocaleDelivery[];
  /** Identifies the invocation that currently owns a sending campaign. */
  sendClaimId?: string;
  /** Lease timestamp used to recover abandoned sending campaigns. */
  sendStartedAt?: Date | null;
  /** Number of delivery claims since the campaign was last edited. */
  sendAttempts: number;
  /** Earliest time the daily scheduler may retry a failed delivery. */
  nextRetryAt?: Date | null;
  lastError?: string;
  utmCampaign?: string;
  lastPreviewCount?: number;
  lastPreviewAt?: Date | null;
  lastPreviewCriteriaHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

const localeContentSchema = new Schema<ICampaignLocaleContent>(
  {
    subject: { type: String, required: true, trim: true },
    htmlContent: { type: String, required: true },
    previewText: { type: String, trim: true },
    brevoTemplateId: { type: Number },
  },
  { _id: false },
);

const audienceSchema = new Schema<ICampaignAudience>(
  {
    countries: { type: [String], default: [] },
    interestedServices: { type: [String], default: [] },
    serviceKeys: { type: [String], default: [] },
    locales: { type: [String], enum: MARKETING_LOCALES, default: [] },
    roles: {
      type: [String],
      enum: ['customer', 'professional'],
      default: ['customer', 'professional'],
    },
  },
  { _id: false },
);

const deliverySchema = new Schema<ICampaignLocaleDelivery>(
  {
    locale: { type: String, enum: MARKETING_LOCALES, required: true },
    brevoListId: { type: Number },
    brevoCampaignId: { type: Number },
    brevoStatus: { type: String, enum: ['created', 'sent'] },
    recipientCount: { type: Number, default: 0 },
    subscriberCount: { type: Number, default: 0 },
    leadCount: { type: Number, default: 0 },
    deduplicatedRecipientCount: { type: Number, default: 0 },
    criteriaHash: { type: String, trim: true },
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      uniqueViews: { type: Number, default: 0 },
      uniqueClicks: { type: Number, default: 0 },
      unsubscriptions: { type: Number, default: 0 },
      softBounces: { type: Number, default: 0 },
      hardBounces: { type: Number, default: 0 },
    },
    error: { type: String },
  },
  { _id: false },
);

const marketingCampaignSchema = new Schema<IMarketingCampaign>(
  {
    name: { type: String, required: true, trim: true, index: true },
    type: {
      type: String,
      enum: MARKETING_CAMPAIGN_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: MARKETING_CAMPAIGN_STATUSES,
      default: 'draft',
      index: true,
    },
    // No schema enum: a removed legacy flow may have stored a value outside the
    // current set. Handlers validate new writes and block sends/previews until
    // an unknown stored value is explicitly corrected.
    audienceType: {
      type: String,
      default: 'subscribers',
      trim: true,
      lowercase: true,
      index: true,
    },
    // Mixed keeps old en/nl/fr documents readable while allowing the catalog
    // to grow without another schema deployment.
    content: { type: Schema.Types.Mixed, default: {} },
    audience: {
      type: audienceSchema,
      default: () => ({
        countries: [],
        interestedServices: [],
        serviceKeys: [],
        locales: [],
        roles: ['customer', 'professional'],
      }),
    },
    inactiveDays: { type: Number, min: 1 },
    autoSend: { type: Boolean, default: false },
    scheduledAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    deliveries: { type: [deliverySchema], default: [] },
    sendClaimId: { type: String, index: true },
    sendStartedAt: { type: Date, default: null },
    sendAttempts: { type: Number, default: 0, min: 0 },
    nextRetryAt: { type: Date, default: null, index: true },
    lastError: { type: String },
    utmCampaign: { type: String, trim: true },
    lastPreviewCount: { type: Number, min: 0 },
    lastPreviewAt: { type: Date, default: null },
    lastPreviewCriteriaHash: { type: String, trim: true },
  },
  { timestamps: true },
);

marketingCampaignSchema.index({ type: 1, autoSend: 1, status: 1 });

const MarketingCampaign = mongoose.model<IMarketingCampaign>(
  'MarketingCampaign',
  marketingCampaignSchema,
);

export default MarketingCampaign;
export type { MarketingLocale };
