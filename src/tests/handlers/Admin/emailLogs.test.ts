import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => {
  const chain = { sort: vi.fn(), skip: vi.fn(), limit: vi.fn(), lean: vi.fn() };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return { chain, find: vi.fn(() => chain), countDocuments: vi.fn() };
});
vi.mock('../../../models/emailLog', () => ({ default: { find: mocks.find, countDocuments: mocks.countDocuments } }));

import { listEmailLogs } from '../../../handlers/Admin/emailLogs';

function res() {
  const out: any = { statusCode: 200, body: undefined };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (body: unknown) => { out.body = body; return out; };
  return out as Response & { statusCode: number; body: any };
}

describe('GET /admin/email-logs (listEmailLogs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chain.sort.mockReturnValue(mocks.chain);
    mocks.chain.skip.mockReturnValue(mocks.chain);
    mocks.chain.limit.mockReturnValue(mocks.chain);
  });

  it('returns the shape the admin page parses, with pagination', async () => {
    mocks.chain.lean.mockResolvedValue([{ _id: 'l1', to: 'a@x.test', template: 'booking-confirmed', status: 'sent', createdAt: new Date() }]);
    mocks.countDocuments.mockResolvedValue(51);
    const out = res();
    await listEmailLogs({ query: { page: '2', limit: '25' } } as unknown as Request, out);
    expect(out.statusCode).toBe(200);
    expect(out.body.success).toBe(true);
    expect(out.body.data.logs).toHaveLength(1);
    expect(out.body.data.pagination).toEqual({ page: 2, limit: 25, total: 51, totalPages: 3 });
    expect(mocks.chain.skip).toHaveBeenCalledWith(25);
  });

  it('builds safe filters: escaped recipient regex, known statuses only, valid booking ids, end-of-day until', async () => {
    mocks.chain.lean.mockResolvedValue([]);
    mocks.countDocuments.mockResolvedValue(0);
    await listEmailLogs({
      query: {
        to: 'a.b+(x)@',
        status: 'sent',
        template: ' welcome ',
        relatedBooking: '507f1f77bcf86cd799439011',
        from: '2026-11-01T00:00:00.000Z',
        until: '2026-11-02T00:00:00.000Z',
        limit: '5000',
      },
    } as unknown as Request, res());
    const query = mocks.find.mock.calls[0][0] as any;
    expect(query.to.source).toBe('a\\.b\\+\\(x\\)@');
    expect(query.status).toBe('sent');
    expect(query.template).toBe('welcome');
    expect(String(query.relatedBooking)).toBe('507f1f77bcf86cd799439011');
    expect(query.createdAt.$lte.toISOString()).toBe('2026-11-02T23:59:59.999Z');
    expect(mocks.chain.limit).toHaveBeenCalledWith(100);

    await listEmailLogs({ query: { status: '$ne', relatedBooking: 'nope', to: 'a' } } as unknown as Request, res());
    expect(mocks.find.mock.calls[1][0]).toEqual({});
  });

  it('answers an empty page cleanly and never leaks the error on failure', async () => {
    mocks.chain.lean.mockResolvedValue([]);
    mocks.countDocuments.mockResolvedValue(0);
    const empty = res();
    await listEmailLogs({ query: {} } as unknown as Request, empty);
    expect(empty.body.data).toEqual({ logs: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } });

    mocks.chain.lean.mockRejectedValue(new Error('MongoServerError: connection pool closed'));
    const failed = res();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await listEmailLogs({ query: {} } as unknown as Request, failed);
    spy.mockRestore();
    expect(failed.statusCode).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('MongoServerError');
  });
});
