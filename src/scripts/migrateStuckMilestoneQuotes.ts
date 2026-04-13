import mongoose from "mongoose";
import dotenv from "dotenv";
import Booking from "../models/booking";

dotenv.config();

const isCustomDatePayable = (m: any): boolean => {
  if (m?.dueCondition !== "custom_date") return false;
  if (!m.customDueDate) return false;
  return new Date(m.customDueDate).getTime() <= Date.now();
};

const isMilestonePayable = (m: any, allMilestones: any[]): boolean => {
  if (m?.status === "paid") return false;
  const cond = m?.dueCondition;
  if (cond === "on_start") return true;
  if (cond === "on_milestone_start") {
    return m.workStatus === "in_progress" || m.workStatus === "completed";
  }
  if (cond === "on_milestone_completion") {
    return m.workStatus === "completed";
  }
  if (cond === "on_project_completion") {
    return allMilestones.every((s: any) => s.workStatus === "completed");
  }
  if (cond === "custom_date") {
    return isCustomDatePayable(m);
  }
  return true;
};

const hasPayableMilestone = (milestones: any[]): boolean =>
  milestones.some((m) => isMilestonePayable(m, milestones));

const hasLegitimateDeferral = (milestones: any[]): boolean =>
  milestones.some((m: any) => {
    const cond = m?.dueCondition;
    if (cond === "on_milestone_completion" || cond === "on_project_completion") {
      return true;
    }
    if (cond === "custom_date" && m.customDueDate) {
      return new Date(m.customDueDate).getTime() > Date.now();
    }
    return false;
  });

async function migrateStuckMilestoneQuotes() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Starting stuck-milestone migration${dryRun ? " (DRY RUN)" : ""}...`);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI or MONGODB_URI not set");

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  try {
    const bookings = await Booking.find({
      "milestonePayments.0": { $exists: true },
    });

    console.log(`Scanning ${bookings.length} bookings with milestonePayments`);

    let fixed = 0;
    let skippedAlreadyOk = 0;
    let skippedHasPaid = 0;
    let skippedEmpty = 0;
    let skippedLegitDefer = 0;

    for (const booking of bookings) {
      const milestones = booking.milestonePayments || [];
      if (milestones.length === 0) {
        skippedEmpty++;
        continue;
      }

      if (milestones.some((m: any) => m.status === "paid")) {
        skippedHasPaid++;
        continue;
      }

      if (hasPayableMilestone(milestones)) {
        skippedAlreadyOk++;
        continue;
      }

      if (hasLegitimateDeferral(milestones)) {
        skippedLegitDefer++;
        continue;
      }

      const earliest = [...milestones].sort(
        (a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)
      )[0];
      const targetOrder = earliest.order ?? 0;

      const idx = milestones.findIndex((m: any) => (m.order ?? 0) === targetOrder);
      if (idx < 0) {
        skippedEmpty++;
        continue;
      }

      console.log(
        `Booking ${booking._id} (status=${booking.status}): flipping milestonePayments[${idx}] "${milestones[idx].title}" ${milestones[idx].dueCondition} -> on_start`
      );

      if (!dryRun) {
        (booking.milestonePayments as any)[idx].dueCondition = "on_start";
        booking.markModified("milestonePayments");

        const currentVer = booking.currentQuoteVersion;
        if (typeof currentVer === "number" && Array.isArray(booking.quoteVersions)) {
          const versionDoc = booking.quoteVersions.find(
            (v: any) => v.version === currentVer
          );
          if (versionDoc && Array.isArray(versionDoc.milestones)) {
            const vIdx = versionDoc.milestones.findIndex(
              (m: any) => (m.order ?? 0) === targetOrder
            );
            if (vIdx >= 0) {
              (versionDoc.milestones as any)[vIdx].dueCondition = "on_start";
              booking.markModified("quoteVersions");
            }
          }
        }

        await booking.save();
      }
      fixed++;
    }

    console.log("\nMigration Summary:");
    console.log(`  Bookings fixed${dryRun ? " (would)" : ""}: ${fixed}`);
    console.log(`  Skipped (already has payable milestone): ${skippedAlreadyOk}`);
    console.log(`  Skipped (a milestone already paid): ${skippedHasPaid}`);
    console.log(`  Skipped (legitimate deferral: completion-gated or future custom_date): ${skippedLegitDefer}`);
    console.log(`  Skipped (empty/malformed): ${skippedEmpty}`);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

if (require.main === module) {
  migrateStuckMilestoneQuotes()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Migration script failed:", error);
      process.exit(1);
    });
}

export { migrateStuckMilestoneQuotes };
