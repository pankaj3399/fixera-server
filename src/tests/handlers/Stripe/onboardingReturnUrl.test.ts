import { beforeEach, describe, expect, it, vi } from 'vitest';

// FT2 #7b: a professional returning from Stripe during onboarding must land on
// the onboarding Stripe step, not on step 1 or the dashboard. No Stripe call is
// made: the SDK and the User model are replaced by stubs.
const accountLinksCreate = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());

vi.mock('../../../services/stripe', () => ({
  stripe: { accountLinks: { create: accountLinksCreate } },
  STRIPE_CONFIG: { frontendUrl: 'https://app.example.test/' },
}));
vi.mock('../../../models/user', () => ({ default: { findById } }));

import {
  buildOnboardingReturnUrls,
  createOnboardingLink,
  isOnboardingStripeReturn,
} from '../../../handlers/Stripe/connectAccount';

const mockRes = () => {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};

const userDoc = (overrides: Record<string, unknown> = {}) => ({
  role: 'professional',
  professionalOnboardingCompletedAt: new Date('2026-01-01'),
  stripe: { accountId: 'acct_local_test' },
  save: vi.fn(async () => undefined),
  ...overrides,
});

describe('Stripe onboarding return URL (FT2 #7b)', () => {
  beforeEach(() => {
    accountLinksCreate.mockReset();
    findById.mockReset();
    accountLinksCreate.mockResolvedValue({ url: 'https://connect.example.test/x', expires_at: 1 });
  });

  it('carries the onboarding marker when the client return URL asks for it', async () => {
    findById.mockResolvedValue(userDoc());
    const res = mockRes();
    await createOnboardingLink(
      {
        user: { _id: 'u1' },
        body: {
          returnUrl: 'https://evil.example.test/professional/stripe/complete?source=onboarding',
          refreshUrl: 'https://evil.example.test/professional/stripe/refresh?source=onboarding',
        },
      } as any,
      res,
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const args = accountLinksCreate.mock.calls[0][0];
    // Host always comes from FRONTEND_URL, never from the client.
    expect(args.return_url).toBe('https://app.example.test/professional/stripe/complete?source=onboarding');
    expect(args.refresh_url).toBe('https://app.example.test/professional/stripe/refresh?source=onboarding');
  });

  it('resumes onboarding for a professional who has not finished it, even without a marker', async () => {
    findById.mockResolvedValue(userDoc({ professionalOnboardingCompletedAt: undefined }));
    await createOnboardingLink({ user: { _id: 'u1' }, body: {} } as any, mockRes());
    expect(accountLinksCreate.mock.calls[0][0].return_url).toBe(
      'https://app.example.test/professional/stripe/complete?source=onboarding',
    );
  });

  it('returns an onboarded professional to the plain complete page', async () => {
    findById.mockResolvedValue(userDoc());
    await createOnboardingLink({ user: { _id: 'u1' }, body: {} } as any, mockRes());
    expect(accountLinksCreate.mock.calls[0][0].return_url).toBe('https://app.example.test/professional/stripe/complete');
  });

  it('ignores malformed or oversized client URLs', () => {
    const done = { role: 'professional', professionalOnboardingCompletedAt: new Date() };
    expect(isOnboardingStripeReturn({ returnUrl: 'x'.repeat(5000) + '?source=onboarding' }, done)).toBe(false);
    expect(isOnboardingStripeReturn({ returnUrl: 42 }, done)).toBe(false);
    expect(isOnboardingStripeReturn(null, done)).toBe(false);
    expect(isOnboardingStripeReturn({ source: 'onboarding' }, done)).toBe(true);
    expect(buildOnboardingReturnUrls('https://a.test//', false).returnUrl).toBe('https://a.test/professional/stripe/complete');
  });
});
