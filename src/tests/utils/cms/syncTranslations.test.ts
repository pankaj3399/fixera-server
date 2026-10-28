import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findOne, updateOne, create, find, deleteMany, updateMany } = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  create: vi.fn(),
  find: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
}));

const { translateTexts, isTranslatorConfigured } = vi.hoisted(() => ({
  translateTexts: vi.fn(),
  isTranslatorConfigured: vi.fn(),
}));

vi.mock('../../../models/cmsContent', () => ({
  default: { findOne, updateOne, create, find, deleteMany, updateMany },
}));

vi.mock('../../../utils/cms/azureTranslator', () => ({
  isTranslatorConfigured,
  translateTexts,
}));

import {
  computeSourceHash,
  deleteAutoTranslatedSiblings,
  moveAutoTranslatedSiblings,
  syncCmsTranslations,
} from '../../../utils/cms/syncTranslations';

function makeSource(overrides: Record<string, any> = {}) {
  return {
    _id: 'source-1',
    type: 'blog',
    slug: 'solar-guide',
    locale: 'en',
    title: 'Solar guide',
    body: '<p>Hello <strong>world</strong></p>',
    excerpt: 'Short excerpt',
    coverImage: 'https://cdn.example.test/cover.jpg',
    coverImageAlt: 'Solar panels',
    category: 'guide',
    tags: ['solar'],
    status: 'published',
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    author: 'author-1',
    authorOverride: undefined,
    relatedContent: [],
    relatedServices: [],
    relatedServiceSlug: 'solar-installation',
    activeCountries: [],
    autoTranslated: false,
    seo: {
      titleTag: 'Solar title tag',
      metaDescription: 'Solar meta description',
      ogTitle: 'Solar OG title',
      ogImage: 'https://cdn.example.test/og.jpg',
      canonical: 'https://fixera.test/en/blog/solar-guide',
      noindex: false,
    },
    ...overrides,
  };
}

function manualSibling(locale: string, overrides: Record<string, any> = {}) {
  return {
    ...makeSource(),
    _id: `${locale}-manual-1`,
    locale,
    autoTranslated: false,
    translatedFrom: undefined,
    ...overrides,
  };
}

function autoSibling(locale: string, sourceHash: string, overrides: Record<string, any> = {}) {
  return {
    ...makeSource(),
    _id: `${locale}-auto-1`,
    locale,
    autoTranslated: true,
    sourceHash,
    translatedFrom: 'source-1',
    ...overrides,
  };
}

let siblings: any[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  siblings = [];

  isTranslatorConfigured.mockReturnValue(true);
  translateTexts.mockImplementation(async (texts: string[], opts: { to: string }) =>
    texts.map((text) => `[${opts.to}] ${text}`)
  );

  findOne.mockImplementation((query: Record<string, any>) => ({
    lean: async () => {
      if (query.translatedFrom) {
        return (
          siblings.find(
            (doc) =>
              doc.locale === query.locale &&
              String(doc.translatedFrom) === String(query.translatedFrom)
          ) ?? null
        );
      }
      return (
        siblings.find((doc) => doc.locale === query.locale && doc.slug === query.slug) ?? null
      );
    },
  }));

  updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  create.mockImplementation(async (payload: Record<string, any>) => payload);
  find.mockReturnValue({ lean: async () => [] });
  deleteMany.mockResolvedValue({ deletedCount: 0 });
  updateMany.mockResolvedValue({ modifiedCount: 0 });
});

describe('syncCmsTranslations', () => {
  it("mirrors publication controls onto a manual translation without touching its text", async () => {
    siblings = [
      manualSibling("nl", { translatedFrom: "source-1", title: "Handmatige titel" }),
      manualSibling("fr", { translatedFrom: "source-1", title: "Titre manuel" }),
    ];

    const results = await syncCmsTranslations(
      makeSource({ status: "draft", publishedAt: undefined, activeCountries: ["BE"] })
    );

    expect(results).toEqual([
      { locale: "nl", status: "skipped_manual" },
      { locale: "fr", status: "skipped_manual" },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(2);

    const [query, update] = updateOne.mock.calls[0];
    expect(query).toEqual({ _id: "nl-manual-1" });
    expect(update.$set).toEqual({
      status: "draft",
      activeCountries: ["BE"],
      translatedFrom: "source-1",
    });
    expect(update.$unset).toEqual({ publishedAt: 1 });
    expect(update.$set.title).toBeUndefined();
    expect(update.$set.body).toBeUndefined();
    expect(update.$set.excerpt).toBeUndefined();
  });

  it("mirrors a republished source's date and country targeting onto manual translations", async () => {
    siblings = [
      manualSibling("nl", { translatedFrom: "source-1" }),
      manualSibling("fr", { translatedFrom: "source-1" }),
    ];

    const publishedAt = new Date("2026-03-01T00:00:00.000Z");
    const results = await syncCmsTranslations(
      makeSource({ status: "published", publishedAt, activeCountries: ["NL"] })
    );

    expect(results).toEqual([
      { locale: "nl", status: "skipped_manual" },
      { locale: "fr", status: "skipped_manual" },
    ]);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set).toEqual({
      status: "published",
      publishedAt,
      activeCountries: ["NL"],
      translatedFrom: "source-1",
    });
    expect(update.$unset).toBeUndefined();
  });

  it("leaves an independent same-slug manual original untouched", async () => {
    siblings = [manualSibling("nl"), manualSibling("fr")];

    const results = await syncCmsTranslations(
      makeSource({ status: "draft", publishedAt: undefined, activeCountries: ["BE"] })
    );

    expect(results).toEqual([
      { locale: "nl", status: "skipped_manual" },
      { locale: "fr", status: "skipped_manual" },
    ]);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('skips manual translations and never calls the provider for them', async () => {
    siblings = [manualSibling('nl'), manualSibling('fr')];

    const results = await syncCmsTranslations(makeSource());

    expect(results).toEqual([
      { locale: 'nl', status: 'skipped_manual' },
      { locale: 'fr', status: 'skipped_manual' },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('mirrors only non-text fields when the source hash is unchanged', async () => {
    const hash = computeSourceHash(makeSource());
    siblings = [autoSibling('nl', hash), autoSibling('fr', hash)];

    const results = await syncCmsTranslations(makeSource());

    expect(results).toEqual([
      { locale: 'nl', status: 'synced' },
      { locale: 'fr', status: 'synced' },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(2);

    const [, update] = updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({
      status: 'published',
      coverImage: 'https://cdn.example.test/cover.jpg',
      category: 'guide',
      tags: ['solar'],
      activeCountries: [],
      author: 'author-1',
      relatedServiceSlug: 'solar-installation',
      'seo.ogImage': 'https://cdn.example.test/og.jpg',
      'seo.noindex': false,
      autoTranslated: true,
      sourceHash: hash,
      translatedFrom: 'source-1',
    });
    expect(update.$set['seo.canonical']).toBeUndefined();
    expect(update.$set.title).toBeUndefined();
    expect(update.$set.body).toBeUndefined();
  });

  it('re-translates and updates when the source hash changed', async () => {
    siblings = [autoSibling('nl', 'stale-hash'), manualSibling('fr')];

    const results = await syncCmsTranslations(makeSource());

    expect(results).toEqual([
      { locale: 'nl', status: 'updated' },
      { locale: 'fr', status: 'skipped_manual' },
    ]);
    expect(translateTexts).toHaveBeenCalledTimes(2); // plain fields + HTML body
    expect(translateTexts).toHaveBeenNthCalledWith(
      1,
      ['Solar guide', 'Short excerpt', 'Solar panels', 'Solar title tag', 'Solar meta description', 'Solar OG title'],
      { from: 'en', to: 'nl', html: false }
    );
    expect(translateTexts).toHaveBeenNthCalledWith(2, ['<p>Hello <strong>world</strong></p>'], {
      from: 'en',
      to: 'nl',
      html: true,
    });

    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.title).toBe('[nl] Solar guide');
    expect(update.$set.body).toBe('[nl] <p>Hello <strong>world</strong></p>');
    expect(update.$set['seo.titleTag']).toBe('[nl] Solar title tag');
    expect(update.$set.autoTranslated).toBe(true);
    expect(update.$set.translatedFrom).toBe('source-1');
    expect(update.$set['seo.canonical']).toBeUndefined();
  });

  it('creates missing translations with the same type/slug and copied non-text fields', async () => {
    siblings = [];

    const results = await syncCmsTranslations(makeSource());

    expect(results).toEqual([
      { locale: 'nl', status: 'created' },
      { locale: 'fr', status: 'created' },
    ]);
    expect(create).toHaveBeenCalledTimes(2);

    const payload = create.mock.calls[0][0];
    expect(payload).toMatchObject({
      type: 'blog',
      slug: 'solar-guide',
      locale: 'nl',
      title: '[nl] Solar guide',
      body: '[nl] <p>Hello <strong>world</strong></p>',
      excerpt: '[nl] Short excerpt',
      coverImageAlt: '[nl] Solar panels',
      status: 'published',
      coverImage: 'https://cdn.example.test/cover.jpg',
      category: 'guide',
      tags: ['solar'],
      relatedServiceSlug: 'solar-installation',
      autoTranslated: true,
      translatedFrom: 'source-1',
      sourceHash: computeSourceHash(makeSource()),
      seo: {
        titleTag: '[nl] Solar title tag',
        metaDescription: '[nl] Solar meta description',
        ogTitle: '[nl] Solar OG title',
        ogImage: 'https://cdn.example.test/og.jpg',
        noindex: false,
      },
    });
    expect(payload.seo.canonical).toBeUndefined();
  });

  it('returns disabled for every locale (with a single warning) when the translator is not configured', async () => {
    isTranslatorConfigured.mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const results = await syncCmsTranslations(makeSource());

    expect(results).toEqual([
      { locale: 'nl', status: 'disabled' },
      { locale: 'fr', status: 'disabled' },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('AZURE_TRANSLATOR_KEY');
    expect(translateTexts).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still mirrors non-text and control fields when the translator is not configured', async () => {
    isTranslatorConfigured.mockReturnValue(false);
    const source = makeSource();
    // nl: fresh auto sibling (hash matches) → synced path mirrors non-text.
    // fr: linked manual sibling → skipped_manual path mirrors controls.
    siblings = [
      autoSibling('nl', computeSourceHash(source), { coverImage: 'https://cdn.example.test/stale.jpg' }),
      { ...manualSibling('fr'), translatedFrom: 'source-1' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const results = await syncCmsTranslations(source);

    expect(results).toEqual([
      { locale: 'nl', status: 'synced' },
      { locale: 'fr', status: 'skipped_manual' },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not let one locale failure affect the other', async () => {
    siblings = [];
    create.mockImplementation(async (payload: Record<string, any>) => {
      if (payload.locale === 'nl') {
        const err: any = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      return payload;
    });

    const results = await syncCmsTranslations(makeSource());

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ locale: 'nl', status: 'failed' });
    expect(results[0].error).toContain('solar-guide');
    expect(results[1]).toEqual({ locale: 'fr', status: 'created' });
  });

  it('force overwrites manual translations', async () => {
    siblings = [manualSibling('nl'), manualSibling('fr')];

    const results = await syncCmsTranslations(makeSource(), { force: true });

    expect(results).toEqual([
      { locale: 'nl', status: 'updated' },
      { locale: 'fr', status: 'updated' },
    ]);
    expect(translateTexts).toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledTimes(2);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.autoTranslated).toBe(true);
    expect(update.$set.title).toBe('[nl] Solar guide');
  });

  it('never translates from a manual translation (translatedFrom set)', async () => {
    const results = await syncCmsTranslations(
      makeSource({ autoTranslated: false, translatedFrom: 'origin-1' })
    );

    expect(results).toEqual([]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('never translates from a manual translation even with force', async () => {
    const results = await syncCmsTranslations(
      makeSource({ autoTranslated: false, translatedFrom: 'origin-1' }),
      { force: true }
    );

    expect(results).toEqual([]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('never translates from an auto-translated doc', async () => {
    const results = await syncCmsTranslations(
      makeSource({ autoTranslated: true, translatedFrom: 'source-1' })
    );

    expect(results).toEqual([]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('never translates from an auto-translated doc even with force', async () => {
    const results = await syncCmsTranslations(
      makeSource({ autoTranslated: true, translatedFrom: 'source-1' }),
      { force: true }
    );

    expect(results).toEqual([]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('syncs an original into every other locale', async () => {
    siblings = [];

    const results = await syncCmsTranslations(makeSource({ locale: 'nl' }));

    expect(results).toEqual([
      { locale: 'en', status: 'created' },
      { locale: 'fr', status: 'created' },
    ]);
  });

  it('clears translated text when the source field was emptied', async () => {
    const source = makeSource({ excerpt: '', coverImageAlt: undefined, seo: { titleTag: 'Only title' } });
    siblings = [autoSibling('nl', 'stale-hash')];

    await syncCmsTranslations(source);

    const [, update] = updateOne.mock.calls[0];
    expect(update.$unset).toMatchObject({
      excerpt: 1,
      coverImageAlt: 1,
      'seo.metaDescription': 1,
      'seo.ogTitle': 1,
    });
    expect(update.$set.title).toBe('[nl] Solar guide');
    expect(update.$set.body).toBe('[nl] <p>Hello <strong>world</strong></p>');
  });
});

describe('translation sibling maintenance', () => {
  it('moves auto-translated siblings to the new source slug and reports conflicts', async () => {
    find.mockReturnValue({
      lean: async () => [
        { _id: 'nl-auto', locale: 'nl', autoTranslated: true },
        { _id: 'fr-auto', locale: 'fr', autoTranslated: true },
        { _id: 'fr-manual', locale: 'fr', autoTranslated: false },
      ],
    });
    updateOne.mockImplementation(async (query: Record<string, any>) => {
      if (query._id === 'fr-auto') {
        const err: any = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      return { matchedCount: 1 };
    });

    const results = await moveAutoTranslatedSiblings({
      _id: 'source-1',
      type: 'blog',
      slug: 'new-slug',
    });

    expect(results).toEqual([
      { locale: 'nl', status: 'updated' },
      { locale: 'fr', status: 'failed', error: 'Slug "new-slug" already exists in locale fr' },
    ]);
    expect(updateOne).toHaveBeenCalledTimes(2); // manual sibling untouched
    const [query, update] = updateOne.mock.calls[0];
    expect(query).toEqual({ _id: 'nl-auto' });
    expect(update).toEqual({ $set: { slug: 'new-slug', type: 'blog' } });
  });

  it('deletes auto siblings and detaches manual ones on source delete', async () => {
    deleteMany.mockResolvedValue({ deletedCount: 2 });
    updateMany.mockResolvedValue({ modifiedCount: 1 });

    const result = await deleteAutoTranslatedSiblings({ _id: 'source-1' });

    expect(result).toEqual({ deleted: 2, detached: 1 });
    expect(deleteMany).toHaveBeenCalledWith({
      translatedFrom: 'source-1',
      autoTranslated: true,
    });
    expect(updateMany).toHaveBeenCalledWith(
      { translatedFrom: 'source-1' },
      { $unset: { translatedFrom: 1 } }
    );
  });
});
