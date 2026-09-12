import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindOne, userCreate } = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  userCreate: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: {
    findOne: userFindOne,
    create: userCreate,
  },
}));

vi.mock('bcrypt', () => ({
  default: { hash: vi.fn().mockResolvedValue('hashed-password') },
}));

vi.mock('../../../utils/emailService', () => ({
  generateOTP: vi.fn(() => '123456'),
  sendOTPEmail: vi.fn().mockResolvedValue(true),
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
  sendIdExpiredEmail: vi.fn(),
}));

vi.mock('../../../utils/referralSystem', () => ({
  generateReferralCode: vi.fn().mockResolvedValue('FIX-ABC123'),
  validateReferralCode: vi.fn(),
  createReferral: vi.fn(),
}));

vi.mock('../../../utils/functions', () => ({
  default: vi.fn(() => 'jwt-token'),
}));

vi.mock('../../../utils/bookingBlocks', () => ({
  buildBookingBlockedRanges: vi.fn().mockResolvedValue([]),
}));

vi.mock('twilio', () => ({
  default: vi.fn(() => ({
    verify: { v2: { services: () => ({ verifications: { create: vi.fn().mockResolvedValue({}) } }) } },
  })),
}));

import { SignUp } from '../../../handlers/Auth';

function resMock() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  return res as any;
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test User',
    password: 'secret123',
    email: 'test@example.com',
    phone: '+32470123456',
    role: 'customer',
    ...overrides,
  };
}

describe('SignUp marketing opt-in persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindOne.mockResolvedValue(null);
    userCreate.mockResolvedValue({
      _id: 'user-1',
      name: 'Test User',
      email: 'test@example.com',
      phone: '+32470123456',
      role: 'customer',
      isEmailVerified: false,
      isPhoneVerified: false,
      save: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('persists marketingOptInPending on the created user document', async () => {
    const res = resMock();
    await SignUp({ body: baseBody({ marketingOptIn: true }) } as any, res, vi.fn());

    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ marketingOptInPending: true }),
    );
  });

  it('does not set the pending flag when the opt-in is unchecked', async () => {
    const res = resMock();
    await SignUp({ body: baseBody() } as any, res, vi.fn());

    const payload = userCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.marketingOptInPending).toBeUndefined();
  });
});
