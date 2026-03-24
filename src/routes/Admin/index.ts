import { Router } from "express";
import {
  getPendingProfessionals,
  getProfessionalDetails,
  requireAdmin,
  approveProfessional,
  rejectProfessional,
  suspendProfessional,
  reactivateProfessional,
  verifyIdProof,
  reviewIdChanges,
  getApprovalStats
} from "../../handlers/Admin/professionalApprovals";
import {
  getLoyaltyConfig,
  updateLoyaltyConfig,
  recalculateCustomerTiers,
  getLoyaltyAnalytics,
  getPointsConfig,
  updatePointsConfig,
  adjustUserPoints,
  getPointsAnalytics,
  getProfessionalLevelConfig,
  updateProfessionalLevelConfig,
  recalculateProfessionalLevels
} from "../../handlers/Admin/loyaltyManagement";
import {
  getAllServiceConfigurations,
  getServiceConfigurationById,
  createServiceConfiguration,
  updateServiceConfiguration,
  deleteServiceConfiguration,
  toggleServiceConfigurationActive,
  getCategories,
  getServicesByCategory
} from "../../handlers/Admin/serviceConfigurationManagement";
import { getPayments, capturePayment } from "../../handlers/Admin/payments";
import {
  getReferralConfig,
  updateReferralConfig,
  getReferralAnalytics,
  getReferralList,
  revokeReferral
} from "../../handlers/Admin/referralManagement";
import {
  getPlatformSettings,
  updatePlatformSettings,
} from "../../handlers/Admin/platformSettings";
import {
  hideReview,
  unhideReview,
  getHiddenReviews,
} from "../../handlers/Admin/reviewModeration";

const adminRouter = Router();

// All admin routes require authentication and admin role
adminRouter.use(requireAdmin);

// Professional approval routes
adminRouter.route('/professionals').get(getPendingProfessionals);
adminRouter.route('/professionals/:professionalId').get(getProfessionalDetails);
adminRouter.route('/professionals/:professionalId/approve').put(approveProfessional);
adminRouter.route('/professionals/:professionalId/reject').put(rejectProfessional);
adminRouter.route('/professionals/:professionalId/suspend').put(suspendProfessional);
adminRouter.route('/professionals/:professionalId/reactivate').put(reactivateProfessional);
adminRouter.route('/professionals/:professionalId/verify-id').put(verifyIdProof);
adminRouter.route('/professionals/:professionalId/id-changes').put(reviewIdChanges);
adminRouter.route('/stats/approvals').get(getApprovalStats);

// Loyalty system management routes
adminRouter.route('/loyalty/config').get(getLoyaltyConfig).put(updateLoyaltyConfig);
adminRouter.route('/loyalty/recalculate').post(recalculateCustomerTiers);
adminRouter.route('/loyalty/analytics').get(getLoyaltyAnalytics);

// Points system management routes
adminRouter.route('/points/config').get(getPointsConfig).put(updatePointsConfig);
adminRouter.route('/points/analytics').get(getPointsAnalytics);
adminRouter.route('/points/adjust').post(adjustUserPoints);

// Professional level management routes
adminRouter.route('/professional-levels/config').get(getProfessionalLevelConfig).put(updateProfessionalLevelConfig);
adminRouter.route('/professional-levels/recalculate').post(recalculateProfessionalLevels);

// Referral system management routes
adminRouter.route('/referral/config').get(getReferralConfig);
adminRouter.route('/referral/config').put(updateReferralConfig);
adminRouter.route('/referral/analytics').get(getReferralAnalytics);
adminRouter.route('/referral/list').get(getReferralList);
adminRouter.route('/referral/:referralId/revoke').put(revokeReferral);

// Service configuration management routes
adminRouter.route('/service-configurations').get(getAllServiceConfigurations);
adminRouter.route('/service-configurations').post(createServiceConfiguration);
adminRouter.route('/service-configurations/categories').get(getCategories);
adminRouter.route('/service-configurations/services/:category').get(getServicesByCategory);
adminRouter.route('/service-configurations/:id').get(getServiceConfigurationById);
adminRouter.route('/service-configurations/:id').put(updateServiceConfiguration);
adminRouter.route('/service-configurations/:id').delete(deleteServiceConfiguration);
adminRouter.route('/service-configurations/:id/toggle-active').patch(toggleServiceConfigurationActive);
adminRouter.route('/payments').get(getPayments);
adminRouter.route('/payments/:paymentId/capture').post(capturePayment);

// Review moderation routes
adminRouter.route('/reviews/hidden').get(getHiddenReviews);
adminRouter.route('/reviews/:bookingId/hide').put(hideReview);
adminRouter.route('/reviews/:bookingId/unhide').put(unhideReview);

// Platform settings routes
adminRouter.route('/platform-settings').get(getPlatformSettings).put(updatePlatformSettings);

export default adminRouter;
