import { Request, Response } from "express";
import Project from "../../models/project";
import User from "../../models/user";
import { aggregateProjectRatings } from "./aggregateRatings";

/**
 * Get popular published projects for the homepage / service carousels.
 * Ranked by a composite popularity score (completed bookings, engaged
 * bookings and favorites), with a recency fallback for projects that have
 * no engagement yet.
 */
export const getPopularProjects = async (req: Request, res: Response) => {
  try {
    const { limit = "10", service } = req.query;
    const parsed = parseInt(limit as string, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(parsed) ? 10 : parsed, 1), 20);

    const serviceFilter =
      typeof service === "string" && service.trim() ? service.trim() : null;

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const match: Record<string, unknown> = { status: "published" };
    if (serviceFilter) {
      match.service = { $regex: `^${escapeRegex(serviceFilter)}$`, $options: "i" };
    }

    const projects: any[] = await Project.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "bookings",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$project", "$$projectId"] },
                status: { $in: ["booked", "in_progress", "professional_completed", "completed"] },
              },
            },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
                reviewed: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "completed"] },
                          { $ne: [{ $ifNull: ["$customerReview.communicationLevel", null] }, null] },
                          { $ne: [{ $ifNull: ["$customerReview.valueOfDelivery", null] }, null] },
                          { $ne: [{ $ifNull: ["$customerReview.qualityOfService", null] }, null] },
                          { $ne: ["$customerReview.isHidden", true] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                ratingSum: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "completed"] },
                          { $ne: [{ $ifNull: ["$customerReview.communicationLevel", null] }, null] },
                          { $ne: [{ $ifNull: ["$customerReview.valueOfDelivery", null] }, null] },
                          { $ne: [{ $ifNull: ["$customerReview.qualityOfService", null] }, null] },
                          { $ne: ["$customerReview.isHidden", true] },
                        ],
                      },
                      {
                        $avg: [
                          { $ifNull: ["$customerReview.communicationLevel", 0] },
                          { $ifNull: ["$customerReview.valueOfDelivery", 0] },
                          { $ifNull: ["$customerReview.qualityOfService", 0] },
                        ],
                      },
                      0,
                    ],
                  },
                },
              },
            },
          ],
          as: "bookingStats",
        },
      },
      {
        $lookup: {
          from: "favorites",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$targetType", "project"] },
                    { $eq: ["$targetId", "$$projectId"] },
                  ],
                },
              },
            },
            { $count: "count" },
          ],
          as: "favoriteStats",
        },
      },
      {
        $addFields: {
          completedBookings: { $ifNull: [{ $arrayElemAt: ["$bookingStats.completed", 0] }, 0] },
          engagedBookings: { $ifNull: [{ $arrayElemAt: ["$bookingStats.total", 0] }, 0] },
          reviewedBookings: { $ifNull: [{ $arrayElemAt: ["$bookingStats.reviewed", 0] }, 0] },
          ratingSum: { $ifNull: [{ $arrayElemAt: ["$bookingStats.ratingSum", 0] }, 0] },
          favoriteCount: { $ifNull: [{ $arrayElemAt: ["$favoriteStats.count", 0] }, 0] },
        },
      },
      {
        $addFields: {
          avgRating: {
            $cond: [{ $gt: ["$reviewedBookings", 0] }, { $divide: ["$ratingSum", "$reviewedBookings"] }, 0],
          },
          engagementScore: {
            $add: [
              { $multiply: ["$completedBookings", 5] },
              { $multiply: ["$engagedBookings", 2] },
              "$favoriteCount",
            ],
          },
        },
      },
      {
        $sort: {
          reviewedBookings: -1,
          avgRating: -1,
          engagementScore: -1,
          completedBookings: -1,
          createdAt: -1,
        },
      },
      { $limit: limitNum },
      {
        $project: {
          title: 1,
          category: 1,
          service: 1,
          "media.images": 1,
          "subprojects.name": 1,
          "subprojects.pricing": 1,
          professionalId: 1,
          "distance.address": 1,
        },
      },
    ]);

    if (projects.length === 0) {
      return res.json({ projects: [] });
    }

    // Batch-load professionals
    const professionalIdSet = new Set(
      projects
        .map((p: any) => p.professionalId?.toString())
        .filter(Boolean)
    );
    const professionalIds = Array.from(professionalIdSet);

    const professionalsData =
      professionalIds.length > 0
        ? await User.find({ _id: { $in: professionalIds } })
            .select("name username businessInfo.city businessInfo.country profileImage")
            .lean()
        : [];

    const professionalMap = new Map(
      professionalsData.map((p: any) => [p._id.toString(), p])
    );

    // Aggregate ratings
    const projectIds = projects.map((p: any) => p._id);
    const ratingMap = await aggregateProjectRatings(projectIds);

    const results = projects.map((project: any) => {
      const profId = project.professionalId?.toString();
      const professional = profId ? professionalMap.get(profId) : null;
      const ratings = ratingMap.get(project._id.toString()) || {
        avgRating: 0,
        totalReviews: 0,
      };

      // Get the lowest starting price from subprojects
      let startingPrice: number | null = null;
      let priceType: string = "rfq";
      if (project.subprojects?.length) {
        for (const sp of project.subprojects) {
          if (sp.pricing?.type === "fixed" && sp.pricing.amount != null) {
            if (startingPrice === null || sp.pricing.amount < startingPrice) {
              startingPrice = sp.pricing.amount;
              priceType = "fixed";
            }
          } else if (
            sp.pricing?.type === "unit" &&
            sp.pricing.amount != null
          ) {
            if (
              startingPrice === null ||
              sp.pricing.amount < startingPrice
            ) {
              startingPrice = sp.pricing.amount;
              priceType = "unit";
            }
          }
        }
      }

      return {
        _id: project._id,
        title: project.title,
        category: project.category,
        service: project.service,
        image: project.media?.images?.[0] || null,
        location: project.distance?.address || null,
        startingPrice,
        priceType,
        avgRating: ratings.avgRating,
        totalReviews: ratings.totalReviews,
        professional: professional
          ? {
              name:
                professional.username || professional.name,
              profileImage: professional.profileImage || null,
              city: professional.businessInfo?.city || null,
              country: professional.businessInfo?.country || null,
            }
          : null,
      };
    });

    res.json({ projects: results });
  } catch (error) {
    console.error("Failed to fetch popular projects:", { error, query: req.query });
    res.status(500).json({ error: "Failed to fetch popular projects" });
  }
};
