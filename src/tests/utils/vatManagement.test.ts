import { describe, expect, it } from "vitest";
import {
  applyB2BInvoiceRule,
  ARTICLE_47_FIELD_NAME,
  countryFromAddressText,
  evaluateVatRule,
  firstVatCountry,
  getStandardVatRate,
  isB2BSameAsB2CCountry,
  normalizeVatCountry,
  parseFlexibleNumber,
  parseVatCountryCode,
  requiresVatRfqReview,
  resolveArticle47Classification,
  resolvePlaceOfSupplyCountry,
  resolvePropertyNature,
  resolveSupplierB2BInvoiceDecision,
  type VatDecision,
} from "../../utils/vatManagement";
import type { IVatLogicRule } from "../../models/serviceConfiguration";

describe("normalizeVatCountry", () => {
  it("does not invent Belgium when the country is missing", () => {
    expect(normalizeVatCountry(undefined)).toBe("");
    expect(normalizeVatCountry("")).toBe("");
    expect(normalizeVatCountry("   ")).toBe("");
  });

  it("passes through ISO-2 codes", () => {
    expect(normalizeVatCountry("nl")).toBe("NL");
    expect(normalizeVatCountry("DE")).toBe("DE");
  });

  it("maps EL (Greek VAT prefix) to GR", () => {
    expect(normalizeVatCountry("EL")).toBe("GR");
  });

  it("maps country names and aliases", () => {
    expect(normalizeVatCountry("Belgium")).toBe("BE");
    expect(normalizeVatCountry("The Netherlands")).toBe("NL");
    expect(normalizeVatCountry("Nederland")).toBe("NL");
    expect(normalizeVatCountry("holland")).toBe("NL");
    expect(normalizeVatCountry("United Kingdom")).toBe("GB");
    expect(normalizeVatCountry("Czech Republic")).toBe("CZ");
  });

  it("returns empty string for unknown countries", () => {
    expect(normalizeVatCountry("Atlantis")).toBe("");
  });
});

describe("parseVatCountryCode / firstVatCountry", () => {
  it("does not treat an empty profile country as Belgium", () => {
    expect(parseVatCountryCode("")).toBe("");
    expect(parseVatCountryCode(undefined)).toBe("");
    expect(firstVatCountry("", undefined, "Nederland")).toBe("NL");
    expect(firstVatCountry("", "BE")).toBe("BE");
    expect(firstVatCountry("Atlantis", undefined)).toBe("");
    expect(parseVatCountryCode("XX")).toBe("");
  });

  it("reads a country name from a formatted service address", () => {
    expect(countryFromAddressText("Keizersgracht 1, Amsterdam, Nederland")).toBe("NL");
  });
});

describe("getStandardVatRate", () => {
  it("returns configured standard rates", () => {
    expect(getStandardVatRate("BE")).toBe(21);
    expect(getStandardVatRate("Germany")).toBe(19);
    expect(getStandardVatRate("CH")).toBe(8.1);
    expect(getStandardVatRate("NO")).toBe(25);
    expect(getStandardVatRate("GR")).toBe(24);
  });

  it("returns 0 for non-VAT countries and unknowns", () => {
    expect(getStandardVatRate("US")).toBe(0);
    expect(getStandardVatRate("Atlantis")).toBe(0);
  });
});

describe("parseFlexibleNumber", () => {
  it("accepts comma decimals and grouped European numbers", () => {
    expect(parseFlexibleNumber("8,1")).toBe(8.1);
    expect(parseFlexibleNumber("25,5")).toBe(25.5);
    expect(parseFlexibleNumber("1.234,56")).toBe(1234.56);
    expect(parseFlexibleNumber("1,234")).toBeNaN();
  });
});

describe("isB2BSameAsB2CCountry", () => {
  it("matches the four non-Belgian exception countries", () => {
    for (const country of ["CH", "LI", "NO", "GR"]) {
      expect(isB2BSameAsB2CCountry(country)).toBe(true);
    }
    expect(isB2BSameAsB2CCountry("BE")).toBe(false);
  });

  it("does not match other EU countries", () => {
    expect(isB2BSameAsB2CCountry("NL")).toBe(false);
    expect(isB2BSameAsB2CCountry("DE")).toBe(false);
  });
});

const makeRule = (overrides: Partial<IVatLogicRule> = {}): IVatLogicRule => ({
  country: "BE",
  standardRate: 21,
  reducedRate: 6,
  conditions: [],
  action: "reduced_rate",
  priority: 1,
  isActive: true,
  ...overrides,
});

describe("evaluateVatRule", () => {
  it("matches when there are no conditions", () => {
    expect(evaluateVatRule(makeRule(), {})).toBe(true);
  });

  it("evaluates equals with boolean coercion", () => {
    const rule = makeRule({
      conditions: [{ fieldName: "is_residence", operator: "equals", value: true }],
    });
    expect(evaluateVatRule(rule, { is_residence: true })).toBe(true);
    expect(evaluateVatRule(rule, { is_residence: "yes" })).toBe(true);
    expect(evaluateVatRule(rule, { is_residence: false })).toBe(false);
  });

  it("evaluates numeric comparisons", () => {
    const rule = makeRule({
      conditions: [{ fieldName: "building_age", operator: "greater_than_or_equal", value: 10 }],
    });
    expect(evaluateVatRule(rule, { building_age: 12 })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: "10" })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: 9 })).toBe(false);
  });

  it("combines conditions with AND", () => {
    const rule = makeRule({
      conditions: [
        { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
        { fieldName: "is_residence", operator: "equals", value: true, connector: "AND" },
      ],
    });
    expect(evaluateVatRule(rule, { building_age: 15, is_residence: true })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: 15, is_residence: false })).toBe(false);
  });

  it("combines conditions with OR", () => {
    const rule = makeRule({
      conditions: [
        { fieldName: "building_age", operator: "greater_than_or_equal", value: 10 },
        { fieldName: "is_social_housing", operator: "equals", value: true, connector: "OR" },
      ],
    });
    expect(evaluateVatRule(rule, { building_age: 2, is_social_housing: true })).toBe(true);
    expect(evaluateVatRule(rule, { building_age: 2, is_social_housing: false })).toBe(false);
  });

  it("evaluates includes against checkbox arrays", () => {
    const rule = makeRule({
      conditions: [{ fieldName: "work_types", operator: "includes", value: "insulation" }],
    });
    expect(evaluateVatRule(rule, { work_types: ["roofing", "insulation"] })).toBe(true);
    expect(evaluateVatRule(rule, { work_types: ["roofing"] })).toBe(false);
  });

  it("supports the remaining comparison operators and unknown fallback", () => {
    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "occupancy", operator: "not_equals", value: "commercial" }] }),
        { occupancy: "residential" }
      )
    ).toBe(true);

    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "building_age", operator: "less_than", value: 10 }] }),
        { building_age: 9 }
      )
    ).toBe(true);

    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "building_age", operator: "less_than_or_equal", value: 10 }] }),
        { building_age: 10 }
      )
    ).toBe(true);

    expect(
      evaluateVatRule(
        makeRule({ conditions: [{ fieldName: "building_age", operator: "mystery" as any, value: 10 }] }),
        { building_age: 10 }
      )
    ).toBe(false);
  });
});

const makeDecision = (overrides: Partial<VatDecision> = {}): VatDecision => ({
  action: "standard_rate",
  country: "NL",
  standardRate: 21,
  appliedRate: 21,
  reverseCharge: false,
  explanation: "Standard VAT rate 21% applied.",
  ...overrides,
});

describe("applyB2BInvoiceRule", () => {
  it("keeps decision untouched for individuals", () => {
    const decision = makeDecision();
    expect(applyB2BInvoiceRule(decision, "individual", "NL123456789B01", true)).toEqual(decision);
  });

  it("applies Reverse Charge for verified EU B2B outside exception countries", () => {
    const result = applyB2BInvoiceRule(makeDecision(), "business", "NL123456789B01", true);
    expect(result.appliedRate).toBe(0);
    expect(result.reverseCharge).toBe(true);
    expect(result.vatLabel).toBe("Reverse Charge");
  });

  it("keeps local B2C rates for CH, LI, NO, and GR B2B", () => {
    for (const country of ["CH", "LI", "NO", "GR"]) {
      const decision = makeDecision({ country, appliedRate: country === "GR" ? 24 : 8.1 });
      const result = applyB2BInvoiceRule(decision, "business", "BE0123456789", true);
      expect(result.reverseCharge).toBe(false);
      expect(result.appliedRate).toBe(decision.appliedRate);
    }
  });

  it("keeps Belgian B2B movable work on the B2C rate", () => {
    const decision = makeDecision({ country: "BE", appliedRate: 21, standardRate: 21 });
    const result = applyB2BInvoiceRule(decision, "business", "BE0123456789", true, {
      propertyNature: "movable",
    });
    expect(result.reverseCharge).toBe(false);
    expect(result.appliedRate).toBe(21);
  });

  it("applies Reverse Charge for Belgian B2B immovable work", () => {
    const decision = makeDecision({ country: "BE", appliedRate: 6, standardRate: 21 });
    const result = applyB2BInvoiceRule(decision, "business", "BE0123456789", true, {
      propertyNature: "immovable",
    });
    expect(result.reverseCharge).toBe(true);
    expect(result.appliedRate).toBe(0);
    expect(result.vatLabel).toBe("Reverse Charge");
  });

  it("keeps Belgian B2C rates when immovable work is exempt from Belgian reverse charge", () => {
    const decision = makeDecision({ country: "BE", appliedRate: 6, standardRate: 21 });
    const result = applyB2BInvoiceRule(decision, "business", "BE0123456789", true, {
      propertyNature: "immovable",
      exemptFromBelgianReverseCharge: true,
    });
    expect(result.reverseCharge).toBe(false);
    expect(result.appliedRate).toBe(6);
  });

  it("requires a verified VAT number for the exemption", () => {
    const unverified = applyB2BInvoiceRule(makeDecision(), "business", "NL123456789B01", false);
    expect(unverified.reverseCharge).toBe(false);

    const missing = applyB2BInvoiceRule(makeDecision(), "business", null, true);
    expect(missing.reverseCharge).toBe(false);
  });
});

describe("resolveSupplierB2BInvoiceDecision", () => {
  it("applies Belgian reverse charge for an immovable professional invoice", () => {
    const result = resolveSupplierB2BInvoiceDecision({
      supplierCountry: "BE",
      buyerCountry: "BE",
      supplierVatNumber: "BE0123456789",
      buyerVatNumber: "BE1002103337",
      propertyNature: "immovable",
    });
    expect(result.appliedRate).toBe(0);
    expect(result.reverseCharge).toBe(true);
  });

  it("honors the Belgian immovable-work exemption on self-billing", () => {
    const result = resolveSupplierB2BInvoiceDecision({
      supplierCountry: "BE",
      buyerCountry: "BE",
      supplierVatNumber: "BE0123456789",
      buyerVatNumber: "BE1002103337",
      propertyNature: "immovable",
      exemptFromBelgianReverseCharge: true,
    });
    expect(result.appliedRate).toBe(21);
    expect(result.reverseCharge).toBe(false);
  });

  it("does not infer Belgian VAT when both supplier and buyer countries are unknown", () => {
    const result = resolveSupplierB2BInvoiceDecision({
      supplierCountry: "Atlantis",
      buyerCountry: "Unknown",
      supplierVatNumber: "XX12345678",
      buyerVatNumber: "YY12345678",
    });
    expect(result.country).toBe("");
    expect(result.standardRate).toBe(0);
    expect(result.appliedRate).toBe(0);
  });

  it("applies cross-border reverse charge when both parties have valid VAT numbers", () => {
    const result = resolveSupplierB2BInvoiceDecision({
      supplierCountry: "NL",
      buyerCountry: "BE",
      supplierVatNumber: "NL123456789B01",
      buyerVatNumber: "BE1002103337",
      propertyNature: "movable",
    });
    expect(result.country).toBe("BE");
    expect(result.appliedRate).toBe(0);
    expect(result.reverseCharge).toBe(true);
  });

  it("keeps the configured B2C rate for cross-border exception countries", () => {
    const expectedRates: Record<string, number> = { CH: 8.1, LI: 8.1, NO: 25, GR: 24 };
    for (const [buyerCountry, rate] of Object.entries(expectedRates)) {
      const result = resolveSupplierB2BInvoiceDecision({
        supplierCountry: "NL",
        buyerCountry,
        supplierVatNumber: "NL123456789B01",
        buyerVatNumber: `${buyerCountry}123456789`,
        propertyNature: "movable",
      });
      expect(result.country).toBe(buyerCountry);
      expect(result.reverseCharge).toBe(false);
      expect(result.appliedRate).toBe(rate);
    }
  });
});

describe("requiresVatRfqReview", () => {
  it("requires review for rfq decisions without reverse charge", () => {
    expect(requiresVatRfqReview({ action: "rfq", reverseCharge: false })).toBe(true);
  });

  it("does not require review when reverse charge applies", () => {
    expect(requiresVatRfqReview({ action: "rfq", reverseCharge: true })).toBe(false);
  });

  it("does not require review for standard or reduced rates", () => {
    expect(requiresVatRfqReview({ action: "standard_rate", reverseCharge: false })).toBe(false);
    expect(requiresVatRfqReview({ action: "reduced_rate", reverseCharge: false })).toBe(false);
    expect(requiresVatRfqReview(null)).toBe(false);
  });
});

describe("resolvePropertyNature", () => {
  it("uses the service classification when it is not project-dependent", () => {
    expect(resolvePropertyNature({ classification: "movable" })).toBe("movable");
    expect(resolvePropertyNature({ classification: "immovable" })).toBe("immovable");
  });

  it("uses the professional Article 47 answer when the service is project-dependent", () => {
    expect(
      resolvePropertyNature({
        classification: "project_dependent",
        professionalAnswers: { [ARTICLE_47_FIELD_NAME]: true },
      })
    ).toBe("immovable");
    expect(
      resolvePropertyNature({
        classification: "project_dependent",
        professionalAnswers: { [ARTICLE_47_FIELD_NAME]: false },
      })
    ).toBe("movable");
  });

  it("returns undefined when project-dependent classification is unanswered", () => {
    expect(
      resolvePropertyNature({
        classification: "project_dependent",
        professionalAnswers: {},
      })
    ).toBeUndefined();
  });

  it("defaults missing classification to immovable when explicitly resolved", () => {
    expect(resolveArticle47Classification(undefined)).toBe("immovable");
    expect(resolveArticle47Classification(null)).toBe("immovable");
    expect(resolvePropertyNature({ classification: "immovable" })).toBe("immovable");
    expect(resolvePropertyNature({ classification: null })).toBeUndefined();
    expect(resolvePropertyNature({})).toBeUndefined();
  });
});

describe("resolvePlaceOfSupplyCountry", () => {
  it("uses the booking address for B2C", () => {
    expect(
      resolvePlaceOfSupplyCountry({
        customerType: "individual",
        propertyNature: "movable",
        bookingCountry: "NL",
        businessCountry: "BE",
      })
    ).toBe("NL");
  });

  it("uses the booking address for B2B immovable work", () => {
    expect(
      resolvePlaceOfSupplyCountry({
        customerType: "business",
        propertyNature: "immovable",
        bookingCountry: "NL",
        businessCountry: "BE",
      })
    ).toBe("NL");
  });

  it("uses the customer business address for B2B movable work", () => {
    expect(
      resolvePlaceOfSupplyCountry({
        customerType: "business",
        propertyNature: "movable",
        bookingCountry: "NL",
        businessCountry: "DE",
      })
    ).toBe("DE");
  });

  it("does not silently turn an unknown place of supply into Belgium", () => {
    expect(
      resolvePlaceOfSupplyCountry({
        customerType: "business",
        propertyNature: "movable",
        bookingCountry: "Atlantis",
        businessCountry: "Unknown",
      })
    ).toBe("");
  });
});
