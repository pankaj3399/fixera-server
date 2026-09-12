import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindOne, userFindByIdAndUpdate, enablePromotionalEmail } = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  userFindByIdAndUpdate: vi.fn(),
  enablePromotionalEmail: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: {
    findOne: userFindOne,
    findByIdAndUpdate: userFindByIdAndUpdate,
  },
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
    userFindByIdAndUpdate.mockResolvedValue({ _id: 'user-1', email: 'buyer@example.com' });
  });

  it('activates and enrolls the opt-in only after OTP verification', async () => {
    mockUser({ marketingOptInPending: true });

    const res = resMock();
    await verifyEmailOTP(
      { body: { email: 'buyer@example.com', otp: '123456' } } as any,
      res,
      vi.fn(),
    );

    expect(userFindByIdAndUpdate).toHaveBeenCalledWith(
      'user-1',
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

    const update = userFindByIdAndUpdate.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.marketingConsentAt).toBeUndefined();
    expect(update.$set['notificationPreferences.promotions.email']).toBeUndefined();
    expect(enablePromotionalEmail).not.toHaveBeenCalled();
  });
});
