import { Schema, model, Document } from "mongoose";

type StripeEventProcessingStatus = "processing" | "processed" | "failed";

export interface IStripeEvent extends Document {
  eventId: string;
  eventType: string;
  status: StripeEventProcessingStatus;
  attempts: number;
  stripeCreatedAt?: Date;
  firstSeenAt: Date;
  lastAttemptAt: Date;
  processedAt?: Date;
  lastError?: string;
  expiresAt: Date;
}

const StripeEventSchema = new Schema<IStripeEvent>(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true },
    status: {
      type: String,
      enum: ["processing", "processed", "failed"],
      default: "processing",
      required: true,
    },
    attempts: { type: Number, default: 1, min: 1 },
    stripeCreatedAt: { type: Date },
    firstSeenAt: { type: Date, default: Date.now },
    lastAttemptAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    lastError: { type: String, maxlength: 2000 },
    // Retain event records for 90 days to preserve durable dedup while limiting storage growth.
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

StripeEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const StripeEvent = model<IStripeEvent>("StripeEvent", StripeEventSchema);

export default StripeEvent;

