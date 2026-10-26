import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Provenance for emails emitted while handling a user action. The central
 * email logger records this id so a later anonymization can redact copies
 * about the target without guessing from the subject text.
 */
const emailActorStorage = new AsyncLocalStorage<string>();

export const runWithEmailActor = async <T>(
  actorId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!actorId) return fn();
  return emailActorStorage.run(actorId, fn);
};

export const currentEmailActorId = (): string | undefined =>
  emailActorStorage.getStore();
