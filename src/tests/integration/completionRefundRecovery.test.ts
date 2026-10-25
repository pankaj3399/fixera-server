import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.hoisted(() => {
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_completion_refund_recovery';
  process.env.STRIPE_PLATFORM_COMMISSION_PERCENT = '0';
});

const stripeMocks = vi.hoisted(() => ({
  refundCreate: vi.fn(),
  refundList: vi.fn(),
  refundRetrieve: vi.fn(),
  transferCreate: vi.fn(),
  transferReversal: vi.fn(),
  paymentIntentRetrieve: vi.fn(),
  chargeRetrieve: vi.fn(),
  constructEvent: vi.fn(),
}));

const notificationEvents = vi.hoisted(() => [] as any[]);

vi.mock('../../services/stripe', () => ({
  stripe: {
    refunds: {
      create: stripeMocks.refundCreate,
      list: stripeMocks.refundList,
      retrieve: stripeMocks.refundRetrieve,
    },
    transfers: {
      create: stripeMocks.transferCreate,
      createReversal: stripeMocks.transferReversal,
    },
    paymentIntents: {
      create: vi.fn(),
      retrieve: stripeMocks.paymentIntentRetrieve,
      cancel: vi.fn(),
    },
    charges: { retrieve: stripeMocks.chargeRetrieve },
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

vi.mock('../../utils/notifications/notify', () => ({
  notify: vi.fn(async (args: any) => {
    notificationEvents.push(args);
    return {};
  }),
  notifyAsync: vi.fn((args: any) => {
    notificationEvents.push(args);
  }),
}));

vi.mock('../../services/invoiceArtifacts', () => ({
  ensureBookingInvoiceArtifacts: vi.fn(async () => undefined),
}));

vi.mock('../../utils/vatManagement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/vatManagement')>();
  return {
    ...actual,
    resolveVatDecisionFromConfig: vi.fn(async () => ({
      action: 'standard_rate',
      country: 'BE',
      standardRate: 21,
      appliedRate: 21,
      reverseVat: false,
      vatLabel: 'VAT 21%',
    })),
    getQuotationTierRateOptionsFromConfig: vi.fn(async () => []),
    getVatRateOptionsFromConfig: vi.fn(async () => []),
    validateServiceCountryCoverage: vi.fn(async () => null),
  };
});

import Booking from '../../models/booking';
import Payment from '../../models/payment';
import User from '../../models/user';
import PlatformSettings from '../../models/platformSettings';
import {
  finalizeBookingCompletion,
  runCompletionAutoAccept,
} from '../../utils/notifications/runCompletionAutoAccept';
import {
  claimPendingExtraCostRefund,
  clearPersistedPendingExtraCostRefund,
  releasePendingExtraCostRefundClaim,
} from '../../utils/completionRefund';
import { customerConfirmCompletion } from '../../handlers/Booking/completion';
import { handleWebhook } from '../../handlers/Stripe/webhooks';

const DAY_MS = 24 * 60 * 60 * 1000;

type ProviderRefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';

interface ProviderRefund {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  payment_intent: string;
  charge: string;
  created: number;
  status: ProviderRefundStatus;
  metadata: Record<string, string>;
  reason?: string;
}

/**
 * Provider fake for the base PaymentIntent refunds. It keeps actual list/paging
 * shapes, enforces charge capacity for non-failed refunds, and honours an
 * idempotency key only for a finite window (Stripe documents at least 24h).
 */
const createProviderFake = (opts: {
  chargeMinorByIntent: Record<string, number>;
  keyTtlMs?: number;
  pageSize?: number;
}) => {
  const keyTtlMs = opts.keyTtlMs ?? DAY_MS;
  const pageSize = opts.pageSize ?? 100;
  let nowMs = Date.now();
  let nextId = 1;
  let nextCreateStatus: ProviderRefundStatus = 'succeeded';
  let acceptNextThenThrow = false;
  let holdNextCreate: Promise<void> | null = null;
  const refunds: ProviderRefund[] = [];
  const keyRegistry = new Map<string, { refund: ProviderRefund; usedAt: number }>();
  const createCalls: Array<{ params: any; idempotencyKey?: string }> = [];
  const listCalls: any[] = [];
  const retrieveCalls: string[] = [];

  const cashMinor = (intent: string): number => refunds
    .filter((refund) => refund.payment_intent === intent)
    .filter((refund) => refund.status !== 'failed' && refund.status !== 'canceled')
    .reduce((sum, refund) => sum + refund.amount, 0);

  const seedRefund = (overrides: Partial<ProviderRefund> & {
    payment_intent: string;
    amount: number;
    status: ProviderRefundStatus;
    created?: number;
    metadata?: Record<string, string>;
  }): ProviderRefund => {
    const refund: ProviderRefund = {
      id: overrides.id || `re_seed_${nextId++}`,
      object: 'refund',
      amount: overrides.amount,
      currency: overrides.currency || 'eur',
      payment_intent: overrides.payment_intent,
      charge: overrides.charge || `ch_${overrides.payment_intent}`,
      created: overrides.created ?? Math.floor(nowMs / 1000),
      status: overrides.status,
      metadata: overrides.metadata || {},
      ...(overrides.reason ? { reason: overrides.reason } : {}),
    };
    refunds.push(refund);
    return refund;
  };

  const create = async (params: any, options?: any): Promise<ProviderRefund> => {
    const idempotencyKey = options?.idempotencyKey;
    createCalls.push({ params, idempotencyKey });
    if (idempotencyKey) {
      const existing = keyRegistry.get(idempotencyKey);
      if (existing && nowMs - existing.usedAt <= keyTtlMs) {
        return existing.refund;
      }
    }
    const intent = String(params.payment_intent);
    const capacity = opts.chargeMinorByIntent[intent];
    if (typeof capacity !== 'number') {
      throw new Error(`Provider fake has no charge for ${intent}`);
    }
    const amount = Number(params.amount);
    const status = nextCreateStatus;
    if (status !== 'failed' && status !== 'canceled' && cashMinor(intent) + amount > capacity) {
      throw new Error(
        `Provider rejected refund: ${cashMinor(intent) + amount} minor exceeds charge ${capacity} for ${intent}`,
      );
    }
    const refund: ProviderRefund = {
      id: `re_${nextId++}`,
      object: 'refund',
      amount,
      currency: 'eur',
      payment_intent: intent,
      charge: `ch_${intent}`,
      created: Math.floor(nowMs / 1000),
      status,
      metadata: { ...(params.metadata || {}) },
    };
    refunds.push(refund);
    if (idempotencyKey) keyRegistry.set(idempotencyKey, { refund, usedAt: nowMs });
    const hold = holdNextCreate;
    holdNextCreate = null;
    if (hold) await hold;
    if (acceptNextThenThrow) {
      acceptNextThenThrow = false;
      throw new Error('StripeConnectionError: socket hang up after request write');
    }
    return refund;
  };

  const list = async (params: any = {}) => {
    listCalls.push({ ...params });
    let filtered = refunds
      .filter((refund) => !params.payment_intent || refund.payment_intent === params.payment_intent)
      .slice()
      .sort((left, right) => right.created - left.created || right.id.localeCompare(left.id));
    let start = 0;
    if (params.starting_after) {
      const index = filtered.findIndex((refund) => refund.id === params.starting_after);
      start = index >= 0 ? index + 1 : filtered.length;
    }
    const limit = Number(params.limit) || pageSize;
    const data = filtered.slice(start, start + limit);
    return {
      object: 'list',
      data,
      has_more: start + data.length < filtered.length,
      url: '/v1/refunds',
    };
  };

  const retrieve = async (id: string): Promise<ProviderRefund> => {
    retrieveCalls.push(id);
    const refund = refunds.find((entry) => entry.id === id);
    if (!refund) throw new Error(`No such refund: ${id}`);
    return { ...refund };
  };

  return {
    refunds,
    createCalls,
    listCalls,
    retrieveCalls,
    cashMinor,
    seedRefund,
    create,
    list,
    retrieve,
    setNow: (value: number) => { nowMs = value; },
    advance: (value: number) => { nowMs += value; },
    now: () => nowMs,
    setNextCreateStatus: (status: ProviderRefundStatus) => { nextCreateStatus = status; },
    acceptNextThenThrow: () => { acceptNextThenThrow = true; },
    holdNextCreate: (promise: Promise<void>) => { holdNextCreate = promise; },
    setRefundStatus: (id: string, status: ProviderRefundStatus) => {
      const refund = refunds.find((entry) => entry.id === id);
      if (!refund) throw new Error(`No such refund: ${id}`);
      refund.status = status;
    },
  };
};

type ProviderFake = ReturnType<typeof createProviderFake>;

const installProvider = (provider: ProviderFake) => {
  stripeMocks.refundCreate.mockImplementation((params: any, options: any) => provider.create(params, options));
  stripeMocks.refundList.mockImplementation((params: any) => provider.list(params));
  stripeMocks.refundRetrieve.mockImplementation((id: string) => provider.retrieve(id));
};

const createUser = async (overrides: Record<string, any>) => User.create({
  name: 'U',
  email: `u-${new Types.ObjectId()}@example.com`,
  phone: `+32${String(new Types.ObjectId()).slice(-9)}`,
  password: 'hashed-password',
  role: 'customer',
  accountStatus: 'active',
  location: {
    type: 'Point',
    coordinates: [4.35, 50.85],
    address: 'A',
    city: 'Brussels',
    country: 'BE',
    postalCode: '1000',
  },
  ...overrides,
});

let customerId: Types.ObjectId;
let professionalId: Types.ObjectId;

const armAutoTransfer = async (suffix: string, chargeMinor = 12000) => {
  await User.updateOne(
    { _id: professionalId },
    { $set: { 'stripe.accountId': `acct_${suffix}` } },
  );
  stripeMocks.chargeRetrieve.mockResolvedValue({
    id: `ch_${suffix}`,
    currency: 'eur',
    balance_transaction: { amount: chargeMinor, currency: 'eur' },
  });
  stripeMocks.transferCreate.mockResolvedValue({
    id: `tr_${suffix}`,
    destination_payment: `py_${suffix}`,
  });
};

const seedBooking = async (params: {
  suffix: string;
  status?: 'professional_completed' | 'completed';
  pending?: {
    amount?: number;
    requestedAt?: Date;
    obligationId?: string;
    providerRefundId?: string;
    claimId?: string;
    processingAt?: Date;
  } | null;
  payment?: Record<string, any>;
}) => {
  const suffix = params.suffix;
  const pending = params.pending === undefined
    ? {
        amount: 20,
        reason: 'Negative extra-cost adjustment (unit underuse)',
        requestedAt: new Date(Date.now() - 30 * 60 * 1000),
        obligationId: new Types.ObjectId().toString(),
      }
    : params.pending;
  const booking = await Booking.create({
    customer: customerId,
    professional: professionalId,
    bookingType: 'professional',
    status: params.status || 'completed',
    professionalCompletedAt: new Date(Date.now() - 11 * DAY_MS),
    location: {
      type: 'Point',
      coordinates: [4.35, 50.85],
      address: 'Main street 1',
      city: 'Brussels',
      country: 'BE',
      postalCode: '1000',
    },
    rfqData: { serviceType: 'Bathroom', description: 'Y', answers: [] },
    quote: { amount: 100, currency: 'EUR', description: 'Quote' },
    vatDecision: {
      action: 'standard_rate',
      country: 'BE',
      standardRate: 21,
      appliedRate: 21,
      answers: [],
    },
    extraCosts: [{ type: 'other', name: 'Waste', justification: 'Less', amount: -20 }],
    extraCostTotal: -20,
    payment: {
      status: 'completed',
      currency: 'EUR',
      amount: 100,
      netAmount: 100,
      vatAmount: 20,
      vatRate: 20,
      totalWithVat: 120,
      professionalPayout: 80,
      stripePaymentIntentId: `pi_${suffix}`,
      stripeChargeId: `ch_${suffix}`,
      stripeTransferId: `tr_${suffix}`,
      transferStatus: 'succeeded',
      ...(pending ? { extraCostRefundPending: pending } : {}),
      ...(params.payment || {}),
    },
    statusHistory: [{
      status: params.status || 'completed',
      timestamp: new Date(Date.now() - 11 * DAY_MS),
      updatedBy: customerId,
      note: 'seed',
    }],
  });
  return Booking.findById(booking._id);
};

const createBasePayment = async (booking: any, overrides: Record<string, any> = {}) => Payment.create({
  booking: booking._id,
  customer: customerId,
  professional: professionalId,
  status: 'completed',
  currency: 'EUR',
  amount: 100,
  netAmount: 100,
  vatAmount: 20,
  vatRate: 20,
  totalWithVat: 120,
  stripePaymentIntentId: booking.payment.stripePaymentIntentId,
  refunds: [],
  ...overrides,
});

const response = () => {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
};

const deliverExtraCostWebhook = async (params: {
  intent: string;
  chargeMinor: number;
  refund: ProviderRefund;
}) => {
  stripeMocks.constructEvent.mockReturnValue({
    id: `evt_${new Types.ObjectId()}`,
    type: 'charge.refunded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `ch_${params.intent}`,
        payment_intent: params.intent,
        currency: 'eur',
        amount: params.chargeMinor,
        amount_refunded: params.refund.amount,
        refunds: { data: [params.refund] },
      },
    },
  });
  const res = response();
  await handleWebhook({
    headers: { 'stripe-signature': 'sig' },
    body: Buffer.from('{}'),
  } as any, res as any);
  return res;
};

const readLedger = async (bookingId: any) => {
  const rows: any[] = await Payment.find({ booking: bookingId }).lean();
  return {
    rows,
    refunds: rows.flatMap((row) => Array.isArray(row.refunds) ? row.refunds : []),
  };
};

describeDb('completion refund recovery (disposable Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: 'fixera_completion_refund_recovery_test' });
    await mongoose.connection.dropDatabase();
    await PlatformSettings.deleteMany({});
    customerId = (await createUser({ role: 'customer' }))._id;
    professionalId = (await createUser({
      role: 'professional',
      professionalStatus: 'approved',
    }))._id;
    await Payment.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    notificationEvents.length = 0;
    await Promise.all([
      Booking.deleteMany({}),
      Payment.deleteMany({}),
      User.deleteMany({ _id: { $nin: [customerId, professionalId] } }),
      mongoose.connection.collection('stripeevents').deleteMany({}),
    ]);
    await User.updateOne(
      { _id: customerId },
      { $set: { totalSpent: 0, totalBookings: 0, loyaltyLevel: 'Bronze' } },
    );
  });

  it('settles a webhook-recorded refund after 24h without moving cash again', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    const provider = createProviderFake({ chargeMinorByIntent: { [`pi_${suffix}`]: 12000 } });
    installProvider(provider);
    const booking = await seedBooking({
      suffix,
      status: 'professional_completed',
      pending: null,
      payment: { status: 'authorized' },
    });

    provider.acceptNextThenThrow();
    const first = await runCompletionAutoAccept();
    expect(first.errors.join(' ')).toContain('refund_recovery_required');
    expect(provider.refunds).toHaveLength(1);

    let stored: any = await Booking.findById(booking!._id).lean();
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toMatchObject({ amount: 20 });
    expect(stored.payment.extraCostRefundPending.obligationId).toBeTruthy();
    expect(stored.payment.extraCostRefundPending.providerRefundId).toBeUndefined();
    expect(stored.payment.extraCostRefundPending.processingAt).toBeUndefined();
    expect((await readLedger(booking!._id)).refunds).toHaveLength(0);

    // The tagged webhook records the accepted refund, but cannot clear the
    // completion marker. Replay must stay one ledger row.
    await deliverExtraCostWebhook({
      intent: `pi_${suffix}`,
      chargeMinor: 12000,
      refund: provider.refunds[0],
    });
    await deliverExtraCostWebhook({
      intent: `pi_${suffix}`,
      chargeMinor: 12000,
      refund: provider.refunds[0],
    });
    let ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0]).toMatchObject({
      refundId: provider.refunds[0].id,
      kind: 'extra_cost',
      amount: 20,
      obligationId: stored.payment.extraCostRefundPending.obligationId,
    });

    provider.advance(25 * 60 * 60 * 1000);
    const second = await runCompletionAutoAccept();
    expect(second).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.refunds).toHaveLength(1);
    expect(provider.cashMinor(`pi_${suffix}`)).toBe(2000);

    stored = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds.reduce((sum, refund) => sum + refund.amount, 0)).toBe(20);
    expect(notificationEvents).toHaveLength(4);
    const customer: any = await User.findById(customerId).lean();
    expect(customer.totalBookings).toBe(1);
    expect(customer.totalSpent).toBe(100);
  });

  it('reconciles an accepted provider refund with no local ledger row after paging', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    const intent = `pi_${suffix}`;
    const provider = createProviderFake({
      chargeMinorByIntent: { [intent]: 12000 },
      pageSize: 1,
    });
    installProvider(provider);
    const booking = await seedBooking({
      suffix,
      status: 'professional_completed',
      pending: null,
      payment: { status: 'authorized' },
    });

    // An older real booking refund on the same intent forces a second page.
    provider.seedRefund({
      amount: 1000,
      status: 'succeeded',
      created: Math.floor(Date.now() / 1000) - 30 * 60 * 60,
      metadata: { bookingId: String(booking!._id), refundKind: 'booking' },
    });
    provider.acceptNextThenThrow();
    const first = await runCompletionAutoAccept();
    expect(first.errors.join(' ')).toContain('refund_recovery_required');
    expect(provider.refunds.filter((refund) => refund.metadata.refundKind === 'extra_cost'))
      .toHaveLength(1);
    expect((await readLedger(booking!._id)).refunds).toHaveLength(0);

    provider.advance(25 * 60 * 60 * 1000);
    const second = await runCompletionAutoAccept();
    expect(second).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.listCalls.length).toBeGreaterThanOrEqual(2);
    expect(provider.refunds.filter((refund) => refund.metadata.refundKind === 'extra_cost'))
      .toHaveLength(1);

    const ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0]).toMatchObject({
      kind: 'extra_cost',
      amount: 20,
      status: 'succeeded',
    });
    expect((await Booking.findById(booking!._id).lean() as any).payment.extraCostRefundPending)
      .toBeUndefined();
    expect(notificationEvents).toHaveLength(4);
  });

  it('reserves a pending provider refund, polls it, and settles without a second create', async () => {
    const suffix = new Types.ObjectId().toString();
    const intent = `pi_${suffix}`;
    const provider = createProviderFake({ chargeMinorByIntent: { [intent]: 12000 } });
    installProvider(provider);
    const booking = await seedBooking({ suffix });
    await createBasePayment(booking);

    provider.setNextCreateStatus('pending');
    const first = await runCompletionAutoAccept();
    expect(first.errors.join(' ')).toContain('refund_recovery_required');
    expect(provider.createCalls).toHaveLength(1);
    const pendingRefund = provider.refunds[0];
    expect(pendingRefund.status).toBe('pending');

    let stored: any = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending).toMatchObject({
      amount: 20,
      providerRefundId: pendingRefund.id,
    });
    expect(stored.payment.extraCostRefundPending.processingAt).toBeUndefined();
    let ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0]).toMatchObject({ status: 'pending', kind: 'extra_cost' });
    expect(notificationEvents).toHaveLength(0);

    const stillPending = await runCompletionAutoAccept();
    expect(stillPending.errors.join(' ')).toContain('refund_recovery_required');
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.retrieveCalls).toContain(pendingRefund.id);
    expect((await Booking.findById(booking!._id).lean() as any).payment.extraCostRefundPending)
      .toBeTruthy();

    provider.setRefundStatus(pendingRefund.id, 'succeeded');
    const settled = await runCompletionAutoAccept();
    expect(settled).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.cashMinor(intent)).toBe(2000);
    stored = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0].status).toBe('succeeded');
    expect(notificationEvents).toHaveLength(3);
  });

  it('retries after a pending provider refund later fails', async () => {
    const suffix = new Types.ObjectId().toString();
    const intent = `pi_${suffix}`;
    const provider = createProviderFake({ chargeMinorByIntent: { [intent]: 12000 } });
    installProvider(provider);
    const obligationId = new Types.ObjectId().toString();
    const booking = await seedBooking({
      suffix,
      pending: {
        amount: 20,
        reason: 'Negative extra-cost adjustment (unit underuse)',
        requestedAt: new Date(Date.now() - 30 * 60 * 1000),
        obligationId,
      },
    });
    await createBasePayment(booking);

    provider.setNextCreateStatus('pending');
    const first = await runCompletionAutoAccept();
    expect(first.errors.join(' ')).toContain('refund_recovery_required');
    expect(provider.createCalls).toHaveLength(1);
    const pendingRefund = provider.refunds[0];
    expect(pendingRefund.status).toBe('pending');

    provider.setRefundStatus(pendingRefund.id, 'failed');
    provider.setNextCreateStatus('succeeded');
    const second = await runCompletionAutoAccept();
    expect(second).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(2);
    expect(provider.cashMinor(intent)).toBe(2000);
    expect(provider.refunds.filter((refund) => refund.status === 'failed')).toHaveLength(1);
    expect(provider.refunds.filter((refund) => refund.status === 'succeeded')).toHaveLength(1);

    const stored: any = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    const ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(2);
    expect(ledger.refunds.map((refund) => refund.status).sort())
      .toEqual(['failed', 'succeeded']);
    expect(notificationEvents).toHaveLength(3);
  });

  it.each(['failed', 'canceled'] as const)(
    'retries after a %s provider refund without counting it as cash',
    async (failedStatus) => {
      const suffix = new Types.ObjectId().toString();
      const intent = `pi_${suffix}`;
      const provider = createProviderFake({ chargeMinorByIntent: { [intent]: 12000 } });
      installProvider(provider);
      const obligationId = new Types.ObjectId().toString();
      const booking = await seedBooking({
        suffix,
        pending: {
          amount: 20,
          reason: 'Negative extra-cost adjustment (unit underuse)',
          requestedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
          obligationId,
        },
      });
      const failedRefund = provider.seedRefund({
        amount: 2000,
        status: failedStatus,
        created: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
        metadata: {
          bookingId: String(booking!._id),
          refundKind: 'extra_cost',
          obligationId,
        },
      });
      await createBasePayment(booking, {
        refunds: [{
          amount: 20,
          refundId: failedRefund.id,
          refundedAt: new Date(failedRefund.created * 1000),
          source: 'platform',
          kind: 'extra_cost',
          obligationId,
          status: failedStatus,
        }],
      });

      const result = await runCompletionAutoAccept();
      expect(result).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
      expect(provider.createCalls).toHaveLength(1);
      expect(provider.refunds).toHaveLength(2);
      expect(provider.cashMinor(intent)).toBe(2000);
      expect(provider.refunds.filter((refund) => refund.status !== 'failed'
        && refund.status !== 'canceled')).toHaveLength(1);

      const stored: any = await Booking.findById(booking!._id).lean();
      expect(stored.payment.extraCostRefundPending).toBeUndefined();
      const ledger = await readLedger(booking!._id);
      expect(ledger.refunds).toHaveLength(2);
      expect(ledger.refunds.map((refund) => refund.status).sort())
        .toEqual([failedStatus, 'succeeded'].sort());
      expect(ledger.refunds.find((refund) => refund.status === 'succeeded')).toMatchObject({
        amount: 20,
        kind: 'extra_cost',
        obligationId,
      });
      expect(notificationEvents).toHaveLength(3);
    },
  );

  it('does not infer an older equal-amount extra refund as this obligation', async () => {
    const suffix = new Types.ObjectId().toString();
    const intent = `pi_${suffix}`;
    const provider = createProviderFake({ chargeMinorByIntent: { [intent]: 12000 } });
    installProvider(provider);
    const obligationId = new Types.ObjectId().toString();
    const otherObligationId = new Types.ObjectId().toString();
    const booking = await seedBooking({
      suffix,
      pending: {
        amount: 20,
        reason: 'Negative extra-cost adjustment (unit underuse)',
        requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        obligationId,
      },
    });
    const older = provider.seedRefund({
      amount: 2000,
      status: 'succeeded',
      created: Math.floor(Date.now() / 1000) - 25 * 60 * 60,
      metadata: {
        bookingId: String(booking!._id),
        refundKind: 'extra_cost',
        obligationId: otherObligationId,
      },
    });
    await createBasePayment(booking, {
      refunds: [{
        amount: 20,
        refundId: older.id,
        refundedAt: new Date(older.created * 1000),
        source: 'platform',
        kind: 'extra_cost',
        obligationId: otherObligationId,
        status: 'succeeded',
      }],
    });

    const result = await runCompletionAutoAccept();
    expect(result).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.refunds).toHaveLength(2);
    const fresh = provider.refunds.find((refund) => refund.metadata.obligationId === obligationId);
    expect(fresh).toMatchObject({ amount: 2000, status: 'succeeded' });
    expect((await Booking.findById(booking!._id).lean() as any).payment.extraCostRefundPending)
      .toBeUndefined();
    const ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(2);
    expect(ledger.refunds.filter((refund) => refund.obligationId === obligationId)).toHaveLength(1);
  });

  it('ignores a milestone/other-intent extra refund when settling the base obligation', async () => {
    const suffix = new Types.ObjectId().toString();
    const intent = `pi_${suffix}`;
    const milestoneIntent = `pi_milestone_${suffix}`;
    const provider = createProviderFake({
      chargeMinorByIntent: { [intent]: 12000, [milestoneIntent]: 5000 },
    });
    installProvider(provider);
    const obligationId = new Types.ObjectId().toString();
    const booking = await seedBooking({
      suffix,
      pending: {
        amount: 20,
        reason: 'Negative extra-cost adjustment (unit underuse)',
        requestedAt: new Date(Date.now() - 30 * 60 * 1000),
        obligationId,
      },
    });
    const base = await createBasePayment(booking);
    const milestone = await Payment.create({
      booking: booking!._id,
      customer: customerId,
      professional: professionalId,
      milestoneIndex: 0,
      milestoneTitle: 'Deposit',
      status: 'completed',
      currency: 'EUR',
      amount: 50,
      totalWithVat: 50,
      stripePaymentIntentId: milestoneIntent,
      refunds: [{
        amount: 20,
        refundId: `re_milestone_${suffix}`,
        refundedAt: new Date(Date.now() - 10 * 60 * 1000),
        source: 'platform',
        kind: 'extra_cost',
        obligationId,
        status: 'succeeded',
      }],
    });
    provider.seedRefund({
      amount: 2000,
      status: 'succeeded',
      payment_intent: milestoneIntent,
      metadata: {
        bookingId: String(booking!._id),
        refundKind: 'extra_cost',
        obligationId,
      },
    });

    const result = await runCompletionAutoAccept();
    expect(result).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.createCalls[0].params.payment_intent).toBe(intent);
    expect(provider.cashMinor(intent)).toBe(2000);
    expect(provider.cashMinor(milestoneIntent)).toBe(2000);

    const baseAfter: any = await Payment.findById(base._id).lean();
    const milestoneAfter: any = await Payment.findById(milestone._id).lean();
    expect(baseAfter.refunds).toHaveLength(1);
    expect(baseAfter.refunds[0].obligationId).toBe(obligationId);
    expect(milestoneAfter.refunds).toHaveLength(1);
    expect(milestoneAfter.refunds[0].refundId).toBe(`re_milestone_${suffix}`);
    expect((await Booking.findById(booking!._id).lean() as any).payment.extraCostRefundPending)
      .toBeUndefined();
  });

  it('does not let a stale claim release or clear a newer claim', async () => {
    const suffix = new Types.ObjectId().toString();
    const booking = await seedBooking({ suffix });

    const firstClaim = await claimPendingExtraCostRefund(booking!._id);
    expect(firstClaim).toBeTruthy();
    const firstClaimId = firstClaim.payment.extraCostRefundPending.claimId;
    expect(firstClaimId).toBeTruthy();

    // Simulate the first lease expiring while its attempt is still running.
    await Booking.updateOne(
      { _id: booking!._id },
      { $set: { 'payment.extraCostRefundPending.processingAt': new Date(Date.now() - 20 * 60 * 1000) } },
    );
    const secondClaim = await claimPendingExtraCostRefund(booking!._id);
    const secondClaimId = secondClaim.payment.extraCostRefundPending.claimId;
    expect(secondClaimId).toBeTruthy();
    expect(secondClaimId).not.toBe(firstClaimId);

    await releasePendingExtraCostRefundClaim(booking!._id, firstClaimId);
    let stored: any = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending.claimId).toBe(secondClaimId);
    expect(stored.payment.extraCostRefundPending.processingAt).toBeInstanceOf(Date);

    expect(await clearPersistedPendingExtraCostRefund(booking!._id, firstClaimId)).toBe(false);
    stored = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending.claimId).toBe(secondClaimId);

    expect(await clearPersistedPendingExtraCostRefund(booking!._id, secondClaimId)).toBe(true);
    stored = await Booking.findById(booking!._id).lean();
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
  });

  it('fences a stale attempt after lease expiry so completion effects run once', async () => {
    const suffix = new Types.ObjectId().toString();
    const intent = `pi_${suffix}`;
    const provider = createProviderFake({ chargeMinorByIntent: { [intent]: 12000 } });
    installProvider(provider);
    const booking = await seedBooking({ suffix });
    await createBasePayment(booking);

    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    provider.holdNextCreate(firstHeld);

    const staleAttempt = finalizeBookingCompletion({
      bookingId: String(booking!._id),
      actorId: String(customerId),
    });
    for (let i = 0; i < 100 && provider.createCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.refunds).toHaveLength(1);

    // Simulate the 15-minute lease expiring while the first provider call is
    // still in flight.
    await Booking.updateOne(
      { _id: booking!._id },
      { $set: { 'payment.extraCostRefundPending.processingAt': new Date(Date.now() - 20 * 60 * 1000) } },
    );
    const replacement = await runCompletionAutoAccept();
    expect(replacement).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });
    expect(provider.createCalls).toHaveLength(1);
    expect(notificationEvents).toHaveLength(3);
    expect((await User.findById(customerId).lean() as any).totalBookings).toBe(1);

    releaseFirst();
    const staleResult = await staleAttempt;
    expect(staleResult.ok).toBe(false);
    expect(staleResult).toMatchObject({ reason: 'completion_claim_lost', skipped: true });

    expect(provider.refunds).toHaveLength(1);
    expect(provider.cashMinor(intent)).toBe(2000);
    const ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(notificationEvents).toHaveLength(3);
    const customer: any = await User.findById(customerId).lean();
    expect(customer.totalBookings).toBe(1);
    expect(customer.totalSpent).toBe(100);
    expect((await Booking.findById(booking!._id).lean() as any).payment.extraCostRefundPending)
      .toBeUndefined();
  });

  it('settles a customer-confirmation retry after the key window through provider reconciliation', async () => {
    const suffix = new Types.ObjectId().toString();
    const intent = `pi_${suffix}`;
    const provider = createProviderFake({ chargeMinorByIntent: { [intent]: 12000 } });
    installProvider(provider);
    const booking = await seedBooking({
      suffix,
      status: 'professional_completed',
      pending: null,
      payment: { status: 'authorized' },
    });
    await armAutoTransfer(suffix);

    provider.acceptNextThenThrow();
    const first = response();
    await customerConfirmCompletion({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    } as any, first as any);
    expect(first.statusCode).toBe(502);
    expect(first.body.error.code).toBe('REFUND_RECOVERY_REQUIRED');
    expect(provider.refunds).toHaveLength(1);
    expect((await readLedger(booking!._id)).refunds).toHaveLength(0);

    provider.advance(25 * 60 * 60 * 1000);
    const second = response();
    await customerConfirmCompletion({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    } as any, second as any);
    expect(second.statusCode).toBe(200);
    expect(second.body.success).toBe(true);
    expect(provider.createCalls).toHaveLength(1);
    expect(provider.refunds).toHaveLength(1);
    expect(provider.cashMinor(intent)).toBe(2000);
    expect((await Booking.findById(booking!._id).lean() as any).payment.extraCostRefundPending)
      .toBeUndefined();
    const ledger = await readLedger(booking!._id);
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0]).toMatchObject({ kind: 'extra_cost', amount: 20 });
  });
});
