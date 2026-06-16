import { Schema, model, Document, Types } from "mongoose";

export type CancellationRequestStatus =
  | "pending"
  | "processing"
  | "negotiating"
  | "escalated"
  | "approved"
  | "denied";

export type CancellationProfessionalDecision = "approved" | "counter" | "rejected";
export type CancellationCustomerDecision = "accepted" | "refused";
export type CancellationEscalationReason = "rejected" | "refused" | "no_response";

export const CANCELLATION_REASON_CATEGORIES = [
  "no_show",
  "not_as_described",
  "extra_payment_requested",
  "poor_communication",
  "no_longer_needed",
  "found_alternative",
  "requirements_changed",
  "scheduling_conflict",
  "trust_concerns",
  "other",
] as const;

export type CancellationReasonCategory =
  (typeof CANCELLATION_REASON_CATEGORIES)[number];

export const CANCELLATION_REASON_LABELS: Record<CancellationReasonCategory, string> = {
  no_show: "Professional didn't show up (No-show)",
  not_as_described: "Service not as described in booking/chat",
  extra_payment_requested: "Professional requested extra payment not agreed upon",
  poor_communication: "Poor communication / unresponsive professional",
  no_longer_needed: "I no longer need the service or booked by mistake",
  found_alternative: "Found a better or cheaper alternative",
  requirements_changed: "Project requirements changed significantly",
  scheduling_conflict: "Scheduling conflict",
  trust_concerns: "Safety, quality or trust concerns",
  other: "Other",
};

export interface ICancellationRequest extends Document {
  _id: Types.ObjectId;
  booking: Types.ObjectId;
  requestedBy: Types.ObjectId;
  requestedRole: "customer" | "professional";
  reasonCategory?: CancellationReasonCategory;
  reason: string;
  evidence: string[];
  status: CancellationRequestStatus;
  // Customer-initiated negotiation between customer and professional
  responseDeadline?: Date;
  professionalDecision?: CancellationProfessionalDecision;
  professionalNote?: string;
  counterOfferAmount?: number;
  professionalRespondedAt?: Date;
  customerDecision?: CancellationCustomerDecision;
  customerRespondedAt?: Date;
  escalatedAt?: Date;
  escalationReason?: CancellationEscalationReason;
  // Final resolution (professional approval or admin)
  resolvedAt?: Date;
  resolvedBy?: Types.ObjectId;
  denyReason?: string;
  refundAmount?: number;
  refundedAt?: Date;
  resolutionNotes?: string;
  resolutionAttachments?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const CancellationRequestSchema = new Schema<ICancellationRequest>(
  {
    booking: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    requestedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    requestedRole: {
      type: String,
      enum: ["customer", "professional"],
      required: true,
    },
    reasonCategory: {
      type: String,
      enum: CANCELLATION_REASON_CATEGORIES,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    evidence: {
      type: [{ type: String, maxlength: 2048 }],
      default: [],
      validate: {
        validator: (val: string[]) => !val || val.length <= 10,
        message: "evidence cannot exceed 10 items",
      },
    },
    status: {
      type: String,
      enum: ["pending", "processing", "negotiating", "escalated", "approved", "denied"],
      default: "pending",
      required: true,
      index: true,
    },
    responseDeadline: { type: Date },
    professionalDecision: { type: String, enum: ["approved", "counter", "rejected"] },
    professionalNote: { type: String, trim: true, maxlength: 1000 },
    counterOfferAmount: { type: Number, min: 0 },
    professionalRespondedAt: { type: Date },
    customerDecision: { type: String, enum: ["accepted", "refused"] },
    customerRespondedAt: { type: Date },
    escalatedAt: { type: Date },
    escalationReason: { type: String, enum: ["rejected", "refused", "no_response"] },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    denyReason: { type: String, trim: true, maxlength: 500 },
    refundAmount: { type: Number, min: 0 },
    refundedAt: { type: Date },
    resolutionNotes: { type: String, trim: true, maxlength: 1000 },
    resolutionAttachments: { type: [String], default: [] },
  },
  { timestamps: true }
);

export const ACTIVE_CANCELLATION_STATUSES = ["pending", "processing", "negotiating", "escalated"];

CancellationRequestSchema.index({ booking: 1, status: 1 });
CancellationRequestSchema.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_CANCELLATION_STATUSES } } }
);
CancellationRequestSchema.index({ status: 1, responseDeadline: 1 });

const CancellationRequest = model<ICancellationRequest>(
  "CancellationRequest",
  CancellationRequestSchema
);

export default CancellationRequest;
