import http from 'node:http';
import https from 'node:https';

/**
 * Test-only guard. Every suite runs with provider delivery disabled and any
 * accidental outbound HTTP(S) request rejected before it reaches a host.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.EMAIL_DEV_NO_SEND = 'true';
process.env.MARKETING_CAMPAIGN_DRY_RUN = 'true';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_provider_isolation';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-provider-isolation';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-provider-isolation';
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';

export const providerNetworkAttempts: string[] = [];

const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

const hostFromArgs = (args: unknown[]): string => {
  const first = args[0] as any;
  if (typeof first === 'string' || first instanceof URL) {
    try {
      return new URL(String(first)).hostname;
    } catch {
      return '';
    }
  }
  if (first && typeof first === 'object') {
    return String(first.hostname || first.host || '').split(':')[0];
  }
  const second = args[1] as any;
  return typeof second === 'string' ? second.split(':')[0] : '';
};

const assertLocal = (host: string, protocol: string, target: string) => {
  if (!host || localHosts.has(host)) return;
  const message = `Blocked unintended ${protocol} provider request to ${host} (${target})`;
  providerNetworkAttempts.push(message);
  throw new Error(message);
};

const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;

(http as any).request = function guardedHttpRequest(...args: unknown[]) {
  assertLocal(hostFromArgs(args), 'http', String(args[0]));
  return (originalHttpRequest as any).apply(this, args);
};
(http as any).get = function guardedHttpGet(...args: unknown[]) {
  assertLocal(hostFromArgs(args), 'http', String(args[0]));
  return (originalHttpGet as any).apply(this, args);
};
(https as any).request = function guardedHttpsRequest(...args: unknown[]) {
  assertLocal(hostFromArgs(args), 'https', String(args[0]));
  return (originalHttpsRequest as any).apply(this, args);
};
(https as any).get = function guardedHttpsGet(...args: unknown[]) {
  assertLocal(hostFromArgs(args), 'https', String(args[0]));
  return (originalHttpsGet as any).apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  let host = '';
  try {
    host = new URL(
      typeof input === 'string' || input instanceof URL ? String(input) : input.url,
    ).hostname;
  } catch {
    host = '';
  }
  assertLocal(host, 'fetch', String(input));
  return originalFetch(input, init);
}) as typeof globalThis.fetch;
