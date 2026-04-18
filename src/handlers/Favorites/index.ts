import { Request, Response } from "express";
import mongoose from "mongoose";
import Favorite, { FavoriteTargetType } from "../../models/favorite";
import User from "../../models/user";
import Project from "../../models/project";
import connectToDatabase from "../../config/db";
import { invalidateFavoritesOverviewCache } from "../Admin/favoritesAdmin";

const VALID_TARGET_TYPES: FavoriteTargetType[] = ["professional", "project"];

const isValidTargetType = (t: any): t is FavoriteTargetType =>
  VALID_TARGET_TYPES.includes(t);

const parseObjectId = (id: any): mongoose.Types.ObjectId | null => {
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
};

const verifyTargetExists = async (
  targetType: FavoriteTargetType,
  targetId: mongoose.Types.ObjectId
): Promise<boolean> => {
  if (targetType === "professional") {
    const user = await User.findOne({ _id: targetId, role: "professional" }).select("_id").lean();
    return Boolean(user);
  }
  const project = await Project.findOne({ _id: targetId, status: "published" }).select("_id").lean();
  return Boolean(project);
};

export const toggleFavorite = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const rawUserId = req.user?.id || (req.user as any)?._id;
    if (!rawUserId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }
    const userId = parseObjectId(typeof rawUserId === "string" ? rawUserId : rawUserId.toString());
    if (!userId) {
      return res.status(400).json({ success: false, msg: "Invalid user id" });
    }

    const { targetType, targetId } = req.body || {};
    if (!isValidTargetType(targetType)) {
      return res.status(400).json({ success: false, msg: "Invalid targetType" });
    }
    const targetObjectId = parseObjectId(targetId);
    if (!targetObjectId) {
      return res.status(400).json({ success: false, msg: "Invalid targetId" });
    }

    const existing = await Favorite.findOne({
      user: userId,
      targetType,
      targetId: targetObjectId,
    });

    let favorited: boolean;
    if (existing) {
      await Favorite.deleteOne({ _id: existing._id });
      favorited = false;
    } else {
      const exists = await verifyTargetExists(targetType, targetObjectId);
      if (!exists) {
        return res.status(404).json({ success: false, msg: "Target not found" });
      }
      try {
        await Favorite.create({ user: userId, targetType, targetId: targetObjectId });
        favorited = true;
      } catch (err: any) {
        // Unique index race: treat as already favorited
        if (err?.code === 11000) {
          favorited = true;
        } else {
          throw err;
        }
      }
    }

    invalidateFavoritesOverviewCache();
    const count = await Favorite.countDocuments({ targetType, targetId: targetObjectId });
    return res.json({ success: true, data: { favorited, count } });
  } catch (error) {
    console.error("toggleFavorite error:", error);
    return res.status(500).json({ success: false, msg: "Failed to toggle favorite" });
  }
};

export const listUserFavorites = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const userId = req.user?.id || (req.user as any)?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const targetTypeParam = req.query.targetType as string | undefined;
    const parsedPage = parseInt((req.query.page as string) || "1", 10);
    const parsedLimit = parseInt((req.query.limit as string) || "24", 10);
    const page = Math.max(Number.isNaN(parsedPage) ? 1 : parsedPage, 1);
    const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 24 : parsedLimit, 1), 100);
    const skip = (page - 1) * limit;

    const filter: any = { user: userId };
    if (targetTypeParam) {
      if (!isValidTargetType(targetTypeParam)) {
        return res.status(400).json({ success: false, msg: "Invalid targetType" });
      }
      filter.targetType = targetTypeParam;
    }

    const [favorites, total] = await Promise.all([
      Favorite.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Favorite.countDocuments(filter),
    ]);

    const profIds = favorites
      .filter((f) => f.targetType === "professional")
      .map((f) => f.targetId);
    const projectIds = favorites
      .filter((f) => f.targetType === "project")
      .map((f) => f.targetId);

    const [profs, projects] = await Promise.all([
      profIds.length
        ? User.find({ _id: { $in: profIds } })
            .select(
              "name username profileImage businessInfo hourlyRate serviceCategories averageRating totalReviews professionalLevel"
            )
            .lean()
        : [],
      projectIds.length
        ? Project.find({ _id: { $in: projectIds }, status: "published" })
            .select(
              "title category service media distance subprojects professionalId status"
            )
            .lean()
        : [],
    ]);

    const profMap = new Map(profs.map((p: any) => [p._id.toString(), p]));
    const projectMap = new Map(projects.map((p: any) => [p._id.toString(), p]));

    const professionalIdsForProjects = Array.from(
      new Set(
        projects
          .map((p: any) => p.professionalId?.toString())
          .filter(Boolean)
      )
    );

    const projectOwners = professionalIdsForProjects.length
      ? await User.find({ _id: { $in: professionalIdsForProjects } })
          .select("name username profileImage businessInfo")
          .lean()
      : [];
    const projectOwnerMap = new Map(
      projectOwners.map((o: any) => [o._id.toString(), o])
    );

    const items = favorites.map((fav: any) => {
      const idStr = fav.targetId.toString();
      if (fav.targetType === "professional") {
        return {
          _id: fav._id,
          targetType: "professional" as const,
          targetId: fav.targetId,
          favoritedAt: fav.createdAt,
          professional: profMap.get(idStr) || null,
        };
      }
      const project: any = projectMap.get(idStr);
      const ownerId = project?.professionalId?.toString();
      return {
        _id: fav._id,
        targetType: "project" as const,
        targetId: fav.targetId,
        favoritedAt: fav.createdAt,
        project: project
          ? { ...project, professional: ownerId ? projectOwnerMap.get(ownerId) || null : null }
          : null,
      };
    });

    return res.json({
      success: true,
      data: {
        items,
        page,
        limit,
        total,
        hasMore: skip + favorites.length < total,
      },
    });
  } catch (error) {
    console.error("listUserFavorites error:", error);
    return res.status(500).json({ success: false, msg: "Failed to list favorites" });
  }
};

export const getFavoriteStatusBatch = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const userId = req.user?.id || (req.user as any)?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const { targetType, targetIds } = req.body || {};
    if (!isValidTargetType(targetType)) {
      return res.status(400).json({ success: false, msg: "Invalid targetType" });
    }
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      return res.json({ success: true, data: { favorited: {} } });
    }
    if (targetIds.length > 100) {
      return res.status(400).json({ success: false, msg: "Maximum 100 targetIds allowed" });
    }

    const parsed = targetIds.map(parseObjectId);
    const invalidIds = targetIds.filter((_id: unknown, i: number) => parsed[i] === null);
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        msg: "Invalid targetIds",
        invalidIds,
      });
    }
    const objectIds = parsed as mongoose.Types.ObjectId[];

    const favorites = await Favorite.find({
      user: userId,
      targetType,
      targetId: { $in: objectIds },
    })
      .select("targetId")
      .lean();

    const favoritedMap: Record<string, boolean> = {};
    for (const fav of favorites) {
      favoritedMap[fav.targetId.toString()] = true;
    }

    return res.json({ success: true, data: { favorited: favoritedMap } });
  } catch (error) {
    console.error("getFavoriteStatusBatch error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch favorite status" });
  }
};

export const getPublicProfessionalFavoriteCount = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const id = parseObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const count = await Favorite.countDocuments({ targetType: "professional", targetId: id });
    return res.json({ success: true, data: { count } });
  } catch (error) {
    console.error("getPublicProfessionalFavoriteCount error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch count" });
  }
};

export const getPublicProjectFavoriteCount = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const id = parseObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, msg: "Invalid id" });
    }
    const count = await Favorite.countDocuments({ targetType: "project", targetId: id });
    return res.json({ success: true, data: { count } });
  } catch (error) {
    console.error("getPublicProjectFavoriteCount error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch count" });
  }
};

export const getProfessionalFavoriteStats = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const user = req.user as any;
    if (!user || user.role !== "professional") {
      return res.status(403).json({ success: false, msg: "Professional role required" });
    }
    const professionalId = new mongoose.Types.ObjectId(user._id || user.id);

    const userProjects = await Project.find({ professionalId, status: "published" })
      .select("_id title")
      .lean();
    const projectIds = userProjects.map((p: any) => p._id);

    const profileCount = await Favorite.countDocuments({
      targetType: "professional",
      targetId: professionalId,
    });

    const perProjectCounts = projectIds.length
      ? await Favorite.aggregate([
          {
            $match: {
              targetType: "project",
              targetId: { $in: projectIds },
            },
          },
          { $group: { _id: "$targetId", count: { $sum: 1 } } },
        ])
      : [];

    const countMap = new Map(
      perProjectCounts.map((c: any) => [c._id.toString(), c.count])
    );

    const perProject = userProjects
      .map((p: any) => ({
        projectId: p._id,
        projectTitle: p.title,
        count: countMap.get(p._id.toString()) || 0,
      }))
      .sort((a, b) => b.count - a.count);

    const totalProjectsFav = perProject.reduce((sum, p) => sum + p.count, 0);
    const total = profileCount + totalProjectsFav;

    const lastViewedAt: Date | undefined = user.lastFavoritesViewedAt;
    const since = lastViewedAt || null;

    let newSinceLastSeen = 0;
    if (since) {
      newSinceLastSeen = await Favorite.countDocuments({
        $or: [
          { targetType: "professional", targetId: professionalId },
          { targetType: "project", targetId: { $in: projectIds } },
        ],
        createdAt: { $gt: since },
      });
    } else {
      newSinceLastSeen = total;
    }

    return res.json({
      success: true,
      data: {
        total,
        profileCount,
        perProject,
        newSinceLastSeen,
      },
    });
  } catch (error) {
    console.error("getProfessionalFavoriteStats error:", error);
    return res.status(500).json({ success: false, msg: "Failed to fetch stats" });
  }
};

export const dismissFavoriteNotifications = async (req: Request, res: Response) => {
  try {
    await connectToDatabase();
    const user = req.user as any;
    if (!user || user.role !== "professional") {
      return res.status(403).json({ success: false, msg: "Professional role required" });
    }
    const userId = user._id || user.id;
    await User.updateOne({ _id: userId }, { $set: { lastFavoritesViewedAt: new Date() } });
    return res.json({ success: true });
  } catch (error) {
    console.error("dismissFavoriteNotifications error:", error);
    return res.status(500).json({ success: false, msg: "Failed to dismiss notifications" });
  }
};

