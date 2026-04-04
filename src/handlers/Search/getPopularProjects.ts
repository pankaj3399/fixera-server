import { Request, Response } from "express";
import Project from "../../models/project";
import User from "../../models/user";
import { aggregateProjectRatings } from "./aggregateRatings";

/**
 * Get popular published projects for the homepage carousel.
 * Ranked by number of completed bookings, with a recency fallback
 * for projects that have no bookings yet.
 */
export const getPopularProjects = async (req: Request, res: Response) => {
  try {
    const { limit = "10" } = req.query;
    const parsed = parseInt(limit as string, 10);
    const limitNum = Math.min(Math.max(Number.isNaN(parsed) ? 10 : parsed, 1), 20);

    // Single aggregation: filter published, lookup completed booking counts,
    // sort by booking count desc + recency, project only needed fields, limit.
    const projects: any[] = await Project.aggregate([
      { $match: { status: "published" } },
      {
        $lookup: {
          from: "bookings",
          let: { projectId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$project", "$$projectId"] },
                status: "completed",
              },
            },
            { $count: "count" },
          ],
          as: "bookingStats",
        },
      },
      {
        $addFields: {
          bookingCount: {
            $ifNull: [{ $arrayElemAt: ["$bookingStats.count", 0] }, 0],
          },
        },
      },
      { $sort: { bookingCount: -1, createdAt: -1 } },
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
