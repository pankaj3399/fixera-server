import { Request, Response, NextFunction } from "express";
import Booking from "../../models/booking";
import User from "../../models/user";
import mongoose from "mongoose";

const MAX_COMMENT_LENGTH = 1000;

// Customer submits a review for the professional (3 categories + text)
export const submitCustomerReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = req.params;
    const { communicationLevel, valueOfDelivery, qualityOfService, comment } = req.body;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    // Validate ratings
    for (const [label, val] of Object.entries({ communicationLevel, valueOfDelivery, qualityOfService })) {
      if (!val || typeof val !== "number" || val < 1 || val > 5 || !Number.isInteger(val)) {
        return res.status(400).json({ success: false, msg: `${label} must be an integer between 1 and 5` });
      }
    }

    // Validate comment length
    const trimmedComment = typeof comment === "string" ? comment.trim() : undefined;
    if (trimmedComment && trimmedComment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ success: false, msg: `Comment must be ${MAX_COMMENT_LENGTH} characters or less` });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the customer can submit a review" });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({ success: false, msg: "Can only review completed bookings" });
    }

    if (booking.customerReview?.communicationLevel) {
      return res.status(400).json({ success: false, msg: "You have already reviewed this booking" });
    }

    booking.customerReview = {
      communicationLevel,
      valueOfDelivery,
      qualityOfService,
      comment: trimmedComment || undefined,
      reviewedAt: new Date(),
    };

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Review submitted successfully",
      customerReview: booking.customerReview,
    });
  } catch (error) {
    console.error("Submit customer review error:", error);
    next(error);
  }
};

// Professional submits a review for the customer (overall rating + text)
export const submitProfessionalReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = req.params;
    const { rating, comment } = req.body;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    if (!rating || typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      return res.status(400).json({ success: false, msg: "Rating must be an integer between 1 and 5" });
    }

    // Validate comment length
    const trimmedComment = typeof comment === "string" ? comment.trim() : undefined;
    if (trimmedComment && trimmedComment.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ success: false, msg: `Comment must be ${MAX_COMMENT_LENGTH} characters or less` });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the professional can submit a review for the customer" });
    }

    if (booking.status !== "completed") {
      return res.status(400).json({ success: false, msg: "Can only review completed bookings" });
    }

    if (booking.professionalReview?.rating) {
      return res.status(400).json({ success: false, msg: "You have already reviewed this customer for this booking" });
    }

    booking.professionalReview = {
      rating,
      comment: trimmedComment || undefined,
      reviewedAt: new Date(),
    };

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Review submitted successfully",
      professionalReview: booking.professionalReview,
    });
  } catch (error) {
    console.error("Submit professional review error:", error);
    next(error);
  }
};

// Professional replies to a customer's review (text only)
export const replyToCustomerReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = req.params;
    const { comment } = req.body;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    if (!comment || typeof comment !== "string" || !comment.trim()) {
      return res.status(400).json({ success: false, msg: "Reply comment is required" });
    }

    if (comment.trim().length > 1000) {
      return res.status(400).json({ success: false, msg: "Reply comment must be 1000 characters or less" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the professional can reply to customer reviews" });
    }

    if (!booking.customerReview?.communicationLevel) {
      return res.status(400).json({ success: false, msg: "No customer review to reply to" });
    }

    if (booking.customerReview.reply?.comment) {
      return res.status(400).json({ success: false, msg: "You have already replied to this review" });
    }

    booking.customerReview.reply = {
      comment: comment.trim(),
      repliedAt: new Date(),
    };

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Reply submitted successfully",
      reply: booking.customerReview.reply,
    });
  } catch (error) {
    console.error("Reply to customer review error:", error);
    next(error);
  }
};

// Get all reviews for a professional (public endpoint)
export const getProfessionalReviews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { professionalId } = req.params;
    const { page = "1", limit = "10" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(professionalId)) {
      return res.status(400).json({ success: false, msg: "Invalid professional ID" });
    }

    const professional = await User.findById(professionalId).select("name role businessInfo profileImage serviceCategories hourlyRate createdAt location professionalStatus");
    if (!professional || professional.role !== "professional" || professional.professionalStatus !== "approved") {
      return res.status(404).json({ success: false, msg: "Professional not found" });
    }

    const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 50);
    const skip = (pageNum - 1) * limitNum;

    const query = {
      professional: new mongoose.Types.ObjectId(professionalId),
      status: "completed",
      "customerReview.communicationLevel": { $exists: true },
    };

    const [reviews, totalCount, ratingStats] = await Promise.all([
      Booking.find(query)
        .select("customerReview customer createdAt")
        .populate("customer", "name profileImage")
        .sort({ "customerReview.reviewedAt": -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(query),
      Booking.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            avgCommunication: { $avg: "$customerReview.communicationLevel" },
            avgValueOfDelivery: { $avg: "$customerReview.valueOfDelivery" },
            avgQualityOfService: { $avg: "$customerReview.qualityOfService" },
            totalReviews: { $sum: 1 },
          },
        },
      ]),
    ]);

    const stats = ratingStats[0] || {
      avgCommunication: 0,
      avgValueOfDelivery: 0,
      avgQualityOfService: 0,
      totalReviews: 0,
    };

    const overallAvg = stats.totalReviews > 0
      ? (stats.avgCommunication + stats.avgValueOfDelivery + stats.avgQualityOfService) / 3
      : 0;

    return res.status(200).json({
      success: true,
      data: {
        professional,
        reviews,
        ratingsSummary: {
          overallAverage: Math.round(overallAvg * 10) / 10,
          avgCommunication: Math.round((stats.avgCommunication || 0) * 10) / 10,
          avgValueOfDelivery: Math.round((stats.avgValueOfDelivery || 0) * 10) / 10,
          avgQualityOfService: Math.round((stats.avgQualityOfService || 0) * 10) / 10,
          totalReviews: stats.totalReviews,
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("Get professional reviews error:", error);
    next(error);
  }
};
