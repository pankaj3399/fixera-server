/**
 * Errors that are safe to show verbatim to the caller.
 *
 * Only use this for messages written for end users (validation, business rules
 * and explicit provider failures). Unexpected errors must stay generic.
 */
export type ErrorCode =
  | 'VALIDATION'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ACCOUNT_UNAVAILABLE'
  | 'SLOT_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export class UserFacingError extends Error {
  readonly expose = true;

  constructor(
    public readonly status: number,
    message: string,
    public readonly code: ErrorCode = 'VALIDATION',
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function errorCodeForStatus(status: number): ErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'VALIDATION';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL';
  return 'VALIDATION';
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}
