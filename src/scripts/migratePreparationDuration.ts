import mongoose from "mongoose";
import dotenv from "dotenv";
import Project from "../models/project";

dotenv.config();

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

async function migratePreparationDuration() {
  try {
    console.log("Starting preparationDuration migration...");

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    const projects = await Project.find({
      "subprojects.deliveryPreparation": { $exists: true },
    });

    console.log(`Found ${projects.length} projects to scan`);

    let updatedProjects = 0;
    let updatedSubprojects = 0;
    let skippedExisting = 0;
    let skippedMissingUnit = 0;
    let skippedMissingValue = 0;

    for (const project of projects) {
      let projectUpdated = false;

      for (const subproject of project.subprojects ?? []) {
        if (subproject.preparationDuration != null) {
          skippedExisting++;
          continue;
        }

        const legacyValue = (subproject as unknown as { deliveryPreparation?: number }).deliveryPreparation;
        if (!isFiniteNumber(legacyValue)) {
          skippedMissingValue++;
          continue;
        }

        const unit = subproject.executionDuration?.unit;
        if (!unit) {
          skippedMissingUnit++;
          continue;
        }

        subproject.preparationDuration = {
          value: legacyValue,
          unit,
        };
        projectUpdated = true;
        updatedSubprojects++;
      }

      if (projectUpdated) {
        project.markModified("subprojects");
        await project.save();
        updatedProjects++;
      }
    }

    console.log("\nMigration Summary:");
    console.log(`  Projects updated: ${updatedProjects}`);
    console.log(`  Subprojects updated: ${updatedSubprojects}`);
    console.log(`  Skipped (already had preparationDuration): ${skippedExisting}`);
    console.log(`  Skipped (missing executionDuration.unit): ${skippedMissingUnit}`);
    console.log(`  Skipped (missing deliveryPreparation): ${skippedMissingValue}`);

    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  migratePreparationDuration()
    .then(() => {
      console.log("Migration script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration script failed:", error);
      process.exit(1);
    });
}

export { migratePreparationDuration };
