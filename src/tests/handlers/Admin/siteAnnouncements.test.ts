import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  aggregate,
  countDocuments,
  find,
  findById,
  findByIdAndUpdate,
  findOneAndUpdate,
  create,
} = vi.hoisted(() => ({
  aggregate: vi.fn(),
  countDocuments: vi.fn(),
  find: vi.fn(),
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findOneAndUpdate: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../../models/siteAnnouncement', () => ({
  default: {
    aggregate,
    countDocuments,
    find,
    findById,
    findByIdAndUpdate,
    findOneAndUpdate,
    create,
  },
}));

import {
  createSiteAnnouncement,
  deleteSiteAnnouncement,
  getSiteAnnouncement,
  listSiteAnnouncements,
  setSiteAnnouncementActive,
  updateSiteAnnouncement,
} from '../../../handlers/Admin/siteAnnouncements';
import {
  listPublicSiteAnnouncements,
} from '../../../handlers/Public/siteAnnouncements';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: unknown };
}

describe('admin site announcement handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires admin auth to create', async () => {
    const res = mockRes();
    await createSiteAnnouncement({ body: {}, admin: undefined } as Request, res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it('creates an announcement with the parsed body and createdBy', async () => {
    create.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', name: 'Summer BE promo' });
    const res = mockRes();
    await createSiteAnnouncement(
      {
        admin: { _id: 'admin-1' },
        body: {
          name: 'Summer BE promo',
          type: 'top_bar',
          title: 'Summer 10% off',
          message: 'Book this month and save',
          startsAt: '2026-07-01',
          endsAt: '2026-08-01',
          activeCountries: ['be'],
          locale: 'en',
          ctaUrl: '/services',
        },
      } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    const payload = create.mock.calls[0][0];
    expect(payload.createdBy).toBe('admin-1');
    expect(payload.name).toBe('Summer BE promo');
    expect(payload.activeCountries).toEqual(['BE']);
    expect(payload.ctaUrl).toBe('/services');
  });

  it('rejects invalid ids on get', async () => {
    const res = mockRes();
    await getSiteAnnouncement({ params: { id: 'bad-id' } } as unknown as Request, res, vi.fn());
    expect(res.statusCode).toBe(400);
  });

  it('lists announcements with pagination filters', async () => {
    countDocuments.mockResolvedValue(1);
    const chain = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ _id: '1', title: 'Promo' }]),
    };
    find.mockReturnValue(chain);

    const res = mockRes();
    await listSiteAnnouncements(
      { query: { page: '1', limit: '10', status: 'active' } } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { total: number } }).data.total).toBe(1);
  });

  it('patches only provided fields', async () => {
    findById.mockResolvedValue({
      name: 'Promo',
      type: 'top_bar',
      title: 'Old',
      message: 'Message',
      activeCountries: [],
      locale: 'en',
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-31T23:59:59.999Z'),
      isActive: true,
      priority: 0,
      delaySeconds: 3,
      dismissible: true,
      requireMarketingConsent: true,
    });
    findOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', title: 'New title' });

    const res = mockRes();
    await updateSiteAnnouncement(
      {
        params: { id: '507f1f77bcf86cd799439011' },
        body: { title: 'New title' },
      } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: '507f1f77bcf86cd799439011' },
      // Legacy doc without a source hash: the edit records the new hash.
      { $set: { title: 'New title', translationSourceHash: expect.any(String) } },
      { new: true, runValidators: true },
    );
  });

  it('unsets cleared optional fields on patch', async () => {
    findById.mockResolvedValue({
      name: 'Promo',
      type: 'top_bar',
      title: 'Old',
      message: 'Message',
      ctaLabel: 'Go',
      ctaUrl: '/services',
      discountCode: 'SAVE',
      activeCountries: [],
      locale: 'en',
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-31T23:59:59.999Z'),
      isActive: true,
      priority: 0,
      delaySeconds: 3,
      dismissible: true,
      requireMarketingConsent: true,
    });
    findOneAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439011' });

    const res = mockRes();
    await updateSiteAnnouncement(
      {
        params: { id: '507f1f77bcf86cd799439011' },
        body: { ctaLabel: '', ctaUrl: '', discountCode: '' },
      } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: '507f1f77bcf86cd799439011' },
      {
        $set: { translationSourceHash: expect.any(String) },
        $unset: { ctaLabel: 1, ctaUrl: 1, discountCode: 1 },
      },
      { new: true, runValidators: true },
    );
  });

  it('toggles active state with validators enabled', async () => {
    findByIdAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', isActive: false });
    const res = mockRes();
    await setSiteAnnouncementActive(
      {
        params: { id: '507f1f77bcf86cd799439011' },
        body: { isActive: false },
      } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      { isActive: false },
      { new: true, runValidators: true },
    );
  });

  it('soft-deletes by deactivating the announcement', async () => {
    findByIdAndUpdate.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', isActive: false });
    const res = mockRes();
    await deleteSiteAnnouncement(
      { params: { id: '507f1f77bcf86cd799439011' } } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      { isActive: false },
      { new: true, runValidators: true },
    );
  });
});

describe('listPublicSiteAnnouncements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns aggregated winners for the requested locale and country', async () => {
    aggregate.mockResolvedValue([
      { type: 'top_bar', title: 'BE promo', locale: 'nl' },
      { type: 'modal', title: 'FR modal', locale: 'fr' },
    ]);

    const res = mockRes();
    await listPublicSiteAnnouncements(
      { query: { country: 'BE', locale: 'fr' } } as unknown as Request,
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(aggregate).toHaveBeenCalledOnce();
    const pipeline = aggregate.mock.calls[0][0];
    expect(pipeline[4]).toEqual({
      $sort: { priority: -1, localeExact: -1, createdAt: -1 },
    });
    expect((res.body as { data: { announcements: unknown[]; country: string } }).data.country).toBe(
      'BE',
    );
  });
});
