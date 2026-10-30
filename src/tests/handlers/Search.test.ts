import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => {
  process.env.JWT_SECRET = "test-search-auth-secret";
  return ({
  projects: [] as any[],
  professionals: [] as any[],
  ratings: new Map<string, { avgRating: number; totalReviews: number }>(),
  schedules: new Map<string, string>(),
  scheduleCalls: [] as any[],
  commission: 0,
  principal: null as any,
}); });

vi.mock("../../models/user", () => ({
  default: {
    findById: vi.fn(() => ({ select: async () => mocks.principal })),
    distinct: vi.fn(async () => mocks.professionals.map((person) => person._id)),
    find: vi.fn(() => ({
      select() { return this; },
      lean: async () => mocks.professionals,
      distinct: async () => mocks.professionals.map((person) => person._id),
    })),
  },
}));
vi.mock("../../models/project", () => ({
  default: {
    find: vi.fn(() => ({ sort() { return this; }, lean: async () => mocks.projects })),
    aggregate: vi.fn(async () => []),
  },
}));
vi.mock("../../models/professionalLevelConfig", () => ({ default: { getCurrentConfig: vi.fn() } }));
vi.mock("../../models/loyaltyConfig", () => ({ default: { getCurrentConfig: async () => ({ tiers: [
  { name: "Bronze", minSpendingAmount: 0, discountPercentage: 0, isActive: true },
  { name: "Gold", minSpendingAmount: 1000, discountPercentage: 10, maxDiscountAmount: 5, isActive: true },
] }) } }));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: async () => ({ commissionPercent: mocks.commission }) } }));
vi.mock("../../utils/scheduleEngine", () => ({
  resolveEffectiveScheduleTimeZone: vi.fn((professional: any) => professional?.businessInfo?.timezone || "UTC"),
  buildProjectScheduleProposalsWithData: vi.fn(async (project: any, professional: any, subprojectIndex: number | undefined, durationOverride: any, _exclude: any, quantity: number) => {
    mocks.scheduleCalls.push({ project, professional, subprojectIndex, durationOverride, quantity });
    return { earliestBookableDate: mocks.schedules.get(project._id.toString()) || "2026-11-03T09:00:00.000Z" };
  }),
}));
vi.mock("../../handlers/Search/aggregateRatings", () => ({
  aggregateProfessionalRatings: vi.fn(async () => new Map()),
  aggregateProjectRatings: vi.fn(async (ids: any[]) => new Map(ids.map((id) => [id.toString(), mocks.ratings.get(id.toString()) || { avgRating: 0, totalReviews: 0 }]))),
}));

import { Types } from "mongoose";
import { search } from "../../handlers/Search";
import Project from "../../models/project";
import searchRouter from "../../routes/Search";

const proId = new Types.ObjectId("507f1f77bcf86cd799439011");
const projectId = (id: string) => new Types.ObjectId(id);
const project = (id: string, details: any = {}) => ({
  _id: projectId(id),
  professionalId: proId,
  status: "published",
  createdAt: new Date("2026-10-01"),
  category: "Home",
  service: "Plumbing",
  areaOfWork: "Indoor",
  distance: { address: "Brussels, Belgium", maxKmRange: 200 },
  subprojects: [],
  ...details,
});

const execute = async (query: Record<string, unknown>, user?: any) => {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await search({ query: { type: "projects", limit: "1", ...query }, user } as any, response as any);
  return response;
};

describe("project search handler", () => {
  beforeEach(() => {
    mocks.commission = 0;
    mocks.principal = null;
    mocks.schedules = new Map();
    mocks.scheduleCalls = [];
    mocks.ratings = new Map();
    mocks.professionals = [{
      _id: proId,
      name: "A. Pro",
      professionalLevel: "Level 2",
      adminTags: ["Verified"],
      businessInfo: { timezone: "UTC" },
      companyAvailability: {},
    }];
  });

  it("returns full-set distinct facets and paginates matching projects", async () => {
    mocks.projects = [
      project("507f1f77bcf86cd799439021", { subprojects: [
        { pricing: { type: "unit", amount: 20 }, projectType: ["Residential", "Residential"], included: [{ name: "Labor" }, { name: "Labor" }] },
        { pricing: { type: "unit", amount: 20 }, projectType: ["Residential"], included: [{ name: "Labor" }] },
      ] }),
      project("507f1f77bcf86cd799439022", { category: "Garden", service: "Landscaping", subprojects: [
        { pricing: { type: "fixed", amount: 150 }, projectType: ["Commercial"], included: [{ name: "Materials" }] },
      ] }),
    ];
    mocks.ratings = new Map([["507f1f77bcf86cd799439021", { avgRating: 4.5, totalReviews: 3 }]]);

    const first = await execute({ page: "1" });
    const body = first.json.mock.calls[0][0];
    expect(body.results).toHaveLength(1);
    expect(body.pagination).toMatchObject({ total: 2, page: 1, totalPages: 2 });
    expect(body.facets.projectTypes).toEqual({ Residential: 1, Commercial: 1 });
    expect(body.facets.includedItems).toEqual({ Labor: 1, Materials: 1 });
    expect(body.facets.professionalLevels["Level 2"]).toBe(2);
    expect(body.facets.adminTags.Verified).toBe(2);
    expect(body.facets.minRating).toEqual({ any: 2, "1": 1, "2": 1, "3": 1, "4": 1, "5": 0 });

    const second = await execute({ page: "2" });
    expect(second.json.mock.calls[0][0].results[0]._id.toString()).toBe("507f1f77bcf86cd799439022");
  });

  it("applies project package filters, inclusive prices, and preserves selected zero-count values", async () => {
    mocks.commission = 10;
    mocks.projects = [
      project("507f1f77bcf86cd799439031", { subprojects: [{ pricing: { type: "fixed", amount: 0 }, projectType: ["Residential"], included: [{ name: "Labor" }] }] }),
      project("507f1f77bcf86cd799439032", { subprojects: [{ pricing: { type: "rfq" }, projectType: ["Commercial"], included: [{ name: "Materials" }] }] }),
      project("507f1f77bcf86cd799439033", { subprojects: [{ pricing: { type: "fixed", amount: 201 }, projectType: ["Residential"], included: [{ name: "Labor" }] }] }),
    ];
    const response = await execute({ priceMin: "0", priceMax: "200", priceModel: "fixed,missing", projectTypes: "residential", includedItems: "labor,missing", services: "plumbing", areaOfWork: "indoor" });
    const body = response.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(1);
    expect(body.results[0]._id.toString()).toBe("507f1f77bcf86cd799439031");
    expect(body.facets.includedItems.missing).toBe(0);
    expect(body.facets.priceModels.missing).toBe(0);
    const noServiceMatch = await execute({ services: "electrical" });
    expect(noServiceMatch.json.mock.calls[0][0].pagination.total).toBe(0);
  });

  it("filters availability by inclusive date-only bounds before paging", async () => {
    const earlier = project("507f1f77bcf86cd799439041");
    const inside = project("507f1f77bcf86cd799439042");
    const endBoundary = project("507f1f77bcf86cd799439044");
    const later = project("507f1f77bcf86cd799439043");
    mocks.projects = [earlier, inside, endBoundary, later];
    mocks.schedules = new Map([
      [earlier._id.toString(), "2026-11-02T10:00:00.000Z"],
      [inside._id.toString(), "2026-11-03T10:00:00.000Z"],
      [endBoundary._id.toString(), "2026-11-04T23:59:00.000Z"],
      [later._id.toString(), "2026-11-05T10:00:00.000Z"],
    ]);
    const response = await execute({ startDateFrom: "2026-11-03", startDateTo: "2026-11-04" });
    expect(response.json.mock.calls[0][0].pagination.total).toBe(2);
    expect(response.json.mock.calls[0][0].results[0]._id.toString()).toBe(inside._id.toString());
    expect(mocks.scheduleCalls[0].professional.companyBlockedRanges).toHaveLength(1);
    expect(new Date(mocks.scheduleCalls[0].professional.companyBlockedRanges[0].endDate).toISOString()).toBe("2026-11-02T23:59:59.999Z");
    const oneSided = await execute({ startDateFrom: "2026-11-04" });
    expect(oneSided.json.mock.calls[0][0].pagination.total).toBe(2);
    expect(oneSided.json.mock.calls[0][0].results[0]._id.toString()).toBe(later._id.toString());
  });

  it("does not truncate rating-filtered projects at the previous 500-row cap", async () => {
    mocks.projects = Array.from({ length: 501 }, () => project(new Types.ObjectId().toString()));
    mocks.ratings = new Map(mocks.projects.map((item) => [item._id.toString(), { avgRating: 4, totalReviews: 1 }]));
    const response = await execute({ minRating: "4" });
    expect(response.json.mock.calls[0][0].pagination.total).toBe(501);
    expect(response.json.mock.calls[0][0].results).toHaveLength(1);
  });

  it("uses the minimum order quantity for a unit package's bookable search duration", async () => {
    const unitProject = project("507f1f77bcf86cd799439051", {
      subprojects: [{
        pricing: { type: "unit", minOrderQuantity: 2, durationBasis: "per_unit" },
        executionDuration: { value: 3, unit: "days" },
      }],
    });
    mocks.projects = [unitProject];
    await execute({ startDateFrom: "2026-11-03" });
    expect(mocks.scheduleCalls.some((call) => call.quantity === 2 && call.subprojectIndex === 0)).toBe(true);
  });

  it("counts price models only when that model has an in-range package", async () => {
    mocks.projects = [project("507f1f77bcf86cd799439061", { subprojects: [
      { pricing: { type: "fixed", amount: 10 } }, { pricing: { type: "unit", amount: 100 } },
    ] })];
    const response = await execute({ priceMax: "20", priceModel: "unit" });
    const body = response.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(0);
    expect(body.facets.priceModels).toEqual({ fixed: 1, unit: 0 });
  });

  it("ignores public discount claims and uses only the authenticated customer's actual tier", async () => {
    mocks.commission = 10;
    mocks.projects = [project("507f1f77bcf86cd799439062", { subprojects: [{ pricing: { type: "fixed", amount: 100 } }] })];
    const fake = await execute({ priceMax: "0", loyaltyDiscountPercent: "100", loyaltyDiscountMax: "999" });
    expect(fake.json.mock.calls[0][0].pagination.total).toBe(0);
    const member = await execute({ priceMin: "105", priceMax: "105", loyaltyDiscountPercent: "100" }, { role: "customer", loyaltyLevel: "Gold", totalSpent: 1000 });
    expect(member.json.mock.calls[0][0].pagination.total).toBe(1);
  });

  it("uses the real public route's optional auth before granting a customer tier", async () => {
    mocks.commission = 10;
    mocks.projects = [project("507f1f77bcf86cd799439063", { subprojects: [{ pricing: { type: "fixed", amount: 100 } }] })];
    mocks.principal = { _id: proId, role: "customer", accountStatus: "active", loyaltyLevel: "Gold", totalSpent: 1000 };
    const app = express();
    app.use("/api/search", searchRouter);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/search?type=projects`;
    try {
      const anon = await fetch(`${base}&priceMax=0&loyaltyDiscountPercent=100`);
      expect((await anon.json()).pagination.total).toBe(0);
      const stale = await fetch(`${base}&priceMax=105`, { headers: { Authorization: "Bearer invalid" } });
      expect((await stale.json()).pagination.total).toBe(0);
      const token = jwt.sign({ id: proId.toString() }, process.env.JWT_SECRET!);
      const member = await fetch(`${base}&priceMin=105&priceMax=105&loyaltyDiscountPercent=100`, { headers: { Authorization: `Bearer ${token}` } });
      expect((await member.json()).pagination.total).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects repeated query fields and treats punctuation as literal search text", async () => {
    const repeated = await execute({ q: ["room", "studio"] });
    expect(repeated.status).toHaveBeenCalledWith(400);
    mocks.projects = [];
    for (const query of ["[", "room.*(studio)"]) {
      const response = await execute({ q: query });
      expect(response.status).not.toHaveBeenCalledWith(500);
      const filter = vi.mocked(Project.find).mock.calls.at(-1)![0] as any;
      const regex = filter.$or[0].title as RegExp;
      expect(regex.test(query)).toBe(true);
      expect(regex.test("room unrelated studio")).toBe(false);
    }
  });

  it("uses project id to break equal creation-time ties before paging", async () => {
    const first = project("507f1f77bcf86cd799439071", { createdAt: new Date("2026-10-01") });
    const second = project("507f1f77bcf86cd799439072", { createdAt: first.createdAt });
    mocks.projects = [second, first];
    const pageOne = await execute({ page: "1" });
    mocks.projects.reverse();
    const pageTwo = await execute({ page: "2" });
    expect(pageOne.json.mock.calls[0][0].results[0]._id.toString()).toBe(first._id.toString());
    expect(pageTwo.json.mock.calls[0][0].results[0]._id.toString()).toBe(second._id.toString());
  });

  it("rejects malformed prices and invalid date ranges at the handler boundary", async () => {
    const invalidPrice = await execute({ priceMin: "-1" });
    expect(invalidPrice.status).toHaveBeenCalledWith(400);
    const invalidRange = await execute({ startDateFrom: "2026-10-20", startDateTo: "2026-10-19" });
    expect(invalidRange.status).toHaveBeenCalledWith(400);
  });

  it("finds a 10km project on the same street when it has no geocoded location (geo address fallback)", async () => {
    // $geoNear cannot see projects without distance.location; the handler
    // falls back to address matching for them (client bug list #20).
    vi.mocked(Project.aggregate).mockResolvedValueOnce([]);
    const unlocated = project("507f1f77bcf86cd799439081", {
      distance: { address: "Rue de la Loi 1, 1000 Bruxelles, Belgium", maxKmRange: 10 },
    });
    delete (unlocated as any).distance.location;
    mocks.projects = [unlocated];
    const response = await execute({
      loc: "Rue de la Loi 1",
      customerCity: "Bruxelles",
      customerCountry: "belgium",
      customerLat: "50.8466",
      customerLon: "4.3523",
    });
    const body = response.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(1);
    expect(body.results[0]._id.toString()).toBe("507f1f77bcf86cd799439081");
  });

  it("builds a crash-safe radius expression for the geo search", async () => {
    vi.mocked(Project.aggregate).mockResolvedValueOnce([]);
    mocks.projects = [];
    await execute({
      loc: "Rue de la Loi 1",
      customerCountry: "belgium",
      customerLat: "50.8466",
      customerLon: "4.3523",
    });
    const pipeline = vi.mocked(Project.aggregate).mock.calls.at(-1)![0] as any[];
    const radiusStage = pipeline.find((stage) => stage?.$match?.$expr?.$lte);
    // $convert keeps a non-numeric maxKmRange from failing the whole search.
    expect(JSON.stringify(radiusStage)).toContain("$convert");
    expect(JSON.stringify(radiusStage)).toContain('"onError":null');
  });

  it("matches noBorders country codes from customer country names", async () => {
    vi.mocked(Project.aggregate).mockResolvedValueOnce([]);
    mocks.projects = [];
    await execute({
      loc: "Bruxelles",
      customerCountry: "belgium",
      customerLat: "50.8466",
      customerLon: "4.3523",
    });
    const pipeline = vi.mocked(Project.aggregate).mock.calls.at(-1)![0] as any[];
    const countryStage = pipeline.find((stage) =>
      JSON.stringify(stage).includes("distance.noBorders")
    );
    // "belgium" must also match projects storing ISO code "BE".
    expect(JSON.stringify(countryStage)).toContain('"BE"');
  });

  it("keeps noBorders projects with a country code in the non-geo address filter", async () => {
    mocks.projects = [
      project("507f1f77bcf86cd799439082", {
        distance: { address: "Rue de la Loi 1, 1000 Bruxelles", countryCode: "BE", noBorders: true, maxKmRange: 10 },
      }),
    ];
    const response = await execute({ loc: "Rue de la Loi 1", customerCountry: "belgium" });
    const body = response.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(1);
    expect(body.results[0]._id.toString()).toBe("507f1f77bcf86cd799439082");
  });

  it("excludes location-less projects from the geo fallback without a street-level match", async () => {
    vi.mocked(Project.aggregate).mockResolvedValueOnce([]);
    mocks.projects = [
      project("507f1f77bcf86cd799439083", {
        distance: { address: "Rue de la Loi 1, 1000 Bruxelles, Belgium", maxKmRange: 10 },
      }),
    ];
    // Coordinates only: no street-level part, so the unverifiable radius
    // project stays excluded even though the city matches.
    const coordsOnly = await execute({ customerLat: "50.8466", customerLon: "4.3523" });
    expect(coordsOnly.json.mock.calls[0][0].pagination.total).toBe(0);
    // A matching derived city alone is not enough: locationParts[0] (the
    // typed location) must match for the fallback.
    const cityOnly = await execute({
      loc: "Antwerp",
      customerCity: "Bruxelles",
      customerLat: "50.8466",
      customerLon: "4.3523",
    });
    expect(cityOnly.json.mock.calls[0][0].pagination.total).toBe(0);
  });
});
