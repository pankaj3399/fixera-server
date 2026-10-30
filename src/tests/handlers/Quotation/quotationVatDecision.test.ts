import { beforeEach, describe, expect, it, vi } from "vitest";

const { findOneMock } = vi.hoisted(() => ({ findOneMock: vi.fn() }));

vi.mock("../../../models/booking", () => ({ default: {} }));
vi.mock("../../../models/user", () => ({ default: {} }));
vi.mock("../../../models/conversation", () => ({ default: {} }));
vi.mock("../../../models/chatMessage", () => ({ default: {} }));
vi.mock("../../../models/platformSettings", () => ({ default: {} }));
vi.mock("../../../models/project", () => ({ default: {} }));
vi.mock("../../../models/serviceConfiguration", () => ({
  default: { findOne: findOneMock },
}));
vi.mock("../../../handlers/Stripe/payment", () => ({ createPaymentIntent: vi.fn() }));
vi.mock("../../../utils/notifications/notify", () => ({ notify: vi.fn() }));
vi.mock("../../../utils/support/accountGuard", () => ({
  withAnonymizationWriteFence: vi.fn(),
}));

import { syncQuotationVatDecision } from "../../../handlers/Quotation";

const cleaningBothRates = {
  category: "Cleaning",
  service: "Home cleaning",
  vatManagement: {
    enabled: true,
    article47Classification: "movable",
    // Conditional rule: offered as a tier option, but never matched without
    // answers, so the base determination stays the standard rate.
    logicRules: [
      {
        country: "BE",
        standardRate: 21,
        reducedRate: 6,
        action: "reduced_rate",
        priority: 0,
        conditions: [{ fieldName: "building_age", operator: "greater_than", value: 10 }],
      },
    ],
  },
};

const booking = () => ({
  location: { country: "BE" },
  customer: {
    customerType: "individual",
    location: { country: "BE" },
  },
  project: {
    category: "Cleaning",
    service: "Home cleaning",
    vatProfessionalAnswers: [],
  },
  vatDecision: undefined as any,
});

describe("syncQuotationVatDecision per-line awareness", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(cleaningBothRates) });
  });

  it("records the reduced tier when every line uses it", async () => {
    const target: any = booking();
    await syncQuotationVatDecision(target, [{ vatRate: 6 }]);
    expect(target.vatDecision).toMatchObject({
      action: "reduced_rate",
      appliedRate: 6,
      reverseCharge: false,
    });
  });

  it("keeps the base determination for mixed lines instead of lines[0]", async () => {
    const target: any = booking();
    await syncQuotationVatDecision(target, [{ vatRate: 6 }, { vatRate: 21 }]);
    expect(target.vatDecision).toMatchObject({
      action: "standard_rate",
      appliedRate: 21,
      reverseCharge: false,
    });
    expect(String(target.vatDecision.explanation)).toContain("Mixed per-line");
  });
});
