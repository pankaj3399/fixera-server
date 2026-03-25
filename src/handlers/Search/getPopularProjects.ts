import { Request, Response } from "express";
import Project from "../../models/project";
import User from "../../models/user";
import Booking from "../../models/booking";
import { aggregateProjectRatings } from "./index";

/**
 * Get popular published projects for the homepage carousel.
 * Ranked by number of completed bookings, with a recency fallback
 * for projects that have no bookings yet.
 */
export const getPopularProjects = async (req: Request, res: Response) => {
  try {
    const { limit = "10" } = req.query;
    const limitNum = Math.min(parseInt(limit as string, 10) || 10, 20);

    // Aggregate completed booking counts per project
    const bookingCounts = await Booking.aggregate([
      {
        $match: {
          project: { $exists: true, $ne: null },
          status: "completed",
        },
      },
      {
        $group: {
          _id: "$project",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const bookingCountMap = new Map<string, number>(
      bookingCounts.map((b: any) => [b._id.toString(), b.count as number])
    );

    // Fetch all published projects (lightweight query)
    const allPublished = await Project.find({ status: "published" })
      .select(
        "title description category service media.images subprojects.name subprojects.pricing professionalId distance.address createdAt"
      )
      .lean();

    if (allPublished.length === 0) {
      return res.json({ projects: [] });
    }

    // Sort: most booked first, then by recency for tie-breaking / zero-booking projects
    allPublished.sort((a: any, b: any) => {
      const countA = bookingCountMap.get(a._id.toString()) || 0;
      const countB = bookingCountMap.get(b._id.toString()) || 0;
      if (countB !== countA) return countB - countA;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const projects = allPublished.slice(0, limitNum);

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
            .select("name businessInfo.companyName businessInfo.city businessInfo.country profileImage")
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
            sp.pricing.priceRange?.min != null
          ) {
            if (
              startingPrice === null ||
              sp.pricing.priceRange.min < startingPrice
            ) {
              startingPrice = sp.pricing.priceRange.min;
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
                professional.businessInfo?.companyName || professional.name,
              profileImage: professional.profileImage || null,
              city: professional.businessInfo?.city || null,
              country: professional.businessInfo?.country || null,
            }
          : null,
      };
    });

    res.json({ projects: results });
  } catch (error) {
    console.error("Failed to fetch popular projects:", error);
    res.status(500).json({ error: "Failed to fetch popular projects" });
  }
};
