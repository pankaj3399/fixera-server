import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { findOneAndUpdate, findOne } = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  findOne: vi.fn(),
}));

const { fetchEcbRates } = vi.hoisted(() => ({
  fetchEcbRates: vi.fn(),
}));

const { connectDB } = vi.hoisted(() => ({
  connectDB: vi.fn(),
}));

vi.mock('../../../models/exchangeRateSnapshot', () => ({
  default: { findOneAndUpdate, findOne },
}));

vi.mock('../../../utils/ecbRates', () => ({ fetchEcbRates }));

vi.mock('../../../config/db', () => ({ default: connectDB }));

import {
  getPublicExchangeRates,
  resetExchangeRatesCacheForTests,
} from '../../../handlers/Public/exchangeRates';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetExchangeRatesCacheForTests();
  connectDB.mockResolvedValue(undefined);
  findOneAndUpdate.mockResolvedValue({});
  findOne.mockReturnValue({ lean: async () => null });
});

describe('GET /api/public/exchange-rates', () => {
  it('connects to Mongo before reading the snapshot on a cache miss', async () => {
    fetchEcbRates.mockResolvedValue({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } });

    await getPublicExchangeRates({} as Request, mockRes());

    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith({ base: 'EUR' });
  });

  it('serves fresh ECB rates without the DB when connectDB fails', async () => {
    connectDB.mockRejectedValue(new Error('MONGODB_URI is not defined'));
    fetchEcbRates.mockResolvedValue({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = mockRes();
    await getPublicExchangeRates({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.date).toBe('2026-10-23');
    expect(res.body.data.rates).toEqual({ EUR: 1, USD: 1.0812 });
    expect(findOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not connect to Mongo when the in-memory cache hits', async () => {
    fetchEcbRates.mockResolvedValue({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } });

    await getPublicExchangeRates({} as Request, mockRes());
    expect(connectDB).toHaveBeenCalledTimes(1);

    await getPublicExchangeRates({} as Request, mockRes());
    expect(connectDB).toHaveBeenCalledTimes(1);
  });

  it('serves fresh ECB rates, persists a snapshot and sets the CDN cache header', async () => {
    fetchEcbRates.mockResolvedValue({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } });

    const res = mockRes();
    await getPublicExchangeRates({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { base: 'EUR', date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } },
    });
    expect(typeof res.body.data.fetchedAt).toBe('string');
    expect(res.headers['Cache-Control']).toBe(
      'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'
    );
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { base: 'EUR' },
      { $set: expect.objectContaining({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } }) },
      { upsert: true, new: true }
    );
  });

  it('serves the in-memory cache without fetching again', async () => {
    fetchEcbRates.mockResolvedValue({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } });

    await getPublicExchangeRates({} as Request, mockRes());
    const second = mockRes();
    await getPublicExchangeRates({} as Request, second);

    expect(fetchEcbRates).toHaveBeenCalledTimes(1);
    expect(second.body.success).toBe(true);
    expect(second.body.data.date).toBe('2026-10-23');
  });

  it('serves a fresh Mongo snapshot without calling the ECB', async () => {
    findOne.mockReturnValue({
      lean: async () => ({
        base: 'EUR',
        date: '2026-10-23',
        rates: { EUR: 1, USD: 1.08 },
        fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    });

    const res = mockRes();
    await getPublicExchangeRates({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.date).toBe('2026-10-23');
    expect(fetchEcbRates).not.toHaveBeenCalled();
  });

  it('falls back to the last Mongo snapshot during an ECB outage', async () => {
    fetchEcbRates.mockRejectedValue(new Error('ECB fetch failed with HTTP status 503'));
    // Older than the freshness window, so the ECB is tried first.
    const staleFetchedAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    findOne.mockReturnValue({
      lean: async () => ({
        base: 'EUR',
        date: '2026-10-22',
        rates: { EUR: 1, USD: 1.07 },
        fetchedAt: staleFetchedAt,
      }),
    });

    const res = mockRes();
    await getPublicExchangeRates({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      base: 'EUR',
      date: '2026-10-22',
      rates: { EUR: 1, USD: 1.07 },
      fetchedAt: staleFetchedAt.toISOString(),
    });
  });

  it('returns 503 when neither ECB nor a snapshot is available', async () => {
    fetchEcbRates.mockRejectedValue(new Error('network down'));
    findOne.mockReturnValue({ lean: async () => null });

    const res = mockRes();
    await getPublicExchangeRates({} as Request, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.msg).toBe('string');
  });

  it('still serves fresh rates when persisting the snapshot fails', async () => {
    fetchEcbRates.mockResolvedValue({ date: '2026-10-23', rates: { EUR: 1, USD: 1.0812 } });
    findOneAndUpdate.mockRejectedValue(new Error('db unavailable'));

    const res = mockRes();
    await getPublicExchangeRates({} as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
