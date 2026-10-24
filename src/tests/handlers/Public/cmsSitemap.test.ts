import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { find, countDocuments } = vi.hoisted(() => ({
  find: vi.fn(),
  countDocuments: vi.fn(),
}));

vi.mock("../../../models/cmsContent", () => ({
  default: { find, countDocuments },
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

import { listCmsSitemapEntries } from "../../../handlers/Public/cms";

type Doc = Record<string, any>;

let docs: Doc[] = [];
let sourcesById: Record<string, Doc> = {};

function entry(overrides: Doc = {}): Doc {
  return {
    _id: "doc-1",
    type: "blog",
    slug: "solar-guide",
    locale: "en",
    status: "published",
    activeCountries: [],
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    translatedFrom: undefined,
    ...overrides,
  };
}

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

function mockReq(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  docs = [];
  sourcesById = {};

  find.mockImplementation((query: Doc) => {
    const builder: any = {
      select: () => builder,
      sort: () => builder,
      skip: () => builder,
      limit: () => builder,
      lean: async () => {
        if (query._id?.$in) {
          return query._id.$in
            .map((id: string) => sourcesById[String(id)])
            .filter(Boolean);
        }
        return docs;
      },
    };
    return builder;
  });

  countDocuments.mockImplementation(async () => docs.length);
});

describe("public CMS sitemap source visibility", () => {
  it("lists originals and translations whose source is still published", async () => {
    docs = [
      entry({ _id: "en-1", slug: "a" }),
      entry({ _id: "nl-1", slug: "a", locale: "nl", translatedFrom: "source-ok" }),
      entry({ _id: "fr-1", slug: "b", locale: "fr", translatedFrom: "source-draft" }),
    ];
    sourcesById = {
      "source-ok": { _id: "source-ok", type: "blog", status: "published", activeCountries: [] },
      "source-draft": { _id: "source-draft", type: "blog", status: "draft", activeCountries: [] },
    };

    const res = mockRes();
    await listCmsSitemapEntries(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.items.map((item: Doc) => item._id)).toEqual(["en-1", "nl-1"]);
    expect(res.body.data.items[0].translatedFrom).toBeUndefined();
    expect(countDocuments).toHaveBeenCalledWith({ status: "published" });
  });

  it("hides a translation whose source no longer exists", async () => {
    docs = [
      entry({ _id: "en-1", slug: "a" }),
      entry({ _id: "nl-1", slug: "b", locale: "nl", translatedFrom: "missing-source" }),
    ];
    sourcesById = {};

    const res = mockRes();
    await listCmsSitemapEntries(mockReq(), res);

    expect(res.body.data.items.map((item: Doc) => item._id)).toEqual(["en-1"]);
  });

  it("keeps country-targeted content because the sitemap is global", async () => {
    docs = [
      entry({ _id: "en-be", slug: "be-only", activeCountries: ["BE"] }),
      entry({
        _id: "nl-be",
        slug: "be-only",
        locale: "nl",
        activeCountries: ["BE"],
        translatedFrom: "source-be",
      }),
    ];
    sourcesById = {
      "source-be": {
        _id: "source-be",
        type: "blog",
        status: "published",
        activeCountries: ["BE"],
      },
    };

    const res = mockRes();
    await listCmsSitemapEntries(mockReq(), res);

    expect(res.body.data.items.map((item: Doc) => item._id)).toEqual(["en-be", "nl-be"]);
  });
});
