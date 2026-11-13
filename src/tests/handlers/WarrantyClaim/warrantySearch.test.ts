import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const CUSTOMER_ID = '507f1f77bcf86cd799439011';

const mocks = vi.hoisted(() => ({
  claimFind: vi.fn(),
  claimCount: vi.fn(),
  claimExists: vi.fn(),
  claimDistinct: vi.fn(),
  claimAggregate: vi.fn(),
  bookingFind: vi.fn(),
  projectFind: vi.fn(),
}));

vi.mock('../../../models/warrantyClaim', () => ({
  default: {
    find: mocks.claimFind,
    countDocuments: mocks.claimCount,
    exists: mocks.claimExists,
    distinct: mocks.claimDistinct,
    aggregate: mocks.claimAggregate,
  },
}));

vi.mock('../../../models/booking', () => ({
  default: { find: mocks.bookingFind, collection: { collectionName: 'bookings' } },
}));

vi.mock('../../../models/project', () => ({
  default: { find: mocks.projectFind, collection: { collectionName: 'projects' } },
}));

vi.mock('../../../models/conversation', () => ({ default: {} }));
vi.mock('../../../models/chatMessage', () => ({ default: {} }));
vi.mock('../../../models/user', () => ({ default: { findById: vi.fn() } }));

import { listMyWarrantyClaims } from '../../../handlers/WarrantyClaim';

const mockRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
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
};

const claimChain = (rows: any[]) => {
  const chain: any = {};
  chain.populate = vi.fn(() => chain);
  chain.sort = vi.fn(() => chain);
  chain.skip = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows.map((row) => ({ ...row })));
  return chain;
};

// Booking-number search and the service filter run as one aggregation over
// the role-scoped claims; their data behavior (snapshot service, booking
// scope, pagination, counts) is covered on real Mongo in
// tests/integration/dashboardListFilters.test.ts.
describe('warranty claim search and filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimFind.mockReturnValue(claimChain([]));
    mocks.claimCount.mockResolvedValue(0);
    mocks.claimAggregate.mockResolvedValue([{ page: [], total: [] }]);
  });

  // The list pipeline is the one that pages ($facet.page); the facet-count
  // aggregation (FT2 #10a) is a separate call.
  const listPipelines = () =>
    (mocks.claimAggregate.mock.calls as any[]).map((call) => call[0] as any[]).filter((p) => p.at(-1)?.$facet?.page);
  const pipelineOf = () => listPipelines()[0];

  it('searches by escaped claim number without regex injection, inside the role scope', async () => {
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { q: 'WC-2026.1 (x)' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.pagination).toEqual({ total: 0, page: 1, limit: 20, totalPages: 0 });
    const pipeline = pipelineOf();
    // Role scoping is the first stage.
    expect(String(pipeline[0].$match.customer)).toBe(CUSTOMER_ID);
    const searchStage = pipeline.find((stage) => stage.$match?.$or);
    const [claimClause, bookingClause] = searchStage.$match.$or;
    expect(String(claimClause.claimNumber)).toContain('WC-2026\\.1 \\(x\\)');
    // Booking-number text only matches bookings of the viewer.
    expect(String(bookingClause.$and[1]['_claimBooking.customer'])).toBe(CUSTOMER_ID);
    expect(mocks.claimDistinct).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  const anyClaimQuery = () => [
    mocks.claimFind,
    mocks.claimCount,
    mocks.claimExists,
    mocks.claimDistinct,
    mocks.claimAggregate,
    mocks.bookingFind,
    mocks.projectFind,
  ].some((fn) => fn.mock.calls.length > 0);

  it.each(['admin', 'employee', 'visitor', 'superuser'])(
    'rejects role %s with 403 before any database query (plain and filtered)',
    async (role) => {
      for (const query of [{}, { q: 'BK-2026', service: 'Plumbing', status: 'open' }]) {
        const res = mockRes();
        await listMyWarrantyClaims(
          { user: { _id: CUSTOMER_ID, role }, query } as unknown as Request,
          res,
        );
        expect(res.statusCode).toBe(403);
        expect(res.body.success).toBe(false);
      }
      expect(anyClaimQuery()).toBe(false);
    },
  );

  it('keeps 401 for a missing user or role, without a query', async () => {
    for (const user of [undefined, { role: 'customer' }, { _id: CUSTOMER_ID }]) {
      const res = mockRes();
      await listMyWarrantyClaims({ user, query: {} } as unknown as Request, res);
      expect(res.statusCode).toBe(401);
    }
    expect(anyClaimQuery()).toBe(false);
  });

  it('scopes a professional to their own claims in both the plain and the joined path', async () => {
    const PRO_ID = '507f1f77bcf86cd799439022';
    const plain = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: PRO_ID, role: 'professional' }, query: {} } as unknown as Request,
      plain,
    );
    expect(plain.statusCode).toBe(200);
    const plainQuery = mocks.claimFind.mock.calls[0][0];
    expect(String(plainQuery.professional)).toBe(PRO_ID);
    expect(plainQuery.customer).toBeUndefined();
    expect(String(mocks.claimCount.mock.calls[0][0].professional)).toBe(PRO_ID);

    const joined = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: PRO_ID, role: 'professional' }, query: { service: 'Plumbing', page: '2', limit: '10' } } as unknown as Request,
      joined,
    );
    expect(joined.statusCode).toBe(200);
    const pipeline = pipelineOf();
    expect(String(pipeline[0].$match.professional)).toBe(PRO_ID);
    expect(pipeline[0].$match.customer).toBeUndefined();
    expect(pipeline.at(-1).$facet.page.slice(0, 2)).toEqual([{ $skip: 10 }, { $limit: 10 }]);
  });

  it('keeps the plain paginated query when no booking-dependent filter is set', async () => {
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { status: 'open', page: '2', limit: '5' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(listPipelines()).toHaveLength(0);
    const query = mocks.claimFind.mock.calls[0][0];
    expect(query.status).toBe('open');
    expect(String(query.customer)).toBe(CUSTOMER_ID);
    const chain = mocks.claimFind.mock.results[0].value;
    expect(chain.skip).toHaveBeenCalledWith(5);
    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it('pages the service filter in the database and hydrates only the page ids', async () => {
    const PAGE_ID = '507f1f77bcf86cd799439055';
    mocks.claimAggregate.mockResolvedValue([{ page: [{ _id: PAGE_ID }], total: [{ count: 41 }] }]);
    mocks.claimFind.mockReturnValue({
      populate: vi.fn(function (this: any) { return this; }),
      then: (resolve: (rows: any[]) => unknown) => resolve([{ _id: PAGE_ID, claimNumber: 'WC-1' }]),
    });
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { service: 'Cleaning', page: '3', limit: '20' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const pipeline = pipelineOf();
    const facet = pipeline.at(-1).$facet;
    expect(facet.page.slice(0, 2)).toEqual([{ $skip: 40 }, { $limit: 20 }]);
    expect(mocks.claimFind.mock.calls[0][0]).toEqual({ _id: { $in: [PAGE_ID] } });
    expect(res.body.data.claims.map((c: any) => c.claimNumber)).toEqual(['WC-1']);
    expect(res.body.data.pagination).toEqual({ total: 41, page: 3, limit: 20, totalPages: 3 });
  });

  it('computes facet counts inside the role scope, without the own status facet (FT2 #10a)', async () => {
    mocks.claimAggregate.mockImplementation(async (pipeline: any[]) =>
      pipeline.at(-1)?.$facet?.page
        ? [{ page: [], total: [] }]
        : [{ status: [{ _id: 'open', count: 2 }], service: [{ _id: 'Cleaning', count: 1 }] }]);
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { status: 'open', service: 'Cleaning' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const countPipeline = (mocks.claimAggregate.mock.calls as any[])
      .map((call) => call[0] as any[])
      .find((p) => p.at(-1)?.$facet?.status);
    expect(String(countPipeline[0].$match.customer)).toBe(CUSTOMER_ID);
    expect(countPipeline[0].$match.status).toBeUndefined();
    expect(res.body.data.statusCounts).toEqual({ open: 2 });
    expect(res.body.data.serviceCounts).toEqual({ Cleaning: 1 });
  });
});
