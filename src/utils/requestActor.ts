import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The authenticated user performing the current request, available to code
 * that has no `req` (Mongoose middleware, shared utils). Set by the auth
 * middlewares; absent for cron jobs, webhooks and scripts (= "system").
 */
export interface RequestActor {
  userId: string;
  role: 'customer' | 'professional' | 'admin' | 'employee' | string;
}

const storage = new AsyncLocalStorage<RequestActor>();

export function runWithRequestActor<T>(user: unknown, fn: () => T): T {
  const record = user as { _id?: unknown; role?: unknown } | null | undefined;
  if (!record?._id) return fn();
  return storage.run({ userId: String(record._id), role: String(record.role || 'customer') }, fn);
}

export function currentRequestActor(): RequestActor | undefined {
  return storage.getStore();
}
