import { beforeEach, describe, expect, it, vi } from 'vitest';

const brevo = vi.hoisted(() => ({ send: vi.fn(async () => ({})) }));

vi.hoisted(() => {
  process.env.EMAIL_DEV_NO_SEND = 'false';
  process.env.BREVO_API_KEY = 'xkeysib-test-not-real';
  process.env.NODE_ENV = 'production';
});

vi.mock('@getbrevo/brevo', () => ({
  TransactionalEmailsApi: class {
    setApiKey() {}
    sendTransacEmail = brevo.send;
  },
  SendSmtpEmail: class {},
  TransactionalEmailsApiApiKeys: { apiKey: 0 },
}));
vi.mock('../../../utils/emailLogger', () => ({ logEmail: vi.fn(async () => undefined) }));

import { NOTIFICATION_REGISTRY } from '../../../utils/notifications/registry';

const baseCtx = {
  bookingId: '507f1f77bcf86cd799439015',
  oldDate: '2026-12-01T09:00:00.000Z',
  newDate: '2026-12-08T09:00:00.000Z',
  reason: 'Material delivery delayed',
};

const sentHtml = () => (brevo.send.mock.calls.at(-1) as any)[0].htmlContent as string;

describe('reschedule request emails', () => {
  beforeEach(() => brevo.send.mockClear());

  it.each([
    ['customer.reschedule_requested', { professionalName: 'Piet Works' }],
    ['professional.reschedule_requested', { customerName: 'Carla' }],
  ])('%s shows old/new start, reason and the optional description', async (eventKey, names) => {
    const built = NOTIFICATION_REGISTRY[eventKey].build({
      ...baseCtx,
      ...names,
      description: 'Supplier moved delivery <b>one week</b>.\nSame crew.',
    });
    await built.sendEmail!({ email: 'party@example.com', name: 'Party' });
    const html = sentHtml();
    expect(html).toContain('Original Start:');
    expect(html).toContain('Proposed Start:');
    expect(html).toContain('Material delivery delayed');
    expect(html).toContain('<strong>Details:</strong> Supplier moved delivery &lt;b&gt;one week&lt;&#x2F;b&gt;.');
    expect(html).not.toContain('<b>one week</b>');
  });

  it('omits the details row when no description was given', async () => {
    const built = NOTIFICATION_REGISTRY['customer.reschedule_requested'].build({ ...baseCtx, professionalName: 'Piet' });
    await built.sendEmail!({ email: 'party@example.com', name: 'Party' });
    expect(sentHtml()).not.toContain('Details:');
    expect(sentHtml()).toContain('Material delivery delayed');
  });
});
