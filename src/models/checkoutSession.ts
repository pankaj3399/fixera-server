import { Schema, model, Document, Types } from "mongoose";

/**
 * FT2-4B: a wizard checkout that has not been paid yet.
 *
 * The booking wizard used to create the Booking (status quote_accepted) and
 * reserve the professional's calendar before the customer had paid. A paid
 * checkout now lives here until its payment is confirmed: no Booking row, no
 * calendar reservation and no notification exists for it. The confirmed
 * payment (Stripe webhook or the confirm endpoint) promotes it to a Booking
 * that reuses this document's `_id`, so the PaymentIntent's metadata.bookingId,
 * the referral reservation and every downstream effect keep using one id.
 *
 * Open sessions are abandoned (intent cancelled, referral released, row
 * deleted) on the payment page's back button, when the same customer starts a
 * new checkout, and by the expiry sweep. `purgeAt` is a TTL backstop.
 */
export type CheckoutSessionStatus = "open" | "promoted" | "conflict";

export interface ICheckoutSchedule {
  projectId: string;
  subprojectIndex?: number;
  startDate?: string;
  startTime?: string;
  customerBlocks?: any;
  quantity?: number;
  requestTimeZone?: string;
}

export interface ICheckoutSession extends Document {
  _id: Types.ObjectId;
  customer: Types.ObjectId;
  professional?: Types.ObjectId;
  project?: Types.ObjectId;
  /** The prepared Booking payload, exactly as createBooking would have saved it. */
  bookingData: Record<string, any>;
  /** Inputs to re-check availability when the payment is confirmed. */
  schedule?: ICheckoutSchedule;
  /** Same shape as Booking.payment; written by createPaymentIntent. */
  payment?: Record<string, any>;
  /** Payment-row fields to upsert when the session is promoted. */
  paymentRow?: Record<string, any>;
  status: CheckoutSessionStatus;
  expiresAt: Date;
  purgeAt: Date;
  promotedAt?: Date;
  conflictAt?: Date;
  conflictReason?: string;
  /** Set once the conflict refund was issued and the referral released. */
  refundedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CheckoutSessionSchema = new Schema<ICheckoutSession>(
  {
    customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    professional: { type: Schema.Types.ObjectId, ref: "User" },
    project: { type: Schema.Types.ObjectId, ref: "Project" },
    bookingData: { type: Schema.Types.Mixed, required: true },
    schedule: { type: Schema.Types.Mixed },
    payment: { type: Schema.Types.Mixed },
    paymentRow: { type: Schema.Types.Mixed },
    status: { type: String, enum: ["open", "promoted", "conflict"], default: "open", required: true },
    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true },
    promotedAt: Date,
    conflictAt: Date,
    conflictReason: String,
    refundedAt: Date,
  },
  { timestamps: true, minimize: false },
);

CheckoutSessionSchema.index({ customer: 1, status: 1 });
CheckoutSessionSchema.index({ status: 1, expiresAt: 1 });
CheckoutSessionSchema.index({ "payment.stripePaymentIntentId": 1 }, { sparse: true });
// TTL backstop: nothing of an unpaid checkout survives this date.
CheckoutSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const CheckoutSession = model<ICheckoutSession>("CheckoutSession", CheckoutSessionSchema);

export default CheckoutSession;
