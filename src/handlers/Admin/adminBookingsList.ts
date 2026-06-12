import { Request, Response } from "express";
import Booking from "../../models/booking";
import User from "../../models/user";

const BOOKING_STATUSES = [
  "rfq",
  "rfq_accepted",
  "draft_quote",
  "quoted",
  "quote_accepted",
  "quote_rejected",
  "payment_pending",
  "booked",
  "rescheduling_requested",
  "in_progress",
  "professional_completed",
  "completed",
  "cancelled",
  "dispute",
  "refunded",
];

const parsePagination = (query: any) => {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
  return { page, limit, skip: (page - 1) * limit };
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const listAdminBookings = async (req: Request, res: Response) => {
  try {
    const { status, q } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const filter: any = {};
    if (typeof status === "string" && BOOKING_STATUSES.includes(status)) {
      filter.status = status;
    }

    const search = typeof q === "string" ? q.trim() : "";
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      const matchedUsers = await User.find({
        $or: [{ name: regex }, { email: regex }, { username: regex }],
      })
        .select("_id")
        .limit(200)
        .lean();
      const userIds = matchedUsers.map((u) => u._id);
      filter.$or = [
        { bookingNumber: regex },
        { customer: { $in: userIds } },
        { professional: { $in: userIds } },
      ];
    }

    const [items, total] = await Promise.all([
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          "bookingNumber status scheduledStartDate createdAt payment.totalWithVat payment.amount payment.currency payment.status customer professional project"
        )
        .populate("customer", "name email")
        .populate("professional", "name email username")
        .populate("project", "title category service")
        .lean(),
      Booking.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: { items, total, page, limit },
    });
  } catch (error: any) {
    console.error("List admin bookings error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load bookings" });
  }
};
