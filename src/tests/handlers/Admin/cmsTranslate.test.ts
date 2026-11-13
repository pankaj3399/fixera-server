import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));
const { connectDB } = vi.hoisted(() => ({ connectDB: vi.fn() }));
const { syncCmsTranslations } = vi.hoisted(() => ({ syncCmsTranslations: vi.fn() }));
const { requestCmsTranslationRun } = vi.hoisted(() => ({ requestCmsTranslationRun: vi.fn() }));
const { loadCmsTranslationStatus } = vi.hoisted(() => ({ loadCmsTranslationStatus: vi.fn() }));

vi.mock('../../../models/cmsContent', () => ({
  default: { findById },
  CMS_CONTENT_TYPES: ['blog', 'news', 'faq', 'policy', 'landing'],
  CMS_CONTENT_STATUSES: ['draft', 'published'],
  FAQ_CATEGORIES: [],
  FAQ_CATEGORY_SLUGS: [],
}));

vi.mock('../../../config/db', () => ({ default: connectDB }));

vi.mock('../../../utils/cms/syncTranslations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/cms/syncTranslations')>()),
  syncCmsTranslations,
  deleteAutoTranslatedSiblings: vi.fn(),
  moveAutoTranslatedSiblings: vi.fn(),
}));

vi.mock('../../../utils/cms/translationQueue', () => ({ requestCmsTranslationRun }));

vi.mock('../../../utils/cms/translationStatus', () => ({
  loadCmsTranslationStatus,
  tryLoadCmsTranslationStatus: vi.fn(async () => undefined),
}));

import { getCmsTranslationStatus, translateCmsContent } from '../../../handlers/Admin/cmsManagement';

const STATUS = { enabled: true, sourceId: 'x', sourceLocale: 'en', running: false, queued: true, locales: [] };

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
  requestCmsTranslationRun.mockResolvedValue(undefined);
  loadCmsTranslationStatus.mockResolvedValue(STATUS);
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
    // Request-time pass only (no provider call); force covers every target locale.
    expect(syncCmsTranslations).toHaveBeenCalledWith(origin, {
      translate: false,
      forceLocales: ['nl', 'fr'],
    });
    expect(translation.save).not.toHaveBeenCalled();
    expect(loadCmsTranslationStatus).toHaveBeenCalledWith(ORIGIN_ID);
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
    expect(syncCmsTranslations).toHaveBeenCalledWith(translation, { translate: false, forceLocales: [] });
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

    expect(syncCmsTranslations).toHaveBeenCalledWith(origin, { translate: false, forceLocales: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      translations: [{ locale: 'fr', status: 'synced' }],
      data: STATUS,
    });
    // Nothing pending: no background run is queued.
    expect(requestCmsTranslationRun).not.toHaveBeenCalled();
  });

  it('queues a background run (with the forced locales) when a locale is pending', async () => {
    const origin = makeOrigin();
    findById.mockImplementation(async (id: unknown) => (String(id) === ORIGIN_ID ? origin : null));
    syncCmsTranslations.mockResolvedValue([
      { locale: 'nl', status: 'synced' },
      { locale: 'fr', status: 'pending' },
    ]);

    const res = mockRes();
    await translateCmsContent(
      { params: { id: ORIGIN_ID }, body: { force: true, locales: ['fr', 'en', 'fr'] } } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(200);
    // `locales` narrows force; the source locale is never a target.
    expect(syncCmsTranslations).toHaveBeenCalledWith(origin, { translate: false, forceLocales: ['fr'] });
    expect(requestCmsTranslationRun).toHaveBeenCalledWith(ORIGIN_ID, { forceLocales: ['fr'] });
    expect(res.body.translations).toEqual([
      { locale: 'nl', status: 'synced' },
      { locale: 'fr', status: 'pending' },
    ]);
  });

  it('ignores `locales` without force', async () => {
    const origin = makeOrigin();
    findById.mockImplementation(async (id: unknown) => (String(id) === ORIGIN_ID ? origin : null));
    const res = mockRes();
    await translateCmsContent(
      { params: { id: ORIGIN_ID }, body: { locales: ['nl'] } } as unknown as Request,
      res
    );
    expect(syncCmsTranslations).toHaveBeenCalledWith(origin, { translate: false, forceLocales: [] });
  });

  it('reports pending locales as failed when the run cannot be queued, and still answers 200', async () => {
    const origin = makeOrigin();
    findById.mockImplementation(async (id: unknown) => (String(id) === ORIGIN_ID ? origin : null));
    syncCmsTranslations.mockResolvedValue([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'skipped_manual' },
    ]);
    requestCmsTranslationRun.mockRejectedValue(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = mockRes();
    await translateCmsContent({ params: { id: ORIGIN_ID }, body: {} } as unknown as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.translations).toEqual([
      { locale: 'nl', status: 'failed', errorCode: 'internal', error: expect.any(String) },
      { locale: 'fr', status: 'skipped_manual' },
    ]);
    errSpy.mockRestore();
  });

  it.each([
    [{ locales: ['de'] }],
    [{ locales: 'nl' }],
    [{ locales: [1] }],
    [{ force: 'yes' }],
  ])('rejects an invalid body %j with 400', async (body) => {
    const res = mockRes();
    await translateCmsContent({ params: { id: ORIGIN_ID }, body } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
    expect(findById).not.toHaveBeenCalled();
    expect(syncCmsTranslations).not.toHaveBeenCalled();
  });

  it('rejects an invalid id with 400', async () => {
    const res = mockRes();
    await translateCmsContent({ params: { id: 'nope' }, body: {} } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.msg).toBe('Invalid content ID');
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

describe('GET /api/admin/cms/:id/translations', () => {
  it('returns the status', async () => {
    const res = mockRes();
    await getCmsTranslationStatus({ params: { id: ORIGIN_ID } } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: STATUS });
    expect(loadCmsTranslationStatus).toHaveBeenCalledWith(ORIGIN_ID);
  });

  it('answers 400 for an invalid id and 404 for a missing doc', async () => {
    const bad = mockRes();
    await getCmsTranslationStatus({ params: { id: 'zzz' } } as unknown as Request, bad);
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toEqual({ success: false, msg: 'Invalid content ID' });

    loadCmsTranslationStatus.mockResolvedValue(null);
    const missing = mockRes();
    await getCmsTranslationStatus({ params: { id: MISSING_ID } } as unknown as Request, missing);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ success: false, msg: 'Content not found' });
  });

  it('answers 500 when the lookup throws', async () => {
    loadCmsTranslationStatus.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    await getCmsTranslationStatus({ params: { id: ORIGIN_ID } } as unknown as Request, res);
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });
});
