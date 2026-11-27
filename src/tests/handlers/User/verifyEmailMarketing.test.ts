import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindOne, userFindOneAndUpdate, enablePromotionalEmail, writeFence } = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  userFindOneAndUpdate: vi.fn(),
  enablePromotionalEmail: vi.fn(),
  writeFence: vi.fn(async (_ids: unknown[], write: (session: undefined) => Promise<unknown>) => write(undefined)),
}));

vi.mock('../../../models/user', () => ({
  default: {
    findOne: userFindOne,
    findOneAndUpdate: userFindOneAndUpdate,
  },
}));

vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: writeFence,
}));

vi.mock('../../../utils/marketing/audience', () => ({
  enablePromotionalEmail,
}));

vi.mock('../../../utils/emailService', () => ({
  generateOTP: vi.fn(),
  sendOTPEmail: vi.fn(),
}));

import { verifyEmailOTP } from '../../../handlers/User/verify/email';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as any;
}

function mockUser(overrides: Record<string, unknown> = {}) {
  userFindOne.mockReturnValue({
    select: vi.fn().mockResolvedValue({
      _id: 'user-1',
      email: 'buyer@example.com',
      isEmailVerified: false,
      verificationCode: '123456',
      verificationCodeExpires: new Date(Date.now() + 10 * 60 * 1000),
      marketingOptInPending: false,
      ...overrides,
    }),
  });
}

describe('verifyEmailOTP pending marketing opt-in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindOneAndUpdate.mockResolvedValue({ _id: 'user-1', email: 'buyer@example.com' });
  });

  it('activates and enrolls the opt-in only after OTP verification', async () => {
    mockUser({ marketingOptInPending: true });

    const res = resMock();
    await verifyEmailOTP(
      { body: { email: 'buyer@example.com', otp: '123456' } } as any,
      res,
      vi.fn(),
    );

    expect(writeFence).toHaveBeenCalledWith(['user-1'], expect.any(Function));
    expect(userFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'user-1',
        email: 'buyer@example.com',
        isEmailVerified: { $ne: true },
        verificationCode: '123456',
        verificationCodeExpires: { $gt: expect.any(Date) },
      },
      {
        $set: expect.objectContaining({
          isEmailVerified: true,
          'notificationPreferences.promotions.email': true,
          marketingOptInPending: false,
          marketingConsentAt: expect.any(Date),
        }),
        $unset: { verificationCode: 1, verificationCodeExpires: 1 },
      },
      { new: true },
    );
    expect(enablePromotionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'user-1' }),
      'signup',
    );
  });

  it('does not enroll or record consent when no pending opt-in exists', async () => {
    mockUser();

    const res = resMock();
    await verifyEmailOTP(
      { body: { email: 'buyer@example.com', otp: '123456' } } as any,
      res,
      vi.fn(),
    );

    const update = userFindOneAndUpdate.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.marketingConsentAt).toBeUndefined();
    expect(update.$set['notificationPreferences.promotions.email']).toBeUndefined();
    expect(enablePromotionalEmail).not.toHaveBeenCalled();
  });

  it('fails without verifying when the email or code changed after the check', async () => {
    // A signup email change replaced the address and code between the read
    // and the write: the conditional update matches nothing.
    mockUser({ marketingOptInPending: true });
    userFindOneAndUpdate.mockResolvedValue(null);

    const res = resMock();
    await verifyEmailOTP(
      { body: { email: 'buyer@example.com', otp: '123456' } } as any,
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(enablePromotionalEmail).not.toHaveBeenCalled();
  });
});
