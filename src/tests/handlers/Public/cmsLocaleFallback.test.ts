import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { find, findOne, updateOne } = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock('../../../models/cmsContent', () => ({
  default: { find, findOne, updateOne },
  CMS_CONTENT_TYPES: ['blog', 'news', 'faq', 'policy', 'landing'],
  CMS_CONTENT_STATUSES: ['draft', 'published'],
  FAQ_CATEGORIES: [{ slug: 'general', name: 'General' }],
  FAQ_CATEGORY_SLUGS: ['general'],
}));

vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));

vi.mock('../../../utils/cmsPresign', () => ({
  presignCmsDoc: vi.fn(async (doc: unknown) => doc),
  presignCmsDocs: vi.fn(async (docs: unknown[]) => docs),
}));

import {
  getPublicCmsContentBySlug,
  listPublicCmsContent,
} from '../../../handlers/Public/cms';

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

function mockReq(overrides: Record<string, any> = {}): Request {
  return {
    params: {},
    query: {},
    get: () => undefined,
    ...overrides,
  } as unknown as Request;
}

function listing(locale: string, slug: string, publishedAt: string, title: string) {
  return {
    _id: `${locale}-${slug}`,
    type: 'blog',
    title,
    slug,
    locale,
    excerpt: `${title} excerpt`,
    coverImage: 'https://cdn.example.test/cover.jpg',
    coverImageAlt: title,
    tags: [],
    publishedAt: new Date(publishedAt),
    seo: {},
    category: undefined,
    author: undefined,
    authorOverride: undefined,
    relatedServiceSlug: undefined,
    updatedAt: new Date(publishedAt),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateOne.mockResolvedValue({});
});

describe('public CMS locale fallback', () => {
  it('serves the en document when the requested locale has no published version', async () => {
    const enDoc = { ...listing('en', 'solar-guide', '2026-02-01', 'Solar guide'), body: '<p>Hello</p>' };
    findOne.mockImplementation((filter: Record<string, any>) => ({
      populate: () => ({
        lean: async () => (filter.locale === 'nl' ? null : enDoc),
      }),
    }));

    const res = mockRes();
    await getPublicCmsContentBySlug(
      mockReq({ params: { type: 'blog', slug: 'solar-guide' }, query: { locale: 'nl' } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.locale).toBe('en');
    expect(res.body.data.slug).toBe('solar-guide');
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(findOne.mock.calls[0][0]).toMatchObject({ locale: 'nl', status: 'published' });
    expect(findOne.mock.calls[1][0]).toMatchObject({ locale: 'en', status: 'published' });
  });

  it('prefers the requested locale when it exists', async () => {
    const nlDoc = { ...listing('nl', 'solar-guide', '2026-02-01', 'Zonne-energie'), body: '<p>Hallo</p>' };
    findOne.mockImplementation(() => ({
      populate: () => ({ lean: async () => nlDoc }),
    }));

    const res = mockRes();
    await getPublicCmsContentBySlug(
      mockReq({ params: { type: 'blog', slug: 'solar-guide' }, query: { locale: 'nl' } }),
      res
    );

    expect(res.body.data.locale).toBe('nl');
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('treats an invalid locale query as en', async () => {
    const enDoc = { ...listing('en', 'solar-guide', '2026-02-01', 'Solar guide'), body: '' };
    findOne.mockImplementation(() => ({
      populate: () => ({ lean: async () => enDoc }),
    }));

    const res = mockRes();
    await getPublicCmsContentBySlug(
      mockReq({ params: { type: 'blog', slug: 'solar-guide' }, query: { locale: 'de' } }),
      res
    );

    expect(res.body.data.locale).toBe('en');
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne.mock.calls[0][0]).toMatchObject({ locale: 'en' });
  });

  it('lists requested-locale docs plus en docs for slugs without a translation', async () => {
    const nlDoc = listing('nl', 'solar-guide', '2026-02-01', 'Zonne-energie');
    const enSameSlug = listing('en', 'solar-guide', '2026-02-01', 'Solar guide');
    const enFallback = listing('en', 'heat-pump', '2026-01-01', 'Heat pump');

    find.mockImplementation((filter: Record<string, any>) => ({
      select: () => ({
        populate: () => ({
          lean: async () => (filter.locale === 'nl' ? [nlDoc] : [enSameSlug, enFallback]),
        }),
      }),
    }));

    const res = mockRes();
    await listPublicCmsContent(
      mockReq({ params: { type: 'blog' }, query: { locale: 'nl', limit: '12' } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.items.map((item: any) => item.slug)).toEqual(['solar-guide', 'heat-pump']);
    expect(res.body.data.items[0].locale).toBe('nl');
    expect(res.body.data.items[1].locale).toBe('en');
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 12, total: 2, totalPages: 1 });
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('does not query a fallback for the default locale', async () => {
    const enDoc = listing('en', 'solar-guide', '2026-02-01', 'Solar guide');
    find.mockImplementation(() => ({
      select: () => ({
        populate: () => ({ lean: async () => [enDoc] }),
      }),
    }));

    const res = mockRes();
    await listPublicCmsContent(
      mockReq({ params: { type: 'blog' }, query: { locale: 'en' } }),
      res
    );

    expect(res.body.data.items).toHaveLength(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('paginates the merged (locale + en fallback) list', async () => {
    const nlDocs = [1, 2].map((n) =>
      listing('nl', `nl-${n}`, `2026-02-0${n}T00:00:00.000Z`, `NL ${n}`)
    );
    const enFallback = listing('en', 'en-1', '2026-01-01T00:00:00.000Z', 'EN 1');

    find.mockImplementation((filter: Record<string, any>) => ({
      select: () => ({
        populate: () => ({
          lean: async () => (filter.locale === 'nl' ? nlDocs : [enFallback]),
        }),
      }),
    }));

    const res = mockRes();
    await listPublicCmsContent(
      mockReq({ params: { type: 'blog' }, query: { locale: 'nl', page: '2', limit: '2' } }),
      res
    );

    expect(res.body.data.items.map((item: any) => item.slug)).toEqual(['en-1']);
    expect(res.body.data.pagination).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('hides a published manual translation whose source was unpublished', async () => {
    const nlDoc = {
      ...listing('nl', 'solar-guide', '2026-02-01', 'Zonne-energie'),
      translatedFrom: 'source-1',
      body: '<p>Hallo</p>',
    };
    findOne.mockImplementation((filter: Record<string, any>) => ({
      populate: () => ({
        lean: async () => (filter.locale === 'nl' ? nlDoc : null),
      }),
    }));
    find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'source-1', type: 'blog', status: 'draft', activeCountries: [] },
        ],
      }),
    });

    const res = mockRes();
    await getPublicCmsContentBySlug(
      mockReq({ params: { type: 'blog', slug: 'solar-guide' }, query: { locale: 'nl' } }),
      res
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, msg: 'Not found' });
  });

  it('hides a translation when the source targets other countries', async () => {
    const nlDoc = {
      ...listing('nl', 'solar-guide', '2026-02-01', 'Zonne-energie'),
      translatedFrom: 'source-1',
      body: '<p>Hallo</p>',
    };
    findOne.mockImplementation((filter: Record<string, any>) => ({
      populate: () => ({
        lean: async () => (filter.locale === 'nl' ? nlDoc : null),
      }),
    }));
    find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'source-1', type: 'blog', status: 'published', activeCountries: ['BE'] },
        ],
      }),
    });

    const inGermany = mockRes();
    await getPublicCmsContentBySlug(
      mockReq({
        params: { type: 'blog', slug: 'solar-guide' },
        query: { locale: 'nl' },
        get: (name: string) => (name === 'x-vercel-ip-country' ? 'DE' : undefined),
      }),
      inGermany
    );
    expect(inGermany.statusCode).toBe(404);

    const inBelgium = mockRes();
    await getPublicCmsContentBySlug(
      mockReq({
        params: { type: 'blog', slug: 'solar-guide' },
        query: { locale: 'nl' },
        get: (name: string) => (name === 'x-vercel-ip-country' ? 'BE' : undefined),
      }),
      inBelgium
    );
    expect(inBelgium.statusCode).toBe(200);
    expect(inBelgium.body.data.locale).toBe('nl');
  });

  it('omits translations hidden through their source from listings', async () => {
    const nlDoc = {
      ...listing('nl', 'solar-guide', '2026-02-01', 'Zonne-energie'),
      translatedFrom: 'source-1',
    };
    const enFallback = listing('en', 'heat-pump', '2026-01-01', 'Heat pump');

    find.mockImplementation((filter: Record<string, any>) => {
      if (filter._id) {
        return {
          select: () => ({
            lean: async () => [
              { _id: 'source-1', type: 'blog', status: 'draft', activeCountries: [] },
            ],
          }),
        };
      }
      const docs = filter.locale === 'nl' ? [nlDoc] : [enFallback];
      const builder: any = {
        select: () => builder,
        populate: () => builder,
        lean: async () => docs,
      };
      return builder;
    });

    const res = mockRes();
    await listPublicCmsContent(
      mockReq({ params: { type: 'blog' }, query: { locale: 'nl' } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.items.map((item: any) => item.slug)).toEqual(['heat-pump']);
    expect(res.body.data.items[0].translatedFrom).toBeUndefined();
  });
});
