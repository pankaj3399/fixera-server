import express from 'express';
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
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_booking_details_boundaries';
});

const stripeMocks = vi.hoisted(() => ({
  refundCreate: vi.fn(),
  refundList: vi.fn(),
  refundRetrieve: vi.fn(),
  constructEvent: vi.fn(),
  transferCreate: vi.fn(),
  paymentIntentRetrieve: vi.fn(),
  paymentIntentCancel: vi.fn(),
  chargeRetrieve: vi.fn(),
}));

vi.mock('../../services/stripe', () => ({
  stripe: {
    refunds: {
      create: stripeMocks.refundCreate,
      list: stripeMocks.refundList,
      retrieve: stripeMocks.refundRetrieve,
    },
    webhooks: { constructEvent: stripeMocks.constructEvent },
    transfers: {
      createReversal: vi.fn(),
      create: stripeMocks.transferCreate,
    },
    paymentIntents: {
      create: vi.fn(),
      retrieve: stripeMocks.paymentIntentRetrieve,
      cancel: stripeMocks.paymentIntentCancel,
    },
    charges: { retrieve: stripeMocks.chargeRetrieve },
    balanceTransactions: { retrieve: vi.fn() },
  },
  STRIPE_CONFIG: {
    environment: 'test',
    defaultCurrency: 'EUR',
    supportedCurrencies: ['EUR', 'USD', 'GBP', 'CAD', 'AUD'],
    commissionPercent: 10,
    webhookSecret: 'whsec_test',
    frontendUrl: 'http://localhost:3000',
  },
}));

vi.mock('../../utils/notifications/notify', () => ({
  notify: vi.fn(async () => undefined),
  notifyAsync: vi.fn(),
}));

vi.mock('../../utils/notifications/notifyBookingCancelledAndRefunded', () => ({
  notifyBookingCancelledAndRefunded: vi.fn(),
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
      reverseCharge: false,
      vatLabel: 'VAT 21%',
    })),
    getQuotationTierRateOptionsFromConfig: vi.fn(async () => [
      { rate: 21, label: 'VAT 21%', country: 'BE' },
      { rate: 6, label: 'VAT 6%', country: 'BE' },
    ]),
    getVatRateOptionsFromConfig: vi.fn(async () => [
      { rate: 21, label: 'VAT 21%', country: 'BE' },
      { rate: 6, label: 'VAT 6%', country: 'BE' },
    ]),
    validateServiceCountryCoverage: vi.fn(async () => null),
  };
});

vi.mock('../../middlewares/auth', () => ({
  protect: async (req: any, res: any, next: any) => {
    const id = req.headers?.['x-test-user'];
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(401).json({ success: false, msg: 'No test user' });
    }
    const { default: User } = await import('../../models/user');
    const user = await User.findById(id);
    if (!user) return res.status(401).json({ success: false, msg: 'No test user' });
    req.user = user;
    next();
  },
  optionalProtect: (_req: any, _res: any, next: any) => next(),
  authMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

import Booking from '../../models/booking';
import Payment from '../../models/payment';
import Project from '../../models/project';
import User from '../../models/user';
import WarrantyClaim from '../../models/warrantyClaim';
import CancellationRequest from '../../models/cancellationRequest';
import {
  cancelBooking,
  createBooking,
  getBookingById,
  proceedAtStandardVatRate,
  submitPostBookingAnswers,
} from '../../handlers/Booking';
import { customerConfirmCompletion } from '../../handlers/Booking/completion';
import { getBookingActivity, getBookingDetails } from '../../handlers/Booking/details';
import {
  customerRespondToCounterOffer,
  professionalRespondToCancellation,
} from '../../handlers/Booking/refundNegotiation';
import { respondToQuoteWithPayment } from '../../handlers/Booking/payment-integration';
import {
  createDirectQuotation,
  customerRespondToQuotation,
  editQuotation,
  respondToRFQ,
} from '../../handlers/Quotation';
import { executeRefund } from '../../handlers/Stripe/payment';
import { handleWebhook } from '../../handlers/Stripe/webhooks';
import { runCompletionAutoAccept } from '../../utils/notifications/runCompletionAutoAccept';
import { notify, notifyAsync } from '../../utils/notifications/notify';
import { getAdminBookingDetail } from '../../handlers/Admin/bookingDetail';
import { SYSTEM_USER_ID } from '../../constants/system';
import bookingRouter from '../../routes/Booking';
import quotationRouter from '../../routes/Quotation';

const S3_BASE = 'https://fixera-uploads.s3.us-east-1.amazonaws.com';

const response = () => {
  const res: any = { statusCode: 200, body: undefined };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  res.send = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
};

/**
 * Provider-contract check for a charge.refunded fixture. Stripe can never
 * report more refunded than the original charge, nor a refund list whose
 * actual refunds exceed amount_refunded. Impossible fixtures fail the test
 * instead of silently proving arithmetic on a state production cannot reach.
 */
const providerCharge = (charge: any) => {
  const amount = Number(charge.amount);
  const refunded = Number(charge.amount_refunded);
  if (!(amount > 0) || !(refunded >= 0) || refunded > amount) {
    throw new Error(`Impossible provider charge: amount_refunded ${refunded} > amount ${amount}`);
  }
  const listed = Array.isArray(charge.refunds?.data)
    ? charge.refunds.data.filter((refund: any) => refund?.status !== 'failed' && refund?.status !== 'canceled')
    : [];
  const listedTotal = listed.reduce((sum: number, refund: any) => sum + Number(refund.amount || 0), 0);
  if (listedTotal > refunded + 0.01) {
    throw new Error(`Impossible provider charge: refund list ${listedTotal} > amount_refunded ${refunded}`);
  }
  if (listedTotal > amount + 0.01) {
    throw new Error(`Impossible provider charge: refund list ${listedTotal} > charge ${amount}`);
  }
  return charge;
};

/**
 * Local Stripe refund stub that enforces the real charge capacity and returns
 * the same refund for a replayed idempotency key. No network call.
 */
const installProviderRefundStub = (chargeMinorByIntent: Record<string, number>) => {
  const calls: Array<{ params: any; idempotencyKey?: string }> = [];
  const totals = new Map<string, number>();
  const byIdempotencyKey = new Map<string, any>();
  const refunds: any[] = [];
  stripeMocks.refundCreate.mockImplementation(async (params: any, options?: any) => {
    const idempotencyKey = options?.idempotencyKey;
    calls.push({ params, idempotencyKey });
    if (idempotencyKey && byIdempotencyKey.has(idempotencyKey)) {
      return byIdempotencyKey.get(idempotencyKey);
    }
    const capacity = chargeMinorByIntent[params.payment_intent];
    if (typeof capacity !== 'number') {
      throw new Error(`Provider stub has no charge for ${params.payment_intent}`);
    }
    const already = totals.get(params.payment_intent) || 0;
    const next = already + Number(params.amount);
    if (next > capacity) {
      throw new Error(
        `Provider rejected refund: ${next} minor exceeds charge ${capacity} for ${params.payment_intent}`,
      );
    }
    totals.set(params.payment_intent, next);
    const refund = {
      id: `re_provider_${calls.length}`,
      object: 'refund',
      amount: params.amount,
      currency: 'eur',
      payment_intent: params.payment_intent,
      charge: `ch_${params.payment_intent}`,
      status: 'succeeded',
      created: 1792454400 + calls.length,
      metadata: params.metadata,
    };
    refunds.push(refund);
    if (idempotencyKey) byIdempotencyKey.set(idempotencyKey, refund);
    return refund;
  });
  stripeMocks.refundList.mockImplementation(async (params: any = {}) => {
    const data = refunds
      .filter((refund) => !params.payment_intent || refund.payment_intent === params.payment_intent)
      .slice()
      .sort((left, right) => right.created - left.created);
    return { object: 'list', data, has_more: false, url: '/v1/refunds' };
  });
  stripeMocks.refundRetrieve.mockImplementation(async (id: string) => {
    const refund = refunds.find((entry) => entry.id === id);
    if (!refund) throw new Error(`No such refund: ${id}`);
    return refund;
  });
  return { calls, totals, byIdempotencyKey, refunds };
};

const request = (overrides: Record<string, any> = {}) => ({
  params: {},
  body: {},
  headers: {},
  ...overrides,
});

let customerId: Types.ObjectId;
let professionalId: Types.ObjectId;
let otherCustomerId: Types.ObjectId;
let marketingAdminId: Types.ObjectId;
let financeAdminId: Types.ObjectId;
let operationsAdminId: Types.ObjectId;
let projectId: Types.ObjectId;

const projectUploadUrl = (project: any, uploader: any, name = 'proof.pdf') =>
  `${S3_BASE}/projects/${project}/attachment/${uploader}/${name}`;

const createUser = async (overrides: Record<string, any>) => {
  const suffix = new Types.ObjectId().toString();
  return User.create({
    name: overrides.name || `User ${suffix}`,
    email: overrides.email || `user-${suffix}@example.com`,
    phone: overrides.phone || `+32${suffix.slice(-9)}`,
    password: 'hashed-password',
    role: 'customer',
    accountStatus: 'active',
    location: {
      type: 'Point',
      coordinates: [4.35, 50.85],
      address: 'Main street 1',
      city: 'Brussels',
      country: 'BE',
      postalCode: '1000',
    },
    ...overrides,
  });
};

const createProject = async (overrides: Record<string, any> = {}) => {
  const id = new Types.ObjectId();
  await mongoose.connection.collection('projects').insertOne({
    _id: id,
    title: 'Bathroom renovation',
    description: 'Full bathroom renovation',
    category: 'Renovation',
    service: 'Bathroom',
    areaOfWork: 'Interior',
    status: 'published',
    professionalId,
    resources: [professionalId],
    distance: { countryCode: 'BE', maxKmRange: 25 },
    media: { images: [] },
    subprojects: [{
      _id: new Types.ObjectId(),
      name: 'Standard package',
      description: 'Standard work',
      projectType: ['renovation'],
      pricing: { type: 'rfq' },
      included: [],
      materialsIncluded: false,
      materials: [],
      preparationDuration: { value: 1, unit: 'days' },
      executionDuration: { value: 2, unit: 'days' },
      buffer: { value: 1, unit: 'days' },
      warrantyPeriod: { value: 2, years: 2, unit: 'years' },
    }],
    rfqQuestions: [{
      _id: 'rfq-file',
      question: 'Upload a plan',
      type: 'attachment',
      isRequired: false,
    }],
    postBookingQuestions: [{
      _id: 'post-file',
      question: 'Upload access proof',
      type: 'attachment',
      isRequired: true,
    }],
    extraOptions: [],
    termsConditions: [],
    services: [{ category: 'Renovation', service: 'Bathroom', areaOfWork: 'Interior' }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });
  return Project.findById(id);
};

const createBookingDoc = async (overrides: Record<string, any> = {}) => {
  const project = overrides.projectId ? { _id: overrides.projectId } : {};
  const data: any = {
    customer: customerId,
    professional: professionalId,
    project: project._id || projectId,
    bookingType: 'project',
    status: 'booked',
    location: {
      type: 'Point',
      coordinates: [4.35, 50.85],
      address: 'Main street 1',
      city: 'Brussels',
      country: 'BE',
      postalCode: '1000',
    },
    rfqData: {
      serviceType: 'Bathroom',
      description: 'Need a bathroom',
      answers: [{
        questionId: 'rfq-file',
        question: 'Upload a plan',
        answer: projectUploadUrl(projectId, customerId, 'plan.pdf'),
        fieldType: 'file',
      }],
    },
    quote: { amount: 100, currency: 'EUR', description: 'Quote' },
    vatDecision: {
      action: 'standard_rate',
      country: 'BE',
      standardRate: 21,
      appliedRate: 21,
      answers: [],
    },
    quoteVersions: [],
    currentQuoteVersion: undefined,
    selectedSubprojectIndex: 0,
    statusHistory: [{
      status: 'rfq',
      timestamp: new Date('2026-01-10T09:00:00.000Z'),
      updatedBy: customerId,
      note: 'Booking created',
    }, {
      status: 'booked',
      timestamp: new Date('2026-01-12T09:00:00.000Z'),
      note: 'Payment confirmed',
    }],
    postBookingData: [],
    extraCosts: [],
    createdAt: new Date('2026-01-10T09:00:00.000Z'),
    updatedAt: new Date('2026-01-12T09:00:00.000Z'),
    ...overrides,
  };
  delete data.projectId;
  const booking = await Booking.create(data);
  return Booking.findById(booking._id);
};

const createPayment = async (booking: any, overrides: Record<string, any> = {}) => Payment.create({
  booking: booking._id,
  bookingNumber: booking.bookingNumber,
  customer: customerId,
  professional: professionalId,
  status: 'completed',
  currency: 'EUR',
  amount: 100,
  netAmount: 100,
  vatAmount: 20,
  vatRate: 20,
  totalWithVat: 120,
  stripePaymentIntentId: overrides.stripePaymentIntentId || `pi_${new Types.ObjectId()}`,
  refunds: [],
  ...overrides,
});

const seedCompletionBooking = async (params: {
  suffix: string;
  status?: string;
  payment?: Record<string, any>;
  extraCosts?: any[];
  extraCostTotal?: number;
}) => {
  const suffix = params.suffix;
  return createBookingDoc({
    status: params.status || 'professional_completed',
    professionalCompletedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
    payment: {
      status: 'authorized',
      currency: 'EUR',
      amount: 100,
      netAmount: 100,
      vatAmount: 20,
      vatRate: 20,
      totalWithVat: 120,
      professionalPayout: 80,
      stripePaymentIntentId: `pi_${suffix}`,
      stripeChargeId: `ch_${suffix}`,
      ...(params.payment || {}),
    },
    extraCosts: params.extraCosts ?? [
      { type: 'other', name: 'Waste', justification: 'Less waste', amount: -20 },
    ],
    extraCostTotal: params.extraCostTotal ?? -20,
  });
};

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

const quoteVersion = (overrides: Record<string, any> = {}) => ({
  version: 1,
  quotationNumber: 'QT-2026-000001-v1',
  scope: 'Bathroom renovation',
  warrantyDuration: { value: 2, unit: 'years' },
  materialsIncluded: false,
  materials: [],
  description: 'Full scope',
  pricingLines: [{ description: 'Work', price: 100, vatRate: 21 }],
  totalAmount: 100,
  currency: 'EUR',
  milestones: [],
  preparationDuration: { value: 1, unit: 'days' },
  executionDuration: { value: 2, unit: 'days' },
  validUntil: new Date('2026-03-01T00:00:00.000Z'),
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  ...overrides,
});

const editQuotationBody = (overrides: Record<string, any> = {}) => ({
  scope: 'Bathroom renovation v2',
  warrantyDuration: { value: 2, unit: 'years' },
  materialsIncluded: false,
  materials: [],
  description: 'Full scope v2',
  totalAmount: 100,
  pricingLines: [{ description: 'Work', price: 100, vatRate: 21 }],
  currency: 'EUR',
  milestones: [],
  preparationDuration: { value: 1, unit: 'days' },
  executionDuration: { value: 2, unit: 'days' },
  validUntil: '2026-03-02T00:00:00.000Z',
  changeNote: 'Adjusted after rejection',
  ...overrides,
});

const getJson = async (url: string, userId: any) => {
  const response = await fetch(url, { headers: { 'x-test-user': String(userId) } });
  return { status: response.status, body: await response.json() };
};

describeDb('booking details write/read boundaries (disposable Mongo)', () => {
  let app: express.Express;
  let server: any;
  let baseUrl: string;

  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: 'fixera_booking_details_boundaries_test' });
    app = express();
    app.use(express.json());
    app.use('/api/bookings', bookingRouter);
    app.use('/api/quotations', quotationRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    stripeMocks.refundList.mockReset();
    stripeMocks.refundList.mockResolvedValue({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/refunds',
    });
    stripeMocks.refundRetrieve.mockReset();
    await Promise.all([
      Booking.deleteMany({}),
      Payment.deleteMany({}),
      Project.deleteMany({}),
      User.deleteMany({}),
      WarrantyClaim.deleteMany({}),
      CancellationRequest.deleteMany({}),
      mongoose.connection.collection('stripeevents').deleteMany({}),
      mongoose.connection.collection('counters').deleteMany({}),
    ]);
    customerId = (await createUser({ role: 'customer', name: 'Carla Customer' }))._id;
    professionalId = (await createUser({
      role: 'professional',
      name: 'Piet Professional',
      professionalStatus: 'approved',
    }))._id;
    otherCustomerId = (await createUser({ role: 'customer', name: 'Other Customer' }))._id;
    marketingAdminId = (await createUser({
      role: 'admin',
      adminRole: 'marketing',
      name: 'Mia Marketing',
    }))._id;
    financeAdminId = (await createUser({
      role: 'admin',
      adminRole: 'finance',
      name: 'Finn Finance',
    }))._id;
    operationsAdminId = (await createUser({
      role: 'admin',
      adminRole: 'operations',
      name: 'Olga Operations',
    }))._id;
    projectId = (await createProject())._id;
  });

  it('accepts a legitimate project-upload RFQ file answer on create and signs it for both parties', async () => {
    const upload = projectUploadUrl(projectId, customerId, 'plan.pdf');
    const res = response();
    await createBooking(request({
      body: {
        bookingType: 'project',
        projectId: String(projectId),
        selectedSubprojectIndex: 0,
        rfqData: {
          serviceType: 'Bathroom',
          description: 'Need a bathroom',
          answers: [{
            questionId: 'rfq-file',
            question: 'Upload a plan',
            answer: upload,
            fieldType: 'file',
          }],
          attachments: [],
        },
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, res as any, vi.fn() as any);

    expect(res.statusCode).toBe(201);
    const stored = await Booking.findOne({ customer: customerId }).lean() as any;
    expect(stored.rfqData.answers[0].answer).toBe(upload);

    const customerDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(stored._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, customerDetails as any, vi.fn() as any);
    expect(customerDetails.statusCode).toBe(200);
    expect(customerDetails.body.data.wizard.rfq.answers[0].answer).toContain('X-Amz-Signature=');
    expect(customerDetails.body.data.wizard.rfqQuestions[0].answered).toBe(true);

    const professionalDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(stored._id) },
      user: { _id: professionalId, role: 'professional' },
    }) as any, professionalDetails as any, vi.fn() as any);
    expect(professionalDetails.statusCode).toBe(200);
    expect(professionalDetails.body.data.wizard.rfq.answers[0].answer).toContain('X-Amz-Signature=');

    const original = response();
    await getBookingById(request({
      params: { bookingId: String(stored._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, original as any, vi.fn() as any);
    expect(original.statusCode).toBe(200);
    expect(original.body.booking.rfqData.answers[0].answer).toContain('X-Amz-Signature=');
    expect(JSON.stringify(original.body.booking)).not.toContain(
      `projects/${projectId}/attachment/${customerId}/plan.pdf"`,
    );
  });

  it('rejects a project file answer for another project or uploader and never stores it', async () => {
    const otherProject = new Types.ObjectId();
    const res = response();
    await createBooking(request({
      body: {
        bookingType: 'project',
        projectId: String(projectId),
        selectedSubprojectIndex: 0,
        rfqData: {
          serviceType: 'Bathroom',
          description: 'Need a bathroom',
          answers: [{
            questionId: 'rfq-file',
            question: 'Upload a plan',
            answer: projectUploadUrl(otherProject, customerId, 'forged.pdf'),
            fieldType: 'file',
          }],
          attachments: [],
        },
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, res as any, vi.fn() as any);

    expect(res.statusCode).toBe(400);
    expect(await Booking.countDocuments({})).toBe(0);
  });

  it('stores and shows post-booking project uploads, rejects forged ownership, and hides raw keys', async () => {
    const booking = await createBookingDoc({ postBookingData: [] });
    const upload = projectUploadUrl(projectId, customerId, 'access-proof.pdf');

    const res = response();
    await submitPostBookingAnswers(request({
      params: { bookingId: String(booking!._id) },
      body: {
        answers: [{
          questionId: 'post-file',
          question: 'Upload access proof',
          answer: upload,
        }],
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, res as any, vi.fn() as any);
    expect(res.statusCode).toBe(200);

    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.postBookingData[0].answer).toBe(upload);
    expect(stored.postBookingSubmittedBy.toString()).toBe(String(customerId));

    const customerDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, customerDetails as any, vi.fn() as any);
    expect(customerDetails.body.data.postBooking.answers[0].answer).toContain('X-Amz-Signature=');
    expect(customerDetails.body.data.postBooking.questions[0].answered).toBe(true);

    const professionalDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: professionalId, role: 'professional' },
    }) as any, professionalDetails as any, vi.fn() as any);
    expect(professionalDetails.body.data.postBooking.answers[0].answer).toContain('X-Amz-Signature=');

    const forgedBooking = await createBookingDoc({ postBookingData: [] });
    const forged = response();
    await submitPostBookingAnswers(request({
      params: { bookingId: String(forgedBooking!._id) },
      body: {
        answers: [{
          questionId: 'post-file',
          question: 'Upload access proof',
          answer: projectUploadUrl(projectId, otherCustomerId, 'forged.pdf'),
        }],
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, forged as any, vi.fn() as any);
    expect(forged.statusCode).toBe(400);
    expect((await Booking.findById(forgedBooking!._id).lean() as any).postBookingData).toHaveLength(0);

    // The original booking DTO must not fall back to the raw key when a stored
    // answer is unowned/unsigned.
    await Booking.updateOne(
      { _id: booking!._id },
      { $set: { 'postBookingData.0.answer': projectUploadUrl(projectId, otherCustomerId, 'legacy.pdf') } },
    );
    const original = response();
    await getBookingById(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, original as any, vi.fn() as any);
    expect(original.statusCode).toBe(200);
    expect(JSON.stringify(original.body.booking)).not.toContain('legacy.pdf');
    expect(original.body.booking.postBookingData[0].answer).toBe('');
  });

  it('keeps post-booking questions created after booking out of the captured snapshot and records their own provenance', async () => {
    const lateQuestionOne = new Types.ObjectId();
    const lateQuestionTwo = new Types.ObjectId();
    await Project.updateOne(
      { _id: projectId },
      { $set: { postBookingQuestions: [] } },
    );
    const created = response();
    await createBooking(request({
      body: {
        bookingType: 'project',
        projectId: String(projectId),
        selectedSubprojectIndex: 0,
        rfqData: {
          serviceType: 'Bathroom',
          description: 'Need a bathroom',
          answers: [{
            questionId: 'rfq-file',
            question: 'Upload a plan',
            answer: projectUploadUrl(projectId, customerId, 'plan.pdf'),
            fieldType: 'file',
          }],
          attachments: [],
        },
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, created as any, vi.fn() as any);
    expect(created.statusCode).toBe(201);
    const booking = await Booking.findById(created.body.booking._id);

    // Captured at booking time: there was no post-booking section.
    expect(booking!.bookingSnapshot?.questions?.postBooking).toBeUndefined();

    // The professional adds questions later. The snapshot must stay untouched.
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          postBookingQuestions: [
            { _id: lateQuestionOne, question: 'Parking available?', type: 'text', isRequired: false },
            { _id: lateQuestionTwo, question: 'Pets present?', type: 'text', isRequired: false },
          ],
        },
      },
    );

    const submit = response();
    await submitPostBookingAnswers(request({
      params: { bookingId: String(booking!._id) },
      body: {
        answers: [
          { questionId: String(lateQuestionOne), question: 'Parking available?', answer: '0' },
          { questionId: String(lateQuestionTwo), question: 'Pets present?', answer: 'false' },
        ],
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, submit as any, vi.fn() as any);
    expect(submit.statusCode).toBe(200);

    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.bookingSnapshot.questions?.postBooking).toBeUndefined();
    expect(stored.postBookingQuestionSnapshot).toMatchObject({
      source: 'post_booking_submission',
      questions: [
        { questionId: String(lateQuestionOne), question: 'Parking available?' },
        { questionId: String(lateQuestionTwo), question: 'Pets present?' },
      ],
    });
    expect(stored.postBookingData.map((answer: any) => answer.answer)).toEqual(['0', 'false']);

    // A later live wording change must not rewrite what was answered.
    await Project.updateOne(
      { _id: projectId },
      { $set: { 'postBookingQuestions.0.question': 'Where do you park now?' } },
    );
    const details = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, details as any, vi.fn() as any);
    expect(details.statusCode).toBe(200);
    expect(details.body.data.bookingSnapshot.questions.postBooking).toEqual([]);
    expect(details.body.data.postBooking.questions.map((question: any) => ({
      source: question.source,
      question: question.question,
      answer: question.answer,
    }))).toEqual([
      { source: 'post_booking_submission', question: 'Parking available?', answer: '0' },
      { source: 'post_booking_submission', question: 'Pets present?', answer: 'false' },
    ]);

    // An answer whose definition no longer survives is still returned, with an
    // explicit recorded-answer provenance instead of invented live wording.
    const orphan = await createBookingDoc({ postBookingData: [] });
    await Booking.updateOne(
      { _id: orphan!._id },
      {
        $set: {
          postBookingData: [{
            questionId: 'removed-question',
            question: 'Old question wording',
            answer: 'kept',
            options: ['kept', 'other'],
          }],
          postBookingSubmittedAt: new Date('2026-02-06T10:00:00.000Z'),
          postBookingSubmittedBy: customerId,
        },
      },
    );
    const orphanDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(orphan!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, orphanDetails as any, vi.fn() as any);
    expect(orphanDetails.statusCode).toBe(200);
    const orphanQuestion = orphanDetails.body.data.postBooking.questions.find(
      (question: any) => question.source === 'recorded_answer',
    );
    expect(orphanQuestion).toMatchObject({
      questionId: 'removed-question',
      question: 'Old question wording',
      answer: 'kept',
      answered: true,
      source: 'recorded_answer',
      options: ['kept', 'other'],
    });
  });

  it('rejects answers that do not belong to the authoritative post-booking questions', async () => {
    const authoritativeQuestion = new Types.ObjectId();
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          postBookingQuestions: [
            { _id: authoritativeQuestion, question: 'Access notes?', type: 'text', isRequired: false },
          ],
        },
      },
    );
    const booking = await createBookingDoc({ postBookingData: [] });
    const forged = response();
    await submitPostBookingAnswers(request({
      params: { bookingId: String(booking!._id) },
      body: {
        answers: [{
          questionId: 'not-a-project-question',
          question: 'Injected question?',
          answer: 'injected',
        }],
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, forged as any, vi.fn() as any);
    expect(forged.statusCode).toBe(400);
    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.postBookingData).toHaveLength(0);
    expect(stored.postBookingQuestionSnapshot).toBeUndefined();

    const matched = response();
    await submitPostBookingAnswers(request({
      params: { bookingId: String(booking!._id) },
      body: {
        answers: [{
          questionId: String(authoritativeQuestion),
          question: 'Tampered wording',
          answer: 'Use the side gate',
        }],
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, matched as any, vi.fn() as any);
    expect(matched.statusCode).toBe(200);
    const storedMatched = await Booking.findById(booking!._id).lean() as any;
    expect(storedMatched.postBookingData[0]).toMatchObject({
      questionId: String(authoritativeQuestion),
      question: 'Access notes?',
      answer: 'Use the side gate',
    });
  });

  it('records a schedule timezone only when the client actually sends one', async () => {
    await User.updateOne(
      { _id: professionalId },
      { $set: { 'businessInfo.timezone': 'Europe/Brussels' } },
    );
    const body = {
      bookingType: 'project',
      projectId: String(projectId),
      selectedSubprojectIndex: 0,
      rfqData: {
        serviceType: 'Bathroom',
        description: 'Need a bathroom',
        answers: [],
        attachments: [],
      },
    };

    // The existing frontend schedule/booking body sends no timeZone. The
    // professional's current profile zone is not a recorded customer choice.
    const withoutZone = response();
    await createBooking(request({
      body,
      user: { _id: customerId, role: 'customer' },
    }) as any, withoutZone as any, vi.fn() as any);
    expect(withoutZone.statusCode).toBe(201);
    const first = await Booking.findById(withoutZone.body.booking._id).lean() as any;
    expect(first.scheduleTimeZone).toBeUndefined();
    expect(first.bookingSnapshot.schedule?.timeZone).toBeUndefined();

    const firstDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(first._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, firstDetails as any, vi.fn() as any);
    expect(firstDetails.body.data.booking.schedule.timeZone).toBeNull();
    expect(firstDetails.body.data.booking.schedule.timeZoneRecorded).toBe(false);

    const withZone = response();
    await createBooking(request({
      body: { ...body, timeZone: 'Europe/Paris' },
      user: { _id: customerId, role: 'customer' },
    }) as any, withZone as any, vi.fn() as any);
    expect(withZone.statusCode).toBe(201);
    const second = await Booking.findById(withZone.body.booking._id).lean() as any;
    expect(second.scheduleTimeZone).toBe('Europe/Paris');
    expect(second.bookingSnapshot.schedule?.timeZone).toBe('Europe/Paris');

    const secondDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(second._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, secondDetails as any, vi.fn() as any);
    expect(secondDetails.body.data.booking.schedule.timeZone).toBe('Europe/Paris');
    expect(secondDetails.body.data.booking.schedule.timeZoneRecorded).toBe(true);
  });

  it('enforces bookings.read for every details/activity alias and gates limited admin areas', async () => {
    const booking = await createBookingDoc({
      payment: {
        status: 'completed',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_rbac_raw',
        stripeClientSecret: 'pi_rbac_raw_secret',
        metadata: { providerError: 'internal' },
        invoiceNumber: 'FIX-RAW-1',
        invoiceUrl: 'https://example.test/FIX-RAW-1.pdf',
        refunds: [{
          amount: 10,
          refundId: 're_rbac_raw',
          refundedAt: new Date('2026-02-03T00:00:00.000Z'),
          source: 'platform',
          notes: 'internal refund note',
        }],
      },
    });
    await createPayment(booking, { stripePaymentIntentId: 'pi_rbac_raw' });
    await CancellationRequest.create({
      booking: booking!._id,
      requestedBy: customerId,
      requestedRole: 'customer',
      reasonCategory: 'scheduling_conflict',
      reason: 'Cannot make the date',
      status: 'pending',
      evidence: [],
    });
    await WarrantyClaim.create({
      booking: booking!._id,
      customer: customerId,
      professional: professionalId,
      claimNumber: 'WC-2026-000001',
      status: 'open',
      reason: 'defect',
      description: 'Water leak',
      evidence: [],
      warrantyEndsAt: new Date('2027-01-01T00:00:00.000Z'),
      openedAt: new Date('2026-02-01T00:00:00.000Z'),
      statusHistory: [],
    });
    await Booking.updateOne(
      { _id: booking!._id },
      {
        $set: {
          notes: 'INTERNAL BOOKING NOTE',
          dispute: {
            type: 'reschedule',
            reason: 'Date changed',
            description: 'Wrong date',
            raisedAt: new Date('2026-02-02T00:00:00.000Z'),
            raisedBy: customerId,
            resolution: 'INTERNAL DISPUTE RESOLUTION',
            resolvedBy: marketingAdminId,
            resolvedAt: new Date('2026-02-04T00:00:00.000Z'),
            adminAdjustedAmount: 5,
            attachments: [
              `${S3_BASE}/dispute-attachments/${customerId}/evidence.pdf`,
              `${S3_BASE}/dispute-attachments/${otherCustomerId}/forged.pdf`,
            ],
          },
        },
      },
    );

    for (const path of [
      `/api/bookings/${booking!._id}/details`,
      `/api/bookings/${booking!._id}/activity`,
      `/api/quotations/${booking!._id}/details`,
    ]) {
      const marketing = await getJson(`${baseUrl}${path}`, marketingAdminId);
      expect(marketing.status).toBe(403);
    }

    const financeDetails = await getJson(`${baseUrl}/api/bookings/${booking!._id}/details`, financeAdminId);
    expect(financeDetails.status).toBe(200);
    const details = financeDetails.body.data;
    expect(details.internal.notes).toBe('INTERNAL BOOKING NOTE');
    expect(details.internal.diagnostics.payment).toBeDefined();
    expect(details.cancellations).toEqual([]);
    expect(details.warrantyClaims).toEqual([]);
    expect(details.extraCosts.dispute).toBeNull();
    expect(details.payments.records[0].providerIds).toBeDefined();
    expect(details.payments.records[0].diagnostics).toBeDefined();
    expect(details.activity.items.some((item: any) => item.category === 'cancellation')).toBe(false);
    expect(details.activity.items.some((item: any) => item.category === 'warranty')).toBe(false);
    expect(details.activity.items.some((item: any) => item.category === 'dispute')).toBe(false);

    const financeActivity = await getJson(`${baseUrl}/api/bookings/${booking!._id}/activity`, financeAdminId);
    expect(financeActivity.status).toBe(200);
    expect(financeActivity.body.data.items.some((item: any) => item.category === 'cancellation')).toBe(false);

    // Operations has bookings.read and warranty but no payments/disputes/
    // cancellations: payment internals and cancellation/dispute data stay out.
    const operationsDetails = await getJson(`${baseUrl}/api/bookings/${booking!._id}/details`, operationsAdminId);
    expect(operationsDetails.status).toBe(200);
    expect(operationsDetails.body.data.internal.notes).toBe('INTERNAL BOOKING NOTE');
    expect(operationsDetails.body.data.internal.diagnostics.payment).toBeUndefined();
    expect(operationsDetails.body.data.payments.records[0].providerIds).toBeUndefined();
    expect(operationsDetails.body.data.payments.records[0].diagnostics).toBeUndefined();
    expect(operationsDetails.body.data.cancellations).toEqual([]);
    expect(operationsDetails.body.data.warrantyClaims).toHaveLength(1);
    expect(operationsDetails.body.data.extraCosts.dispute).toBeNull();
    expect(operationsDetails.body.data.activity.items.some((item: any) => item.category === 'cancellation')).toBe(false);
    expect(operationsDetails.body.data.activity.items.some((item: any) => item.category === 'dispute')).toBe(false);
    expect(operationsDetails.body.data.activity.items.some((item: any) => item.category === 'warranty')).toBe(true);

    // The canonical legacy route now enforces the same effective bookings.read
    // instead of leaking the raw booking to every admin role.
    const marketingCanonical = await getJson(`${baseUrl}/api/bookings/${booking!._id}`, marketingAdminId);
    expect(marketingCanonical.status).toBe(403);

    const financeCanonical = await getJson(`${baseUrl}/api/bookings/${booking!._id}`, financeAdminId);
    expect(financeCanonical.status).toBe(200);
    expect(financeCanonical.body.booking.notes).toBe('INTERNAL BOOKING NOTE');
    expect(financeCanonical.body.booking.dispute).toBeUndefined();
    expect(financeCanonical.body.booking.cancellation).toBeUndefined();
    expect(financeCanonical.body.booking.payment.stripePaymentIntentId).toBeDefined();
    expect(financeCanonical.body.details.internal.notes).toBe('INTERNAL BOOKING NOTE');

    const operationsCanonical = await getJson(`${baseUrl}/api/bookings/${booking!._id}`, operationsAdminId);
    expect(operationsCanonical.status).toBe(200);
    expect(operationsCanonical.body.booking.dispute).toBeUndefined();
    expect(operationsCanonical.body.booking.payment.stripePaymentIntentId).toBeUndefined();
    expect(operationsCanonical.body.booking.payment.stripeClientSecret).toBeUndefined();
    expect(operationsCanonical.body.booking.payment.refunds?.[0]?.refundId).toBeUndefined();
    expect(operationsCanonical.body.booking.payment.metadata).toBeUndefined();
    expect(operationsCanonical.body.booking.payment.invoiceNumber).toBeUndefined();
    expect(operationsCanonical.body.details.payments.records[0].providerIds).toBeUndefined();
    expect(operationsCanonical.body.details.payments.records[0].invoice).toBeNull();

    const customerCanonical = await getJson(`${baseUrl}/api/bookings/${booking!._id}`, customerId);
    expect(customerCanonical.status).toBe(200);
    expect(customerCanonical.body.booking.notes).toBeUndefined();
    expect(customerCanonical.body.booking.dispute.resolution).toBeUndefined();
    expect(customerCanonical.body.booking.dispute.resolvedBy).toBeUndefined();
    expect(customerCanonical.body.booking.dispute.adminAdjustedAmount).toBeUndefined();
    expect(customerCanonical.body.booking.dispute.attachments).toHaveLength(1);
    expect(customerCanonical.body.booking.dispute.attachments[0]).toContain('X-Amz-Signature=');
    expect(JSON.stringify(customerCanonical.body.booking.dispute.attachments))
      .not.toContain(`dispute-attachments/${otherCustomerId}`);
    // Participant provider ids/metadata are stripped; the customer keeps only
    // their own client secret for the existing payment page.
    expect(customerCanonical.body.booking.payment.stripePaymentIntentId).toBeUndefined();
    expect(customerCanonical.body.booking.payment.metadata).toBeUndefined();
    expect(customerCanonical.body.booking.payment.stripeClientSecret).toBe('pi_rbac_raw_secret');
    expect(customerCanonical.body.booking.payment.invoiceNumber).toBe('FIX-RAW-1');

    // Admin full is a real persisted read: areas without permission are
    // omitted from both the raw fields and the additive details payload.
    const financeFull = response();
    await getAdminBookingDetail(request({
      params: { id: String(booking!._id) },
      user: { _id: financeAdminId, role: 'admin', adminRole: 'finance' },
    }) as any, financeFull as any);
    expect(financeFull.statusCode).toBe(200);
    expect(financeFull.body.data.payment).not.toBeNull();
    expect(financeFull.body.data.cancellationRequests).toEqual([]);
    expect(financeFull.body.data.booking.dispute).toBeUndefined();
    expect(financeFull.body.data.booking.cancellation).toBeUndefined();
    expect(financeFull.body.data.details.cancellations).toEqual([]);
    expect(financeFull.body.data.details.warrantyClaims).toEqual([]);

    const operationsFull = response();
    await getAdminBookingDetail(request({
      params: { id: String(booking!._id) },
      user: { _id: operationsAdminId, role: 'admin', adminRole: 'operations' },
    }) as any, operationsFull as any);
    expect(operationsFull.statusCode).toBe(200);
    expect(operationsFull.body.data.payment).toBeNull();
    expect(operationsFull.body.data.cancellationRequests).toEqual([]);
    expect(operationsFull.body.data.booking.payment.stripePaymentIntentId).toBeUndefined();
    expect(operationsFull.body.data.details.warrantyClaims).toHaveLength(1);
    expect(operationsFull.body.data.details.payments.records[0].providerIds).toBeUndefined();

    const marketingFull = response();
    await getAdminBookingDetail(request({
      params: { id: String(booking!._id) },
      user: { _id: marketingAdminId, role: 'admin', adminRole: 'marketing' },
    }) as any, marketingFull as any);
    expect(marketingFull.statusCode).toBe(403);
  });

  it('keeps negative extra-cost refunds out of booking status/totals and dedupes webhook replays', async () => {
    const booking = await createBookingDoc({
      status: 'completed',
      payment: {
        status: 'completed',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_extra_refund_test',
      },
      extraCosts: [{ type: 'other', name: 'Waste', justification: 'Extra', amount: -20 }],
      extraCostTotal: -20,
    });
    const payment = await createPayment(booking, { stripePaymentIntentId: 'pi_extra_refund_test' });

    const charge = {
      id: 'ch_extra_refund_test',
      payment_intent: 'pi_extra_refund_test',
      currency: 'eur',
      amount: 12000,
      amount_refunded: 2000,
      refunds: {
        data: [{
          id: 're_extra_refund_test',
          amount: 2000,
          created: 1792454400,
          metadata: { refundKind: 'extra_cost' },
        }],
      },
    };
    stripeMocks.constructEvent.mockReturnValue({
      id: 'evt_extra_refund_1',
      type: 'charge.refunded',
      created: 1792454400,
      data: { object: charge },
    });
    const res = response();
    await handleWebhook(request({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    }) as any, res as any);

    expect(res.body).toEqual({ received: true });
    const afterExtra = await Booking.findById(booking!._id).lean() as any;
    expect(afterExtra.status).toBe('completed');
    expect(afterExtra.payment.status).toBe('completed');
    expect(afterExtra.payment.refundAmount ?? 0).toBe(0);
    const paymentAfterExtra = await Payment.findById(payment._id).lean() as any;
    expect(paymentAfterExtra.refunds).toHaveLength(1);
    expect(paymentAfterExtra.refunds[0]).toMatchObject({
      refundId: 're_extra_refund_test',
      amount: 20,
      kind: 'extra_cost',
    });

    // Duplicate delivery with a different event id must not append the row again.
    stripeMocks.constructEvent.mockReturnValue({
      id: 'evt_extra_refund_2',
      type: 'charge.refunded',
      created: 1792454401,
      data: { object: charge },
    });
    await handleWebhook(request({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    }) as any, response() as any);
    const afterReplay = await Payment.findById(payment._id).lean() as any;
    expect(afterReplay.refunds).toHaveLength(1);

    // A later real booking refund is counted without the extra-cost amount.
    // amount_refunded 12000 is the actual 120 charge: 20 extra + 100 booking.
    stripeMocks.constructEvent.mockReturnValue({
      id: 'evt_booking_refund',
      type: 'charge.refunded',
      created: 1792454402,
      data: {
        object: providerCharge({
          ...charge,
          amount_refunded: 12000,
          refunds: {
            data: [
              charge.refunds.data[0],
              { id: 're_booking_refund', amount: 10000, created: 1792454402, metadata: { refundKind: 'booking' } },
            ],
          },
        }),
      },
    });
    await handleWebhook(request({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    }) as any, response() as any);
    const afterBookingRefund = await Booking.findById(booking!._id).lean() as any;
    expect(afterBookingRefund.status).toBe('completed');
    expect(afterBookingRefund.payment.status).toBe('partially_refunded');
    expect(afterBookingRefund.payment.refundAmount).toBe(100);
    const paymentAfterBooking = await Payment.findById(payment._id).lean() as any;
    expect(paymentAfterBooking.refunds.map((refund: any) => refund.kind).sort()).toEqual(['booking', 'extra_cost']);
    expect(paymentAfterBooking.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(120);
  });

  it('uses only authoritative recorded splits for a final partial refund', async () => {
    const booking = await createBookingDoc({
      status: 'completed',
      payment: {
        status: 'partially_refunded',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_partial_refund_test',
      },
    });
    const payment = await createPayment(booking, {
      status: 'partially_refunded',
      stripePaymentIntentId: 'pi_partial_refund_test',
      refunds: [{
        amount: 40,
        reason: 'Earlier partial',
        refundId: 're_earlier_unknown',
        refundedAt: new Date('2026-02-01T00:00:00.000Z'),
        source: 'platform',
      }],
    });
    stripeMocks.refundCreate.mockResolvedValue({ id: 're_final_unknown', status: 'succeeded' });

    const refunded = await executeRefund(String(booking!._id), { amount: 80, reason: 'Final refund' });
    expect(refunded.amount).toBe(80);
    const afterUnknown = await Payment.findById(payment._id).lean() as any;
    const finalUnknown = afterUnknown.refunds.find((refund: any) => refund.refundId === 're_final_unknown');
    expect(finalUnknown).toMatchObject({ amount: 80 });
    expect(finalUnknown.netAmount).toBeUndefined();
    expect(finalUnknown.vatAmount).toBeUndefined();

    // A historical aggregate-only refund (no per-refund row) still reduces
    // the refundable remainder; it cannot be refunded again.
    const aggregateOnlyBooking = await createBookingDoc({
      status: 'completed',
      payment: {
        status: 'partially_refunded',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_partial_refund_aggregate',
        refundAmount: 40,
        refundedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
    });
    await createPayment(aggregateOnlyBooking, {
      status: 'partially_refunded',
      stripePaymentIntentId: 'pi_partial_refund_aggregate',
      refunds: [],
    });
    await expect(
      executeRefund(String(aggregateOnlyBooking!._id), { amount: 100, reason: 'Too much' }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_TOTAL' });

    const splitBooking = await createBookingDoc({
      status: 'completed',
      payment: {
        status: 'partially_refunded',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_partial_refund_split',
      },
    });
    const splitPayment = await createPayment(splitBooking, {
      status: 'partially_refunded',
      stripePaymentIntentId: 'pi_partial_refund_split',
      refunds: [{
        amount: 40,
        reason: 'Earlier partial',
        refundId: 're_earlier_known',
        refundedAt: new Date('2026-02-01T00:00:00.000Z'),
        source: 'platform',
        netAmount: 33.33,
        vatAmount: 6.67,
        vatRate: 20,
      }],
    });
    stripeMocks.refundCreate.mockResolvedValue({ id: 're_final_known', status: 'succeeded' });
    await executeRefund(String(splitBooking!._id), { amount: 80, reason: 'Final refund' });
    const afterKnown = await Payment.findById(splitPayment._id).lean() as any;
    const finalKnown = afterKnown.refunds.find((refund: any) => refund.refundId === 're_final_known');
    expect(finalKnown).toMatchObject({ amount: 80, netAmount: 66.67, vatAmount: 13.33, vatRate: 20 });
  });

  it('records legacy /respond acceptance and rejection with actor/time and is retry-safe', async () => {
    const version = {
      version: 1,
      quotationNumber: 'QT-2026-000001-v1',
      scope: 'Bathroom renovation',
      warrantyDuration: { value: 2, unit: 'years' },
      materialsIncluded: false,
      materials: [],
      description: 'Full scope',
      pricingLines: [{ description: 'Work', price: 100, vatRate: 21 }],
      totalAmount: 100,
      currency: 'EUR',
      milestones: [],
      preparationDuration: { value: 1, unit: 'days' },
      executionDuration: { value: 2, unit: 'days' },
      validUntil: new Date('2026-03-01T00:00:00.000Z'),
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    };
    const rejectBooking = await createBookingDoc({
      status: 'quoted',
      quotationNumber: 'QT-2026-000001',
      quote: { amount: 100, currency: 'EUR', description: 'Quote' },
      quoteVersions: [version],
      currentQuoteVersion: 1,
    });
    const rejectRes = response();
    await respondToQuoteWithPayment(request({
      params: { bookingId: String(rejectBooking!._id) },
      body: { action: 'reject', rejectionReason: 'Too expensive' },
      user: { _id: customerId, role: 'customer' },
    }) as any, rejectRes as any);
    expect(rejectRes.statusCode).toBe(200);
    const rejected = await Booking.findById(rejectBooking!._id).lean() as any;
    expect(rejected.status).toBe('quote_rejected');
    expect(rejected.customerRejectionReason).toBe('Too expensive');
    expect(rejected.quoteVersions[0]).toMatchObject({
      rejectionReason: 'Too expensive',
      rejectedBy: customerId,
    });
    expect(rejected.quoteVersions[0].rejectedAt).toBeInstanceOf(Date);
    expect(rejected.statusHistory.at(-1)).toMatchObject({
      status: 'quote_rejected',
      note: 'Customer rejected the quote: Too expensive',
    });
    expect(rejected.statusHistory.at(-1).updatedBy.toString()).toBe(String(customerId));
    expect(rejected.statusHistory.at(-1).timestamp).toBeInstanceOf(Date);

    const retry = response();
    await respondToQuoteWithPayment(request({
      params: { bookingId: String(rejectBooking!._id) },
      body: { action: 'reject' },
      user: { _id: customerId, role: 'customer' },
    }) as any, retry as any);
    expect(retry.statusCode).toBe(400);
    const retried = await Booking.findById(rejectBooking!._id).lean() as any;
    expect(retried.statusHistory.filter((entry: any) => entry.status === 'quote_rejected')).toHaveLength(1);

    const acceptBooking = await createBookingDoc({
      status: 'quoted',
      quotationNumber: 'QT-2026-000002',
      quote: { amount: 100, currency: 'EUR', description: 'Quote' },
      quoteVersions: [version],
      currentQuoteVersion: 1,
    });
    const acceptRes = response();
    await respondToQuoteWithPayment(request({
      params: { bookingId: String(acceptBooking!._id) },
      body: { action: 'accept' },
      user: { _id: customerId, role: 'customer' },
    }) as any, acceptRes as any);
    expect(acceptRes.statusCode).toBe(200);
    const accepted = await Booking.findById(acceptBooking!._id).lean() as any;
    expect(accepted.status).toBe('quote_accepted');
    expect(accepted.acceptedQuoteVersion).toBe(1);
    expect(accepted.acceptedQuotationNumber).toBe('QT-2026-000001-v1');
    expect(accepted.statusHistory.at(-1)).toMatchObject({
      status: 'quote_accepted',
      note: 'Customer accepted the quote',
    });

    const acceptRetry = response();
    await respondToQuoteWithPayment(request({
      params: { bookingId: String(acceptBooking!._id) },
      body: { action: 'accept' },
      user: { _id: customerId, role: 'customer' },
    }) as any, acceptRetry as any);
    expect(acceptRetry.statusCode).toBe(400);
    const acceptedAgain = await Booking.findById(acceptBooking!._id).lean() as any;
    expect(acceptedAgain.statusHistory.filter((entry: any) => entry.status === 'quote_accepted')).toHaveLength(1);
  });

  it('moves an RFQ through accepted/rejected without inventing a quote and keeps RFQ history', async () => {
    const booking = await createBookingDoc({
      status: 'rfq',
      quote: undefined,
      quoteVersions: [],
      quotationNumber: undefined,
      statusHistory: [{
        status: 'rfq',
        timestamp: new Date('2026-01-10T09:00:00.000Z'),
        updatedBy: customerId,
        note: 'Booking created',
      }],
    });
    const acceptRes = response();
    await respondToRFQ(request({
      params: { bookingId: String(booking!._id) },
      body: { action: 'accepted' },
      user: { _id: professionalId, role: 'professional' },
    }) as any, acceptRes as any);
    expect(acceptRes.statusCode).toBe(200);

    const acceptedDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, acceptedDetails as any, vi.fn() as any);
    expect(acceptedDetails.body.data.quotation).toMatchObject({
      status: 'none',
      versions: [],
    });
    expect(acceptedDetails.body.data.quotation.rfqHistory.map((item: any) => item.type))
      .toEqual(expect.arrayContaining(['rfq_submitted', 'rfq_accepted']));
    expect(acceptedDetails.body.data.quotation.status).not.toBe('quoted');

    const rejectBooking = await createBookingDoc({
      status: 'rfq',
      quote: undefined,
      quoteVersions: [],
      quotationNumber: undefined,
      statusHistory: [{
        status: 'rfq',
        timestamp: new Date('2026-01-10T09:00:00.000Z'),
        updatedBy: customerId,
        note: 'Booking created',
      }],
    });
    const rejectRes = response();
    await respondToRFQ(request({
      params: { bookingId: String(rejectBooking!._id) },
      body: { action: 'rejected', rejectionReason: 'Not available' },
      user: { _id: professionalId, role: 'professional' },
    }) as any, rejectRes as any);
    expect(rejectRes.statusCode).toBe(200);

    const rejectedDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(rejectBooking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, rejectedDetails as any, vi.fn() as any);
    expect(rejectedDetails.body.data.quotation).toMatchObject({
      status: 'rejected',
      versions: [],
    });
    expect(rejectedDetails.body.data.quotation.status).not.toBe('quoted');
  });

  it('persists booking and direct-quotation snapshots through save/reload and a later project edit', async () => {
    const createRes = response();
    await createBooking(request({
      body: {
        bookingType: 'project',
        projectId: String(projectId),
        selectedSubprojectIndex: 0,
        rfqData: {
          serviceType: 'Bathroom',
          description: 'Need a bathroom',
          answers: [],
          attachments: [],
        },
      },
      user: { _id: customerId, role: 'customer' },
    }) as any, createRes as any, vi.fn() as any);
    expect(createRes.statusCode).toBe(201);

    const created = await Booking.findOne({ customer: customerId }).lean() as any;
    expect(created.bookingSnapshot).toBeTruthy();
    expect(created.bookingSnapshot.source).toBe('booking_creation');
    expect(created.bookingSnapshot.project.title).toBe('Bathroom renovation');

    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          title: 'Renamed after booking',
          'subprojects.0.name': 'Renamed package',
          'subprojects.0.pricing.amount': 999,
        },
      },
    );
    const reloaded = await Booking.findById(created._id).lean() as any;
    expect(reloaded.bookingSnapshot.project.title).toBe('Bathroom renovation');
    expect(reloaded.bookingSnapshot.selectedSubproject.name).toBe('Standard package');

    const detailsRes = response();
    await getBookingDetails(request({
      params: { bookingId: String(created._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, detailsRes as any, vi.fn() as any);
    expect(detailsRes.body.data.bookingSnapshot).toMatchObject({
      authority: 'booking_snapshot',
      immutable: true,
      capturedBySource: 'booking_creation',
    });
    expect(detailsRes.body.data.bookingSnapshot.project.title).toBe('Bathroom renovation');
    expect(detailsRes.body.data.bookingSnapshot.selectedSubproject.name).toBe('Standard package');

    const directRes = response();
    await createDirectQuotation(request({
      body: { customerId: String(customerId), projectId: String(projectId), selectedSubprojectIndex: 0 },
      user: { _id: professionalId, role: 'professional' },
    }) as any, directRes as any);
    expect(directRes.statusCode).toBe(201);
    const direct = await Booking.findById(directRes.body.data.bookingId).lean() as any;
    expect(direct.bookingSnapshot).toBeTruthy();
    expect(direct.bookingSnapshot.source).toBe('direct_quotation_creation');
    expect(direct.bookingSnapshot.project.title).toBe('Renamed after booking');

    await Project.updateOne({ _id: projectId }, { $set: { title: 'Third project title' } });
    const directReloaded = await Booking.findById(direct._id).lean() as any;
    expect(directReloaded.bookingSnapshot.project.title).toBe('Renamed after booking');
  });

  it('merges aggregate booking refunds with real Payment rows and dedupes provider events', async () => {
    const booking = await createBookingDoc({
      status: 'booked',
      payment: {
        status: 'partially_refunded',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_aggregate_refund',
        refundAmount: 30,
        refundedAt: new Date('2026-02-04T10:00:00.000Z'),
        refundReason: 'Provider dashboard refund',
        refundSource: 'platform',
        refundNotes: 'Internal provider note',
      },
    });
    const payment = await createPayment(booking, {
      status: 'partially_refunded',
      stripePaymentIntentId: 'pi_aggregate_refund',
      refunds: [],
    });

    const first = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, first as any, vi.fn() as any);
    const firstDetails = first.body.data;
    expect(firstDetails.payments.refunds).toHaveLength(1);
    expect(firstDetails.payments.refunds[0]).toMatchObject({
      amount: 30,
      status: 'aggregate_only',
      kind: 'booking',
      justification: 'Provider dashboard refund',
      vatSplitRecorded: false,
    });
    expect(firstDetails.payments.refunds[0].internalNotes).toBeUndefined();
    expect(firstDetails.booking.payment.refundedTotal).toBe(30);
    expect(firstDetails.payments.byCurrency[0]).toMatchObject({
      currency: 'EUR',
      recordedRefunded: 30,
      recordedNet: 90,
    });
    expect(firstDetails.meta.dataQuality.refundVatRecorded).toBe(false);
    expect(firstDetails.payments.notices.map((notice: any) => notice.code))
      .toContain('REFUND_VAT_SPLIT_NOT_RECORDED');
    expect(firstDetails.activity.items.filter((item: any) => item.type === 'refund_issued'))
      .toHaveLength(1);
    expect(firstDetails.activity.items.find((item: any) => item.type === 'refund_issued'))
      .toMatchObject({ amounts: { amount: 30, currency: 'EUR' } });

    // A later provider event records its own refund row; the aggregate is only
    // reduced to the still-unrepresented residual.
    await Payment.updateOne(
      { _id: payment._id },
      {
        $push: {
          refunds: {
            amount: 20,
            refundId: 're_mixed_a',
            refundedAt: new Date('2026-02-04T10:00:00.000Z'),
            source: 'platform',
            kind: 'booking',
          },
        },
      },
    );
    const mixed = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, mixed as any, vi.fn() as any);
    expect(mixed.body.data.payments.refunds).toHaveLength(2);
    expect(mixed.body.data.payments.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(30);
    expect(mixed.body.data.payments.refunds.filter((refund: any) => refund.status === 'aggregate_only'))
      .toHaveLength(1);
    expect(mixed.body.data.payments.refunds.find((refund: any) => refund.status === 'aggregate_only').amount)
      .toBe(10);
    expect(mixed.body.data.payments.byCurrency[0].recordedRefunded).toBe(30);

    const charge = {
      id: 'ch_aggregate_refund',
      payment_intent: 'pi_aggregate_refund',
      currency: 'eur',
      amount: 12000,
      amount_refunded: 3000,
      refunds: {
        data: [
          { id: 're_mixed_a', amount: 2000, created: 1792454400, metadata: { refundKind: 'booking' } },
          { id: 're_mixed_b', amount: 1000, created: 1792454401, metadata: { refundKind: 'booking' } },
        ],
      },
    };
    for (const eventId of ['evt_aggregate_a', 'evt_aggregate_a_replay']) {
      stripeMocks.constructEvent.mockReturnValue({
        id: eventId,
        type: 'charge.refunded',
        created: 1792454400,
        data: { object: charge },
      });
      await handleWebhook(request({
        headers: { 'stripe-signature': 'sig' },
        body: Buffer.from('{}'),
      }) as any, response() as any);
    }

    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.payment.refundAmount).toBe(30);
    const storedPayment = await Payment.findById(payment._id).lean() as any;
    expect(storedPayment.refundAmount).toBeUndefined();
    expect(storedPayment.refunds.map((refund: any) => refund.refundId).sort())
      .toEqual(['re_mixed_a', 're_mixed_b']);
    expect(storedPayment.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(30);

    const afterReplay = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, afterReplay as any, vi.fn() as any);
    expect(afterReplay.body.data.payments.refunds).toHaveLength(2);
    expect(afterReplay.body.data.payments.refunds.some((refund: any) => refund.status === 'aggregate_only'))
      .toBe(false);
    expect(afterReplay.body.data.payments.byCurrency[0].recordedRefunded).toBe(30);
    expect(afterReplay.body.data.booking.payment.refundedTotal).toBe(30);
    expect(afterReplay.body.data.activity.items.filter((item: any) => item.type === 'refund_issued'))
      .toHaveLength(2);
  });

  it('records a negative completion refund on a full legacy base Payment row and survives webhook replay', async () => {
    stripeMocks.refundCreate.mockResolvedValue({
      id: 're_completion_negative',
      status: 'succeeded',
    });

    // No Payment document exists yet: the legacy booking payment subdocument is
    // the only base-payment record. The refund row must copy those facts instead
    // of creating a false zero-value base payment.
    const booking = await createBookingDoc({
      status: 'professional_completed',
      payment: {
        status: 'completed',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        professionalPayout: 100,
        stripePaymentIntentId: 'pi_completion_negative',
        stripeChargeId: 'ch_completion_negative',
        stripeTransferId: 'tr_existing_completion',
        transferStatus: 'succeeded',
        authorizedAt: new Date('2026-02-02T00:00:00.000Z'),
        capturedAt: new Date('2026-02-02T00:01:00.000Z'),
        transferredAt: new Date('2026-02-02T00:02:00.000Z'),
      },
      extraCosts: [{ type: 'other', name: 'Waste', justification: 'More waste', amount: -20 }],
      extraCostTotal: -20,
    });

    const res = response();
    await customerConfirmCompletion(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(stripeMocks.refundCreate).toHaveBeenCalledTimes(1);

    const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment).toBeTruthy();
    expect(payment.amount).toBe(100);
    expect(payment.totalWithVat).toBe(120);
    expect(payment.stripePaymentIntentId).toBe('pi_completion_negative');
    expect(payment.stripeTransferId).toBe('tr_existing_completion');
    expect(payment.authorizedAt).toBeInstanceOf(Date);
    expect(payment.capturedAt).toBeInstanceOf(Date);
    expect(payment.transferredAt).toBeInstanceOf(Date);
    expect(payment.refunds).toHaveLength(1);
    expect(payment.refunds[0]).toMatchObject({
      refundId: 're_completion_negative',
      kind: 'extra_cost',
      amount: 20,
    });

    const charge = {
      id: 'ch_completion_negative',
      payment_intent: 'pi_completion_negative',
      currency: 'eur',
      amount: 12000,
      amount_refunded: 2000,
      refunds: {
        data: [{
          id: 're_completion_negative',
          amount: 2000,
          created: 1792454500,
          metadata: { refundKind: 'extra_cost' },
        }],
      },
    };
    for (const eventId of ['evt_completion_refund_1', 'evt_completion_refund_2']) {
      stripeMocks.constructEvent.mockReturnValue({
        id: eventId,
        type: 'charge.refunded',
        created: 1792454500,
        data: { object: charge },
      });
      await handleWebhook(request({
        headers: { 'stripe-signature': 'sig' },
        body: Buffer.from('{}'),
      }) as any, response() as any);
    }

    const afterReplayBooking = await Booking.findById(booking!._id).lean() as any;
    expect(afterReplayBooking.status).toBe('completed');
    expect(afterReplayBooking.payment.status).toBe('completed');
    expect(afterReplayBooking.payment.refundAmount ?? 0).toBe(0);
    const afterReplayPayment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(afterReplayPayment.refunds).toHaveLength(1);
    expect(afterReplayPayment.refundAmount).toBeUndefined();
  });

  it('auto-completion tags a negative extra refund and a later full refund only takes the remaining cash', async () => {
    const provider = installProviderRefundStub({ pi_auto_negative: 12000 });
    await User.updateOne(
      { _id: professionalId },
      { $set: { 'stripe.accountId': 'acct_auto_negative' } },
    );
    stripeMocks.chargeRetrieve.mockResolvedValue({
      id: 'ch_auto_negative',
      currency: 'eur',
      balance_transaction: { amount: 12000, currency: 'eur' },
    });
    stripeMocks.transferCreate.mockResolvedValue({
      id: 'tr_auto_negative',
      destination_payment: 'py_auto_negative',
    });

    const booking = await createBookingDoc({
      status: 'professional_completed',
      professionalCompletedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
      payment: {
        status: 'authorized',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        professionalPayout: 80,
        stripePaymentIntentId: 'pi_auto_negative',
        stripeChargeId: 'ch_auto_negative',
      },
      extraCosts: [{ type: 'other', name: 'Waste', justification: 'Less waste', amount: -20 }],
      extraCostTotal: -20,
    });

    const auto = await runCompletionAutoAccept();
    expect(auto.autoAccepted).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].params).toMatchObject({
      payment_intent: 'pi_auto_negative',
      amount: 2000,
      metadata: expect.objectContaining({ refundKind: 'extra_cost' }),
    });

    const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment).toBeTruthy();
    expect(payment.amount).toBe(100);
    expect(payment.totalWithVat).toBe(120);
    expect(payment.refunds).toHaveLength(1);
    expect(payment.refunds[0]).toMatchObject({ amount: 20, kind: 'extra_cost' });
    expect(payment.refunds[0].refundedBy.toString()).toBe(String(SYSTEM_USER_ID));

    const extraRefund = payment.refunds[0];
    stripeMocks.constructEvent.mockReturnValue({
      id: 'evt_auto_extra_refund',
      type: 'charge.refunded',
      created: 1792454600,
      data: {
        object: providerCharge({
          id: 'ch_auto_negative',
          payment_intent: 'pi_auto_negative',
          currency: 'eur',
          amount: 12000,
          amount_refunded: 2000,
          refunds: {
            data: [{
              id: extraRefund.refundId,
              amount: 2000,
              created: 1792454600,
              metadata: { refundKind: 'extra_cost' },
            }],
          },
        }),
      },
    });
    await handleWebhook(request({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    }) as any, response() as any);

    const afterWebhook = await Booking.findById(booking!._id).lean() as any;
    expect(afterWebhook.status).toBe('completed');
    expect(afterWebhook.payment.status).toBe('completed');
    expect(afterWebhook.payment.refundAmount ?? 0).toBe(0);
    expect((await Payment.findOne({ booking: booking!._id }).lean() as any).refunds).toHaveLength(1);

    // 20 extra is already refunded on the same 120 charge: the full booking
    // refund must request at most 100, and the provider stub rejects anything
    // above the actual charge.
    const refunded = await executeRefund(String(booking!._id), { reason: 'Booking cancelled' });
    expect(refunded.amount).toBe(100);
    expect(provider.calls.at(-1)?.params.amount).toBe(10000);
    expect(provider.totals.get('pi_auto_negative')).toBe(12000);

    const afterFull = await Booking.findById(booking!._id).lean() as any;
    expect(afterFull.status).toBe('refunded');
    expect(afterFull.payment.status).toBe('refunded');
    expect(afterFull.payment.refundAmount).toBe(100);
    const afterFullPayment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(afterFullPayment.refunds).toHaveLength(2);
    expect(afterFullPayment.refunds.map((refund: any) => refund.kind).sort())
      .toEqual(['booking', 'extra_cost']);
    expect(afterFullPayment.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(120);

    const details = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, details as any, vi.fn() as any);
    expect(details.body.data.payments.refunds).toHaveLength(2);
    expect(details.body.data.payments.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(120);
    expect(details.body.data.booking.payment.refundedTotal).toBe(100);
  });

  it('keeps an automatic completion refund retryable when the provider rejects before creating it', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    const provider = installProviderRefundStub({ [`pi_${suffix}`]: 12000 });
    const delegate = stripeMocks.refundCreate.getMockImplementation()!;
    let failBeforeCreate = true;
    stripeMocks.refundCreate.mockImplementation(async (params: any, options: any) => {
      if (failBeforeCreate) {
        failBeforeCreate = false;
        throw new Error('Transient provider failure');
      }
      return delegate(params, options);
    });

    const booking = await seedCompletionBooking({ suffix });
    const first = await runCompletionAutoAccept();
    expect(first).toMatchObject({ autoAccepted: 0, recovered: 0 });
    expect(first.errors.join(' ')).toContain('refund_recovery_required');

    let stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toMatchObject({ amount: 20 });
    expect(stored.payment.extraCostRefundPending.processingAt).toBeUndefined();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
    const baseRow = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(baseRow).toBeTruthy();
    expect(baseRow.refunds).toHaveLength(0);
    expect(notifyAsync).not.toHaveBeenCalled();
    expect(stripeMocks.transferCreate).toHaveBeenCalledTimes(1);

    const second = await runCompletionAutoAccept();
    expect(second).toMatchObject({ autoAccepted: 0, recovered: 1, errors: [] });

    stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
    const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment.refunds).toHaveLength(1);
    expect(payment.refunds[0]).toMatchObject({ amount: 20, kind: 'extra_cost' });
    expect(provider.calls).toHaveLength(1);
    expect(provider.totals.get(`pi_${suffix}`)).toBe(2000);
    expect(stripeMocks.transferCreate).toHaveBeenCalledTimes(1);
    expect(notifyAsync).toHaveBeenCalled();

    const third = await runCompletionAutoAccept();
    expect(third).toMatchObject({ autoAccepted: 0, recovered: 0, errors: [] });
    expect(notifyAsync.mock.calls).toHaveLength(4);
  });

  it('keeps a customer completion retryable and settles it on a later manual retry', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    const provider = installProviderRefundStub({ [`pi_${suffix}`]: 12000 });
    const delegate = stripeMocks.refundCreate.getMockImplementation()!;
    let failBeforeCreate = true;
    stripeMocks.refundCreate.mockImplementation(async (params: any, options: any) => {
      if (failBeforeCreate) {
        failBeforeCreate = false;
        throw new Error('Transient provider failure');
      }
      return delegate(params, options);
    });

    const booking = await seedCompletionBooking({ suffix });
    const first = response();
    await customerConfirmCompletion(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, first as any);
    expect(first.statusCode).toBe(502);
    expect(first.body).toMatchObject({
      success: false,
      error: { code: 'REFUND_RECOVERY_REQUIRED' },
      data: { refundStatus: 'pending' },
    });

    let stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toMatchObject({ amount: 20 });
    expect(stored.payment.extraCostRefundPending.processingAt).toBeUndefined();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
    const baseRow = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(baseRow.refunds).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();

    const customerRaw = response();
    await getBookingById(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, customerRaw as any, vi.fn() as any);
    expect(customerRaw.statusCode).toBe(200);
    expect(customerRaw.body.booking.payment.extraCostRefundPending).toBeUndefined();

    const second = response();
    await customerConfirmCompletion(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, second as any);
    expect(second.statusCode).toBe(200);
    expect(second.body.success).toBe(true);

    stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
    const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment.refunds).toHaveLength(1);
    expect(payment.refunds[0]).toMatchObject({ amount: 20, kind: 'extra_cost' });
    expect(provider.calls).toHaveLength(1);
    expect(provider.totals.get(`pi_${suffix}`)).toBe(2000);
    expect(stripeMocks.transferCreate).toHaveBeenCalledTimes(1);

    const third = response();
    await customerConfirmCompletion(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, third as any);
    expect(third.statusCode).toBe(400);
    expect(provider.calls).toHaveLength(1);
    expect((await Payment.findOne({ booking: booking!._id }).lean() as any).refunds).toHaveLength(1);
  });

  it('reuses the provider idempotency key after a timeout that followed provider acceptance', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    const byIdempotencyKey = new Map<string, any>();
    let providerCalls = 0;
    let cashMovements = 0;
    stripeMocks.refundCreate.mockImplementation(async (params: any, options: any) => {
      providerCalls += 1;
      const key = options?.idempotencyKey;
      if (key && byIdempotencyKey.has(key)) return byIdempotencyKey.get(key);
      cashMovements += 1;
      const refund = {
        id: `re_timeout_${suffix}`,
        amount: params.amount,
        status: 'succeeded',
        created: 1792454700,
        metadata: params.metadata,
      };
      if (key) byIdempotencyKey.set(key, refund);
      if (providerCalls === 1) throw new Error('StripeConnectionError: socket hang up');
      return refund;
    });

    const booking = await seedCompletionBooking({ suffix });
    const first = await runCompletionAutoAccept();
    expect(first.errors.join(' ')).toContain('refund_recovery_required');
    const afterFirst = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(afterFirst.refunds).toHaveLength(0);

    const second = await runCompletionAutoAccept();
    expect(second.recovered).toBe(1);
    const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment.refunds).toHaveLength(1);
    expect(providerCalls).toBe(2);
    expect(cashMovements).toBe(1);
    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
  });

  it('recovers a provider refund after the local ledger write fails once', async () => {
    const suffix = new Types.ObjectId().toString();
    const provider = installProviderRefundStub({ [`pi_${suffix}`]: 12000 });
    const booking = await seedCompletionBooking({
      suffix,
      payment: {
        status: 'completed',
        stripeTransferId: `tr_${suffix}`,
        transferStatus: 'succeeded',
      },
    });

    const originalFindOneAndUpdate = Payment.findOneAndUpdate.bind(Payment);
    let failLedgerWrite = true;
    const ledgerSpy = vi.spyOn(Payment, 'findOneAndUpdate').mockImplementation(((
      filter: any,
      update: any,
      options: any,
    ) => {
      if (failLedgerWrite && update?.$push?.refunds) {
        failLedgerWrite = false;
        return Promise.reject(new Error('ledger write failed'));
      }
      return originalFindOneAndUpdate(filter, update, options);
    }) as any);

    try {
      const first = await runCompletionAutoAccept();
      expect(first.errors.join(' ')).toContain('refund_recovery_required');
      expect(await Payment.findOne({ booking: booking!._id }).lean()).toBeNull();

      const second = await runCompletionAutoAccept();
      expect(second.recovered).toBe(1);
      const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
      expect(payment.refunds).toHaveLength(1);
      expect(payment.refunds[0]).toMatchObject({ amount: 20, kind: 'extra_cost' });
      // The accepted provider refund is reconciled from the provider list, so
      // the retry records it without issuing a second create.
      expect(provider.calls).toHaveLength(1);
      expect(provider.totals.get(`pi_${suffix}`)).toBe(2000);
    } finally {
      ledgerSpy.mockRestore();
    }
  });

  it('settles one refund and one completion fact under concurrent automatic runs', async () => {
    const suffix = new Types.ObjectId().toString();
    const provider = installProviderRefundStub({ [`pi_${suffix}`]: 12000 });
    const booking = await seedCompletionBooking({
      suffix,
      payment: {
        status: 'completed',
        stripeTransferId: `tr_${suffix}`,
        transferStatus: 'succeeded',
      },
    });

    const [first, second] = await Promise.all([
      runCompletionAutoAccept(),
      runCompletionAutoAccept(),
    ]);
    expect(first.autoAccepted + first.recovered + second.autoAccepted + second.recovered).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(provider.totals.get(`pi_${suffix}`)).toBe(2000);

    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
    const payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment.refunds).toHaveLength(1);
    expect(notifyAsync.mock.calls).toHaveLength(4);
  });

  it('completes a zero-extra booking without creating a refund obligation', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    stripeMocks.refundCreate.mockReset();
    const booking = await seedCompletionBooking({
      suffix,
      extraCosts: [],
      extraCostTotal: 0,
    });

    const result = await runCompletionAutoAccept();
    expect(result).toMatchObject({ autoAccepted: 1, recovered: 0, errors: [] });
    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    expect(stripeMocks.refundCreate).not.toHaveBeenCalled();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
  });

  it('completes a paid positive-extra booking without a refund obligation', async () => {
    const suffix = new Types.ObjectId().toString();
    await armAutoTransfer(suffix);
    stripeMocks.refundCreate.mockReset();
    stripeMocks.paymentIntentRetrieve.mockResolvedValue({
      id: `pi_extra_${suffix}`,
      status: 'succeeded',
      latest_charge: `ch_extra_${suffix}`,
    });
    stripeMocks.chargeRetrieve.mockImplementation(async (chargeId: string) => {
      if (chargeId === `ch_extra_${suffix}`) {
        return {
          id: chargeId,
          status: 'succeeded',
          refunded: false,
          amount_refunded: 0,
          transfer: `tr_extra_${suffix}`,
        };
      }
      return {
        id: chargeId,
        currency: 'eur',
        balance_transaction: { amount: 12000, currency: 'eur' },
      };
    });

    const booking = await seedCompletionBooking({
      suffix,
      payment: {
        extraCostStripePaymentIntentId: `pi_extra_${suffix}`,
        extraCostAmount: 20,
        extraCostStatus: 'pending',
      },
      extraCosts: [{ type: 'other', name: 'Extra material', justification: 'More material', amount: 20 }],
      extraCostTotal: 20,
    });

    const result = await runCompletionAutoAccept();
    expect(result).toMatchObject({ autoAccepted: 1, recovered: 0, errors: [] });
    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('completed');
    expect(stored.payment.extraCostStatus).toBe('succeeded');
    expect(stored.payment.extraCostRefundPending).toBeUndefined();
    expect(stripeMocks.refundCreate).not.toHaveBeenCalled();
    expect(stored.statusHistory.filter((entry: any) => entry.status === 'completed')).toHaveLength(1);
  });

  it('creates the base Payment row for provider refunds and dedupes out-of-order booking/extra events', async () => {
    const booking = await createBookingDoc({
      status: 'completed',
      payment: {
        status: 'completed',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_provider_no_row',
        stripeChargeId: 'ch_provider_no_row',
        stripeTransferId: 'tr_provider_no_row',
        transferStatus: 'succeeded',
        authorizedAt: new Date('2026-02-02T00:00:00.000Z'),
        capturedAt: new Date('2026-02-02T00:01:00.000Z'),
        transferredAt: new Date('2026-02-02T00:02:00.000Z'),
      },
      extraCosts: [{ type: 'other', name: 'Waste', justification: 'Less waste', amount: -20 }],
      extraCostTotal: -20,
    });
    expect(await Payment.countDocuments({ booking: booking!._id })).toBe(0);

    // Out of order: the booking refund event arrives before the later extra-
    // cost refund. Both must be recorded on the row created from booking facts.
    const bookingCharge = {
      id: 'ch_provider_no_row',
      payment_intent: 'pi_provider_no_row',
      currency: 'eur',
      amount: 12000,
      amount_refunded: 10000,
      refunds: {
        data: [{
          id: 're_provider_booking',
          amount: 10000,
          created: 1792454700,
          metadata: { refundKind: 'booking' },
        }],
      },
    };
    stripeMocks.constructEvent.mockReturnValue({
      id: 'evt_provider_booking',
      type: 'charge.refunded',
      created: 1792454700,
      data: { object: providerCharge(bookingCharge) },
    });
    await handleWebhook(request({
      headers: { 'stripe-signature': 'sig' },
      body: Buffer.from('{}'),
    }) as any, response() as any);

    let payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment).toBeTruthy();
    expect(payment.amount).toBe(100);
    expect(payment.totalWithVat).toBe(120);
    expect(payment.stripePaymentIntentId).toBe('pi_provider_no_row');
    expect(payment.stripeTransferId).toBe('tr_provider_no_row');
    expect(payment.authorizedAt).toBeInstanceOf(Date);
    expect(payment.refunds).toHaveLength(1);
    expect(payment.refunds[0]).toMatchObject({ refundId: 're_provider_booking', amount: 100, kind: 'booking' });
    let stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.payment.refundAmount).toBe(100);
    expect(stored.payment.status).toBe('partially_refunded');

    const bothCharge = {
      ...bookingCharge,
      amount_refunded: 12000,
      refunds: {
        data: [
          bookingCharge.refunds.data[0],
          {
            id: 're_provider_extra',
            amount: 2000,
            created: 1792454701,
            metadata: { refundKind: 'extra_cost' },
          },
        ],
      },
    };
    for (const eventId of ['evt_provider_both', 'evt_provider_both_replay']) {
      stripeMocks.constructEvent.mockReturnValue({
        id: eventId,
        type: 'charge.refunded',
        created: 1792454701,
        data: { object: providerCharge(bothCharge) },
      });
      await handleWebhook(request({
        headers: { 'stripe-signature': 'sig' },
        body: Buffer.from('{}'),
      }) as any, response() as any);
    }

    stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.payment.refundAmount).toBe(100);
    expect(stored.payment.status).toBe('partially_refunded');
    payment = await Payment.findOne({ booking: booking!._id }).lean() as any;
    expect(payment.refunds).toHaveLength(2);
    expect(payment.refunds.map((refund: any) => refund.kind).sort()).toEqual(['booking', 'extra_cost']);
    expect(payment.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(120);

    // A full booking-price refund (100) plus the 20 extra has consumed the
    // whole charge; the capacity arithmetic must not try to refund it again.
    await expect(
      executeRefund(String(booking!._id), { amount: 1, reason: 'Should be rejected' }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_TOTAL' });
  });

  it('computes base refund capacity only from the base PaymentIntent, not milestone rows', async () => {
    const provider = installProviderRefundStub({ pi_base_milestone: 12000 });
    const booking = await createBookingDoc({
      status: 'completed',
      payment: {
        status: 'completed',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_base_milestone',
      },
    });
    const basePayment = await createPayment(booking, {
      stripePaymentIntentId: 'pi_base_milestone',
      refunds: [{
        amount: 20,
        reason: 'Extra cost refund',
        refundId: 're_base_extra',
        refundedAt: new Date('2026-02-04T10:00:00.000Z'),
        source: 'platform',
        kind: 'extra_cost',
      }],
    });
    const milestonePayment = await createPayment(booking, {
      milestoneIndex: 0,
      milestoneTitle: 'Deposit',
      status: 'completed',
      amount: 50,
      netAmount: 50,
      vatAmount: 0,
      totalWithVat: 50,
      stripePaymentIntentId: 'pi_milestone_only',
      refunds: [{
        amount: 50,
        reason: 'Milestone refund',
        refundId: 're_milestone',
        refundedAt: new Date('2026-02-04T11:00:00.000Z'),
        source: 'platform',
        kind: 'booking',
      }],
    });

    const refunded = await executeRefund(String(booking!._id), { reason: 'Base cancellation' });
    expect(refunded.amount).toBe(100);
    expect(provider.calls.at(-1)?.params).toMatchObject({
      payment_intent: 'pi_base_milestone',
      amount: 10000,
    });

    const storedBase = await Payment.findById(basePayment._id).lean() as any;
    expect(storedBase.refunds).toHaveLength(2);
    expect(storedBase.refunds.reduce((sum: number, refund: any) => sum + refund.amount, 0)).toBe(120);
    const storedMilestone = await Payment.findById(milestonePayment._id).lean() as any;
    expect(storedMilestone.refunds).toHaveLength(1);
    expect(storedMilestone.refunds[0].refundId).toBe('re_milestone');
  });

  it('binds rejection reasons to exact quote versions through reject/edit/reject/accept', async () => {
    const booking = await createBookingDoc({
      status: 'quoted',
      quotationNumber: 'QT-2026-000001',
      quote: { amount: 100, currency: 'EUR', description: 'Quote' },
      quoteVersions: [quoteVersion()],
      currentQuoteVersion: 1,
    });

    const rejectV1 = response();
    await customerRespondToQuotation(request({
      params: { bookingId: String(booking!._id) },
      body: { action: 'rejected', rejectionReason: 'First reason' },
      user: { _id: customerId, role: 'customer' },
    }) as any, rejectV1 as any);
    expect(rejectV1.statusCode).toBe(200);

    const editV2 = response();
    await editQuotation(request({
      params: { bookingId: String(booking!._id) },
      body: editQuotationBody(),
      user: { _id: professionalId, role: 'professional' },
    }) as any, editV2 as any);
    expect(editV2.statusCode).toBe(200);
    const afterV2 = await Booking.findById(booking!._id).lean() as any;
    expect(afterV2.currentQuoteVersion).toBe(2);
    expect(afterV2.customerRejectionReason).toBeUndefined();
    expect(afterV2.quoteVersions[0]).toMatchObject({ rejectionReason: 'First reason' });

    const rejectV2 = response();
    await customerRespondToQuotation(request({
      params: { bookingId: String(booking!._id) },
      body: { action: 'rejected', rejectionReason: 'Second reason' },
      user: { _id: customerId, role: 'customer' },
    }) as any, rejectV2 as any);
    expect(rejectV2.statusCode).toBe(200);

    const editV3 = response();
    await editQuotation(request({
      params: { bookingId: String(booking!._id) },
      body: editQuotationBody({ scope: 'Bathroom renovation v3', changeNote: 'Final revision' }),
      user: { _id: professionalId, role: 'professional' },
    }) as any, editV3 as any);
    expect(editV3.statusCode).toBe(200);

    const acceptV3 = response();
    await customerRespondToQuotation(request({
      params: { bookingId: String(booking!._id) },
      body: { action: 'accepted' },
      user: { _id: customerId, role: 'customer' },
    }) as any, acceptV3 as any);
    expect(acceptV3.statusCode).toBe(200);

    const stored = await Booking.findById(booking!._id).lean() as any;
    expect(stored.status).toBe('quote_accepted');
    expect(stored.acceptedQuoteVersion).toBe(3);
    expect(stored.quoteVersions.map((version: any) => version.rejectionReason || null))
      .toEqual(['First reason', 'Second reason', null]);

    const details = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, details as any, vi.fn() as any);
    const versions = details.body.data.quotation.versions;
    expect(versions[0]).toMatchObject({ version: 1, rejectionReason: 'First reason' });
    expect(versions[0].rejectedAt).toBeTruthy();
    expect(versions[1]).toMatchObject({ version: 2, rejectionReason: 'Second reason' });
    expect(versions[1].rejectedAt).toBeTruthy();
    expect(versions[2]).toMatchObject({ version: 3, rejectedAt: null, rejectionReason: null, accepted: true });
  });

  it('records the final cancellation actor for professional and customer finalizers', async () => {
    const booking = await createBookingDoc({
      status: 'booked',
      payment: {
        status: 'authorized',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_cancel_actor',
      },
    });
    await createPayment(booking, {
      status: 'authorized',
      stripePaymentIntentId: 'pi_cancel_actor',
    });
    const requestDoc = await CancellationRequest.create({
      booking: booking!._id,
      requestedBy: customerId,
      requestedRole: 'customer',
      reasonCategory: 'scheduling_conflict',
      reason: 'Cannot make the date',
      status: 'pending',
      evidence: [],
    });
    stripeMocks.refundCreate.mockResolvedValue({ id: 're_cancel_pro', status: 'succeeded' });

    const approve = response();
    await professionalRespondToCancellation(request({
      params: { bookingId: String(booking!._id) },
      body: { decision: 'approve', note: 'Approved' },
      user: { _id: professionalId, role: 'professional' },
    }) as any, approve as any);
    expect(approve.statusCode).toBe(200);

    const approvedRequest = await CancellationRequest.findById(requestDoc._id).lean() as any;
    expect(approvedRequest.resolvedBy.toString()).toBe(String(professionalId));
    expect(approvedRequest.professionalRespondedBy.toString()).toBe(String(professionalId));

    const details = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, details as any, vi.fn() as any);
    const finalCancellation = details.body.data.activity.items.find(
      (item: any) => item.type === 'cancellation_approved' && item.metadata?.stage === 'final',
    );
    expect(finalCancellation.actor).toMatchObject({ role: 'professional', name: 'Piet Professional' });
    expect(finalCancellation.actorRecorded).toBe(true);
    const professionalResponse = details.body.data.activity.items.find(
      (item: any) => item.metadata?.stage === 'professional_response',
    );
    expect(professionalResponse.actor).toMatchObject({ role: 'professional', name: 'Piet Professional' });
    expect(professionalResponse.actorRecorded).toBe(true);

    const customerBooking = await createBookingDoc({
      status: 'booked',
      payment: {
        status: 'authorized',
        currency: 'EUR',
        amount: 100,
        netAmount: 100,
        vatAmount: 20,
        vatRate: 20,
        totalWithVat: 120,
        stripePaymentIntentId: 'pi_cancel_customer',
      },
    });
    await createPayment(customerBooking, {
      status: 'authorized',
      stripePaymentIntentId: 'pi_cancel_customer',
    });
    const counterDoc = await CancellationRequest.create({
      booking: customerBooking!._id,
      requestedBy: customerId,
      requestedRole: 'customer',
      reasonCategory: 'scheduling_conflict',
      reason: 'Cannot make the date',
      status: 'negotiating',
      professionalDecision: 'counter',
      counterOfferAmount: 30,
      professionalRespondedAt: new Date('2026-02-02T00:00:00.000Z'),
      evidence: [],
    });
    stripeMocks.refundCreate.mockResolvedValue({ id: 're_cancel_customer', status: 'succeeded' });

    const accept = response();
    await customerRespondToCounterOffer(request({
      params: { bookingId: String(customerBooking!._id) },
      body: { decision: 'accept' },
      user: { _id: customerId, role: 'customer' },
    }) as any, accept as any);
    expect(accept.statusCode).toBe(200);

    const counterStored = await CancellationRequest.findById(counterDoc._id).lean() as any;
    expect(counterStored.resolvedBy.toString()).toBe(String(customerId));
    expect(counterStored.customerRespondedBy.toString()).toBe(String(customerId));

    const customerDetails = response();
    await getBookingDetails(request({
      params: { bookingId: String(customerBooking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, customerDetails as any, vi.fn() as any);
    const customerFinal = customerDetails.body.data.activity.items.find(
      (item: any) => item.type === 'cancellation_approved' && item.metadata?.stage === 'final',
    );
    expect(customerFinal.actor).toMatchObject({ role: 'customer', name: 'Carla Customer' });
    expect(customerFinal.actorRecorded).toBe(true);
    const customerResponse = customerDetails.body.data.activity.items.find(
      (item: any) => item.metadata?.stage === 'customer_response',
    );
    expect(customerResponse.actor).toMatchObject({ role: 'customer', name: 'Carla Customer' });
    expect(customerResponse.actorRecorded).toBe(true);
  });

  it('validates cancellation evidence ownership and signs only the requester file', async () => {
    const booking = await createBookingDoc({ status: 'booked' });
    const owned = `${S3_BASE}/dispute-attachments/${customerId}/owned-proof.pdf`;
    const forged = `${S3_BASE}/dispute-attachments/${otherCustomerId}/forged-proof.pdf`;

    const forgedRes = response();
    await cancelBooking(request({
      params: { bookingId: String(booking!._id) },
      body: { reasonCategory: 'scheduling_conflict', reason: 'Date issue', evidence: [forged] },
      user: { _id: customerId, role: 'customer' },
    }) as any, forgedRes as any, vi.fn() as any);
    expect(forgedRes.statusCode).toBe(400);

    const ownedRes = response();
    await cancelBooking(request({
      params: { bookingId: String(booking!._id) },
      body: { reasonCategory: 'scheduling_conflict', reason: 'Date issue', evidence: [owned] },
      user: { _id: customerId, role: 'customer' },
    }) as any, ownedRes as any, vi.fn() as any);
    expect(ownedRes.statusCode).toBe(201);
    const stored = await CancellationRequest.findOne({ booking: booking!._id }).lean() as any;
    expect(stored.evidence).toEqual([owned]);

    const details = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, details as any, vi.fn() as any);
    expect(details.body.data.cancellations[0].evidence[0].signed).toBe(true);
    expect(details.body.data.cancellations[0].evidence[0].url).toContain('X-Amz-Signature=');
  });

  it('projects the standard-VAT acceptance path into quotation history', async () => {
    const fixedProject = await createProject({
      title: 'Fixed bathroom',
      subprojects: [{
        _id: new Types.ObjectId(),
        name: 'Fixed package',
        description: 'Fixed work',
        projectType: ['renovation'],
        pricing: { type: 'fixed', amount: 100 },
        included: [],
        materialsIncluded: false,
        materials: [],
        preparationDuration: { value: 1, unit: 'days' },
        executionDuration: { value: 2, unit: 'days' },
        buffer: { value: 1, unit: 'days' },
        warrantyPeriod: { value: 2, unit: 'years' },
      }],
    });
    const booking = await createBookingDoc({
      projectId: fixedProject._id,
      status: 'rfq_accepted',
      quote: undefined,
      quoteVersions: [],
      quotationNumber: undefined,
      vatDecision: {
        action: 'rfq',
        country: 'BE',
        standardRate: 21,
        appliedRate: 21,
        reverseCharge: false,
        answers: [],
      },
      checkoutSnapshot: {
        pricingType: 'fixed',
        unitAmount: 100,
        quantity: 1,
        baseSubtotal: 100,
        extraOptionsTotal: 0,
        totalAmount: 100,
        currency: 'EUR',
        selectedOptions: [],
      },
      statusHistory: [{
        status: 'rfq',
        timestamp: new Date('2026-01-10T09:00:00.000Z'),
        updatedBy: customerId,
        note: 'Booking created',
      }],
    });

    const res = response();
    await proceedAtStandardVatRate(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, res as any, vi.fn() as any);
    expect(res.statusCode).toBe(200);

    const details = response();
    await getBookingDetails(request({
      params: { bookingId: String(booking!._id) },
      user: { _id: customerId, role: 'customer' },
    }) as any, details as any, vi.fn() as any);
    const accepted = details.body.data.quotation.history.find(
      (item: any) => item.type === 'quotation_accepted',
    );
    expect(accepted).toMatchObject({
      category: 'quotation',
      descriptionSource: 'system',
      statusTo: 'quote_accepted',
    });
    expect(accepted.description).toBe('Customer chose standard VAT rate and restored fixed-price checkout');
    expect(accepted.actor).toMatchObject({ role: 'customer', name: 'Carla Customer' });
    expect(details.body.data.quotation.status).toBe('accepted');
  });
});
