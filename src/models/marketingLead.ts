import mongoose, { Document, Schema } from 'mongoose';
import { MARKETING_LOCALES, type MarketingLocale } from '../utils/marketing/marketingCatalog';
export { MARKETING_LOCALES } from '../utils/marketing/marketingCatalog';
export type { MarketingLocale } from '../utils/marketing/marketingCatalog';

export const MARKETING_LEAD_STATUSES = ['active', 'deleted'] as const;
export type MarketingLeadStatus = (typeof MARKETING_LEAD_STATUSES)[number];

export interface IMarketingLead extends Document {
  email: string;
  emailNormalized: string;
  country: string;
  locale: MarketingLocale;
  serviceKeys: string[];
  primaryServiceKey: string;
  interestedServices: string[];
  identityHash: string;
  status: MarketingLeadStatus;
  unsubscribedAt?: Date | null;
  deletedAt?: Date | null;
  lastCampaignSentAt?: Date | null;
  sourceImportId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const marketingLeadSchema = new Schema<IMarketingLead>(
  {
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    emailNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },
    country: { type: String, required: true, trim: true, uppercase: true, maxlength: 2 },
    locale: { type: String, enum: MARKETING_LOCALES, required: true },
    serviceKeys: { type: [String], default: [] },
    primaryServiceKey: { type: String, required: true, trim: true },
    interestedServices: { type: [String], default: [] },
    identityHash: { type: String, required: true, trim: true },
    status: { type: String, enum: MARKETING_LEAD_STATUSES, default: 'active' },
    unsubscribedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    lastCampaignSentAt: { type: Date, default: null },
    sourceImportId: {
      type: Schema.Types.ObjectId,
      ref: 'MarketingLeadImport',
    },
  },
  { timestamps: true },
);

// Exact normalized tuple uniqueness. Legacy documents without identityHash
// stay outside the index and are hidden by every query.
marketingLeadSchema.index(
  { identityHash: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active', identityHash: { $exists: true } },
  },
);
marketingLeadSchema.index({ status: 1, country: 1, locale: 1, serviceKeys: 1 });
marketingLeadSchema.index({ status: 1, primaryServiceKey: 1 });
marketingLeadSchema.index({ status: 1, createdAt: -1 });
marketingLeadSchema.index({ emailNormalized: 1 });
marketingLeadSchema.index({ sourceImportId: 1 });

const MarketingLead = mongoose.model<IMarketingLead>('MarketingLead', marketingLeadSchema);

export default MarketingLead;
