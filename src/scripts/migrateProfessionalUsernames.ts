import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import User from "../models/user";
import { generateUsername, isTooSimilarToCompanyName } from "../utils/usernameUtils";

const DRY_RUN = process.argv.includes("--dry-run");

async function migrate() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI not set");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log(`Connected to MongoDB. Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  const professionals = await User.find({ role: "professional" }).lean();
  console.log(`Found ${professionals.length} professionals`);

  const existingUsernames = new Set<string>();
  const allUsersWithUsername = await User.find({ username: { $exists: true, $ne: null } }).select("username").lean();
  for (const u of allUsersWithUsername) {
    if (u.username) existingUsernames.add(u.username);
  }
  console.log(`${existingUsernames.size} existing usernames in DB`);

  const alreadyHave = professionals.filter((p) => p.username);
  const needUsername = professionals.filter((p) => !p.username);
  console.log(`${alreadyHave.length} already have usernames, ${needUsername.length} need one`);

  let successCount = 0;
  let fallbackCount = 0;
  let collisionCount = 0;
  const updates: { _id: mongoose.Types.ObjectId; username: string }[] = [];

  for (const pro of needUsername) {
    const companyName = pro.businessInfo?.companyName;
    const city = pro.businessInfo?.city;
    let baseUsername = "";

    if (companyName) {
      baseUsername = generateUsername(companyName, city);
    }
    if (!baseUsername && pro.name) {
      baseUsername = generateUsername(pro.name, city);
    }
    if (!baseUsername) {
      baseUsername = `pro-${pro._id.toString().slice(-6)}`;
      fallbackCount++;
    }

    if (companyName && isTooSimilarToCompanyName(baseUsername, companyName)) {
      const suffix = Math.floor(Math.random() * 900 + 100);
      baseUsername = `${baseUsername.replace(/-+$/, '').slice(0, 26)}-${suffix}`;
    }

    let candidate = baseUsername;
    let suffix = 1;
    while (existingUsernames.has(candidate)) {
      candidate = `${baseUsername}-${suffix}`;
      suffix++;
      collisionCount++;
      if (suffix > 99) {
        candidate = `pro-${pro._id.toString().slice(-6)}`;
        fallbackCount++;
        break;
      }
    }

    existingUsernames.add(candidate);
    updates.push({ _id: pro._id, username: candidate });
    successCount++;

    if (updates.length <= 5 || updates.length % 100 === 0) {
      console.log(`  ${companyName || pro.name || pro._id} -> ${candidate}`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Total processed: ${needUsername.length}`);
  console.log(`  Successfully assigned: ${successCount}`);
  console.log(`  Fallbacks (no company name): ${fallbackCount}`);
  console.log(`  Collisions resolved: ${collisionCount}`);

  if (DRY_RUN) {
    console.log(`\nDRY RUN - no changes applied. Run without --dry-run to apply.`);
  } else {
    if (updates.length > 0) {
      console.log(`\nApplying ${updates.length} updates...`);
      const bulkOps = updates.map((u) => ({
        updateOne: {
          filter: { _id: u._id },
          update: { $set: { username: u.username } },
        },
      }));

      const batchSize = 500;
      for (let i = 0; i < bulkOps.length; i += batchSize) {
        const batch = bulkOps.slice(i, i + batchSize);
        try {
          await User.bulkWrite(batch);
          console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ${batch.length} updates applied`);
        } catch (err: any) {
          console.error(`  Batch ${Math.floor(i / batchSize) + 1} failed:`, err.message);
          for (const op of batch) {
            try {
              await User.updateOne(op.updateOne.filter, op.updateOne.update);
            } catch (innerErr: any) {
              if (innerErr.code === 11000) {
                const fallback = `pro-${op.updateOne.filter._id.toString().slice(-6)}-${Date.now() % 1000}`;
                await User.updateOne(op.updateOne.filter, { $set: { username: fallback } });
                console.log(`  Resolved duplicate for ${op.updateOne.filter._id} -> ${fallback}`);
              } else {
                console.error(`  Failed for ${op.updateOne.filter._id}:`, innerErr.message);
              }
            }
          }
        }
      }
    }

    const withoutUsername = await User.countDocuments({ role: "professional", $or: [{ username: { $exists: false } }, { username: null }] });
    console.log(`\nVerification: ${withoutUsername} professionals still without username`);

    const duplicates = await User.aggregate([
      { $match: { username: { $exists: true, $ne: null } } },
      { $group: { _id: "$username", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    if (duplicates.length > 0) {
      console.log(`WARNING: Found ${duplicates.length} duplicate usernames:`, duplicates);
    } else {
      console.log("No duplicate usernames found.");
    }

    const samples = await User.find({ role: "professional", username: { $exists: true } })
      .select("name username businessInfo.companyName")
      .limit(5)
      .lean();
    console.log("\nSample mappings:");
    for (const s of samples) {
      console.log(`  ${s.businessInfo?.companyName || s.name} -> ${s.username}`);
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
