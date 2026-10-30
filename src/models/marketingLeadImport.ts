import mongoose, { Document, Schema } from 'mongoose';

export const MARKETING_LEAD_IMPORT_STATUSES = [
  'processing',
  'completed',
  'partial',
  'duplicate_only',
  'failed',
] as const;
export type MarketingLeadImportStatus = (typeof MARKETING_LEAD_IMPORT_STATUSES)[number];

export interface IMarketingLeadImportError {
  row: number;
  field?: string;
  message: string;
}

// Mongoose documents expose their own validation `errors` map, so the stored
// row-error list uses `rowErrors`. The API still exposes it as `errors`.
export interface IMarketingLeadImport extends Document {
  filename: string;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedAt: Date;
  status: MarketingLeadImportStatus;
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
  suppressedRows: number;
  fileError?: string | null;
  rowErrors: IMarketingLeadImportError[];
  createdAt: Date;
  updatedAt: Date;
}

const errorSchema = new Schema<IMarketingLeadImportError>(
  {
    row: { type: Number, required: true, min: 1 },
    field: { type: String, trim: true },
    message: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const marketingLeadImportSchema = new Schema<IMarketingLeadImport>(
  {
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now },
    status: { type: String, enum: MARKETING_LEAD_IMPORT_STATUSES, required: true },
    totalRows: { type: Number, default: 0, min: 0 },
    importedRows: { type: Number, default: 0, min: 0 },
    duplicateRows: { type: Number, default: 0, min: 0 },
    failedRows: { type: Number, default: 0, min: 0 },
    suppressedRows: { type: Number, default: 0, min: 0 },
    fileError: { type: String, trim: true },
    rowErrors: { type: [errorSchema], default: [] },
  },
  { timestamps: true },
);

marketingLeadImportSchema.index({ uploadedAt: -1 });
marketingLeadImportSchema.index({ uploadedBy: 1, uploadedAt: -1 });

const MarketingLeadImport = mongoose.model<IMarketingLeadImport>(
  'MarketingLeadImport',
  marketingLeadImportSchema,
);

export default MarketingLeadImport;
