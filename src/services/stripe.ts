/**
 * Stripe Service - Central Stripe SDK initialization
 * Version: 2.1
 */

import Stripe from 'stripe';

// Validate that Stripe secret key is present
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY is not defined in environment variables');
  console.error('Please add STRIPE_SECRET_KEY to your .env file');
  console.error('Get your key from: https://dashboard.stripe.com/test/apikeys');
  // Don't throw in development to allow app to start
  if (process.env.NODE_ENV === 'production') {
    throw new Error('STRIPE_SECRET_KEY is required in production');
  }
}

// Initialize Stripe with latest API version
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2025-11-17.clover', // Use latest stable API version
  typescript: true,
  appInfo: {
    name: 'Fixera Platform',
    version: '2.1.0',
    url: 'https://fixera.com',
  },
});

// Stripe configuration constants
export const STRIPE_CONFIG = {
  // Payment settings
  defaultCurrency: (process.env.STRIPE_DEFAULT_CURRENCY || 'EUR').toUpperCase(),
  supportedCurrencies: (process.env.STRIPE_SUPPORTED_CURRENCIES || 'EUR,USD,GBP,CAD,AUD')
    .split(',')
    .map(c => c.trim().toUpperCase()),

  // Escrow/capture settings
  paymentHoldEnabled: process.env.STRIPE_PAYMENT_HOLD_ENABLED === 'true',

  // Commission settings
  commissionPercent: parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0'),

  // Frontend URL for redirects
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  // Webhook secret
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // Environment
  isProduction: process.env.NODE_ENV === 'production',
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'test',
};

// Log Stripe configuration on startup (without sensitive data)
console.log('✅ Stripe Service initialized:');
console.log(`   - Environment: ${STRIPE_CONFIG.environment}`);
console.log(`   - Default Currency: ${STRIPE_CONFIG.defaultCurrency}`);
console.log(`   - Supported Currencies: ${STRIPE_CONFIG.supportedCurrencies.join(', ')}`);
console.log(`   - Payment Hold (Escrow): ${STRIPE_CONFIG.paymentHoldEnabled ? 'Enabled' : 'Disabled'}`);
console.log(`   - Platform Commission: ${STRIPE_CONFIG.commissionPercent}%`);
console.log(`   - API Key: ${process.env.STRIPE_SECRET_KEY ? '✅ Configured' : '❌ Missing'}`);
console.log(`   - Webhook Secret: ${STRIPE_CONFIG.webhookSecret ? '✅ Configured' : '⚠️  Not configured (webhooks will fail)'}`);

// Export default for convenience
export default stripe;
