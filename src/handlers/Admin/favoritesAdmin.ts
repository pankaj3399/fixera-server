import { Request, Response } from "express";
import mongoose from "mongoose";
import Favorite from "../../models/favorite";
import User from "../../models/user";
import Project from "../../models/project";
import connectToDatabase from "../../config/db";

const parseObjectId = (id: any): mongoose.Types.ObjectId | null => {
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

const FAVORITES_OVERVIEW_TTL_MS = 45 * 1000;
const overviewCache: { key: string; data: any; expiresAt: number } = {
  key: "favorites_overview",
  data: null,
  expiresAt: 0,
};

export const invalidateFavoritesOverviewCache = () => {
  overviewCache.data = null;
  overviewCache.expiresAt = 0;
};

export const getFavoritesOverview = async (_req: Request, res: Response) => {
  try {
    await connectToDatabase();

    if (overviewCache.data && Date.now() < overviewCache.expiresAt) {
      return res.json({ success: true, data: overviewCache.data });
    }

    const [totalsAgg, uniqueCustomersAgg] = await Promise.all([
      Favorite.aggregate([
        { $group: { _id: "$targetType", count: { $sum: 1 } } },
      ]),
      Favorite.aggregate([
        { $group: { _id: "$user" } },
        { $count: "n" },
      ]),
    ]);

    const totals = { professionals: 0, projects: 0, uniqueCustomers: 0 };
    for (const row of totalsAgg) {
      if (row._id === "professional") totals.professionals = row.count;
      if (row._id === "project") totals.projects = row.count;
    }
    totals.uniqueCustomers = uniqueCustomersAgg[0]?.n || 0;

    const topProfessionalsRaw = await Favorite.aggregate([
      { $match: { targetType: "professional" } },
      { $group: { _id: "$targetId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    const topProjectsRaw = await Favorite.aggregate([
      { $match: { targetType: "project" } },
      { $group: { _id: "$targetId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    const profIds = topProfessionalsRaw.map((r) => r._id);
    const projIds = topProjectsRaw.map((r) => r._id);

    const [profs, projects] = await Promise.all([
      profIds.length
        ? User.find({ _id: { $in: profIds } })
            .select("name username profileImage businessInfo")
            .lean()
        : [],
      projIds.length
        ? Project.find({ _id: { $in: projIds } })
            .select("title professionalId")
            .lean()
        : [],
    ]);

    const profMap = new Map(profs.map((p: any) => [p._id.toString(), p]));
    const projectMap = new Map(projects.map((p: any) => [p._id.toString(), p]));

    const projectOwnerIds = Array.from(
      new Set(
        projects.map((p: any) => p.professionalId?.toString()).filter(Boolean)
      )
    );
    const projectOwners = projectOwnerIds.length
      ? await User.find({ _id: { $in: projectOwnerIds } })
          .select("name username")
          .lean()
      : [];
    const ownerMap = new Map(projectOwners.map((o: any) => [o._id.toString(), o]));

    const topProfessionals = topProfessionalsRaw.map((r: any) => {
      const p = profMap.get(r._id.toString());
      return {
        _id: r._id,
        count: r.count,
        name: p?.username || p?.name || "Unknown",
        profileImage: p?.profileImage || null,
      };
    });

    const topProjects = topProjectsRaw.map((r: any) => {
      const p: any = projectMap.get(r._id.toString());
      const owner = p?.professionalId ? ownerMap.get(p.professionalId.toString()) : null;
      return {
        _id: r._id,
        count: r.count,
        title: p?.title || "(deleted project)",
        professionalId: p?.professionalId || null,
        professionalName: owner?.username || owner?.name || null,
      };
    });

    const recentRaw = await Favorite.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("user", "name email")
      .lean();

    const recentProfIds: mongoose.Types.ObjectId[] = [];
    const recentProjIds: mongoose.Types.ObjectId[] = [];
    for (const r of recentRaw) {
      if ((r as any).targetType === "professional") recentProfIds.push((r as any).targetId);
      else if ((r as any).targetType === "project") recentProjIds.push((r as any).targetId);
    }

    const [recentProfs, recentProjects] = await Promise.all([
      recentProfIds.length
        ? User.find({ _id: { $in: recentProfIds } }).select("name username").lean()
        : [],
      recentProjIds.length
        ? Project.find({ _id: { $in: recentProjIds } }).select("title").lean()
        : [],
    ]);
    const recentProfMap = new Map(recentProfs.map((p: any) => [p._id.toString(), p]));
    const recentProjMap = new Map(recentProjects.map((p: any) => [p._id.toString(), p]));

    const recent = recentRaw.map((r: any) => {
      const idStr = r.targetId.toString();
      let targetLabel: string = "(missing)";
      if (r.targetType === "professional") {
        const p = recentProfMap.get(idStr);
        targetLabel = p?.username || p?.name || "(deleted)";
      } else {
        const p = recentProjMap.get(idStr);
        targetLabel = p?.title || "(deleted)";
      }
      return {
        _id: r._id,
        user: r.user,
        targetType: r.targetType,
        targetId: r.targetId,
        targetLabel,
        createdAt: r.createdAt,
      };
    });

    const payload = { totals, topProfessionals, topProjects, recent };
    overviewCache.data = payload;
    overviewCache.expiresAt = Date.now() + FAVORITES_OVERVIEW_TTL_MS;

    return res.json({ success: true, data: payload });
  } catch (error) {
    console.error("getFavoritesOverview error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch overview" });
  }
};

export const listAllFavorites = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const targetType = req.query.targetType as string | undefined;
    const userId = req.query.userId as string | undefined;
    const targetId = req.query.targetId as string | undefined;
    const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || "50", 10), 1),
      200
    );
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (targetType !== undefined) {
      if (targetType !== "professional" && targetType !== "project") {
        return res.status(400).json({ success: false, msg: "Invalid targetType" });
      }
      filter.targetType = targetType;
    }
    if (userId) {
      const oid = parseObjectId(userId);
      if (!oid) return res.status(400).json({ success: false, msg: "Invalid userId" });
      filter.user = oid;
    }
    if (targetId) {
      const oid = parseObjectId(targetId);
      if (!oid) return res.status(400).json({ success: false, msg: "Invalid targetId" });
      filter.targetId = oid;
    }

    const [rows, total] = await Promise.all([
      Favorite.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email role")
        .lean(),
      Favorite.countDocuments(filter),
    ]);

    const profIdSet = new Map<string, mongoose.Types.ObjectId>();
    const projIdSet = new Map<string, mongoose.Types.ObjectId>();
    for (const r of rows) {
      const row = r as any;
      const key = row.targetId.toString();
      if (row.targetType === "professional") profIdSet.set(key, row.targetId);
      else if (row.targetType === "project") projIdSet.set(key, row.targetId);
    }

    const [profs, projects] = await Promise.all([
      profIdSet.size
        ? User.find({ _id: { $in: Array.from(profIdSet.values()) } }).select("name username").lean()
        : [],
      projIdSet.size
        ? Project.find({ _id: { $in: Array.from(projIdSet.values()) } }).select("title").lean()
        : [],
    ]);
    const profMap = new Map(profs.map((p: any) => [p._id.toString(), p]));
    const projMap = new Map(projects.map((p: any) => [p._id.toString(), p]));

    const items = rows.map((r: any) => {
      const idStr = r.targetId.toString();
      let targetLabel = "(deleted)";
      if (r.targetType === "professional") {
        const p = profMap.get(idStr);
        targetLabel = p?.username || p?.name || "(deleted)";
      } else if (r.targetType === "project") {
        const p = projMap.get(idStr);
        targetLabel = p?.title || "(deleted)";
      }
      return { ...r, targetLabel };
    });

    return res.json({
      success: true,
      data: { items, page, limit, total },
    });
  } catch (error) {
    console.error("listAllFavorites error:", error);
    return res.status(500).json({ success: false, msg: "Failed to list favorites" });
  }
};

export const deleteFavorite = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ success: false, msg: "Invalid id" });
    const result = await Favorite.deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, msg: "Favorite not found" });
    }
    invalidateFavoritesOverviewCache();
    // TODO: Audit log hook (task 14a) — record admin-initiated favorite deletion.
    return res.json({ success: true });
  } catch (error) {
    console.error("deleteFavorite error:", error);
    return res.status(500).json({ success: false, msg: "Failed to delete favorite" });
  }
};
