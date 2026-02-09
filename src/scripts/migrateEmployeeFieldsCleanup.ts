import mongoose from "mongoose";
import User from "../models/user";
import dotenv from "dotenv";

dotenv.config();

/**
 * Migration script to clean up unnecessary fields from employee documents.
 *
 * Employees only need:
 * - Basic auth fields: name, email, phone, password, isPhoneVerified, isEmailVerified
 * - Employee metadata: employee.*
 * - Personal blocked dates: blockedDates, blockedRanges
 * - Timestamps: createdAt, updatedAt
 *
 * This script removes all other fields that were unnecessarily stored.
 */

// Fields to remove from employee documents
const FIELDS_TO_UNSET = {
  // Professional-only fields
  businessInfo: "",
  hourlyRate: "",
  currency: "",
  serviceCategories: "",
  availability: "",
  companyAvailability: "",
  companyBlockedDates: "",
  companyBlockedRanges: "",

  // Professional verification/approval fields
  vatNumber: "",
  isVatVerified: "",
  idProofUrl: "",
  idProofFileName: "",
  idProofUploadedAt: "",
  isIdVerified: "",
  professionalStatus: "",
  approvedBy: "",
  approvedAt: "",
  rejectionReason: "",

  // Customer-only fields
  customerType: "",
  location: "",
  loyaltyPoints: "",
  loyaltyLevel: "",
  totalSpent: "",
  totalBookings: "",
  lastLoyaltyUpdate: "",

  // Other unused fields
  profileCompletedAt: "",
};

async function migrateEmployeeFieldsCleanup(dryRun: boolean = false) {
  try {
    console.log(`Starting employee fields cleanup migration... ${dryRun ? "(DRY RUN)" : ""}`);

    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGO_URI or MONGODB_URI not found in environment variables");
    }

    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    // =====================
    // 1. Find all employees
    // =====================
    console.log("\n--- Finding Employee Documents ---");

    const employees = await User.find({ role: "employee" }).lean();
    console.log(`Found ${employees.length} employee documents`);

    if (employees.length === 0) {
      console.log("No employees found. Nothing to migrate.");
      await mongoose.disconnect();
      return;
    }

    // =====================
    // 2. Analyze what needs to be cleaned
    // =====================
    console.log("\n--- Analyzing Documents ---");

    let employeesWithUnnecessaryFields = 0;
    const fieldCounts: Record<string, number> = {};

    for (const emp of employees) {
      let hasUnnecessaryFields = false;

      for (const field of Object.keys(FIELDS_TO_UNSET)) {
        if ((emp as any)[field] !== undefined) {
          hasUnnecessaryFields = true;
          fieldCounts[field] = (fieldCounts[field] || 0) + 1;
        }
      }

      if (hasUnnecessaryFields) {
        employeesWithUnnecessaryFields++;
      }
    }

    console.log(`\nEmployees with unnecessary fields: ${employeesWithUnnecessaryFields}/${employees.length}`);

    if (Object.keys(fieldCounts).length > 0) {
      console.log("\nField breakdown:");
      for (const [field, count] of Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  - ${field}: ${count} documents`);
      }
    } else {
      console.log("\nNo unnecessary fields found. Database is already clean.");
      await mongoose.disconnect();
      return;
    }

    // =====================
    // 3. Perform cleanup
    // =====================
    if (!dryRun) {
      console.log("\n--- Performing Cleanup ---");

      const updateResult = await User.updateMany(
        { role: "employee" },
        { $unset: FIELDS_TO_UNSET }
      );

      console.log(`Updated ${updateResult.modifiedCount} employee documents`);

      // =====================
      // 4. Verification
      // =====================
      console.log("\n--- Verification ---");

      let verificationPassed = true;
      for (const field of Object.keys(FIELDS_TO_UNSET)) {
        const count = await User.countDocuments({
          role: "employee",
          [field]: { $exists: true }
        });

        if (count > 0) {
          console.log(`WARNING: ${count} employees still have field '${field}'`);
          verificationPassed = false;
        }
      }

      if (verificationPassed) {
        console.log("Verification passed: All unnecessary fields removed from employee documents");
      }
    } else {
      console.log("\n--- Dry Run Complete ---");
      console.log("No changes were made. Run without --dry-run to apply changes.");
    }

    // =====================
    // Summary
    // =====================
    console.log("\n--- Migration Summary ---");
    console.log(`  Total employees: ${employees.length}`);
    console.log(`  Employees needing cleanup: ${employeesWithUnnecessaryFields}`);
    console.log(`  Mode: ${dryRun ? "DRY RUN (no changes made)" : "LIVE (changes applied)"}`);

    // Disconnect
    await mongoose.disconnect();
    console.log("\nDisconnected from MongoDB");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log("=".repeat(60));
  console.log("Employee Fields Cleanup Migration");
  console.log("=".repeat(60));

  if (dryRun) {
    console.log("\nRunning in DRY RUN mode - no changes will be made");
  } else {
    console.log("\nRunning in LIVE mode - changes will be applied");
    console.log("Use --dry-run flag to preview changes without applying them");
  }

  migrateEmployeeFieldsCleanup(dryRun)
    .then(() => {
      console.log("\nMigration script completed");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration script failed:", error);
      process.exit(1);
    });
}

export { migrateEmployeeFieldsCleanup };
