import mongoose, { Document, Schema } from 'mongoose';

export type EmailLogStatus = 'sent' | 'failed' | 'skipped';

export interface IEmailLog extends Document {
  to: string;
  subject: string;
  template: string;
  status: EmailLogStatus;
  errorMessage?: string;
  relatedBooking?: mongoose.Types.ObjectId;
  relatedUser?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const emailLogSchema = new Schema<IEmailLog>({
  to: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  subject: { type: String, required: true, trim: true, maxlength: 500 },
  template: { type: String, required: true, trim: true, maxlength: 100, default: 'unknown' },
  status: { type: String, enum: ['sent', 'failed', 'skipped'], required: true },
  errorMessage: { type: String, trim: true, maxlength: 2000 },
  relatedBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  relatedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true
});

emailLogSchema.index({ to: 1, createdAt: -1 });
emailLogSchema.index({ template: 1, createdAt: -1 });
emailLogSchema.index({ relatedBooking: 1, createdAt: -1 });
emailLogSchema.index({ status: 1, createdAt: -1 });
emailLogSchema.index({ createdAt: -1 });

const EmailLog = mongoose.model<IEmailLog>('EmailLog', emailLogSchema);

export default EmailLog;
