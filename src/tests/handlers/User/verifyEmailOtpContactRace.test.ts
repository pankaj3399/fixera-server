import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindOne, userFindOneAndUpdate, sendOTPEmail } = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  userFindOneAndUpdate: vi.fn(),
  sendOTPEmail: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findOne: userFindOne, findOneAndUpdate: userFindOneAndUpdate },
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: vi.fn(async (_ids: unknown[], write: (session: undefined) => Promise<unknown>) => write(undefined)),
}));
vi.mock('../../../utils/marketing/audience', () => ({ enablePromotionalEmail: vi.fn() }));
vi.mock('../../../utils/emailService', () => ({ generateOTP: vi.fn(() => '222222'), sendOTPEmail }));

import { resendEmailOTP, sendEmailOTP } from '../../../handlers/User/verify/email';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as any;
}

/** Stored account; findOneAndUpdate applies $set only when the filter still matches. */
let stored: Record<string, any>;
beforeEach(() => {
  vi.clearAllMocks();
  sendOTPEmail.mockResolvedValue(true);
  stored = { _id: 'user-1', name: 'Buyer', email: 'old@example.com', isEmailVerified: false };
  userFindOneAndUpdate.mockImplementation(async (filter: Record<string, any>, update: { $set: Record<string, unknown> }) => {
    const matches = Object.entries(filter).every(([key, value]) => stored[key] === value);
    if (!matches) return null;
    Object.assign(stored, update.$set);
    return { ...stored };
  });
});

describe.each([
  ['sendEmailOTP', sendEmailOTP],
  ['resendEmailOTP', resendEmailOTP],
])('%s and a concurrent signup contact change', (_name, handler) => {
  it('stores and mails a code while the email is unchanged', async () => {
    userFindOne.mockResolvedValue({ ...stored });
    const res = resMock();
    await handler({ body: { email: 'old@example.com' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(stored.verificationCode).toBe('222222');
    expect(sendOTPEmail).toHaveBeenCalledWith('old@example.com', '222222', 'Buyer');
  });

  it('neither stores nor mails a code when the email changed after the read', async () => {
    userFindOne.mockImplementation(async () => {
      const snapshot = { ...stored };
      stored.email = 'new@example.com';
      stored.verificationCode = '999999';
      return snapshot;
    });
    const res = resMock();
    await handler({ body: { email: 'old@example.com' } } as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(stored.verificationCode).toBe('999999');
    expect(sendOTPEmail).not.toHaveBeenCalled();
  });
});
