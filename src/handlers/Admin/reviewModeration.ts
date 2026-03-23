import { Request, Response, NextFunction } from "express";
import Booking from "../../models/booking";
import mongoose from "mongoose";

// Hide a customer review (admin only)
export const hideReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = req.user?._id;
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (!booking.customerReview?.communicationLevel) {
      return res.status(400).json({ success: false, msg: "No customer review on this booking" });
    }

    if (booking.customerReview.isHidden) {
      return res.status(400).json({ success: false, msg: "Review is already hidden" });
    }

    booking.customerReview.isHidden = true;
    booking.customerReview.hiddenBy = adminId;
    booking.customerReview.hiddenAt = new Date();
    await booking.save();

    return res.status(200).json({ success: true, msg: "Review hidden successfully" });
  } catch (error) {
    console.error("Hide review error:", error);
    next(error);
  }
};

// Unhide a customer review (admin only)
export const unhideReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = req.user?._id;
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (!booking.customerReview?.isHidden) {
      return res.status(400).json({ success: false, msg: "Review is not hidden" });
    }

    // Use atomic $set/$unset to properly remove fields and record audit trail
    await Booking.updateOne(
      { _id: bookingId },
      {
        $set: {
          "customerReview.isHidden": false,
          "customerReview.unhiddenBy": adminId,
          "customerReview.unhiddenAt": new Date(),
        },
        $unset: {
          "customerReview.hiddenBy": "",
          "customerReview.hiddenAt": "",
        },
      }
    );

    return res.status(200).json({ success: true, msg: "Review unhidden successfully" });
  } catch (error) {
    console.error("Unhide review error:", error);
    next(error);
  }
};

// Get all hidden reviews (admin only)
export const getHiddenReviews = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = "1", limit = "20" } = req.query;

    const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);
    const skip = (pageNum - 1) * limitNum;

    const query = {
      "customerReview.isHidden": true,
      "customerReview.communicationLevel": { $exists: true },
    };

    const [reviews, totalCount] = await Promise.all([
      Booking.find(query)
        .select("customerReview customer professional project createdAt")
        .populate("customer", "name profileImage")
        .populate("professional", "name businessInfo profileImage")
        .populate("project", "title")
        .sort({ "customerReview.hiddenAt": -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Booking.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        reviews,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    console.error("Get hidden reviews error:", error);
    next(error);
  }
};
