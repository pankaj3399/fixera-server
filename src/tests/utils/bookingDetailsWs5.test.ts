import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
});

import { buildBookingDetails } from '../../utils/bookingDetails/projection';
import type { ActorMap } from '../../utils/bookingDetails/actors';

const customerId = new Types.ObjectId('507f1f77bcf86cd799439011');
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');
const bookingId = new Types.ObjectId('507f1f77bcf86cd799439015');

const actors: ActorMap = new Map([
  [String(customerId), {
    id: String(customerId), name: 'Carla Customer', username: 'carla',
    email: 'carla@example.com', role: 'customer', companyName: null,
  }],
  [String(professionalId), {
    id: String(professionalId), name: 'Piet Professional', username: 'piet',
    email: 'piet@example.com', role: 'professional', companyName: 'Piet Works',
  }],
]);

const baseBooking = (overrides: Record<string, any> = {}) => ({
  _id: bookingId,
  bookingNumber: 'BK-2026-000001',
  bookingType: 'project',
  status: 'booked',
  customer: customerId,
  professional: professionalId,
  project: null,
  statusHistory: [],
  quoteVersions: [],
  createdAt: new Date('2026-01-20T09:00:00.000Z'),
  updatedAt: new Date('2026-02-03T10:00:00.000Z'),
  ...overrides,
});

const cancellation = (overrides: Record<string, any> = {}) => ({
  _id: new Types.ObjectId('507f1f77bcf86cd799439031'),
  booking: bookingId,
  requestedBy: customerId,
  requestedRole: 'customer',
  reasonCategory: 'scheduling_conflict',
  reason: 'Scheduling conflict',
  evidence: [],
  status: 'pending',
  createdAt: new Date('2026-02-06T10:00:00.000Z'),
  responseDeadline: new Date('2026-02-13T10:00:00.000Z'),
  ...overrides,
});

const build = (viewerRole: 'customer' | 'professional' | 'admin', overrides: Record<string, any> = {}) =>
  buildBookingDetails({
    booking: { ...baseBooking(overrides.booking), __cancellationRequests: overrides.cancellations ?? [] },
    payments: overrides.payments ?? [],
    cancellations: overrides.cancellations ?? [],
    warrantyClaims: overrides.warrantyClaims ?? [],
    actors: overrides.actors ?? actors,
    viewerRole,
    adminAccess: viewerRole === 'admin'
      ? { bookings: true, disputes: true, warranty: true, cancellations: true, payments: true }
      : undefined,
  });

describe('cancellation requests in booking details (client bug list #3)', () => {
  it('exposes status, reason, requested dates and actor to the customer', async () => {
    const details = await build('customer', { cancellations: [cancellation()] });
    expect(details.cancellations).toHaveLength(1);
    expect(details.cancellations[0]).toMatchObject({
      status: 'pending',
      reasonCategory: 'scheduling_conflict',
      reason: 'Scheduling conflict',
      requestedRole: 'customer',
      createdAt: '2026-02-06T10:00:00.000Z',
      responseDeadline: '2026-02-13T10:00:00.000Z',
    });
    expect(details.cancellations[0].requestedBy).toMatchObject({ role: 'customer', name: 'Carla Customer' });
    // The booking page timeline also surfaces the request to participants.
    expect(details.activity.items.some((item) => item.type === 'cancellation_requested')).toBe(true);
  });

  it('exposes the same request to the professional', async () => {
    const details = await build('professional', { cancellations: [cancellation()] });
    expect(details.cancellations).toHaveLength(1);
    expect(details.cancellations[0].reason).toBe('Scheduling conflict');
  });

  it('withholds the admin-authored resolution note from participants', async () => {
    const request = cancellation({ adminResolutionNote: 'INTERNAL ADMIN NOTE', status: 'denied', denyReason: 'Policy' });
    const customer = await build('customer', { cancellations: [request] });
    expect(customer.cancellations[0].adminResolutionNote).toBeNull();
    const admin = await build('admin', { cancellations: [request] });
    expect(admin.cancellations[0].adminResolutionNote).toBe('INTERNAL ADMIN NOTE');
  });
});

describe('reschedule canRespond and terminal state (client bug list #9c)', () => {
  const pendingEntry = {
    requestedBy: professionalId,
    requestedAt: new Date('2026-02-07T10:00:00.000Z'),
    reason: 'New date needed',
    description: 'Access moved',
    status: 'pending',
    previousSchedule: { scheduledStartDate: new Date('2026-02-10T09:00:00.000Z') },
    proposedSchedule: { scheduledStartDate: new Date('2026-02-12T09:00:00.000Z') },
  };

  it('marks the live pending request respondable', async () => {
    const details = await build('customer', {
      booking: {
        status: 'rescheduling_requested',
        rescheduleRequest: { ...pendingEntry, status: 'pending' },
      },
    });
    expect(details.booking.schedule.reschedulePending).toBe(true);
    expect(details.reschedules).toHaveLength(1);
    expect(details.reschedules[0]).toMatchObject({ status: 'pending', canRespond: true });
  });

  it('marks settled history entries as not respondable', async () => {
    const details = await build('customer', {
      booking: {
        status: 'booked',
        rescheduleHistory: [{
          ...pendingEntry,
          status: 'accepted',
          respondedAt: new Date('2026-02-07T11:00:00.000Z'),
          respondedBy: customerId,
        }],
      },
    });
    expect(details.reschedules).toHaveLength(1);
    expect(details.reschedules[0]).toMatchObject({ status: 'accepted', canRespond: false });
  });

  it('exposes a disputed request as terminal and never respondable', async () => {
    const details = await build('customer', {
      booking: {
        status: 'dispute',
        dispute: {
          type: 'reschedule',
          reason: 'Date changed',
          raisedAt: new Date('2026-02-08T10:00:00.000Z'),
          raisedBy: customerId,
        },
        rescheduleHistory: [{
          ...pendingEntry,
          status: 'disputed',
          respondedAt: new Date('2026-02-08T10:00:00.000Z'),
          respondedBy: customerId,
        }],
      },
    });
    expect(details.reschedules).toHaveLength(1);
    expect(details.reschedules[0]).toMatchObject({ status: 'disputed', canRespond: false });
    expect(details.activity.items.some((item) => item.type === 'reschedule_disputed')).toBe(true);
  });
});

describe('milestone expected charges in booking details (client bug list #19b)', () => {
  const milestoneBooking = {
    status: 'booked',
    milestonePayments: [
      { title: 'Deposit', amount: 100, order: 0, status: 'pending', workStatus: 'pending' },
      { title: 'Final', amount: 200, order: 1, status: 'pending', workStatus: 'pending' },
    ],
    selectedExtraOptions: [{ extraOptionId: 'opt-1', bookedPrice: 20 }],
    quoteVersions: [{
      version: 1,
      quotationNumber: 'QT-1',
      customerTotals: { commissionPercent: 10 },
    }],
    currentQuoteVersion: 1,
  };

  it('puts the full options charge on the first milestone only', async () => {
    const details = await build('customer', { booking: milestoneBooking });
    expect(details.payments.milestones).toHaveLength(2);
    expect(details.payments.milestones[0]).toMatchObject({
      expectedCustomerCharge: 132,
      includesSelectedOptions: true,
    });
    expect(details.payments.milestones[1]).toMatchObject({
      expectedCustomerCharge: 220,
      includesSelectedOptions: false,
    });
  });

  it('reports null expected charges when no commission was recorded', async () => {
    const details = await build('customer', {
      booking: { ...milestoneBooking, quoteVersions: [], currentQuoteVersion: undefined },
    });
    expect(details.payments.milestones[0].expectedCustomerCharge).toBeNull();
    expect(details.payments.milestones[0].includesSelectedOptions).toBe(false);
  });
});
