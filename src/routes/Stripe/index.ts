/**
 * Stripe API Routes
 */

import express from 'express';
import {
  createConnectAccount,
  createOnboardingLink,
  getAccountStatus,
  createDashboardLink,
} from '../../handlers/Stripe/connectAccount';
import {
  confirmPayment,
  refundPayment,
} from '../../handlers/Stripe/payment';
import { handleWebhook } from '../../handlers/Stripe/webhooks';
import { protect } from '../../middlewares/auth';

const router = express.Router();

router.post('/connect/create-account', protect, createConnectAccount);
router.post('/connect/create-onboarding-link', protect, createOnboardingLink);
router.get('/connect/account-status', protect, getAccountStatus);
router.get('/connect/dashboard-link', protect, createDashboardLink);
router.post('/payment/confirm', protect, confirmPayment);
router.post('/payment/refund', protect, refundPayment);
router.post(
  '/webhooks',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

export default router;
