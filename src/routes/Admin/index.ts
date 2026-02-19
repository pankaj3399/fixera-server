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
  testLoyaltySystem
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
adminRouter.route('/loyalty/config').get(getLoyaltyConfig);
adminRouter.route('/loyalty/config').put(updateLoyaltyConfig);
adminRouter.route('/loyalty/recalculate').post(recalculateCustomerTiers);
adminRouter.route('/loyalty/analytics').get(getLoyaltyAnalytics);
adminRouter.route('/loyalty/test').post(testLoyaltySystem);

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

export default adminRouter;
