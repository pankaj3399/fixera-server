import { beforeEach, describe, expect, it, vi } from "vitest";

const { find } = vi.hoisted(() => ({ find: vi.fn() }));

vi.mock("../../../models/cmsContent", () => ({
  default: { find },
}));

import {
  filterCmsDocsVisibleThroughSource,
  filterCmsDocsWithPublishedSource,
  isCmsDocPubliclyVisible,
} from "../../../utils/cms/publicVisibility";

function mockSources(sources: Array<Record<string, any>>) {
  find.mockReturnValue({
    select: () => ({ lean: async () => sources }),
  });
}

function doc(overrides: Record<string, any> = {}) {
  return {
    _id: "nl-1",
    type: "blog",
    status: "published",
    activeCountries: [],
    translatedFrom: "source-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSources([]);
});

describe("public CMS visibility through translation source", () => {
  it("keeps a translation whose source is published and global", async () => {
    mockSources([{ _id: "source-1", type: "blog", status: "published", activeCountries: [] }]);

    await expect(isCmsDocPubliclyVisible(doc(), "DE")).resolves.toBe(true);
  });

  it("hides a translation whose source was unpublished", async () => {
    mockSources([{ _id: "source-1", type: "blog", status: "draft", activeCountries: [] }]);

    await expect(isCmsDocPubliclyVisible(doc(), "DE")).resolves.toBe(false);
  });

  it("hides a translation when the source targets other countries", async () => {
    mockSources([
      { _id: "source-1", type: "blog", status: "published", activeCountries: ["BE"] },
    ]);

    await expect(isCmsDocPubliclyVisible(doc(), "DE")).resolves.toBe(false);
    await expect(isCmsDocPubliclyVisible(doc(), "BE")).resolves.toBe(true);
  });

  it("hides a translation when its source no longer exists (fail closed)", async () => {
    mockSources([]);

    await expect(isCmsDocPubliclyVisible(doc(), "DE")).resolves.toBe(false);
  });

  it("judges an independent manual original by its own fields", async () => {
    await expect(
      isCmsDocPubliclyVisible(doc({ translatedFrom: undefined, activeCountries: ["BE"] }), "BE")
    ).resolves.toBe(true);

    expect(find).not.toHaveBeenCalled();
  });

  it("hides drafts and country-restricted documents on their own fields", async () => {
    await expect(isCmsDocPubliclyVisible(doc({ status: "draft" }), "DE")).resolves.toBe(false);
    await expect(
      isCmsDocPubliclyVisible(doc({ translatedFrom: undefined, activeCountries: ["BE"] }), "DE")
    ).resolves.toBe(false);
  });

  it("resolves every translation source in one query and keeps input order", async () => {
    mockSources([
      { _id: "source-1", type: "blog", status: "published", activeCountries: [] },
      { _id: "source-2", type: "blog", status: "draft", activeCountries: [] },
    ]);
    const first = doc({ _id: "nl-1", translatedFrom: "source-1" });
    const second = doc({ _id: "fr-1", translatedFrom: "source-2", locale: "fr" });

    const visible = await filterCmsDocsVisibleThroughSource([first, second], "DE");

    expect(visible.map((item) => item._id)).toEqual(["nl-1"]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({ _id: { $in: ["source-1", "source-2"] } });
  });

  it("does not query sources for originals-only lists", async () => {
    const visible = await filterCmsDocsVisibleThroughSource([
      doc({ _id: "en-1", translatedFrom: undefined }),
    ]);

    expect(visible).toHaveLength(1);
    expect(find).not.toHaveBeenCalled();
  });
});

describe("public CMS visibility for country-agnostic endpoints", () => {
  it("keeps country-targeted originals and translations of published sources", async () => {
    mockSources([
      { _id: "source-1", type: "blog", status: "published", activeCountries: ["BE"] },
    ]);
    const original = doc({
      _id: "en-1",
      translatedFrom: undefined,
      activeCountries: ["BE"],
    });
    const translation = doc({ _id: "nl-1", activeCountries: ["BE"] });

    const visible = await filterCmsDocsWithPublishedSource([original, translation]);

    expect(visible.map((item) => item._id)).toEqual(["en-1", "nl-1"]);
  });

  it("hides translations whose source is draft or missing", async () => {
    mockSources([{ _id: "source-1", type: "blog", status: "draft", activeCountries: [] }]);
    const draftSource = doc({ _id: "nl-1", translatedFrom: "source-1" });
    const missingSource = doc({ _id: "fr-1", translatedFrom: "source-2", locale: "fr" });

    const visible = await filterCmsDocsWithPublishedSource([draftSource, missingSource]);

    expect(visible).toEqual([]);
  });

  it("keeps independent originals without querying their source", async () => {
    const original = doc({ _id: "en-1", translatedFrom: undefined });

    await expect(filterCmsDocsWithPublishedSource([original])).resolves.toEqual([original]);
    expect(find).not.toHaveBeenCalled();
  });
});
