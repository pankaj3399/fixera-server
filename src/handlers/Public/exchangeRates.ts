import { Request, Response } from "express";

import connectDB from "../../config/db";
import ExchangeRateSnapshot from "../../models/exchangeRateSnapshot";
import { fetchEcbRates } from "../../utils/ecbRates";

/**
 * GET /api/public/exchange-rates
 *
 * Serves EUR-based daily reference rates:
 * 1. In-memory cache (per warm serverless instance, TTL 6h).
 * 2. Fresh Mongo snapshot written by another instance (so cold instances do
 *    not all hit the ECB).
 * 3. Fresh fetch of the ECB daily XML, persisted to Mongo for other instances
 *    and for outage fallbacks.
 * 4. Stale Mongo snapshot when the ECB fetch fails.
 * 5. 503 when nothing is available at all.
 */
const MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
/** A snapshot younger than this is served without calling the ECB. */
const SNAPSHOT_FRESH_MS = 6 * 60 * 60 * 1000; // 6h
/** Stale snapshots are re-checked sooner so an ECB recovery is picked up. */
const STALE_SNAPSHOT_TTL_MS = 15 * 60 * 1000; // 15min
const SNAPSHOT_BASE = "EUR";
const CACHE_CONTROL = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400";

interface RatesPayload {
  base: string;
  date: string;
  rates: Record<string, number>;
  fetchedAt: string;
}

let memoryCache: { payload: RatesPayload; expiresAt: number } | null = null;

function toPayload(snapshot: {
  base?: string;
  date: string;
  rates: Record<string, number>;
  fetchedAt: Date | string;
}): RatesPayload {
  const fetched = new Date(snapshot.fetchedAt as any);
  return {
    base: snapshot.base || SNAPSHOT_BASE,
    date: snapshot.date,
    rates: snapshot.rates,
    fetchedAt: Number.isFinite(fetched.getTime())
      ? fetched.toISOString()
      : new Date().toISOString(),
  };
}

function isUsableSnapshot(snapshot: any): boolean {
  return Boolean(snapshot?.rates && snapshot?.date);
}

function sendRates(res: Response, payload: RatesPayload) {
  res.set("Cache-Control", CACHE_CONTROL);
  return res.status(200).json({ success: true, data: payload });
}

async function loadSnapshot(): Promise<any | null> {
  try {
    return await ExchangeRateSnapshot.findOne({ base: SNAPSHOT_BASE }).lean();
  } catch (error) {
    console.error("Failed to load exchange-rate snapshot:", error);
    return null;
  }
}

export const getPublicExchangeRates = async (_req: Request, res: Response) => {
  const now = Date.now();

  if (memoryCache && memoryCache.expiresAt > now) {
    return sendRates(res, memoryCache.payload);
  }

  // Vercel has no startup connect: connect per request (mongoose caches the
  // connection). A DB outage must not take the endpoint down — the ECB rates
  // are still served, just without the snapshot cache.
  let dbConnected = false;
  try {
    await connectDB();
    dbConnected = true;
  } catch (error) {
    console.error("MongoDB unavailable for exchange rates; serving without snapshot cache:", error);
  }

  const snapshot = dbConnected ? await loadSnapshot() : null;
  let payload: RatesPayload | undefined;
  let fromSnapshot = false;

  if (isUsableSnapshot(snapshot)) {
    const fetchedAtMs = new Date(snapshot.fetchedAt).getTime();
    if (Number.isFinite(fetchedAtMs) && now - fetchedAtMs < SNAPSHOT_FRESH_MS) {
      payload = toPayload(snapshot);
      fromSnapshot = true;
    }
  }

  if (!payload) {
    try {
      const ecb = await fetchEcbRates();
      payload = {
        base: SNAPSHOT_BASE,
        date: ecb.date,
        rates: ecb.rates,
        fetchedAt: new Date(now).toISOString(),
      };

      // Persist inside the request (serverless freezes post-response work), but
      // a snapshot write failure must never fail the response. Skipped entirely
      // when Mongo was unreachable at the start of the request.
      if (dbConnected) {
        try {
          await ExchangeRateSnapshot.findOneAndUpdate(
            { base: SNAPSHOT_BASE },
            { $set: { date: payload.date, rates: payload.rates, fetchedAt: new Date(now) } },
            { upsert: true, new: true }
          );
        } catch (persistError) {
          console.error("Failed to persist exchange-rate snapshot:", persistError);
        }
      }
    } catch (fetchError) {
      console.error("ECB exchange-rates fetch failed, trying last known snapshot:", fetchError);
    }
  }

  if (!payload && isUsableSnapshot(snapshot)) {
    payload = toPayload(snapshot);
    fromSnapshot = true;
  }

  if (!payload) {
    return res.status(503).json({
      success: false,
      msg: "Exchange rates are temporarily unavailable. Please try again later.",
    });
  }

  memoryCache = {
    payload,
    expiresAt: Date.now() + (fromSnapshot ? STALE_SNAPSHOT_TTL_MS : MEMORY_CACHE_TTL_MS),
  };
  return sendRates(res, payload);
};

export function resetExchangeRatesCacheForTests() {
  memoryCache = null;
}
