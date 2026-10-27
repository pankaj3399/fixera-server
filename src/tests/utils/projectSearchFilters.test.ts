import { describe, expect, it } from "vitest";
import { parseDateOnly, parsePriceBound, projectMatchesDimensions } from "../../utils/search/projectFilters";

describe("project search filters", () => {
  it("treats blank price as omitted and zero as a real inclusive bound", () => {
    expect(parsePriceBound("")).toEqual({ invalid: false });
    expect(parsePriceBound("0")).toEqual({ value: 0, invalid: false });
    expect(parsePriceBound("Infinity").invalid).toBe(true);
    expect(projectMatchesDimensions({ subprojects: [{ pricing: { type: "fixed", amount: 0 } }] }, { priceMin: 0, priceMax: 0 })).toBe(true);
    expect(projectMatchesDimensions({ subprojects: [{ pricing: { type: "fixed", amount: 201 } }] }, { priceMax: 200 })).toBe(false);
  });

  it("matches RFQ only when a known numeric range overlaps", () => {
    expect(projectMatchesDimensions({ subprojects: [{ pricing: { type: "rfq" } }] }, { priceMin: 0, priceMax: 200 })).toBe(false);
    expect(projectMatchesDimensions({ subprojects: [{ pricing: { type: "rfq", priceRange: { min: 180, max: 240 } } }] }, { priceMax: 200 })).toBe(true);
    expect(projectMatchesDimensions({ subprojects: [{ pricing: { type: "rfq", priceRange: { min: 201, max: 240 } } }] }, { priceMax: 200 })).toBe(false);
  });

  it("compares the card's commission and customer loyalty price", () => {
    const project = { subprojects: [{ pricing: { type: "fixed", amount: 100 } }] };
    expect(projectMatchesDimensions(project, { priceMin: 99, priceMax: 100, commissionPercent: 10, loyaltyDiscountPercent: 10 })).toBe(true);
    expect(projectMatchesDimensions(project, { priceMin: 100.01, commissionPercent: 10, loyaltyDiscountPercent: 10 })).toBe(false);
    expect(projectMatchesDimensions(project, { priceMin: 109, priceMax: 109, commissionPercent: 10, loyaltyDiscountPercent: 10, loyaltyDiscountMax: 1 })).toBe(true);
  });

  it("normalizes dimensions, ORs values within a facet, and counts package matches per project", () => {
    const project = { subprojects: [
      { pricing: { type: " UNIT " }, projectType: ["Residential"], included: [{ name: "Labor" }] },
      { pricing: { type: "fixed" }, projectType: ["Commercial"], included: [{ name: "Materials" }] },
    ] };
    expect(projectMatchesDimensions(project, { priceModels: ["unit"], projectTypes: ["commercial"], includedItems: ["labor"] })).toBe(true);
    expect(projectMatchesDimensions(project, { priceModels: ["unit"], projectTypes: ["outdoor"] })).toBe(false);
    expect(projectMatchesDimensions(project, {
      priceModels: ["fixed"], priceMin: 100, priceMax: 200,
    })).toBe(false);
  });

  it("parses only real date-only values and accepts leap day", () => {
    expect(parseDateOnly("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(parseDateOnly("2025-02-29")).toBeUndefined();
    expect(parseDateOnly("2026-10")).toBeUndefined();
  });
});
