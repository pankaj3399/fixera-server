import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHARS_PER_REQUEST,
  TranslatorNotConfiguredError,
  isTranslatorConfigured,
  splitHtmlIntoChunks,
  translateTexts,
} from '../../../utils/cms/azureTranslator';

const ENV_KEYS = [
  'AZURE_TRANSLATOR_KEY',
  'AZURE_TRANSLATOR_REGION',
  'AZURE_TRANSLATOR_ENDPOINT',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

const fetchMock = vi.fn();

function clearTranslatorEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function mockTranslation(mapper: (text: string, to: string) => string = (text) => text) {
  fetchMock.mockImplementation(async (url: string, init: any) => {
    const to = new URL(url).searchParams.get('to') ?? '';
    const payload = JSON.parse(init.body) as Array<{ Text: string }>;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          payload.map((item) => ({ translations: [{ text: mapper(item.Text, to), to }] }))
        ),
    };
  });
}

function requestBodies() {
  return fetchMock.mock.calls.map(([, init]: [string, any]) => JSON.parse(init.body) as Array<{ Text: string }>);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearTranslatorEnv();
  process.env.AZURE_TRANSLATOR_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearTranslatorEnv();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] !== undefined) process.env[key] = originalEnv[key];
  }
});

describe('Azure translator client', () => {
  it('is configured only when the key is set', () => {
    expect(isTranslatorConfigured()).toBe(true);
    delete process.env.AZURE_TRANSLATOR_KEY;
    expect(isTranslatorConfigured()).toBe(false);
  });

  it('sends the documented URL, query params, headers and body', async () => {
    mockTranslation((text) => `nl:${text}`);

    const result = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false });

    expect(result).toEqual(['nl:Hello']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, any];
    const url = new URL(rawUrl);
    expect(url.origin + url.pathname).toBe('https://api.cognitive.microsofttranslator.com/translate');
    expect(url.searchParams.get('api-version')).toBe('3.0');
    expect(url.searchParams.get('from')).toBe('en');
    expect(url.searchParams.get('to')).toBe('nl');
    expect(url.searchParams.get('textType')).toBe('plain');

    expect(init.method).toBe('POST');
    expect(init.headers['Ocp-Apim-Subscription-Key']).toBe('test-key');
    expect(init.headers['Ocp-Apim-Subscription-Region']).toBeUndefined();
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual([{ Text: 'Hello' }]);
    expect(init.signal).toBeDefined();
  });

  it('sends textType=html for HTML bodies', async () => {
    mockTranslation();
    await translateTexts(['<p>Hi</p>'], { from: 'en', to: 'fr', html: true });

    const [rawUrl] = fetchMock.mock.calls[0] as [string];
    expect(new URL(rawUrl).searchParams.get('textType')).toBe('html');
  });

  it('sends the region header only when set and not "global"', async () => {
    mockTranslation();

    process.env.AZURE_TRANSLATOR_REGION = 'westeurope';
    await translateTexts(['a'], { from: 'en', to: 'nl', html: false });
    expect((fetchMock.mock.calls[0] as [string, any])[1].headers['Ocp-Apim-Subscription-Region']).toBe(
      'westeurope'
    );

    fetchMock.mockClear();
    process.env.AZURE_TRANSLATOR_REGION = 'global';
    await translateTexts(['a'], { from: 'en', to: 'nl', html: false });
    expect(
      (fetchMock.mock.calls[0] as [string, any])[1].headers['Ocp-Apim-Subscription-Region']
    ).toBeUndefined();
  });

  it('honours AZURE_TRANSLATOR_ENDPOINT', async () => {
    process.env.AZURE_TRANSLATOR_ENDPOINT = 'https://translator.example.test/';
    mockTranslation();

    await translateTexts(['a'], { from: 'en', to: 'nl', html: false });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^https:\/\/translator\.example\.test\/translate\?/
    );
  });

  it('maps results back by index and skips empty values', async () => {
    mockTranslation((text) => `T(${text})`);

    const result = await translateTexts(['One', '   ', '', 'Two'], {
      from: 'en',
      to: 'nl',
      html: false,
    });

    expect(result).toEqual(['T(One)', '', '', 'T(Two)']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBodies()[0]).toEqual([{ Text: 'One' }, { Text: 'Two' }]);
  });

  it('packs plain fields into requests that stay under the character cap', async () => {
    mockTranslation();

    const texts = ['a'.repeat(20_000), 'b'.repeat(20_000), 'c'.repeat(20_000)];
    const result = await translateTexts(texts, { from: 'en', to: 'fr', html: false });

    expect(result).toEqual(texts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const body of requestBodies()) {
      const chars = body.reduce((sum, item) => sum + item.Text.length, 0);
      expect(chars).toBeLessThanOrEqual(MAX_CHARS_PER_REQUEST);
      expect(body.length).toBeLessThanOrEqual(1_000);
    }
  });

  it('splits oversized HTML at block boundaries and re-joins in order', async () => {
    mockTranslation();

    const block = `<p>${'x'.repeat(1990)}</p>`; // 2000 chars per block
    const html = block.repeat(30); // 60,000 chars, above the 45k request cap
    expect(html.length).toBeGreaterThan(MAX_CHARS_PER_REQUEST);

    const [translated] = await translateTexts([html], { from: 'en', to: 'nl', html: true });

    expect(translated).toBe(html);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const elements = requestBodies().flat().map((item) => item.Text);
    expect(elements.length).toBeGreaterThan(1);
    for (const element of elements) {
      expect(element.length).toBeLessThanOrEqual(MAX_CHARS_PER_REQUEST);
      expect(element.endsWith('</p>')).toBe(true);
    }
    for (const body of requestBodies()) {
      const chars = body.reduce((sum, item) => sum + item.Text.length, 0);
      expect(chars).toBeLessThanOrEqual(MAX_CHARS_PER_REQUEST);
    }
  });

  it('surfaces HTTP status plus the Azure error message without leaking the key', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: { code: 403001, message: 'The subscription quota has been exceeded.' },
        }),
    });

    let message = '';
    try {
      await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false });
    } catch (err: any) {
      message = err.message;
    }
    expect(message).toContain('HTTP status 403');
    expect(message).toContain('403001');
    expect(message).toContain('quota');
    expect(message).not.toContain('test-key');
  });

  it('surfaces 429 rate-limit failures as errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { code: 429001, message: 'Rate limit exceeded' } }),
    });

    await expect(translateTexts(['Hello'], { from: 'en', to: 'fr', html: false })).rejects.toThrow(
      /HTTP status 429.*Rate limit exceeded/s
    );
  });

  it('throws when the provider is not configured', async () => {
    delete process.env.AZURE_TRANSLATOR_KEY;
    await expect(
      translateTexts(['Hello'], { from: 'en', to: 'nl', html: false })
    ).rejects.toBeInstanceOf(TranslatorNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported locales before calling the provider', async () => {
    await expect(
      translateTexts(['Hello'], { from: 'de', to: 'nl', html: false })
    ).rejects.toThrow(/Unsupported translation language "de"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('splitHtmlIntoChunks', () => {
  it('never splits inside a tag and chunks concatenate back to the input', () => {
    const block = `<p>${'a'.repeat(56)}</p>`; // 60 chars
    const html = block.repeat(4);

    const chunks = splitHtmlIntoChunks(html, 100);

    expect(chunks.join('')).toBe(html);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.endsWith('</p>')).toBe(true);
    }
  });

  it('returns the input untouched when it already fits', () => {
    const html = '<p>short</p>';
    expect(splitHtmlIntoChunks(html, 100)).toEqual([html]);
  });
});
