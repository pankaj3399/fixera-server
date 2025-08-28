import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

declare global {
  var mongooseConn: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } | undefined;
}

const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌ MONGODB_URI is not defined in .env file');
    process.exit(1);
  }

  // Reuse existing connection if already connected or connecting
  if (!global.mongooseConn) {
    global.mongooseConn = { conn: null, promise: null };
  }
  if (global.mongooseConn.conn) {
    return;
  }
  if (!global.mongooseConn.promise) {
    console.log('🟡 Connecting to MongoDB...');
    global.mongooseConn.promise = mongoose.connect(mongoUri).then((m) => {
      console.log('✅ MongoDB connected successfully!');
      return m;
    });
  }
  await global.mongooseConn.promise;
  global.mongooseConn.conn = mongoose;
};

export default connectDB;