/**
 * Stripe Connect Account Handlers
 * Handles professional Stripe account creation and onboarding
 */

import { Request, Response } from 'express';
import { stripe, STRIPE_CONFIG } from '../../services/stripe';
import User from '../../models/user';
import { StripeAccountStatusResponse } from '../../Types/stripe';

/**
 * Create Stripe Connect Express account for professional
 * POST /api/stripe/connect/create-account
 */
export const createConnectAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    // Get user and verify they're a professional
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'User not found' }
      });
    }

    if (user.role !== 'professional') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_PROFESSIONAL', message: 'Only professionals can create Stripe accounts' }
      });
    }

    if (user.professionalStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'NOT_APPROVED',
          message: 'Professional must be approved before connecting Stripe'
        }
      });
    }

    // Check if account already exists
    if (user.stripe?.accountId) {
      // Return existing account status
      try {
        const account = await stripe.accounts.retrieve(user.stripe.accountId);

        return res.json({
          success: true,
          data: {
            accountId: account.id,
            onboardingCompleted: account.details_submitted || false,
            chargesEnabled: account.charges_enabled || false,
            payoutsEnabled: account.payouts_enabled || false,
            detailsSubmitted: account.details_submitted || false,
            accountStatus: account.charges_enabled ? 'active' : 'pending',
            message: 'Stripe account already exists'
          }
        });
      } catch (error) {
        // If account doesn't exist in Stripe, create new one
        console.log('Existing account not found in Stripe, creating new one');
      }
    }

    // Create new Stripe Connect Express account
    const account = await stripe.accounts.create({
      type: 'express',
      country: user.businessInfo?.country || user.location?.country || 'BE',
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual', // or 'company' based on user type
      metadata: {
        userId: user._id.toString(),
        professionalId: user.professionalId || user._id.toString(),
        platform: 'fixera',
        environment: STRIPE_CONFIG.environment,
      },
    });

    // Update user with Stripe account info
    user.stripe = {
      accountId: account.id,
      onboardingCompleted: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      chargesEnabled: false,
      accountStatus: 'pending',
      createdAt: new Date(),
    };
    await user.save();

    console.log(`✅ Stripe Connect account created for user ${user._id}: ${account.id}`);

    res.json({
      success: true,
      data: {
        accountId: account.id,
        onboardingCompleted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        accountStatus: 'pending',
        requiresOnboarding: true,
      }
    });

  } catch (error: any) {
    console.error('Error creating Stripe Connect account:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to create Stripe account'
      }
    });
  }
};

/**
 * Generate Stripe onboarding link
 * POST /api/stripe/connect/create-onboarding-link
 */
export const createOnboardingLink = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const user = await User.findById(userId);
    if (!user || !user.stripe?.accountId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_STRIPE_ACCOUNT', message: 'Stripe account not found. Create one first.' }
      });
    }

    // Generate account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: user.stripe.accountId,
      refresh_url: `${STRIPE_CONFIG.frontendUrl}/professional/stripe/refresh`,
      return_url: `${STRIPE_CONFIG.frontendUrl}/professional/stripe/complete`,
      type: 'account_onboarding',
    });

    // Update last onboarding refresh time
    user.stripe.lastOnboardingRefresh = new Date();
    await user.save();

    res.json({
      success: true,
      data: {
        url: accountLink.url,
        expiresAt: accountLink.expires_at,
      }
    });

  } catch (error: any) {
    console.error('Error creating onboarding link:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to create onboarding link'
      }
    });
  }
};

/**
 * Get Stripe account status
 * GET /api/stripe/connect/account-status
 */
export const getAccountStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const user = await User.findById(userId);
    if (!user || !user.stripe?.accountId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_STRIPE_ACCOUNT', message: 'Stripe account not found' }
      });
    }

    // Retrieve account from Stripe
    const account = await stripe.accounts.retrieve(user.stripe.accountId);

    // Update user's Stripe info in database
    user.stripe.onboardingCompleted = account.details_submitted || false;
    user.stripe.chargesEnabled = account.charges_enabled || false;
    user.stripe.payoutsEnabled = account.payouts_enabled || false;
    user.stripe.detailsSubmitted = account.details_submitted || false;
    user.stripe.accountStatus = account.charges_enabled ? 'active' :
                                 account.details_submitted ? 'pending' : 'pending';
    await user.save();

    const statusResponse: StripeAccountStatusResponse = {
      accountId: account.id,
      onboardingCompleted: account.details_submitted || false,
      chargesEnabled: account.charges_enabled || false,
      payoutsEnabled: account.payouts_enabled || false,
      detailsSubmitted: account.details_submitted || false,
      accountStatus: user.stripe.accountStatus,
      requirements: {
        currentlyDue: account.requirements?.currently_due || [],
        pendingVerification: account.requirements?.pending_verification || [],
      }
    };

    res.json({
      success: true,
      data: statusResponse
    });

  } catch (error: any) {
    console.error('Error fetching account status:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to fetch account status'
      }
    });
  }
};

/**
 * Generate Stripe Express dashboard link
 * GET /api/stripe/connect/dashboard-link
 */
export const createDashboardLink = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user._id;

    const user = await User.findById(userId);
    if (!user || !user.stripe?.accountId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_STRIPE_ACCOUNT', message: 'Stripe account not found' }
      });
    }

    // Create login link to Stripe Express dashboard
    const loginLink = await stripe.accounts.createLoginLink(user.stripe.accountId);

    res.json({
      success: true,
      data: {
        url: loginLink.url,
      }
    });

  } catch (error: any) {
    console.error('Error creating dashboard link:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STRIPE_ERROR',
        message: error.message || 'Failed to create dashboard link'
      }
    });
  }
};
