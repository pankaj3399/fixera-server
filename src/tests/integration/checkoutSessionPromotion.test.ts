import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FT2-4B: a wizard checkout creates no booking and blocks no calendar until
 * its payment is confirmed. Real Mongo, real createBooking, createPaymentIntent,
 * confirm and webhook handlers; only Stripe and notifications are stand-ins.
 */

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri && /test/i.test(testUri) ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_checkout_session';
  process.env.STRIPE_PLATFORM_COMMISSION_PERCENT = '0';
});

const mocks = vi.hoisted(() => ({
  intentCreate: vi.fn(),
  intentRetrieve: vi.fn(),
  intentCancel: vi.fn(),
  intentUpdate: vi.fn(async () => ({})),
  refundCreate: vi.fn(async () => ({ id: 're_conflict', status: 'succeeded' })),
  constructEvent: vi.fn(),
  notify: vi.fn(async () => ({})),
  paidNotify: vi.fn(async () => undefined),
}));

vi.mock('../../services/stripe', () => ({
  stripe: {
    paymentIntents: {
      create: mocks.intentCreate,
      retrieve: mocks.intentRetrieve,
      cancel: mocks.intentCancel,
      update: mocks.intentUpdate,
    },
    refunds: { create: mocks.refundCreate, list: vi.fn(async () => ({ data: [] })), retrieve: vi.fn() },
    transfers: { create: vi.fn(), createReversal: vi.fn() },
    charges: { retrieve: vi.fn() },
    balanceTransactions: { retrieve: vi.fn() },
    webhooks: { constructEvent: mocks.constructEvent },
  },
  STRIPE_CONFIG: {
    environment: 'test',
    defaultCurrency: 'EUR',
    supportedCurrencies: ['EUR', 'USD', 'GBP'],
    commissionPercent: 0,
    webhookSecret: 'whsec_test',
    frontendUrl: 'http://localhost:3000',
  },
}));
vi.mock('../../utils/notifications/notify', () => ({ notify: mocks.notify, notifyAsync: vi.fn() }));
vi.mock('../../utils/notifications/bookingPaymentNotify', () => ({ notifyBookingPaymentConfirmed: mocks.paidNotify }));
vi.mock('../../utils/notifications/milestonePaymentDue', () => ({ notifyMilestonePaymentDue: vi.fn(async () => ({})) }));

import Booking from '../../models/booking';
import Payment from '../../models/payment';
import CalendarReservation from '../../models/calendarReservation';
import CheckoutSession from '../../models/checkoutSession';
import DiscountCode from '../../models/discountCode';
import DiscountCodeUsage from '../../models/discountCodeUsage';
import PointTransaction from '../../models/pointTransaction';
import StripeEvent from '../../models/stripeEvent';
import User from '../../models/user';
import { abandonCheckout, createBooking, getBookingById } from '../../handlers/Booking';
import { ensurePaymentIntent } from '../../handlers/Booking/payment-integration';
import { confirmPayment, createPaymentIntent } from '../../handlers/Stripe/payment';
import { handleWebhook } from '../../handlers/Stripe/webhooks';
import { expireStaleCheckoutSessions } from '../../utils/checkoutSession';
import { promoteCheckoutSession } from '../../handlers/Stripe/checkoutPromotion';
import { reserveBookingCalendar } from '../../utils/support/bookingCalendar';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: any) => { res.body = body; return res; });
  res.send = vi.fn((body: any) => { res.body = body; return res; });
  return res;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const professional = new Types.ObjectId();
const customer = new Types.ObjectId();
const otherCustomer = new Types.ObjectId();
const project = new Types.ObjectId();
let intentCounter = 0;

const startCheckout = async (startDate = '2027-01-11', who = customer) => {
  const res = response();
  await createBooking({
    user: { _id: String(who) },
    body: {
      bookingType: 'project',
      projectId: String(project),
      selectedSubprojectIndex: 0,
      preferredStartDate: startDate,
      paymentAtCheckout: true,
      rfqData: { serviceType: 'Painting', description: 'Paint the hall' },
    },
  } as any, res as any, vi.fn());
  return res;
};

const deliver = async (event: any) => {
  mocks.constructEvent.mockReturnValue({ created: Math.floor(Date.now() / 1000), ...event });
  const res = response();
  await handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as any, res as any);
  return res;
};

const succeeded = (bookingId: string, intentId: string) => ({
  id: `evt_${new Types.ObjectId()}`,
  type: 'payment_intent.succeeded',
  data: { object: { id: intentId, object: 'payment_intent', amount: 12100, currency: 'eur', status: 'succeeded', latest_charge: `ch_${intentId}`, metadata: { bookingId, type: 'booking_payment' } } },
});

describeDb('FT2-4B wizard checkout sessions (disposable Mongo)', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T09:00:00Z'));
    await mongoose.connect(testUri!, { dbName: `ft2_checkout_${process.pid}_${Date.now().toString(36)}`, autoCreate: false, autoIndex: false });
    const availability = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(key => [key, { available: true, startTime: '09:00', endTime: '17:00' }]));
    const location = { type: 'Point', coordinates: [4.35, 50.85], address: 'Main street 1', city: 'Brussels', country: 'BE', postalCode: '1000' };
    await mongoose.connection.collection('users').insertMany([
      { _id: new Types.ObjectId(), name: 'Admin', email: 'checkout-admin@test.example', role: 'admin' },
      { _id: professional, name: 'Checkout Pro', email: 'checkout-pro@test.example', role: 'professional', professionalStatus: 'approved', businessInfo: { timezone: 'UTC', country: 'BE' }, companyAvailability: availability, stripe: { accountId: 'acct_checkout', chargesEnabled: true, payoutsEnabled: true } },
      { _id: customer, name: 'Checkout Customer', email: 'checkout-customer@test.example', role: 'customer', location, points: 0 },
      { _id: otherCustomer, name: 'Other Customer', email: 'checkout-other@test.example', role: 'customer', location },
    ]);
    await mongoose.connection.collection('projects').insertOne({
      _id: project, professionalId: professional, title: 'Hall painting', status: 'published',
      resources: [String(professional)], minResources: 1, minOverlapPercentage: 100,
      executionDuration: { value: 1, unit: 'days' }, timeMode: 'days', distance: { countryCode: 'BE' },
      subprojects: [{ name: 'Package', pricing: { type: 'fixed', amount: 100 }, executionDuration: { value: 1, unit: 'days' } }],
    });
    await CalendarReservation.createCollection();
    await CalendarReservation.createIndexes();
    await mongoose.connection.createCollection('counters');
    await Promise.all([Payment.syncIndexes(), StripeEvent.syncIndexes(), CheckoutSession.syncIndexes(), PointTransaction.syncIndexes(), DiscountCode.syncIndexes(), DiscountCodeUsage.syncIndexes()]);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await Promise.all([
      Booking.deleteMany({}),
      Payment.deleteMany({}),
      CheckoutSession.deleteMany({}),
      CalendarReservation.deleteMany({}),
      PointTransaction.deleteMany({}),
      StripeEvent.deleteMany({}),
      DiscountCode.deleteMany({}),
      DiscountCodeUsage.deleteMany({}),
    ]);
    mocks.refundCreate.mockImplementation(async () => ({ id: 're_conflict', status: 'succeeded' }));
    mocks.intentCreate.mockImplementation(async (params: any) => {
      intentCounter += 1;
      const id = `pi_checkout_${intentCounter}`;
      return { id, client_secret: `${id}_secret`, status: 'requires_payment_method', amount: params.amount, metadata: params.metadata };
    });
    mocks.intentCancel.mockImplementation(async (id: string) => ({ id, status: 'canceled' }));
    mocks.intentRetrieve.mockImplementation(async (id: string) => ({ id, status: 'succeeded', latest_charge: `ch_${id}`, currency: 'eur', amount: 12100, metadata: {} }));
  });

  it('reaching the payment step creates no booking, no calendar block and no notification', async () => {
    const res = await startCheckout();
    expect(res.statusCode).toBe(201);
    const checkoutId = res.body.checkout.id;
    expect(String(res.body.booking._id)).toBe(checkoutId);
    expect(await Booking.countDocuments({})).toBe(0);
    expect(await CalendarReservation.countDocuments({})).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    const session = await CheckoutSession.findById(checkoutId).lean();
    expect(session?.status).toBe('open');
    expect(session?.bookingData.scheduledStartDate).toBeTruthy();

    // The payment page reads it as the customer's own (virtual) booking.
    const own = response();
    await getBookingById({ user: { _id: customer, role: 'customer' }, params: { bookingId: checkoutId } } as any, own as any, vi.fn());
    expect(own.statusCode).toBe(200);
    expect(own.body.checkout.id).toBe(checkoutId);
    expect(own.body.booking.status).toBe('quote_accepted');
    // It is nobody else's booking.
    const pro = response();
    await getBookingById({ user: { _id: professional, role: 'professional' }, params: { bookingId: checkoutId } } as any, pro as any, vi.fn());
    expect(pro.statusCode).toBe(404);
  });

  it('promotes once on the confirmed payment and runs each paid-booking effect once', async () => {
    await User.updateOne({ _id: customer }, { $set: { points: 30, pointsExpiry: new Date(Date.now() + 90 * DAY_MS) } });
    const checkoutId = (await startCheckout()).body.checkout.id;
    const intentRes = response();
    await ensurePaymentIntent({ params: { bookingId: checkoutId }, body: { pointsToRedeem: 10 }, user: { _id: customer } } as any, intentRes as any);
    expect(intentRes.body.success).toBe(true);
    const intent = await createPaymentIntent(checkoutId, String(customer), 10);
    expect(intent.success).toBe(true);
    expect(await Booking.countDocuments({})).toBe(0);
    expect(await Payment.countDocuments({})).toBe(0);
    const intentId = intent.paymentIntentId!;
    expect((await CheckoutSession.findById(checkoutId).lean())?.payment?.stripePaymentIntentId).toBe(intentId);

    const confirm = response();
    await confirmPayment({ body: { bookingId: checkoutId, paymentIntentId: intentId }, user: { _id: customer } } as any, confirm as any);
    expect(confirm.body.success).toBe(true);
    await deliver(succeeded(checkoutId, intentId));
    await deliver(succeeded(checkoutId, intentId));
    const again = response();
    await confirmPayment({ body: { bookingId: checkoutId, paymentIntentId: intentId }, user: { _id: customer } } as any, again as any);
    expect(again.body.data.alreadyProcessed).toBe(true);

    const bookings = await Booking.find({}).lean();
    expect(bookings).toHaveLength(1);
    const booking: any = bookings[0];
    expect(String(booking._id)).toBe(checkoutId);
    expect(booking.status).toBe('booked');
    expect(booking.payment.status).toBe('authorized');
    expect(booking.bookingNumber).toMatch(/^BK-/);
    expect(booking.statusHistory.filter((entry: any) => entry.status === 'booked')).toHaveLength(1);
    expect(await CalendarReservation.countDocuments({ sourceId: booking._id })).toBeGreaterThan(0);
    const payment = await Payment.findOne({ booking: booking._id }).lean();
    expect(payment?.status).toBe('authorized');
    expect(payment?.stripePaymentIntentId).toBe(intentId);
    // Points leave the wallet once (webhook), whatever the delivery order.
    expect(await PointTransaction.countDocuments({ relatedBooking: booking._id, source: 'redemption' })).toBe(1);
    expect((await User.findById(customer).lean())?.points).toBe(20);
    expect((await CheckoutSession.findById(checkoutId).lean())?.status).toBe('promoted');
    expect(mocks.refundCreate).not.toHaveBeenCalled();
    await User.updateOne({ _id: customer }, { $set: { points: 0 } });
  });

  it('refunds and creates nothing when the slot was taken while the customer paid', async () => {
    const checkoutId = (await startCheckout()).body.checkout.id;
    const intent = await createPaymentIntent(checkoutId, String(customer));
    expect(intent.success).toBe(true);
    // Another booking takes the professional's day before the payment lands.
    const session = await CheckoutSession.findById(checkoutId).lean();
    const blocker = await Booking.create({
      customer: otherCustomer, professional, project, bookingType: 'project', status: 'booked',
      location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
      rfqData: { serviceType: 'Painting', description: 'Blocker' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, answers: [] },
      quote: { amount: 100, currency: 'EUR', description: 'Blocker' },
      assignedTeamMembers: [professional],
      scheduledStartDate: session!.bookingData.scheduledStartDate,
      scheduledExecutionEndDate: session!.bookingData.scheduledExecutionEndDate,
    });
    await reserveBookingCalendar(blocker as any);

    const confirm = response();
    await confirmPayment({ body: { bookingId: checkoutId, paymentIntentId: intent.paymentIntentId }, user: { _id: customer } } as any, confirm as any);
    expect(confirm.statusCode).toBe(409);
    expect(confirm.body.error.code).toBe('SLOT_UNAVAILABLE');
    expect(mocks.refundCreate).toHaveBeenCalledTimes(1);
    expect(mocks.refundCreate.mock.calls[0][0]).toMatchObject({ payment_intent: intent.paymentIntentId });
    expect(await Booking.exists({ _id: checkoutId })).toBeNull();
    expect(await CalendarReservation.countDocuments({ sourceId: new Types.ObjectId(checkoutId) })).toBe(0);
    expect((await CheckoutSession.findById(checkoutId).lean())?.status).toBe('conflict');

    // A late webhook for the same intent neither books nor refunds twice.
    await deliver(succeeded(checkoutId, intent.paymentIntentId!));
    expect(await Booking.exists({ _id: checkoutId })).toBeNull();
    expect(mocks.refundCreate).toHaveBeenCalledTimes(1);
    expect(mocks.paidNotify).not.toHaveBeenCalled();
  });

  it('the back button, a new checkout and the expiry sweep leave nothing behind', async () => {
    mocks.intentRetrieve.mockImplementation(async (id: string) => ({ id, status: 'requires_payment_method' }));
    const first = (await startCheckout()).body.checkout.id;
    const firstIntent = await createPaymentIntent(first, String(customer));
    expect(firstIntent.success).toBe(true);

    const back = response();
    await abandonCheckout({ params: { bookingId: first }, user: { _id: customer } } as any, back as any, vi.fn());
    expect(back.body).toMatchObject({ success: true, data: { outcome: 'abandoned' } });
    expect(mocks.intentCancel).toHaveBeenCalledWith(firstIntent.paymentIntentId);
    expect(await CheckoutSession.exists({ _id: first })).toBeNull();

    // Starting a new checkout supersedes an open one of the same customer.
    const second = (await startCheckout()).body.checkout.id;
    await createPaymentIntent(second, String(customer));
    const third = (await startCheckout('2027-01-12')).body.checkout.id;
    expect(await CheckoutSession.exists({ _id: second })).toBeNull();
    expect(await CheckoutSession.exists({ _id: third })).toBeTruthy();

    // Past its hold, the sweep removes it.
    vi.setSystemTime(new Date('2027-01-01T11:00:00Z'));
    try {
      const swept = await expireStaleCheckoutSessions();
      expect(swept).toMatchObject({ checked: 1, abandoned: 1 });
      expect(await CheckoutSession.countDocuments({})).toBe(0);
    } finally {
      vi.setSystemTime(new Date('2027-01-01T09:00:00Z'));
    }
    expect(await Booking.countDocuments({})).toBe(0);
    expect(await Payment.countDocuments({})).toBe(0);
    expect(await CalendarReservation.countDocuments({})).toBe(0);
  });

  it('a failed then cancelled intent leaves nothing behind', async () => {
    const checkoutId = (await startCheckout()).body.checkout.id;
    const intent = await createPaymentIntent(checkoutId, String(customer));
    await deliver({ id: `evt_${new Types.ObjectId()}`, type: 'payment_intent.payment_failed', data: { object: { id: intent.paymentIntentId, metadata: { bookingId: checkoutId, type: 'booking_payment' } } } });
    expect(await Booking.countDocuments({})).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    await deliver({ id: `evt_${new Types.ObjectId()}`, type: 'payment_intent.canceled', data: { object: { id: intent.paymentIntentId, status: 'canceled', metadata: { bookingId: checkoutId, type: 'booking_payment' } } } });
    expect(await CheckoutSession.exists({ _id: checkoutId })).toBeNull();
    expect(await Booking.countDocuments({})).toBe(0);
  });

  // --- CodeRabbit round 2: races between confirm, webhook and promotion ---

  const confirmAs = async (bookingId: string, paymentIntentId: string) => {
    const res = response();
    await confirmPayment({ body: { bookingId, paymentIntentId }, user: { _id: customer } } as any, res as any);
    return res;
  };

  const blockSlot = async (checkoutId: string) => {
    const session = await CheckoutSession.findById(checkoutId).lean();
    const blocker = await Booking.create({
      customer: otherCustomer, professional, project, bookingType: 'project', status: 'booked',
      location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
      rfqData: { serviceType: 'Painting', description: 'Blocker' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, answers: [] },
      quote: { amount: 100, currency: 'EUR', description: 'Blocker' },
      assignedTeamMembers: [professional],
      scheduledStartDate: session!.bookingData.scheduledStartDate,
      scheduledExecutionEndDate: session!.bookingData.scheduledExecutionEndDate,
    });
    await reserveBookingCalendar(blocker as any);
    return blocker;
  };

  const paidCheckout = async (pointsToRedeem = 0) => {
    const checkoutId = (await startCheckout()).body.checkout.id;
    if (pointsToRedeem > 0) {
      const intentRes = response();
      await ensurePaymentIntent({ params: { bookingId: checkoutId }, body: { pointsToRedeem }, user: { _id: customer } } as any, intentRes as any);
      expect(intentRes.body.success).toBe(true);
    }
    const intent = await createPaymentIntent(checkoutId, String(customer), pointsToRedeem || undefined);
    expect(intent.success).toBe(true);
    return { checkoutId, intentId: intent.paymentIntentId! };
  };

  it('a promotion that lost the race returns the winner booking instead of refunding it', async () => {
    const { checkoutId, intentId } = await paidCheckout();
    // The losing attempt read "no booking, session open" before the winner committed.
    const staleCheckout = await CheckoutSession.findById(checkoutId);
    expect((await confirmAs(checkoutId, intentId)).body.success).toBe(true);
    expect(await Booking.exists({ _id: checkoutId })).toBeTruthy();

    vi.spyOn(Booking, 'findById').mockResolvedValueOnce(null as any);
    vi.spyOn(CheckoutSession, 'findById').mockResolvedValueOnce(staleCheckout as any);
    // Its availability recheck now counts the winner's own booking as a conflict.
    const result = await promoteCheckoutSession(checkoutId, { id: intentId, latest_charge: `ch_${intentId}` } as any);
    expect(result.status).toBe('promoted');
    expect(mocks.refundCreate).not.toHaveBeenCalled();
    expect((await CheckoutSession.findById(checkoutId).lean())?.status).toBe('promoted');
    expect(await Booking.countDocuments({ _id: checkoutId })).toBe(1);
  });

  it('concurrent confirm and webhook promote once and never refund', async () => {
    const { checkoutId, intentId } = await paidCheckout();
    const [confirmed, delivered] = await Promise.all([
      confirmAs(checkoutId, intentId),
      deliver(succeeded(checkoutId, intentId)),
      confirmAs(checkoutId, intentId),
    ]);
    expect(confirmed.body.success).toBe(true);
    expect(delivered.statusCode).toBe(200);
    expect(await Booking.countDocuments({ _id: checkoutId })).toBe(1);
    expect(mocks.refundCreate).not.toHaveBeenCalled();
    expect((await Booking.findById(checkoutId).lean())?.payment?.status).toBe('authorized');
    expect(await Payment.countDocuments({ booking: checkoutId })).toBe(1);
  });

  it('a conflict refund that failed is completed by the next signal, and only once', async () => {
    const { checkoutId, intentId } = await paidCheckout();
    await blockSlot(checkoutId);
    mocks.refundCreate.mockRejectedValueOnce(Object.assign(new Error('Stripe unavailable'), { type: 'StripeConnectionError' }));
    expect((await confirmAs(checkoutId, intentId)).statusCode).toBe(500);
    let checkout = await CheckoutSession.findById(checkoutId).lean();
    expect(checkout?.status).toBe('conflict');
    expect(checkout?.refundedAt).toBeUndefined();

    // Stripe's webhook finishes the refund the crashed attempt missed.
    await deliver(succeeded(checkoutId, intentId));
    expect(mocks.refundCreate).toHaveBeenCalledTimes(2);
    expect(mocks.refundCreate.mock.calls[1][1]).toEqual({ idempotencyKey: `checkout-conflict-refund:${intentId}` });
    checkout = await CheckoutSession.findById(checkoutId).lean();
    expect(checkout?.refundedAt).toBeTruthy();
    await deliver(succeeded(checkoutId, intentId));
    expect(mocks.refundCreate).toHaveBeenCalledTimes(2);
    expect(await Booking.exists({ _id: checkoutId })).toBeNull();
  });

  it('recreates a Payment row a crashed promotion never wrote', async () => {
    const { checkoutId, intentId } = await paidCheckout();
    // The promotion stops after the Booking insert.
    vi.spyOn(Payment, 'findOneAndUpdate').mockRejectedValueOnce(new Error('connection reset'));
    expect((await confirmAs(checkoutId, intentId)).statusCode).toBe(500);
    expect((await Booking.findById(checkoutId).lean())?.payment?.status).toBe('pending');
    expect(await Payment.countDocuments({ booking: checkoutId })).toBe(0);

    // The next confirmation settles the booking and creates the row.
    const again = await confirmAs(checkoutId, intentId);
    expect(again.body.data.status).toBe('authorized');
    const row = await Payment.findOne({ booking: checkoutId }).lean();
    expect(row).toMatchObject({ status: 'authorized', stripePaymentIntentId: intentId });
    expect(row?.customer && String(row.customer)).toBe(String(customer));
  });

  it('the webhook recreates a missing Payment row on either path without rolling a status back', async () => {
    // Main path: the webhook settles a pending booking whose row is missing.
    const first = await paidCheckout();
    await promoteCheckoutSession(first.checkoutId, { id: first.intentId } as any);
    await Payment.deleteMany({ booking: first.checkoutId });
    await deliver(succeeded(first.checkoutId, first.intentId));
    expect(await Payment.findOne({ booking: first.checkoutId }).lean()).toMatchObject({ status: 'authorized', stripePaymentIntentId: first.intentId });

    // Already-authorized path: a later delivery restores a lost row and
    // leaves an existing one untouched.
    await Payment.deleteMany({ booking: first.checkoutId });
    await deliver(succeeded(first.checkoutId, first.intentId));
    expect(await Payment.findOne({ booking: first.checkoutId }).lean()).toMatchObject({ status: 'authorized', stripePaymentIntentId: first.intentId });
    await Payment.updateOne({ booking: first.checkoutId }, { $set: { status: 'completed' } });
    await deliver(succeeded(first.checkoutId, first.intentId));
    expect((await Payment.findOne({ booking: first.checkoutId }).lean())?.status).toBe('completed');
  });

  it('a confirmation that read a pending payment never rolls back a refund that landed meanwhile', async () => {
    const { checkoutId, intentId } = await paidCheckout();
    await promoteCheckoutSession(checkoutId, { id: intentId } as any);
    expect((await Booking.findById(checkoutId).lean())?.payment?.status).toBe('pending');
    // While confirmation waits on Stripe, the webhook authorizes the payment
    // and a refund completes.
    const succeededIntent = { id: intentId, status: 'succeeded', latest_charge: `ch_${intentId}`, currency: 'eur', amount: 12100, metadata: {} };
    mocks.intentRetrieve.mockImplementationOnce(async () => {
      await Booking.updateOne({ _id: checkoutId }, { $set: { status: 'refunded', 'payment.status': 'refunded', 'payment.refundedAt': new Date() } });
      await Payment.updateOne({ booking: checkoutId }, { $set: { status: 'refunded' } }, { upsert: true });
      return succeededIntent;
    });
    const confirmed = await confirmAs(checkoutId, intentId);
    expect(confirmed.body.data.status).toBe('refunded');
    const booking = await Booking.findById(checkoutId).lean();
    expect(booking?.status).toBe('refunded');
    expect(booking?.payment?.status).toBe('refunded');
    expect((await Payment.findOne({ booking: checkoutId }).lean())?.status).toBe('refunded');
    expect(await Payment.countDocuments({ booking: checkoutId })).toBe(1);
  });

  it('applies the benefits when confirmation wins after the webhook read the payment pending', async () => {
    await User.updateOne({ _id: customer }, { $set: { points: 30, pointsExpiry: new Date(Date.now() + 90 * DAY_MS) } });
    try {
      const { checkoutId, intentId } = await paidCheckout(10);
      await promoteCheckoutSession(checkoutId, { id: intentId } as any);
      const original = Booking.findOneAndUpdate.bind(Booking);
      // The webhook has read "pending"; confirmPayment authorizes before its write.
      vi.spyOn(Booking, 'findOneAndUpdate').mockImplementationOnce((async (...args: any[]) => {
        expect((await confirmAs(checkoutId, intentId)).body.data.status).toBe('authorized');
        return (original as any)(...args);
      }) as any);
      const delivered = await deliver(succeeded(checkoutId, intentId));
      expect(delivered.statusCode).toBe(200);

      const booking: any = await Booking.findById(checkoutId).lean();
      expect(booking.payment.status).toBe('authorized');
      expect(booking.payment.benefitsAppliedIntentId).toBe(intentId);
      expect(await PointTransaction.countDocuments({ relatedBooking: booking._id, source: 'redemption' })).toBe(1);
      expect((await User.findById(customer).lean())?.points).toBe(20);
      // A duplicate delivery does not deduct again.
      await deliver(succeeded(checkoutId, intentId));
      expect((await User.findById(customer).lean())?.points).toBe(20);
    } finally {
      await User.updateOne({ _id: customer }, { $set: { points: 0 } });
    }
  });

  it('finishes a benefit that failed midway on retry without repeating the one that succeeded', async () => {
    await User.updateOne({ _id: customer }, { $set: { points: 30, pointsExpiry: new Date(Date.now() + 90 * DAY_MS) } });
    try {
      const { checkoutId, intentId } = await paidCheckout(10);
      await promoteCheckoutSession(checkoutId, { id: intentId } as any);
      const code = await DiscountCode.create({
        code: 'SAVE5', type: 'fixed', value: 5, validFrom: new Date(Date.now() - DAY_MS),
        validUntil: new Date(Date.now() + 30 * DAY_MS), createdBy: professional, usageCount: 0,
      });
      await Booking.updateOne({ _id: checkoutId }, {
        $set: { 'payment.discount.codeId': code._id, 'payment.discount.codeDiscountAmount': 5, 'payment.discount.codeLabel': 'SAVE5' },
      });

      // Points are deducted, then the discount-code lookup fails transiently.
      const failingLookup = { session: () => Promise.reject(Object.assign(new Error('socket closed'), { name: 'MongoNetworkError' })) };
      vi.spyOn(DiscountCode, 'findById').mockReturnValueOnce(failingLookup as any);
      const event = succeeded(checkoutId, intentId);
      const failed = await deliver(event);
      expect(failed.statusCode).toBe(500);
      let booking: any = await Booking.findById(checkoutId).lean();
      expect(booking.payment.status).toBe('authorized');
      expect(booking.payment.pointsAppliedIntentId).toBe(intentId);
      expect(booking.payment.discountCodeAppliedIntentId).toBeUndefined();
      expect(booking.payment.benefitsAppliedIntentId).toBeUndefined();
      expect((await User.findById(customer).lean())?.points).toBe(20);
      expect(await DiscountCodeUsage.countDocuments({ booking: checkoutId })).toBe(0);

      // Stripe's retry of the same event records the code usage, and only that.
      expect((await deliver(event)).statusCode).toBe(200);
      booking = await Booking.findById(checkoutId).lean();
      expect(booking.payment.discountCodeAppliedIntentId).toBe(intentId);
      expect(booking.payment.benefitsAppliedIntentId).toBe(intentId);
      expect((await User.findById(customer).lean())?.points).toBe(20);
      expect(await PointTransaction.countDocuments({ relatedBooking: booking._id, source: 'redemption' })).toBe(1);
      expect(await DiscountCodeUsage.countDocuments({ booking: checkoutId })).toBe(1);
      expect((await DiscountCode.findById(code._id).lean())?.usageCount).toBe(1);

      await deliver(succeeded(checkoutId, intentId));
      expect((await User.findById(customer).lean())?.points).toBe(20);
      expect((await DiscountCode.findById(code._id).lean())?.usageCount).toBe(1);
    } finally {
      await User.updateOne({ _id: customer }, { $set: { points: 0 } });
    }
  });

  it('the back button reports a refunded slot conflict without a success redirect', async () => {
    const { checkoutId, intentId } = await paidCheckout();
    await blockSlot(checkoutId);
    // The intent had already succeeded when the customer went back.
    mocks.intentCancel.mockRejectedValueOnce(Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' }));
    const back = response();
    await abandonCheckout({ params: { bookingId: checkoutId }, user: { _id: customer } } as any, back as any, vi.fn());
    expect(back.statusCode).toBe(200);
    expect(back.body.data.outcome).toBe('conflict');
    expect(back.body.data.redirectTo).toBeUndefined();
    expect(mocks.refundCreate).toHaveBeenCalledTimes(1);
    expect(mocks.refundCreate.mock.calls[0][0]).toMatchObject({ payment_intent: intentId });
    expect(await Booking.exists({ _id: checkoutId })).toBeNull();
  });

  it('blocks a replacement when a payment intent is persisted between the read and the delete', async () => {
    const checkoutId = (await startCheckout()).body.checkout.id;
    // The customer's payment page creates its intent right after the
    // replacement request read the (still intent-less) checkout.
    const realDeleteOne = CheckoutSession.deleteOne.bind(CheckoutSession);
    let racedIntentId: string | undefined;
    const deleteSpy = vi.spyOn(CheckoutSession, 'deleteOne').mockImplementationOnce(((filter: any, ...rest: any[]) => {
      const run = async () => {
        const intent = await createPaymentIntent(checkoutId, String(customer));
        expect(intent.success).toBe(true);
        racedIntentId = intent.paymentIntentId;
        return realDeleteOne(filter, ...rest);
      };
      return run() as any;
    }) as any);

    const replacement = await startCheckout('2027-01-12');
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(replacement.statusCode).toBe(409);
    expect(replacement.body.code).toBe('PAYMENT_IN_PROGRESS');
    const original = await CheckoutSession.findById(checkoutId).lean();
    expect(original?.status).toBe('open');
    expect(original?.payment?.stripePaymentIntentId).toBe(racedIntentId);
    expect(await CheckoutSession.countDocuments({})).toBe(1);
    // The raced intent is still payable: nothing cancelled it.
    expect(mocks.intentCancel).not.toHaveBeenCalledWith(racedIntentId);
  });

  it('does not start a replacement checkout while the previous payment is in flight', async () => {
    const { checkoutId } = await paidCheckout();
    mocks.intentCancel.mockRejectedValueOnce(Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' }));
    mocks.intentRetrieve.mockImplementationOnce(async (id: string) => ({ id, status: 'processing' }));
    const replacement = await startCheckout('2027-01-12');
    expect(replacement.statusCode).toBe(409);
    expect(replacement.body.code).toBe('PAYMENT_IN_PROGRESS');
    expect(await CheckoutSession.countDocuments({})).toBe(1);
    expect((await CheckoutSession.findById(checkoutId).lean())?.status).toBe('open');

    // Once the previous payment is closed, the replacement goes ahead.
    const later = await startCheckout('2027-01-12');
    expect(later.statusCode).toBe(201);
    expect(await CheckoutSession.exists({ _id: checkoutId })).toBeNull();
  });
});
