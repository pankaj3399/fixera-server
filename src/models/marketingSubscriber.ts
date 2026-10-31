import mongoose, { Document, Schema } from 'mongoose';
import { MARKETING_LOCALES, type MarketingLocale } from '../utils/marketing/marketingCatalog';
export { MARKETING_LOCALES } from '../utils/marketing/marketingCatalog';
export type { MarketingLocale } from '../utils/marketing/marketingCatalog';

export interface IMarketingSubscriber extends Document {
  email: string;
  emailNormalized: string;
  name?: string;
  firstName?: string;
  userId?: mongoose.Types.ObjectId;
  role?: 'customer' | 'professional';
  region?: string;
  interestedServices: string[];
  locale: MarketingLocale;
  localeSource?: 'explicit' | 'country_default' | 'fallback';
  serviceKeys: string[];
  subscribedAt: Date;
  consentVerifiedAt?: Date | null;
  unsubscribedAt?: Date | null;
  brevoUnsubscribedAt?: Date | null;
  brevoUnsubscribeError?: string;
  brevoResubscribeError?: string;
  unsubscribeToken: string;
  source: 'user_sync' | 'manual' | 'signup';
  lastEngagedAt?: Date | null;
  lastCampaignSentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const marketingSubscriberSchema = new Schema<IMarketingSubscriber>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    emailNormalized: {
      type: String,
      lowercase: true,
      trim: true,
      // bulkWrite upserts evaluate this default with `this === null`. A
      // non-null-safe default silently aborted every new subscriber upsert
      // (mongoose returned it in validationErrors), which is the sync defect
      // behind professionals never appearing. Keep the default inert.
      default: function (this: IMarketingSubscriber | null) {
        return this?.email?.trim().toLowerCase();
      },
    },
    name: { type: String, trim: true },
    firstName: { type: String, trim: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    role: {
      type: String,
      enum: ['customer', 'professional'],
      index: true,
    },
    region: {
      type: String,
      trim: true,
      uppercase: true,
      index: true,
    },
    interestedServices: {
      type: [String],
      default: [],
    },
    locale: {
      type: String,
      default: 'en',
      index: true,
    },
    localeSource: {
      type: String,
      enum: ['explicit', 'country_default', 'fallback'],
      default: 'fallback',
    },
    serviceKeys: { type: [String], default: [] },
    subscribedAt: {
      type: Date,
      default: Date.now,
    },
    consentVerifiedAt: {
      type: Date,
      default: null,
    },
    unsubscribedAt: { type: Date, default: null },
    brevoUnsubscribedAt: { type: Date, default: null },
    brevoUnsubscribeError: { type: String },
    brevoResubscribeError: { type: String },
    unsubscribeToken: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    source: {
      type: String,
      enum: ['user_sync', 'manual', 'signup'],
      default: 'user_sync',
    },
    lastCampaignSentAt: {
      type: Date,
      default: null,
    },
    lastEngagedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

marketingSubscriberSchema.index({ unsubscribedAt: 1, region: 1, locale: 1 });
marketingSubscriberSchema.index({ consentVerifiedAt: 1, unsubscribedAt: 1 });
// Reconciliation: pending Brevo suppress/restore sweeps.
marketingSubscriberSchema.index({ unsubscribedAt: 1, brevoUnsubscribedAt: 1, updatedAt: 1 });
marketingSubscriberSchema.index({
  unsubscribedAt: 1,
  consentVerifiedAt: 1,
  brevoUnsubscribedAt: 1,
  updatedAt: 1,
});
marketingSubscriberSchema.index({ unsubscribedAt: 1, role: 1, subscribedAt: 1 });
marketingSubscriberSchema.index({ unsubscribedAt: 1, lastCampaignSentAt: 1, subscribedAt: 1 });
marketingSubscriberSchema.index({ unsubscribedAt: 1, lastEngagedAt: 1, subscribedAt: 1 });
marketingSubscriberSchema.index({ subscribedAt: -1 });
marketingSubscriberSchema.index({ emailNormalized: 1 }, { unique: true, sparse: true });

const MarketingSubscriber = mongoose.model<IMarketingSubscriber>(
  'MarketingSubscriber',
  marketingSubscriberSchema,
);

export default MarketingSubscriber;
