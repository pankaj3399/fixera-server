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
import { getProfessionalReviews, getProjectReviews } from "../../handlers/Booking/reviews";
import { validateReferralCodePublic } from "../../handlers/User/referralManagement";
import {
  getPublicProfessionalFavoriteCount,
  getPublicProjectFavoriteCount,
} from "../../handlers/Favorites";
import {
  listPublicCmsContent,
  getPublicCmsContentBySlug,
  listPublicFaq,
  listCmsSitemapEntries,
} from "../../handlers/Public/cms";
import { recordProfessionalView } from "../../handlers/Public/profileView";

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

// Referral code validation (public endpoint for signup)
publicRouter.route("/referral/validate/:code").get(schedulingRateLimiter, validateReferralCodePublic);

// Professional profile and reviews (public)
publicRouter
  .route("/professionals/:professionalId/reviews")
  .get(schedulingRateLimiter, getProfessionalReviews);

// Project-specific reviews (public)
publicRouter
  .route("/projects/:projectId/reviews")
  .get(schedulingRateLimiter, getProjectReviews);

// Profile view tracking (public, rate-limited, dedup per visitor/day)
publicRouter
  .route("/professionals/:id/view")
  .post(schedulingRateLimiter, recordProfessionalView);

// Public favorite counts (social proof)
publicRouter
  .route("/professionals/:id/favorites-count")
  .get(schedulingRateLimiter, getPublicProfessionalFavoriteCount);
publicRouter
  .route("/projects/:id/favorites-count")
  .get(schedulingRateLimiter, getPublicProjectFavoriteCount);

// CMS public endpoints
publicRouter.route("/cms/sitemap").get(listCmsSitemapEntries);
publicRouter.route("/cms/faq").get(listPublicFaq);
publicRouter.route("/cms/:type").get(listPublicCmsContent);
publicRouter.route("/cms/:type/:slug").get(getPublicCmsContentBySlug);

export default publicRouter;
