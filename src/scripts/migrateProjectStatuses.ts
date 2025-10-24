
import mongoose from "mongoose";
import Project from "../models/project";
import dotenv from "dotenv";

dotenv.config();

// Status mapping from old combined status to new separated statuses
const statusMigrationMap: Record<
  string,
  { status: string; bookingStatus?: string }
> = {
  // Project lifecycle statuses (no booking status)
  draft: { status: "draft" },
  pending_approval: { status: "pending" },
  rejected: { status: "rejected" },
  published: { status: "published" },
  on_hold: { status: "on_hold" },

  // Booking lifecycle statuses (project is published, booking has status)
  quoted: { status: "published", bookingStatus: "quoted" },
  booked: { status: "published", bookingStatus: "booked" },
  in_progress: { status: "published", bookingStatus: "execution" },
  completed: { status: "published", bookingStatus: "completed" },
  awaiting_confirmation: { status: "published", bookingStatus: "completed" }, // Map to completed
  closed: { status: "published", bookingStatus: "completed" }, // Map to completed
  disputed: { status: "published", bookingStatus: "dispute" },
};

async function migrateProjectStatuses() {
  try {
    console.log("🚀 Starting project status migration...");

    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
    }

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // Get all projects
    const projects = await Project.find({});
    console.log(`📊 Found ${projects.length} projects to migrate`);

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const project of projects) {
      try {
        const oldStatus = project.status as string;
        const migration = statusMigrationMap[oldStatus];

        if (!migration) {
          console.warn(
            `⚠️  Unknown status "${oldStatus}" for project ${project._id}, skipping...`
          );
          skippedCount++;
          continue;
        }

        // Check if already migrated (status is one of new values and doesn't need change)
        const newStatusValues = [
          "draft",
          "pending",
          "rejected",
          "published",
          "on_hold",
        ];
        if (
          newStatusValues.includes(oldStatus) &&
          !project.bookingStatus &&
          !["quoted", "booked", "in_progress", "completed", "awaiting_confirmation", "closed", "disputed"].includes(oldStatus)
        ) {
          console.log(
            `✓ Project ${project._id} already migrated (status: ${oldStatus})`
          );
          skippedCount++;
          continue;
        }

        // Update the project
        const updateData: any = {
          status: migration.status,
        };

        if (migration.bookingStatus) {
          updateData.bookingStatus = migration.bookingStatus;
        }

        await Project.updateOne({ _id: project._id }, { $set: updateData });

        console.log(
          `✅ Migrated project ${project._id}: ${oldStatus} → status: ${migration.status}${migration.bookingStatus ? `, bookingStatus: ${migration.bookingStatus}` : ""}`
        );
        migratedCount++;
      } catch (error) {
        console.error(`❌ Error migrating project ${project._id}:`, error);
        errorCount++;
      }
    }

    console.log("\n📈 Migration Summary:");
    console.log(`   ✅ Migrated: ${migratedCount}`);
    console.log(`   ⏭️  Skipped: ${skippedCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log(`   📊 Total: ${projects.length}`);

    if (errorCount === 0) {
      console.log("\n🎉 Migration completed successfully!");
    } else {
      console.log(
        "\n⚠️  Migration completed with errors. Please review the error messages above."
      );
    }

    // Disconnect
    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrateProjectStatuses()
    .then(() => {
      console.log("✅ Migration script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Migration script failed:", error);
      process.exit(1);
    });
}

export { migrateProjectStatuses };
