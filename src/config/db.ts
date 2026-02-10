// src/config/db.ts
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Cache the connection for serverless environments
let isConnected = false;

const connectDB = async () => {
  // If already connected, return immediately
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }

  // If connection is in progress, wait for it (with error + timeout)
  if (mongoose.connection.readyState === 2) {
    const CONNECTION_TIMEOUT_MS = 30_000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        mongoose.connection.removeListener('connected', onConnected);
        mongoose.connection.removeListener('error', onError);
        clearTimeout(timer);
      };
      const onConnected = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`MongoDB connection timed out after ${CONNECTION_TIMEOUT_MS}ms`));
      }, CONNECTION_TIMEOUT_MS);
      mongoose.connection.once('connected', onConnected);
      mongoose.connection.once('error', onError);
    });
    isConnected = true;
    return;
  }

  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('❌ MONGODB_URI is not defined in .env file');
      throw new Error('MONGODB_URI is not defined');
    }

    // Set mongoose options for serverless
    mongoose.set('bufferCommands', false);

    console.log('🟡 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    isConnected = true;
    console.log('✅ MongoDB connected successfully!');
  } catch (error) {
    console.error('❌ MongoDB connection error:', (error as Error).message);
    isConnected = false;
    throw error; // Don't exit process, throw error instead
  }
};

export default connectDB;