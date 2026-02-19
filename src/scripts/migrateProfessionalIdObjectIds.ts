import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const OBJECT_ID_HEX_REGEX = /^[a-fA-F0-9]{24}$/;

const toObjectId = (value: unknown): mongoose.Types.ObjectId | null => {
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }
  if (
    typeof value === "string" &&
    OBJECT_ID_HEX_REGEX.test(value) &&
    mongoose.Types.ObjectId.isValid(value)
  ) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
};

const getBulkWriteModifiedCountFromError = (error: any): number => {
  const result = error?.result;
  if (!result) return 0;

  const directModified = result.modifiedCount;
  if (typeof directModified === "number") return directModified;

  const legacyModified = result.nModified;
  if (typeof legacyModified === "number") return legacyModified;

  const nestedModified = result?.result?.nModified;
  if (typeof nestedModified === "number") return nestedModified;

  return 0;
};

const flushBulkOps = async (
  collection: mongoose.mongo.Collection,
  ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }>,
  label: string
): Promise<number> => {
  if (ops.length === 0) return 0;

  try {
    const result = await collection.bulkWrite(ops, { ordered: false });
    return result.modifiedCount;
  } catch (error: any) {
    const partialModified = getBulkWriteModifiedCountFromError(error);
    console.error(
      `[MIGRATION][${label}] bulkWrite failed; continuing with partial progress. Modified so far in this batch: ${partialModified}`,
      error
    );
    return partialModified;
  }
};

const migrateCollection = async (
  collection: mongoose.mongo.Collection,
  fieldName: string,
  batchSize: number,
  label: string,
  cursor: mongoose.mongo.FindCursor<any>
): Promise<{ updated: number; skipped: number }> => {
  let updated = 0;
  let skipped = 0;
  let ops: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    };
  }> = [];

  for await (const doc of cursor) {
    const fieldValue = doc[fieldName];
    const converted = toObjectId(fieldValue);

    if (!converted) {
      console.warn(
        `[MIGRATION][${label}] Skipping invalid ${fieldName} for ${label.toLowerCase()} ${doc._id}:`,
        fieldValue
      );
      skipped++;
      continue;
    }

    if (!(fieldValue instanceof mongoose.Types.ObjectId)) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { [fieldName]: converted } },
        },
      });

      if (ops.length >= batchSize) {
        updated += await flushBulkOps(collection, ops, label);
        ops = [];
      }
    }
  }

  updated += await flushBulkOps(collection, ops, label);
  ops = [];

  return { updated, skipped };
};

async function migrateProfessionalIdsToObjectIds() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection is missing database handle");
  }

  const projects = db.collection("projects");
  const meetings = db.collection("meetings");
  const BATCH_SIZE = 500;

  let projectCursor: mongoose.mongo.FindCursor<any> | null = null;
  let meetingCursor: mongoose.mongo.FindCursor<any> | null = null;

  let projectUpdated = 0;
  let projectSkippedInvalid = 0;
  let meetingUpdated = 0;
  let meetingSkippedInvalid = 0;

  try {
    projectCursor = projects.find(
      { professionalId: { $exists: true } },
      { projection: { professionalId: 1 } }
    );
    const projectResult = await migrateCollection(
      projects,
      "professionalId",
      BATCH_SIZE,
      "PROJECT",
      projectCursor
    );
    projectUpdated = projectResult.updated;
    projectSkippedInvalid = projectResult.skipped;

    meetingCursor = meetings.find(
      { professionalId: { $exists: true } },
      { projection: { professionalId: 1 } }
    );
    const meetingResult = await migrateCollection(
      meetings,
      "professionalId",
      BATCH_SIZE,
      "MEETING",
      meetingCursor
    );
    meetingUpdated = meetingResult.updated;
    meetingSkippedInvalid = meetingResult.skipped;

    console.log("Migration complete:");
    console.log(`  Projects updated: ${projectUpdated}`);
    console.log(`  Projects skipped (invalid): ${projectSkippedInvalid}`);
    console.log(`  Meetings updated: ${meetingUpdated}`);
    console.log(`  Meetings skipped (invalid): ${meetingSkippedInvalid}`);
  } finally {
    if (projectCursor) {
      await projectCursor.close().catch(() => undefined);
    }
    if (meetingCursor) {
      await meetingCursor.close().catch(() => undefined);
    }
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

if (require.main === module) {
  migrateProfessionalIdsToObjectIds()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Failed to migrate professionalId fields:", error);
      process.exit(1);
    });
}

export { migrateProfessionalIdsToObjectIds };

