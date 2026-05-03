import { Schema, model, Document, Types } from "mongoose";

export type CmsContentType = "blog" | "news" | "faq" | "policy" | "landing";
export type CmsContentStatus = "draft" | "published";

export const CMS_CONTENT_TYPES: CmsContentType[] = ["blog", "news", "faq", "policy", "landing"];
export const CMS_CONTENT_STATUSES: CmsContentStatus[] = ["draft", "published"];

export const FAQ_CATEGORIES = [
  { slug: "general", name: "General" },
  { slug: "booking", name: "Booking" },
  { slug: "payments-invoicing", name: "Payments & Invoicing" },
  { slug: "warranty-disputes", name: "Warranty & Disputes" },
  { slug: "professionals", name: "For Professionals" },
  { slug: "account", name: "Account & Profile" },
] as const;

export const FAQ_CATEGORY_SLUGS = FAQ_CATEGORIES.map((c) => c.slug) as string[];

export interface ICmsSeo {
  titleTag?: string;
  metaDescription?: string;
  ogTitle?: string;
  ogImage?: string;
  canonical?: string;
  noindex?: boolean;
}

export interface ICmsContent extends Document {
  _id: Types.ObjectId;
  type: CmsContentType;
  title: string;
  slug: string;
  locale: string;
  body: string;
  excerpt?: string;
  coverImage?: string;
  category?: string;
  tags: string[];
  status: CmsContentStatus;
  author?: Types.ObjectId;
  authorOverride?: string;
  publishedAt?: Date;
  seo: ICmsSeo;
  relatedContent: Types.ObjectId[];
  relatedServices: Types.ObjectId[];
  relatedServiceSlug?: string;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const CmsSeoSchema = new Schema<ICmsSeo>(
  {
    titleTag: { type: String, trim: true, maxlength: 120 },
    metaDescription: { type: String, trim: true, maxlength: 300 },
    ogTitle: { type: String, trim: true, maxlength: 120 },
    ogImage: { type: String, trim: true },
    canonical: { type: String, trim: true },
    noindex: { type: Boolean, default: false },
  },
  { _id: false }
);

const CmsContentSchema = new Schema<ICmsContent>(
  {
    type: {
      type: String,
      enum: CMS_CONTENT_TYPES,
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    locale: { type: String, required: true, default: "en", lowercase: true, trim: true },
    body: { type: String, default: "" },
    excerpt: { type: String, trim: true, maxlength: 500 },
    coverImage: { type: String, trim: true },
    category: { type: String, trim: true, lowercase: true },
    tags: [{ type: String, trim: true, lowercase: true }],
    status: {
      type: String,
      enum: CMS_CONTENT_STATUSES,
      default: "draft",
      index: true,
    },
    author: { type: Schema.Types.ObjectId, ref: "User" },
    authorOverride: { type: String, trim: true, maxlength: 120 },
    publishedAt: { type: Date },
    seo: { type: CmsSeoSchema, default: () => ({}) },
    relatedContent: [{ type: Schema.Types.ObjectId, ref: "CmsContent" }],
    relatedServices: [{ type: Schema.Types.ObjectId, ref: "ServiceCategory" }],
    relatedServiceSlug: { type: String, trim: true, lowercase: true, maxlength: 200 },
    viewCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

CmsContentSchema.index({ type: 1, slug: 1, locale: 1 }, { unique: true });
CmsContentSchema.index({ type: 1, status: 1, publishedAt: -1 });
CmsContentSchema.index({ tags: 1 });
CmsContentSchema.index({ category: 1 });
CmsContentSchema.index({ relatedServiceSlug: 1, type: 1, status: 1 });
CmsContentSchema.index({ title: "text", excerpt: "text" });

CmsContentSchema.pre("save", function (next) {
  if (this.status === "published" && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  if (this.isModified("status") && this.status !== "published") {
    this.publishedAt = undefined;
  }
  if (this.isModified("tags") && Array.isArray(this.tags)) {
    this.tags = Array.from(
      new Set(
        this.tags
          .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
          .filter((t) => t.length > 0 && t.length <= 40)
      )
    ).slice(0, 20);
  }
  next();
});

const CmsContent = model<ICmsContent>("CmsContent", CmsContentSchema);

export default CmsContent;
