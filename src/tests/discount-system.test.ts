/**
 * Discount System Integration Test
 *
 * Tests:
 * 1. calculateDiscountedPayouts — pure math (no DB)
 * 2. calculateAutoDiscount — with real DB data
 * 3. Discount preview API handler logic
 * 4. Edge cases (caps, minimum payment, disabled loyalty, no project)
 *
 * Run: npx tsx src/tests/discount-system.test.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../config/db';
import User from '../models/user';
import LoyaltyConfig from '../models/loyaltyConfig';
import Project from '../models/project';
import Booking from '../models/booking';
import { calculateAutoDiscount, calculateDiscountedPayouts, DiscountBreakdown } from '../utils/discountEngine';

// ─── Test helpers ─────────────────────────────────────────────────

const roundToTwo = (value: number): number => Math.round(value * 100) / 100;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ ${message}`);
  }
}

function assertClose(actual: number, expected: number, message: string, tolerance = 0.01) {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (expected ${expected}, got ${actual})`);
}

// ─── Test fixtures ────────────────────────────────────────────────

let testCustomerId: any;
let testProfessionalId: any;
let testProjectId: any;
let testBookingId: any;

const TEST_EMAIL_PREFIX = `discount-test-${Date.now()}`;

// Customer totalSpent values used in fixtures
const GOLD_CUSTOMER_TOTAL_SPENT = 6000;
const BRONZE_CUSTOMER_TOTAL_SPENT = 100;

async function createTestFixtures() {
  console.log('\n📦 Creating test fixtures...');

  // Create test customer with Gold tier
  const customer = await User.create({
    name: 'Test Customer Discount',
    email: `${TEST_EMAIL_PREFIX}-customer@test.com`,
    phone: '+32400000001',
    password: 'TestPassword123!',
    role: 'customer',
    customerType: 'individual',
    loyaltyLevel: 'Gold',
    totalSpent: GOLD_CUSTOMER_TOTAL_SPENT,
    totalBookings: 10,
    location: {
      type: 'Point',
      coordinates: [4.3517, 50.8503],
      address: 'Test Address',
      city: 'Brussels',
      country: 'BE',
    },
  });
  testCustomerId = customer._id;
  console.log(`  Created customer: ${customer.email} (${customer.loyaltyLevel})`);

  // Create test professional
  const professional = await User.create({
    name: 'Test Professional Discount',
    email: `${TEST_EMAIL_PREFIX}-pro@test.com`,
    phone: '+32400000002',
    password: 'TestPassword123!',
    role: 'professional',
    professionalStatus: 'approved',
    businessInfo: {
      companyName: 'Test Pro Co',
      address: 'Pro Street 1',
      city: 'Brussels',
      country: 'BE',
    },
    stripe: {
      accountId: 'acct_test_discount',
      chargesEnabled: true,
      payoutsEnabled: true,
    },
  });
  testProfessionalId = professional._id;
  console.log(`  Created professional: ${professional.email}`);

  // Create test project with repeat-buyer discount
  const project = await Project.create({
    professionalId: testProfessionalId,
    title: 'Test Project For Discount Testing Purpose',
    category: 'plumber',
    service: 'plumber',
    description: 'This is a test project for discount system testing',
    priceModel: 'fixed',
    distance: { address: 'Test Street 1, Brussels', maxKmRange: 50, useCompanyAddress: false, noBorders: false, location: { type: 'Point', coordinates: [4.3517, 50.8503] } },
    media: { images: ['https://placeholder.test/img.jpg'] },
    subprojects: [{
      name: 'Test Sub',
      description: 'Test subproject for testing',
      projectType: ['plumber'],
      professionalInputs: [],
      pricing: { type: 'fixed', amount: 500 },
      included: [],
      materialsIncluded: false,
      preparationDuration: { value: 1, unit: 'days' },
      executionDuration: { value: 2, unit: 'days' },
      warrantyPeriod: { value: 1, unit: 'years' },
    }],
    status: 'published',
    repeatBuyerDiscount: {
      enabled: true,
      percentage: 10,
      minPreviousBookings: 2,
      maxDiscountAmount: 50,
    },
  });
  testProjectId = project._id;
  console.log(`  Created project: ${project.title} (repeat discount: 10%, min: 2 bookings, cap: €50)`);

  // Create 3 completed bookings (so customer qualifies for repeat discount)
  for (let i = 0; i < 3; i++) {
    await Booking.create({
      customer: testCustomerId,
      professional: testProfessionalId,
      project: testProjectId,
      bookingType: 'project',
      status: 'completed',
      rfqData: {
        serviceType: 'plumber',
        description: `Completed booking ${i + 1}`,
      },
      location: {
        type: 'Point',
        coordinates: [4.3517, 50.8503],
      },
      quote: { amount: 500, currency: 'EUR', submittedAt: new Date(), submittedBy: testProfessionalId },
      payment: { amount: 500, currency: 'EUR', status: 'completed' },
    });
  }
  console.log(`  Created 3 completed bookings for repeat-buyer qualification`);

  // Create a "quoted" booking (the one we'll test discounts on)
  const booking = await Booking.create({
    customer: testCustomerId,
    professional: testProfessionalId,
    project: testProjectId,
    bookingType: 'project',
    status: 'quoted',
    rfqData: {
      serviceType: 'plumber',
      description: 'Test booking for discount preview',
    },
    location: {
      type: 'Point',
      coordinates: [4.3517, 50.8503],
    },
    quote: { amount: 500, currency: 'EUR', submittedAt: new Date(), submittedBy: testProfessionalId },
  });
  testBookingId = booking._id;
  console.log(`  Created quoted booking: ${booking.bookingNumber} (€500)`);
}

async function cleanupTestFixtures() {
  console.log('\n🧹 Cleaning up test fixtures...');
  await Booking.deleteMany({ customer: testCustomerId });
  await Project.findByIdAndDelete(testProjectId);
  await User.findByIdAndDelete(testCustomerId);
  await User.findByIdAndDelete(testProfessionalId);
  console.log('  Done.');
}

// ─── Tests ────────────────────────────────────────────────────────

async function testPurePayoutCalculation() {
  console.log('\n═══ Test 1: calculateDiscountedPayouts (pure math) ═══');

  // Scenario: €500 quote, 5% loyalty (€25), 10% repeat (€50), 15% commission
  const discount: DiscountBreakdown = {
    loyaltyDiscount: { tier: 'Gold', percentage: 5, amount: 25, capped: false },
    repeatBuyerDiscount: { percentage: 10, amount: 50, previousBookings: 3, capped: false },
    totalDiscount: 75,
    originalAmount: 500,
    finalAmount: 425,
  };

  const result = calculateDiscountedPayouts(discount, 15);

  // Customer pays: 425
  assertClose(result.customerPays, 425, 'Customer pays €425');

  // Professional base = 500 - 50 (repeat) = 450
  // Commission on 450 at 15% = 67.50
  // Professional payout = 450 - 67.50 = 382.50
  assertClose(result.professionalPayout, 382.50, 'Professional payout €382.50');

  // Platform commission = 67.50 - 25 (loyalty absorbed) = 42.50
  assertClose(result.platformCommission, 42.50, 'Platform commission €42.50');

  // Verify: customer pays = platform commission + professional payout + ...
  // 425 = 42.50 + 382.50 = 425 ✅ (platform absorbed 25 from its share)
  assertClose(result.platformCommission + result.professionalPayout, result.customerPays,
    'Commission + Payout = Customer pays');
}

async function testPurePayoutNoDiscount() {
  console.log('\n═══ Test 2: calculateDiscountedPayouts (no discount) ═══');

  const discount: DiscountBreakdown = {
    loyaltyDiscount: { tier: 'Bronze', percentage: 0, amount: 0, capped: false },
    repeatBuyerDiscount: { percentage: 0, amount: 0, previousBookings: 0, capped: false },
    totalDiscount: 0,
    originalAmount: 1000,
    finalAmount: 1000,
  };

  const result = calculateDiscountedPayouts(discount, 10);

  assertClose(result.customerPays, 1000, 'Customer pays full €1000');
  assertClose(result.platformCommission, 100, 'Platform commission €100 (10%)');
  assertClose(result.professionalPayout, 900, 'Professional payout €900');
}

async function testPurePayoutOnlyLoyalty() {
  console.log('\n═══ Test 3: calculateDiscountedPayouts (loyalty only) ═══');

  const discount: DiscountBreakdown = {
    loyaltyDiscount: { tier: 'Platinum', percentage: 10, amount: 100, capped: false },
    repeatBuyerDiscount: { percentage: 0, amount: 0, previousBookings: 0, capped: false },
    totalDiscount: 100,
    originalAmount: 1000,
    finalAmount: 900,
  };

  const result = calculateDiscountedPayouts(discount, 10);

  assertClose(result.customerPays, 900, 'Customer pays €900');
  // Professional base = 1000 (no repeat discount). Commission = 100. Payout = 900.
  assertClose(result.professionalPayout, 900, 'Professional payout €900 (full, platform absorbs loyalty)');
  // Platform commission = 100 - 100 (loyalty absorbed) = 0
  assertClose(result.platformCommission, 0, 'Platform commission €0 (absorbed loyalty)');
}

async function testPurePayoutOnlyRepeat() {
  console.log('\n═══ Test 4: calculateDiscountedPayouts (repeat only) ═══');

  const discount: DiscountBreakdown = {
    loyaltyDiscount: { tier: 'Bronze', percentage: 0, amount: 0, capped: false },
    repeatBuyerDiscount: { percentage: 5, amount: 50, previousBookings: 3, capped: false },
    totalDiscount: 50,
    originalAmount: 1000,
    finalAmount: 950,
  };

  const result = calculateDiscountedPayouts(discount, 10);

  assertClose(result.customerPays, 950, 'Customer pays €950');
  // Professional base = 1000 - 50 = 950. Commission = 95. Payout = 855.
  assertClose(result.professionalPayout, 855, 'Professional payout €855 (absorbs repeat discount)');
  assertClose(result.platformCommission, 95, 'Platform commission €95');
}

async function testDiscountBreakdownWithDB() {
  console.log('\n═══ Test 5: calculateAutoDiscount (DB integration) ═══');

  const quoteAmount = 500;
  const discount = await calculateAutoDiscount(
    testCustomerId.toString(),
    testProfessionalId.toString(),
    testProjectId.toString(),
    quoteAmount,
    GOLD_CUSTOMER_TOTAL_SPENT
  );

  console.log('  Discount breakdown:', JSON.stringify(discount, null, 2));

  // Loyalty: use actual DB values
  const expectedLoyaltyRaw = roundToTwo((quoteAmount * goldTierDiscount) / 100);
  const expectedLoyalty = goldTierMaxCap && expectedLoyaltyRaw > goldTierMaxCap ? goldTierMaxCap : expectedLoyaltyRaw;

  assert(discount.loyaltyDiscount.tier === 'Gold', 'Loyalty tier is Gold');
  assertClose(discount.loyaltyDiscount.percentage, goldTierDiscount, `Loyalty percentage is ${goldTierDiscount}%`);
  assertClose(discount.loyaltyDiscount.amount, expectedLoyalty, `Loyalty discount amount is €${expectedLoyalty}`);

  // Repeat: 10% of 500 = 50, cap 50 → 50, customer has 3 completed bookings (min 2)
  assertClose(discount.repeatBuyerDiscount.percentage, 10, 'Repeat percentage is 10%');
  assertClose(discount.repeatBuyerDiscount.amount, 50, 'Repeat discount amount is €50 (capped)');
  assert(discount.repeatBuyerDiscount.previousBookings >= 2, `Customer has ${discount.repeatBuyerDiscount.previousBookings} completed bookings (>= 2)`);

  // Total
  const expectedTotal = expectedLoyalty + 50;
  const expectedDiscounted = quoteAmount - expectedTotal;
  assertClose(discount.totalDiscount, expectedTotal, `Total discount is €${expectedTotal}`);
  assertClose(discount.originalAmount, quoteAmount, 'Original amount is €500');
  assertClose(discount.finalAmount, expectedDiscounted, `Discounted amount is €${expectedDiscounted}`);
}

async function testDiscountCapHit() {
  console.log('\n═══ Test 6: Discount cap enforcement ═══');

  const quoteAmount = 5000;
  const discount = await calculateAutoDiscount(
    testCustomerId.toString(),
    testProfessionalId.toString(),
    testProjectId.toString(),
    quoteAmount,
    GOLD_CUSTOMER_TOTAL_SPENT
  );

  // Loyalty: goldTierDiscount% of 5000, capped at goldTierMaxCap
  const loyaltyRaw = roundToTwo((quoteAmount * goldTierDiscount) / 100);
  const expectedLoyaltyCapped = goldTierMaxCap && loyaltyRaw > goldTierMaxCap ? goldTierMaxCap : loyaltyRaw;

  if (goldTierMaxCap && loyaltyRaw > goldTierMaxCap) {
    assertClose(discount.loyaltyDiscount.amount, goldTierMaxCap, `Loyalty discount capped at €${goldTierMaxCap} (raw would be €${loyaltyRaw})`);
  } else {
    assertClose(discount.loyaltyDiscount.amount, loyaltyRaw, `Loyalty discount is €${loyaltyRaw} (no cap hit)`);
  }

  // Repeat: 10% of 5000 = 500, but cap is 50 → 50
  assertClose(discount.repeatBuyerDiscount.amount, 50, 'Repeat discount capped at €50 (not €500)');

  const expectedTotal = expectedLoyaltyCapped + 50;
  assertClose(discount.totalDiscount, expectedTotal, `Total discount is €${expectedTotal}`);
  assertClose(discount.finalAmount, quoteAmount - expectedTotal, `Discounted amount is €${quoteAmount - expectedTotal}`);
}

async function testNoRepeatDiscountBelowMinBookings() {
  console.log('\n═══ Test 7: No repeat discount when below min bookings ═══');

  const freshCustomer = await User.create({
    name: 'Fresh Customer',
    email: `${TEST_EMAIL_PREFIX}-fresh@test.com`,
    phone: '+32400000003',
    password: 'TestPassword123!',
    role: 'customer',
    customerType: 'individual',
    loyaltyLevel: 'Gold',
    totalSpent: GOLD_CUSTOMER_TOTAL_SPENT,
    location: { type: 'Point', coordinates: [4.3517, 50.8503] },
  });

  try {
    const quoteAmount = 500;
    const discount = await calculateAutoDiscount(
      freshCustomer._id.toString(),
      testProfessionalId.toString(),
      testProjectId.toString(),
      quoteAmount,
      GOLD_CUSTOMER_TOTAL_SPENT
    );

    const expectedLoyalty = Math.min(
      roundToTwo((quoteAmount * goldTierDiscount) / 100),
      goldTierMaxCap ?? Infinity
    );

    assertClose(discount.loyaltyDiscount.amount, expectedLoyalty, `Fresh customer gets loyalty discount (€${expectedLoyalty})`);
    assertClose(discount.repeatBuyerDiscount.amount, 0, 'Fresh customer gets NO repeat discount');
    assert(discount.repeatBuyerDiscount.previousBookings === 0, 'Fresh customer has 0 completed bookings');
    assertClose(discount.finalAmount, quoteAmount - expectedLoyalty, `Discounted amount is €${quoteAmount - expectedLoyalty} (loyalty only)`);
  } finally {
    await User.findByIdAndDelete(freshCustomer._id);
  }
}

async function testBronzeTierNoDiscount() {
  console.log('\n═══ Test 8: Bronze tier gets no loyalty discount ═══');

  const bronzeCustomer = await User.create({
    name: 'Bronze Customer',
    email: `${TEST_EMAIL_PREFIX}-bronze@test.com`,
    phone: '+32400000004',
    password: 'TestPassword123!',
    role: 'customer',
    customerType: 'individual',
    loyaltyLevel: 'Bronze',
    totalSpent: BRONZE_CUSTOMER_TOTAL_SPENT,
    location: { type: 'Point', coordinates: [4.3517, 50.8503] },
  });

  try {
    const discount = await calculateAutoDiscount(
      bronzeCustomer._id.toString(),
      testProfessionalId.toString(),
      null, // no project = no repeat discount
      500,
      BRONZE_CUSTOMER_TOTAL_SPENT
    );

    assertClose(discount.loyaltyDiscount.amount, 0, 'Bronze gets 0% loyalty discount');
    assertClose(discount.repeatBuyerDiscount.amount, 0, 'No repeat discount without project');
    assertClose(discount.totalDiscount, 0, 'Total discount is €0');
    assertClose(discount.finalAmount, 500, 'Discounted amount equals original (€500)');
  } finally {
    await User.findByIdAndDelete(bronzeCustomer._id);
  }
}

async function testMinimumPaymentThreshold() {
  console.log('\n═══ Test 9: Minimum payment threshold (€0.50) ═══');

  // Create a scenario where discount would make amount < 0.50
  // A €1 quote with Gold (5%) + repeat (10%) = 15% = €0.15 discount → €0.85 (above threshold)
  // But let's test more aggressively by temporarily thinking about it:
  // For the minimum to kick in, we'd need a very small quote
  // €0.60 quote, Gold 5% = €0.03, repeat 10% = €0.06 → total discount €0.09 → €0.51 (still above)
  // €0.50 quote, 5% = 0.025 → 0.03, 10% = 0.05 → total 0.08 → 0.42 → clamped to 0.50

  const discount = await calculateAutoDiscount(
    testCustomerId.toString(),
    testProfessionalId.toString(),
    testProjectId.toString(),
    0.50,
    GOLD_CUSTOMER_TOTAL_SPENT
  );

  assert(discount.finalAmount >= 0.50, `Discounted amount is >= €0.50 (got €${discount.finalAmount})`);
}

async function testProjectWithDisabledRepeatDiscount() {
  console.log('\n═══ Test 10: Project with repeat discount disabled ═══');

  const noDiscountProject = await Project.create({
    professionalId: testProfessionalId,
    title: 'No Discount Project For Testing Purposes',
    category: 'plumber',
    service: 'plumber',
    description: 'Project without repeat buyer discount enabled',
    priceModel: 'fixed',
    distance: { address: 'Test Street 1, Brussels', maxKmRange: 50, useCompanyAddress: false, noBorders: false, location: { type: 'Point', coordinates: [4.3517, 50.8503] } },
    media: { images: ['https://placeholder.test/img.jpg'] },
    subprojects: [{
      name: 'Test Sub',
      description: 'Test subproject for testing',
      projectType: ['plumber'],
      professionalInputs: [],
      pricing: { type: 'fixed', amount: 500 },
      included: [],
      materialsIncluded: false,
      preparationDuration: { value: 1, unit: 'days' },
      executionDuration: { value: 2, unit: 'days' },
      warrantyPeriod: { value: 1, unit: 'years' },
    }],
    status: 'published',
    repeatBuyerDiscount: { enabled: false, percentage: 10, minPreviousBookings: 1 },
  });

  try {
    const quoteAmount = 500;
    const discount = await calculateAutoDiscount(
      testCustomerId.toString(),
      testProfessionalId.toString(),
      (noDiscountProject._id as any).toString(),
      quoteAmount,
      GOLD_CUSTOMER_TOTAL_SPENT
    );

    const expectedLoyalty = Math.min(
      roundToTwo((quoteAmount * goldTierDiscount) / 100),
      goldTierMaxCap ?? Infinity
    );

    assertClose(discount.loyaltyDiscount.amount, expectedLoyalty, `Still gets loyalty discount (€${expectedLoyalty})`);
    assertClose(discount.repeatBuyerDiscount.amount, 0, 'No repeat discount (disabled on project)');
    assertClose(discount.finalAmount, quoteAmount - expectedLoyalty, `Discounted amount €${quoteAmount - expectedLoyalty}`);
  } finally {
    await Project.findByIdAndDelete(noDiscountProject._id);
  }
}

async function testBookingModelStoresDiscount() {
  console.log('\n═══ Test 11: Booking model stores discount data ═══');

  const booking = await Booking.findById(testBookingId);
  assert(!!booking, 'Test booking exists');

  // Simulate storing discount in payment.discount (flat shape)
  const discount = await calculateAutoDiscount(
    testCustomerId.toString(),
    testProfessionalId.toString(),
    testProjectId.toString(),
    500,
    GOLD_CUSTOMER_TOTAL_SPENT
  );

  if (!booking!.payment) {
    booking!.payment = { amount: 500, currency: 'EUR' } as any;
  }
  (booking!.payment as any).discount = {
    loyaltyTier: discount.loyaltyDiscount.tier,
    loyaltyPercentage: discount.loyaltyDiscount.percentage,
    loyaltyAmount: discount.loyaltyDiscount.amount,
    repeatBuyerPercentage: discount.repeatBuyerDiscount.percentage,
    repeatBuyerAmount: discount.repeatBuyerDiscount.amount,
    totalDiscount: discount.totalDiscount,
    originalAmount: discount.originalAmount,
  };

  await booking!.save();

  // Re-fetch and verify
  const reloaded = await Booking.findById(testBookingId);
  const storedDiscount = (reloaded?.payment as any)?.discount;
  assert(!!storedDiscount, 'Discount stored on booking.payment');
  assertClose(storedDiscount.totalDiscount, discount.totalDiscount, `Stored totalDiscount is €${discount.totalDiscount}`);
  assert(storedDiscount.loyaltyTier === 'Gold', 'Stored loyalty tier name is Gold');
  assertClose(storedDiscount.loyaltyAmount, discount.loyaltyDiscount.amount, `Stored loyalty amount is €${discount.loyaltyDiscount.amount}`);
  assertClose(storedDiscount.repeatBuyerAmount, discount.repeatBuyerDiscount.amount, `Stored repeat amount is €${discount.repeatBuyerDiscount.amount}`);
}

async function testProjectModelStoresRepeatDiscount() {
  console.log('\n═══ Test 12: Project model stores repeat-buyer discount settings ═══');

  const project = await Project.findById(testProjectId);
  assert(!!project, 'Test project exists');
  assert(project!.repeatBuyerDiscount?.enabled === true, 'Repeat discount is enabled');
  assert(project!.repeatBuyerDiscount?.percentage === 10, 'Repeat discount percentage is 10%');
  assert(project!.repeatBuyerDiscount?.minPreviousBookings === 2, 'Min previous bookings is 2');
  assert(project!.repeatBuyerDiscount?.maxDiscountAmount === 50, 'Max discount cap is €50');
}

// Cache loyalty config for data-driven assertions
let goldTierDiscount = 0;
let goldTierMaxCap: number | undefined = undefined;

async function testLoyaltyConfigHasDiscountFields() {
  console.log('\n═══ Test 13: LoyaltyConfig has discount fields on all tiers ═══');

  const config = await LoyaltyConfig.getCurrentConfig();

  for (const tier of config.tiers) {
    assert(
      typeof tier.discountPercentage === 'number',
      `Tier ${tier.name} has discountPercentage (${tier.discountPercentage}%)`
    );
  }

  const bronze = config.tiers.find(t => t.name === 'Bronze');
  const gold = config.tiers.find(t => t.name === 'Gold');

  // Bronze should always be 0
  assertClose(bronze?.discountPercentage ?? -1, 0, 'Bronze discount is 0%');

  // Gold — read actual value, don't hardcode expected
  assert((gold?.discountPercentage ?? 0) > 0, `Gold discount is > 0% (actual: ${gold?.discountPercentage}%)`);

  // Cache for subsequent tests
  goldTierDiscount = gold?.discountPercentage ?? 0;
  goldTierMaxCap = gold?.maxDiscountAmount ?? undefined;
  console.log(`  📋 Gold tier from DB: ${goldTierDiscount}%, cap €${goldTierMaxCap ?? 'none'}`);
}

// ─── Runner ───────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║       Discount System Integration Tests         ║');
  console.log('╚══════════════════════════════════════════════════╝');

  await connectDB();

  try {
    // Pure math tests (no DB needed for these)
    await testPurePayoutCalculation();
    await testPurePayoutNoDiscount();
    await testPurePayoutOnlyLoyalty();
    await testPurePayoutOnlyRepeat();

    // DB integration tests
    await createTestFixtures();
    await testLoyaltyConfigHasDiscountFields();
    await testProjectModelStoresRepeatDiscount();
    await testDiscountBreakdownWithDB();
    await testDiscountCapHit();
    await testNoRepeatDiscountBelowMinBookings();
    await testBronzeTierNoDiscount();
    await testMinimumPaymentThreshold();
    await testProjectWithDisabledRepeatDiscount();
    await testBookingModelStoresDiscount();

  } finally {
    await cleanupTestFixtures();
    await mongoose.disconnect();
  }

  // Report
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => { console.log(`    ❌ ${f}`); });
  }
  console.log('══════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
