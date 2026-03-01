/**
 * Migration: Deduplicate conversations so that each (customerId, professionalId)
 * pair has only one conversation. Must be run BEFORE the new unique index is created.
 *
 * Usage: npx ts-node src/scripts/migrateConversationDedup.ts
 */
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

import mongoose from "mongoose";
import connectDB from "../config/db";
import Conversation from "../models/conversation";
import ChatMessage from "../models/chatMessage";

async function dropOldIndexIfExists() {
  try {
    await Conversation.collection.dropIndex("customerId_1_professionalId_1_bookingId_1");
    console.log("Dropped old bookingId compound index.");
  } catch (error: unknown) {
    const mongoErr = error as { code?: number };
    if (mongoErr.code === 27) {
      console.log("Old bookingId compound index not found (already dropped or never existed).");
    } else {
      throw error;
    }
  }
}

async function run() {
  await connectDB();

  try {
    console.log("Finding duplicate conversation pairs...");

    const duplicates = await Conversation.aggregate([
      {
        $group: {
          _id: { customerId: "$customerId", professionalId: "$professionalId" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
          earliest: { $min: "$createdAt" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);

    if (duplicates.length === 0) {
      console.log("No duplicate conversations found. Safe to create unique index.");
      await dropOldIndexIfExists();
      return;
    }

    console.log(`Found ${duplicates.length} duplicate pairs. Merging...`);

    for (const dup of duplicates) {
      const allIds: mongoose.Types.ObjectId[] = dup.ids;

      // Keep the earliest conversation as canonical
      const canonical = await Conversation.findOne({
        _id: { $in: allIds },
      }).sort({ createdAt: 1 });

      if (!canonical) continue;

      const duplicateIds = allIds.filter((id) => id.toString() !== canonical._id.toString());

      console.log(
        `Pair customer=${dup._id.customerId} professional=${dup._id.professionalId}: ` +
          `keeping ${canonical._id}, merging ${duplicateIds.length} duplicates`
      );

      // Move messages from duplicate conversations to the canonical one
      const result = await ChatMessage.updateMany(
        { conversationId: { $in: duplicateIds } },
        { $set: { conversationId: canonical._id } }
      );
      console.log(`  Moved ${result.modifiedCount} messages to canonical conversation`);

      // Update canonical conversation's lastMessageAt if needed
      const latestMessage = await ChatMessage.findOne({ conversationId: canonical._id })
        .sort({ createdAt: -1 })
        .select("createdAt");
      if (latestMessage) {
        await Conversation.updateOne(
          { _id: canonical._id },
          { $set: { lastMessageAt: latestMessage.createdAt } }
        );
      }

      // Delete duplicate conversations
      await Conversation.deleteMany({ _id: { $in: duplicateIds } });
      console.log(`  Deleted ${duplicateIds.length} duplicate conversations`);
    }

    await dropOldIndexIfExists();

    console.log("Migration complete. The new unique index will be created on next server start.");
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
