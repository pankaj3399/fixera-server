import { Router } from "express";
import { getGoogleMapsConfig, validateAddress } from "../../handlers/User/googleMaps";
import { validateVAT } from "../../handlers/User/validateVat";
import { getPublishedProject, getProjectTeamAvailability, getProjectScheduleProposals, getProjectProfessionalWorkingHours } from "../../handlers/Project";

// Public routes - accessible without authentication
const publicRouter = Router();

// Google Maps configuration (public endpoint)
publicRouter.route("/google-maps-config").get(getGoogleMapsConfig);

// Address validation (public endpoint for signup)
publicRouter.route("/validate-address").post(validateAddress);

// VAT validation (public endpoint for signup)
publicRouter.route("/vat/validate").post(validateVAT);

// Project viewing (public endpoint for customers to view projects)
publicRouter.route("/projects/:id").get(getPublishedProject);

// Team availability (public endpoint for booking calendar)
publicRouter.route("/projects/:id/availability").get(getProjectTeamAvailability);

// Schedule proposals (public endpoint for suggested dates/times)
publicRouter.route("/projects/:id/schedule-proposals").get(getProjectScheduleProposals);

// Professional working hours (public endpoint for hours mode bookings)
publicRouter.route("/projects/:id/working-hours").get(getProjectProfessionalWorkingHours);

export default publicRouter;
