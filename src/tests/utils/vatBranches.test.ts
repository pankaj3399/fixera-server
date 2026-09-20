import { describe, expect, it, vi, beforeEach } from "vitest";

const { findOneMock } = vi.hoisted(() => ({ findOneMock: vi.fn() }));
vi.mock("../../models/serviceConfiguration", () => ({
  default: { findOne: findOneMock },
}));

import {
  resolveVatDecisionFromConfig,
  resolveSupplierB2BInvoiceDecision,
  resolveSupplierInvoiceVatDecision,
} from "../../utils/vatManagement";

const mockConfig = (config: unknown) => {
  findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(config) });
};

const baseConfig = {
  category: "Cleaning",
  vatManagement: { enabled: false, article47Classification: "immovable" },
};

describe("VAT SSOT branch table — customer leg", () => {
  beforeEach(() => findOneMock.mockReset());

  const cases: Array<{
    name: string;
    params: Parameters<typeof resolveVatDecisionFromConfig>[0];
    expect: { country: string; reverseCharge: boolean; appliedRate?: number };
  }> = [
    {
      name: "B2C immovable -> booking country, standard, no RC",
      params: { country: "BE", bookingCountry: "BE", customerType: "individual" },
      expect: { country: "BE", reverseCharge: false, appliedRate: 21 },
    },
    {
      name: "B2B movable -> business country",
      params: { bookingCountry: "BE", businessCountry: "NL", propertyNature: "movable", customerType: "business", vatNumber: "NL123456789B01", isVatVerified: false },
      expect: { country: "NL", reverseCharge: false },
    },
    {
      name: "B2B immovable BE verified -> RC",
      params: { country: "BE", bookingCountry: "BE", customerType: "business", vatNumber: "BE0123456789", isVatVerified: true, propertyNature: "immovable" },
      expect: { country: "BE", reverseCharge: true, appliedRate: 0 },
    },
    {
      name: "B2B movable BE verified -> no RC (BE branch)",
      params: { country: "BE", bookingCountry: "BE", customerType: "business", vatNumber: "BE0123456789", isVatVerified: true, propertyNature: "movable" },
      expect: { country: "BE", reverseCharge: false },
    },
    {
      name: "B2B CH exception -> no RC",
      params: { country: "CH", bookingCountry: "CH", customerType: "business", vatNumber: "CHE123456789", isVatVerified: true },
      expect: { country: "CH", reverseCharge: false },
    },
    {
      name: "unverified B2B -> no RC",
      params: { country: "NL", bookingCountry: "NL", customerType: "business", vatNumber: "NL123456789B01", isVatVerified: false },
      expect: { country: "NL", reverseCharge: false },
    },
    {
      name: "unknown country -> rfq with trace",
      params: { country: "Atlantis", customerType: "individual" },
      expect: { country: "", reverseCharge: false },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      mockConfig(baseConfig);
      const decision = await resolveVatDecisionFromConfig(c.params as any);
      expect(decision.country).toBe(c.expect.country);
      expect(decision.reverseCharge).toBe(c.expect.reverseCharge);
      if (c.expect.appliedRate !== undefined) expect(decision.appliedRate).toBe(c.expect.appliedRate);
      expect(Array.isArray(decision.trace)).toBe(true);
      expect(decision.trace!.length).toBeGreaterThan(0);
    });
  }
});

describe("VAT SSOT branch table — supplier leg", () => {
  const cases: Array<{
    name: string;
    params: Parameters<typeof resolveSupplierB2BInvoiceDecision>[0];
    expect: { country: string; reverseCharge: boolean };
  }> = [
    {
      name: "supplier immovable -> booking country",
      params: { supplierCountry: "NL", buyerCountry: "BE", bookingCountry: "DE", supplierVatNumber: "NL123456789B01", buyerVatNumber: "BE1002103337", propertyNature: "immovable" },
      expect: { country: "DE", reverseCharge: true },
    },
    {
      name: "supplier movable -> professional country",
      params: { supplierCountry: "NL", buyerCountry: "BE", supplierVatNumber: "NL123456789B01", buyerVatNumber: "BE1002103337", propertyNature: "movable" },
      expect: { country: "NL", reverseCharge: true },
    },
    {
      name: "supplier BE movable -> no RC",
      params: { supplierCountry: "BE", buyerCountry: "BE", supplierVatNumber: "BE0123456789", buyerVatNumber: "BE1002103337", propertyNature: "movable" },
      expect: { country: "BE", reverseCharge: false },
    },
    {
      name: "supplier BE immovable verified -> RC",
      params: { supplierCountry: "BE", buyerCountry: "BE", bookingCountry: "BE", supplierVatNumber: "BE0123456789", buyerVatNumber: "BE1002103337", propertyNature: "immovable" },
      expect: { country: "BE", reverseCharge: true },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const decision = resolveSupplierB2BInvoiceDecision(c.params);
      expect(decision.country).toBe(c.expect.country);
      expect(decision.reverseCharge).toBe(c.expect.reverseCharge);
      expect(Array.isArray(decision.trace)).toBe(true);
    });
  }
});

describe("supplier self-bill honors the service configuration rate", () => {
  beforeEach(() => findOneMock.mockReset());

  const reducedConfig = {
    category: "Cleaning",
    service: "Moving",
    vatManagement: {
      enabled: true,
      article47Classification: "movable",
      rateRuleGroup: "renovation",
      reducedVatQuestions: [],
      professionalVatQuestions: [],
      logicRules: [
        {
          country: "BE",
          standardRate: 21,
          reducedRate: 6,
          conditions: [
            { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
            { fieldName: "private_housing", operator: "equals", value: true, connector: "AND" },
          ],
          action: "reduced_rate",
          priority: 1,
          isActive: true,
        },
      ],
    },
  };

  const baseParams = {
    serviceConfigurationId: "507f1f77bcf86cd799439011",
    supplierCountry: "BE",
    buyerCountry: "BE",
    supplierVatNumber: "BE0123456789",
    buyerVatNumber: "BE1002103337",
    buyerVatVerified: true,
    professionalAnswers: { building_age: 12, private_housing: true },
  };

  it("applies the configured 6% reduced rate instead of the 21% standard rate", async () => {
    mockConfig(reducedConfig);
    const decision = await resolveSupplierInvoiceVatDecision(baseParams);
    expect(decision.country).toBe("BE");
    expect(decision.reverseCharge).toBe(false);
    expect(decision.action).toBe("reduced_rate");
    expect(decision.appliedRate).toBe(6);
    expect(decision.standardRate).toBe(21);
  });

  it("falls back to the standard rate when the rule conditions do not match", async () => {
    mockConfig(reducedConfig);
    const decision = await resolveSupplierInvoiceVatDecision({
      ...baseParams,
      professionalAnswers: { building_age: 4, private_housing: true },
    });
    expect(decision.action).toBe("standard_rate");
    expect(decision.appliedRate).toBe(21);
  });

  it("uses the configured standard rate when no reduced-rate rule matches", async () => {
    mockConfig({
      ...reducedConfig,
      vatManagement: {
        ...reducedConfig.vatManagement,
        logicRules: [
          {
            country: "BE",
            standardRate: 20,
            reducedRate: 6,
            conditions: [{ fieldName: "building_age", operator: "greater_than_or_equal", value: 100 }],
            action: "reduced_rate",
            priority: 1,
            isActive: true,
          },
        ],
      },
    });
    const decision = await resolveSupplierInvoiceVatDecision({
      ...baseParams,
      professionalAnswers: { building_age: 12, private_housing: true },
    });
    expect(decision.action).toBe("standard_rate");
    expect(decision.standardRate).toBe(20);
    expect(decision.appliedRate).toBe(20);
  });

  it("still applies reverse charge for immovable work regardless of the configured rate", async () => {
    mockConfig({
      ...reducedConfig,
      vatManagement: { ...reducedConfig.vatManagement, article47Classification: "immovable" },
    });
    const decision = await resolveSupplierInvoiceVatDecision({
      ...baseParams,
      propertyNature: "immovable",
    });
    expect(decision.reverseCharge).toBe(true);
    expect(decision.appliedRate).toBe(0);
    expect(decision.vatLabel).toBe("Reverse Charge");
  });

  it("does not resolve a config from a partial natural key", async () => {
    mockConfig(reducedConfig);
    findOneMock.mockClear();
    const decision = await resolveSupplierInvoiceVatDecision({
      // category without service and no serviceConfigurationId
      category: "Cleaning",
      supplierCountry: "BE",
      buyerCountry: "BE",
      supplierVatNumber: "BE0123456789",
      buyerVatNumber: "BE1002103337",
      buyerVatVerified: true,
      professionalAnswers: { building_age: 12, private_housing: true },
    });
    expect(findOneMock).not.toHaveBeenCalled();
    expect(decision.action).toBe("standard_rate");
    expect(decision.appliedRate).toBe(21);
  });
});
