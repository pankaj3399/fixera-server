import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { connectDB, getLoyaltyConfig, getProfessionalConfig } = vi.hoisted(() => ({
  connectDB: vi.fn(),
  getLoyaltyConfig: vi.fn(),
  getProfessionalConfig: vi.fn(),
}));

vi.mock("../../../config/db", () => ({ default: connectDB }));
vi.mock("../../../models/loyaltyConfig", () => ({
  default: { getCurrentConfig: getLoyaltyConfig },
}));
vi.mock("../../../models/professionalLevelConfig", () => ({
  default: { getCurrentConfig: getProfessionalConfig },
}));

import {
  getPublicLoyaltyTiers,
  getPublicProfessionalLevels,
} from "../../../handlers/Public/levelTiers";

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectDB.mockResolvedValue(undefined);
});

describe("GET /api/public/loyalty-tiers (tag colours)", () => {
  it("exposes the admin-configured color per tier", async () => {
    getLoyaltyConfig.mockResolvedValue({
      tiers: [
        { name: "Bronze", color: "#CD7F32", icon: "bronze-medal", order: 1, isActive: true },
        { name: "Gold", color: "#BADA55", icon: "gold-medal", order: 3, isActive: true },
        { name: "Silver", color: "#C0C0C0", icon: "silver-medal", order: 2, isActive: false },
      ],
    });

    const res = mockRes();
    await getPublicLoyaltyTiers({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        tiers: [
          { name: "Bronze", color: "#CD7F32", icon: "bronze-medal", order: 1 },
          { name: "Gold", color: "#BADA55", icon: "gold-medal", order: 3 },
        ],
      },
    });
    // Inactive tiers stay hidden; no admin internals leak.
    expect(res.body.data.tiers).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain("minSpendingAmount");
  });

  it("falls back to the default color when a tier has none recorded", async () => {
    getLoyaltyConfig.mockResolvedValue({
      tiers: [{ name: "Platinum", order: 4, isActive: true }],
    });

    const res = mockRes();
    await getPublicLoyaltyTiers({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.tiers).toMatchObject([{ name: "Platinum", color: "#6B7280" }]);
  });
});

describe("GET /api/public/professional-levels (tag colours)", () => {
  it("exposes the admin-configured color per level", async () => {
    getProfessionalConfig.mockResolvedValue({
      levels: [
        { name: "New", color: "#123456", icon: "user", perks: { badge: "new-badge" }, order: 1, isActive: true },
        { name: "Expert", color: "#F59E0B", icon: "crown", perks: { badge: "expert-badge" }, order: 5, isActive: true },
      ],
    });

    const res = mockRes();
    await getPublicProfessionalLevels({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.levels).toMatchObject([
      { name: "New", color: "#123456", icon: "user", badge: "new-badge", order: 1 },
      { name: "Expert", color: "#F59E0B", icon: "crown", badge: "expert-badge", order: 5 },
    ]);
    // Threshold criteria stay admin-only.
    expect(JSON.stringify(res.body)).not.toContain("minCompletedBookings");
  });

  it("falls back to defaults when a level has no color recorded", async () => {
    getProfessionalConfig.mockResolvedValue({
      levels: [{ name: "Level 1", order: 2, isActive: true }],
    });

    const res = mockRes();
    await getPublicProfessionalLevels({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.levels).toMatchObject([{ name: "Level 1", color: "#6B7280" }]);
  });

  it("sanitizes the admin-authored badge: strips markup and controls, caps length", async () => {
    const ctrl = String.fromCharCode(0, 1, 31, 127);
    getProfessionalConfig.mockResolvedValue({
      levels: [
        { name: "New", color: "#123456", icon: "user", perks: { badge: "new-badge" }, order: 1, isActive: true },
        { name: "Level 1", order: 2, isActive: true, perks: { badge: "<b>Top</b> pro" } },
        { name: "Level 2", order: 3, isActive: true, perks: { badge: `a${ctrl}b` } },
        { name: "Level 3", order: 4, isActive: true, perks: { badge: "x".repeat(100) } },
      ],
    });

    const res = mockRes();
    await getPublicProfessionalLevels({} as Request, res);

    expect(res.statusCode).toBe(200);
    const [fresh, markup, controls, long] = res.body.data.levels;
    expect(fresh.badge).toBe("new-badge");
    expect(markup.badge).toBe("Top pro");
    expect(controls.badge).toBe("ab");
    expect(long.badge).toHaveLength(40);
    expect(JSON.stringify(res.body)).not.toContain("<b>");
  });

  it("falls back to undefined when the badge is empty after sanitizing", async () => {
    getProfessionalConfig.mockResolvedValue({
      levels: [
        { name: "New", order: 1, isActive: true, perks: { badge: "   " } },
        { name: "Level 1", order: 2, isActive: true, perks: { badge: "<br>" } },
        { name: "Level 2", order: 3, isActive: true },
      ],
    });

    const res = mockRes();
    await getPublicProfessionalLevels({} as Request, res);

    expect(res.statusCode).toBe(200);
    for (const level of res.body.data.levels) {
      expect(level.badge).toBeUndefined();
    }
  });
});
