import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.hoisted(() => {
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_booking_details_routes';
});

const mocks = vi.hoisted(() => ({
  bookingFindById: vi.fn(),
  paymentFind: vi.fn(),
  paymentFindOne: vi.fn(),
  cancellationFind: vi.fn(),
  warrantyFind: vi.fn(),
  userFind: vi.fn(),
}));

vi.mock('../../../models/booking', () => ({
  default: { findById: mocks.bookingFindById },
}));

vi.mock('../../../models/payment', () => ({
  default: { find: mocks.paymentFind, findOne: mocks.paymentFindOne },
}));

vi.mock('../../../models/cancellationRequest', () => ({
  default: { find: mocks.cancellationFind },
}));

vi.mock('../../../models/warrantyClaim', () => ({
  default: { find: mocks.warrantyFind },
}));

vi.mock('../../../models/user', () => ({
  default: { find: mocks.userFind },
}));

import { getBookingActivity, getBookingDetails } from '../../../handlers/Booking/details';
import { getBookingById, submitPostBookingAnswers } from '../../../handlers/Booking';
import { getAdminBookingDetail } from '../../../handlers/Admin/bookingDetail';

const customerId = new Types.ObjectId('64b000000000000000000001');
const professionalId = new Types.ObjectId('64b000000000000000000002');
const projectId = new Types.ObjectId('64b000000000000000000003');
const bookingId = new Types.ObjectId('64b000000000000000000004');

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

const booking = () => ({
  _id: bookingId,
  bookingNumber: 'BK-2026-000004',
  bookingType: 'project',
  status: 'booked',
  customer: {
    _id: customerId,
    name: 'Carla Customer',
    username: 'carla',
    email: 'carla@example.com',
    phone: '+3212345678',
    customerType: 'individual',
    location: { city: 'Brussels', country: 'BE', postalCode: '1000' },
  },
  professional: {
    _id: professionalId,
    name: 'Piet Professional',
    username: 'piet',
    email: 'piet@example.com',
    phone: '+3298765432',
    businessInfo: { companyName: 'Piet Works', city: 'Ghent', country: 'BE' },
  },
  project: {
    _id: projectId,
    title: 'Bathroom renovation',
    description: 'Full bathroom',
    category: 'Renovation',
    service: 'Bathroom',
    professionalId,
    subprojects: [{ name: 'Standard package', pricing: { type: 'fixed', amount: 100 } }],
  },
  selectedSubprojectIndex: 0,
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
  quoteVersions: [],
  statusHistory: [
    { status: 'rfq', timestamp: new Date('2026-01-20T09:00:00.000Z'), note: 'Booking created' },
    { status: 'booked', timestamp: new Date('2026-02-03T10:00:00.000Z'), note: 'Payment confirmed' },
  ],
  postBookingData: [],
  extraCosts: [],
  rescheduleHistory: [],
  notes: 'INTERNAL SECRET NOTE',
  dispute: {
    reason: 'Scope question',
    raisedAt: new Date('2026-02-04T10:00:00.000Z'),
    resolution: 'INTERNAL ADMIN RESOLUTION',
    resolutionAttachments: ['https://fixera-uploads.s3.us-east-1.amazonaws.com/dispute-attachments/private.pdf'],
  },
  createdAt: new Date('2026-01-20T09:00:00.000Z'),
  updatedAt: new Date('2026-02-03T10:00:00.000Z'),
});

const request = (user: any, params: any = { bookingId: String(bookingId) }) => ({
  user,
  params,
});

beforeEach(() => {
  vi.clearAllMocks();
  const source = booking();
  mocks.bookingFindById.mockImplementation(() => query(source));
  mocks.paymentFind.mockImplementation(() => query([]));
  mocks.paymentFindOne.mockImplementation(() => query(null));
  mocks.cancellationFind.mockImplementation(() => query([]));
  mocks.warrantyFind.mockImplementation(() => query([]));
  mocks.userFind.mockImplementation(() => query([]));
});

describe('booking details route handlers', () => {
  it('keeps the existing booking response and adds details to it', async () => {
    const res = response();
    await getBookingById(
      request({ _id: customerId, role: 'customer' }) as any,
      res as any,
      vi.fn() as any,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({
      success: true,
      viewerRole: 'customer',
      booking: { _id: bookingId },
      details: { viewerRole: 'customer', booking: { id: String(bookingId) } },
    });
    expect(res.body.booking).toEqual(expect.objectContaining({ bookingNumber: 'BK-2026-000004' }));
    expect(res.body.booking.notes).toBeUndefined();
  });

  it('returns the normalized participant details without internal fields', async () => {
    const res = response();
    const next = vi.fn();
    await getBookingDetails(
      request({ _id: customerId, role: 'customer' }) as any,
      res as any,
      next as any,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        viewerRole: 'customer',
        booking: { id: String(bookingId), bookingNumber: 'BK-2026-000004' },
      },
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('INTERNAL SECRET NOTE');
    expect(serialized).not.toContain('INTERNAL ADMIN RESOLUTION');
    expect(serialized).not.toContain('dispute-attachments/private.pdf');
    expect(res.body.data.adminLinks).toBeUndefined();
    expect(res.body.data.internal).toBeUndefined();
  });

  it('returns the same activity object through the activity alias', async () => {
    const detailsRes = response();
    await getBookingDetails(
      request({ _id: customerId, role: 'customer' }) as any,
      detailsRes as any,
      vi.fn() as any,
    );

    const activityRes = response();
    await getBookingActivity(
      request({ _id: customerId, role: 'customer' }) as any,
      activityRes as any,
      vi.fn() as any,
    );

    expect(activityRes.body.success).toBe(true);
    expect(activityRes.body.data.items.map((item: any) => item.id))
      .toEqual(detailsRes.body.data.activity.items.map((item: any) => item.id));
  });

  it('rejects an unrelated participant and an invalid booking id', async () => {
    const forbidden = response();
    await getBookingDetails(
      request({ _id: new Types.ObjectId(), role: 'customer' }) as any,
      forbidden as any,
      vi.fn() as any,
    );
    expect(forbidden.status).toHaveBeenCalledWith(403);

    const invalid = response();
    await getBookingDetails(
      request({ _id: customerId, role: 'customer' }, { bookingId: 'not-an-id' }) as any,
      invalid as any,
      vi.fn() as any,
    );
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it('adds details to the admin full response with only authorized admin links', async () => {
    const res = response();
    await getAdminBookingDetail(
      {
        params: { id: String(bookingId) },
        user: {
          _id: new Types.ObjectId(),
          role: 'admin',
          adminPermissionLevels: { bookings: 'read' },
        },
        admin: undefined,
      } as any,
      res as any,
    );

    expect(res.body.success).toBe(true);
    expect(res.body.data.booking).toMatchObject({ _id: bookingId });
    expect(res.body.data.details).toMatchObject({
      viewerRole: 'admin',
      internal: { notes: 'INTERNAL SECRET NOTE' },
      adminLinks: { booking: `/admin/bookings/${bookingId}` },
    });
    expect(res.body.data.details.adminLinks).not.toHaveProperty('disputes');
    expect(res.body.data.details.adminLinks).not.toHaveProperty('payments');
  });

  it('records post-booking answers with snapshot wording, metadata and an honest actor/time', async () => {
    const source: any = booking();
    source.customer = customerId;
    source.project = {
      ...source.project,
      postBookingQuestions: [
        { _id: 'pq-edited', question: 'Edited live question?', type: 'text', isRequired: false },
      ],
    };
    source.bookingSnapshot = {
      capturedAt: new Date('2026-01-20T09:00:00.000Z'),
      source: 'booking_creation',
      questions: {
        postBooking: [
          {
            questionId: 'pq-1',
            question: 'Parking available?',
            type: 'checkbox',
            options: ['yes', 'no'],
            isRequired: true,
          },
          {
            questionId: 'pq-2',
            question: 'Confirmed?',
            type: 'text',
            isRequired: true,
          },
        ],
      },
    };
    source.save = vi.fn(async () => source);
    mocks.bookingFindById.mockImplementation(() => query(source));

    const res = response();
    await submitPostBookingAnswers(
      {
        params: { bookingId: String(bookingId) },
        body: {
          answers: [
            { questionId: 'pq-1', question: 'Parking available?', answer: 'false' },
            { questionId: 'pq-2', question: 'Confirmed?', answer: '0' },
          ],
        },
        user: { _id: customerId, role: 'customer' },
      } as any,
      res as any,
      vi.fn() as any,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(source.postBookingData).toEqual([
      expect.objectContaining({
        questionId: 'pq-1',
        question: 'Parking available?',
        answer: 'false',
        fieldType: 'checkbox',
        options: ['yes', 'no'],
      }),
      expect.objectContaining({
        questionId: 'pq-2',
        question: 'Confirmed?',
        answer: '0',
        fieldType: 'text',
      }),
    ]);
    expect(source.postBookingSubmittedBy.toString()).toBe(customerId.toString());
    expect(source.postBookingSubmittedAt).toBeInstanceOf(Date);
    expect(source.save).toHaveBeenCalled();
  });

  it('rejects a post-booking file answer the customer does not own', async () => {
    const source: any = booking();
    source.customer = customerId;
    source.project = {
      ...source.project,
      postBookingQuestions: [
        { _id: 'pq-file', question: 'Upload proof', type: 'attachment', isRequired: true },
      ],
    };
    source.postBookingData = [];
    source.save = vi.fn(async () => source);
    mocks.bookingFindById.mockImplementation(() => query(source));

    const res = response();
    await submitPostBookingAnswers(
      {
        params: { bookingId: String(bookingId) },
        body: {
          answers: [{
            questionId: 'pq-file',
            question: 'Upload proof',
            answer: `https://fixera-uploads.s3.us-east-1.amazonaws.com/rfq-attachments/${professionalId}/forged.pdf`,
          }],
        },
        user: { _id: customerId, role: 'customer' },
      } as any,
      res as any,
      vi.fn() as any,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(source.save).not.toHaveBeenCalled();
  });
});
