import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Real-Mongo coverage for the per-payment discount ledger: milestone
 * checkouts run through the real createPaymentIntent, the real webhook and
 * confirm handlers, and the real savings summary handler. Only Stripe and
 * notifications are stand-ins; no provider is called.
 */

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.hoisted(() => {
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_savings_ledger';
  process.env.STRIPE_PLATFORM_COMMISSION_PERCENT = '0';
});

const stripeMocks = vi.hoisted(() => ({
  intentCreate: vi.fn(),
  intentRetrieve: vi.fn(),
  intentCancel: vi.fn(),
  constructEvent: vi.fn(),
  milestoneDue: vi.fn(async () => ({ notified: true })),
}));

vi.mock('../../services/stripe', () => ({
  stripe: {
    paymentIntents: {
      create: stripeMocks.intentCreate,
      retrieve: stripeMocks.intentRetrieve,
      cancel: stripeMocks.intentCancel,
    },
    refunds: { create: vi.fn(), list: vi.fn(async () => ({ data: [] })), retrieve: vi.fn() },
    transfers: { create: vi.fn(), createReversal: vi.fn() },
    charges: { retrieve: vi.fn() },
    balanceTransactions: { retrieve: vi.fn() },
    webhooks: { constructEvent: stripeMocks.constructEvent },
  },
  STRIPE_CONFIG: {
    environment: 'test',
    defaultCurrency: 'EUR',
    supportedCurrencies: ['EUR', 'USD', 'GBP', 'CAD', 'AUD'],
    commissionPercent: 0,
    webhookSecret: 'whsec_test',
    frontendUrl: 'http://localhost:3000',
  },
}));

vi.mock('../../utils/notifications/milestonePaymentDue', () => ({ notifyMilestonePaymentDue: stripeMocks.milestoneDue }));

vi.mock('../../utils/notifications/bookingPaymentNotify', () => ({
  notifyBookingPaymentConfirmed: vi.fn(async () => undefined),
}));
vi.mock('../../utils/notifications/notify', () => ({
  notify: vi.fn(async () => ({})),
  notifyAsync: vi.fn(),
}));

import { notifyBookingPaymentConfirmed } from '../../utils/notifications/bookingPaymentNotify';
import Referral from '../../models/referral';
import ReferralConfig from '../../models/referralConfig';
import { withReferralDiscount, releaseReferralReservation } from '../../utils/referralDiscount';
import { releaseUnpaidReferral } from '../../utils/releaseUnpaidReferral';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import User from '../../models/user';
import DiscountCode from '../../models/discountCode';
import DiscountCodeUsage from '../../models/discountCodeUsage';
import PlatformSettings from '../../models/platformSettings';
import StripeEvent from '../../models/stripeEvent';
import { createPaymentIntent, confirmPayment } from '../../handlers/Stripe/payment';
import { handleWebhook, reconciliationItemEventId } from '../../handlers/Stripe/webhooks';
import { inspectStripeReconciliationItems } from '../../scripts/migrate/checkStripeReconciliationItems';
import { buildDetailsForBookingDocument } from '../../handlers/Booking/details';
import { getSavingsSummary } from '../../handlers/User/savingsSummary';
import { recordPaymentDiscountSnapshot } from '../../utils/paymentDiscountLedger';
import { bookingForRequest } from '../../utils/invoiceVisibility';

const DAY_MS = 24 * 60 * 60 * 1000;

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  res.send = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};

const location = {
  type: 'Point',
  coordinates: [4.35, 50.85],
  address: 'Main street 1',
  city: 'Brussels',
  country: 'BE',
  postalCode: '1000',
};

const createUser = async (overrides: Record<string, any>) => User.create({
  name: 'U',
  email: `u-${new Types.ObjectId()}@example.com`,
  phone: `+32${String(new Types.ObjectId()).slice(-9)}`,
  password: 'hashed-password',
  role: 'customer',
  accountStatus: 'active',
  location,
  ...overrides,
});

const createCode = (code: string, type: 'percentage' | 'fixed', value: number) => DiscountCode.create({
  code,
  type,
  value,
  isActive: true,
  perUserLimit: 1,
  validFrom: new Date(Date.now() - DAY_MS),
  validUntil: new Date(Date.now() + 30 * DAY_MS),
  createdBy: new Types.ObjectId(),
});

let customerId: Types.ObjectId;
let otherCustomerId: Types.ObjectId;
let professionalId: Types.ObjectId;
let intentCounter = 0;

const seedMilestoneBooking = async () => Booking.create({
  customer: customerId,
  professional: professionalId,
  bookingType: 'professional',
  status: 'quote_accepted',
  location,
  rfqData: { serviceType: 'Bathroom', description: 'Y', answers: [] },
  quote: { amount: 200, currency: 'EUR', description: 'Quote' },
  vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, answers: [] },
  milestonePayments: [
    { title: 'Deposit', amount: 100, dueCondition: 'on_start', order: 0 },
    { title: 'Final', amount: 100, dueCondition: 'on_start', order: 1 },
  ],
  statusHistory: [{ status: 'quote_accepted', timestamp: new Date(), updatedBy: customerId, note: 'seed' }],
});

const deliverEvent = async (event: { id: string; type: string; data: { object: any } }) => {
  stripeMocks.constructEvent.mockReturnValue({ created: Math.floor(Date.now() / 1000), ...event });
  const res = response();
  await handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res as any);
  return res;
};

const succeededEvent = (bookingId: string, intentId: string, eventId = `evt_${new Types.ObjectId()}`) => ({
  id: eventId,
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: intentId,
      object: 'payment_intent',
      amount: 10000,
      currency: 'eur',
      status: 'succeeded',
      latest_charge: `ch_${intentId}`,
      metadata: { bookingId },
    },
  },
});

const summaryFor = async (user: any) => {
  const res = response();
  await getSavingsSummary({ user } as any, res as any, vi.fn());
  return res;
};

const snapshotTotal = (discount: any) => Math.round((
  (discount?.loyaltyAmount || 0)
  + (discount?.repeatBuyerAmount || 0)
  + (discount?.pointsDiscountAmount || 0)
  + (discount?.codeDiscountAmount || 0)
  + (discount?.referralDiscountAmount || 0)
) * 100) / 100;

const readLedger = async (bookingId: any): Promise<any[]> => {
  const raw = await Booking.findById(bookingId).select('+paymentDiscountLedger').lean();
  return ((raw as any)?.paymentDiscountLedger || []) as any[];
};

describeDb('per-payment savings ledger (disposable Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft3_savings_${process.pid}_${Date.now().toString(36)}`, autoCreate: false, autoIndex: false });
    await mongoose.connection.dropDatabase();
    await PlatformSettings.deleteMany({});
    // Loyalty/points configs default-create themselves attributed to an admin.
    await createUser({ role: 'admin' });
    customerId = (await createUser({ role: 'customer' }))._id;
    otherCustomerId = (await createUser({ role: 'customer' }))._id;
    professionalId = (await createUser({
      role: 'professional',
      professionalStatus: 'approved',
      stripe: { accountId: 'acct_savings_ledger', chargesEnabled: true, payoutsEnabled: true },
      businessInfo: { country: 'BE' },
    }))._id;
    await Promise.all([Payment.syncIndexes(), DiscountCodeUsage.syncIndexes(), StripeEvent.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await User.updateOne({ _id: customerId }, { $unset: { manualCustomerLevelOverride: 1 } });
    await Promise.all([
      Booking.deleteMany({}),
      Referral.deleteMany({}),
      ReferralConfig.deleteMany({}),
      Payment.deleteMany({}),
      DiscountCode.deleteMany({}),
      DiscountCodeUsage.deleteMany({}),
      mongoose.connection.collection('stripeevents').deleteMany({}),
    ]);
    stripeMocks.intentCreate.mockImplementation(async () => {
      intentCounter += 1;
      const id = `pi_ledger_${intentCounter}`;
      return { id, client_secret: `${id}_secret`, status: 'requires_payment_method' };
    });
    stripeMocks.intentCancel.mockResolvedValue({});
    stripeMocks.intentRetrieve.mockImplementation(async (id: string) => ({
      id,
      status: 'succeeded',
      latest_charge: `ch_${id}`,
      currency: 'eur',
    }));
  });

  // FT3 #12: customers redeem wallet points at checkout. The discount is
  // fixed on the intent; the points leave the wallet once, on success.
  it('redeems customer points at checkout and deducts them once when the payment succeeds', async () => {
    await User.updateOne({ _id: customerId }, { $set: { points: 30, pointsExpiry: new Date(Date.now() + 90 * DAY_MS) } });
    try {
      const booking = await seedMilestoneBooking();
      const bookingId = String(booking._id);
      const intent = await createPaymentIntent(bookingId, String(customerId), 20);
      expect(intent.success).toBe(true);
      const stored = await Booking.findById(booking._id).lean();
      expect((stored as any).payment.discount.pointsRedeemed).toBe(20);
      expect((stored as any).payment.discount.pointsDiscountAmount).toBe(20);
      const charged = stripeMocks.intentCreate.mock.calls.at(-1)![0].amount;
      const withoutPoints = Math.round(((stored as any).payment.discount.originalAmount) * 121);
      expect(charged).toBeLessThan(withoutPoints);
      // Nothing leaves the wallet before the payment succeeds.
      expect((await User.findById(customerId).lean())?.points).toBe(30);
      const event = succeededEvent(bookingId, intent.paymentIntentId!);
      expect((await deliverEvent(event)).statusCode).toBe(200);
      expect((await User.findById(customerId).lean())?.points).toBe(10);
      // A replayed webhook does not deduct again.
      await deliverEvent(event);
      expect((await User.findById(customerId).lean())?.points).toBe(10);
    } finally {
      await User.updateOne({ _id: customerId }, { $set: { points: 0 } });
    }
  });

  it('never redeems more points than the customer holds', async () => {
    await User.updateOne({ _id: customerId }, { $set: { points: 5, pointsExpiry: new Date(Date.now() + 90 * DAY_MS) } });
    try {
      const booking = await seedMilestoneBooking();
      const intent = await createPaymentIntent(String(booking._id), String(customerId), 50);
      expect(intent.success).toBe(true);
      const stored = await Booking.findById(booking._id).lean();
      expect((stored as any).payment.discount.pointsRedeemed).toBe(5);
    } finally {
      await User.updateOne({ _id: customerId }, { $set: { points: 0 } });
    }
  });

  it('applies points to a milestone in full up to what it can absorb, charging only the points used', async () => {
    await User.updateOne({ _id: customerId }, { $set: { points: 150, pointsExpiry: new Date(Date.now() + 90 * DAY_MS) } });
    try {
      const booking = await seedMilestoneBooking();
      const intent = await createPaymentIntent(String(booking._id), String(customerId), 150);
      expect(intent.success).toBe(true);
      const discount = ((await Booking.findById(booking._id).lean()) as any).payment.discount;
      // Milestone 1 is EUR 100 net: at most EUR 99.50 of points (Stripe minimum stays payable).
      expect(discount.pointsRedeemed).toBe(99);
      expect(discount.pointsDiscountAmount).toBe(99);
      expect(discount.pointsDiscountAmount).toBe(discount.pointsRedeemed * 1);
    } finally {
      await User.updateOne({ _id: customerId }, { $set: { points: 0 } });
    }
  });

  it('loads the hidden customer ledger for details with a persisted Payment row', async () => {
    const booking = await seedMilestoneBooking();
    await Booking.updateOne({ _id: booking._id }, { $set: {
      payment: { status: 'completed', stripePaymentIntentId: 'pi_new_checkout', discount: { referralDiscountAmount: 99 } },
      paymentDiscountLedger: [{ paymentIntentId: 'pi_recorded_checkout', referralDiscountAmount: 12, loyaltyAmount: 5, totalDiscount: 17, originalAmount: 100, recordedAt: new Date() }],
    } });
    await Payment.collection.insertOne({
      booking: booking._id, customer: customerId, professional: professionalId,
      stripePaymentIntentId: 'pi_recorded_checkout', status: 'completed',
      amount: 83, netAmount: 83, currency: 'EUR', discount: null,
    });
    const loaded = await Booking.findById(booking._id);
    expect(loaded?.paymentDiscountLedger).toBeUndefined();
    const details = await buildDetailsForBookingDocument({ booking: loaded, viewerRole: 'customer', user: { _id: customerId } });
    const recorded = details.payments.records.find(row => row.amount === 83)!;
    expect(recorded.discount).toMatchObject({ referralDiscountAmount: 12, loyaltyAmount: 5, totalDiscount: 17, originalAmount: 100 });
    const professional = await buildDetailsForBookingDocument({ booking: loaded, viewerRole: 'professional', user: { _id: professionalId } });
    expect(professional.payments.records.find(row => row.amount === 83)?.discount).toBeNull();
  });

  const seedReferral = async () => {
    await ReferralConfig.create({
      isEnabled: true, referredCustomerDiscountType: 'fixed', referredCustomerDiscountValue: 20,
      referredCustomerDiscountMaxAmount: 20, minBookingAmountForTrigger: 1, lastModifiedBy: customerId,
    });
    return Referral.create({ referrer: otherCustomerId, referredUser: customerId, referralCode: 'REFTEST', expiresAt: new Date(Date.now() + DAY_MS) });
  };

  it('returns an unpaid cancelled booking benefit and permits only one concurrent new reservation', async () => {
    const referral = await seedReferral();
    const old = await seedMilestoneBooking();
    const fresh = await seedMilestoneBooking();
    const rival = await seedMilestoneBooking();
    expect((await createPaymentIntent(String(old._id), String(customerId), 0, 0)).success).toBe(true);
    const pending = await Booking.findById(old._id);
    pending!.status = 'cancelled';
    await pending!.save();
    stripeMocks.intentRetrieve.mockResolvedValue({ status: 'requires_payment_method' });
    stripeMocks.intentCancel.mockResolvedValue({ status: 'canceled' });
    await releaseUnpaidReferral(pending!);
    expect((await Referral.findById(referral._id))?.discountBooking).toBeUndefined();
    const discount = { originalAmount: 200, finalAmount: 200, totalDiscount: 0, loyaltyDiscount: { amount: 0, tier: 'Bronze', percentage: 0, capped: false }, repeatBuyerDiscount: { amount: 0, percentage: 0, previousBookings: 0, capped: false }, pointsDiscount: { discountAmount: 0, pointsUsed: 0, conversionRate: 1 } };
    const results = await Promise.allSettled([
      withReferralDiscount(discount, String(customerId), String(fresh._id), true),
      withReferralDiscount(discount, String(customerId), String(rival._id), true),
    ]);
    const discounted = results.filter(result => result.status === 'fulfilled' && result.value.referralDiscount);
    expect(discounted).toHaveLength(1);
    const winner = (await Referral.findById(referral._id))!.discountBooking;
    await releaseReferralReservation(String(old._id), pending!.payment!.discount!.referralReservationToken); // delayed old cleanup cannot clear the winner
    expect(String((await Referral.findById(referral._id))!.discountBooking)).toBe(String(winner));
  });

  it('releases a cancelled current intent but ignores a delayed superseded-intent cancellation', async () => {
    const referral = await seedReferral();
    const booking = await seedMilestoneBooking();
    const checkout = await createPaymentIntent(String(booking._id), String(customerId), 0, 0);
    expect(checkout.success).toBe(true);
    await deliverEvent({ id: `evt_cancel_old_${new Types.ObjectId()}`, type: 'payment_intent.canceled', data: { object: {
      id: 'pi_superseded', metadata: { bookingId: String(booking._id) }, status: 'canceled',
    } } });
    expect(String((await Referral.findById(referral._id))!.discountBooking)).toBe(String(booking._id));
    await deliverEvent({ id: `evt_cancel_current_${new Types.ObjectId()}`, type: 'payment_intent.canceled', data: { object: {
      id: checkout.paymentIntentId, metadata: { bookingId: String(booking._id) }, status: 'canceled',
    } } });
    expect((await Referral.findById(referral._id))!.discountBooking).toBeUndefined();
    expect((await Booking.findById(booking._id))!.payment!.status).toBe('failed');
  });

  it('keeps retry B reserved when the old A webhook releases after B re-reserves the SAME booking', async () => {
    const referral = await seedReferral();
    const booking = await seedMilestoneBooking();
    const rival = await seedMilestoneBooking();
    const first = await createPaymentIntent(String(booking._id), String(customerId), 0, 0);
    const oldPayment = (await Booking.findById(booking._id))!.payment!;
    expect(oldPayment.discount!.referralReservationToken).toBe(first.paymentIntentId);
    const update = Booking.updateOne.bind(Booking);
    let retry: Awaited<ReturnType<typeof createPaymentIntent>> | undefined;
    const spy = vi.spyOn(Booking, 'updateOne').mockImplementationOnce((async (...args: any[]) => {
      const result = await (update as any)(...args);
      // A has become failed, but its handler has not released its token yet.
      retry = await createPaymentIntent(String(booking._id), String(customerId), 0, 0);
      return result;
    }) as any);
    try {
      await deliverEvent({ id: `evt_race_${new Types.ObjectId()}`, type: 'payment_intent.canceled', data: { object: {
        id: first.paymentIntentId, metadata: { bookingId: String(booking._id) }, status: 'canceled',
      } } });
    } finally { spy.mockRestore(); }
    expect(retry?.success).toBe(true);
    expect(retry?.paymentIntentId).not.toBe(first.paymentIntentId);
    const current = (await Booking.findById(booking._id))!.payment!;
    expect(current.discount!.referralReservationToken).toBe(retry!.paymentIntentId);
    expect((await Referral.findById(referral._id))!.discountReservationToken).toBe(retry!.paymentIntentId);
    expect(current.discount!.referralDiscountAmount).toBeGreaterThan(0);
    expect(stripeMocks.intentCreate.mock.calls[0][1].idempotencyKey).not.toBe(stripeMocks.intentCreate.mock.calls[1][1].idempotencyKey);
    expect((await createPaymentIntent(String(rival._id), String(customerId), 0, 0)).success).toBe(true);
    expect((await Booking.findById(rival._id))!.payment!.discount!.referralDiscountAmount).toBe(0);
    // A terminal path holding A's snapshot is fenced by the same token.
    stripeMocks.intentRetrieve.mockResolvedValue({ status: 'canceled' });
    await releaseUnpaidReferral({ _id: booking._id, payment: oldPayment });
    expect((await Referral.findById(referral._id))!.discountReservationToken).toBe(retry!.paymentIntentId);
  });

  it('never releases a consumed referral even if a caller holds a stale unpaid booking', async () => {
    const referral = await seedReferral();
    const booking = await seedMilestoneBooking();
    await Referral.updateOne({ _id: referral._id }, { $set: { discountBooking: booking._id, discountReservationToken: 'pi_settled', referredUserDiscountApplied: true } });
    await releaseReferralReservation(String(booking._id), 'pi_settled');
    expect(String((await Referral.findById(referral._id))!.discountBooking)).toBe(String(booking._id));
  });

  it('prorates referral with loyalty and code across real milestone checkouts and retains it on same-booking retries', async () => {
    await seedReferral();
    await createCode('REFERRALCOMBO', 'fixed', 10);
    await User.updateOne({ _id: customerId }, { $set: { manualCustomerLevelOverride: 'Silver' } });
    const booking = await seedMilestoneBooking();
    expect((await createPaymentIntent(String(booking._id), String(customerId), 0, 0, 'REFERRALCOMBO')).success).toBe(true);
    const first = (await Booking.findById(booking._id))!;
    expect(first.payment!.discount!.referralDiscountAmount).toBe(10);
    expect((await createPaymentIntent(String(booking._id), String(customerId), 0, 0, 'REFERRALCOMBO')).success).toBe(true);
    expect(stripeMocks.intentCreate).toHaveBeenCalledOnce();
    await recordPaymentDiscountSnapshot(String(booking._id), first.payment!, first.payment!.stripePaymentIntentId);
    first.milestonePayments![0].status = 'paid';
    first.payment!.status = 'completed';
    await first.save();
    expect((await createPaymentIntent(String(booking._id), String(customerId), 0, 1, 'REFERRALCOMBO')).success).toBe(true);
    const second = (await Booking.findById(booking._id))!;
    expect(second.payment!.discount!.referralDiscountAmount).toBe(10);
    expect(first.payment!.discount!.loyaltyAmount).toBeGreaterThan(0);
    expect(first.payment!.discount!.codeDiscountAmount).toBe(5);
    expect(second.payment!.discount!.codeDiscountAmount).toBe(5);
    const { buildUblInvoiceXml } = await import('../../services/invoiceArtifacts');
    // The full quotation invoice requires both settled checkouts and their
    // durable snapshots, rather than extrapolating either installment.
    second.payment!.status = 'completed';
    second.milestonePayments![1].status = 'paid';
    await second.save();
    await recordPaymentDiscountSnapshot(String(booking._id), second.payment!, second.payment!.stripePaymentIntentId);
    const settledPayments = [first.payment!, second.payment!].map(payment => ({
      ...(payment as any).toObject?.() || payment, status: 'completed',
    }));
    const ledger = (await Booking.findById(booking._id).select('+paymentDiscountLedger'))!.paymentDiscountLedger;
    const fullBookingTotal = (first.payment!.totalWithVat! + second.payment!.totalWithVat!).toFixed(2);
    for (const installment of [first, second]) {
      await installment.populate('customer professional');
      const xml = buildUblInvoiceXml({ ...installment.toObject(), __settledPayments: settledPayments, paymentDiscountLedger: ledger }, 'FIX-MILESTONE', new Date(), { selfBilling: false, platform: { country: 'BE' } });
      expect(xml).toContain('Referral discount');
      expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="EUR">${fullBookingTotal}</cbc:TaxInclusiveAmount>`);
    }
  });

  it.each([true, false])('a losing checkout save preserves a shared active intent: %s', async (sameIntent) => {
    const referral = await seedReferral();
    stripeMocks.intentCancel.mockResolvedValue({ status: 'canceled' });
    const booking = await seedMilestoneBooking();
    const save = vi.spyOn(Booking.prototype, 'save').mockImplementationOnce(async function (this: any) {
      await Booking.collection.updateOne({ _id: this._id }, { $set: {
        payment: { stripePaymentIntentId: sameIntent ? this.payment.stripePaymentIntentId : 'pi_winner' },
      } });
      throw new mongoose.Error.DocumentNotFoundError({ _id: this._id });
    });
    try {
      const result = await createPaymentIntent(String(booking._id), String(customerId), 0, 0);
      expect(result).toMatchObject({ success: false, error: { code: 'BOOKING_CHANGED' } });
      if (sameIntent) expect(stripeMocks.intentCancel).not.toHaveBeenCalled();
      else expect(stripeMocks.intentCancel).toHaveBeenCalledOnce();
      const winner = (await Booking.findById(booking._id))!.payment!.stripePaymentIntentId;
      expect((await Referral.findById(referral._id))!.discountReservationToken).toBe(winner);
    } finally {
      save.mockRestore();
    }
  });

  it('keeps milestone 1 savings through the milestone 2 checkout and adds milestone 2 exactly once', async () => {
    await createCode('FIRST10', 'percentage', 10);
    await createCode('SECOND6', 'fixed', 6);
    const booking = await seedMilestoneBooking();
    const bookingId = String(booking._id);
    const customer = { _id: customerId, role: 'customer' };

    // Milestone 1 checkout with a discount code.
    const first = await createPaymentIntent(bookingId, String(customerId), 0, 0, 'FIRST10');
    expect(first.success).toBe(true);
    const afterFirstCheckout: any = await Booking.findById(bookingId).lean();
    const firstDiscount = afterFirstCheckout.payment.discount;
    const firstTotal = snapshotTotal(firstDiscount);
    expect(firstDiscount.codeDiscountAmount).toBeGreaterThan(0);
    expect(await readLedger(bookingId)).toHaveLength(0);

    // Pending milestone 1: nothing settled yet.
    let summary = (await summaryFor(customer)).body.data;
    expect(summary.settledPaymentCount).toBe(0);
    expect(summary.groups).toEqual([]);

    // Milestone 1 succeeds; duplicate deliveries, a Stripe retry under a new
    // event id and the confirm endpoint all leave one entry.
    const firstEvent = succeededEvent(bookingId, first.paymentIntentId!);
    expect((await deliverEvent(firstEvent)).statusCode).toBe(200);
    await deliverEvent(firstEvent);
    await deliverEvent(succeededEvent(bookingId, first.paymentIntentId!));
    const confirmRes = response();
    await confirmPayment({
      user: customer,
      body: { bookingId, paymentIntentId: first.paymentIntentId },
    } as any, confirmRes as any);
    expect(confirmRes.statusCode).toBe(200);

    let ledger = await readLedger(bookingId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      paymentIntentId: first.paymentIntentId,
      milestoneIndex: 0,
      currency: 'EUR',
      codeDiscountAmount: firstDiscount.codeDiscountAmount,
      originalAmount: firstDiscount.originalAmount,
    });
    // The code usage is recorded once (existing behaviour kept).
    expect(await DiscountCodeUsage.countDocuments({ booking: booking._id })).toBe(1);

    summary = (await summaryFor(customer)).body.data;
    expect(summary.complete).toBe(true);
    expect(summary.settledPaymentCount).toBe(1);
    expect(summary.groups[0].totalRecorded).toBe(firstTotal);

    // Milestone 2 checkout replaces booking.payment with a pending payment.
    const second = await createPaymentIntent(bookingId, String(customerId), 0, 1, 'SECOND6');
    expect(second.success).toBe(true);
    expect(second.paymentIntentId).not.toBe(first.paymentIntentId);
    const afterSecondCheckout: any = await Booking.findById(bookingId).lean();
    expect(afterSecondCheckout.payment.stripePaymentIntentId).toBe(second.paymentIntentId);
    expect(afterSecondCheckout.payment.status).toBe('pending');
    const secondDiscount = afterSecondCheckout.payment.discount;
    const secondTotal = snapshotTotal(secondDiscount);
    expect(secondTotal).toBeGreaterThan(0);
    // booking.payment replacement did not drop the earlier ledger entry.
    expect(await readLedger(bookingId)).toHaveLength(1);

    summary = (await summaryFor(customer)).body.data;
    expect(summary.complete).toBe(true);
    expect(summary.settledPaymentCount).toBe(1);
    expect(summary.groups[0].totalRecorded).toBe(firstTotal);

    // A late milestone 1 event after the replacement neither marks milestone
    // 2 paid nor attributes milestone 2's pending snapshot to milestone 1.
    await deliverEvent(succeededEvent(bookingId, first.paymentIntentId!));
    expect(await readLedger(bookingId)).toHaveLength(1);
    const afterStale: any = await Booking.findById(bookingId).lean();
    expect(afterStale.payment.status).toBe('pending');
    expect(afterStale.payment.stripeChargeId).toBeUndefined();
    expect(afterStale.milestonePayments.map((milestone: any) => milestone.status)).toEqual(['paid', 'pending']);
    // Milestone 1 was already settled (its ledger entry exists), so the late
    // redelivery is not a new charge and raises no reconciliation item.
    expect(await StripeEvent.countDocuments({ 'reconciliation.required': true })).toBe(0);

    // Milestone 2 settles: added once, across duplicates and confirm.
    const secondEvent = succeededEvent(bookingId, second.paymentIntentId!);
    await deliverEvent(secondEvent);
    await deliverEvent(secondEvent);
    await deliverEvent(succeededEvent(bookingId, second.paymentIntentId!));
    await confirmPayment({
      user: customer,
      body: { bookingId, paymentIntentId: second.paymentIntentId },
    } as any, response() as any);

    ledger = await readLedger(bookingId);
    expect(ledger.map((entry) => [entry.paymentIntentId, entry.milestoneIndex])).toEqual([
      [first.paymentIntentId, 0],
      [second.paymentIntentId, 1],
    ]);
    const paid: any = await Booking.findById(bookingId).lean();
    expect(paid.payment.stripeChargeId).toBe(`ch_${second.paymentIntentId}`);
    expect(paid.milestonePayments.map((milestone: any) => milestone.status)).toEqual(['paid', 'paid']);

    summary = (await summaryFor(customer)).body.data;
    expect(summary.complete).toBe(true);
    expect(summary.settledPaymentCount).toBe(2);
    expect(summary.unrecordedPaymentCount).toBe(0);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].bookingCount).toBe(1);
    expect(summary.groups[0].totalRecorded).toBe(Math.round((firstTotal + secondTotal) * 100) / 100);
    expect(summary.groups[0].byType.discountCode).toBe(
      Math.round((firstDiscount.codeDiscountAmount + secondDiscount.codeDiscountAmount) * 100) / 100,
    );

    // The ledger is never part of booking payloads, even for the customer.
    const plain: any = await Booking.findById(bookingId).lean();
    expect(plain.paymentDiscountLedger).toBeUndefined();
    const doc = await Booking.findById(bookingId);
    expect((bookingForRequest(doc, { _id: professionalId, role: 'professional' }) as any).paymentDiscountLedger).toBeUndefined();

    // Saving a document loaded without the ledger keeps the ledger intact.
    doc!.notes = 'touched';
    await doc!.save();
    expect(await readLedger(bookingId)).toHaveLength(2);

    // Dispute on the current charge: the booking becomes uncertain and is not
    // summed. Winning the dispute restores the recorded total.
    await deliverEvent({
      id: `evt_${new Types.ObjectId()}`,
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', charge: `ch_${second.paymentIntentId}`, amount: 5000, currency: 'eur', reason: 'fraudulent', status: 'needs_response' } },
    });
    summary = (await summaryFor(customer)).body.data;
    expect(summary.excludedUncertainCount).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.groups[0].totalRecorded).toBe(0);
    expect(await readLedger(bookingId)).toHaveLength(2);

    await deliverEvent({
      id: `evt_${new Types.ObjectId()}`,
      type: 'charge.dispute.closed',
      data: { object: { id: 'dp_1', charge: `ch_${second.paymentIntentId}`, amount: 5000, currency: 'eur', reason: 'fraudulent', status: 'won' } },
    });
    summary = (await summaryFor(customer)).body.data;
    expect(summary.complete).toBe(true);
    expect(summary.groups[0].totalRecorded).toBe(Math.round((firstTotal + secondTotal) * 100) / 100);

    // Access scope: customer-only, own bookings only.
    expect((await summaryFor({ _id: professionalId, role: 'professional' })).statusCode).toBe(403);
    expect((await summaryFor(undefined)).statusCode).toBe(401);
    const other = (await summaryFor({ _id: otherCustomerId, role: 'customer' })).body.data;
    expect(other.groups).toEqual([]);
    expect(other.settledPaymentCount).toBe(0);
  });

  it('records a durable reconciliation item when a superseded, never-applied intent succeeds', async () => {
    await createCode('FIRST10', 'percentage', 10);
    const booking = await seedMilestoneBooking();
    const bookingId = String(booking._id);

    // Milestone 1 checkout, then a changed checkout for the same milestone.
    // The old intent is already processing, so its cancel fails with
    // payment_intent_unexpected_state (swallowed by createPaymentIntent).
    const oldIntent = await createPaymentIntent(bookingId, String(customerId), 0, 0, 'FIRST10');
    stripeMocks.intentCancel.mockRejectedValueOnce(Object.assign(new Error('processing'), { code: 'payment_intent_unexpected_state' }));
    const newIntent = await createPaymentIntent(bookingId, String(customerId), 0, 0);
    expect(stripeMocks.intentCancel).toHaveBeenCalledWith(oldIntent.paymentIntentId);
    expect(newIntent.paymentIntentId).not.toBe(oldIntent.paymentIntentId);

    // The old intent then succeeds: Stripe charged the customer.
    const staleEvent = succeededEvent(bookingId, oldIntent.paymentIntentId!);
    const before = Date.now();
    expect((await deliverEvent(staleEvent)).statusCode).toBe(200);

    // The current pending payment is untouched; nothing is applied.
    const after: any = await Booking.findById(bookingId).lean();
    expect(after.payment.stripePaymentIntentId).toBe(newIntent.paymentIntentId);
    expect(after.payment.status).toBe('pending');
    expect(after.payment.stripeChargeId).toBeUndefined();
    expect(after.status).toBe('payment_pending');
    expect(after.milestonePayments.map((milestone: any) => milestone.status)).toEqual(['pending', 'pending']);
    expect(await readLedger(bookingId)).toHaveLength(0);
    expect(await DiscountCodeUsage.countDocuments({ booking: booking._id })).toBe(0);

    // The delivered event keeps its ordinary dedup record (processed, TTL).
    const delivered: any = await StripeEvent.findOne({ eventId: staleEvent.id }).lean();
    expect(delivered.status).toBe('processed');
    expect(delivered.expiresAt).toBeInstanceOf(Date);
    expect(delivered.reconciliation).toBeUndefined();
    // The item is its own durable (no TTL) record, queryable, and identifies the money.
    const itemEventId = reconciliationItemEventId(oldIntent.paymentIntentId!);
    const record: any = await StripeEvent.findOne({ eventId: itemEventId }).lean();
    expect(record.status).toBe('processed');
    expect(record.expiresAt).toBeUndefined();
    expect(record.reconciliation).toMatchObject({
      sourceEventId: staleEvent.id,
      required: true,
      reason: 'superseded_payment_intent_succeeded',
      paymentIntentId: oldIntent.paymentIntentId,
      currentPaymentIntentId: newIntent.paymentIntentId,
      chargeId: `ch_${oldIntent.paymentIntentId}`,
      amount: 100,
      currency: 'EUR',
      resolvedAt: null,
    });
    expect(String(record.reconciliation.bookingId)).toBe(bookingId);
    expect(new Date(record.reconciliation.detectedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const openQueue = await StripeEvent.find({ 'reconciliation.required': true, 'reconciliation.resolvedAt': null }).lean();
    expect(openQueue.map((item: any) => item.eventId)).toEqual([itemEventId]);

    // The operator queue query is served by the partial index.
    const plan: any = await StripeEvent.find({ 'reconciliation.required': true, 'reconciliation.resolvedAt': null })
      .explain('queryPlanner');
    expect(JSON.stringify(plan)).toContain('reconciliation.required_1_reconciliation.resolvedAt_1_reconciliation.detectedAt_1');

    // Redelivery of the same event and a second event for the same intent
    // keep exactly one item, with its first detection time.
    await deliverEvent(staleEvent);
    await deliverEvent(succeededEvent(bookingId, oldIntent.paymentIntentId!));
    const items: any[] = await StripeEvent.find({ 'reconciliation.paymentIntentId': oldIntent.paymentIntentId }).lean();
    expect(items).toHaveLength(1);
    expect(new Date(items[0].reconciliation.detectedAt).getTime()).toBe(new Date(record.reconciliation.detectedAt).getTime());
    expect(stripeMocks.intentCreate).toHaveBeenCalledTimes(2);

    // Resolving the item takes it out of the open queue.
    await StripeEvent.updateOne({ eventId: itemEventId }, { $set: { 'reconciliation.resolvedAt': new Date(), 'reconciliation.note': 'refunded in dashboard' } });
    expect(await StripeEvent.countDocuments({ 'reconciliation.required': true, 'reconciliation.resolvedAt': null })).toBe(0);
    // A later delivery for the resolved intent neither reopens nor duplicates it.
    await deliverEvent(succeededEvent(bookingId, oldIntent.paymentIntentId!));
    expect(await StripeEvent.countDocuments({ 'reconciliation.paymentIntentId': oldIntent.paymentIntentId })).toBe(1);
    expect(await StripeEvent.countDocuments({ 'reconciliation.required': true, 'reconciliation.resolvedAt': null })).toBe(0);

    // The current intent still settles normally afterwards.
    await deliverEvent(succeededEvent(bookingId, newIntent.paymentIntentId!));
    const paid: any = await Booking.findById(bookingId).lean();
    expect(paid.payment.status).toBe('authorized');
    expect(paid.milestonePayments[0].status).toBe('paid');
    expect((await readLedger(bookingId)).map((entry) => entry.paymentIntentId)).toEqual([newIntent.paymentIntentId]);
  });

  it('records one item when different events for one superseded intent are delivered concurrently', async () => {
    await createCode('REPLACEMENT5', 'fixed', 5);
    const booking = await seedMilestoneBooking();
    const bookingId = String(booking._id);
    const oldIntent = await createPaymentIntent(bookingId, String(customerId), 0, 0);
    stripeMocks.intentCancel.mockRejectedValueOnce(Object.assign(new Error('processing'), { code: 'payment_intent_unexpected_state' }));
    // An identical retry correctly reuses its intent. Change the checkout
    // discount to create the superseded-intent scenario under test.
    const newIntent = await createPaymentIntent(bookingId, String(customerId), 0, 0, 'REPLACEMENT5');
    expect(newIntent.success).toBe(true);
    expect(newIntent.paymentIntentId).not.toBe(oldIntent.paymentIntentId);

    // Stripe can deliver the same success under distinct event ids at once.
    const events = Array.from({ length: 4 }, () => succeededEvent(bookingId, oldIntent.paymentIntentId!));
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
    const responses = await Promise.all(events.map((event) => deliverEvent(event)));
    expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200, 200]);

    const items: any[] = await StripeEvent.find({ 'reconciliation.required': true }).lean();
    expect(items).toHaveLength(1);
    expect(items[0].eventId).toBe(reconciliationItemEventId(oldIntent.paymentIntentId!));
    expect(items[0].reconciliation.currentPaymentIntentId).toBe(newIntent.paymentIntentId);
    expect(events.map((event) => event.id)).toContain(items[0].reconciliation.sourceEventId);
    // Every delivered event keeps normal dedup: processed, not failed, own TTL.
    const delivered: any[] = await StripeEvent.find({ eventId: { $in: events.map((event) => event.id) } }).lean();
    expect(delivered).toHaveLength(4);
    expect(delivered.every((record) => record.status === 'processed' && record.expiresAt instanceof Date)).toBe(true);
    expect(delivered.every((record) => record.reconciliation === undefined)).toBe(true);

    // Redelivering all of them again (also concurrently) changes nothing.
    await Promise.all(events.map((event) => deliverEvent(event)));
    expect(await StripeEvent.countDocuments({ 'reconciliation.required': true })).toBe(1);
    const current: any = await Booking.findById(bookingId).lean();
    expect(current.payment.stripePaymentIntentId).toBe(newIntent.paymentIntentId);
    expect(current.payment.status).toBe('pending');
  });

  it('persists the settling intent on the paid milestone in the confirm and webhook paths', async () => {
    const booking = await seedMilestoneBooking();
    const bookingId = String(booking._id);
    const customer = { _id: customerId, role: 'customer' };
    // Confirm endpoint settles milestone 1 first.
    const first = await createPaymentIntent(bookingId, String(customerId), 0, 0);
    const confirmRes = response();
    await confirmPayment({ user: customer, body: { bookingId, paymentIntentId: first.paymentIntentId } } as any, confirmRes as any);
    expect(confirmRes.statusCode).toBe(200);
    let stored: any = await Booking.findById(bookingId).lean();
    expect(stored.milestonePayments[0]).toMatchObject({ status: 'paid', paidStripePaymentIntentId: first.paymentIntentId });
    // Webhook settles milestone 2.
    const second = await createPaymentIntent(bookingId, String(customerId), 0, 1);
    await deliverEvent(succeededEvent(bookingId, second.paymentIntentId!));
    stored = await Booking.findById(bookingId).lean();
    expect(stored.milestonePayments[1]).toMatchObject({ status: 'paid', paidStripePaymentIntentId: second.paymentIntentId });
    // The settlement field is never part of a participant payload.
    const doc = await Booking.findById(bookingId);
    const visible: any = bookingForRequest(doc, customer as any);
    expect(visible.milestonePayments.every((milestone: any) => milestone.paidStripePaymentIntentId === undefined)).toBe(true);
  });

  it('treats a paid milestone as applied only from its recorded settling intent, never from a checkout id', async () => {
    const seedPaidLegacy = async (milestone: Record<string, any>) => Booking.create({
      customer: customerId,
      professional: professionalId,
      bookingType: 'professional',
      status: 'in_progress',
      location,
      rfqData: { serviceType: 'Bathroom', description: 'Y', answers: [] },
      quote: { amount: 200, currency: 'EUR', description: 'Quote' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, answers: [] },
      milestonePayments: [
        { title: 'Deposit', amount: 100, dueCondition: 'on_start', order: 0, status: 'paid', ...milestone },
        { title: 'Final', amount: 100, dueCondition: 'on_start', order: 1 },
      ],
      // Pre-ledger booking: no paymentDiscountLedger entry for milestone 1.
      payment: { status: 'pending', currency: 'EUR', amount: 100, stripePaymentIntentId: 'pi_current_m2', milestoneIndex: 1 },
    });

    // Recorded settlement fact: a late redelivery is not a new charge.
    const settled = await seedPaidLegacy({ stripePaymentIntentId: 'pi_m1_paid', paidStripePaymentIntentId: 'pi_m1_paid' });
    expect((await deliverEvent(succeededEvent(String(settled._id), 'pi_m1_paid'))).statusCode).toBe(200);
    expect(await StripeEvent.countDocuments({ 'reconciliation.required': true })).toBe(0);

    // Only the checkout id is known (it is written before payment), so the
    // charge is not assumed applied: the operator gets an item.
    const unknown = await seedPaidLegacy({ stripePaymentIntentId: 'pi_m1_checkout' });
    expect((await deliverEvent(succeededEvent(String(unknown._id), 'pi_m1_checkout'))).statusCode).toBe(200);
    const items: any[] = await StripeEvent.find({ 'reconciliation.required': true }).lean();
    expect(items.map((item) => item.reconciliation.paymentIntentId)).toEqual(['pi_m1_checkout']);
    // Neither booking was changed by the stale successes.
    for (const id of [settled._id, unknown._id]) {
      const stored: any = await Booking.findById(id).lean();
      expect(stored.payment.status).toBe('pending');
      expect(stored.milestonePayments.map((milestone: any) => milestone.status)).toEqual(['paid', 'pending']);
    }
  });

  it('keeps legacy per-event items authoritative and reports them in the read-only preflight', async () => {
    const booking = await seedMilestoneBooking();
    const bookingId = String(booking._id);
    await createPaymentIntent(bookingId, String(customerId), 0, 0);
    const oldIntentId = 'pi_legacy_marked';
    // Two open items for one intent from the earlier per-event version.
    const legacyItem = (eventId: string) => ({
      eventId,
      eventType: 'payment_intent.succeeded',
      status: 'processed',
      attempts: 1,
      firstSeenAt: new Date(),
      lastAttemptAt: new Date(),
      reconciliation: {
        required: true,
        reason: 'superseded_payment_intent_succeeded',
        bookingId: booking._id,
        paymentIntentId: oldIntentId,
        detectedAt: new Date('2026-11-01T00:00:00.000Z'),
        resolvedAt: null,
      },
    });
    await mongoose.connection.collection('stripeevents').insertMany([legacyItem('evt_legacy_a'), legacyItem('evt_legacy_b')]);
    const before = await inspectStripeReconciliationItems(mongoose.connection.db!);
    expect(before).toMatchObject({ eventIdIndexUnique: true, openItems: 2, openLegacyItems: 2, safe: true });
    expect(before.duplicateOpenIntents).toEqual([{ paymentIntentId: oldIntentId, eventIds: ['evt_legacy_a', 'evt_legacy_b'] }]);

    // A new delivery for that intent counts as already marked: no third item,
    // and the legacy records are not rewritten or deleted.
    await deliverEvent(succeededEvent(bookingId, oldIntentId));
    const items: any[] = await StripeEvent.find({ 'reconciliation.paymentIntentId': oldIntentId }).sort({ eventId: 1 }).lean();
    expect(items.map((item) => item.eventId)).toEqual(['evt_legacy_a', 'evt_legacy_b']);
    expect(items.every((item) => item.reconciliation.sourceEventId === undefined)).toBe(true);
    const after = await inspectStripeReconciliationItems(mongoose.connection.db!);
    expect(after).toEqual(before);
  });

  it('classifies a refunded milestone booking as uncertain and keeps legacy milestones unrecorded', async () => {
    const legacy = await Booking.create({
      customer: customerId,
      professional: professionalId,
      bookingType: 'professional',
      status: 'in_progress',
      location,
      rfqData: { serviceType: 'Bathroom', description: 'Y', answers: [] },
      quote: { amount: 200, currency: 'EUR', description: 'Quote' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, answers: [] },
      milestonePayments: [
        { title: 'Deposit', amount: 100, dueCondition: 'on_start', order: 0, status: 'paid' },
        { title: 'Final', amount: 100, dueCondition: 'on_start', order: 1, status: 'paid' },
      ],
      // Pre-ledger data: milestone 1's snapshot was replaced by milestone 2's.
      payment: {
        status: 'authorized',
        currency: 'EUR',
        amount: 95,
        stripePaymentIntentId: 'pi_legacy_2',
        milestoneIndex: 1,
        discount: { loyaltyAmount: 5, totalDiscount: 5, originalAmount: 100 },
      },
    });
    const customer = { _id: customerId, role: 'customer' };

    let summary = (await summaryFor(customer)).body.data;
    expect(summary.settledPaymentCount).toBe(2);
    expect(summary.unrecordedPaymentCount).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.groups[0].coverage).toBe('partial');
    expect(summary.groups[0].totalRecorded).toBe(5);

    // A late ledger write for the current payment replaces the legacy source,
    // never adds to it; the earlier milestone stays unknown.
    expect(await recordPaymentDiscountSnapshot(legacy._id, legacy.payment, 'pi_legacy_2')).toBe(true);
    summary = (await summaryFor(customer)).body.data;
    expect(summary.groups[0].totalRecorded).toBe(5);
    expect(summary.unrecordedPaymentCount).toBe(1);

    // Concurrent writers for the same intent add one entry.
    const results = await Promise.all([
      recordPaymentDiscountSnapshot(legacy._id, legacy.payment, 'pi_legacy_2'),
      recordPaymentDiscountSnapshot(legacy._id, legacy.payment, 'pi_legacy_2'),
    ]);
    expect(results).toEqual([false, false]);
    expect(await readLedger(legacy._id)).toHaveLength(1);
    // A different intent cannot claim an already-recorded milestone.
    expect(await recordPaymentDiscountSnapshot(
      legacy._id,
      { ...legacy.toObject().payment, stripePaymentIntentId: 'pi_other' },
      'pi_other',
    )).toBe(false);

    await Booking.updateOne({ _id: legacy._id }, { $set: { 'payment.status': 'refunded', status: 'refunded' } });
    summary = (await summaryFor(customer)).body.data;
    expect(summary.excludedUncertainCount).toBe(1);
    expect(summary.groups[0].totalRecorded).toBe(0);
    expect(summary.complete).toBe(false);
  });

  it('records concurrent first writes for a fresh intent exactly once', async () => {
    const booking = await seedMilestoneBooking();
    await Booking.updateOne({ _id: booking._id }, {
      $set: {
        payment: {
          status: 'authorized',
          currency: 'EUR',
          amount: 90,
          stripePaymentIntentId: 'pi_race',
          milestoneIndex: 0,
          discount: { loyaltyAmount: 10, totalDiscount: 10, originalAmount: 100 },
        },
        'milestonePayments.0.status': 'paid',
      },
    });
    const fresh: any = await Booking.findById(booking._id).lean();
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      recordPaymentDiscountSnapshot(booking._id, fresh.payment, 'pi_race')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readLedger(booking._id)).toHaveLength(1);
  });

  for (const path of ['updated', 'lost-update', 'already-settled']) {
    it.each([false, true])(`retries milestone-due from ${path} independently of confirmation failure %s`, async fail => {
      const booking = await seedMilestoneBooking();
      const intentId = 'pi_retry_due';
      const paid = path === 'already-settled';
      await Booking.updateOne({ _id: booking._id }, { $set: { status: 'booked', payment: {
        status: paid ? 'authorized' : 'pending', stripePaymentIntentId: intentId,
        milestoneIndex: 0, amount: 100, totalWithVat: 121, currency: 'EUR',
      }, 'milestonePayments.0.status': paid ? 'paid' : 'pending',
        ...(paid ? { 'milestonePayments.0.paidStripePaymentIntentId': intentId } : {}),
      } });
      let race: ReturnType<typeof vi.spyOn> | undefined;
      if (path === 'lost-update') {
        const original = Booking.findOneAndUpdate.bind(Booking);
        race = vi.spyOn(Booking, 'findOneAndUpdate').mockImplementationOnce((async (...args: any[]) => {
          await (original as any)(...args);
          return null;
        }) as any);
      }
      if (fail) vi.mocked(notifyBookingPaymentConfirmed).mockRejectedValueOnce(new Error('confirmation delivery failed'));
      stripeMocks.milestoneDue.mockClear();
      try {
        const res = await deliverEvent(succeededEvent(String(booking._id), intentId));
        expect(res.statusCode).toBe(fail ? 500 : 200);
        expect(stripeMocks.milestoneDue).toHaveBeenCalledWith(String(booking._id));
      } finally { race?.mockRestore(); }
    });
  }

});
