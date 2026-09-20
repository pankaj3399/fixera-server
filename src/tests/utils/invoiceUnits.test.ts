import { describe, expect, it } from "vitest";
import {
  assertValidInvoiceUnit,
  formatVatAnswerWithUnit,
  isKnownInvoiceUnit,
  mapUnitToUneceCode,
  normalizeUnitLabel,
  resolveInvoiceServiceUnit,
  tryNormalizeInvoiceUnit,
} from "../../utils/invoiceUnits";

describe("invoiceUnits", () => {
  it("normalizes common unit labels", () => {
    expect(normalizeUnitLabel("m2")).toBe("m²");
    expect(normalizeUnitLabel("m3")).toBe("m³");
    expect(normalizeUnitLabel("M3")).toBe("m³");
    expect(normalizeUnitLabel("m^3")).toBe("m³");
    expect(normalizeUnitLabel("hours")).toBe("hour");
    expect(normalizeUnitLabel("hrs")).toBe("hour");
    expect(normalizeUnitLabel("  ")).toBeUndefined();
  });

  it("maps real units to UNECE codes (no generic C62 for m²/hour)", () => {
    expect(mapUnitToUneceCode("m²")).toBe("MTK");
    expect(mapUnitToUneceCode("m³")).toBe("MTQ");
    expect(mapUnitToUneceCode("m3")).toBe("MTQ");
    expect(mapUnitToUneceCode("hour")).toBe("HUR");
    expect(mapUnitToUneceCode(undefined)).toBe("C62");
  });

  it("rejects unknown units instead of silently mapping to C62", () => {
    expect(isKnownInvoiceUnit("m²")).toBe(true);
    expect(isKnownInvoiceUnit("frobnicate")).toBe(false);
    expect(() => mapUnitToUneceCode("frobnicate")).toThrow(/Unknown UBL unit/);
    expect(() => assertValidInvoiceUnit("frobnicate", "service unit")).toThrow(/Unknown service unit/);
  });

  it("formats VAT answers with configured units", () => {
    const config = { reducedVatQuestions: [{ fieldName: "building_age", unit: "years" }], professionalVatQuestions: [] };
    expect(formatVatAnswerWithUnit("building_age", 10, config)).toBe("- building_age: 10 years");
    expect(formatVatAnswerWithUnit("private_housing", true, config)).toBe("- private_housing: true");
  });

  it("tryNormalizeInvoiceUnit never throws on malformed historical data", () => {
    expect(tryNormalizeInvoiceUnit("m2")).toBe("m²");
    expect(tryNormalizeInvoiceUnit("forfait")).toBeUndefined();
    expect(tryNormalizeInvoiceUnit(undefined)).toBeUndefined();
  });

  it("resolves the service unit from checkout, subproject, then service config", () => {
    expect(resolveInvoiceServiceUnit({ checkoutUnit: "m2", subprojectUnit: "hour" })).toBe("m²");
    expect(resolveInvoiceServiceUnit({ subprojectUnit: "hour" })).toBe("hour");
    expect(resolveInvoiceServiceUnit({ subprojectUnit: "m3" })).toBe("m³");
    expect(
      resolveInvoiceServiceUnit({
        pricingType: "unit",
        pricingOptions: [{ pricingType: "price_per_unit", unit: "room" }],
      }),
    ).toBe("room");
    expect(
      resolveInvoiceServiceUnit({
        pricingType: "fixed",
        pricingOptions: [{ pricingType: "price_per_unit", unit: "room" }],
      }),
    ).toBeUndefined();
    expect(
      resolveInvoiceServiceUnit({
        checkoutUnit: "nonsense",
        pricingType: "unit",
        pricingOptions: [{ pricingType: "price_per_unit", unit: "m³" }],
      }),
    ).toBe("m³");
  });
});
