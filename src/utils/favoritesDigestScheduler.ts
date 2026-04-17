import mongoose from "mongoose";
import User from "../models/user";
import Project from "../models/project";
import Favorite from "../models/favorite";
import { sendFavoritesDigestEmail } from "./emailService";

/**
 * Weekly favorites digest: for each professional, count new favorites
 * since their last digest and send an email if there are any.
 *
 * This utility follows the manual-trigger pattern used by
 * warrantyClaimScheduler.ts and rfqDeadlineScheduler.ts — it is invoked
 * via the admin endpoint `/api/admin/run-favorites-digest`.
 */
export const runFavoritesDigest = async () => {
  const now = new Date();
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  console.log(`[Favorites Digest] Running at ${now.toISOString()}`);

  const professionals = await User.find({
    role: "professional",
    professionalStatus: "approved",
    accountStatus: { $ne: "suspended" },
    deletedAt: { $exists: false },
  })
    .select("email name username lastFavoritesNotifiedAt notificationPreferences")
    .lean();

  for (const pro of professionals) {
    try {
      if (pro.notificationPreferences?.emailFavorites === false) {
        skipped++;
        continue;
      }
      if (!pro.email) {
        skipped++;
        continue;
      }

      const professionalId = new mongoose.Types.ObjectId(pro._id);
      const since = pro.lastFavoritesNotifiedAt || new Date(0);

      const projects = await Project.find({ professionalId }).select("_id title").lean();
      const projectIds = projects.map((p) => p._id);

      const [profileFavs, projectFavAgg] = await Promise.all([
        Favorite.countDocuments({
          targetType: "professional",
          targetId: professionalId,
          createdAt: { $gt: since },
        }),
        projectIds.length
          ? Favorite.aggregate([
              {
                $match: {
                  targetType: "project",
                  targetId: { $in: projectIds },
                  createdAt: { $gt: since },
                },
              },
              { $group: { _id: "$targetId", count: { $sum: 1 } } },
            ])
          : [],
      ]);

      const projectFavMap = new Map(projectFavAgg.map((r: any) => [r._id.toString(), r.count]));
      const totalNew =
        profileFavs +
        projectFavAgg.reduce((sum: number, r: any) => sum + r.count, 0);

      if (totalNew < 1) {
        skipped++;
        continue;
      }

      const topItems: Array<{ label: string; kind: "profile" | "project"; count: number }> = [];
      if (profileFavs > 0) {
        topItems.push({ label: "Your profile", kind: "profile", count: profileFavs });
      }
      for (const p of projects) {
        const c = projectFavMap.get(p._id.toString());
        if (c) topItems.push({ label: p.title, kind: "project", count: c });
      }
      topItems.sort((a, b) => b.count - a.count);

      const periodLabel = pro.lastFavoritesNotifiedAt
        ? "since your last update"
        : "recently";

      const ok = await sendFavoritesDigestEmail(
        pro.email,
        pro.username || pro.name || "there",
        totalNew,
        topItems,
        periodLabel
      );

      if (ok) {
        await User.updateOne(
          { _id: pro._id },
          { $set: { lastFavoritesNotifiedAt: now } }
        );
        sent++;
      } else {
        errors.push(`Failed to send to ${pro.email}`);
      }
    } catch (err: any) {
      console.error(`[Favorites Digest] Error for user ${pro._id}:`, err);
      errors.push(`${pro._id}: ${err?.message || "unknown"}`);
    }
  }

  console.log(
    `[Favorites Digest] Done. Sent=${sent} skipped=${skipped} errors=${errors.length}`
  );

  return { sent, skipped, errors };
};
