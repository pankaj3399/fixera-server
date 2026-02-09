import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getGoogleMapsConfig, validateAddress } from "../../handlers/User/googleMaps";
import { validateVAT } from "../../handlers/User/validateVat";
import {
  getPublishedProject,
  getProjectScheduleProposals,
  getProjectScheduleWindow,
  getProjectTeamAvailability,
  getProjectWorkingHours,
} from "../../handlers/Project";

// Public routes - accessible without authentication
const publicRouter = Router();

const schedulingRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Google Maps configuration (public endpoint)
publicRouter.route("/google-maps-config").get(getGoogleMapsConfig);

// Address validation (public endpoint for signup)
publicRouter.route("/validate-address").post(validateAddress);

// VAT validation (public endpoint for signup)
publicRouter.route("/vat/validate").post(validateVAT);

// Project viewing (public endpoint for customers to view projects)
publicRouter.route("/projects/:id").get(getPublishedProject);

// Team availability (public endpoint for booking calendar)
publicRouter
  .route("/projects/:id/availability")
  .get(schedulingRateLimiter, getProjectTeamAvailability);
publicRouter
  .route("/projects/:id/working-hours")
  .get(schedulingRateLimiter, getProjectWorkingHours);
publicRouter
  .route("/projects/:id/schedule-proposals")
  .get(schedulingRateLimiter, getProjectScheduleProposals);
publicRouter
  .route("/projects/:id/schedule-window")
  .get(schedulingRateLimiter, getProjectScheduleWindow);

export default publicRouter;
