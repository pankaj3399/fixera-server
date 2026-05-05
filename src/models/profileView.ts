import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IProfileView extends Document {
  professional: Types.ObjectId;
  viewer?: Types.ObjectId;
  visitorKey: string;
  dayKey: string;
  createdAt: Date;
}

const profileViewSchema = new Schema<IProfileView>(
  {
    professional: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    viewer: { type: Schema.Types.ObjectId, ref: 'User' },
    visitorKey: { type: String, required: true },
    dayKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

profileViewSchema.index(
  { professional: 1, visitorKey: 1, dayKey: 1 },
  { unique: true }
);
profileViewSchema.index({ professional: 1, createdAt: -1 });

export default (mongoose.models.ProfileView as mongoose.Model<IProfileView>) ||
  mongoose.model<IProfileView>('ProfileView', profileViewSchema);
