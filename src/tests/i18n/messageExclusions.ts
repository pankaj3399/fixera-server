/**
 * Strings the message scanner finds that are deliberately NOT translated.
 * Every entry needs a reason; anything else the scanner reports must have an
 * nl and fr translation in `src/i18n/messages`.
 */

/** Whole modules whose responses never reach a localized user screen. */
export const EXCLUDED_FILES: Record<string, string> = {
  "src/handlers/Public/cron.ts": "Vercel cron endpoint; responses are read by the scheduler/operators only",
  "src/handlers/Stripe/webhooks.ts": "Stripe webhook acknowledgements; read by Stripe, never shown to users",
  "src/handlers/Project/admin.ts": "Admin project moderation endpoints; the admin panel stays English",
  "src/utils/adminRbac/assertPermission.ts": "Admin staff permission denials; the admin panel stays English",
  "src/services/peppolDispatch.ts": "Peppol/Odoo dispatch diagnostics for operators",
  "src/utils/retryPeppolDispatches.ts": "Peppol retry diagnostics for operators (cron)",
  "src/utils/marketing/sendCampaign.ts": "Admin campaign delivery state; the admin panel stays English",
  "src/utils/marketing/brevoMarketing.ts": "Brevo provider diagnostics for admins/operators",
  "src/utils/emailService.ts": "Email provider diagnostics, logged and never returned verbatim",
};

/** Individual strings in otherwise user-facing modules. */
export const EXCLUDED_MESSAGES: Record<string, string> = {
  "JWT_SECRET is not configured": "Operator configuration failure; never expected in a configured environment",
  "Another active write fence was created concurrently": "Internal concurrency diagnostic (account write fence)",
  "Calendar transaction commit-phase replay needs a document reset": "Internal transaction retry signal",
};
