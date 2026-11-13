import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findOne, findById, updateOne, create, find, deleteMany, updateMany, exists } = vi.hoisted(() => ({
  exists: vi.fn(),
  findById: vi.fn(),
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
  default: { findOne, findById, updateOne, create, find, deleteMany, updateMany, exists },
}));

vi.mock('../../../utils/cms/azureTranslator', () => {
  class TranslatorError extends Error {
    status?: number;
    code: string;
    constructor(message: string, status?: number, code = 'provider_error') {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { isTranslatorConfigured, translateTexts, TranslatorError };
});

import {
  clampTranslatedText,
  computeSourceHash,
  deleteAutoTranslatedSiblings,
  moveAutoTranslatedSiblings,
  syncCmsTranslations,
  TRANSLATED_FIELD_MAX_LENGTH,
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

  findById.mockImplementation((id: unknown) => {
    const row = () => siblings.find((doc) => String(doc._id) === String(id)) ?? null;
    return { select: () => ({ lean: async () => row() }), lean: async () => row() };
  });
  updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  create.mockImplementation(async (payload: Record<string, any>) => payload);
  find.mockReturnValue({ lean: async () => [] });
  deleteMany.mockResolvedValue({ deletedCount: 0 });
  updateMany.mockResolvedValue({ modifiedCount: 0 });
  exists.mockResolvedValue(null);
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
    expect(query).toEqual({ _id: "nl-manual-1", autoTranslated: { $ne: true } });
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

  // Behaviour change (T6): a published source used to copy its status and
  // publishedAt onto linked manual translations, so publishing the source
  // published a manual draft an editor had deliberately held back, and
  // rewrote a published manual translation's own publication date. Source
  // publication now only ever restricts a manual translation.
  it("mirrors country targeting but keeps a published manual translation's own publishedAt", async () => {
    const ownDate = new Date("2026-02-15T00:00:00.000Z");
    siblings = [
      manualSibling("nl", { translatedFrom: "source-1", publishedAt: ownDate }),
      manualSibling("fr", { translatedFrom: "source-1", publishedAt: ownDate }),
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
    expect(update.$set).toEqual({ activeCountries: ["NL"], translatedFrom: "source-1" });
    expect(update.$unset).toBeUndefined();
  });

  it("never publishes a linked manual draft when the source is published", async () => {
    siblings = [
      manualSibling("nl", { translatedFrom: "source-1", status: "draft", publishedAt: undefined }),
      manualSibling("fr", { translatedFrom: "source-1", status: "published" }),
    ];

    const results = await syncCmsTranslations(makeSource({ activeCountries: ["BE"] }));

    expect(results).toEqual([
      { locale: "nl", status: "skipped_manual" },
      { locale: "fr", status: "skipped_manual" },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
    for (const [, update] of updateOne.mock.calls) {
      expect(update.$set.status).toBeUndefined();
      expect(update.$set.publishedAt).toBeUndefined();
      expect(update.$unset).toBeUndefined();
      expect(update.$set.activeCountries).toEqual(["BE"]);
    }
  });

  it("clears a manual translation's countries when the source becomes global", async () => {
    siblings = [manualSibling("nl", { translatedFrom: "source-1", activeCountries: ["BE"] })];
    await syncCmsTranslations(makeSource({ activeCountries: undefined }));
    const [, update] = updateOne.mock.calls[0];
    expect(update.$unset).toEqual({ activeCountries: 1 });
    expect(update.$set).toEqual({ translatedFrom: "source-1" });
  });

  it("applies the restricting controls to a linked manual translation even with force and no translator", async () => {
    isTranslatorConfigured.mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    siblings = [manualSibling("nl", { translatedFrom: "source-1", title: "Handmatig" })];

    const results = await syncCmsTranslations(
      makeSource({ status: "draft", publishedAt: undefined, activeCountries: ["NL"] }),
      { force: true }
    );

    expect(results).toEqual([
      { locale: "nl", status: "disabled" },
      { locale: "fr", status: "disabled" },
    ]);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [query, update] = updateOne.mock.calls[0];
    expect(query).toEqual({ _id: "nl-manual-1", autoTranslated: { $ne: true } });
    expect(update.$set).toEqual({ status: "draft", activeCountries: ["NL"], translatedFrom: "source-1" });
    expect(update.$unset).toEqual({ publishedAt: 1 });
    warn.mockRestore();
  });

  it("machine translations still follow the source's publication status and date", async () => {
    const source = makeSource();
    siblings = [
      autoSibling("nl", computeSourceHash(source), { status: "draft", publishedAt: undefined }),
    ];
    await syncCmsTranslations(source);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({ status: "published", publishedAt: source.publishedAt });
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
      translatedFrom: 'source-1',
    });
    // Mirroring never marks text as fresh; only a translated write sets the hash.
    expect(update.$set.sourceHash).toBeUndefined();
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

  it('returns disabled for every locale, quietly, when the translator is not configured', async () => {
    isTranslatorConfigured.mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const translate of [true, false]) {
      const results = await syncCmsTranslations(makeSource(), { translate });
      expect(results).toEqual([
        { locale: 'nl', status: 'disabled' },
        { locale: 'fr', status: 'disabled' },
      ]);
    }
    // An unconfigured translator is a supported setup, not a warning per save.
    expect(warn).not.toHaveBeenCalled();
    expect(translateTexts).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
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
    expect(warn).not.toHaveBeenCalled();
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
    expect(results[0]).toMatchObject({ locale: 'nl', status: 'failed', errorCode: 'slug_conflict' });
    expect(results[0].error).toContain('solar-guide');
    expect(results[1]).toEqual({ locale: 'fr', status: 'created' });
  });

  // Replaced 2026-11-03: the old "force overwrites manual translations" case
  // used UNLINKED same-slug manual siblings, i.e. it asserted that force
  // overwrote independent originals. Force now only replaces this source's
  // linked manual translations.
  it('force overwrites linked manual translations', async () => {
    siblings = [
      manualSibling('nl', { translatedFrom: 'source-1' }),
      manualSibling('fr', { translatedFrom: 'source-1' }),
    ];

    const results = await syncCmsTranslations(makeSource(), { force: true });

    expect(results).toEqual([
      { locale: 'nl', status: 'updated' },
      { locale: 'fr', status: 'updated' },
    ]);
    expect(translateTexts).toHaveBeenCalled();
    const machineWrites = updateOne.mock.calls.filter(([, update]) => update.$set.autoTranslated === true);
    expect(machineWrites).toHaveLength(2);
    const [query, update] = machineWrites[0];
    // Conditional: still manual (and unedited when it carries an updatedAt).
    expect(query).toEqual({ _id: 'nl-manual-1', autoTranslated: { $ne: true } });
    expect(update.$set.title).toBe('[nl] Solar guide');
  });

  it('force never overwrites an independent same-slug manual original, while a linked one is replaced', async () => {
    siblings = [
      manualSibling('nl', { title: 'Zonne-gids (eigen origineel)' }),
      manualSibling('fr', { translatedFrom: 'source-1' }),
    ];

    const results = await syncCmsTranslations(makeSource(), { force: true });

    expect(results).toEqual([
      { locale: 'nl', status: 'skipped_manual' },
      { locale: 'fr', status: 'updated' },
    ]);
    // No write of any kind reaches the independent original, and no provider call is made for it.
    expect(updateOne.mock.calls.some(([query]) => query._id === 'nl-manual-1')).toBe(false);
    expect(translateTexts.mock.calls.every(([, opts]) => opts.to === 'fr')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('force never overwrites a manual translation linked to ANOTHER original or with a dangling link', async () => {
    siblings = [
      manualSibling('nl', { translatedFrom: 'other-original' }),
      manualSibling('fr', { translatedFrom: 'deleted-original' }),
    ];
    exists.mockImplementation(async (query: Record<string, any>) =>
      String(query._id) === 'other-original' ? { _id: 'other-original' } : null
    );

    for (const force of [false, true]) {
      updateOne.mockClear();
      translateTexts.mockClear();
      const results = await syncCmsTranslations(makeSource(), { force });
      expect(results).toEqual([
        { locale: 'nl', status: 'skipped_manual' },
        { locale: 'fr', status: 'skipped_manual' },
      ]);
      expect(updateOne).not.toHaveBeenCalled();
      expect(translateTexts).not.toHaveBeenCalled();
    }
  });

  it('force still adopts an orphan same-slug MACHINE row whose original is gone', async () => {
    siblings = [autoSibling('nl', 'stale', { translatedFrom: 'deleted-original' })];
    exists.mockResolvedValue(null);

    const results = await syncCmsTranslations(makeSource(), { force: true });

    expect(results).toEqual([
      { locale: 'nl', status: 'updated' },
      { locale: 'fr', status: 'created' },
    ]);
    const [query, update] = updateOne.mock.calls[0];
    expect(query).toEqual({ _id: 'nl-auto-1', autoTranslated: true });
    expect(update.$set).toMatchObject({ translatedFrom: 'source-1', autoTranslated: true, title: '[nl] Solar guide' });
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
      {
        locale: 'fr',
        status: 'failed',
        errorCode: 'slug_conflict',
        error: 'Slug "new-slug" already exists in locale fr.',
      },
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

describe('clampTranslatedText', () => {
  it('returns text that fits unchanged (trimmed)', () => {
    expect(clampTranslatedText('  Hallo wereld  ', 20)).toBe('Hallo wereld');
    expect(clampTranslatedText('x'.repeat(20), 20)).toBe('x'.repeat(20));
  });

  it('cuts at the last word boundary and adds an ellipsis within the limit', () => {
    const text = 'Isolation thermique du toit, guide complet pour les propriétaires';
    const out = clampTranslatedText(text, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).toBe('Isolation thermique du toit, guide…'); // trailing punctuation dropped
  });

  it('hard-cuts a long word with no usable boundary', () => {
    const out = clampTranslatedText('a'.repeat(50), 10);
    expect(out).toBe(`${'a'.repeat(9)}…`);
  });

  it('clamps every translated plain field to its schema limit on write', async () => {
    translateTexts.mockImplementation(async (texts: string[], opts: { to: string; html: boolean }) =>
      texts.map((text) => (opts.html ? text : `${text} ${'langer '.repeat(80)}`))
    );
    siblings = [];
    await syncCmsTranslations(makeSource());
    const payload = create.mock.calls[0][0];
    expect(payload.title.length).toBeLessThanOrEqual(TRANSLATED_FIELD_MAX_LENGTH.title);
    expect(payload.excerpt.length).toBeLessThanOrEqual(TRANSLATED_FIELD_MAX_LENGTH.excerpt);
    expect(payload.coverImageAlt.length).toBeLessThanOrEqual(TRANSLATED_FIELD_MAX_LENGTH.coverImageAlt);
    expect(payload.seo.titleTag.length).toBeLessThanOrEqual(TRANSLATED_FIELD_MAX_LENGTH['seo.titleTag']);
    expect(payload.seo.ogTitle.length).toBeLessThanOrEqual(TRANSLATED_FIELD_MAX_LENGTH['seo.ogTitle']);
    expect(payload.title.endsWith('…')).toBe(true);
    // The HTML body has no schema limit and is never clamped.
    expect(payload.body).toBe('<p>Hello <strong>world</strong></p>');
  });
});

describe('syncCmsTranslations — request-time pass and background safety', () => {
  it('translate:false never calls the provider and reports text work as pending', async () => {
    const source = makeSource();
    siblings = [
      autoSibling('nl', 'stale-hash'),
      manualSibling('fr', { translatedFrom: 'source-1' }),
    ];

    const results = await syncCmsTranslations(source, { translate: false });

    expect(results).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'skipped_manual' },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // The stale machine row still gets the source's controls right away, without a hash.
    const nlWrite = updateOne.mock.calls.find(([query]) => query._id === 'nl-auto-1');
    expect(nlWrite![1].$set).toMatchObject({ status: 'published', coverImage: source.coverImage });
    expect(nlWrite![1].$set.sourceHash).toBeUndefined();
    expect(nlWrite![1].$set.title).toBeUndefined();
  });

  it('translate:false reports a forced linked manual translation as pending (and missing rows too)', async () => {
    siblings = [manualSibling('nl', { translatedFrom: 'source-1' })];
    const results = await syncCmsTranslations(makeSource(), { translate: false, forceLocales: ['nl'] });
    expect(results).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'pending' },
    ]);
    expect(translateTexts).not.toHaveBeenCalled();
  });

  it('forceLocales forces only the listed locales', async () => {
    siblings = [
      manualSibling('nl', { translatedFrom: 'source-1' }),
      manualSibling('fr', { translatedFrom: 'source-1' }),
    ];
    const results = await syncCmsTranslations(makeSource(), { forceLocales: ['fr'] });
    expect(results).toEqual([
      { locale: 'nl', status: 'skipped_manual' },
      { locale: 'fr', status: 'updated' },
    ]);
    expect(translateTexts.mock.calls.every(([, opts]) => opts.to === 'fr')).toBe(true);
  });

  it('a machine row taken over by an admin during the provider call is reported skipped_manual', async () => {
    siblings = [autoSibling('nl', 'stale-hash')];
    updateOne.mockImplementation(async (query: Record<string, any>, update: Record<string, any>) => {
      // The translated write (it carries the new title) finds the row manual now.
      if (query._id === 'nl-auto-1' && update.$set?.title) {
        siblings[0] = { ...siblings[0], autoTranslated: false };
        return { matchedCount: 0, modifiedCount: 0 };
      }
      return { matchedCount: 1, modifiedCount: 1 };
    });

    const results = await syncCmsTranslations(makeSource());

    expect(results[0]).toEqual({ locale: 'nl', status: 'skipped_manual' });
    const write = updateOne.mock.calls.find(([q, u]) => q._id === 'nl-auto-1' && u.$set?.title);
    expect(write![0]).toEqual({ _id: 'nl-auto-1', autoTranslated: true });
  });

  it('a forced manual row is written only if its updatedAt is unchanged since the control update', async () => {
    const readAt = new Date('2026-05-01T10:00:00.000Z');
    const afterControls = new Date('2026-05-01T10:00:01.000Z');
    siblings = [manualSibling('nl', { translatedFrom: 'source-1', updatedAt: readAt })];
    findById.mockImplementation(() => ({
      select: () => ({ lean: async () => ({ _id: 'nl-manual-1', updatedAt: afterControls }) }),
      lean: async () => ({ _id: 'nl-manual-1', autoTranslated: false }),
    }));
    updateOne.mockImplementation(async (query: Record<string, any>, update: Record<string, any>) =>
      update.$set?.title ? { matchedCount: 0, modifiedCount: 0 } : { matchedCount: 1, modifiedCount: 1 }
    );

    const results = await syncCmsTranslations(makeSource(), { forceLocales: ['nl'] });

    const write = updateOne.mock.calls.find(([, u]) => u.$set?.title);
    // Filters on the timestamp read AFTER the control update, not the stale one.
    expect(write![0]).toEqual({ _id: 'nl-manual-1', autoTranslated: { $ne: true }, updatedAt: afterControls });
    expect(results[0]).toEqual({
      locale: 'nl',
      status: 'failed',
      errorCode: 'changed_during_run',
      error: expect.any(String),
    });
  });

  it('a failing guard aborts the remaining locales as interrupted', async () => {
    siblings = [];
    const guard = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const results = await syncCmsTranslations(makeSource(), { guard });
    expect(results.map((r) => [r.locale, r.status, r.errorCode])).toEqual([
      ['nl', 'failed', 'interrupted'], // guard lost after translating, before the write
      ['fr', 'failed', 'interrupted'],
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('reloadSource writes the latest controls/slug with the translated snapshot text', async () => {
    const snapshot = makeSource({ title: 'Old title' });
    const latest = makeSource({ title: 'New title', status: 'draft', publishedAt: undefined, slug: 'moved-slug' });
    let reads = 0;
    findById.mockImplementation(() => {
      reads += 1;
      // First read (start of nl) = snapshot; later reads = the newer save.
      const doc = reads === 1 ? snapshot : latest;
      return { select: () => ({ lean: async () => doc }), lean: async () => doc };
    });
    siblings = [];

    await syncCmsTranslations(snapshot, { reloadSource: true });

    const nl = create.mock.calls.find(([payload]) => payload.locale === 'nl')![0];
    expect(nl).toMatchObject({ title: '[nl] Old title', status: 'draft', slug: 'moved-slug' });
    expect(nl.publishedAt).toBeUndefined();
    expect(nl.sourceHash).toBe(computeSourceHash(snapshot)); // stale on purpose: re-run fixes the text
    const fr = create.mock.calls.find(([payload]) => payload.locale === 'fr')![0];
    expect(fr).toMatchObject({ title: '[fr] New title', sourceHash: computeSourceHash(latest) });
  });

  it('reloadSource stops when the source is gone', async () => {
    findById.mockImplementation(() => ({ lean: async () => null, select: () => ({ lean: async () => null }) }));
    const results = await syncCmsTranslations(makeSource(), { reloadSource: true });
    expect(results.map((r) => r.errorCode)).toEqual(['interrupted', 'interrupted']);
    expect(translateTexts).not.toHaveBeenCalled();
  });

  it('maps provider error codes onto failed results with safe messages', async () => {
    const { TranslatorError } = await import('../../../utils/cms/azureTranslator');
    siblings = [];
    translateTexts.mockImplementation(async (_texts: string[], opts: { to: string }) => {
      throw new (TranslatorError as any)('HTTP 403 403001 raw provider text', 403, opts.to === 'nl' ? 'quota_exceeded' : 'auth');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await syncCmsTranslations(makeSource());
    expect(results).toEqual([
      { locale: 'nl', status: 'failed', errorCode: 'quota_exceeded', error: 'The monthly translation quota is used up.' },
      { locale: 'fr', status: 'failed', errorCode: 'auth', error: "The translation service rejected the server's credentials." },
    ]);
    error.mockRestore();
  });
});

