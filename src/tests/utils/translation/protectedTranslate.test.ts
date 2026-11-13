import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractMergeTags,
  PlaceholderLostError,
  protectHtml,
  protectPlain,
  restoreTokens,
  translateProtectedFields,
} from '../../../utils/translation/protectedTranslate';
import { installFakeAzure } from './fakeAzure';

describe('merge tag protection', () => {
  it('wraps merge tags in text nodes with translate="no" tokens and restores them', () => {
    const html = '<p>Hi {{firstName}}, use {{ contact.FIRSTNAME }} and *|FNAME|* {% if x %}ok{% endif %}</p>';
    const protectedText = protectHtml(html);
    expect(protectedText.tokens).toEqual([
      '{{firstName}}',
      '{{ contact.FIRSTNAME }}',
      '*|FNAME|*',
      '{% if x %}',
      '{% endif %}',
    ]);
    expect(protectedText.html).not.toContain('{{');
    expect(protectedText.html).toContain('<span translate="no" class="notranslate">__FXMT0__</span>');
    expect(restoreTokens(protectedText.html, protectedText.tokens)).toBe(html);
  });

  it('never rewrites merge tags inside HTML attributes', () => {
    const html = '<a href="https://x.test/u?t={{ contact.UNSUB_TOKEN }}">Unsubscribe {{firstName}}</a>';
    const protectedText = protectHtml(html);
    expect(protectedText.tokens).toEqual(['{{firstName}}']);
    expect(protectedText.html).toContain('href="https://x.test/u?t={{ contact.UNSUB_TOKEN }}"');
  });

  it('protects caller literals such as a discount code in plain text', () => {
    const protectedText = protectPlain('Use SPRING10 & save <now>', ['SPRING10']);
    expect(protectedText.tokens).toEqual(['SPRING10']);
    expect(protectedText.html).toContain('&amp; save &lt;now&gt;');
  });

  it('throws when a token is lost or duplicated', () => {
    const { html, tokens } = protectHtml('<p>Hi {{firstName}}</p>');
    expect(() => restoreTokens(html.replace(/<span[^>]*>__FXMT0__<\/span>/, ''), tokens)).toThrow(PlaceholderLostError);
    expect(() => restoreTokens(`${html}${html}`, tokens)).toThrow(PlaceholderLostError);
  });

  it('extracts merge tags as a sorted multiset', () => {
    expect(extractMergeTags('{{b}} x {{a}} {{b}}')).toEqual(['{{a}}', '{{b}}', '{{b}}']);
  });
});

describe('translateProtectedFields (fake Azure)', () => {
  beforeEach(() => {
    vi.stubEnv('AZURE_TRANSLATOR_KEY', 'unit-test-key-not-a-secret');
    vi.stubEnv('AZURE_TRANSLATOR_ENDPOINT', 'https://translator.fake.test');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('translates text but keeps {{firstName}} and other merge tags byte-identical', async () => {
    const { calls } = installFakeAzure();
    const [subject, body] = await translateProtectedFields(
      [
        { text: 'Hello {{firstName}} & welcome', kind: 'plain' },
        { text: '<p>Dear {{ contact.FIRSTNAME }},</p><p><a href="/u?t={{ contact.UNSUB_TOKEN }}">Stop</a></p>', kind: 'html' },
      ],
      { from: 'en', to: 'nl', languages: ['en', 'nl', 'fr', 'de'] },
    );
    expect(subject).toBe('nl:Hello {{firstName}}nl: & welcome');
    expect(body).toContain('{{ contact.FIRSTNAME }}');
    expect(body).toContain('href="/u?t={{ contact.UNSUB_TOKEN }}"');
    expect(body).toContain('nl:Stop');
    // Nothing that looks like a merge tag was sent to the provider as translatable text.
    expect(calls[0].textType).toBe('html');
    expect(calls[0].texts[0]).not.toContain('{{firstName}}');
  });

  it('fails with placeholder_lost when the provider mangles a protected token', async () => {
    installFakeAzure('mangle-tag');
    await expect(
      translateProtectedFields([{ text: 'Hi {{firstName}}', kind: 'plain' }], { from: 'en', to: 'fr' }),
    ).rejects.toBeInstanceOf(PlaceholderLostError);
  });

  it('fails with placeholder_lost when the provider drops the protecting span and the token', async () => {
    installFakeAzure('drop-span');
    await expect(
      translateProtectedFields([{ text: '<p>Hi {{firstName}}</p>', kind: 'html' }], { from: 'en', to: 'fr' }),
    ).rejects.toBeInstanceOf(PlaceholderLostError);
  });

  it('returns empty strings for empty fields without failing', async () => {
    installFakeAzure();
    const out = await translateProtectedFields(
      [
        { text: '', kind: 'plain' },
        { text: 'Go', kind: 'plain' },
      ],
      { from: 'en', to: 'fr' },
    );
    expect(out).toEqual(['', 'fr:Go']);
  });
});
