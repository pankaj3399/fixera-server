import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projects: [] as any[],
  professionals: [] as any[],
  ratings: new Map<string, { avgRating: number; totalReviews: number }>(),
  schedules: new Map<string, string>(),
  commission: 10,
}));

vi.mock("../../models/user", () => ({
  default: {
    findById: vi.fn(() => ({ select: async () => null })),
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
vi.mock("../../models/professionalLevelConfig", () => ({
  default: {
    getCurrentConfig: vi.fn(async () => ({
      levels: [
        { name: "New", order: 1 },
        { name: "Level 1", order: 2 },
        { name: "Level 2", order: 3 },
        { name: "Level 3", order: 4 },
        { name: "Expert", order: 5 },
      ],
    })),
  },
}));
vi.mock("../../models/loyaltyConfig", () => ({ default: { getCurrentConfig: async () => ({ tiers: [] }) } }));
vi.mock("../../models/platformSettings", () => ({ default: { getCurrentConfig: async () => ({ commissionPercent: mocks.commission }) } }));
vi.mock("../../utils/scheduleEngine", () => ({
  resolveEffectiveScheduleTimeZone: vi.fn(() => "UTC"),
  buildProjectScheduleProposalsWithData: vi.fn(async (project: any) => ({
    earliestBookableDate: mocks.schedules.get(project._id.toString()) || "2026-11-03T09:00:00.000Z",
  })),
}));
vi.mock("../../handlers/Search/aggregateRatings", () => ({
  aggregateProfessionalRatings: vi.fn(async () => new Map()),
  aggregateProjectRatings: vi.fn(async (ids: any[]) => new Map(ids.map((id) => [id.toString(), mocks.ratings.get(id.toString()) || { avgRating: 0, totalReviews: 0 }]))),
}));

import { Types } from "mongoose";
import { search } from "../../handlers/Search";

const proJunior = new Types.ObjectId("507f1f77bcf86cd799439011");
const proSenior = new Types.ObjectId("507f1f77bcf86cd799439012");
const projectId = (id: string) => new Types.ObjectId(id);
const project = (id: string, professionalId: Types.ObjectId, details: any = {}) => ({
  _id: projectId(id),
  professionalId,
  status: "published",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  category: "Home",
  service: "Plumbing",
  areaOfWork: "Indoor",
  title: "Generic project",
  description: "Standard work",
  distance: { address: "Brussels, Belgium", maxKmRange: 200 },
  subprojects: [],
  ...details,
});

const execute = async (query: Record<string, unknown>) => {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await search({ query: { type: "projects", limit: "10", ...query } } as any, response as any);
  return response;
};

describe("project relevance sort (client bug list #4a)", () => {
  beforeEach(() => {
    mocks.professionals = [
      { _id: proJunior, name: "Junior Pro", professionalLevel: "Level 1", adminTags: [], businessInfo: { timezone: "UTC" } },
      { _id: proSenior, name: "Senior Pro", professionalLevel: "Expert", adminTags: ["Verified"], businessInfo: { timezone: "UTC" } },
    ];
    mocks.ratings = new Map([
      ["507f1f77bcf86cd799439021", { avgRating: 3, totalReviews: 1 }],
      ["507f1f77bcf86cd799439022", { avgRating: 4.9, totalReviews: 80 }],
    ]);
  });

  it("ranks the better match first by default instead of newest-first", async () => {
    mocks.projects = [
      project("507f1f77bcf86cd799439021", proJunior, {
        title: "Unrelated garden work",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
      project("507f1f77bcf86cd799439022", proSenior, {
        title: "Bathroom plumbing renovation",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ];
    const response = await execute({ q: "plumbing" });
    const body = response.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(2);
    expect(body.results.map((result: any) => result._id.toString())).toEqual([
      "507f1f77bcf86cd799439022",
      "507f1f77bcf86cd799439021",
    ]);
  });

  it("keeps explicit newest sort on newest-first order", async () => {
    mocks.projects = [
      project("507f1f77bcf86cd799439021", proJunior, {
        title: "Unrelated garden work",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
      project("507f1f77bcf86cd799439022", proSenior, {
        title: "Bathroom plumbing renovation",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ];
    const response = await execute({ q: "plumbing", sortBy: "newest" });
    const body = response.json.mock.calls[0][0];
    expect(body.pagination.total).toBe(2);
    expect(body.results.map((result: any) => result._id.toString())).toEqual([
      "507f1f77bcf86cd799439021",
      "507f1f77bcf86cd799439022",
    ]);
  });

  it("keeps pagination totals consistent with the sorted set", async () => {
    mocks.projects = [
      project("507f1f77bcf86cd799439021", proJunior, { createdAt: new Date("2026-03-01T00:00:00.000Z") }),
      project("507f1f77bcf86cd799439022", proSenior, { createdAt: new Date("2026-02-01T00:00:00.000Z") }),
    ];
    const first = await execute({ limit: "1", page: "1" });
    const second = await execute({ limit: "1", page: "2" });
    const firstBody = first.json.mock.calls[0][0];
    const secondBody = second.json.mock.calls[0][0];
    expect(firstBody.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(secondBody.pagination).toMatchObject({ total: 2, page: 2 });
    expect(firstBody.results[0]._id.toString()).not.toBe(secondBody.results[0]._id.toString());
  });
});
