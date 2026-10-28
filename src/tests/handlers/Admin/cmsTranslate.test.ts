import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));
const { connectDB } = vi.hoisted(() => ({ connectDB: vi.fn() }));
const { syncCmsTranslations } = vi.hoisted(() => ({ syncCmsTranslations: vi.fn() }));

vi.mock('../../../models/cmsContent', () => ({
  default: { findById },
  CMS_CONTENT_TYPES: ['blog', 'news', 'faq', 'policy', 'landing'],
  CMS_CONTENT_STATUSES: ['draft', 'published'],
  FAQ_CATEGORIES: [],
  FAQ_CATEGORY_SLUGS: [],
}));

vi.mock('../../../config/db', () => ({ default: connectDB }));

vi.mock('../../../utils/cms/syncTranslations', () => ({
  syncCmsTranslations,
  deleteAutoTranslatedSiblings: vi.fn(),
  mergeTranslationResults: vi.fn((...groups: any[][]) => groups.flat()),
  moveAutoTranslatedSiblings: vi.fn(),
  isTranslationSource: vi.fn(() => true),
}));

import { translateCmsContent } from '../../../handlers/Admin/cmsManagement';

const ORIGIN_ID = '507f1f77bcf86cd799439011';
const TRANSLATION_ID = '507f1f77bcf86cd799439012';
const MISSING_ID = '507f1f77bcf86cd799439013';

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

function makeOrigin() {
  return {
    _id: ORIGIN_ID,
    type: 'blog',
    slug: 'solar-guide',
    locale: 'en',
    autoTranslated: false,
    translatedFrom: undefined,
  };
}

function makeTranslation(overrides: Record<string, any> = {}) {
  return {
    _id: TRANSLATION_ID,
    type: 'blog',
    slug: 'solar-guide',
    locale: 'nl',
    autoTranslated: false,
    translatedFrom: ORIGIN_ID,
    sourceHash: 'stale-hash',
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connectDB.mockResolvedValue(undefined);
  syncCmsTranslations.mockResolvedValue([{ locale: 'fr', status: 'synced' }]);
});

describe('POST /api/admin/cms/:id/translate', () => {
  it('reruns the sync from the origin when the doc is a translation', async () => {
    const origin = makeOrigin();
    const translation = makeTranslation();
    findById.mockImplementation(async (id: unknown) =>
      String(id) === ORIGIN_ID ? origin : translation
    );

    const res = mockRes();
    await translateCmsContent(
      { params: { id: TRANSLATION_ID }, body: { force: true } } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(200);
    expect(syncCmsTranslations).toHaveBeenCalledTimes(1);
    expect(syncCmsTranslations).toHaveBeenCalledWith(origin, { force: true });
    expect(translation.save).not.toHaveBeenCalled();
  });

  it('promotes an orphaned translation to an original and syncs from it', async () => {
    const translation = makeTranslation({ autoTranslated: true });
    findById.mockImplementation(async (id: unknown) =>
      String(id) === TRANSLATION_ID ? translation : null
    );

    const res = mockRes();
    await translateCmsContent(
      { params: { id: TRANSLATION_ID }, body: {} } as unknown as Request,
      res
    );

    expect(translation.translatedFrom).toBeUndefined();
    expect(translation.autoTranslated).toBe(false);
    expect(translation.sourceHash).toBeUndefined();
    expect(translation.save).toHaveBeenCalledTimes(1);
    expect(syncCmsTranslations).toHaveBeenCalledWith(translation, { force: false });
    expect(res.statusCode).toBe(200);
  });

  it('syncs directly from an original doc', async () => {
    const origin = makeOrigin();
    findById.mockImplementation(async (id: unknown) =>
      String(id) === ORIGIN_ID ? origin : null
    );

    const res = mockRes();
    await translateCmsContent(
      { params: { id: ORIGIN_ID }, body: { force: false } } as unknown as Request,
      res
    );

    expect(syncCmsTranslations).toHaveBeenCalledWith(origin, { force: false });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      translations: [{ locale: 'fr', status: 'synced' }],
    });
  });

  it('returns 404 when the doc does not exist', async () => {
    findById.mockResolvedValue(null);

    const res = mockRes();
    await translateCmsContent(
      { params: { id: MISSING_ID }, body: {} } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(404);
    expect(syncCmsTranslations).not.toHaveBeenCalled();
  });
});
