import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { findOne, find, updateOne } = vi.hoisted(() => ({
  findOne: vi.fn(),
  find: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("../../../models/cmsContent", () => ({
  default: { findOne, find, updateOne },
  CMS_CONTENT_TYPES: ["blog", "news", "faq", "policy", "landing"],
  CMS_CONTENT_STATUSES: ["draft", "published"],
  FAQ_CATEGORIES: [{ slug: "general", name: "General" }],
  FAQ_CATEGORY_SLUGS: ["general"],
}));

vi.mock("../../../config/db", () => ({ default: vi.fn(async () => undefined) }));

vi.mock("../../../utils/cmsPresign", () => ({
  presignCmsDoc: vi.fn(async (doc: unknown) => doc),
  presignCmsDocs: vi.fn(async (docs: unknown[]) => docs),
}));

import { getPublicCmsContentBySlug } from "../../../handlers/Public/cms";

const EN_A = "507f1f77bcf86cd799439001";
const EN_B = "507f1f77bcf86cd799439002";
const NL_A = "507f1f77bcf86cd799439003";
const NL_B = "507f1f77bcf86cd799439004";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
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

function mockReq(country?: string): Request {
  return {
    params: { type: "blog", slug: "a" },
    query: { locale: "nl" },
    get: (name: string) => {
      if (name === "x-vercel-ip-country") return country;
      if (name === "user-agent") return "Mozilla/5.0";
      return undefined;
    },
  } as unknown as Request;
}

function doc(overrides: Record<string, any> = {}) {
  return {
    _id: EN_A,
    type: "blog",
    title: "Title",
    slug: "a",
    locale: "en",
    body: "",
    excerpt: "Excerpt",
    coverImage: "https://cdn.example.test/cover.jpg",
    coverImageAlt: "Alt",
    status: "published",
    activeCountries: [],
    translatedFrom: undefined,
    relatedContent: [],
    relatedServices: [],
    tags: [],
    seo: {},
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

let docsById: Record<string, any> = {};
let docsByLocale: Record<string, any[]> = {};

function register(...docs: any[]) {
  for (const entry of docs) {
    docsById[String(entry._id)] = entry;
    const locale = String(entry.locale);
    docsByLocale[locale] = docsByLocale[locale] || [];
    docsByLocale[locale].push(entry);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  docsById = {};
  docsByLocale = {};
  updateOne.mockResolvedValue({});

  findOne.mockImplementation((query: Record<string, any>) => ({
    populate: () => ({
      lean: async () => {
        const match = (docsByLocale[String(query.locale)] || []).find(
          (candidate) =>
            candidate.type === query.type &&
            candidate.slug === query.slug &&
            candidate.status === query.status
        );
        return match || null;
      },
    }),
  }));

  find.mockImplementation((query: Record<string, any>) => ({
    select: () => ({
      lean: async () => {
        if (query._id?.$in) {
          return query._id.$in.map((id: string) => docsById[String(id)]).filter(Boolean);
        }
        const localeDocs = docsByLocale[String(query.locale)] || [];
        return localeDocs.filter((candidate) => {
          if (query.status && candidate.status !== query.status) return false;
          const clauses = Array.isArray(query.$or) ? query.$or : [];
          return clauses.some((clause: Record<string, any>) => {
            if (clause._id?.$in) {
              return clause._id.$in.map(String).includes(String(candidate._id));
            }
            if (clause.translatedFrom?.$in) {
              return clause.translatedFrom.$in
                .map(String)
                .includes(String(candidate.translatedFrom));
            }
            return clause.type === candidate.type && clause.slug === candidate.slug;
          });
        });
      },
    }),
  }));
});

describe("public CMS related content localization", () => {
  it("serves the nl card fields for a related English source document", async () => {
    register(
      doc({ _id: NL_A, locale: "nl", title: "Nederlands A", slug: "a", relatedContent: [EN_B] }),
      doc({ _id: EN_B, title: "English B", slug: "b" }),
      doc({
        _id: NL_B,
        locale: "nl",
        title: "Nederlands B",
        slug: "b",
        excerpt: "NL samenvatting B",
        coverImageAlt: "NL alt B",
        translatedFrom: EN_B,
      })
    );

    const res = mockRes();
    await getPublicCmsContentBySlug(mockReq("NL"), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.relatedContent).toHaveLength(1);
    expect(res.body.data.relatedContent[0]).toMatchObject({
      _id: NL_B,
      title: "Nederlands B",
      slug: "b",
      locale: "nl",
      excerpt: "NL samenvatting B",
      coverImageAlt: "NL alt B",
    });
  });

  it("falls back to the English card when the localized sibling is a draft", async () => {
    register(
      doc({ _id: NL_A, locale: "nl", title: "Nederlands A", slug: "a", relatedContent: [EN_B] }),
      doc({ _id: EN_B, title: "English B", slug: "b" }),
      doc({
        _id: NL_B,
        locale: "nl",
        title: "Nederlands B",
        slug: "b",
        status: "draft",
        translatedFrom: EN_B,
      })
    );

    const res = mockRes();
    await getPublicCmsContentBySlug(mockReq("NL"), res);

    expect(res.body.data.relatedContent.map((item: any) => item._id)).toEqual([EN_B]);
  });

  it("does not expose related documents that are country-ineligible", async () => {
    register(
      doc({ _id: NL_A, locale: "nl", title: "Nederlands A", slug: "a", relatedContent: [EN_B] }),
      doc({ _id: EN_B, title: "English B", slug: "b", activeCountries: ["BE"] })
    );

    const res = mockRes();
    await getPublicCmsContentBySlug(mockReq("DE"), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.relatedContent).toEqual([]);
  });
});
