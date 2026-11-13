import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Append-only archive of booking manipulations (Booking & Quotation page
 * phase 2). One row per status transition, written centrally by the Booking
 * model hooks (utils/bookingEvents/archive.ts), with the executioner, note
 * and a snapshot of the context at that moment (dispute, cancellation,
 * reschedule request, completion evidence, quote rejection). Rows are never
 * updated: later edits of the booking (e.g. a second dispute overwriting
 * `booking.dispute`) cannot erase what happened before.
 *
 * Anonymization redacts free text here like it does on the booking.
 */
export interface IBookingEvent extends Document {
  booking: Types.ObjectId;
  type: 'status_changed';
  at: Date;
  statusFrom?: string | null;
  statusTo: string;
  actor?: Types.ObjectId | null;
  actorRole: 'customer' | 'professional' | 'admin' | 'employee' | 'system';
  /** True when the actor came from the statusHistory entry itself. */
  actorFromEntry: boolean;
  note?: string;
  context?: Record<string, unknown>;
  /** Evidence URLs captured with the context (resolved/presigned on read). */
  attachments: string[];
  createdAt: Date;
}

const BookingEventSchema = new Schema<IBookingEvent>(
  {
    booking: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    type: { type: String, enum: ['status_changed'], required: true },
    at: { type: Date, required: true },
    statusFrom: { type: String, default: null },
    statusTo: { type: String, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: {
      type: String,
      enum: ['customer', 'professional', 'admin', 'employee', 'system'],
      required: true,
    },
    actorFromEntry: { type: Boolean, default: false },
    note: { type: String, maxlength: 1000 },
    context: { type: Schema.Types.Mixed },
    attachments: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

BookingEventSchema.index({ booking: 1, at: 1 });

const BookingEvent = mongoose.model<IBookingEvent>('BookingEvent', BookingEventSchema);
export default BookingEvent;
