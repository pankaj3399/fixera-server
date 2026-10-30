import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  employees: [] as any[],
  professional: null as any,
  meetings: [] as any[],
  bookingBlockedRanges: [] as any[],
}));

vi.mock("../../models/user", () => ({
  default: {
    find: vi.fn(() => ({ select: async () => mocks.employees })),
    findById: vi.fn(() => ({ select: async () => mocks.professional })),
  },
}));

vi.mock("../../models/meeting", () => ({
  default: {
    find: vi.fn(() => ({ select: async () => mocks.meetings })),
  },
}));

vi.mock("../../utils/bookingBlocks", () => ({
  buildBookingBlockedRanges: vi.fn(async () => mocks.bookingBlockedRanges),
}));

import { getEmployeeAvailability } from "../../handlers/Meeting";

const run = async (body: Record<string, unknown>) => {
  const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await getEmployeeAvailability(
    { user: { professionalId: "pro1" }, body } as any,
    response as any
  );
  return response;
};

describe("meeting employee availability (company closures, client bug list #21)", () => {
  beforeEach(() => {
    mocks.bookingBlockedRanges = [];
    mocks.meetings = [];
    mocks.employees = [
      {
        _id: "e1",
        name: "Sam Employee",
        email: "sam@example.com",
        availability: {},
        blockedDates: [],
        blockedRanges: [],
        employee: { availabilityPreference: "personal" },
      },
    ];
    mocks.professional = {
      companyAvailability: {},
      companyBlockedDates: [
        { date: new Date("2026-11-10T00:00:00.000Z"), reason: "Company closure" },
        { date: new Date("2027-05-01T00:00:00.000Z"), reason: "Far future" },
      ],
      companyBlockedRanges: [
        {
          startDate: new Date("2026-11-20T00:00:00.000Z"),
          endDate: new Date("2026-11-22T00:00:00.000Z"),
          reason: "Team holiday",
        },
        {
          startDate: new Date("2027-01-05T00:00:00.000Z"),
          endDate: new Date("2027-01-06T00:00:00.000Z"),
          reason: "Far future range",
        },
      ],
    };
  });

  it("exposes in-range company closures on every employee entry", async () => {
    const response = await run({
      employeeIds: ["e1"],
      startDate: new Date("2026-11-01T00:00:00.000Z").toISOString(),
      endDate: new Date("2026-11-30T00:00:00.000Z").toISOString(),
    });
    expect(response.status).toHaveBeenCalledWith(200);
    const body = response.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.employees).toHaveLength(1);
    expect(body.data.employees[0].companyBlockedDates).toHaveLength(1);
    expect(body.data.employees[0].companyBlockedDates[0]).toMatchObject({ reason: "Company closure" });
    expect(body.data.employees[0].companyBlockedRanges).toHaveLength(1);
    expect(body.data.employees[0].companyBlockedRanges[0]).toMatchObject({ reason: "Team holiday" });
    // The aggregate company view keeps working as before.
    expect(body.data.companyAvailability.blockedDates).toHaveLength(1);
    expect(body.data.companyAvailability.blockedRanges).toHaveLength(1);
  });
});
