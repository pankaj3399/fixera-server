import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/user";

dotenv.config();

async function removeProfessionalAvailability() {
  try {
    console.log("Starting professional availability cleanup...");

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    const filter = {
      role: "professional",
      availability: { $exists: true },
    };

    const result = await User.updateMany(filter, {
      $unset: {
        availability: "",
      },
    });

    console.log(`Matched: ${result.matchedCount}`);
    console.log(`Modified: ${result.modifiedCount}`);

    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  } catch (error) {
    console.error("Cleanup failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  removeProfessionalAvailability()
    .then(() => {
      console.log("Cleanup script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Cleanup script failed:", error);
      process.exit(1);
    });
}

export { removeProfessionalAvailability };
