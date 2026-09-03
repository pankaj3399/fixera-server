import { beforeEach, describe, expect, it, vi } from "vitest";

const { findOneMock } = vi.hoisted(() => ({ findOneMock: vi.fn() }));

vi.mock("../../models/serviceConfiguration", () => ({
  default: { findOne: findOneMock },
}));

import { resolveVatDecisionFromConfig, getVatRateOptionsFromConfig } from "../../utils/vatManagement";

const mockConfig = (config: unknown) => {
  findOneMock.mockReturnValue({ select: vi.fn().mockResolvedValue(config) });
};

const belgianRenovationConfig = {
  category: "Solar",
  service: "Solar panel installation",
  vatManagement: {
    enabled: true,
    article47Classification: "immovable",
    rateRuleGroup: "building_work",
    reducedVatQuestions: [],
    logicRules: [
      {
        country: "BE",
        standardRate: 21,
        reducedRate: 6,
        conditions: [
          { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
          { fieldName: "is_residence", operator: "equals", value: true, connector: "AND" },
        ],
        action: "reduced_rate",
        customText: "6% reduced VAT for renovations of homes older than 10 years.",
        priority: 1,
        isActive: true,
      },
      {
        country: "BE",
        standardRate: 21,
        reducedRate: 6,
        conditions: [
          { fieldName: "is_social_housing", operator: "equals", value: true },
        ],
        action: "rfq",
        customText: "Social housing requires a quotation review.",
        priority: 2,
        isActive: true,
      },
    ],
  },
};

describe("resolveVatDecisionFromConfig", () => {
  beforeEach(() => {
    findOneMock.mockReset();
  });

  it("falls back to the standard country rate when VAT management is disabled", async () => {
    mockConfig({ category: "Solar", vatManagement: { enabled: false } });
    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "NL",
      customerType: "individual",
    });
    expect(decision.action).toBe("standard_rate");
    expect(decision.appliedRate).toBe(21);
  });

  it("applies the reduced rate when rule conditions match", async () => {
    mockConfig(belgianRenovationConfig);
    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "Belgium",
      answers: { building_age: 15, is_residence: true },
      customerType: "individual",
    });
    expect(decision.action).toBe("reduced_rate");
    expect(decision.appliedRate).toBe(6);
    expect(decision.standardRate).toBe(21);
    expect(decision.explanation).toContain("6% reduced VAT");
  });

  it("routes to RFQ when an rfq rule matches, keeping the standard rate", async () => {
    mockConfig(belgianRenovationConfig);
    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "BE",
      answers: { building_age: 2, is_residence: false, is_social_housing: true },
      customerType: "individual",
    });
    expect(decision.action).toBe("rfq");
    expect(decision.appliedRate).toBe(21);
  });

  it("uses the standard rate when no rule matches", async () => {
    mockConfig(belgianRenovationConfig);
    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "BE",
      answers: { building_age: 2, is_residence: false, is_social_housing: false },
      customerType: "individual",
    });
    expect(decision.action).toBe("standard_rate");
    expect(decision.appliedRate).toBe(21);
  });

  it("defaults legacy VAT configs without Article 47 to immovable and applies logic rules", async () => {
    mockConfig({
      category: "Interior",
      service: "Painter & Wallpaperer",
      vatManagement: {
        enabled: true,
        rateRuleGroup: "building_work",
        reducedVatQuestions: [],
        logicRules: [
          {
            country: "BE",
            standardRate: 21,
            reducedRate: 6,
            conditions: [
              { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
              { fieldName: "private_housing", operator: "equals", value: "Yes", connector: "AND" },
            ],
            action: "reduced_rate",
            customText: "6% reduced VAT",
            priority: 1,
            isActive: true,
          },
        ],
      },
    });
    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "BE",
      answers: { building_age: 15, private_housing: "Yes" },
      customerType: "individual",
    });
    expect(decision.action).toBe("reduced_rate");
    expect(decision.appliedRate).toBe(6);
    expect(decision.propertyNature).toBe("immovable");
  });

  it("overrides with reverse charge for verified EU B2B outside exception countries", async () => {
    mockConfig(null);
    const decision = await resolveVatDecisionFromConfig({
      category: "Cleaning",
      country: "NL",
      customerType: "business",
      vatNumber: "NL123456789B01",
      isVatVerified: true,
    });
    expect(decision.reverseCharge).toBe(true);
    expect(decision.appliedRate).toBe(0);
    expect(decision.vatLabel).toBe("Reverse Charge");
  });

  it("uses the Dutch business country for a movable Dutch B2B customer", async () => {
    mockConfig(null);
    const decision = await resolveVatDecisionFromConfig({
      country: "Belgium",
      bookingCountry: "Belgium",
      businessCountry: "Nederland",
      propertyNature: "movable",
      customerType: "business",
      vatNumber: "NL123456789B01",
      isVatVerified: true,
    });

    expect(decision.country).toBe("NL");
    expect(decision.appliedRate).toBe(0);
    expect(decision.reverseCharge).toBe(true);
  });

  it("applies Reverse Charge for Belgian B2B immovable work", async () => {
    mockConfig({
      category: "Cleaning",
      vatManagement: { enabled: false, article47Classification: "immovable" },
    });
    const decision = await resolveVatDecisionFromConfig({
      category: "Cleaning",
      country: "BE",
      customerType: "business",
      vatNumber: "BE0123456789",
      isVatVerified: true,
      propertyNature: "immovable",
    });
    expect(decision.reverseCharge).toBe(true);
    expect(decision.appliedRate).toBe(0);
    expect(decision.vatLabel).toBe("Reverse Charge");
  });

  it("keeps local VAT for Belgian B2B (same-as-B2C exception)", async () => {
    mockConfig(null);
    const decision = await resolveVatDecisionFromConfig({
      category: "Cleaning",
      country: "BE",
      customerType: "business",
      vatNumber: "BE0123456789",
      isVatVerified: true,
    });
    expect(decision.reverseCharge).toBe(false);
    expect(decision.appliedRate).toBe(21);
  });

  it("requires VAT review when the country cannot be resolved", async () => {
    const decision = await resolveVatDecisionFromConfig({
      country: "Atlantis",
      customerType: "individual",
    });
    expect(decision.action).toBe("rfq");
    expect(decision.appliedRate).toBe(0);
  });

  it("does not treat an unrecognized two-letter country code as a real country", async () => {
    const decision = await resolveVatDecisionFromConfig({
      country: "XX",
      customerType: "individual",
    });
    expect(decision.country).toBe("");
    expect(decision.action).toBe("rfq");
    expect(decision.appliedRate).toBe(0);
  });

  it("requires VAT review when place-of-supply context is present but unknown", async () => {
    const decision = await resolveVatDecisionFromConfig({
      bookingCountry: "Atlantis",
      businessCountry: "Unknown",
      customerType: "business",
    });
    expect(decision.country).toBe("");
    expect(decision.action).toBe("rfq");
    expect(decision.appliedRate).toBe(0);
  });

  it("forces RFQ review for the Renovation category", async () => {
    mockConfig({ category: "Renovation", vatManagement: { enabled: false } });
    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "BE",
      customerType: "individual",
    });
    expect(decision.action).toBe("rfq");
  });
});

describe("getVatRateOptionsFromConfig", () => {
  beforeEach(() => {
    findOneMock.mockReset();
  });

  it("returns only the 0% exempt option for verified EU B2B", async () => {
    mockConfig(null);
    const options = await getVatRateOptionsFromConfig({
      category: "Cleaning",
      country: "NL",
      customerType: "business",
      vatNumber: "NL123456789B01",
      isVatVerified: true,
    });
    expect(options).toHaveLength(1);
    expect(options[0].rate).toBe(0);
    expect(options[0].reverseCharge).toBe(true);
    expect(options[0].label).toBe("Reverse Charge");
    expect(options[0].source).toBe("b2b_exempt");
  });

  it("returns standard and reduced options when a reduced rule matches", async () => {
    mockConfig(belgianRenovationConfig);
    const options = await getVatRateOptionsFromConfig({
      serviceConfigurationId: "652f1f77bcf86cd799439011",
      country: "BE",
      customerType: "individual",
      answers: { building_age: 15, is_residence: true },
    });
    const rates = options.map((option) => option.rate);
    expect(rates).toContain(6);
    expect(rates).toContain(21);
  });
});
