import { Schema, model, Document, Types } from "mongoose";

export interface IExchangeRateSnapshot extends Document {
  _id: Types.ObjectId;
  /** Snapshot key — a single doc per base currency ("EUR" for now). */
  base: string;
  /** ECB reference date, e.g. "2026-10-23". */
  date: string;
  /** EUR-based rates, e.g. { EUR: 1, USD: 1.0812 } */
  rates: Record<string, number>;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ExchangeRateSnapshotSchema = new Schema<IExchangeRateSnapshot>(
  {
    base: { type: String, required: true, default: "EUR", trim: true, uppercase: true },
    date: { type: String, required: true },
    rates: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true }
);

ExchangeRateSnapshotSchema.index({ base: 1 }, { unique: true });

const ExchangeRateSnapshot = model<IExchangeRateSnapshot>(
  "ExchangeRateSnapshot",
  ExchangeRateSnapshotSchema
);

export default ExchangeRateSnapshot;
