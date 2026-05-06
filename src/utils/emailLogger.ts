import mongoose from 'mongoose';
import EmailLog, { EmailLogStatus } from '../models/emailLog';

interface LogEmailInput {
  to: string;
  subject: string;
  template: string;
  status: EmailLogStatus;
  errorMessage?: string;
  relatedBooking?: string | mongoose.Types.ObjectId;
  relatedUser?: string | mongoose.Types.ObjectId;
}

const toObjectId = (value?: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId | undefined => {
  if (!value) return undefined;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === 'string' && mongoose.Types.ObjectId.isValid(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return undefined;
};

export const logEmail = async (input: LogEmailInput): Promise<void> => {
  try {
    await EmailLog.create({
      to: input.to,
      subject: input.subject,
      template: input.template || 'unknown',
      status: input.status,
      errorMessage: input.errorMessage,
      relatedBooking: toObjectId(input.relatedBooking),
      relatedUser: toObjectId(input.relatedUser),
    });
  } catch (err: any) {
    console.error('Failed to write EmailLog entry:', err?.message || err);
  }
};
