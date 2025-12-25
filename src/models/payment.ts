import { Schema, model, Document, Types } from "mongoose";

export type PaymentStatus =
  | "pending"
  | "authorized"
  | "completed"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "expired";

export interface IPaymentRefund {
  amount: number;
  reason?: string;
  refundId?: string;
  refundedAt: Date;
  source: "professional" | "platform" | "mixed";
  notes?: string;
}

export interface IPayment extends Document {
  booking: Types.ObjectId;
  bookingNumber?: string;
  customer: Types.ObjectId;
  professional?: Types.ObjectId;
  status: PaymentStatus;
  method?: "card" | "bank_transfer" | "cash";

  currency: string;
  amount: number;
  netAmount?: number;
  vatAmount?: number;
  vatRate?: number;
  totalWithVat?: number;
  platformCommission?: number;
  professionalPayout?: number;

  stripePaymentIntentId?: string;
  stripeClientSecret?: string;
  stripeChargeId?: string;
  stripeTransferId?: string;
  stripeDestinationPayment?: string;

  refunds: IPaymentRefund[];

  authorizedAt?: Date;
  capturedAt?: Date;
  transferredAt?: Date;
  refundedAt?: Date;
  canceledAt?: Date;

  invoiceNumber?: string;
  invoiceUrl?: string;
  invoiceGeneratedAt?: Date;

  metadata?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

const PaymentRefundSchema = new Schema<IPaymentRefund>(
  {
    amount: { type: Number, required: true },
    reason: { type: String, maxlength: 500 },
    refundId: { type: String },
    refundedAt: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ["professional", "platform", "mixed"],
      default: "platform",
      required: true,
    },
    notes: { type: String, maxlength: 1000 },
  },
  { _id: false }
);

const PaymentSchema = new Schema<IPayment>(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, unique: true },
    bookingNumber: { type: String },
    customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    professional: { type: Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: ["pending", "authorized", "completed", "failed", "refunded", "partially_refunded", "expired"],
      default: "pending",
      required: true,
    },
    method: {
      type: String,
      enum: ["card", "bank_transfer", "cash"],
    },

    currency: { type: String, enum: ["USD", "EUR", "GBP", "CAD", "AUD"], default: "EUR" },
    amount: { type: Number, required: true },
    netAmount: { type: Number },
    vatAmount: { type: Number },
    vatRate: { type: Number },
    totalWithVat: { type: Number },
    platformCommission: { type: Number },
    professionalPayout: { type: Number },

    stripePaymentIntentId: { type: String },
    stripeClientSecret: { type: String },
    stripeChargeId: { type: String },
    stripeTransferId: { type: String },
    stripeDestinationPayment: { type: String },

    refunds: { type: [PaymentRefundSchema], default: [] },

    authorizedAt: { type: Date },
    capturedAt: { type: Date },
    transferredAt: { type: Date },
    refundedAt: { type: Date },
    canceledAt: { type: Date },

    invoiceNumber: { type: String },
    invoiceUrl: { type: String },
    invoiceGeneratedAt: { type: Date },

    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

PaymentSchema.index({ status: 1 });
PaymentSchema.index({ customer: 1, status: 1 });
PaymentSchema.index({ professional: 1, status: 1 });
PaymentSchema.index({ bookingNumber: 1 });

const Payment = model<IPayment>("Payment", PaymentSchema);

export default Payment;
