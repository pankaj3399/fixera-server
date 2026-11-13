import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookings: [] as any[],
}));

vi.mock("../../models/booking", () => ({
  default: {
    find: vi.fn(() => ({
      select: vi.fn(() => ({
        populate: async () => mocks.bookings,
      })),
    })),
  },
}));

import { buildBookingBlockedRanges } from "../../utils/bookingBlocks";

const userId = new Types.ObjectId().toString();

const booking = (overrides: Record<string, any> = {}) => ({
  _id: new Types.ObjectId(),
  status: "booked",
  bookingNumber: "BK-2026-000042",
  rfqData: { serviceType: "Plumbing", description: "Fix sink" },
  customer: { name: "Carla Customer" },
  location: { city: "Brussels", country: "BE" },
  scheduledStartDate: new Date("2026-11-05T13:00:00.000Z"),
  scheduledExecutionEndDate: new Date("2026-11-05T15:00:00.000Z"),
  scheduledBufferStartDate: new Date("2026-11-05T15:00:00.000Z"),
  scheduledBufferEndDate: new Date("2026-11-05T15:30:00.000Z"),
  resourcePlan: [],
  assignedTeamMembers: [new Types.ObjectId(userId)],
  ...overrides,
});

describe("buildBookingBlockedRanges status/title (calendar tier colours)", () => {
  beforeEach(() => {
    mocks.bookings = [];
    vi.clearAllMocks();
  });

  it("exposes status, booking id and title on execution ranges", async () => {
    mocks.bookings = [booking()];
    const ranges = await buildBookingBlockedRanges(userId);
    const execution = ranges.find((range) => range.reason === "booking");
    expect(execution).toMatchObject({
      status: "booked",
      bookingId: String(mocks.bookings[0]._id),
      bookingNumber: "BK-2026-000042",
      title: "Plumbing",
    });
  });

  it("exposes status on buffer ranges without leaking private data", async () => {
    mocks.bookings = [booking({ status: "in_progress" })];
    const ranges = await buildBookingBlockedRanges(userId);
    const buffer = ranges.find((range) => range.reason === "booking-buffer");
    expect(buffer).toMatchObject({ status: "in_progress", title: "Plumbing" });
    expect(buffer).not.toHaveProperty("notes");
    expect(buffer).not.toHaveProperty("stripePaymentIntentId");
  });

  it("exposes status on resource-plan day ranges", async () => {
    mocks.bookings = [
      booking({
        status: "quote_accepted",
        resourcePlan: [{ resourceId: new Types.ObjectId(userId), days: [new Date("2026-11-06T00:00:00.000Z")] }],
      }),
    ];
    const ranges = await buildBookingBlockedRanges(userId);
    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      expect(range.status).toBe("quote_accepted");
      expect(range.title).toBe("Plumbing");
    }
  });

  it("falls back to a null title when no service type was recorded", async () => {
    mocks.bookings = [booking({ rfqData: undefined })];
    const ranges = await buildBookingBlockedRanges(userId);
    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      expect(range.status).toBe("booked");
      expect(range.title).toBeNull();
    }
  });
});

describe("buildBookingBlockedRanges FT3 #5/#8 retention and completed display", () => {
  const Booking = () => import("../../models/booking").then((m) => m.default as any);
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  beforeEach(() => {
    mocks.bookings = [];
    vi.clearAllMocks();
  });

  it("queries the retained partial-refund clause and leaves completed out by default", async () => {
    await buildBookingBlockedRanges(userId);
    const filter = (await Booking()).find.mock.calls[0][0];
    const statusClauses = filter.$and[0].$or;
    expect(statusClauses).toContainEqual({ status: { $nin: ["completed", "cancelled", "refunded"] } });
    expect(statusClauses).toContainEqual({
      status: "cancelled",
      refundPreservesPastPlanning: true,
      "payment.status": "partially_refunded",
    });
    expect(statusClauses.some((clause: any) => clause.status === "completed")).toBe(false);
  });

  it("adds a bounded completed clause only when the display consumer opts in", async () => {
    const now = new Date("2026-11-11T12:00:00.000Z");
    await buildBookingBlockedRanges(userId, { includeCompleted: true, now });
    const filter = (await Booking()).find.mock.calls[0][0];
    const completed = filter.$and[0].$or.find((clause: any) => clause.status === "completed");
    expect(completed.scheduledStartDate.$gte.getTime()).toBe(now.getTime() - 400 * 24 * 60 * 60 * 1000);
  });

  it("keeps the past planned days of a cancelled started booking after a partial refund", async () => {
    mocks.bookings = [
      booking({
        status: "cancelled",
        refundPreservesPastPlanning: true,
        payment: { status: "partially_refunded" },
        scheduledStartDate: new Date("2026-11-02T08:00:00.000Z"),
        scheduledExecutionEndDate: new Date("2026-11-13T17:00:00.000Z"),
        resourcePlan: [{ resourceId: new Types.ObjectId(userId), days: [day("2026-11-02"), day("2026-11-03")] }],
      }),
    ];
    const ranges = await buildBookingBlockedRanges(userId);
    expect(ranges.map((range) => range.startDate)).toEqual([
      "2026-11-02T00:00:00.000Z",
      "2026-11-03T00:00:00.000Z",
    ]);
    for (const range of ranges) {
      expect(range).toMatchObject({ status: "cancelled", retainedAfterRefund: true, reason: "booking" });
    }
  });

  it("never falls back to the whole window for a retained booking without planned days", async () => {
    mocks.bookings = [
      booking({
        status: "cancelled",
        refundPreservesPastPlanning: true,
        payment: { status: "partially_refunded" },
        resourcePlan: [{ resourceId: new Types.ObjectId(userId), days: [] }],
      }),
    ];
    expect(await buildBookingBlockedRanges(userId)).toEqual([]);
  });

  it("shows a completed booking clipped to its actual end (no future occupancy)", async () => {
    const now = new Date("2026-11-11T12:00:00.000Z");
    mocks.bookings = [
      booking({
        status: "completed",
        actualEndDate: new Date("2026-11-04T15:00:00.000Z"),
        scheduledStartDate: new Date("2026-11-02T08:00:00.000Z"),
        scheduledExecutionEndDate: new Date("2026-11-20T17:00:00.000Z"),
        scheduledBufferStartDate: new Date("2026-11-20T17:00:00.000Z"),
        scheduledBufferEndDate: new Date("2026-11-21T17:00:00.000Z"),
      }),
    ];
    const ranges = await buildBookingBlockedRanges(userId, { includeCompleted: true, now });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      status: "completed",
      reason: "booking",
      startDate: "2026-11-02T08:00:00.000Z",
      endDate: "2026-11-04T15:00:00.000Z",
    });
    expect(ranges[0]).not.toHaveProperty("retainedAfterRefund");
  });

  it("drops completed plan days after completion and clips to now without a completion timestamp", async () => {
    const now = new Date("2026-11-11T12:00:00.000Z");
    mocks.bookings = [
      booking({
        status: "completed",
        statusHistory: [{ status: "completed", timestamp: new Date("2026-11-03T18:00:00.000Z") }],
        resourcePlan: [{
          resourceId: new Types.ObjectId(userId),
          days: [day("2026-11-02"), day("2026-11-03"), day("2026-11-04")],
        }],
      }),
      booking({
        status: "completed",
        scheduledStartDate: new Date("2026-11-10T08:00:00.000Z"),
        scheduledExecutionEndDate: new Date("2026-11-14T17:00:00.000Z"),
        scheduledBufferStartDate: new Date("2026-11-14T17:00:00.000Z"),
        scheduledBufferEndDate: new Date("2026-11-15T17:00:00.000Z"),
      }),
    ];
    const ranges = await buildBookingBlockedRanges(userId, { includeCompleted: true, now });
    expect(ranges.map((range) => [range.startDate, range.endDate])).toEqual([
      ["2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"],
      ["2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
      ["2026-11-10T08:00:00.000Z", "2026-11-11T12:00:00.000Z"],
    ]);
    for (const range of ranges) {
      expect(new Date(range.endDate).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });
});
