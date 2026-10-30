import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const CUSTOMER_ID = '507f1f77bcf86cd799439011';

const mocks = vi.hoisted(() => ({
  claimFind: vi.fn(),
  claimCount: vi.fn(),
  claimExists: vi.fn(),
  bookingFind: vi.fn(),
  projectFind: vi.fn(),
}));

vi.mock('../../../models/warrantyClaim', () => ({
  default: {
    find: mocks.claimFind,
    countDocuments: mocks.claimCount,
    exists: mocks.claimExists,
  },
}));

vi.mock('../../../models/booking', () => ({
  default: { find: mocks.bookingFind },
}));

vi.mock('../../../models/project', () => ({
  default: { find: mocks.projectFind },
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

describe('warranty claim search and filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimFind.mockReturnValue(claimChain([]));
    mocks.claimCount.mockResolvedValue(0);
    mocks.bookingFind.mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn(async () => []) })) });
    mocks.projectFind.mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn(async () => []) })) });
  });

  it('searches by escaped claim number without regex injection', async () => {
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { q: 'WC-2026.1 (x)' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const query = mocks.claimFind.mock.calls[0][0];
    const searchOr = query.$and[0].$or;
    expect(String(searchOr[0].claimNumber)).toContain('WC-2026\\.1 \\(x\\)');
    // Role scoping preserved.
    expect(String(query.customer)).toContain(CUSTOMER_ID.slice(-6));
  });

  it('resolves booking-number text through the viewer own bookings', async () => {
    mocks.bookingFind.mockReturnValue({
      select: vi.fn(() => ({ lean: vi.fn(async () => [{ _id: 'b9' }]) })),
    });
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { q: 'BK-9' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const query = mocks.claimFind.mock.calls[0][0];
    const bookingClause = query.$and[0].$or.find((clause: any) => clause.booking);
    expect(bookingClause).toBeTruthy();
    const bookingScope = mocks.bookingFind.mock.calls[0][0];
    expect(String(bookingScope.customer)).toContain(CUSTOMER_ID.slice(-6));
  });

  it('scopes the service filter to the viewer bookings', async () => {
    mocks.bookingFind.mockReturnValue({
      select: vi.fn(() => ({ lean: vi.fn(async () => [{ _id: 'b1' }]) })),
    });
    const res = mockRes();
    await listMyWarrantyClaims(
      { user: { _id: CUSTOMER_ID, role: 'customer' }, query: { service: 'Cleaning' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const query = mocks.claimFind.mock.calls[0][0];
    expect(query.booking).toBeTruthy();
  });
});
