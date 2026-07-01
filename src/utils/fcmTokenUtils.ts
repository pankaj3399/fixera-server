import { Request } from 'express';
import { IUser } from '../models/user';
import { getFrontendUrl } from './frontendUrl';

/** Normalise origin for comparison (protocol + host, no trailing slash). */
export function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    try {
      const url = new URL(`https://${origin.replace(/^\/+/, '')}`);
      return `${url.protocol}//${url.host}`.toLowerCase();
    } catch {
      return origin.replace(/\/+$/, '').toLowerCase();
    }
  }
}

/** Origins allowed when registering a token (prevents arbitrary values). */
export function isAllowedOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  const allowed = new Set([
    normalizeOrigin(getFrontendUrl()),
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  return allowed.has(normalized);
}

/** Derive origin from trusted request headers only (never from body). */
export function getOriginFromRequest(req: Request): string {
  const header = req.get('origin') || req.get('referer');
  if (header) {
    try {
      return normalizeOrigin(new URL(header).origin);
    } catch {
      // fall through
    }
  }

  return normalizeOrigin(getFrontendUrl());
}

/**
 * Only return FCM tokens registered for this deployment's FRONTEND_URL.
 * Legacy plain-string tokens are ignored (re-register after deploy).
 */
export function getTokensForCurrentDeployment(
  entries: IUser['fcmTokens'] | undefined,
): string[] {
  if (!entries?.length) return [];

  const target = normalizeOrigin(getFrontendUrl());

  return entries.flatMap((entry) => {
    if (!entry || typeof entry === 'string') return [];
    if (!entry.token) return [];
    if (normalizeOrigin(entry.origin) !== target) return [];
    return [entry.token];
  });
}
