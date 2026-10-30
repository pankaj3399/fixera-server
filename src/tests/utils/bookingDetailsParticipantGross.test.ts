import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || "fixera-uploads";
  process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "test-key";
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || "test-secret";
});

import { buildBookingDetails } from "../../utils/bookingDetails/projection";
import type { ActorMap } from "../../utils/bookingDetails/actors";

const customerId = new Types.ObjectId("507f1f77bcf86cd799439011");
const professionalId = new Types.ObjectId("507f1f77bcf86cd799439012");
const bookingId = new Types.ObjectId("507f1f77bcf86cd799439015");

const actors: ActorMap = new Map([
  [String(customerId), {
    id: String(customerId), name: "Carla Customer", username: "carla",
    email: "carla@example.com", role: "customer", companyName: null,
  }],
  [String(professionalId), {
    id: String(professionalId), name: "Piet Professional", username: "piet",
    email: "piet@example.com", role: "professional", companyName: "Piet Works",
  }],
]);

const paidBooking = {
  _id: bookingId,
  bookingNumber: "BK-2026-000001",
  bookingType: "project",
  status: "booked",
  customer: customerId,
  professional: professionalId,
  project: null,
  statusHistory: [],
  quoteVersions: [],
  quote: { amount: 100, currency: "EUR" },
  payment: { currency: "EUR", stripePaymentIntentId: "pi_test_123" },
  createdAt: new Date("2026-01-20T09:00:00.000Z"),
  updatedAt: new Date("2026-02-03T10:00:00.000Z"),
};

const paidPaymentRow = {
  _id: new Types.ObjectId("507f1f77bcf86cd799439021"),
  status: "completed",
  currency: "EUR",
  netAmount: 100,
  vatAmount: 21,
  vatRate: 21,
  totalWithVat: 121,
  stripePaymentIntentId: "pi_test_123",
};

const pendingReschedule = {
  requestedBy: professionalId,
  requestedAt: new Date("2026-02-07T10:00:00.000Z"),
  reason: "New date needed",
  status: "pending",
  previousSchedule: { scheduledStartDate: new Date("2026-02-10T09:00:00.000Z") },
  proposedSchedule: { scheduledStartDate: new Date("2026-02-12T09:00:00.000Z") },
};

const pendingCancellation = {
  _id: new Types.ObjectId("507f1f77bcf86cd799439031"),
  booking: bookingId,
  requestedBy: customerId,
  requestedRole: "customer",
  reasonCategory: "scheduling_conflict",
  reason: "Scheduling conflict",
  evidence: [],
  status: "pending",
  createdAt: new Date("2026-02-06T10:00:00.000Z"),
  responseDeadline: new Date("2026-02-13T10:00:00.000Z"),
};

describe("booking details VAT gross + cancellation/reschedule DTOs (participant view)", () => {
  it.each(["customer", "professional"] as const)(
    "exposes the recorded VAT-inclusive gross as payments.base.totalWithVat to the %s",
    async (viewerRole) => {
      const details = await buildBookingDetails({
        booking: { ...paidBooking },
        payments: [{ ...paidPaymentRow }],
        cancellations: [],
        warrantyClaims: [],
        actors,
        viewerRole,
      });
      expect(details.payments.base?.totalWithVat).toBe(121);
      expect(details.payments.records[0]).toMatchObject({
        netAmount: 100,
        vatAmount: 21,
        totalWithVat: 121,
      });
    },
  );

  it.each(["customer", "professional"] as const)(
    "exposes cancellations and reschedules DTOs to the %s",
    async (viewerRole) => {
      const details = await buildBookingDetails({
        booking: {
          ...paidBooking,
          status: "rescheduling_requested",
          rescheduleRequest: { ...pendingReschedule, status: "pending" },
        },
        payments: [{ ...paidPaymentRow }],
        cancellations: [{ ...pendingCancellation }],
        warrantyClaims: [],
        actors,
        viewerRole,
      });
      expect(details.cancellations).toHaveLength(1);
      expect(details.cancellations[0]).toMatchObject({
        id: String(pendingCancellation._id),
        status: "pending",
        reason: "Scheduling conflict",
      });
      expect(details.reschedules).toHaveLength(1);
      expect(details.reschedules[0]).toMatchObject({ status: "pending", reason: "New date needed" });
    },
  );
});
