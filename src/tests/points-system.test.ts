/**
 * Points & Professional Level System Integration Test
 *
 * Tests:
 * 1. addPoints — atomic credit with audit trail
 * 2. deductPoints — atomic debit with insufficient-balance guard
 * 3. previewPointsRedemption — caps, minimums, conversion
 * 4. expirePoints — batch expiry
 * 5. getPointsBalance / getPointHistory — read helpers
 * 6. Professional level calculation
 * 7. Points boost toward professional level
 * 8. Employee guard rails
 *
 * Run: npx tsx src/tests/points-system.test.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import connectDB from '../config/db';
import User from '../models/user';
import Booking from '../models/booking';
import Project from '../models/project';
import PointTransaction from '../models/pointTransaction';
import PointsConfig from '../models/pointsConfig';
import ProfessionalLevelConfig from '../models/professionalLevelConfig';
import {
  addPoints,
  deductPoints,
  previewPointsRedemption,
  expirePoints,
  getPointsBalance,
  getPointHistory,
} from '../utils/pointsSystem';
import {
  getProfessionalMetrics,
  calculateProfessionalLevel,
  updateProfessionalLevel,
} from '../utils/professionalLevelSystem';

// ─── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  \u2705 ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  \u274C ${message}`);
  }
}

function assertClose(actual: number, expected: number, message: string, tolerance = 0.01) {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (expected ${expected}, got ${actual})`);
}

// ─── Test fixtures ────────────────────────────────────────────────

const TEST_PREFIX = `pts-test-${Date.now()}`;

let customerId: any;
let professionalId: any;
let employeeId: any;
let projectId: any;

async function createTestFixtures() {
  console.log('\n\uD83D\uDCE6 Creating test fixtures...');

  const customer = await User.create({
    name: 'Test Customer Points',
    email: `${TEST_PREFIX}-cust@test.com`,
    phone: '+32400100001',
    password: 'TestPassword123!',
    role: 'customer',
    customerType: 'individual',
    points: 0,
    location: {
      type: 'Point',
      coordinates: [4.3517, 50.8503],
      address: 'Test Addr',
      city: 'Brussels',
      country: 'BE',
    },
  });
  customerId = customer._id;
  console.log(`  Created customer: ${customer.email}`);

  const professional = await User.create({
    name: 'Test Pro Points',
    email: `${TEST_PREFIX}-pro@test.com`,
    phone: '+32400100002',
    password: 'TestPassword123!',
    role: 'professional',
    professionalStatus: 'approved',
    points: 0,
    businessInfo: {
      companyName: 'Pro Points Co',
      address: 'Pro Street 1',
      city: 'Brussels',
      country: 'BE',
    },
    stripe: {
      accountId: `acct_pts_test_${Date.now()}`,
      chargesEnabled: true,
      payoutsEnabled: true,
    },
  });
  professionalId = professional._id;
  console.log(`  Created professional: ${professional.email}`);

  const employee = await User.create({
    name: 'Test Employee Points',
    email: `${TEST_PREFIX}-emp@test.com`,
    phone: '+32400100003',
    password: 'TestPassword123!',
    role: 'employee',
    location: {
      type: 'Point',
      coordinates: [4.3517, 50.8503],
      address: 'Test Addr',
      city: 'Brussels',
      country: 'BE',
    },
  });
  employeeId = employee._id;
  console.log(`  Created employee: ${employee.email}`);

  const project = await Project.create({
    professionalId: professionalId,
    title: 'Test Project For Points System Testing',
    category: 'plumber',
    service: 'plumber',
    description: 'This is a test project for points system testing purposes',
    priceModel: 'fixed',
    distance: {
      address: 'Test Street, Brussels',
      maxKmRange: 50,
      useCompanyAddress: false,
      noBorders: false,
      location: { type: 'Point', coordinates: [4.3517, 50.8503] },
    },
    media: { images: ['https://placeholder.test/img.jpg'] },
    subprojects: [{
      name: 'Test Sub',
      description: 'Test subproject for points testing purposes',
      projectType: ['plumber'],
      professionalInputs: [],
      pricing: { type: 'fixed', amount: 200 },
      included: [],
      materialsIncluded: false,
      preparationDuration: { value: 1, unit: 'days' },
      executionDuration: { value: 1, unit: 'days' },
      warrantyPeriod: { value: 1, unit: 'years' },
    }],
    status: 'published',
  });
  projectId = project._id;
  console.log(`  Created project: ${project.title}`);

  console.log('  Done.');
}

async function cleanupTestFixtures() {
  console.log('\n\uD83E\uDDF9 Cleaning up test fixtures...');
  await PointTransaction.deleteMany({ userId: { $in: [customerId, professionalId, employeeId] } });
  await Booking.deleteMany({ customer: customerId });
  await Project.findByIdAndDelete(projectId);
  await User.deleteMany({ email: { $regex: `^${TEST_PREFIX}` } });
  console.log('  Done.');
}

// ─── Tests ────────────────────────────────────────────────────────

async function testAddPoints() {
  console.log('\n\u2550\u2550\u2550 Test 1: addPoints basics \u2550\u2550\u2550');

  // Reset balance
  await User.findByIdAndUpdate(customerId, { $set: { points: 0, pointsExpiry: null } });

  const result1 = await addPoints(customerId, 50, 'referral', 'Test referral reward');
  assertClose(result1.newBalance, 50, 'Balance after first add');
  assert(result1.transaction != null, 'Transaction record created');

  const result2 = await addPoints(customerId, 30, 'admin-adjustment', 'Admin bonus');
  assertClose(result2.newBalance, 80, 'Balance after second add');

  // Verify audit trail
  const tx = await PointTransaction.findById(result2.transaction._id);
  assertClose(tx!.balanceBefore, 50, 'balanceBefore in transaction');
  assertClose(tx!.balanceAfter, 80, 'balanceAfter in transaction');
  assert(tx!.source === 'admin-adjustment', 'Source recorded correctly');

  // Verify user balance in DB
  const user = await User.findById(customerId).select('points pointsExpiry');
  assertClose(user!.points!, 80, 'User.points in DB');
  assert(user!.pointsExpiry != null, 'pointsExpiry set');
}

async function testAddPointsValidation() {
  console.log('\n\u2550\u2550\u2550 Test 2: addPoints validation \u2550\u2550\u2550');

  let threw = false;
  try {
    await addPoints(customerId, 0, 'referral', 'Zero amount');
  } catch (e: any) {
    threw = true;
    assert(e.message.includes('positive'), `Zero amount throws: ${e.message}`);
  }
  assert(threw, 'Zero amount throws');

  threw = false;
  try {
    await addPoints(customerId, -10, 'referral', 'Negative amount');
  } catch (e: any) {
    threw = true;
  }
  assert(threw, 'Negative amount throws');

  threw = false;
  try {
    await addPoints(new mongoose.Types.ObjectId(), 10, 'referral', 'Non-existent user');
  } catch (e: any) {
    threw = true;
    assert(e.message.includes('not found'), `Non-existent user throws: ${e.message}`);
  }
  assert(threw, 'Non-existent user throws');
}

async function testDeductPoints() {
  console.log('\n\u2550\u2550\u2550 Test 3: deductPoints basics \u2550\u2550\u2550');

  // Set known balance
  await User.findByIdAndUpdate(customerId, { $set: { points: 100 } });
  await PointTransaction.deleteMany({ userId: customerId });

  const result = await deductPoints(customerId, 40, 'redemption', 'Test redemption');
  assertClose(result.newBalance, 60, 'Balance after deduction');
  assertClose(result.transaction.balanceBefore, 100, 'balanceBefore in deduction tx');
  assertClose(result.transaction.balanceAfter, 60, 'balanceAfter in deduction tx');

  // Verify DB
  const user = await User.findById(customerId).select('points');
  assertClose(user!.points!, 60, 'User.points after deduction');
}

async function testDeductInsufficientBalance() {
  console.log('\n\u2550\u2550\u2550 Test 4: deductPoints insufficient balance \u2550\u2550\u2550');

  await User.findByIdAndUpdate(customerId, { $set: { points: 10 } });

  let threw = false;
  try {
    await deductPoints(customerId, 50, 'redemption', 'Over-spend');
  } catch (e: any) {
    threw = true;
    assert(e.message.includes('Insufficient'), `Throws insufficient: ${e.message}`);
  }
  assert(threw, 'Insufficient balance throws');

  // Balance unchanged
  const user = await User.findById(customerId).select('points');
  assertClose(user!.points!, 10, 'Balance unchanged after failed deduction');
}

async function testEmployeeGuard() {
  console.log('\n\u2550\u2550\u2550 Test 5: Employee cannot earn or spend points \u2550\u2550\u2550');

  // Ensure employee has 0 points
  await User.findByIdAndUpdate(employeeId, { $set: { points: 0 } });

  let threw = false;
  try {
    await addPoints(employeeId, 50, 'referral', 'Employee referral');
  } catch (e: any) {
    threw = true;
    assert(e.message.includes('Employees'), `addPoints employee throws: ${e.message}`);
  }
  assert(threw, 'addPoints rejects employee');

  // Balance should still be 0 (rolled back)
  const user = await User.findById(employeeId).select('points');
  assertClose(user!.points!, 0, 'Employee points unchanged after rejected add');

  // Give employee some points directly to test deduct guard
  await User.findByIdAndUpdate(employeeId, { $set: { points: 100 } });
  threw = false;
  try {
    await deductPoints(employeeId, 10, 'redemption', 'Employee spend');
  } catch (e: any) {
    threw = true;
    assert(e.message.includes('Employees'), `deductPoints employee throws: ${e.message}`);
  }
  assert(threw, 'deductPoints rejects employee');

  // Reset
  await User.findByIdAndUpdate(employeeId, { $set: { points: 0 } });
}

async function testPreviewRedemption() {
  console.log('\n\u2550\u2550\u2550 Test 6: previewPointsRedemption \u2550\u2550\u2550');

  await User.findByIdAndUpdate(customerId, { $set: { points: 200, pointsExpiry: new Date(Date.now() + 86400000 * 30) } });

  // Normal preview
  const preview = await previewPointsRedemption(customerId, 50, 300);
  assertClose(preview.pointsToRedeem, 50, 'Redeem 50 points');
  assertClose(preview.discountAmount, 50, 'Discount = 50 EUR (rate 1:1)');
  assertClose(preview.newBalance, 150, 'Remaining balance');

  // Cap to available
  const preview2 = await previewPointsRedemption(customerId, 500, 300);
  assertClose(preview2.pointsToRedeem, 200, 'Capped to available points');

  // Cap to booking amount minus 0.50
  const preview3 = await previewPointsRedemption(customerId, 200, 10);
  assertClose(preview3.discountAmount, 9.50, 'Discount capped to booking - 0.50');
}

async function testExpiredPointsPreview() {
  console.log('\n\u2550\u2550\u2550 Test 7: Expired points return zero \u2550\u2550\u2550');

  await User.findByIdAndUpdate(customerId, { $set: { points: 100, pointsExpiry: new Date(Date.now() - 86400000) } });

  const preview = await previewPointsRedemption(customerId, 50, 300);
  assertClose(preview.pointsToRedeem, 0, 'Expired points: 0 redeemable');
  assertClose(preview.discountAmount, 0, 'Expired points: 0 discount');
}

async function testExpirePointsBatch() {
  console.log('\n\u2550\u2550\u2550 Test 8: expirePoints batch \u2550\u2550\u2550');

  // Set customer with expired points
  await User.findByIdAndUpdate(customerId, { $set: { points: 75, pointsExpiry: new Date(Date.now() - 1000) } });

  const count = await expirePoints();
  assert(count >= 1, `Expired at least 1 user (got ${count})`);

  const user = await User.findById(customerId).select('points');
  assertClose(user!.points!, 0, 'Points zeroed after expiry');

  // Check expiry transaction was logged
  const tx = await PointTransaction.findOne({ userId: customerId, source: 'expiry' });
  assert(tx != null, 'Expiry transaction logged');
  assertClose(tx!.amount, 75, 'Expiry amount matches');
}

async function testGetPointsBalance() {
  console.log('\n\u2550\u2550\u2550 Test 9: getPointsBalance \u2550\u2550\u2550');

  const futureExpiry = new Date(Date.now() + 86400000 * 60);
  await User.findByIdAndUpdate(customerId, { $set: { points: 120, pointsExpiry: futureExpiry } });

  const balance = await getPointsBalance(customerId);
  assertClose(balance.points, 120, 'Balance points');
  assert(balance.isExpired === false, 'Not expired');
  assertClose(balance.euroValue, 120, 'Euro value at 1:1 rate');
  assert(balance.conversionRate > 0, 'Conversion rate present');
}

async function testGetPointHistory() {
  console.log('\n\u2550\u2550\u2550 Test 10: getPointHistory \u2550\u2550\u2550');

  // Clean and add some transactions
  await PointTransaction.deleteMany({ userId: customerId });
  await User.findByIdAndUpdate(customerId, { $set: { points: 0 } });

  await addPoints(customerId, 10, 'referral', 'Hist 1');
  await addPoints(customerId, 20, 'referral', 'Hist 2');
  await addPoints(customerId, 30, 'admin-adjustment', 'Hist 3');

  const history = await getPointHistory(customerId, 10, 0);
  assert(history.total === 3, `3 transactions (got ${history.total})`);
  assert(history.transactions.length === 3, '3 returned');
  // Most recent first
  assert(history.transactions[0].description === 'Hist 3', 'Sorted newest first');
}

async function testProfessionalMetrics() {
  console.log('\n\u2550\u2550\u2550 Test 11: getProfessionalMetrics \u2550\u2550\u2550');

  // Create some completed bookings for the professional
  for (let i = 0; i < 3; i++) {
    await Booking.create({
      customer: customerId,
      professional: professionalId,
      project: projectId,
      bookingType: 'project',
      status: 'completed',
      rfqData: { serviceType: 'plumber', description: `Points test booking ${i}` },
      location: { type: 'Point', coordinates: [4.3517, 50.8503] },
      quote: { amount: 200, currency: 'EUR', submittedAt: new Date(), submittedBy: professionalId },
      payment: { amount: 200, currency: 'EUR', status: 'completed' },
      customerReview: i < 2 ? {
        rating: true,
        communicationLevel: 4.5,
        valueOfDelivery: 4.0,
        qualityOfService: 4.5,
        comment: 'Great work',
        createdAt: new Date(),
      } : undefined,
    });
  }

  const metrics = await getProfessionalMetrics(professionalId);
  assert(metrics.completedBookings >= 3, `Completed bookings >= 3 (got ${metrics.completedBookings})`);
  assert(metrics.daysActive >= 0, `Days active >= 0 (got ${metrics.daysActive})`);
  assert(metrics.avgRating >= 0, `Avg rating >= 0 (got ${metrics.avgRating})`);
  assert(metrics.onTimePercentage >= 0 && metrics.onTimePercentage <= 100, `On-time % in range (got ${metrics.onTimePercentage})`);
  assert(metrics.responseRate >= 0 && metrics.responseRate <= 100, `Response rate in range (got ${metrics.responseRate})`);
  assert(metrics.boostedBookings >= 0, `Boosted bookings >= 0 (got ${metrics.boostedBookings})`);
}

async function testCalculateProfessionalLevel() {
  console.log('\n\u2550\u2550\u2550 Test 12: calculateProfessionalLevel \u2550\u2550\u2550');

  const levelInfo = await calculateProfessionalLevel(professionalId);
  assert(typeof levelInfo.currentLevel === 'string', `Level name: ${levelInfo.currentLevel}`);
  assert(levelInfo.metrics != null, 'Metrics included');
  assert(levelInfo.effectiveBookings >= 0, `Effective bookings: ${levelInfo.effectiveBookings}`);
  assert(levelInfo.perks != null, 'Perks included');
  assert(typeof levelInfo.perks.badge === 'string', 'Badge is string');
  assert(typeof levelInfo.perks.commissionReduction === 'number', 'Commission reduction is number');
  assert(typeof levelInfo.color === 'string', 'Color present');

  // With few bookings, should be New or Rising at most
  assert(['New', 'Rising'].includes(levelInfo.currentLevel), `Low-activity pro is New/Rising (got ${levelInfo.currentLevel})`);

  // Next level info
  if (levelInfo.nextLevel) {
    assert(typeof levelInfo.nextLevel.name === 'string', `Next level name: ${levelInfo.nextLevel.name}`);
    assert(Array.isArray(levelInfo.nextLevel.missingCriteria), 'Missing criteria is array');
    assert(typeof levelInfo.nextLevel.progress === 'number', `Progress: ${levelInfo.nextLevel.progress}%`);
  }
}

async function testUpdateProfessionalLevel() {
  console.log('\n\u2550\u2550\u2550 Test 13: updateProfessionalLevel \u2550\u2550\u2550');

  const result = await updateProfessionalLevel(professionalId);
  assert(typeof result.oldLevel === 'string', `Old level: ${result.oldLevel}`);
  assert(typeof result.newLevel === 'string', `New level: ${result.newLevel}`);
  assert(typeof result.levelChanged === 'boolean', `Level changed: ${result.levelChanged}`);

  // Verify persisted
  const user = await User.findById(professionalId).select('professionalLevel');
  assert(user!.professionalLevel === result.newLevel, `Persisted level matches: ${user!.professionalLevel}`);
}

async function testNonProfessionalLevel() {
  console.log('\n\u2550\u2550\u2550 Test 14: updateProfessionalLevel for non-professional \u2550\u2550\u2550');

  const result = await updateProfessionalLevel(customerId);
  assert(result.levelChanged === false, 'Customer level not changed');
  assert(result.newLevel === 'New', `Returns New for non-pro (got ${result.newLevel})`);
}

async function testDiscountEngineWithPoints() {
  console.log('\n\u2550\u2550\u2550 Test 15: Discount engine with points redemption \u2550\u2550\u2550');

  // Give customer points and set Gold tier
  await User.findByIdAndUpdate(customerId, {
    $set: {
      points: 100,
      pointsExpiry: new Date(Date.now() + 86400000 * 30),
      loyaltyLevel: 'Gold',
      totalSpent: 6000,
    }
  });

  const { calculateAutoDiscount } = await import('../utils/discountEngine');

  const discount = await calculateAutoDiscount(
    customerId.toString(),
    professionalId.toString(),
    projectId.toString(),
    500,  // quoteAmount
    6000, // customerTotalSpent (Gold tier)
    50,   // pointsToRedeem
  );

  assert(discount != null, 'Discount calculated');
  assert(discount.originalAmount === 500, `Original amount: ${discount.originalAmount}`);
  assert(discount.finalAmount < 500, `Final amount < 500 (got ${discount.finalAmount})`);

  // Points discount should be present
  assertClose(discount.pointsDiscount.pointsUsed, 50, 'Points used');
  assert(discount.pointsDiscount.discountAmount > 0, `Points discount > 0 (got ${discount.pointsDiscount.discountAmount})`);
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Points & Professional Level System Integration Tests');
  console.log('='.repeat(60));

  await connectDB();

  try {
    await createTestFixtures();

    await testAddPoints();
    await testAddPointsValidation();
    await testDeductPoints();
    await testDeductInsufficientBalance();
    await testEmployeeGuard();
    await testPreviewRedemption();
    await testExpiredPointsPreview();
    await testExpirePointsBatch();
    await testGetPointsBalance();
    await testGetPointHistory();
    await testProfessionalMetrics();
    await testCalculateProfessionalLevel();
    await testUpdateProfessionalLevel();
    await testNonProfessionalLevel();
    await testDiscountEngineWithPoints();
  } catch (err) {
    console.error('\n\uD83D\uDCA5 FATAL ERROR:', err);
    failed++;
    failures.push(`Fatal: ${err}`);
  } finally {
    await cleanupTestFixtures();
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log('='.repeat(60));

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main();
