/**
 * Translate webapp to Dutch & French #2: "Auto-translate created content in CMS".
 *
 * End-to-end against the real admin + public routers and REAL MongoDB
 * persistence, with the Azure Translator replaced by a LOCAL transport fixture:
 * a 127.0.0.1 HTTP server speaking the Translator v3 `/translate` wire format.
 * The production adapter (`utils/cms/azureTranslator.ts`) and its global fetch
 * are used unmodified; only AZURE_TRANSLATOR_ENDPOINT points at the fixture.
 * No request leaves the machine (tests/setup/providerIsolation blocks it) and
 * this is NOT evidence of a live Azure pass.
 *
 * The only module mock is the S3 delete boundary, recorded instead of sent.
 *
 * Run only with FIXERA_TEST_MONGODB_URI (disposable local DB); skipped otherwise.
 */
import cookieParser from 'cookie-parser';
import express from 'express';
import http, { type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri ? describe : describe.skip;

const FIXTURE_KEY = 'local-fixture-translator-key-not-a-secret';
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cms-auto-translate-test-secret';
  process.env.S3_BUCKET_NAME = 'fixera-test-bucket';
  process.env.AZURE_TRANSLATOR_KEY = '';
  process.env.AZURE_TRANSLATOR_REGION = 'westeurope';
});

const s3Deletes = vi.hoisted(() => [] as string[]);
vi.mock('../../utils/s3Upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/s3Upload')>();
  return {
    ...actual,
    deleteFromS3: vi.fn(async (key: string) => {
      s3Deletes.push(key);
    }),
  };
});

import adminRouter from '../../routes/Admin';
import publicRouter from '../../routes/Public';
import CmsContent from '../../models/cmsContent';
import { settleCmsResponse, skipTranslatorBackoff } from './cmsTranslationSettle';
import User from '../../models/user';

const TAG = 'cmsautotr-it';
const cover = (name: string) => `https://fixera-test-bucket.s3.eu-west-1.amazonaws.com/cms/${TAG}-${name}.jpg`;

// ---------------------------------------------------------------- transport fixture
type FixtureRequest = {
  path: string;
  query: Record<string, string>;
  hasKey: boolean;
  region?: string;
  texts: string[];
};
const fixture = {
  requests: [] as FixtureRequest[],
  failLocales: new Set<string>(),
  authFail: false,
};

const translatorServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let texts: string[] = [];
    try {
      texts = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Array<{ Text: string }>).map((e) => e.Text);
    } catch {
      texts = [];
    }
    const query = Object.fromEntries(url.searchParams.entries());
    fixture.requests.push({
      path: url.pathname,
      query,
      hasKey: req.headers['ocp-apim-subscription-key'] === FIXTURE_KEY,
      region: req.headers['ocp-apim-subscription-region'] as string | undefined,
      texts,
    });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (fixture.authFail || req.headers['ocp-apim-subscription-key'] !== FIXTURE_KEY) {
      return send(401, { error: { code: 401000, message: 'The request is not authorized because credentials are missing or invalid.' } });
    }
    if (url.pathname !== '/translate' || query['api-version'] !== '3.0') return send(404, { error: { code: 404000, message: 'not found' } });
    if (fixture.failLocales.has(query.to)) {
      return send(500, { error: { code: 500000, message: 'An unexpected error occurred.' } });
    }
    const to = query.to;
    send(
      200,
      texts.map((text) => ({
        translations: [
          {
            to,
            // HTML stays tag-balanced: prefix the inner text of the first tag.
            text: query.textType === 'html' ? text.replace(/>([^<])/, `>[${to}] $1`) : `[${to}] ${text}`,
          },
        ],
      })),
    );
  });
});

// ---------------------------------------------------------------- app + auth
const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/public', publicRouter);
let apiServer: Server;
let api = '';

const cookieFor = (user: { _id: unknown }) =>
  `auth-token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
let superCookie = '';
let contentCookie = '';
let careCookie = '';
let customerCookie = '';

const call = async (
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${api}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  expect(text).not.toContain(FIXTURE_KEY); // the key never reaches a response
  // Async translation: wait for the background run and fold its outcome into
  // `translations` (immediate results stay on body.immediate).
  const body = await settleCmsResponse(text ? JSON.parse(text) : undefined);
  return { status: response.status, body };
};

const configureTranslator = (on: boolean) => {
  process.env.AZURE_TRANSLATOR_KEY = on ? FIXTURE_KEY : '';
};
const byLocale = (translations: Array<{ locale: string; status: string; error?: string }>) =>
  Object.fromEntries(translations.map((t) => [t.locale, t.status]));
const family = async (sourceId: unknown) =>
  CmsContent.find({ translatedFrom: sourceId }).sort({ locale: 1 }).lean();

let seq = 0;
const blog = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    type: 'blog',
    locale: 'en',
    title: `Heat pump guide ${seq}`,
    slug: `${TAG}-guide-${seq}`,
    body: '<h2>Why a heat pump</h2><p>Lower bills.</p>',
    excerpt: 'Short intro',
    coverImage: cover(`c${seq}`),
    coverImageAlt: 'Heat pump on a wall',
    tags: [TAG],
    status: 'draft',
    activeCountries: ['BE'],
    seo: { titleTag: 'Heat pumps', metaDescription: 'All about heat pumps', canonical: 'https://example.test/en/guide', noindex: false },
    ...over,
  };
};

describeDb('CMS auto-translation (real MongoDB, local translator transport fixture)', () => {
  beforeAll(async () => {
    skipTranslatorBackoff();
    await mongoose.connect(testUri!);
    await CmsContent.deleteMany({ $or: [{ tags: TAG }, { slug: new RegExp(`^${TAG}`) }] });
    await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
    const mk = (adminRole: string | undefined, role = 'admin') =>
      User.create({
        name: `${TAG} ${adminRole || role}`,
        email: `${adminRole || role}-${new Types.ObjectId().toHexString()}@${TAG}.example`,
        phone: `+3247${Math.floor(Math.random() * 1e7)}`,
        password: 'not-used-hash',
        role,
        ...(adminRole ? { adminRole } : {}),
        isEmailVerified: true,
        accountStatus: 'active',
      });
    superCookie = cookieFor(await mk('super'));
    contentCookie = cookieFor(await mk('content_creator'));
    careCookie = cookieFor(await mk('care'));
    customerCookie = cookieFor(await mk(undefined, 'customer'));

    await new Promise<void>((resolve) => translatorServer.listen(0, '127.0.0.1', resolve));
    const tAddr = translatorServer.address();
    if (!tAddr || typeof tAddr === 'string') throw new Error('fixture did not bind');
    process.env.AZURE_TRANSLATOR_ENDPOINT = `http://127.0.0.1:${tAddr.port}/`;

    apiServer = app.listen(0);
    await new Promise<void>((resolve) => apiServer.once('listening', resolve));
    const aAddr = apiServer.address();
    if (!aAddr || typeof aAddr === 'string') throw new Error('api did not bind');
    api = `http://127.0.0.1:${aAddr.port}`;
  });

  afterAll(async () => {
    configureTranslator(false);
    await new Promise<void>((resolve) => (apiServer ? apiServer.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => translatorServer.close(() => resolve()));
    if (mongoose.connection.readyState === 1) {
      await CmsContent.deleteMany({ $or: [{ tags: TAG }, { slug: new RegExp(`^${TAG}`) }] });
      await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
      await mongoose.disconnect();
    }
  });

  beforeEach(() => {
    fixture.requests.length = 0;
    fixture.failLocales.clear();
    fixture.authFail = false;
    s3Deletes.length = 0;
  });

  it('provider unconfigured: saves succeed, every target reports disabled, nothing is created or sent', async () => {
    configureTranslator(false);
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: blog({ status: 'published' }) });
    expect(created.status).toBe(201);
    expect(byLocale(created.body.translations)).toEqual({ nl: 'disabled', fr: 'disabled' });
    const id = created.body.data._id;
    expect(await CmsContent.countDocuments({ _id: id })).toBe(1);
    expect(await family(id)).toHaveLength(0);

    const retry = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: {} });
    expect(retry.status).toBe(200);
    expect(retry.body.success).toBe(true);
    // The status says the translator is off; nothing is pending or queued.
    expect(retry.body.data).toMatchObject({ enabled: false, sourceId: id, running: false, queued: false });
    expect(retry.body.data.locales.map((l: any) => [l.locale, l.state])).toEqual([
      ['en', 'source'],
      ['nl', 'missing'],
      ['fr', 'missing'],
    ]);
    expect(byLocale(retry.body.translations)).toEqual({ nl: 'disabled', fr: 'disabled' });
    expect(retry.body.immediate).toBeUndefined(); // nothing was ever pending
    expect((await CmsContent.findById(id).lean())!.translationRun).toBeUndefined();

    const updated = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: 'Changed while unconfigured' } });
    expect(updated.status).toBe(200);
    expect(byLocale(updated.body.translations)).toEqual({ nl: 'disabled', fr: 'disabled' });
    expect(fixture.requests).toHaveLength(0);
  });

  it('RBAC: translate requires cms.manage write; customers and admins without it are refused', async () => {
    configureTranslator(true);
    const created = await call('POST', '/api/admin/cms', { cookie: contentCookie, body: blog() });
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    fixture.requests.length = 0;

    expect((await call('POST', `/api/admin/cms/${id}/translate`, { cookie: careCookie, body: {} })).status).toBe(403);
    expect((await call('POST', `/api/admin/cms/${id}/translate`, { cookie: customerCookie, body: {} })).status).toBe(403);
    expect((await call('POST', `/api/admin/cms/${id}/translate`, { body: {} })).status).toBe(401);
    expect((await call('POST', '/api/admin/cms', { cookie: careCookie, body: blog() })).status).toBe(403);
    expect(fixture.requests).toHaveLength(0);

    const ok = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: contentCookie, body: {} });
    expect(ok.status).toBe(200);
    expect(byLocale(ok.body.translations)).toEqual({ nl: 'synced', fr: 'synced' });
    expect(fixture.requests).toHaveLength(0); // unchanged text: no provider call
    expect((await call('POST', '/api/admin/cms/not-an-id/translate', { cookie: contentCookie, body: {} })).status).toBe(400);
    expect((await call('POST', `/api/admin/cms/${new Types.ObjectId()}/translate`, { cookie: contentCookie, body: {} })).status).toBe(404);
  });

  it('draft create persists managed nl/fr variants with copied controls; publication flows through without re-translating', async () => {
    configureTranslator(true);
    const input = blog();
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    expect(created.status).toBe(201);
    expect(byLocale(created.body.translations)).toEqual({ nl: 'created', fr: 'created' });
    const id = created.body.data._id;

    // Wire format: one target language per request, plain fields batched, body as html.
    expect(fixture.requests).toHaveLength(4);
    for (const request of fixture.requests) {
      expect(request.path).toBe('/translate');
      expect(request.hasKey).toBe(true);
      expect(request.region).toBe('westeurope');
      expect(request.query).toMatchObject({ 'api-version': '3.0', from: 'en' });
    }
    const plainNl = fixture.requests.find((r) => r.query.to === 'nl' && r.query.textType === 'plain')!;
    expect(plainNl.texts).toEqual([input.title, 'Short intro', 'Heat pump on a wall', 'Heat pumps', 'All about heat pumps']);

    const variants = await family(id);
    expect(variants.map((v) => v.locale)).toEqual(['fr', 'nl']);
    for (const variant of variants) {
      expect(variant).toMatchObject({
        type: 'blog',
        slug: input.slug,
        status: 'draft',
        autoTranslated: true,
        activeCountries: ['BE'],
        coverImage: input.coverImage,
        tags: [TAG],
      });
      expect(String(variant.translatedFrom)).toBe(String(id));
      expect(variant.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(variant.title).toBe(`[${variant.locale}] ${input.title}`);
      expect(variant.body).toBe(`<h2>[${variant.locale}] Why a heat pump</h2><p>Lower bills.</p>`);
      expect(variant.seo?.titleTag).toBe(`[${variant.locale}] Heat pumps`);
      expect(variant.seo?.canonical).toBeUndefined(); // canonical is per-locale, never copied
      expect(variant.seo?.noindex).toBe(false);
      expect(variant.publishedAt).toBeUndefined();
    }

    const be = { 'x-fixera-content-country': 'BE', 'x-vercel-ip-country': 'BE' };
    expect((await call('GET', `/api/public/cms/blog/${input.slug}?locale=nl`, { headers: be })).status).toBe(404);

    // Publishing is a non-text change: mirrored to the variants with no provider call.
    fixture.requests.length = 0;
    const published = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'published' } });
    expect(published.status).toBe(200);
    expect(byLocale(published.body.translations)).toEqual({ nl: 'synced', fr: 'synced' });
    expect(fixture.requests).toHaveLength(0);
    const [fr, nl] = await family(id);
    expect([fr.status, nl.status]).toEqual(['published', 'published']);
    expect(nl.publishedAt?.toISOString()).toBe(
      (await CmsContent.findById(id).lean())!.publishedAt!.toISOString(),
    );

    const nlPublic = await call('GET', `/api/public/cms/blog/${input.slug}?locale=nl`, { headers: be });
    expect(nlPublic.status).toBe(200);
    expect(nlPublic.body.data.locale).toBe('nl');
    expect(nlPublic.body.data.title).toBe(`[nl] ${input.title}`);
    // Country targeting mirrored from the source.
    const nlVisitor = { 'x-fixera-content-country': 'NL', 'x-vercel-ip-country': 'NL' };
    expect((await call('GET', `/api/public/cms/blog/${input.slug}?locale=nl`, { headers: nlVisitor })).status).toBe(404);

    // A text change re-translates and refreshes the hash.
    const before = nl.sourceHash;
    const retitled = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: 'Heat pumps explained' } });
    expect(byLocale(retitled.body.translations)).toEqual({ nl: 'updated', fr: 'updated' });
    const nlAfter = await CmsContent.findById(nl._id).lean();
    expect(nlAfter!.title).toBe('[nl] Heat pumps explained');
    expect(nlAfter!.sourceHash).not.toBe(before);
  });

  it('a manual edit wins over sync for text, but publication/country controls still follow the source; force overwrites from the origin', async () => {
    configureTranslator(true);
    const input = blog({ status: 'published', activeCountries: [] });
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const nl = (await family(id)).find((v) => v.locale === 'nl')!;

    // Admin edits the machine nl text: demoted to a manual translation, not a source.
    fixture.requests.length = 0;
    const manual = await call('PUT', `/api/admin/cms/${nl._id}`, { cookie: superCookie, body: { title: 'Handmatige titel' } });
    expect(manual.status).toBe(200);
    expect(manual.body.translations).toEqual([]);
    expect(fixture.requests).toHaveLength(0);
    const nlManual = await CmsContent.findById(nl._id).lean();
    expect(nlManual).toMatchObject({ autoTranslated: false, title: 'Handmatige titel' });
    expect(String(nlManual!.translatedFrom)).toBe(String(id));

    const retitled = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: 'New english title' } });
    expect(byLocale(retitled.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'updated' });
    expect((await CmsContent.findById(nl._id).lean())!.title).toBe('Handmatige titel');

    // Unpublishing / geo-restricting the source hides the manual translation too.
    const restricted = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'draft', activeCountries: ['NL'] } });
    expect(restricted.status).toBe(200);
    const nlControlled = await CmsContent.findById(nl._id).lean();
    expect(nlControlled).toMatchObject({ status: 'draft', activeCountries: ['NL'], title: 'Handmatige titel' });
    expect((await call('GET', `/api/public/cms/blog/${input.slug}?locale=nl`, { headers: { 'x-fixera-content-country': 'NL' } })).status).toBe(404);

    // Re-translate on the translation's id runs from its origin; force overwrites manual text.
    const plain = await call('POST', `/api/admin/cms/${nl._id}/translate`, { cookie: superCookie, body: {} });
    expect(byLocale(plain.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'synced' });
    const forced = await call('POST', `/api/admin/cms/${nl._id}/translate`, { cookie: superCookie, body: { force: true } });
    expect(byLocale(forced.body.translations)).toEqual({ nl: 'updated', fr: 'updated' });
    const nlForced = await CmsContent.findById(nl._id).lean();
    expect(nlForced).toMatchObject({ autoTranslated: true, title: '[nl] New english title' });
    // The english original is never overwritten by machine text.
    expect((await CmsContent.findById(id).lean())!.title).toBe('New english title');
  });

  it('provider failures are reported per locale, never roll back the save, and persist no partial variant', async () => {
    configureTranslator(true);
    fixture.failLocales.add('fr');
    const input = blog();
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    expect(created.status).toBe(201);
    expect(created.body.immediate).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'pending' },
    ]);
    // 5xx is retried (backoff stubbed), then reported with a safe message.
    expect(created.body.translations).toEqual([
      { locale: 'nl', status: 'created' },
      {
        locale: 'fr',
        status: 'failed',
        errorCode: 'provider_error',
        error: 'The translation service returned an error. Retry later.',
      },
    ]);
    expect(fixture.requests.filter((r) => r.query.to === 'fr')).toHaveLength(4);
    const failedStatus = (await call('GET', `/api/admin/cms/${created.body.data._id}/translations`, { cookie: superCookie })).body.data;
    expect(failedStatus.locales.map((l: any) => [l.locale, l.state])).toEqual([
      ['en', 'source'],
      ['nl', 'up_to_date'],
      ['fr', 'failed'],
    ]);
    expect(failedStatus.locales[2].lastResult).toMatchObject({ status: 'failed', errorCode: 'provider_error' });
    const id = created.body.data._id;
    expect(await CmsContent.countDocuments({ _id: id })).toBe(1);
    expect((await family(id)).map((v) => v.locale)).toEqual(['nl']);

    // Retry after the provider recovers: only the missing locale is translated.
    fixture.failLocales.clear();
    fixture.requests.length = 0;
    const retry = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: {} });
    expect(byLocale(retry.body.translations)).toEqual({ nl: 'synced', fr: 'created' });
    expect(new Set(fixture.requests.map((r) => r.query.to))).toEqual(new Set(['fr']));

    // Auth failure (bad/revoked key): sanitized failure, existing variants untouched.
    fixture.authFail = true;
    const nlBefore = (await family(id)).find((v) => v.locale === 'nl')!;
    const updated = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: 'Retitled during outage' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data.title).toBe('Retitled during outage');
    expect(byLocale(updated.body.translations)).toEqual({ nl: 'failed', fr: 'failed' });
    expect(updated.body.translations.map((t: any) => t.errorCode)).toEqual(['auth', 'auth']);
    // Only the safe admin sentence is surfaced, never the provider's raw error.
    expect(JSON.stringify(updated.body)).not.toMatch(/401000|not authorized/);
    const nlAfter = await CmsContent.findById(nlBefore._id).lean();
    expect(nlAfter!.title).toBe(nlBefore.title);
    expect(nlAfter!.sourceHash).toBe(nlBefore.sourceHash); // still stale -> next save retries
  });

  it('slug change moves machine variants; delete removes them, detaches manual ones and keeps a still-referenced cover', async () => {
    configureTranslator(true);
    const input = blog({ status: 'published' });
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const fr = (await family(id)).find((v) => v.locale === 'fr')!;
    await call('PUT', `/api/admin/cms/${fr._id}`, { cookie: superCookie, body: { title: 'Titre manuel' } });

    const newSlug = `${input.slug}-moved`;
    const moved = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { slug: newSlug } });
    expect(moved.status).toBe(200);
    expect(byLocale(moved.body.translations)).toEqual({ nl: 'synced', fr: 'skipped_manual' });
    const afterMove = await family(id);
    expect(afterMove.find((v) => v.locale === 'nl')!.slug).toBe(newSlug);
    expect(afterMove.find((v) => v.locale === 'fr')!.slug).toBe(input.slug); // manual keeps its slug

    // Replacing the cover: machine variants follow; the manual fr still uses the
    // old object, so it must not be deleted from S3.
    const swapped = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { coverImage: cover('swapped') } });
    expect(swapped.status).toBe(200);
    expect((await family(id)).find((v) => v.locale === 'nl')!.coverImage).toBe(cover('swapped'));
    expect(s3Deletes).toEqual([]);

    const removed = await call('DELETE', `/api/admin/cms/${id}`, { cookie: superCookie });
    expect(removed.status).toBe(200);
    expect(removed.body.translationCleanup).toEqual({ deleted: 1, detached: 1 });
    expect(await CmsContent.countDocuments({ _id: { $in: [id] } })).toBe(0);
    const frLeft = await CmsContent.findById(fr._id).lean();
    expect(frLeft).toMatchObject({ title: 'Titre manuel', autoTranslated: false });
    expect(frLeft!.translatedFrom).toBeUndefined();
    // The swapped cover is unreferenced now (source and nl gone); the old one is still used by fr.
    expect(s3Deletes).toEqual([`cms/${TAG}-swapped.jpg`]);
  });

  it('a pre-existing same-slug manual original (main-era manual workflow) is never overwritten or linked', async () => {
    const slug = `${TAG}-legacy-${++seq}`;
    // Created on main before auto-translation existed (no translator): an independent nl original.
    configureTranslator(false);
    const legacyNl = await call('POST', '/api/admin/cms', {
      cookie: superCookie,
      body: blog({ slug, locale: 'nl', title: 'Warmtepomp gids', status: 'published', activeCountries: [] }),
    });
    expect(legacyNl.status).toBe(201);
    expect(await family(legacyNl.body.data._id)).toHaveLength(0);

    configureTranslator(true);
    fixture.requests.length = 0;
    const enInput = blog({ slug, status: 'published', activeCountries: ['BE'] });
    const en = await call('POST', '/api/admin/cms', { cookie: superCookie, body: enInput });
    expect(en.status).toBe(201);
    expect(byLocale(en.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'created' });
    const nlDoc = await CmsContent.findById(legacyNl.body.data._id).lean();
    expect(nlDoc).toMatchObject({ title: 'Warmtepomp gids', status: 'published', activeCountries: [] });
    expect(nlDoc!.translatedFrom).toBeUndefined();
    expect(new Set(fixture.requests.map((r) => r.query.to))).toEqual(new Set(['fr']));

    // Saving the legacy nl original must not re-translate or re-link the en source's fr variant.
    const frBefore = await CmsContent.findOne({ type: 'blog', slug, locale: 'fr' }).lean();
    fixture.requests.length = 0;
    const nlSave = await call('PUT', `/api/admin/cms/${legacyNl.body.data._id}`, {
      cookie: superCookie,
      body: { title: 'Warmtepomp gids (bijgewerkt)' },
    });
    expect(nlSave.status).toBe(200);
    const frAfter = await CmsContent.findOne({ type: 'blog', slug, locale: 'fr' }).lean();
    expect(String(frAfter!.translatedFrom)).toBe(String(en.body.data._id));
    expect(frAfter!.title).toBe(frBefore!.title);
    expect(frAfter!.activeCountries).toEqual(['BE']);
    expect(fixture.requests).toHaveLength(0);
    // The en original is also untouched by the nl save.
    expect((await CmsContent.findById(en.body.data._id).lean())!.title).toBe(enInput.title);
  });
});
