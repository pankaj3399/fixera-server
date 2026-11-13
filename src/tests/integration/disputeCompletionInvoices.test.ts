import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// FT3 #10 (13a/13b) and FT3 #5: post-resolution invoice work runs through
// waitUntil, survives a failed capture/transfer, reflects the admin-adjusted
// extra cost, and partial-refund invoices carry the negotiated/dispute note.
const mocks = vi.hoisted(() => ({
  pending: [] as Promise<unknown>[],
  waitUntil: vi.fn(),
  capture: vi.fn(),
  invoices: vi.fn(),
  credits: vi.fn(),
  refund: vi.fn(),
  refundList: vi.fn(),
  notify: vi.fn(async () => undefined),
}));
vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }));
vi.mock('../../services/stripe', () => ({
  stripe: {
    refunds: { create: mocks.refund, list: mocks.refundList },
    transfers: { createReversal: vi.fn(), create: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
  },
  STRIPE_CONFIG: { supportedCurrencies: ['EUR'], defaultCurrency: 'EUR', environment: 'test' },
}));
vi.mock('../../handlers/Stripe/payment', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../handlers/Stripe/payment')>(),
  captureAndTransferPayment: mocks.capture,
}));
vi.mock('../../services/invoiceArtifacts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/invoiceArtifacts')>(),
  ensureBookingInvoiceArtifacts: mocks.invoices,
  ensurePartialRefundCreditArtifacts: mocks.credits,
}));
vi.mock('../../utils/notifications/notify', () => ({ notify: mocks.notify }));
vi.mock('../../utils/auditLogger', () => ({ auditLog: vi.fn(async () => undefined) }));

import Booking from '../../models/booking';
import User from '../../models/user';
import Payment from '../../models/payment';
import CancellationRequest from '../../models/cancellationRequest';
import CalendarReservation from '../../models/calendarReservation';
import { resolveDispute } from '../../handlers/Admin/disputeManagement';
import { customerRespondToCounterOffer } from '../../handlers/Booking/refundNegotiation';
import { buildUblInvoiceXml } from '../../services/invoiceArtifacts';
import { generateBookingInvoice } from '../../services/invoiceGenerator';
import { normalizeInvoiceBasis } from '../../utils/milestoneInvoice';
import { inflateSync } from 'node:zlib';

const uri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = uri && /test/i.test(uri) ? describe : describe.skip;
const proId = new Types.ObjectId();
const customerId = new Types.ObjectId();
const adminId = new Types.ObjectId();
const platform = { name: 'Fixtract', vatNumber: 'BE1002103337', country: 'BE' };

const response = () => ({
  statusCode: 200, body: undefined as any,
  status(code: number) { this.statusCode = code; return this; },
  json(body: unknown) { this.body = body; return this; },
});

/** Run everything the handler registered with waitUntil, like Vercel does. */
const drainWaitUntil = async () => {
  while (mocks.pending.length) await Promise.allSettled(mocks.pending.splice(0));
};

const loadInvoiceBooking = async (id: Types.ObjectId) => {
  const booking: any = await Booking.findById(id).populate('customer').populate('professional');
  booking.__commissionPercent = 10;
  booking.__supplierVatDecision = { reverseCharge: false, appliedRate: 21 };
  return booking;
};

const pdfText = (pdf: Buffer): string => {
  const parts: string[] = [];
  let offset = 0;
  while (true) {
    const start = pdf.indexOf('stream', offset);
    if (start < 0) break;
    let contentStart = start + 6;
    if (pdf[contentStart] === 13) contentStart += 1;
    if (pdf[contentStart] === 10) contentStart += 1;
    const end = pdf.indexOf('endstream', contentStart);
    if (end < 0) break;
    try { parts.push(inflateSync(pdf.subarray(contentStart, end)).toString('latin1')); } catch { /* not text */ }
    offset = end + 9;
  }
  return [...parts.join('\n').matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
};

const amount = (xml: string, tag: string) => Number(xml.match(new RegExp(`<cbc:${tag}[^>]*>([^<]+)<`))![1]);
const extraCostLines = (xml: string) => [...xml.matchAll(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g)]
  .map(([line]) => line).filter((line) => line.includes('Extra cost:'))
  .map((line) => Number(line.match(/<cbc:LineExtensionAmount[^>]*>([^<]+)</)![1]));

describeDb('dispute completion and partial-refund invoices', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName: `dispute_invoices_${process.pid}_${Date.now().toString(36)}` });
    await CalendarReservation.createIndexes();
  });
  afterAll(async () => {
    await drainWaitUntil();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.pending.length = 0;
    mocks.waitUntil.mockImplementation((promise: Promise<unknown>) => { mocks.pending.push(promise); });
    mocks.invoices.mockResolvedValue(null);
    mocks.credits.mockResolvedValue('generate');
    mocks.refundList.mockResolvedValue({ data: [], has_more: false });
    mocks.refund.mockResolvedValue({ id: 're_dispute_invoices', status: 'succeeded', created: Math.floor(Date.now() / 1000) });
    await Promise.all([Booking.collection.deleteMany({}), User.collection.deleteMany({}), Payment.collection.deleteMany({}),
      CancellationRequest.collection.deleteMany({}), CalendarReservation.collection.deleteMany({})]);
    await User.collection.insertMany([
      { _id: proId, role: 'professional', name: 'Professional', email: 'pro@dispute-invoices.test',
        businessInfo: { companyName: 'Pro BV', country: 'BE', vatNumber: 'BE0123456848' } },
      { _id: customerId, role: 'customer', name: 'Customer', email: 'customer@dispute-invoices.test', location: { country: 'BE' } },
      { _id: adminId, role: 'admin', name: 'Admin', email: 'admin@dispute-invoices.test' },
    ] as any[]);
  });

  // Professional 100 + 10% commission = 110 net, 21% VAT = 133.10 paid.
  // Extra cost 80 (professional) = 88 customer net, 106.48 gross, disputed.
  const seedExtraCostDispute = async () => {
    const id = new Types.ObjectId();
    await Booking.collection.insertOne({
      _id: id, bookingNumber: `BK-DI-${String(id).slice(-6)}`, bookingType: 'professional',
      customer: customerId, professional: proId, status: 'dispute',
      location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, reverseCharge: false },
      rfqData: { serviceType: 'Plumbing', description: 'Dispute invoice fixture' },
      quote: { amount: 100, currency: 'EUR', description: 'Service' },
      dispute: { type: 'extra_costs', raisedAt: new Date(), raisedBy: customerId, reason: 'Extra cost too high',
        description: 'The extra work took one hour, not three' },
      extraCosts: [{ type: 'condition', name: 'Extra work', justification: 'Hidden leak', amount: 80 }],
      extraCostTotal: 80, extraCostStatus: 'disputed',
      payment: {
        status: 'completed', stripePaymentIntentId: 'pi_dispute_invoices', currency: 'EUR',
        amount: 110, netAmount: 110, vatAmount: 23.1, vatRate: 21, totalWithVat: 133.1, professionalPayout: 100,
        extraCostAmount: 106.48, extraCostCustomerNetAmount: 88, extraCostVatAmount: 18.48,
      },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    return id;
  };

  it.each([
    ['adjust', 50, { customerExtra: [55], customerTotal: 199.65, supplierExtra: [50], supplierNet: 150, supplierTotal: 181.5 }],
    ['reject_extra_costs', 0, { customerExtra: [], customerTotal: 133.1, supplierExtra: [], supplierNet: 100, supplierTotal: 121 }],
  ] as const)('admin completion (%s → %s) still generates invoices when capture throws, with the resolved extra cost', async (action, adjusted, expected) => {
    const id = await seedExtraCostDispute();
    mocks.capture.mockRejectedValue(new Error('Stripe capture unavailable'));
    const built: { customer?: string; supplier?: string; customerPdf?: string; supplierPdf?: string } = {};
    mocks.invoices.mockImplementation(async (bookingId: string) => {
      const booking = await loadInvoiceBooking(new Types.ObjectId(bookingId));
      built.customer = buildUblInvoiceXml(booking, 'FIX-DI', new Date(), { selfBilling: false, platform });
      built.supplier = buildUblInvoiceXml(booking, 'SUP-DI', new Date(), { selfBilling: true, platform });
      built.customerPdf = pdfText((await generateBookingInvoice(booking, { kind: 'customer' })).pdfBuffer);
      built.supplierPdf = pdfText((await generateBookingInvoice(booking, { kind: 'self_bill' })).pdfBuffer);
      return null;
    });
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(id) },
      body: { action, ...(action === 'adjust' ? { adjustedAmount: adjusted } : {}), resolution: 'Admin decided the extra cost' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.booking.status).toBe('completed');
    // The work is registered with waitUntil, not left as untracked work.
    expect(mocks.waitUntil).toHaveBeenCalled();
    await drainWaitUntil();
    expect(mocks.capture).toHaveBeenCalledWith(String(id));
    expect(mocks.invoices).toHaveBeenCalledWith(String(id));
    expect((await Booking.findById(id).lean())?.extraCostTotal).toBe(adjusted);

    expect(extraCostLines(built.customer!)).toEqual(expected.customerExtra);
    expect(amount(built.customer!, 'TaxInclusiveAmount')).toBe(expected.customerTotal);
    expect(extraCostLines(built.supplier!)).toEqual(expected.supplierExtra);
    expect(amount(built.supplier!, 'TaxExclusiveAmount')).toBe(expected.supplierNet);
    expect(amount(built.supplier!, 'TaxInclusiveAmount')).toBe(expected.supplierTotal);
    expect(built.customerPdf).toContain(expected.customerTotal.toFixed(2));
    expect(built.supplierPdf).toContain(expected.supplierTotal.toFixed(2));
    expect(built.customerPdf!.includes('Extra cost: Extra work')).toBe(expected.customerExtra.length > 0);
    expect(built.supplierPdf!.includes('Extra cost: Extra work')).toBe(expected.supplierExtra.length > 0);
    expect(built.customerPdf).not.toContain('88.00');
  }, 30000);

  it('generates invoices after a successful capture too', async () => {
    const id = await seedExtraCostDispute();
    mocks.capture.mockResolvedValue({ success: false, error: 'already captured' });
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(id) },
      body: { action: 'accept_professional', resolution: 'Extra cost justified' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    await drainWaitUntil();
    expect(mocks.invoices).toHaveBeenCalledTimes(1);
  }, 30000);

  // FT3 #5: the refund block's description on the remainder invoice.
  const seedPaidBooking = async (status: string, dispute?: Record<string, unknown>) => {
    const id = new Types.ObjectId();
    await Booking.collection.insertOne({
      _id: id, bookingNumber: `BK-RN-${String(id).slice(-6)}`, bookingType: 'professional',
      customer: customerId, professional: proId, status, statusBeforeDispute: 'in_progress', scheduleTimeZone: 'UTC',
      location: { type: 'Point', coordinates: [4.35, 50.85], country: 'BE' },
      vatDecision: { action: 'standard_rate', country: 'BE', standardRate: 21, appliedRate: 21, reverseCharge: false },
      rfqData: { serviceType: 'Plumbing', description: 'Refund note fixture' },
      quote: { amount: 100, currency: 'EUR', description: 'Service' },
      ...(dispute ? { dispute } : {}),
      payment: { status: 'completed', stripePaymentIntentId: `pi_${id}`, currency: 'EUR',
        amount: 100, netAmount: 100, vatAmount: 21, vatRate: 21, totalWithVat: 121 },
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    return id;
  };

  const refundBlock = async (id: Types.ObjectId) => {
    const booking = await loadInvoiceBooking(id);
    const basis = normalizeInvoiceBasis(booking, 10);
    const text = pdfText((await generateBookingInvoice(booking, { kind: 'customer' })).pdfBuffer);
    const ubl = buildUblInvoiceXml(booking, 'FIX-RN', new Date(), { selfBilling: false, platform });
    return { booking, basis, text, ubl };
  };

  it('negotiated refund: the invoice shows the negotiated note under the refund', async () => {
    const id = await seedPaidBooking('in_progress');
    await CancellationRequest.create({ booking: id, requestedBy: customerId, requestedRole: 'customer',
      status: 'negotiating', reason: 'Only half of the work was done', counterOfferAmount: 50,
      professionalDecision: 'counter', professionalNote: 'Materials already bought, refunding labour only' });
    const res = response();
    await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(id) },
      body: { decision: 'accept' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    await drainWaitUntil();
    expect(mocks.credits).toHaveBeenCalledWith(String(id));
    const { booking, basis, text, ubl } = await refundBlock(id);
    expect(booking.payment.status).toBe('partially_refunded');
    expect(booking.cancellation.refundNote).toBe('Materials already bought, refunding labour only');
    expect(basis.refund?.reason).toBe('Customer accepted negotiated refund: Only half of the work was done');
    expect(basis.refund?.description).toBe('Materials already bought, refunding labour only');
    expect(text).toContain('Materials already bought, refunding labour only');
    expect(ubl).toContain('— Materials already bought, refunding labour only</cbc:Note>');
  }, 30000);

  it('negotiated refund without a note: the requester description is already the reason, never printed twice', async () => {
    const id = await seedPaidBooking('in_progress');
    await CancellationRequest.create({ booking: id, requestedBy: customerId, requestedRole: 'customer',
      status: 'negotiating', reason: 'Only half of the work was done', counterOfferAmount: 50 });
    const res = response();
    await customerRespondToCounterOffer({ user: { _id: customerId }, params: { bookingId: String(id) },
      body: { decision: 'accept' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    await drainWaitUntil();
    const { booking, basis, text } = await refundBlock(id);
    expect(booking.cancellation.refundNote).toBe('Only half of the work was done');
    expect(basis.refund?.description).toBeUndefined();
    expect(text.split('Only half of the work was done')).toHaveLength(2);
  }, 30000);

  it('dispute refund: the invoice shows the requester description next to the admin resolution', async () => {
    const id = await seedPaidBooking('dispute', { type: 'refund_request', raisedAt: new Date(), raisedBy: customerId,
      reason: 'Work not finished', description: 'The bathroom tiles were never grouted' });
    const res = response();
    await resolveDispute({ user: { _id: adminId }, params: { bookingId: String(id) },
      body: { forceStatus: 'refunded', action: 'adjust', adjustedAmount: 50, resolution: 'Refund the grouting part' } } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(mocks.waitUntil).toHaveBeenCalled();
    await drainWaitUntil();
    expect(mocks.credits).toHaveBeenCalledWith(String(id));
    const { booking, basis, text, ubl } = await refundBlock(id);
    expect(booking.payment.status).toBe('partially_refunded');
    expect(booking.cancellation.refundNote).toBe('The bathroom tiles were never grouted');
    expect(basis.refund?.reason).toBe('Dispute resolution (refund_request): Refund the grouting part');
    expect(basis.refund?.description).toBe('The bathroom tiles were never grouted');
    expect(text).toContain('Refund the grouting part');
    expect(text).toContain('The bathroom tiles were never grouted');
    expect(ubl).toContain('Refund the grouting part — The bathroom tiles were never grouted</cbc:Note>');
  }, 30000);
});
