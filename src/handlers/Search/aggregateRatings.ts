import { Types } from "mongoose";
import Booking from "../../models/booking";

export async function aggregateRatings(
  groupField: "professional" | "project",
  ids: (string | Types.ObjectId)[]
): Promise<Map<string, { avgRating: number; totalReviews: number }>> {
  if (ids.length === 0) return new Map();

  const objectIds = ids.map((id) =>
    typeof id === "string" ? new Types.ObjectId(id) : id
  );

  const results = await Booking.aggregate([
    {
      $match: {
        [groupField]: { $in: objectIds },
        status: "completed",
        "customerReview.communicationLevel": { $exists: true },
        "customerReview.isHidden": { $ne: true },
      },
    },
    {
      $group: {
        _id: `$${groupField}`,
        avgCommunication: { $avg: "$customerReview.communicationLevel" },
        avgValueOfDelivery: { $avg: "$customerReview.valueOfDelivery" },
        avgQualityOfService: { $avg: "$customerReview.qualityOfService" },
        totalReviews: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    results.map((r: any) => {
      const avg =
        (r.avgCommunication + r.avgValueOfDelivery + r.avgQualityOfService) / 3;
      return [
        r._id.toString(),
        { avgRating: Math.round(avg * 10) / 10, totalReviews: r.totalReviews },
      ];
    })
  );
}

export async function aggregateProfessionalRatings(
  ids: (string | Types.ObjectId)[]
): Promise<Map<string, { avgRating: number; totalReviews: number }>> {
  return aggregateRatings("professional", ids);
}

export async function aggregateProjectRatings(
  ids: (string | Types.ObjectId)[]
): Promise<Map<string, { avgRating: number; totalReviews: number }>> {
  return aggregateRatings("project", ids);
}
