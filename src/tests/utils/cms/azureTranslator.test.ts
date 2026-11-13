import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHARS_PER_REQUEST,
  MAX_RETRIES,
  MIN_REQUEST_TIMEOUT_MS,
  TranslatorError,
  TranslatorNotConfiguredError,
  isTranslatorConfigured,
  splitHtmlIntoChunks,
  translateTexts,
  translatorTiming,
} from '../../../utils/cms/azureTranslator';

const ENV_KEYS = [
  'AZURE_TRANSLATOR_KEY',
  'AZURE_TRANSLATOR_REGION',
  'AZURE_TRANSLATOR_ENDPOINT',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

const fetchMock = vi.fn();
const realTiming = { ...translatorTiming };
let sleeps: number[] = [];
let clock = 0;

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: false,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function okResponse(texts: string[], to: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(texts.map((text) => ({ translations: [{ text: `[${to}] ${text}`, to }] }))),
  };
}

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
  // Never really wait: record the requested sleeps and advance a fake clock.
  sleeps = [];
  clock = 1_000_000;
  translatorTiming.now = () => clock;
  translatorTiming.sleep = async (ms: number) => {
    sleeps.push(ms);
    clock += ms;
  };
});

afterEach(() => {
  translatorTiming.now = realTiming.now;
  translatorTiming.sleep = realTiming.sleep;
  translatorTiming.timeoutSignal = realTiming.timeoutSignal;
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

  it('surfaces 429 rate-limit failures as rate_limited after bounded retries', async () => {
    fetchMock.mockImplementation(async () =>
      errorResponse(429, { error: { code: 429001, message: 'Rate limit exceeded' } })
    );

    const err = await translateTexts(['Hello'], { from: 'en', to: 'fr', html: false }).catch((e) => e);

    expect(err).toBeInstanceOf(TranslatorError);
    expect(err.message).toMatch(/HTTP status 429.*Rate limit exceeded/s);
    expect(err.code).toBe('rate_limited');
    expect(err.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    // No Retry-After: the fixed backoff schedule.
    expect(sleeps).toEqual([2_000, 6_000, 15_000]);
  });

  it('honours Retry-After (seconds) and succeeds on a later attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, { error: { code: 429001, message: 'slow down' } }, { 'Retry-After': '7' }))
      .mockResolvedValueOnce(errorResponse(503, 'upstream unavailable'))
      .mockImplementation(async (url: string, init: any) =>
        okResponse(
          (JSON.parse(init.body) as Array<{ Text: string }>).map((item) => item.Text),
          new URL(url).searchParams.get('to') ?? ''
        )
      );

    await expect(translateTexts(['Hello'], { from: 'en', to: 'nl', html: false })).resolves.toEqual([
      '[nl] Hello',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 7s from Retry-After, then the second backoff step for the 503.
    expect(sleeps).toEqual([7_000, 6_000]);
  });

  it('caps a long Retry-After at 30 seconds', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, {}, { 'retry-after': '3600' }))
      .mockImplementation(async (url: string, init: any) =>
        okResponse(
          (JSON.parse(init.body) as Array<{ Text: string }>).map((item) => item.Text),
          new URL(url).searchParams.get('to') ?? ''
        )
      );

    await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false });
    expect(sleeps).toEqual([30_000]);
  });

  it('retries network errors and timeouts, then reports timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));

    const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false }).catch((e) => e);

    expect(err.code).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(err.message).not.toContain('test-key');
  });

  it('retries 5xx as provider_error but never retries auth or quota failures', async () => {
    fetchMock.mockResolvedValue(errorResponse(502, 'bad gateway'));
    const fiveXX = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false }).catch((e) => e);
    expect(fiveXX.code).toBe('provider_error');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);

    for (const [status, code, expected] of [
      [401, 401000, 'auth'],
      [403, 403001, 'quota_exceeded'],
      [403, undefined, 'auth'],
      [400, 400036, 'provider_error'],
    ] as const) {
      fetchMock.mockReset();
      sleeps = [];
      fetchMock.mockResolvedValue(errorResponse(status, { error: { code, message: 'nope' } }));
      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false }).catch((e) => e);
      expect(err.code).toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('maps only Azure 403001 (free-tier quota) to quota_exceeded', async () => {
    for (const code of [403001, '403001']) {
      fetchMock.mockReset();
      sleeps = [];
      fetchMock.mockResolvedValue(
        errorResponse(403, { error: { code, message: 'The free tier quota has been exceeded.' } })
      );
      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false }).catch((e) => e);
      expect(err).toBeInstanceOf(TranslatorError);
      expect(err.code).toBe('quota_exceeded');
      expect(err.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('maps every other 403 to auth, even when the Azure code starts with 403', async () => {
    for (const code of [403000, 403002, '403013', 'Forbidden', undefined]) {
      fetchMock.mockReset();
      sleeps = [];
      fetchMock.mockResolvedValue(errorResponse(403, { error: { code, message: 'forbidden' } }));
      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false }).catch((e) => e);
      expect(err).toBeInstanceOf(TranslatorError);
      expect(err.code).toBe('auth');
      expect(err.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }

    // A 403 with a non-JSON body (no Azure code at all) is also auth.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });
    const plain = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false }).catch((e) => e);
    expect(plain.code).toBe('auth');
  });

  describe('per-attempt timeout under a deadline', () => {
    let attemptTimeouts: number[] = [];
    let current: { controller: AbortController; ms: number } | undefined;

    // Record each attempt's timeout and hand out a signal the test controls.
    const useFakeTimeouts = () => {
      attemptTimeouts = [];
      translatorTiming.timeoutSignal = (ms: number) => {
        attemptTimeouts.push(ms);
        current = { controller: new AbortController(), ms };
        return current.controller.signal;
      };
    };
    // A request that never answers: its timeout elapses on the fake clock.
    const hang = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
      const attempt = current!;
      clock += attempt.ms;
      attempt.controller.abort(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    });
    const hangUntilAborted = () => fetchMock.mockImplementation((_url: string, init: any) => hang(init.signal));

    it('caps the attempt at the budget left, and keeps the full timeout otherwise', async () => {
      useFakeTimeouts();
      mockTranslation();

      await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false });
      await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false, deadline: clock + 60_000 });
      await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false, deadline: clock + 3_000 });

      expect(attemptTimeouts).toEqual([25_000, 25_000, 3_000]);
    });

    it('reports an attempt cut off by the deadline as budget_exceeded, ending at the deadline', async () => {
      useFakeTimeouts();
      hangUntilAborted();
      const deadline = clock + 3_000;

      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false, deadline }).catch((e) => e);

      expect(err.code).toBe('budget_exceeded');
      expect(err.message).not.toContain('test-key');
      expect(attemptTimeouts).toEqual([3_000]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect(clock).toBe(deadline);
    });

    it('keeps a full-length attempt timeout a retryable timeout', async () => {
      useFakeTimeouts();
      hangUntilAborted();

      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false, deadline: clock + 600_000 })
        .catch((e) => e);

      expect(err.code).toBe('timeout');
      expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    });

    it('caps a retry at the budget left after the backoff', async () => {
      useFakeTimeouts();
      hangUntilAborted();
      fetchMock.mockResolvedValueOnce(errorResponse(503, 'unavailable'));
      const deadline = clock + 10_000;

      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false, deadline }).catch((e) => e);

      expect(err.code).toBe('budget_exceeded');
      expect(sleeps).toEqual([2_000]);
      expect(attemptTimeouts).toEqual([10_000, 8_000]);
      expect(clock).toBe(deadline);
    });

    it('treats an abort while reading the body as the same timeout', async () => {
      useFakeTimeouts();
      fetchMock.mockImplementation(async (_url: string, init: any) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => hang(init.signal),
      }));

      const err = await translateTexts(['Hello'], { from: 'en', to: 'nl', html: false, deadline: clock + 2_000 })
        .catch((e) => e);

      expect(err.code).toBe('budget_exceeded');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends no request when less than the minimum attempt time is left', async () => {
      useFakeTimeouts();
      mockTranslation();

      const err = await translateTexts(['Hello'], {
        from: 'en', to: 'nl', html: false, deadline: clock + MIN_REQUEST_TIMEOUT_MS - 1,
      }).catch((e) => e);

      expect(err.code).toBe('budget_exceeded');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('does not wait past the deadline: a retry that would overrun fails fast', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'unavailable'));
    const err = await translateTexts(['Hello'], {
      from: 'en',
      to: 'nl',
      html: false,
      deadline: clock + 5_000, // first backoff (2s) fits, the second (6s) does not
    }).catch((e) => e);

    expect(err.code).toBe('budget_exceeded');
    expect(err.message).toContain('no time left to retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);

    // A rate limit that cannot be waited out stays a rate_limited failure.
    fetchMock.mockReset();
    sleeps = [];
    fetchMock.mockResolvedValue(errorResponse(429, {}, { 'Retry-After': '20' }));
    const limited = await translateTexts(['Hello'], {
      from: 'en',
      to: 'nl',
      html: false,
      deadline: clock + 10_000,
    }).catch((e) => e);
    expect(limited.code).toBe('rate_limited');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts no request once the deadline has passed', async () => {
    mockTranslation();
    const err = await translateTexts(['Hello'], {
      from: 'en',
      to: 'nl',
      html: false,
      deadline: clock - 1,
    }).catch((e) => e);
    expect(err.code).toBe('budget_exceeded');
    expect(fetchMock).not.toHaveBeenCalled();
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
