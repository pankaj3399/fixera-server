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
