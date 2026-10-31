import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bookingFindById: vi.fn(),
  bookingFindOneAndUpdate: vi.fn(),
  bookingFind: vi.fn(),
  bookingDistinct: vi.fn(),
  paymentFind: vi.fn(),
  paymentFindOneAndUpdate: vi.fn(),
  paymentCountDocuments: vi.fn(),
  paymentAggregate: vi.fn(),
  userFindById: vi.fn(),
  cancellationFind: vi.fn(),
  notify: vi.fn(),
  sendDisputeRaisedAdminEmail: vi.fn(),
  warrantyUpdateMany: vi.fn(),
}));

vi.mock('../../../models/booking', () => ({
  default: {
    findById: mocks.bookingFindById,
    findOneAndUpdate: mocks.bookingFindOneAndUpdate,
    find: mocks.bookingFind,
    distinct: mocks.bookingDistinct,
    create: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../../models/payment', () => ({
  default: {
    find: mocks.paymentFind,
    findById: vi.fn(),
    findOneAndUpdate: mocks.paymentFindOneAndUpdate,
    countDocuments: mocks.paymentCountDocuments,
    aggregate: mocks.paymentAggregate,
  },
}));

vi.mock('../../../models/user', () => ({
  default: { findById: mocks.userFindById },
}));

vi.mock('../../../models/cancellationRequest', () => ({
  default: {
    find: mocks.cancellationFind,
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
  ACTIVE_CANCELLATION_STATUSES: ['pending', 'processing', 'negotiating', 'escalated'],
  CANCELLATION_REASON_CATEGORIES: [
    'no_show',
    'not_as_described',
    'extra_payment_requested',
    'poor_communication',
    'no_longer_needed',
    'found_alternative',
    'requirements_changed',
    'scheduling_conflict',
    'trust_concerns',
    'other',
  ],
  CANCELLATION_REASON_LABELS: { other: 'Other' },
}));

vi.mock('../../../models/warrantyClaim', () => ({
  default: { updateMany: mocks.warrantyUpdateMany },
}));

vi.mock('../../../services/stripe', () => ({
  stripe: {},
  STRIPE_CONFIG: {
    supportedCurrencies: ['EUR'],
    defaultCurrency: 'EUR',
    environment: 'test',
    commissionPercent: 0,
  },
}));

vi.mock('../../../handlers/Stripe/payment', () => ({
  createPaymentIntent: vi.fn(),
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));

vi.mock('../../../services/invoiceArtifacts', () => ({
  ensureBookingInvoiceArtifacts: vi.fn(),
}));

vi.mock('../../../services/extraCostPayment', () => ({
  reconcileExtraCostPayment: vi.fn(),
}));

vi.mock('../../../utils/notifications/notify', () => ({
  notify: mocks.notify,
  notifyAsync: mocks.notify,
}));

vi.mock('../../../utils/emailService', () => ({
  sendDisputeRaisedAdminEmail: mocks.sendDisputeRaisedAdminEmail,
  sendCancellationRequestAdminEmail: vi.fn(),
  sendDisputeRaisedEmail: vi.fn(),
}));

vi.mock('../../../utils/referralSystem', () => ({
  processReferralCompletion: vi.fn(),
}));

vi.mock('../../../utils/professionalLevelSystem', () => ({
  updateProfessionalLevel: vi.fn(),
}));

vi.mock('../../../utils/loyaltySystem', () => ({
  getCurrentTier: vi.fn(),
  updateUserLoyalty: vi.fn(),
}));

vi.mock('../../../utils/pointsSystem', () => ({
  addPoints: vi.fn(),
}));

import { getMyDisputes, getMyPayments, submitQuote } from '../../../handlers/Booking';
import { customerDisputeExtraCosts } from '../../../handlers/Booking/completion';
import {
  ensurePaymentIntent,
  extendBookingExecution,
  requestBookingReschedule,
  respondToBookingReschedule,
  setBookingSchedule,
  updateBookingStatusWithPayment,
} from '../../../handlers/Booking/payment-integration';
import { listProfessionalRefundRequests } from '../../../handlers/Booking/refundNegotiation';
import { customerRespondToQuotation, respondToRFQ } from '../../../handlers/Quotation';

const RAW_PROVIDER_TEXT = 'Stripe API error: SQLSTATE 42P01 traceback at password=hunter2';
const RAW_PEPPOL_TEXT = 'Odoo Server Error: Traceback (most recent call last)';
const CUSTOMER_ID = '64b000000000000000000001';
const PROFESSIONAL_ID = '64b000000000000000000002';

const rawPayment = () => ({
  status: 'completed',
  amount: 100,
  totalWithVat: 121,
  currency: 'EUR',
  transferFailureReason: RAW_PROVIDER_TEXT,
  extraCostTransferFailureReason: RAW_PROVIDER_TEXT,
  refundNotes: `Dispute opened; provider secret sk_live_secret ${RAW_PROVIDER_TEXT}`,
  refunds: [
    {
      amount: 10,
      reason: 'Customer cancellation: requirements changed',
      source: 'platform',
      refundedAt: new Date('2026-01-01'),
      notes: `refund failed ${RAW_PROVIDER_TEXT}`,
    },
  ],
  metadata: {
    transferFailed: true,
    transferError: `provider failure ${RAW_PROVIDER_TEXT}`,
  },
  peppolDispatchReason: RAW_PEPPOL_TEXT,
  supplierPeppolDispatchReason: RAW_PEPPOL_TEXT,
  creditNotePeppolDispatchReason: RAW_PEPPOL_TEXT,
  supplierCreditNotePeppolDispatchReason: RAW_PEPPOL_TEXT,
  invoiceNumber: 'FIX-1',
  invoiceUrl: 'https://example/FIX.pdf',
  invoiceGeneratedAt: new Date('2026-01-01'),
  supplierInvoiceNumber: 'SUP-1',
  supplierInvoiceUrl: 'https://example/SUP.pdf',
  supplierInvoiceGeneratedAt: new Date('2026-01-01'),
  stripeClientSecret: 'pi_customer_secret',
  refundReason: 'Customer accepted negotiated refund',
  disputeReason: 'product_not_received',
  disputeStatus: 'needs_response',
  invoiceArtifactHistory: [
    { side: 'customer', invoiceNumber: 'FIX-OLD' },
    { side: 'supplier', invoiceNumber: 'SUP-OLD' },
  ],
});

const rawMilestones = () => [
  {
    title: 'Start',
    amount: 50,
    status: 'pending',
    stripeClientSecret: 'pi_milestone_secret',
  },
];

const makeBooking = (overrides: Record<string, any> = {}) => {
  const booking: any = {
    _id: 'booking-1',
    bookingNumber: 'BK-1',
    customer: 'customer-1',
    professional: 'professional-1',
    status: 'booked',
    quote: { amount: 100 },
    payment: rawPayment(),
    milestonePayments: rawMilestones(),
    statusHistory: [],
    rescheduleHistory: [],
    save: vi.fn(async () => booking),
    populate: vi.fn(async () => booking),
    updateStatus: vi.fn(async (status: string) => {
      booking.status = status;
    }),
    ...overrides,
  };
  return booking;
};

const query = (result: any) => {
  const q: any = {};
  for (const method of ['select', 'populate', 'sort', 'limit', 'skip']) {
    q[method] = vi.fn(() => q);
  }
  q.lean = vi.fn(async () => result);
  q.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject: any) => Promise.resolve(result).catch(reject);
  return q;
};

const response = () => {
  const res: any = { body: undefined };
  res.status = vi.fn(() => res);
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
};

const user = (role: 'customer' | 'professional', id = `${role}-1`) => ({
  _id: id,
  role,
});

const expectNoRawDiagnostics = (serialized: string) => {
  expect(serialized).not.toContain('SQLSTATE');
  expect(serialized).not.toContain('Traceback');
  expect(serialized).not.toContain('sk_live_secret');
  expect(serialized).not.toContain('hunter2');
  expect(serialized).not.toContain('pi_milestone_secret');
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindById.mockImplementation((id: string) =>
    query({ _id: id, name: id === 'customer-1' ? 'Customer' : 'Professional' })
  );
  mocks.warrantyUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mocks.paymentFindOneAndUpdate.mockResolvedValue({});
});

describe('non-admin booking response serialization', () => {
  it.each([
    ['customer', CUSTOMER_ID],
    ['professional', PROFESSIONAL_ID],
  ] as const)('sanitizes the dispute list for %s', async (role, userId) => {
    const booking = {
      _id: 'booking-1',
      bookingNumber: 'BK-1',
      status: 'dispute',
      customer: { _id: CUSTOMER_ID, name: 'Customer' },
      professional: { _id: PROFESSIONAL_ID, name: 'Professional' },
      project: { title: 'Project' },
      payment: rawPayment(),
      milestonePayments: rawMilestones(),
      dispute: { reason: 'Work incomplete', raisedAt: new Date('2026-02-01') },
    };
    mocks.bookingFind.mockReturnValue(query([booking]));

    const res = response();
    await getMyDisputes(
      { user: user(role, userId) } as any,
      res as any,
      vi.fn() as any
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.body.success).toBe(true);
    const item = res.body.data.items[0];
    const serialized = JSON.stringify(res.body);
    expectNoRawDiagnostics(serialized);
    expect(item.dispute.reason).toBe('Work incomplete');
    expect(item.payment.refunds[0].reason).toBe('Customer cancellation: requirements changed');
    expect(item.payment.refundReason).toBe('Customer accepted negotiated refund');

    if (role === 'customer') {
      expect(item.payment.invoiceNumber).toBe('FIX-1');
      expect(item.payment.supplierInvoiceNumber).toBeUndefined();
      expect(item.payment.supplierInvoiceUrl).toBeUndefined();
    } else {
      expect(item.payment.supplierInvoiceNumber).toBe('SUP-1');
      expect(item.payment.invoiceNumber).toBeUndefined();
      expect(item.payment.invoiceUrl).toBeUndefined();
      expect(item.payment.stripeClientSecret).toBeUndefined();
    }
  });

  it('sanitizes the booking returned after raising an extra-cost dispute', async () => {
    const booking = makeBooking({ status: 'professional_completed', extraCosts: [{ amount: 20 }] });
    const disputedBooking = makeBooking({ status: 'dispute' });
    mocks.bookingFindById.mockResolvedValue(booking);
    mocks.bookingFindOneAndUpdate.mockResolvedValue(disputedBooking);

    const res = response();
    await customerDisputeExtraCosts(
      {
        params: { bookingId: 'booking-1' },
        body: { reason: 'Added costs were not agreed' },
        user: user('customer'),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    const serialized = JSON.stringify(res.body);
    expectNoRawDiagnostics(serialized);
    const payment = res.body.data.booking.payment;
    expect(payment.transferFailureReason).toBeUndefined();
    expect(payment.extraCostTransferFailureReason).toBeUndefined();
    expect(payment.refundNotes).toBeUndefined();
    expect(payment.metadata).toBeUndefined();
    expect(payment.refunds[0].notes).toBeUndefined();
    expect(payment.refunds[0].refundId).toBeUndefined();
    expect(payment.supplierInvoiceNumber).toBeUndefined();
    expect(res.body.data.booking.milestonePayments[0].stripeClientSecret).toBeUndefined();
  });

  it.each([
    ['customer', 'customer-1'],
    ['professional', 'professional-1'],
  ] as const)('sanitizes the status-mutation response for %s', async (role, userId) => {
    const booking = makeBooking({ customer: role === 'customer' ? userId : 'customer-1', professional: role === 'professional' ? userId : 'professional-1' });
    mocks.bookingFindById.mockResolvedValue(booking);

    const res = response();
    await updateBookingStatusWithPayment(
      {
        params: { bookingId: 'booking-1' },
        body: { status: 'cancelled' },
        user: user(role, userId),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.status).toBe('cancelled');
    expect(res.body.data.booking.payment.amount).toBe(100);
  });

  it('sanitizes the already-paid payment-intent response', async () => {
    const booking = makeBooking({
      status: 'completed',
      payment: { ...rawPayment(), status: 'completed' },
      milestonePayments: [],
    });
    mocks.bookingFindById.mockReturnValue(query(booking));

    const res = response();
    await ensurePaymentIntent(
      { params: { bookingId: 'booking-1' }, body: {}, user: user('customer') } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expect(res.body.data.booking.payment.status).toBe('completed');
    expectNoRawDiagnostics(JSON.stringify(res.body));
  });

  it('sanitizes the schedule response for the customer', async () => {
    const booking = makeBooking({
      status: 'quote_accepted',
      project: null,
      customer: { _id: 'customer-1', name: 'Customer' },
      professional: { _id: 'professional-1', name: 'Professional' },
      scheduledExecutionEndDate: new Date('2099-01-05'),
    });
    mocks.bookingFindById.mockReturnValue(query(booking));

    const res = response();
    await setBookingSchedule(
      {
        params: { bookingId: 'booking-1' },
        body: { scheduledStartDate: '2099-01-02', scheduledStartTime: '09:00' },
        user: user('customer'),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.payment.refundReason).toBe('Customer accepted negotiated refund');
  });

  it('sanitizes the reschedule-request response for the professional', async () => {
    const booking = makeBooking({
      professional: { _id: 'professional-1', name: 'Professional' },
      customer: { _id: 'customer-1', name: 'Customer' },
      project: null,
      scheduledExecutionEndDate: new Date('2099-01-05'),
      scheduledBufferEndDate: new Date('2099-01-05'),
    });
    mocks.bookingFindById.mockReturnValue(query(booking));

    const res = response();
    await requestBookingReschedule(
      {
        params: { bookingId: 'booking-1' },
        body: { scheduledStartDate: '2099-02-02', reason: 'Site unavailable' },
        user: user('professional'),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.payment.invoiceNumber).toBeUndefined();
    expect(res.body.data.booking.payment.supplierInvoiceNumber).toBe('SUP-1');
  });

  it('sanitizes the reschedule-resolution response for the customer', async () => {
    const booking = makeBooking({
      status: 'rescheduling_requested',
      customer: { _id: 'customer-1', name: 'Customer' },
      professional: { _id: 'professional-1', name: 'Professional' },
      rescheduleRequest: {
        status: 'pending',
        requestedBy: 'professional-1',
        requestedAt: new Date('2026-01-01'),
        reason: 'Site unavailable',
        proposedSchedule: {},
      },
    });
    mocks.bookingFindById.mockReturnValue(query(booking));

    const res = response();
    await respondToBookingReschedule(
      {
        params: { bookingId: 'booking-1' },
        body: { action: 'accept' },
        user: user('customer'),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.payment.supplierInvoiceNumber).toBeUndefined();
  });

  it('sanitizes the execution-extension response for the professional', async () => {
    const booking = makeBooking({
      status: 'in_progress',
      scheduledStartDate: new Date('2026-01-01'),
      scheduledExecutionEndDate: new Date('2026-01-05'),
    });
    mocks.bookingFindById.mockReturnValue(query(booking));

    const res = response();
    await extendBookingExecution(
      {
        params: { bookingId: 'booking-1' },
        body: { newExecutionEndDate: '2026-01-10' },
        user: user('professional'),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.payment.invoiceNumber).toBeUndefined();
    expect(res.body.data.booking.payment.supplierInvoiceNumber).toBe('SUP-1');
  });

  it('sanitizes bookings returned inside professional refund requests', async () => {
    mocks.bookingDistinct.mockResolvedValue(['booking-1']);
    mocks.bookingFind.mockReturnValue({ distinct: mocks.bookingDistinct });
    const booking = {
      _id: 'booking-1',
      bookingNumber: 'BK-1',
      status: 'booked',
      payment: rawPayment(),
      milestonePayments: rawMilestones(),
      project: { title: 'Project' },
    };
    mocks.cancellationFind.mockReturnValue(
      query([
        {
          _id: 'request-1',
          status: 'pending',
          reason: 'Customer cancellation',
          booking,
          requestedBy: { _id: 'customer-1', name: 'Customer' },
        },
      ])
    );

    const res = response();
    await listProfessionalRefundRequests(
      { user: user('professional') } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    const returned = res.body.data.requests[0];
    expect(returned.reason).toBe('Customer cancellation');
    expect(returned.booking.payment.supplierInvoiceNumber).toBe('SUP-1');
    expect(returned.booking.payment.invoiceNumber).toBeUndefined();
    expect(returned.booking.payment.totalWithVat).toBe(121);
  });
});

describe('payment history and quotation response serialization', () => {
  it('sanitizes customer payment history documents and their artifact history', async () => {
    mocks.userFindById.mockResolvedValue({ _id: CUSTOMER_ID, role: 'customer' });
    mocks.paymentFind.mockReturnValue(
      query([
        {
          _id: 'payment-1',
          status: 'completed',
          amount: 100,
          totalWithVat: 121,
          transferFailureReason: RAW_PROVIDER_TEXT,
          extraCostTransferFailureReason: RAW_PROVIDER_TEXT,
          refundNotes: RAW_PROVIDER_TEXT,
          refunds: [
            {
              amount: 10,
              reason: 'Customer cancellation',
              notes: `raw ${RAW_PROVIDER_TEXT}`,
            },
          ],
          metadata: { transferError: RAW_PROVIDER_TEXT, transferFailed: true },
          peppolDispatchReason: RAW_PEPPOL_TEXT,
          invoiceNumber: 'FIX-1',
          supplierInvoiceNumber: 'SUP-1',
          invoiceArtifactHistory: [
            { side: 'customer', invoiceNumber: 'FIX-OLD' },
            { side: 'supplier', invoiceNumber: 'SUP-OLD' },
          ],
          manualArtifactClaims: [
            { side: 'customer', invoiceNumber: 'FIX-MANUAL' },
            { side: 'supplier', invoiceNumber: 'SUP-MANUAL' },
          ],
        },
      ])
    );
    mocks.paymentCountDocuments.mockResolvedValue(1);
    mocks.paymentAggregate.mockResolvedValue([{ _id: 'completed', count: 1, total: 121 }]);

    const res = response();
    await getMyPayments(
      { user: user('customer', CUSTOMER_ID), query: {} } as any,
      res as any,
      vi.fn() as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    const payment = res.body.data.payments[0];
    expect(payment.status).toBe('completed');
    expect(payment.amount).toBe(100);
    expect(payment.refunds[0].reason).toBe('Customer cancellation');
    expect(payment.metadata).toBeUndefined();
    expect(payment.invoiceNumber).toBe('FIX-1');
    expect(payment.supplierInvoiceNumber).toBeUndefined();
    expect(payment.invoiceArtifactHistory).toEqual([
      expect.objectContaining({ side: 'customer', invoiceNumber: 'FIX-OLD' }),
    ]);
    expect(payment.manualArtifactClaims).toEqual([
      expect.objectContaining({ side: 'customer', invoiceNumber: 'FIX-MANUAL' }),
    ]);
  });

  it('sanitizes the quote-submission response for a professional', async () => {
    const booking = makeBooking({ status: 'rfq', professional: PROFESSIONAL_ID });
    mocks.bookingFindById.mockResolvedValue(booking);

    const res = response();
    await submitQuote(
      {
        params: { bookingId: 'booking-1' },
        body: { amount: 100, currency: 'EUR', description: 'Work' },
        user: user('professional', PROFESSIONAL_ID),
      } as any,
      res as any,
      vi.fn() as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.booking.payment.invoiceNumber).toBeUndefined();
    expect(res.body.booking.payment.supplierInvoiceNumber).toBe('SUP-1');
  });

  it('sanitizes the RFQ response for a professional', async () => {
    const booking = makeBooking({
      status: 'rfq',
      customer: { _id: CUSTOMER_ID, name: 'Customer' },
      professional: { _id: PROFESSIONAL_ID, name: 'Professional' },
    });
    mocks.bookingFindById.mockReturnValue(query(booking));

    const res = response();
    await respondToRFQ(
      {
        params: { bookingId: 'booking-1' },
        body: { action: 'accepted' },
        user: user('professional', PROFESSIONAL_ID),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.payment.invoiceNumber).toBeUndefined();
    expect(res.body.data.booking.payment.supplierInvoiceNumber).toBe('SUP-1');
  });

  it('sanitizes the quotation-rejection response for a customer', async () => {
    const booking = makeBooking({
      status: 'quoted',
      customer: { _id: CUSTOMER_ID, name: 'Customer' },
      professional: { _id: PROFESSIONAL_ID, name: 'Professional', businessInfo: {} },
    });
    mocks.bookingFindById.mockReturnValue(query(booking));
    mocks.bookingFindOneAndUpdate.mockResolvedValue({
      ...booking,
      status: 'quote_rejected',
      customerRejectionReason: 'Too expensive',
    });

    const res = response();
    await customerRespondToQuotation(
      {
        params: { bookingId: 'booking-1' },
        body: { action: 'rejected', rejectionReason: 'Too expensive' },
        user: user('customer', CUSTOMER_ID),
      } as any,
      res as any
    );

    expect(res.body.success).toBe(true);
    expectNoRawDiagnostics(JSON.stringify(res.body));
    expect(res.body.data.booking.payment.invoiceNumber).toBe('FIX-1');
    expect(res.body.data.booking.payment.supplierInvoiceNumber).toBeUndefined();
    expect(res.body.data.booking.customerRejectionReason).toBe('Too expensive');
  });
});
