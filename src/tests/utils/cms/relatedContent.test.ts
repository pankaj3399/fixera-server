import { beforeEach, describe, expect, it, vi } from "vitest";

const { find } = vi.hoisted(() => ({ find: vi.fn() }));

vi.mock("../../../models/cmsContent", () => ({
  default: { find },
}));

import { resolveLocalizedRelatedContent } from "../../../utils/cms/relatedContent";

type Doc = Record<string, any>;

let docsById: Record<string, Doc>;
let docsByLocale: Record<string, Doc[]>;

function doc(overrides: Doc = {}): Doc {
  return {
    _id: "doc-1",
    type: "blog",
    title: "Title",
    slug: "slug",
    locale: "en",
    excerpt: "Excerpt",
    coverImage: "https://cdn.example.test/cover.jpg",
    coverImageAlt: "Alt",
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "published",
    activeCountries: [],
    translatedFrom: undefined,
    ...overrides,
  };
}

function register(...docs: Doc[]) {
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

  find.mockImplementation((query: Doc) => ({
    select: () => ({
      lean: async () => {
        if (query._id?.$in) {
          return query._id.$in
            .map((id: string) => docsById[String(id)])
            .filter(Boolean);
        }

        const localeDocs = docsByLocale[String(query.locale)] || [];
        await Promise.resolve();
        return localeDocs.filter((candidate) => {
          if (query.status && candidate.status !== query.status) return false;
          const clauses = Array.isArray(query.$or) ? query.$or : [];
          return clauses.some((clause: Doc) => {
            if (clause._id?.$in) {
              return clause._id.$in.map(String).includes(String(candidate._id));
            }
            if (clause.translatedFrom?.$in) {
              return clause.translatedFrom.$in.map(String).includes(String(candidate.translatedFrom));
            }
            return clause.type === candidate.type && clause.slug === candidate.slug;
          });
        });
      },
    }),
  }));
});

describe("localized related content", () => {
  it("resolves nl cards for related en documents and keeps the stored order", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({ _id: "507f1f77bcf86cd799439002", title: "English B", slug: "b" }),
      doc({
        _id: "507f1f77bcf86cd799439003",
        locale: "nl",
        title: "Nederlands A",
        slug: "a",
        excerpt: "NL samenvatting A",
        coverImageAlt: "NL alt A",
        translatedFrom: "507f1f77bcf86cd799439001",
      }),
      doc({
        _id: "507f1f77bcf86cd799439004",
        locale: "nl",
        title: "Nederlands B",
        slug: "b",
        excerpt: "NL samenvatting B",
        translatedFrom: "507f1f77bcf86cd799439002",
      })
    );

    const cards = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001", "507f1f77bcf86cd799439002"], "nl", "NL");

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439003", "507f1f77bcf86cd799439004"]);
    expect(cards.map((card) => card.title)).toEqual(["Nederlands A", "Nederlands B"]);
    expect(cards[0]).toMatchObject({
      slug: "a",
      locale: "nl",
      type: "blog",
      excerpt: "NL samenvatting A",
      coverImageAlt: "NL alt A",
    });
  });

  it("resolves fr cards and preserves order across locales", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({
        _id: "507f1f77bcf86cd799439005",
        locale: "fr",
        title: "Français A",
        slug: "a",
        excerpt: "Résumé A",
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001"], "fr", "FR");

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ _id: "507f1f77bcf86cd799439005", locale: "fr", title: "Français A" });
  });

  it("resolves the English family origin when a manual translation keeps its own slug", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({
        _id: "507f1f77bcf86cd799439006",
        locale: "nl",
        title: "Handmatige vertaling",
        slug: "eigen-slug",
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(
      ["507f1f77bcf86cd799439006"],
      "en",
      "NL"
    );

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439001"]);
    expect(cards[0].title).toBe("English A");
  });

  it("falls back to the English document when the localized sibling is missing", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({ _id: "507f1f77bcf86cd799439002", title: "English B", slug: "b" })
    );

    const cards = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001", "507f1f77bcf86cd799439002"], "nl", "NL");

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439001", "507f1f77bcf86cd799439002"]);
    expect(cards.map((card) => card.locale)).toEqual(["en", "en"]);
  });

  it("falls back to English when the localized sibling is still a draft", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({
        _id: "507f1f77bcf86cd799439003",
        locale: "nl",
        title: "Nederlands A",
        slug: "a",
        status: "draft",
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001"], "nl", "NL");

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439001"]);
    expect(cards[0].title).toBe("English A");
  });

  it("falls back to the English source when the stored related id is the country-hidden requested-locale row", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({
        _id: "507f1f77bcf86cd799439003",
        locale: "nl",
        title: "Nederlands A",
        slug: "a",
        activeCountries: ["BE"],
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(
      ["507f1f77bcf86cd799439003"],
      "nl",
      "DE"
    );

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439001"]);
    expect(cards[0]).toMatchObject({ title: "English A", locale: "en" });
  });

  it("falls back to the English source when the stored related id is a draft requested-locale row", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({
        _id: "507f1f77bcf86cd799439003",
        locale: "nl",
        title: "Nederlands A",
        slug: "a",
        status: "draft",
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(
      ["507f1f77bcf86cd799439003"],
      "nl",
      "DE"
    );

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439001"]);
    expect(cards[0]).toMatchObject({ title: "English A", locale: "en" });
  });

  it("excludes documents that are country-ineligible for the visitor", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a", activeCountries: ["BE"] }),
      doc({ _id: "507f1f77bcf86cd799439002", title: "English B", slug: "b" }),
      doc({
        _id: "507f1f77bcf86cd799439003",
        locale: "nl",
        title: "Nederlands A",
        slug: "a",
        activeCountries: [],
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001", "507f1f77bcf86cd799439002"], "nl", "DE");

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439002"]);

    const forBelgium = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001", "507f1f77bcf86cd799439002"], "nl", "BE");
    expect(forBelgium.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439003", "507f1f77bcf86cd799439002"]);
  });

  it("does not expose a stale published sibling after its source was unpublished", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a", status: "draft" }),
      doc({
        _id: "507f1f77bcf86cd799439003",
        locale: "nl",
        title: "Nederlands A",
        slug: "a",
        status: "published",
        translatedFrom: "507f1f77bcf86cd799439001",
      })
    );

    const cards = await resolveLocalizedRelatedContent(["507f1f77bcf86cd799439001"], "nl", "NL");

    expect(cards).toEqual([]);
  });

  it("drops missing and invalid related ids without breaking order", async () => {
    register(
      doc({ _id: "507f1f77bcf86cd799439001", title: "English A", slug: "a" }),
      doc({ _id: "507f1f77bcf86cd799439002", title: "English B", slug: "b" })
    );

    const cards = await resolveLocalizedRelatedContent(
      ["not-an-object-id", "507f1f77bcf86cd799439002", "507f1f77bcf86cd799439099", "507f1f77bcf86cd799439001"],
      "nl",
      "NL"
    );

    expect(cards.map((card) => card._id)).toEqual(["507f1f77bcf86cd799439002", "507f1f77bcf86cd799439001"]);
  });

  it("returns no cards for an empty or non-array value", async () => {
    await expect(resolveLocalizedRelatedContent(undefined, "nl")).resolves.toEqual([]);
    await expect(resolveLocalizedRelatedContent([], "nl")).resolves.toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
