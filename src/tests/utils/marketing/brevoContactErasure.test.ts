import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteContact = vi.hoisted(() => vi.fn());
vi.mock('@getbrevo/brevo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@getbrevo/brevo')>();
  class ContactsApi {
    setApiKey() {}
    deleteContact = deleteContact;
  }
  return { ...actual, ContactsApi };
});

import { deleteBrevoMarketingContact } from '../../../utils/marketing/brevoMarketing';

describe('deleteBrevoMarketingContact (GDPR erasure, SDK mocked)', () => {
  beforeEach(() => {
    deleteContact.mockReset();
    vi.stubEnv('BREVO_API_KEY', 'unit-test-not-a-key');
    vi.stubEnv('MARKETING_CAMPAIGN_DRY_RUN', 'false');
    vi.stubEnv('EMAIL_DEV_NO_SEND', 'false');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does nothing when Brevo is not configured or in dry-run', async () => {
    vi.stubEnv('MARKETING_CAMPAIGN_DRY_RUN', 'true');
    expect(await deleteBrevoMarketingContact('a@x.test')).toBe('not_configured');
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it('deletes the normalized contact, and treats a missing contact as removed', async () => {
    deleteContact.mockResolvedValueOnce({});
    expect(await deleteBrevoMarketingContact(' A@X.test ')).toBe('removed');
    expect(deleteContact).toHaveBeenCalledWith('a@x.test');
    deleteContact.mockRejectedValueOnce({ response: { status: 404 }, statusCode: 404, status: 404 });
    expect(await deleteBrevoMarketingContact('gone@x.test')).toBe('removed');
  });

  it('throws a sanitized error on other provider failures', async () => {
    deleteContact.mockRejectedValueOnce({ status: 500, message: 'api-key xkeysib-SECRET rejected' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(deleteBrevoMarketingContact('a@x.test')).rejects.toThrow('Brevo contact deletion failed');
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(logged).not.toContain('a@x.test');
  });
});
