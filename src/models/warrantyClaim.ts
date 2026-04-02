import mongoose, { Document, Schema, Types, model } from "mongoose";

export type WarrantyClaimStatus =
  | "open"
  | "proposal_sent"
  | "proposal_accepted"
  | "resolved"
  | "escalated"
  | "closed";

export type WarrantyClaimReason =
  | "defect"
  | "incomplete_work"
  | "material_issue"
  | "functionality_issue"
  | "safety_issue"
  | "other";

export interface IWarrantyClaim extends Document {
  _id: Types.ObjectId;
  claimNumber: string;
  booking: Types.ObjectId;
  customer: Types.ObjectId;
  professional: Types.ObjectId;
  status: WarrantyClaimStatus;
  reason: WarrantyClaimReason;
  description: string;
  evidence: string[];
  warrantyEndsAt?: Date;
  openedAt: Date;
  proposal?: {
    message: string;
    resolveByDate?: Date;
    proposedScheduleAt?: Date;
    proposedBy: Types.ObjectId;
    proposedAt: Date;
    customerDecision?: "accepted" | "declined";
    decidedAt?: Date;
    decisionNote?: string;
  };
  escalation?: {
    escalatedAt: Date;
    escalatedBy: Types.ObjectId;
    autoEscalated: boolean;
    reason: string;
    note?: string;
  };
  resolution?: {
    summary: string;
    attachments?: string[];
    resolvedAt: Date;
    resolvedBy: Types.ObjectId;
    customerConfirmedAt?: Date;
    confirmedBy?: Types.ObjectId;
    autoClosedAt?: Date;
  };
  sla?: {
    professionalResponseDueAt?: Date;
    customerConfirmationDueAt?: Date;
    customerAutoCloseDays: number;
  };
  statusHistory: {
    status: WarrantyClaimStatus;
    timestamp: Date;
    updatedBy?: Types.ObjectId;
    note?: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const WarrantyClaimSchema = new Schema<IWarrantyClaim>(
  {
    claimNumber: {
      type: String,
      unique: true,
      index: true,
    },
    booking: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    customer: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    professional: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        "open",
        "proposal_sent",
        "proposal_accepted",
        "resolved",
        "escalated",
        "closed",
      ],
      default: "open",
      required: true,
      index: true,
    },
    reason: {
      type: String,
      enum: [
        "defect",
        "incomplete_work",
        "material_issue",
        "functionality_issue",
        "safety_issue",
        "other",
      ],
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    evidence: [{ type: String }],
    warrantyEndsAt: { type: Date },
    openedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    proposal: {
      message: { type: String, maxlength: 3000 },
      resolveByDate: { type: Date },
      proposedScheduleAt: { type: Date },
      proposedBy: { type: Schema.Types.ObjectId, ref: "User" },
      proposedAt: { type: Date },
      customerDecision: { type: String, enum: ["accepted", "declined"] },
      decidedAt: { type: Date },
      decisionNote: { type: String, maxlength: 1000 },
    },
    escalation: {
      escalatedAt: { type: Date },
      escalatedBy: { type: Schema.Types.ObjectId, ref: "User" },
      autoEscalated: { type: Boolean, default: false },
      reason: { type: String, maxlength: 500 },
      note: { type: String, maxlength: 1000 },
    },
    resolution: {
      summary: { type: String, maxlength: 3000 },
      attachments: [{ type: String }],
      resolvedAt: { type: Date },
      resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
      customerConfirmedAt: { type: Date },
      confirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
      autoClosedAt: { type: Date },
    },
    sla: {
      professionalResponseDueAt: { type: Date },
      customerConfirmationDueAt: { type: Date },
      customerAutoCloseDays: { type: Number, min: 1, max: 60, default: 7 },
    },
    statusHistory: [
      {
        status: {
          type: String,
          enum: [
            "open",
            "proposal_sent",
            "proposal_accepted",
            "resolved",
            "escalated",
            "closed",
          ],
          required: true,
        },
        timestamp: {
          type: Date,
          default: Date.now,
          required: true,
        },
        updatedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        note: {
          type: String,
          maxlength: 1000,
        },
      },
    ],
  },
  { timestamps: true }
);

WarrantyClaimSchema.index({ status: 1, createdAt: -1 });
WarrantyClaimSchema.index({ professional: 1, status: 1, createdAt: -1 });
WarrantyClaimSchema.index({ customer: 1, status: 1, createdAt: -1 });
WarrantyClaimSchema.index({ "sla.professionalResponseDueAt": 1, status: 1 });
WarrantyClaimSchema.index({ "sla.customerConfirmationDueAt": 1, status: 1 });

WarrantyClaimSchema.pre("save", async function (next) {
  if (this.isNew && !this.claimNumber) {
    const year = new Date().getFullYear();
    const db = mongoose.connection.db;
    if (!db) {
      return next(new Error("MongoDB connection unavailable for claim counter"));
    }
    const countersCollection = db.collection<{ _id: string; seq: number }>("counters");
    const counter = await countersCollection.findOneAndUpdate(
      { _id: `warrantyClaimNumber-${year}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    const seq = counter?.seq ?? 1;
    this.claimNumber = `WC-${year}-${String(seq).padStart(6, "0")}`;
  }

  if (this.isNew && this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status,
      timestamp: new Date(),
      note: "Warranty claim opened",
    });
  }

  next();
});

WarrantyClaimSchema.methods.updateStatus = function (
  newStatus: WarrantyClaimStatus,
  updatedBy?: Types.ObjectId,
  note?: string
) {
  this.status = newStatus;
  this.statusHistory.push({
    status: newStatus,
    timestamp: new Date(),
    updatedBy,
    note,
  });
  return this.save();
};

const WarrantyClaim = model<IWarrantyClaim>("WarrantyClaim", WarrantyClaimSchema);

export default WarrantyClaim;
