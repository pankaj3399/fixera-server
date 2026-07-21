import mongoose, { Document, Schema, Types } from 'mongoose';
import type { PrefCategory, NotificationEntityType } from '../utils/notifications/types';
import { NOTIFICATION_ENTITY_TYPES } from '../utils/notifications/types';

export type { NotificationEntityType };

export interface INotification extends Document {
  userId: Types.ObjectId;
  eventKey: string;
  category: PrefCategory;
  title: string;
  body: string;
  clickUrl: string;
  entityType?: NotificationEntityType;
  entityId?: Types.ObjectId;
  readAt: Date | null;
  emailAttempted: boolean;
  emailSent: boolean;
  pushAttempted: boolean;
  pushSent: boolean;
  meta?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    eventKey: { type: String, required: true, trim: true, maxlength: 120 },
    category: {
      type: String,
      enum: ['booking_updates', 'messages', 'promotions', 'system'],
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    clickUrl: { type: String, required: true, trim: true, maxlength: 500 },
    entityType: {
      type: String,
      enum: [...NOTIFICATION_ENTITY_TYPES],
    },
    entityId: { type: Schema.Types.ObjectId },
    readAt: { type: Date, default: null },
    emailAttempted: { type: Boolean, default: false },
    emailSent: { type: Boolean, default: false },
    pushAttempted: { type: Boolean, default: false },
    pushSent: { type: Boolean, default: false },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, eventKey: 1, entityId: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>('Notification', notificationSchema);

export default Notification;
