import mongoose, { Document, Schema } from 'mongoose';

export type FavoriteTargetType = 'professional' | 'project';

export interface IFavorite extends Document {
  user: mongoose.Types.ObjectId;
  targetType: FavoriteTargetType;
  targetId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const favoriteSchema = new Schema<IFavorite>({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  targetType: {
    type: String,
    enum: ['professional', 'project'],
    required: true
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  }
}, {
  timestamps: true
});

favoriteSchema.index({ user: 1, targetType: 1, targetId: 1 }, { unique: true });
favoriteSchema.index({ targetType: 1, targetId: 1 });
favoriteSchema.index({ user: 1, createdAt: -1 });
favoriteSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

const Favorite = mongoose.model<IFavorite>('Favorite', favoriteSchema);

export default Favorite;
