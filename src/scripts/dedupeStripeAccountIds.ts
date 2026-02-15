import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/user";

dotenv.config();

async function dedupeStripeAccountIds(apply = false) {
  const initialReadyState = mongoose.connection.readyState;
  const shouldOpenConnection = initialReadyState === 0;
  let openedConnection = false;

  try {
    if (shouldOpenConnection) {
      const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
      if (!mongoUri) {
        throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
      }
      await mongoose.connect(mongoUri);
      openedConnection = true;
      console.log("Connected to MongoDB");
    } else {
      console.log("Using existing MongoDB connection");
    }

    const duplicates = await User.aggregate([
      { $match: { "stripe.accountId": { $exists: true, $ne: null } } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: "$stripe.accountId",
          userIds: { $push: "$_id" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    if (duplicates.length === 0) {
      console.log("No duplicate stripe.accountId values found.");
      return;
    }

    console.warn(`Found ${duplicates.length} duplicate stripe.accountId values.`);
    const UPDATE_BATCH_SIZE = 500;
    let totalFound = 0;
    let totalDuplicateUsers = 0;
    let totalCleared = 0;

    for (const dup of duplicates) {
      totalFound += 1;
      const [primaryUserId, ...duplicateUserIds] = dup.userIds;
      totalDuplicateUsers += duplicateUserIds.length;
      console.log(
        `stripe.accountId=${dup._id} primary=${primaryUserId} duplicates=${duplicateUserIds.join(",")}`
      );

      if (apply && duplicateUserIds.length > 0) {
        for (let i = 0; i < duplicateUserIds.length; i += UPDATE_BATCH_SIZE) {
          const batchIds = duplicateUserIds.slice(i, i + UPDATE_BATCH_SIZE);
          const result = await User.updateMany(
            { _id: { $in: batchIds } },
            {
              $unset: { stripe: "" },
            }
          );
          totalCleared += result.modifiedCount || 0;
        }
        console.log(`Cleared stripe field for ${duplicateUserIds.length} duplicate users.`);
      }
    }

    if (!apply) {
      console.log("Dry run complete. Re-run with APPLY_CHANGES=true to clear duplicates.");
    }

    console.log(
      `Dedupe summary: duplicateAccountIds=${totalFound}, duplicateUsers=${totalDuplicateUsers}, clearedUsers=${totalCleared}, apply=${apply}`
    );
  } finally {
    if (openedConnection) {
      await mongoose.disconnect();
      console.log("Disconnected from MongoDB");
    }
  }
}

if (require.main === module) {
  const apply = process.env.APPLY_CHANGES === "true";
  dedupeStripeAccountIds(apply)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Stripe account dedupe failed:", error);
      process.exit(1);
    });
}

export { dedupeStripeAccountIds };
