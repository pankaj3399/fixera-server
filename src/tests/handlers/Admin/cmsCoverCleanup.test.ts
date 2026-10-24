import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  findById,
  findByIdAndDelete,
  find,
  deleteFromS3,
  syncCmsTranslations,
  deleteAutoTranslatedSiblings,
  moveAutoTranslatedSiblings,
  isTranslationSource,
} = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIdAndDelete: vi.fn(),
  find: vi.fn(),
  deleteFromS3: vi.fn(),
  syncCmsTranslations: vi.fn(),
  deleteAutoTranslatedSiblings: vi.fn(),
  moveAutoTranslatedSiblings: vi.fn(),
  isTranslationSource: vi.fn(),
}));

vi.mock('../../../models/cmsContent', () => ({
  default: { findById, findByIdAndDelete, find },
  CMS_CONTENT_TYPES: ['blog', 'news', 'faq', 'policy', 'landing'],
  CMS_CONTENT_STATUSES: ['draft', 'published'],
  FAQ_CATEGORIES: [],
  FAQ_CATEGORY_SLUGS: [],
}));

vi.mock('../../../config/db', () => ({ default: vi.fn(async () => undefined) }));

vi.mock('../../../utils/s3Upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/s3Upload')>();
  return { ...actual, deleteFromS3 };
});

vi.mock('../../../utils/cmsPresign', () => ({
  presignCmsDoc: vi.fn(async (doc: unknown) => doc),
  presignCmsDocs: vi.fn(async (docs: unknown[]) => docs),
}));

vi.mock('../../../utils/cms/syncTranslations', () => ({
  syncCmsTranslations,
  deleteAutoTranslatedSiblings,
  moveAutoTranslatedSiblings,
  mergeTranslationResults: vi.fn((...groups: any[][]) => groups.flat()),
  isTranslationSource,
}));

import {
  deleteCmsContent,
  updateCmsContent,
} from '../../../handlers/Admin/cmsManagement';

const ID = '507f1f77bcf86cd799439011';
const OLD_COVER =
  'https://fixera-uploads.s3.us-east-1.amazonaws.com/cms/admin1/1710000000-old.jpg';
const NEW_COVER =
  'https://fixera-uploads.s3.us-east-1.amazonaws.com/cms/admin1/1710000001-new.jpg';
const OLD_KEY = 'cms/admin1/1710000000-old.jpg';

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

function makeDoc(overrides: Record<string, any> = {}) {
  const doc: any = {
    _id: ID,
    type: 'blog',
    title: 'Solar guide',
    slug: 'solar-guide',
    locale: 'en',
    body: '',
    excerpt: '',
    coverImage: OLD_COVER,
    coverImageAlt: 'Old alt',
    status: 'published',
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    autoTranslated: false,
    translatedFrom: undefined,
    seo: {},
    relatedContent: [],
    relatedServices: [],
    tags: [],
    activeCountries: [],
    save: vi.fn(async () => undefined),
    ...overrides,
  };
  doc.toObject = () => ({ ...doc });
  doc.populate = vi.fn(() => doc);
  doc.lean = vi.fn(async () => doc.toObject());
  return doc;
}

function mockReferenceDocs(docs: Array<Record<string, any>>) {
  find.mockReturnValue({
    select: () => ({ lean: async () => docs }),
  });
}

/** Mongoose `findById` is both awaitable and chainable (populate → lean). */
function mockFindById(doc: Record<string, any>) {
  const query: any = {
    populate: () => query,
    lean: async () => doc.toObject(),
    then: (resolve: any, reject: any) => Promise.resolve(doc).then(resolve, reject),
  };
  findById.mockReturnValue(query);
  return doc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReferenceDocs([]);
  deleteFromS3.mockResolvedValue(undefined);
  syncCmsTranslations.mockResolvedValue([]);
  deleteAutoTranslatedSiblings.mockResolvedValue({ deleted: 0, detached: 0 });
  moveAutoTranslatedSiblings.mockResolvedValue([]);
  isTranslationSource.mockReturnValue(true);
});

describe('CMS cover cleanup on update', () => {
  it('runs the translation sync before reclaiming the replaced cover', async () => {
    mockFindById(makeDoc());

    const res = mockRes();
    await updateCmsContent(
      { params: { id: ID }, body: { coverImage: NEW_COVER } } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(200);
    expect(syncCmsTranslations).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).toHaveBeenCalledWith(OLD_KEY);
    expect(syncCmsTranslations.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFromS3.mock.invocationCallOrder[0]
    );
  });

  it('keeps the replaced object when a surviving manual translation still references it', async () => {
    mockFindById(makeDoc());
    mockReferenceDocs([{ _id: 'manual-nl', coverImage: OLD_COVER }]);

    const res = mockRes();
    await updateCmsContent(
      { params: { id: ID }, body: { coverImage: NEW_COVER } } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(200);
    expect(syncCmsTranslations).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('keeps the replaced object when the translation sync fails', async () => {
    mockFindById(makeDoc());
    syncCmsTranslations.mockRejectedValueOnce(new Error('translator unavailable'));
    mockReferenceDocs([{ _id: 'auto-nl', coverImage: OLD_COVER }]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = mockRes();
    await updateCmsContent(
      { params: { id: ID }, body: { coverImage: NEW_COVER } } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.translations).toEqual([
      { locale: '*', status: 'failed', error: 'Translation sync crashed' },
    ]);
    expect(deleteFromS3).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('CMS cover cleanup on delete', () => {
  it('keeps the cover object while a manual translation survivor references it', async () => {
    findByIdAndDelete.mockResolvedValue(makeDoc());
    deleteAutoTranslatedSiblings.mockResolvedValue({ deleted: 1, detached: 1 });
    mockReferenceDocs([{ _id: 'manual-nl', coverImage: OLD_COVER }]);

    const res = mockRes();
    await deleteCmsContent(
      { params: { id: ID }, body: {} } as unknown as Request,
      res
    );

    expect(res.statusCode).toBe(200);
    expect(deleteAutoTranslatedSiblings).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('deletes the cover object when no surviving document references it', async () => {
    findByIdAndDelete.mockResolvedValue(makeDoc());
    deleteAutoTranslatedSiblings.mockResolvedValue({ deleted: 2, detached: 0 });

    const res = mockRes();
    await deleteCmsContent(
      { params: { id: ID }, body: {} } as unknown as Request,
      res
    );

    expect(deleteFromS3).toHaveBeenCalledWith(OLD_KEY);
    expect(deleteAutoTranslatedSiblings.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFromS3.mock.invocationCallOrder[0]
    );
  });
});
