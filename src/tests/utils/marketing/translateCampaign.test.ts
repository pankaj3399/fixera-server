import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  CampaignTranslationInputError,
  parseCampaignTranslationRequest,
  translateCampaignDraft,
} from '../../../utils/marketing/translateCampaign';
import { autoTranslateMarketingCampaign } from '../../../handlers/Admin/marketingCampaigns';
import { installFakeAzure } from '../translation/fakeAzure';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res as Response & { statusCode: number; body: any };
}

const draft = {
  subject: 'Spring deals for {{firstName}}',
  previewText: 'Save now',
  htmlContent:
    '<h1>Hi {{ contact.FIRSTNAME }}</h1><p>Book before May. <a href="https://fixtract.test/x?c={{ params.CODE }}">Book</a></p>',
};

describe('parseCampaignTranslationRequest', () => {
  it('accepts a valid request and dedupes targets', () => {
    const parsed = parseCampaignTranslationRequest({
      sourceLocale: 'EN',
      targetLocales: ['nl', 'fr', 'nl'],
      content: draft,
    });
    expect(parsed.sourceLocale).toBe('en');
    expect(parsed.targetLocales).toEqual(['nl', 'fr']);
  });

  it.each([
    [{ sourceLocale: 'xx', targetLocales: ['nl'], content: draft }, 'supported source'],
    [{ sourceLocale: 'en', targetLocales: [], content: draft }, 'at least one'],
    [{ sourceLocale: 'en', targetLocales: ['en'], content: draft }, 'cannot also be a target'],
    [{ sourceLocale: 'en', targetLocales: ['es'], content: draft }, 'unsupported'],
    [{ sourceLocale: 'en', targetLocales: ['nl'], content: { ...draft, subject: '' } }, 'subject'],
    [{ sourceLocale: 'en', targetLocales: ['nl'], content: { ...draft, htmlContent: '<p></p>' } }, 'body content'],
  ])('rejects invalid input %#', (body, message) => {
    expect(() => parseCampaignTranslationRequest(body)).toThrow(CampaignTranslationInputError);
    expect(() => parseCampaignTranslationRequest(body)).toThrow(new RegExp(message));
  });
});

describe('translateCampaignDraft / auto-translate endpoint (fake Azure)', () => {
  beforeEach(() => {
    vi.stubEnv('AZURE_TRANSLATOR_KEY', 'unit-test-key-not-a-secret');
    vi.stubEnv('AZURE_TRANSLATOR_ENDPOINT', 'https://translator.fake.test');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('fills every target language and keeps merge tags (incl. {{firstName}}) intact', async () => {
    const { calls } = installFakeAzure();
    const outcomes = await translateCampaignDraft({
      sourceLocale: 'en',
      targetLocales: ['nl', 'de'],
      content: draft,
    });
    expect(outcomes.map((o) => [o.locale, o.status])).toEqual([
      ['nl', 'translated'],
      ['de', 'translated'],
    ]);
    const nl = outcomes[0] as Extract<(typeof outcomes)[number], { status: 'translated' }>;
    expect(nl.content.subject).toContain('{{firstName}}');
    expect(nl.content.subject).toContain('nl:Spring deals for');
    expect(nl.content.htmlContent).toContain('<h1>nl:Hi {{ contact.FIRSTNAME }}</h1>');
    expect(nl.content.htmlContent).toContain('href="https://fixtract.test/x?c={{ params.CODE }}"');
    expect(nl.content.previewText).toBe('nl:Save now');
    expect(calls.map((c) => c.to)).toEqual(['nl', 'de']);
    expect(calls.every((c) => c.from === 'en')).toBe(true);
  });

  it('reports a per-locale failure instead of returning a broken merge tag', async () => {
    installFakeAzure('mangle-tag');
    const outcomes = await translateCampaignDraft({ sourceLocale: 'en', targetLocales: ['fr'], content: draft });
    expect(outcomes).toEqual([
      expect.objectContaining({ locale: 'fr', status: 'failed', errorCode: 'placeholder_lost' }),
    ]);
  });

  it('endpoint returns translations and never touches campaign storage', async () => {
    installFakeAzure();
    const res = mockRes();
    await autoTranslateMarketingCampaign(
      { body: { sourceLocale: 'en', targetLocales: ['fr'], content: draft } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.translations[0]).toMatchObject({ locale: 'fr', status: 'translated' });
  });

  it('endpoint answers 409 when no translator key is configured', async () => {
    vi.stubEnv('AZURE_TRANSLATOR_KEY', '');
    const { fetchMock } = installFakeAzure();
    const res = mockRes();
    await autoTranslateMarketingCampaign(
      { body: { sourceLocale: 'en', targetLocales: ['fr'], content: draft } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('endpoint answers 400 for invalid input', async () => {
    installFakeAzure();
    const res = mockRes();
    await autoTranslateMarketingCampaign({ body: { sourceLocale: 'en', targetLocales: [] } } as unknown as Request, res);
    expect(res.statusCode).toBe(400);
  });
});
