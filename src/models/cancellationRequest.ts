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

export interface ICancellationRequest extends Document {
  _id: Types.ObjectId;
  booking: Types.ObjectId;
  requestedBy: Types.ObjectId;
  requestedRole: "customer" | "professional";
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
