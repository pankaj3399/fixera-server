/**
 * In-process fake of the Azure Translator v3 /translate endpoint for unit
 * tests (installed as globalThis.fetch). It "translates" every HTML text node
 * to `<to>:<text>` and, like Azure, leaves markup, attribute values and the
 * contents of translate="no" elements untouched.
 */
import { vi } from 'vitest';

export type FakeMode = 'faithful' | 'drop-span' | 'mangle-tag';

export function fakeTranslateHtml(html: string, to: string, mode: FakeMode = 'faithful'): string {
  const parts = html.split(/(<[^>]*>)/);
  let noTranslateDepth = 0;
  const out = parts.map((part, index) => {
    if (index % 2 === 1) {
      if (/^<span\b[^>]*translate="no"/i.test(part)) {
        noTranslateDepth += 1;
        return mode === 'drop-span' ? '' : part;
      }
      if (/^<\/span>/i.test(part) && noTranslateDepth > 0) {
        noTranslateDepth -= 1;
        return mode === 'drop-span' ? '' : part;
      }
      return part;
    }
    if (noTranslateDepth > 0) {
      if (mode === 'drop-span') return ''; // span AND its token lost
      return mode === 'mangle-tag' ? part.replace(/__FXMT(\d+)__/g, '__FXMT9$1__') : part;
    }
    if (!part.trim()) return part;
    return `${to}:${part}`;
  });
  return out.join('');
}

export function installFakeAzure(mode: FakeMode = 'faithful') {
  const calls: Array<{ from: string; to: string; textType: string; texts: string[] }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    const to = url.searchParams.get('to') || '';
    const from = url.searchParams.get('from') || '';
    const textType = url.searchParams.get('textType') || '';
    const texts = (JSON.parse(String(init?.body || '[]')) as Array<{ Text: string }>).map((e) => e.Text);
    calls.push({ from, to, textType, texts });
    const body = texts.map((text) => ({ translations: [{ to, text: fakeTranslateHtml(text, to, mode) }] }));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
