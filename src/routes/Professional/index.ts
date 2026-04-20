import { Router } from "express";
import { getProfessionalsByCategory, getAllProfessionals } from "../../handlers/Professional";
import { getProfessionalDashboardStats, getProfessionalDashboardBookings } from "../../handlers/Professional/dashboardStats";
import { authMiddleware } from "../../middlewares/auth";

const router = Router();

// Public route to get all approved professionals
router.route("/").get(getAllProfessionals);

// Public route to get professionals by category slug
router.route("/by-category/:categorySlug").get(getProfessionalsByCategory);

// Authenticated professional dashboard stats
router.route("/dashboard/stats").get(authMiddleware(['professional']), getProfessionalDashboardStats);
router.route("/dashboard/bookings").get(authMiddleware(['professional']), getProfessionalDashboardBookings);

export default router;
