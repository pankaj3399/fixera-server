import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
});

import { buildBookingSnapshot } from '../../utils/bookingDetails/snapshot';
import { buildQuoteCustomerTotals, resolveAcceptedQuoteVersion } from '../../utils/bookingDetails/quoteTotals';
import { buildBookingDetails } from '../../utils/bookingDetails/projection';
import { buildBookingActivity } from '../../utils/bookingDetails/timeline';
import {
  isUploadOwnedByUser,
  presignOwnedUrl,
} from '../../utils/bookingDetails/attachments';
import type { ActorMap } from '../../utils/bookingDetails/actors';

const customerId = new Types.ObjectId('507f1f77bcf86cd799439011');
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');
const adminId = new Types.ObjectId('507f1f77bcf86cd799439013');
const projectId = new Types.ObjectId('507f1f77bcf86cd799439014');
const bookingId = new Types.ObjectId('507f1f77bcf86cd799439015');
const quoteTime = new Date('2026-02-01T10:00:00.000Z');
const acceptedTime = new Date('2026-02-02T10:00:00.000Z');
const paidTime = new Date('2026-02-03T10:00:00.000Z');

const project = () => ({
  _id: projectId,
  title: 'Bathroom renovation',
  description: 'Full bathroom',
  category: 'Renovation',
  service: 'Bathroom',
  areaOfWork: 'Interior',
  priceModel: 'fixed',
  timeMode: 'days',
  media: { images: ['https://fixera-uploads.s3.us-east-1.amazonaws.com/project-images/one.jpg'] },
  minResources: 2,
  minOverlapPercentage: 50,
  resources: ['507f1f77bcf86cd799439099'],
  subprojects: [
    {
      _id: 'sub-1',
      name: 'Standard package',
      description: 'Standard work',
      projectType: ['renovation'],
      pricing: { type: 'fixed', amount: 100 },
      included: [{ name: 'Labour', description: 'All labour', isCustom: false }],
      materialsIncluded: true,
      materials: [{ name: 'Tiles', quantity: '10', unit: 'm2' }],
      preparationDuration: { value: 1, unit: 'days' },
      executionDuration: { value: 2, unit: 'days' },
      buffer: { value: 1, unit: 'days' },
      warrantyPeriod: { value: 2, unit: 'years' },
      professionalInputs: [{ fieldName: 'secret', value: 'internal' }],
    },
  ],
  extraOptions: [{ _id: 'opt-1', name: 'Deep clean', description: 'Extra clean', price: 20 }],
  termsConditions: [{ name: 'Access', description: 'Access required', type: 'condition', isCustom: false }],
  rfqQuestions: [{ _id: 'q-1', question: 'Building type?', type: 'text', isRequired: true }],
  postBookingQuestions: [
    { _id: 'pq-1', question: 'Parking?', type: 'text', isRequired: false },
    { _id: 'pq-2', question: 'Pets?', type: 'text', isRequired: false },
  ],
  customConfirmationMessage: 'See you soon',
});

const customer = () => ({
  _id: customerId,
  name: 'Carla Customer',
  username: 'carla',
  email: 'carla@example.com',
  phone: '+3212345678',
  customerType: 'business',
  businessName: 'Carla BV',
  vatNumber: 'BE0123456789',
  timeZone: 'Europe/Brussels',
  location: {
    address: 'Main street 1',
    city: 'Brussels',
    country: 'BE',
    postalCode: '1000',
    coordinates: [4.35, 50.85],
  },
});

const professional = () => ({
  _id: professionalId,
  name: 'Piet Professional',
  username: 'piet',
  email: 'piet@example.com',
  phone: '+3298765432',
  vatNumber: 'BE0987654321',
  timeZone: 'Europe/Brussels',
  businessInfo: {
    companyName: 'Piet Works',
    website: 'https://piet.example',
    city: 'Ghent',
    country: 'BE',
    timezone: 'Europe/Brussels',
  },
});

const booking = (overrides: Record<string, any> = {}) => {
  const base = {
    _id: bookingId,
    bookingNumber: 'BK-2026-000001',
    quotationNumber: 'QT-2026-000001',
    bookingType: 'project',
    status: 'booked',
    customer: customer(),
    professional: professional(),
    project: project(),
    selectedSubprojectIndex: 0,
    selectedExtraOptions: [{ extraOptionId: 'opt-1', bookedPrice: 20 }],
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
      answers: [{ questionId: 'q-1', question: 'Building type?', answer: 'House', fieldType: 'text' }],
    },
    vatDecision: {
      action: 'standard_rate',
      country: 'BE',
      standardRate: 21,
      appliedRate: 21,
      answers: [{ fieldName: 'propertyNature', value: 'immovable' }],
    },
    checkoutSnapshot: {
      pricingType: 'fixed',
      unitAmount: 100,
      quantity: 1,
      baseSubtotal: 100,
      extraOptionsTotal: 20,
      totalAmount: 120,
      currency: 'EUR',
      selectedOptions: [{ extraOptionId: 'opt-1', name: 'Deep clean', unitPrice: 20, quantity: 1, totalPrice: 20 }],
    },
    quoteVersions: [
      {
        version: 1,
        quotationNumber: 'QT-2026-000001-v1',
        scope: 'Bathroom renovation',
        warrantyDuration: { value: 2, unit: 'years' },
        materialsIncluded: true,
        materials: [{ name: 'Tiles', quantity: 10, unit: 'm2', description: 'White' }],
        description: 'Full scope',
        pricingLines: [{ description: 'Work', price: 100, vatRate: 21, vatCountry: 'BE' }],
        totalAmount: 100,
        currency: 'EUR',
        milestones: [],
        preparationDuration: { value: 1, unit: 'days' },
        executionDuration: { value: 2, unit: 'days' },
        validUntil: new Date('2026-03-01T00:00:00.000Z'),
        createdAt: quoteTime,
        changeNote: 'Initial quotation',
        createdBy: professionalId,
        customerTotals: {
          commissionPercent: 10,
          professionalNetAmount: 100,
          customerNetAmount: 110,
          amountBeforeDiscounts: 110,
          vatAmount: 21,
          vatRate: 21,
          totalWithVat: 131,
          totalAmount: 131,
          currency: 'EUR',
          recordedAt: quoteTime,
        },
        serviceLocation: { country: 'BE', address: 'Main street 1', city: 'Brussels', postalCode: '1000' },
      },
    ],
    currentQuoteVersion: 1,
    acceptedQuoteVersion: 1,
    acceptedQuotationNumber: 'QT-2026-000001-v1',
    statusHistory: [
      { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), note: 'Booking created' },
      {
        status: 'quoted',
        timestamp: quoteTime,
        updatedBy: professionalId,
        note: 'Quotation submitted by professional',
      },
      {
        status: 'quote_accepted',
        timestamp: acceptedTime,
        updatedBy: customerId,
        note: 'Customer accepted quotation',
      },
      {
        status: 'booked',
        timestamp: paidTime,
        note: 'Payment confirmed — booking confirmed',
      },
    ],
    postBookingData: [],
    extraCosts: [],
    notes: 'INTERNAL SECRET NOTE',
    createdAt: new Date('2026-01-20T09:00:00.000Z'),
    updatedAt: paidTime,
  };
  return { ...base, ...overrides };
};

const payment = (overrides: Record<string, any> = {}) => ({
  _id: new Types.ObjectId('507f1f77bcf86cd799439020'),
  booking: bookingId,
  customer: customerId,
  professional: professionalId,
  status: 'completed',
  method: 'card',
  currency: 'EUR',
  amount: 110,
  netAmount: 110,
  vatAmount: 21,
  vatRate: 21,
  totalWithVat: 131,
  platformCommission: 10,
  professionalPayout: 100,
  stripeFeeAmount: 4.9,
  stripePaymentIntentId: 'pi_secret_123',
  stripeChargeId: 'ch_secret_123',
  stripeTransferId: 'tr_secret_123',
  metadata: { providerError: 'do not leak' },
  authorizedAt: paidTime,
  capturedAt: paidTime,
  refundNotes: 'INTERNAL REFUND NOTE',
  transferFailureReason: 'INTERNAL TRANSFER ERROR',
  invoiceNumber: 'FIX-1',
  invoiceUrl: 'https://fixera-uploads.s3.us-east-1.amazonaws.com/invoices/customer.pdf',
  supplierInvoiceNumber: 'SUP-1',
  supplierInvoiceUrl: 'https://fixera-uploads.s3.us-east-1.amazonaws.com/invoices/supplier.pdf',
  refunds: [],
  ...overrides,
});

const actors: ActorMap = new Map([
  [String(customerId), {
    id: String(customerId),
    name: 'Carla Customer',
    username: 'carla',
    email: 'carla@example.com',
    role: 'customer',
    companyName: null,
  }],
  [String(professionalId), {
    id: String(professionalId),
    name: 'Piet Professional',
    username: 'piet',
    email: 'piet@example.com',
    role: 'professional',
    companyName: 'Piet Works',
  }],
  [String(adminId), {
    id: String(adminId),
    name: 'Ada Admin',
    username: 'ada',
    email: 'ada@example.com',
    role: 'admin',
    companyName: null,
  }],
]);

const buildDetails = async (viewerRole: 'customer' | 'professional' | 'admin', overrides: Record<string, any> = {}) => {
  const sourceBooking = booking(overrides.booking || {});
  const cancellations = overrides.cancellations ?? [];
  return buildBookingDetails({
    booking: {
      ...sourceBooking,
      __cancellationRequests: cancellations,
    },
    payments: overrides.payments ?? [payment()],
    cancellations,
    warrantyClaims: overrides.warrantyClaims ?? [],
    actors: overrides.actors ?? actors,
    viewerRole,
    adminAccess: viewerRole === 'admin'
      ? { bookings: true, disputes: true, warranty: true, cancellations: true, payments: true }
      : undefined,
  });
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('booking snapshot', () => {
  it('copies only the booked project/package facts and survives later project edits', () => {
    const liveProject = project();
    const snapshot = buildBookingSnapshot({
      booking: booking(),
      project: liveProject,
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
      capturedAt: quoteTime,
      vatQuestions: [{ fieldName: 'propertyNature', question: 'Property type', type: 'select' }],
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.capturedAt).toEqual(quoteTime);
    expect(snapshot!.project?.title).toBe('Bathroom renovation');
    expect(snapshot!.selectedSubproject?.name).toBe('Standard package');
    expect(snapshot!.selectedSubproject?.pricing).toMatchObject({ type: 'fixed', amount: 100 });
    expect(snapshot!.selectedExtraOptions?.[0]).toMatchObject({ name: 'Deep clean', bookedPrice: 20 });
    expect(snapshot!.questions?.postBooking).toHaveLength(2);
    expect(snapshot!.questions?.vat?.[0]).toMatchObject({ fieldName: 'propertyNature' });

    // Whitelist: no internal professional inputs, resource ids, certifications or secrets.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('professionalInputs');
    expect(serialized).not.toContain('507f1f77bcf86cd799439099');
    expect(serialized).not.toContain('secret');

    // Later live edits must not mutate the captured object.
    liveProject.title = 'Renamed after booking';
    liveProject.subprojects[0].pricing.amount = 999;
    liveProject.termsConditions[0].description = 'Changed after booking';
    expect(snapshot!.project?.title).toBe('Bathroom renovation');
    expect(snapshot!.selectedSubproject?.pricing).toMatchObject({ amount: 100 });
    expect(snapshot!.project?.termsConditions?.[0]?.description).toBe('Access required');
  });

  it('strips presigned query strings and external urls from media', () => {
    const liveProject = project();
    liveProject.media.images = [
      'https://fixera-uploads.s3.us-east-1.amazonaws.com/project-images/one.jpg?X-Amz-Signature=expiring',
      'https://evil.example/private.jpg',
    ];
    const snapshot = buildBookingSnapshot({
      booking: booking(),
      project: liveProject,
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
    });
    expect(snapshot!.project?.media?.images).toEqual([
      'https://fixera-uploads.s3.us-east-1.amazonaws.com/project-images/one.jpg',
    ]);
  });

  it('keeps the recorded extra-option quantity instead of replacing it with one', async () => {
    const selected = [{ extraOptionId: 'opt-1', bookedPrice: 40, quantity: 2 }];
    const base = booking({ selectedExtraOptions: selected });
    const snapshot = buildBookingSnapshot({
      booking: base,
      project: project(),
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
    });
    expect(snapshot!.selectedExtraOptions?.[0]).toMatchObject({ quantity: 2, totalPrice: 40 });

    base.bookingSnapshot = snapshot as any;
    const details = await buildDetails('customer', { booking: base });
    expect(details.bookingSnapshot.selectedExtraOptions[0].quantity).toBe(2);
  });
});

describe('quote provenance and totals', () => {
  it('computes the same quote-time customer total as the existing checkout calculation', () => {
    const totals = buildQuoteCustomerTotals({
      booking: booking(),
      totalAmount: 100,
      pricingLines: [{ description: 'Work', price: 100, vatRate: 21 }],
      commissionPercent: 10,
      currency: 'EUR',
      recordedAt: quoteTime,
    });
    expect(totals).toMatchObject({
      commissionPercent: 10,
      professionalNetAmount: 100,
      customerNetAmount: 110,
      amountBeforeDiscounts: 110,
      // VAT is charged on the price after commission: 21% of 110.00.
      vatAmount: 23.1,
      totalWithVat: 133.1,
      totalAmount: 133.1,
      currency: 'EUR',
    });
  });

  it('uses the recorded accepted version and falls back to an explicit inference for legacy rows', () => {
    expect(resolveAcceptedQuoteVersion(booking())).toMatchObject({
      version: 1,
      quotationNumber: 'QT-2026-000001-v1',
      source: 'recorded',
    });
    const legacy = booking({ acceptedQuoteVersion: undefined, acceptedQuotationNumber: undefined });
    expect(resolveAcceptedQuoteVersion(legacy)).toMatchObject({
      version: 1,
      source: 'inferred_current',
    });
  });

  it('returns each version with actor, service location and customer totals intact', async () => {
    const details = await buildDetails('customer');
    const version = details.quotation!.versions[0];
    expect(version.createdBy).toMatchObject({ role: 'professional', name: 'Piet Professional' });
    expect(version.actorRecorded).toBe(true);
    expect(version.serviceLocationRecorded).toBe(true);
    expect(version.customerTotalsRecorded).toBe(true);
    expect(version.customerTotals).toMatchObject({ customerNetAmount: 110, totalWithVat: 131 });
    expect(details.quotation!.acceptedVersion).toMatchObject({ source: 'recorded', version: 1 });
  });

  it('distinguishes direct drafts, RFQ rejection/prequote, and a real quote', async () => {
    const directDraft = booking({
      status: 'draft_quote',
      quotationNumber: undefined,
      quoteVersions: [],
      currentQuoteVersion: undefined,
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      quote: undefined,
      rfqResponse: undefined,
      statusHistory: [{
        status: 'draft_quote',
        timestamp: new Date('2026-02-01T10:00:00.000Z'),
        updatedBy: professionalId,
        note: 'Professional-initiated direct quotation',
      }],
    });
    const draftDetails = await buildDetails('customer', { booking: directDraft });
    expect(draftDetails.quotation).toMatchObject({ status: 'draft', quotationNumber: null });
    expect(draftDetails.booking.quote).toMatchObject({ status: 'draft' });

    const rfqRejected = booking({
      status: 'cancelled',
      quotationNumber: undefined,
      quoteVersions: [],
      currentQuoteVersion: undefined,
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      quote: undefined,
      rfqResponse: {
        action: 'rejected',
        respondedAt: new Date('2026-01-21T10:00:00.000Z'),
        respondedBy: professionalId,
        rejectionReason: 'Not available',
      },
    });
    const rejectedDetails = await buildDetails('customer', { booking: rfqRejected });
    expect(rejectedDetails.quotation?.status).toBe('rejected');
    expect(rejectedDetails.quotation?.status).not.toBe('quoted');
    expect(rejectedDetails.quotation?.versions).toHaveLength(0);

    const rfqPrequote = booking({
      status: 'rfq_accepted',
      quotationNumber: undefined,
      quoteVersions: [],
      currentQuoteVersion: undefined,
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      quote: undefined,
      rfqResponse: {
        action: 'accepted',
        respondedAt: new Date('2026-01-21T10:00:00.000Z'),
        respondedBy: professionalId,
      },
    });
    const prequoteDetails = await buildDetails('customer', { booking: rfqPrequote });
    expect(prequoteDetails.quotation?.status).toBe('none');
    expect(prequoteDetails.quotation?.versions).toHaveLength(0);
    expect(prequoteDetails.quotation?.rfqHistory.map((item) => item.type))
      .toEqual(expect.arrayContaining(['rfq_submitted', 'rfq_accepted']));

    const quoted = await buildDetails('customer');
    expect(quoted.quotation?.status).toBe('accepted');
    expect(quoted.quotation?.versions).toHaveLength(1);
  });

  it('does not turn missing legacy quote-version values into 0/false', async () => {
    const base = booking({
      status: 'quoted',
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      currentQuoteVersion: 1,
    });
    base.quoteVersions = [{
      ...base.quoteVersions[0],
      materialsIncluded: undefined,
      totalAmount: undefined,
      milestones: [{ title: 'Deposit', amount: undefined, dueCondition: 'on_start', order: 0, status: 'pending' }],
      preparationDuration: undefined,
      executionDuration: undefined,
      validUntil: undefined,
      createdAt: quoteTime,
    }];
    const details = await buildDetails('customer', { booking: base });
    const version = details.quotation!.versions[0];
    expect(version.materialsIncluded).toBeNull();
    expect(version.totalAmount).toBeNull();
    expect(version.milestones[0].amount).toBeNull();
    expect(version.preparationDuration).toBeNull();
    expect(version.executionDuration).toBeNull();
    expect(version.validUntil).toBeNull();

    const quoteEvent = details.activity.items.find((item) => item.type === 'quotation_submitted')!;
    expect(quoteEvent.amounts).toBeUndefined();
    expect(quoteEvent.amountLines).toBeUndefined();
  });

  it('attaches a rejection only to the version that was current when it happened', async () => {
    const base = booking({
      status: 'quoted',
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      currentQuoteVersion: 2,
    });
    const v2 = {
      ...base.quoteVersions[0],
      version: 2,
      quotationNumber: 'QT-2026-000001-v2',
      totalAmount: 120,
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
      changeNote: 'Revised after rejection',
    };
    base.quoteVersions = [base.quoteVersions[0], v2];
    base.statusHistory = [
      { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), updatedBy: customerId, note: 'Booking created' },
      { status: 'quoted', timestamp: quoteTime, updatedBy: professionalId, note: 'Quotation submitted by professional' },
      { status: 'quote_rejected', timestamp: new Date('2026-02-01T11:00:00.000Z'), updatedBy: customerId, note: 'Customer rejected quotation: Too expensive' },
      { status: 'quoted', timestamp: new Date('2026-02-02T10:00:00.000Z'), updatedBy: professionalId, note: 'Quotation updated by professional' },
    ];
    const quoted = await buildDetails('customer', { booking: base });
    expect(quoted.quotation?.status).toBe('quoted');
    expect(quoted.quotation?.versions.find((version) => version.version === 1)?.rejectedAt)
      .toBe('2026-02-01T11:00:00.000Z');
    expect(quoted.quotation?.versions.find((version) => version.version === 1)?.rejectionReason)
      .toBe('Too expensive');
    expect(quoted.quotation?.versions.find((version) => version.version === 2)?.rejectedAt).toBeNull();
    expect(quoted.quotation?.versions.find((version) => version.version === 2)?.rejectionReason).toBeNull();

    const accepted = booking({
      status: 'completed',
      currentQuoteVersion: 2,
      acceptedQuoteVersion: 2,
      acceptedQuotationNumber: 'QT-2026-000001-v2',
      quoteVersions: [base.quoteVersions[0], v2],
      statusHistory: [
        ...base.statusHistory,
        { status: 'quote_accepted', timestamp: new Date('2026-02-03T10:00:00.000Z'), updatedBy: customerId, note: 'Customer accepted quotation' },
        { status: 'completed', timestamp: new Date('2026-02-10T10:00:00.000Z'), updatedBy: customerId, note: 'Customer confirmed completion' },
      ],
    });
    const acceptedDetails = await buildDetails('customer', { booking: accepted });
    expect(acceptedDetails.quotation?.acceptedVersion?.version).toBe(2);
    expect(acceptedDetails.quotation?.versions.find((version) => version.version === 2)?.rejectedAt).toBeNull();
    expect(acceptedDetails.quotation?.versions.find((version) => version.version === 1)?.rejectedAt)
      .toBe('2026-02-01T11:00:00.000Z');
  });

  it('keeps a rejected quotation rejected after the booking is cancelled or refunded', async () => {
    const base = booking({
      status: 'refunded',
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      currentQuoteVersion: 1,
      quote: { amount: 100, currency: 'EUR', description: 'Quote' },
      quoteVersions: [{
        ...booking().quoteVersions[0],
        rejectedAt: new Date('2026-02-02T10:00:00.000Z'),
        rejectionReason: 'Too expensive',
        rejectedBy: customerId,
      }],
      statusHistory: [
        { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), updatedBy: customerId, note: 'Booking created' },
        { status: 'quoted', timestamp: quoteTime, updatedBy: professionalId, note: 'Quotation submitted by professional' },
        { status: 'quote_rejected', timestamp: new Date('2026-02-02T10:00:00.000Z'), updatedBy: customerId, note: 'Customer rejected quotation: Too expensive' },
        { status: 'cancelled', timestamp: new Date('2026-02-03T10:00:00.000Z'), updatedBy: customerId, note: 'Cancelled after rejection' },
        { status: 'refunded', timestamp: new Date('2026-02-04T10:00:00.000Z'), updatedBy: adminId, note: 'Refunded' },
      ],
    });
    const details = await buildDetails('customer', { booking: base });
    expect(details.quotation?.status).toBe('rejected');
    expect(details.quotation?.acceptedVersion).toBeNull();

    // A later resubmission is still a live quote, not a rejection.
    base.status = 'quoted';
    base.currentQuoteVersion = 2;
    base.quoteVersions.push({
      ...base.quoteVersions[0],
      version: 2,
      quotationNumber: 'QT-2026-000001-v2',
      rejectedAt: undefined,
      rejectionReason: undefined,
      rejectedBy: undefined,
      createdAt: new Date('2026-02-05T10:00:00.000Z'),
    });
    base.statusHistory.push({
      status: 'quoted',
      timestamp: new Date('2026-02-05T10:00:00.000Z'),
      updatedBy: professionalId,
      note: 'Quotation updated by professional',
    });
    const resubmitted = await buildDetails('customer', { booking: base });
    expect(resubmitted.quotation?.status).toBe('quoted');
  });

  it('scopes legacy rejection reasons to each rejected version, never the latest global reason', async () => {
    const base = booking({
      status: 'quoted',
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      currentQuoteVersion: 2,
      customerRejectionReason: 'Second reason',
    });
    const v1 = { ...base.quoteVersions[0], totalAmount: 100 };
    const v2 = {
      ...base.quoteVersions[0],
      version: 2,
      quotationNumber: 'QT-2026-000001-v2',
      totalAmount: 120,
      createdAt: new Date('2026-02-05T10:00:00.000Z'),
      changeNote: 'Revised after first rejection',
    };
    base.quoteVersions = [v1, v2];
    base.statusHistory = [
      { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), updatedBy: customerId, note: 'Booking created' },
      { status: 'quoted', timestamp: quoteTime, updatedBy: professionalId, note: 'Quotation submitted by professional' },
      { status: 'quote_rejected', timestamp: new Date('2026-02-02T10:00:00.000Z'), updatedBy: customerId, note: 'Customer rejected quotation: First reason' },
      { status: 'quoted', timestamp: new Date('2026-02-05T10:00:00.000Z'), updatedBy: professionalId, note: 'Quotation updated (v2): Revised after first rejection' },
      { status: 'quote_rejected', timestamp: new Date('2026-02-06T10:00:00.000Z'), updatedBy: customerId, note: 'Customer rejected quotation: Second reason' },
    ];

    const details = await buildDetails('customer', { booking: base });
    const versions = details.quotation!.versions;
    expect(versions.find((version) => version.version === 1)).toMatchObject({
      rejectedAt: '2026-02-02T10:00:00.000Z',
      rejectionReason: 'First reason',
    });
    expect(versions.find((version) => version.version === 2)).toMatchObject({
      rejectedAt: '2026-02-06T10:00:00.000Z',
      rejectionReason: 'Second reason',
    });

    // A later edit clears the global field; the per-version evidence stays.
    base.customerRejectionReason = undefined;
    const afterEdit = await buildDetails('customer', { booking: base });
    expect(afterEdit.quotation!.versions.find((version) => version.version === 1)?.rejectionReason)
      .toBe('First reason');
    expect(afterEdit.quotation!.versions.find((version) => version.version === 2)?.rejectionReason)
      .toBe('Second reason');
  });

  it('keeps the recorded accepted version and its stored totals after later versions and fee changes', async () => {
    const base = booking();
    base.quoteVersions.push({
      ...base.quoteVersions[0],
      version: 2,
      quotationNumber: 'QT-2026-000001-v2',
      totalAmount: 500,
      createdAt: new Date('2026-02-10T10:00:00.000Z'),
      changeNote: 'Later revision',
      customerTotals: {
        commissionPercent: 25,
        professionalNetAmount: 500,
        customerNetAmount: 625,
        amountBeforeDiscounts: 625,
        vatAmount: 131.25,
        vatRate: 21,
        totalWithVat: 756.25,
        totalAmount: 756.25,
        currency: 'EUR',
        recordedAt: new Date('2026-02-10T10:00:00.000Z'),
      },
    });
    base.currentQuoteVersion = 2;
    // Later live/payment values must not rewrite the accepted v1 snapshot.
    base.quote = { amount: 999, currency: 'USD' };
    base.payment = { status: 'completed', totalWithVat: 9999, netAmount: 9999, vatAmount: 0, currency: 'USD' };

    const details = await buildDetails('customer', { booking: base });
    expect(details.quotation!.acceptedVersion).toMatchObject({
      version: 1,
      quotationNumber: 'QT-2026-000001-v1',
      source: 'recorded',
    });
    const accepted = details.quotation!.versions.find((version) => version.version === 1)!;
    const later = details.quotation!.versions.find((version) => version.version === 2)!;
    expect(accepted.accepted).toBe(true);
    expect(accepted.totalAmount).toBe(100);
    expect(accepted.customerTotals).toMatchObject({ customerNetAmount: 110, totalWithVat: 131 });
    expect(later.accepted).toBe(false);
    expect(later.customerTotals).toMatchObject({ customerNetAmount: 625, totalWithVat: 756.25 });
  });
});

describe('details privacy', () => {
  it('never exposes internal notes, admin links, provider ids or diagnostics to participants', async () => {
    const details = await buildDetails('customer');
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('INTERNAL SECRET NOTE');
    expect(serialized).not.toContain('INTERNAL REFUND NOTE');
    expect(serialized).not.toContain('INTERNAL TRANSFER ERROR');
    expect(serialized).not.toContain('pi_secret_123');
    expect(serialized).not.toContain('ch_secret_123');
    expect(serialized).not.toContain('tr_secret_123');
    expect(details.internal).toBeUndefined();
    expect(details.adminLinks).toBeUndefined();
    expect(details.parties.professional.email).toBeNull();
    expect(details.parties.professional.phone).toBeNull();
    expect(details.parties.professional.vatNumber).toBeNull();
    expect(details.parties.customer.vatNumber).toBeNull();
    expect(details.payments.records[0].providerIds).toBeUndefined();
    expect(details.payments.records[0].diagnostics).toBeUndefined();
    expect(details.payments.records[0].platformCommission).toBeNull();
    expect(details.payments.records[0].professionalPayout).toBeNull();
  });

  it('gives each party only its own invoice side', async () => {
    const customerDetails = await buildDetails('customer');
    expect(customerDetails.payments.records[0].invoice?.invoiceNumber).toBe('FIX-1');
    expect(customerDetails.payments.records[0].invoice?.invoiceUrl).toMatch(/customer\.pdf/);
    expect(customerDetails.payments.records[0].invoice).not.toHaveProperty('supplierInvoiceNumber');

    const professionalDetails = await buildDetails('professional');
    const professionalRecord = professionalDetails.payments.records[0] as any;
    expect(professionalRecord.invoice?.invoiceNumber).toBeUndefined();
    expect(professionalRecord.invoice?.supplierInvoiceNumber).toBe('SUP-1');
    expect(professionalRecord.invoice?.supplierInvoiceUrl).toMatch(/supplier\.pdf/);
    expect(JSON.stringify(professionalRecord)).not.toContain('customer.pdf');
    expect(professionalRecord.invoice).not.toHaveProperty('creditNoteNumber');
  });

  it('returns the supplier credit note and supplier Peppol fields to professional/admin only', async () => {
    const source = [payment({
      supplierCreditNoteNumber: 'SUP-CN-1',
      supplierCreditNoteUrl: 'https://fixera-uploads.s3.us-east-1.amazonaws.com/invoices/supplier-credit.pdf',
      supplierCreditNoteUblUrl: 'https://fixera-uploads.s3.us-east-1.amazonaws.com/invoices/supplier-credit.xml',
      supplierCreditNoteGeneratedAt: new Date('2026-02-04T10:00:00.000Z'),
      supplierCreditNoteRelatedInvoiceNumber: 'SUP-1',
      supplierPeppolDispatchStatus: 'sent',
      supplierPeppolDispatchReference: 'peppol-sup-1',
      supplierPeppolDispatchedAt: new Date('2026-02-04T11:00:00.000Z'),
    })];

    const professionalDetails = await buildDetails('professional', { payments: source });
    expect(professionalDetails.payments.records[0].invoice).toMatchObject({
      supplierCreditNoteNumber: 'SUP-CN-1',
      supplierCreditNoteRelatedInvoiceNumber: 'SUP-1',
      supplierPeppolDispatchStatus: 'sent',
      supplierPeppolDispatchReference: 'peppol-sup-1',
    });
    expect(professionalDetails.payments.records[0].invoice?.supplierCreditNoteUrl).toContain('supplier-credit.pdf');

    const adminDetails = await buildDetails('admin', { payments: source });
    expect(adminDetails.payments.records[0].invoice?.supplierCreditNoteNumber).toBe('SUP-CN-1');

    const customerDetails = await buildDetails('customer', { payments: source });
    expect(customerDetails.payments.records[0].invoice).not.toHaveProperty('supplierCreditNoteNumber');
    expect(JSON.stringify(customerDetails.payments.records[0])).not.toContain('supplier-credit.pdf');
  });

  it('exposes admin-only notes and links only to admins', async () => {
    const details = await buildDetails('admin');
    expect(details.internal?.notes).toBe('INTERNAL SECRET NOTE');
    expect(details.adminLinks).toMatchObject({
      booking: `/admin/bookings/${bookingId}`,
      disputes: '/admin/disputes',
      warrantyClaims: '/admin/warranty-claims',
      cancellationRequests: '/admin/cancellation-requests',
      payments: '/admin/payments',
    });
    expect(details.payments.records[0].providerIds).toMatchObject({
      paymentIntentId: 'pi_secret_123',
      chargeId: 'ch_secret_123',
    });
  });
});

describe('extra-cost payment currency provenance', () => {
  it('does not present a defaulted EUR as a recorded extra-cost currency', async () => {
    const details = await buildDetails('customer', {
      booking: {
        quote: undefined,
        quoteVersions: [],
        currentQuoteVersion: undefined,
        acceptedQuoteVersion: undefined,
        payment: {
          status: 'completed',
          extraCostStatus: 'succeeded',
          extraCostAmount: 20,
          extraCostCustomerNetAmount: 20,
        },
      },
      payments: [],
    });

    expect(details.extraCosts?.payment).toMatchObject({
      currency: null,
      currencySource: 'not_recorded',
    });
    expect(JSON.stringify(details.extraCosts?.payment)).not.toContain('"currency":"EUR"');
  });

  it('reports the quote currency as the recorded source when the payment record has none', async () => {
    const details = await buildDetails('customer', {
      booking: {
        quote: { amount: 100, currency: 'USD', description: 'Quote' },
        quoteVersions: [],
        currentQuoteVersion: undefined,
        acceptedQuoteVersion: undefined,
        payment: {
          status: 'completed',
          extraCostStatus: 'succeeded',
          extraCostAmount: 20,
          extraCostCustomerNetAmount: 20,
        },
      },
      payments: [],
    });

    expect(details.extraCosts?.payment).toMatchObject({
      currency: 'USD',
      currencySource: 'quote',
    });
  });

  it('keeps a recorded payment currency authoritative for the extra-cost record', async () => {
    const details = await buildDetails('customer', {
      booking: {
        quote: { amount: 100, currency: 'USD', description: 'Quote' },
        quoteVersions: [],
        currentQuoteVersion: undefined,
        acceptedQuoteVersion: undefined,
        payment: {
          status: 'completed',
          currency: 'GBP',
          extraCostStatus: 'succeeded',
          extraCostAmount: 20,
          extraCostCustomerNetAmount: 20,
        },
      },
      payments: [],
    });

    expect(details.extraCosts?.payment).toMatchObject({
      currency: 'GBP',
      currencySource: 'payment',
    });
  });
});

describe('base transfer facts', () => {
  it('reads recorded transfer amount/currency from the booking payment when the Payment row lacks them', async () => {
    const details = await buildDetails('professional', {
      booking: {
        payment: {
          status: 'completed',
          stripePaymentIntentId: 'pi_secret_123',
          stripeTransferId: 'tr_from_booking',
          transferStatus: 'succeeded',
          transferAmount: 100,
          transferCurrency: 'EUR',
          transferAttemptedAt: new Date('2026-02-03T11:00:00.000Z'),
        },
      },
      payments: [payment({
        stripePaymentIntentId: 'pi_secret_123',
        transferStatus: 'succeeded',
      })],
    });

    expect(details.payments.records[0].transfer).toMatchObject({
      status: 'succeeded',
      currency: 'EUR',
      amount: 100,
      attemptedAt: '2026-02-03T11:00:00.000Z',
    });
  });

  it('keeps milestone rows out of the base transfer fallback', async () => {
    const details = await buildDetails('professional', {
      booking: {
        payment: {
          status: 'completed',
          stripePaymentIntentId: 'pi_secret_123',
          transferAmount: 100,
          transferCurrency: 'EUR',
        },
      },
      payments: [payment({
        milestoneIndex: 0,
        transferStatus: undefined,
        stripeTransferId: undefined,
      })],
    });

    expect(details.payments.records[0].kind).toBe('milestone');
    expect(details.payments.records[0].transfer).toBeNull();
  });
});

describe('refund facts', () => {
  it('keeps a recorded VAT split and flags a legacy partial refund instead of inventing one', async () => {
    const details = await buildDetails('customer', {
      payments: [payment({
        refunds: [
          {
            amount: 131,
            reason: 'Cancelled before start',
            refundId: 're_full',
            refundedAt: new Date('2026-02-04T10:00:00.000Z'),
            source: 'platform',
            netAmount: 110,
            vatAmount: 21,
            vatRate: 21,
          },
          {
            amount: 20,
            reason: 'Goodwill',
            refundId: 're_partial',
            refundedAt: new Date('2026-02-05T10:00:00.000Z'),
            source: 'platform',
            notes: 'INTERNAL REFUND NOTE',
          },
        ],
        refundAmount: 151,
        refundedAt: new Date('2026-02-05T10:00:00.000Z'),
      })],
    });
    const full = details.payments.refunds.find((refund) => refund.amount === 131)!;
    expect(full).toMatchObject({
      amount: 131,
      netAmount: 110,
      vatAmount: 21,
      vatSplitRecorded: true,
      justification: 'Cancelled before start',
    });
    const partial = details.payments.refunds.find((refund) => refund.amount === 20)!;
    expect(partial).toMatchObject({
      amount: 20,
      netAmount: null,
      vatAmount: null,
      vatSplitRecorded: false,
      justification: 'Goodwill',
      kind: 'booking',
    });
    expect(partial.internalNotes).toBeUndefined();
    expect(details.meta.dataQuality.refundVatRecorded).toBe(false);
    expect(details.payments.notices.map((notice) => notice.code)).toContain('REFUND_VAT_SPLIT_NOT_RECORDED');
  });

  it('keeps an aggregate-only booking refund explicit when a real Payment row exists', async () => {
    // The aggregate lives on booking.payment (the Payment schema intentionally
    // has no top-level refundAmount). A Payment row for the same intent must
    // not hide the historical/provider-dashboard aggregate.
    const details = await buildDetails('customer', {
      booking: {
        payment: {
          status: 'partially_refunded',
          currency: 'EUR',
          stripePaymentIntentId: 'pi_secret_123',
          refundAmount: 30,
          refundedAt: new Date('2026-02-04T10:00:00.000Z'),
          refundReason: undefined,
          refundNotes: 'Internal provider note',
        },
      },
      payments: [payment({
        status: 'partially_refunded',
        refunds: [],
      })],
    });
    expect(details.payments.refunds).toHaveLength(1);
    expect(details.payments.refunds[0]).toMatchObject({
      amount: 30,
      status: 'aggregate_only',
      justification: null,
      justificationRecorded: false,
      vatAmount: null,
      netAmount: null,
      vatSplitRecorded: false,
    });
    expect(details.payments.refunds[0].internalNotes).toBeUndefined();
    expect(details.payments.byCurrency).toEqual([
      expect.objectContaining({ currency: 'EUR', recordedRefunded: 30, recordedNet: 101 }),
    ]);
    expect(details.meta.dataQuality.refundVatRecorded).toBe(false);
    expect(details.payments.notices.map((notice) => notice.code))
      .toContain('REFUND_VAT_SPLIT_NOT_RECORDED');

    const admin = await buildDetails('admin', {
      booking: {
        payment: {
          status: 'partially_refunded',
          currency: 'EUR',
          stripePaymentIntentId: 'pi_secret_123',
          refundAmount: 30,
          refundedAt: new Date('2026-02-04T10:00:00.000Z'),
          refundNotes: 'Internal provider note',
        },
      },
      payments: [payment({ status: 'partially_refunded', refunds: [] })],
    });
    const aggregate = admin.payments.refunds.find((refund) => refund.amount === 30)!;
    expect(aggregate.internalNotes).toBe('Internal provider note');
  });

  it('counts only booking-kind refunds in the currency net, not extra-cost refunds', async () => {
    const details = await buildDetails('customer', {
      payments: [payment({
        refunds: [
          { amount: 100, reason: 'Booking refund', refundId: 're_booking', refundedAt: new Date('2026-02-04T10:00:00.000Z'), source: 'platform', kind: 'booking' },
          { amount: 10, reason: 'Extra cost refund', refundId: 're_extra', refundedAt: new Date('2026-02-05T10:00:00.000Z'), source: 'platform', kind: 'extra_cost' },
        ],
      })],
    });
    expect(details.payments.byCurrency).toEqual([
      expect.objectContaining({ currency: 'EUR', recordedCharged: 131, recordedRefunded: 100, recordedNet: 31 }),
    ]);
    expect(details.payments.refunds.some((refund) => refund.kind === 'extra_cost')).toBe(true);
  });

  it('excludes failed and canceled provider refunds from returned money and capacity', async () => {
    const details = await buildDetails('customer', {
      payments: [payment({
        refunds: [
          {
            amount: 10,
            reason: 'Failed provider refund',
            refundId: 're_failed',
            refundedAt: new Date('2026-02-04T10:00:00.000Z'),
            source: 'platform',
            status: 'failed',
          },
          {
            amount: 5,
            reason: 'Succeeded provider refund',
            refundId: 're_succeeded',
            refundedAt: new Date('2026-02-05T10:00:00.000Z'),
            source: 'platform',
            status: 'succeeded',
          },
        ],
      })],
    });
    expect(details.payments.refunds).toHaveLength(1);
    expect(details.payments.refunds[0]).toMatchObject({ amount: 5, kind: 'booking' });
    expect(details.payments.byCurrency[0]).toMatchObject({ recordedRefunded: 5, recordedNet: 126 });
  });

  it('keeps a cancellation-request refund that has no Payment refund row', async () => {
    const cancellation = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439031'),
      status: 'approved',
      requestedBy: customerId,
      requestedRole: 'customer',
      reason: 'Scheduling conflict',
      refundAmount: 25,
      refundedAt: new Date('2026-02-07T10:00:00.000Z'),
      createdAt: new Date('2026-02-06T10:00:00.000Z'),
      resolvedAt: new Date('2026-02-07T10:00:00.000Z'),
      resolvedBy: adminId,
    };
    const details = await buildDetails('customer', {
      payments: [payment({ refunds: [] })],
      cancellations: [cancellation],
    });
    const refund = details.payments.refunds.find((entry) => entry.cancellationRequestId === String(cancellation._id))!;
    expect(refund).toMatchObject({
      amount: 25,
      currency: 'EUR',
      status: 'approved',
      justification: 'Scheduling conflict',
      vatSplitRecorded: false,
    });
    expect(details.activity.items.some((item) => item.type === 'refund_issued')).toBe(true);
    expect(details.cancellations).toHaveLength(1);
  });

  it('never exposes provider refund ids to participants and keeps them admin-only', async () => {
    const source = [payment({
      refunds: [{
        amount: 20,
        reason: 'Provider dashboard refund',
        refundId: 're_provider_secret',
        refundedAt: new Date('2026-02-05T10:00:00.000Z'),
        source: 'platform',
      }],
    })];

    const customerDetails = await buildDetails('customer', { payments: source });
    expect(JSON.stringify(customerDetails)).not.toContain('re_provider_secret');
    expect(customerDetails.payments.refunds[0].id).toMatch(/^payment:.+:refund:[a-f0-9]{16}$/);
    expect(customerDetails.payments.refunds[0].providerRefundId).toBeUndefined();
    const customerRefundEvent = customerDetails.activity.items.find((item) => item.type === 'refund_issued')!;
    expect(customerRefundEvent.metadata?.providerRefundId).toBeUndefined();
    expect(customerRefundEvent.metadata?.refundId).toBeUndefined();
    expect(customerRefundEvent.metadata?.refundRef).toMatch(/^[a-f0-9]{16}$/);

    const adminDetails = await buildDetails('admin', { payments: source });
    expect(adminDetails.payments.refunds[0].providerRefundId).toBe('re_provider_secret');
    const adminRefundEvent = adminDetails.activity.items.find((item) => item.type === 'refund_issued')!;
    expect(adminRefundEvent.metadata?.providerRefundId).toBe('re_provider_secret');
  });

  it('labels legacy cancellation response actors as inferred unless the actor was actually stored', async () => {
    const legacyRequest = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439041'),
      status: 'negotiating',
      requestedBy: customerId,
      requestedRole: 'customer',
      reason: 'Scheduling conflict',
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
      professionalDecision: 'counter',
      counterOfferAmount: 30,
      professionalRespondedAt: new Date('2026-02-02T10:00:00.000Z'),
      customerDecision: 'refused',
      customerRespondedAt: new Date('2026-02-03T10:00:00.000Z'),
    };
    const legacy = await buildBookingActivity({
      booking: booking(),
      payments: [],
      cancellations: [legacyRequest],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    for (const stage of ['professional_response', 'customer_response']) {
      const event = legacy.items.find((item) => item.metadata?.stage === stage)!;
      expect(event.actorRecorded).toBe(false);
      expect(event.actor).toMatchObject({ source: 'inferred_route', id: null });
    }

    const recorded = await buildBookingActivity({
      booking: booking(),
      payments: [],
      cancellations: [{
        ...legacyRequest,
        professionalRespondedBy: professionalId,
        customerRespondedBy: customerId,
      }],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const professionalEvent = recorded.items.find((item) => item.metadata?.stage === 'professional_response')!;
    expect(professionalEvent.actor).toMatchObject({
      id: String(professionalId),
      role: 'professional',
      source: 'recorded',
    });
    expect(professionalEvent.actorRecorded).toBe(true);
  });
});

describe('extra costs', () => {
  it('keeps the refund-breakdown warning while a negative extra refund is only pending', async () => {
    const source = booking({
      extraCosts: [{ type: 'other', name: 'Waste removal', justification: 'Less waste', amount: -20 }],
      extraCostTotal: -20,
    });
    const pendingDetails = await buildDetails('customer', {
      booking: source,
      payments: [payment({
        refunds: [{
          amount: 20,
          refundId: 're_pending_extra',
          refundedAt: new Date('2026-02-05T10:00:00.000Z'),
          source: 'platform',
          kind: 'extra_cost',
          status: 'pending',
        }],
      })],
    });
    expect(pendingDetails.extraCosts.notices.map((entry) => entry.code))
      .toContain('REFUND_BREAKDOWN_INCOMPLETE');
    expect(pendingDetails.payments.refunds.some((refund) => refund.kind === 'extra_cost')).toBe(true);

    const settledDetails = await buildDetails('customer', {
      booking: source,
      payments: [payment({
        refunds: [{
          amount: 20,
          refundId: 're_settled_extra',
          refundedAt: new Date('2026-02-05T10:00:00.000Z'),
          source: 'platform',
          kind: 'extra_cost',
          status: 'succeeded',
        }],
      })],
    });
    expect(settledDetails.extraCosts.notices.map((entry) => entry.code))
      .not.toContain('REFUND_BREAKDOWN_INCOMPLETE');
  });

  it('only projects an extra-cost dispute into the extra-cost section', async () => {
    const rescheduleDispute = booking({
      dispute: {
        type: 'reschedule',
        reason: 'Date changed',
        description: 'The proposed date does not work',
        raisedAt: new Date('2026-02-06T10:00:00.000Z'),
        raisedBy: customerId,
      },
    });
    const rescheduleDetails = await buildDetails('customer', { booking: rescheduleDispute });
    expect(rescheduleDetails.extraCosts.dispute).toBeNull();
    expect(rescheduleDetails.activity.items.some((item) => item.type === 'dispute_opened')).toBe(true);

    const extraCostDispute = booking({
      dispute: {
        type: 'extra_costs',
        reason: 'Extra cost not agreed',
        description: 'Unit count is wrong',
        raisedAt: new Date('2026-02-06T10:00:00.000Z'),
        raisedBy: customerId,
      },
      extraCosts: [{ type: 'other', name: 'Waste removal', justification: 'Extra bags', amount: 25 }],
      extraCostTotal: 25,
    });
    const extraDetails = await buildDetails('customer', { booking: extraCostDispute });
    expect(extraDetails.extraCosts.dispute).toMatchObject({
      type: 'extra_costs',
      reason: 'Extra cost not agreed',
      status: 'open',
    });
    expect(extraDetails.extraCosts.items[0].customerCharge).toBeNull();
  });
});

describe('wizard and post-booking answers', () => {
  it('preserves false/0 answers and marks them answered', async () => {
    const base = booking();
    base.bookingSnapshot = buildBookingSnapshot({
      booking: base,
      project: project(),
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
    }) as any;
    base.postBookingData = [
      { questionId: 'pq-1', question: 'Parking?', answer: '0' },
      { questionId: 'pq-2', question: 'Pets?', answer: 'false' },
    ];
    base.postBookingSubmittedAt = new Date('2026-02-06T10:00:00.000Z');
    base.postBookingSubmittedBy = customerId;
    const details = await buildDetails('customer', { booking: base });
    expect(details.postBooking.answers.map((answer) => answer.answer)).toEqual(['0', 'false']);
    expect(details.postBooking.questions.every((question) => question.answered)).toBe(true);
    expect(details.postBooking.timestampRecorded).toBe(true);
    expect(details.postBooking.submittedBy).toMatchObject({ role: 'customer' });
  });

  it('preserves preferred start time and VAT answers in the read DTO', async () => {
    const base = booking({
      rfqData: {
        ...booking().rfqData,
        preferredStartDate: new Date('2026-03-01T00:00:00.000Z'),
        preferredStartTime: '09:30',
      },
    });
    base.bookingSnapshot = buildBookingSnapshot({
      booking: base,
      project: project(),
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
      vatQuestions: [{ fieldName: 'propertyNature', question: 'Property type', type: 'select' }],
    }) as any;
    base.vatDecision.answers = [{ fieldName: 'propertyNature', value: 'immovable' }];

    const details = await buildDetails('customer', { booking: base });
    expect(details.booking.schedule.preferredStartTime).toBe('09:30');
    expect(details.wizard.rfq.preferredStartTime).toBe('09:30');
    expect(details.bookingSnapshot.questions.vat[0]).toMatchObject({
      fieldName: 'propertyNature',
      answer: 'immovable',
    });
  });

  it('keeps URL-looking text answers as text and only signs declared file answers', async () => {
    const base = booking({
      rfqData: {
        serviceType: 'Bathroom',
        description: 'Need a bathroom',
        answers: [{
          questionId: 'q-1',
          question: 'Building type?',
          answer: 'https://example.com/portfolio',
          fieldType: 'text',
        }],
      },
      postBookingData: [{
        questionId: 'pq-1',
        question: 'Parking?',
        answer: 'https://example.com/parking',
        fieldType: 'text',
      }],
      postBookingSubmittedAt: new Date('2026-02-06T10:00:00.000Z'),
      postBookingSubmittedBy: customerId,
    });
    base.bookingSnapshot = buildBookingSnapshot({
      booking: base,
      project: project(),
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
    }) as any;

    const details = await buildDetails('customer', { booking: base });
    const rfqAnswer = details.wizard.rfq.answers[0];
    expect(rfqAnswer).toMatchObject({
      answer: 'https://example.com/portfolio',
      answerType: 'text',
    });
    expect(details.wizard.rfqQuestions[0]).toMatchObject({
      answer: 'https://example.com/portfolio',
      answered: true,
    });
    expect(details.postBooking.answers[0]).toMatchObject({
      answer: 'https://example.com/parking',
      answerType: 'text',
    });
  });

  it('signs a project-question upload only for this booking project and uploader', async () => {
    const projectUpload = `https://fixera-uploads.s3.us-east-1.amazonaws.com/projects/${projectId}/attachment/${customerId}/proof.pdf`;
    const otherProjectUpload = `https://fixera-uploads.s3.us-east-1.amazonaws.com/projects/${new Types.ObjectId()}/attachment/${customerId}/proof.pdf`;
    const base = booking({
      rfqData: {
        serviceType: 'Bathroom',
        description: 'Need a bathroom',
        answers: [{
          questionId: 'q-1',
          question: 'Building type?',
          answer: projectUpload,
          fieldType: 'file',
        }],
      },
      postBookingData: [{
        questionId: 'pq-1',
        question: 'Parking?',
        answer: projectUpload,
        fieldType: 'file',
      }],
      postBookingSubmittedAt: new Date('2026-02-06T10:00:00.000Z'),
      postBookingSubmittedBy: customerId,
    });
    base.bookingSnapshot = buildBookingSnapshot({
      booking: base,
      project: project(),
      customer: customer(),
      professional: professional(),
      source: 'booking_creation',
    }) as any;

    const signed = await buildDetails('customer', { booking: base });
    expect(signed.wizard.rfq.answers[0].answer).toContain('proof.pdf?X-Amz-Algorithm=');
    expect(signed.wizard.rfq.answers[0].answer).toContain('X-Amz-Signature=');
    expect(signed.wizard.rfq.answers[0].answerType).toBe('file');
    expect(signed.wizard.rfqQuestions[0].answered).toBe(true);
    expect(signed.postBooking.answers[0].answer).toContain('proof.pdf?X-Amz-Algorithm=');
    expect(signed.postBooking.answers[0].answer).toContain('X-Amz-Signature=');
    expect(signed.postBooking.questions[0].answered).toBe(true);

    const forged = booking({
      ...base,
      rfqData: {
        ...base.rfqData,
        answers: [{ ...base.rfqData.answers[0], answer: otherProjectUpload }],
      },
      postBookingData: [{ ...base.postBookingData[0], answer: otherProjectUpload }],
    });
    const rejected = await buildDetails('customer', { booking: forged });
    expect(rejected.wizard.rfq.answers[0].answer).toBe('');
    expect(rejected.wizard.rfqQuestions[0].answered).toBe(false);
    expect(rejected.postBooking.answers[0].answer).toBe('');
    expect(rejected.postBooking.questions[0].answered).toBe(false);
  });

  it('keeps the checkout payment option after the booking becomes booked', async () => {
    const base = booking({
      status: 'booked',
      quotationNumber: undefined,
      quoteVersions: [],
      currentQuoteVersion: undefined,
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      quote: {
        amount: 120,
        currency: 'EUR',
        description: 'Auto-generated checkout quote',
        submittedAt: new Date('2026-02-03T10:00:00.000Z'),
      },
    });
    const details = await buildDetails('customer', { booking: base });
    expect(details.wizard.paymentAtCheckout).toBe(true);
  });

  it('does not fabricate a timestamp for legacy post-booking answers', async () => {
    const base = booking();
    base.postBookingData = [{ questionId: 'pq-1', question: 'Parking?', answer: 'Yes' }];
    base.postBookingSubmittedAt = undefined;
    base.postBookingSubmittedBy = undefined;
    const details = await buildDetails('customer', { booking: base });
    expect(details.postBooking.timestampRecorded).toBe(false);
    expect(details.postBooking.submittedAt).toBeNull();
    expect(details.postBooking.notices.map((notice) => notice.code)).toContain('POST_BOOKING_TIMESTAMP_NOT_RECORDED');
  });
});

describe('activity', () => {
  it('dedupes a payment status history entry and keeps recorded actors', async () => {
    const activity = await buildBookingActivity({
      booking: booking(),
      payments: [payment()],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const paymentEvents = activity.items.filter((item) => item.type === 'payment_authorized');
    expect(paymentEvents).toHaveLength(1);
    const bookedStatus = activity.items.filter(
      (item) => item.type === 'status_changed' && item.statusTo === 'booked',
    );
    expect(bookedStatus).toHaveLength(0);
    expect(activity.items.find((item) => item.type === 'quotation_submitted')).toMatchObject({
      actorRecorded: true,
      actor: expect.objectContaining({ role: 'professional' }),
    });
  });

  it('emits a payout amount line for a released payment without replacing recorded totals', async () => {
    const released = payment({
      transferredAt: paidTime,
      transferAmount: 100,
      professionalPayout: 95,
    });
    const activity = await buildBookingActivity({
      booking: booking(),
      payments: [released],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'professional',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const event = activity.items.find((item) => item.type === 'payment_released')!;
    expect(event.amounts).toMatchObject({ totalAmount: 131, netAmount: 110, vatAmount: 21, currency: 'EUR' });
    expect(event.amountLines).toEqual([{
      kind: 'payout',
      amount: 100,
      currency: 'EUR',
      recorded: true,
    }]);
    expect(event.actor).toMatchObject({ role: 'system', source: 'provider_webhook' });
  });

  it('keeps deterministic event ids across reads so pagination/links stay stable', async () => {
    const context = {
      booking: booking(),
      payments: [payment()],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer' as const,
      customerId: String(customerId),
      professionalId: String(professionalId),
    };
    const first = await buildBookingActivity(context);
    const second = await buildBookingActivity(context);
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });

  it('marks generated status notes as system text instead of user-authored', async () => {
    const base = booking();
    base.statusHistory.push({
      status: 'quote_rejected',
      timestamp: new Date('2026-02-01T11:00:00.000Z'),
      updatedBy: customerId,
      note: 'Customer rejected quotation v1: Too expensive',
    });
    const activity = await buildBookingActivity({
      booking: base,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const rejected = activity.items.find((item) => item.type === 'quotation_rejected');
    expect(rejected).toMatchObject({
      descriptionSource: 'system',
      descriptionLocale: 'en',
    });
    const submitted = activity.items.find((item) => item.type === 'quotation_submitted');
    expect(submitted).toMatchObject({
      descriptionSource: 'user',
      descriptionLocale: 'unknown',
    });
  });

  it('omits an invented currency from legacy payment/milestone/extra-cost events', async () => {
    const base = booking({
      quote: undefined,
      quoteVersions: [],
      payment: {
        status: 'completed',
        amount: 100,
        netAmount: 100,
        totalWithVat: 120,
        authorizedAt: paidTime,
        capturedAt: paidTime,
      },
      milestonePayments: [{
        title: 'Deposit',
        amount: 50,
        status: 'paid',
        workStatus: 'completed',
        dueCondition: 'on_start',
        startedAt: new Date('2026-02-02T09:00:00.000Z'),
        completedAt: new Date('2026-02-02T10:00:00.000Z'),
        paidAt: new Date('2026-02-02T11:00:00.000Z'),
      }],
      extraCosts: [{ type: 'other', name: 'Waste', justification: 'Extra', amount: 10 }],
      extraCostTotal: 10,
      completionAttestation: {
        confirmedAt: new Date('2026-02-03T10:00:00.000Z'),
        confirmedBy: professionalId,
        notes: 'Done',
        attachments: [],
      },
    });
    const activity = await buildBookingActivity({
      booking: base,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    for (const type of ['payment_authorized', 'milestone_started', 'extra_costs_declared']) {
      const event = activity.items.find((item) => item.type === type)!;
      expect(event.amounts?.amount).toBeDefined();
      expect(event.amounts).not.toHaveProperty('currency');
    }
  });

  it('uses the recorded closing actor for a warranty close and the system actor only for auto-close', async () => {
    const claim = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439071'),
      claimNumber: 'WC-2026-000001',
      customer: customerId,
      professional: professionalId,
      reason: 'defect',
      status: 'closed',
      openedAt: new Date('2026-02-01T10:00:00.000Z'),
      statusHistory: [
        { status: 'closed', timestamp: new Date('2026-02-05T10:00:00.000Z'), updatedBy: adminId, note: 'Closed by admin' },
      ],
    };
    const activity = await buildBookingActivity({
      booking: booking({ quoteVersions: [], quote: undefined }),
      payments: [],
      cancellations: [],
      warrantyClaims: [claim],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const closed = activity.items.find((item) => item.type === 'warranty_closed')!;
    expect(closed.actor).toMatchObject({ role: 'admin', name: 'Ada Admin' });
    expect(closed.actorRecorded).toBe(true);

    const autoActivity = await buildBookingActivity({
      booking: booking(),
      payments: [],
      cancellations: [],
      warrantyClaims: [{
        ...claim,
        statusHistory: [],
        resolution: { autoClosedAt: new Date('2026-02-06T10:00:00.000Z'), resolvedAt: new Date('2026-02-05T10:00:00.000Z'), resolvedBy: adminId },
      }],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    expect(autoActivity.items.find((item) => item.type === 'warranty_closed')?.actor)
      .toMatchObject({ role: 'system', source: 'system_job' });
  });

  it('emits one payment-canceled event for the webhook status entry and its system actor', async () => {
    const zeroId = new Types.ObjectId('000000000000000000000000');
    const canceledAt = new Date('2026-02-04T10:00:00.000Z');
    const base = booking({
      status: 'cancelled',
      statusHistory: [
        ...booking().statusHistory,
        {
          status: 'cancelled',
          timestamp: canceledAt,
          updatedBy: zeroId,
          note: 'Payment intent canceled — booking cancelled',
        },
      ],
      payment: {
        status: 'refunded',
        currency: 'EUR',
        amount: 100,
        totalWithVat: 120,
        canceledAt,
        refundedAt: canceledAt,
      },
      quoteVersions: [],
      quote: undefined,
    });
    const activity = await buildBookingActivity({
      booking: base,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const canceled = activity.items.filter((item) => item.type === 'payment_canceled');
    expect(canceled).toHaveLength(1);
    expect(canceled[0]).toMatchObject({
      actor: expect.objectContaining({ role: 'system', id: null, source: 'system_job' }),
      description: 'Payment intent canceled — booking cancelled',
      statusTo: 'cancelled',
      descriptionSource: 'system',
    });
    expect(activity.items.some(
      (item) => item.type === 'status_changed' && item.statusTo === 'cancelled',
    )).toBe(false);
  });

  it('labels a system auto-completion as auto-accepted and never as an unknown actor', async () => {
    const zeroId = new Types.ObjectId('000000000000000000000000');
    const base = booking({
      status: 'completed',
      statusHistory: [
        { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), note: 'Booking created' },
        { status: 'professional_completed', timestamp: new Date('2026-02-03T10:00:00.000Z'), updatedBy: professionalId, note: 'Completion requested' },
        { status: 'completed', timestamp: new Date('2026-02-10T10:00:00.000Z'), updatedBy: zeroId, note: 'Completion finalized' },
      ],
    });
    const activity = await buildBookingActivity({
      booking: base,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const completed = activity.items.find((item) => item.type === 'completion_auto_accepted')!;
    expect(completed).toMatchObject({
      actorRecorded: true,
      actor: expect.objectContaining({ role: 'system', id: null }),
    });
    expect(activity.items.some((item) => item.type === 'completion_confirmed')).toBe(false);
    expect(JSON.stringify(activity.items)).not.toContain('000000000000000000000000');
  });

  it('emits RFQ submission from the recorded creation boundary and keeps legacy actors explicit', async () => {
    const recorded = await buildBookingActivity({
      booking: booking({
        statusHistory: [
          { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), updatedBy: customerId, note: 'Booking created' },
          ...booking().statusHistory.slice(1),
        ],
      }),
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    expect(recorded.items.filter((item) => item.type === 'rfq_submitted')).toHaveLength(1);
    expect(recorded.items.find((item) => item.type === 'rfq_submitted')).toMatchObject({
      occurredAt: '2026-01-20T09:00:00.000Z',
      actorRecorded: true,
      actor: expect.objectContaining({ id: String(customerId), role: 'customer' }),
      legacyDerived: false,
    });

    const legacy = await buildBookingActivity({
      booking: booking({
        status: 'rfq_accepted',
        quotationNumber: undefined,
        quoteVersions: [],
        rfqResponse: {
          action: 'accepted',
          respondedAt: new Date('2026-01-21T10:00:00.000Z'),
          respondedBy: professionalId,
        },
        statusHistory: [{
          status: 'rfq',
          timestamp: new Date('2026-01-20T09:00:00.000Z'),
          note: 'Booking created',
        }],
      }),
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    expect(legacy.items.find((item) => item.type === 'rfq_submitted')).toMatchObject({
      actor: null,
      actorRecorded: false,
      legacyDerived: true,
    });
    expect(legacy.dataQuality.notes).toContain('RFQ_SUBMISSION_ACTOR_NOT_RECORDED');
  });

  it('uses the recorded refund actor and keeps provider-webhook refunds honestly system-sourced', async () => {
    const withRefunds = payment({
      refunds: [
        {
          amount: 10,
          reason: 'Admin adjustment',
          refundId: 're_admin',
          refundedAt: new Date('2026-02-04T10:00:00.000Z'),
          source: 'platform',
          refundedBy: adminId,
        },
        {
          amount: 5,
          reason: 'Provider dashboard refund',
          refundId: 're_provider',
          refundedAt: new Date('2026-02-05T10:00:00.000Z'),
          source: 'platform',
        },
      ],
    });
    const activity = await buildBookingActivity({
      booking: booking(),
      payments: [withRefunds],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const adminRefund = activity.items.find((item) => item.description === 'Admin adjustment')!;
    expect(adminRefund).toMatchObject({
      actorRecorded: true,
      actor: expect.objectContaining({ role: 'admin', id: null }),
    });
    expect(JSON.stringify(adminRefund)).not.toContain('re_admin');
    const providerRefund = activity.items.find((item) => item.description === 'Provider dashboard refund')!;
    expect(providerRefund).toMatchObject({
      actorRecorded: true,
      actor: expect.objectContaining({ role: 'system', source: 'provider_webhook' }),
    });
    expect(JSON.stringify(providerRefund)).not.toContain('re_provider');
  });

  it('uses the recorded RFQ responder and keeps legacy RFQ responses explicitly inferred', async () => {
    const recorded = booking({
      rfqResponse: {
        action: 'accepted',
        respondedAt: new Date('2026-01-21T10:00:00.000Z'),
        respondedBy: professionalId,
      },
    });
    const recordedActivity = await buildBookingActivity({
      booking: recorded,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    expect(recordedActivity.items.find((item) => item.type === 'rfq_accepted')).toMatchObject({
      actorRecorded: true,
      actor: expect.objectContaining({ id: String(professionalId), role: 'professional' }),
      legacyDerived: false,
    });

    const legacy = booking({
      rfqResponse: {
        action: 'accepted',
        respondedAt: new Date('2026-01-21T10:00:00.000Z'),
      },
    });
    const legacyActivity = await buildBookingActivity({
      booking: legacy,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    expect(legacyActivity.items.find((item) => item.type === 'rfq_accepted')).toMatchObject({
      actorRecorded: false,
      legacyDerived: true,
    });
  });

  it('withholds raw admin status notes from participants but keeps the outcome and admin actor', async () => {
    const base = booking();
    base.statusHistory.push({
      status: 'booked',
      timestamp: new Date('2026-02-06T10:00:00.000Z'),
      updatedBy: adminId,
      note: 'Status force-set by admin (was dispute): INTERNAL ADMIN NOTE',
    });
    const activity = await buildBookingActivity({
      booking: base,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    const adminEvent = activity.items.find((item) => item.type === 'admin_status_changed')!;
    expect(adminEvent.description).toBeNull();
    expect(adminEvent.noteCodes).toContain('ADMIN_NOTE_ADMIN_ONLY');
    expect(JSON.stringify(adminEvent)).not.toContain('INTERNAL ADMIN NOTE');
    expect(adminEvent.actor).toMatchObject({ role: 'admin', id: null });
  });

  it('omits undated sources instead of giving them today’s timestamp', async () => {
    const base = booking();
    base.postBookingData = [{ questionId: 'pq-1', question: 'Parking?', answer: 'Yes' }];
    base.postBookingSubmittedAt = undefined;
    const activity = await buildBookingActivity({
      booking: base,
      payments: [],
      cancellations: [],
      warrantyClaims: [],
      actors,
      viewerRole: 'customer',
      customerId: String(customerId),
      professionalId: String(professionalId),
    });
    expect(activity.complete).toBe(false);
    expect(activity.dataQuality.undatedEvents).toBeGreaterThan(0);
    expect(activity.dataQuality.notes).toContain('POST_BOOKING_TIMESTAMP_NOT_RECORDED');
    expect(activity.items.every((item) => Boolean(item.occurredAt))).toBe(true);
  });
});

describe('attachment ownership', () => {
  const own = `https://fixera-uploads.s3.us-east-1.amazonaws.com/rfq-attachments/${customerId}/file.pdf`;
  const other = `https://fixera-uploads.s3.us-east-1.amazonaws.com/rfq-attachments/${professionalId}/file.pdf`;
  const forged = `https://evil.example/rfq-attachments/${customerId}/file.pdf`;

  it('accepts only a trusted bucket key owned by the user', () => {
    expect(isUploadOwnedByUser(own, customerId)).toBe(true);
    expect(isUploadOwnedByUser(other, customerId)).toBe(false);
    expect(isUploadOwnedByUser(forged, customerId)).toBe(false);
  });

  it('returns no signed URL for an unowned legacy attachment', async () => {
    const result = await presignOwnedUrl(other, [customerId], ['rfq-attachments']);
    expect(result).toMatchObject({ url: null, signed: false, unavailableReason: 'not_owned' });
  });
});

describe('reschedule details', () => {
  it('returns the pending request and every recorded history entry, not only the latest', async () => {
    const base = booking({
      rescheduleRequest: {
        status: 'pending',
        requestedBy: customerId,
        requestedAt: new Date('2026-02-07T10:00:00.000Z'),
        reason: 'New date needed',
        description: 'The building access moved',
        previousSchedule: {
          scheduledStartDate: new Date('2026-02-10T09:00:00.000Z'),
          scheduledExecutionEndDate: new Date('2026-02-10T17:00:00.000Z'),
          scheduledStartTime: '09:00',
          scheduledEndTime: '17:00',
        },
        proposedSchedule: {
          scheduledStartDate: new Date('2026-02-12T09:00:00.000Z'),
          scheduledExecutionEndDate: new Date('2026-02-12T17:00:00.000Z'),
          scheduledStartTime: '09:00',
          scheduledEndTime: '17:00',
        },
      },
      rescheduleHistory: [
        {
          requestedBy: professionalId,
          requestedAt: new Date('2026-02-01T10:00:00.000Z'),
          reason: 'Material delay',
          description: 'Supplier delay',
          status: 'accepted',
          respondedAt: new Date('2026-02-01T11:00:00.000Z'),
          respondedBy: customerId,
          responseNote: 'Accepted',
          previousSchedule: {
            scheduledStartDate: new Date('2026-02-03T09:00:00.000Z'),
            scheduledExecutionEndDate: new Date('2026-02-03T17:00:00.000Z'),
          },
          proposedSchedule: {
            scheduledStartDate: new Date('2026-02-04T09:00:00.000Z'),
            scheduledExecutionEndDate: new Date('2026-02-04T17:00:00.000Z'),
          },
        },
      ],
    });
    const details = await buildDetails('customer', { booking: base });
    expect(details.booking.schedule.reschedulePending).toBe(true);
    expect(details.reschedules).toHaveLength(2);
    expect(details.reschedules.map((entry) => entry.status)).toEqual(['accepted', 'pending']);
    expect(details.reschedules[0]).toMatchObject({
      reason: 'Material delay',
      description: 'Supplier delay',
      actorRecorded: true,
      respondedAt: '2026-02-01T11:00:00.000Z',
    });
    expect(details.reschedules[1]).toMatchObject({
      reason: 'New date needed',
      description: 'The building access moved',
      respondedAt: null,
    });
    expect(details.activity.items.some((item) => item.type === 'reschedule_requested')).toBe(true);
  });
});

describe('legacy compatibility', () => {
  it('marks a booking without a snapshot as current-project reference with notices', async () => {
    const legacy = booking({
      bookingSnapshot: undefined,
      quoteVersions: [],
      quotationNumber: undefined,
      acceptedQuoteVersion: undefined,
      acceptedQuotationNumber: undefined,
      status: 'completed',
    });
    const details = await buildDetails('customer', { booking: legacy, payments: [] });
    expect(details.bookingSnapshot).toMatchObject({
      authority: 'current_project_reference',
      immutable: false,
      capturedAt: null,
    });
    expect(details.bookingSnapshot.currentProjectReference).toMatchObject({ source: 'live_project' });
    expect(details.bookingSnapshot.notices.map((notice) => notice.code)).toEqual(
      expect.arrayContaining(['BOOKING_SNAPSHOT_NOT_RECORDED', 'LIVE_PROJECT_MAY_HAVE_CHANGED']),
    );
    expect(details.meta.legacy).toBe(true);
    expect(details.quotation).toBeNull();
  });
});
