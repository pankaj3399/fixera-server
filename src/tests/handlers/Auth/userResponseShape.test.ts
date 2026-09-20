import { describe, expect, it, vi } from "vitest";

vi.mock("../../../models/user", () => ({ default: {} }));
vi.mock("../../../utils/emailService", () => ({
  generateOTP: vi.fn(),
  sendOTPEmail: vi.fn(),
  sendWelcomeEmail: vi.fn(),
  sendIdExpiredEmail: vi.fn(),
}));
vi.mock("../../../utils/referralSystem", () => ({
  generateReferralCode: vi.fn(),
  validateReferralCode: vi.fn(),
  createReferral: vi.fn(),
}));
vi.mock("../../../utils/bookingBlocks", () => ({
  buildBookingBlockedRanges: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../../utils/functions", () => ({
  default: vi.fn(() => "jwt-token"),
}));
vi.mock("twilio", () => ({ default: vi.fn(() => ({})) }));

import { buildUserResponse } from "../../../handlers/Auth";

describe("buildUserResponse", () => {
  it("includes the customer address fields the client needs after login", () => {
    const response = buildUserResponse({
      _id: "u1",
      name: "Customer",
      email: "customer@example.com",
      role: "customer",
      customerType: "business",
      businessName: "ACME BV",
      companyAddress: { address: "Rue 1", city: "Brussels", postalCode: "1000", country: "BE" },
      location: { type: "Point", coordinates: [4.35, 50.85], country: "BE" },
    });

    expect(response.companyAddress).toEqual({
      address: "Rue 1",
      city: "Brussels",
      postalCode: "1000",
      country: "BE",
    });
    expect(response.location?.country).toBe("BE");
    expect(response.customerType).toBe("business");
    expect(response.businessName).toBe("ACME BV");
  });

  it("keeps parity with the fields the frontend reads for professionals", () => {
    const response = buildUserResponse({
      _id: "p1",
      name: "Pro",
      email: "pro@example.com",
      role: "professional",
      businessInfo: { companyName: "Pro BV", country: "NL", vatNumber: "NL123456789B01" },
      points: undefined,
      totalSpent: undefined,
    });

    expect(response.businessInfo?.country).toBe("NL");
    expect(response.points).toBe(0);
    expect(response.totalSpent).toBe(0);
    expect(response.accountStatus).toBe("active");
  });
});
