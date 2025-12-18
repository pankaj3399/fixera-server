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

  // If connection is in progress, wait for it
  if (mongoose.connection.readyState === 2) {
    await new Promise<void>((resolve) => {
      mongoose.connection.once('connected', () => resolve());
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