import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getGoogleMapsConfig, validateAddress } from "../../handlers/User/googleMaps";
import { validateVAT } from "../../handlers/User/validateVat";
import {
  getProjectAvailableSlots,
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
  listPublicPolicyLinks,
} from "../../handlers/Public/cms";
import { getPublicSiteSettings } from "../../handlers/Public/siteSettings";
import { getPublicExchangeRates } from "../../handlers/Public/exchangeRates";
import {
  listPublicSiteAnnouncements,
  recordSiteAnnouncementEvent,
} from "../../handlers/Public/siteAnnouncements";
import { unsubscribeMarketing } from "../../handlers/Public/marketingUnsubscribe";
import { getMarketingLanguages } from "../../handlers/Public/marketingLanguages";
import { recordProfessionalView } from "../../handlers/Public/profileView";
import { recordServiceView } from "../../handlers/Public/serviceView";
import {
  runNotificationRemindersCron,
  runPeppolRetryCron,
  runKpiMonthlyReportCron,
  runMarketingCampaignsCron,
} from "../../handlers/Public/cron";
import { optionalProtect } from "../../middlewares/auth";

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
publicRouter
  .route("/projects/:id/available-slots")
  .get(schedulingRateLimiter, getProjectAvailableSlots);

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
  .post(schedulingRateLimiter, optionalProtect, recordProfessionalView);

// Service-page view tracking (public, rate-limited, dedup per visitor/day)
publicRouter
  .route("/services/:serviceId/view")
  .post(schedulingRateLimiter, optionalProtect, recordServiceView);

// Public favorite counts (social proof)
publicRouter
  .route("/professionals/:id/favorites-count")
  .get(schedulingRateLimiter, getPublicProfessionalFavoriteCount);
publicRouter
  .route("/projects/:id/favorites-count")
  .get(schedulingRateLimiter, getPublicProjectFavoriteCount);

// Public site settings (social links etc)
publicRouter.route("/site-settings").get(getPublicSiteSettings);

// ECB EUR-based daily exchange rates (cached in memory + Mongo snapshot)
publicRouter.route("/exchange-rates").get(getPublicExchangeRates);

// Marketing site announcements (top bar / modal / exit-intent)
publicRouter.route("/site-announcements").get(schedulingRateLimiter, listPublicSiteAnnouncements);
publicRouter
  .route("/site-announcements/:id/event")
  .post(schedulingRateLimiter, recordSiteAnnouncementEvent);

// CMS public endpoints
publicRouter.route("/cms/sitemap").get(listCmsSitemapEntries);
publicRouter.route("/cms/faq").get(listPublicFaq);
publicRouter.route("/cms/policy-links").get(listPublicPolicyLinks);
publicRouter.route("/cms/:type").get(listPublicCmsContent);
publicRouter.route("/cms/:type/:slug").get(getPublicCmsContentBySlug);

// Marketing unsubscribe (public) — GET preview/verify only; POST mutates
publicRouter
  .route("/marketing/unsubscribe")
  .get(schedulingRateLimiter, unsubscribeMarketing)
  .post(schedulingRateLimiter, unsubscribeMarketing);
publicRouter.route("/marketing/languages").get(schedulingRateLimiter, getMarketingLanguages);

// Cron entrypoints (secured via CRON_SECRET bearer token)
publicRouter.route("/cron/notification-reminders").get(runNotificationRemindersCron);
publicRouter.route("/cron/notification-reminders").post(runNotificationRemindersCron);
publicRouter.route("/cron/peppol-retry").get(runPeppolRetryCron);
publicRouter.route("/cron/peppol-retry").post(runPeppolRetryCron);
publicRouter.route("/cron/kpi-monthly-report").get(runKpiMonthlyReportCron);
publicRouter.route("/cron/kpi-monthly-report").post(runKpiMonthlyReportCron);
// Manual entrypoint — not a separate Vercel cron (Hobby limit = 1; piggybacked daily)
publicRouter.route("/cron/marketing-campaigns").get(runMarketingCampaignsCron);
publicRouter.route("/cron/marketing-campaigns").post(runMarketingCampaignsCron);

export default publicRouter;
