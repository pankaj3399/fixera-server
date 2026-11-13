/**
 * T6 (CMS translation publication rules) and T5 (admin localeVariants by
 * translation family), end-to-end against the real admin + public routers and
 * REAL MongoDB, with the Azure Translator replaced by the same LOCAL
 * Translator-v3 transport fixture as cmsAutoTranslation.test.ts. No request
 * leaves the machine and this is NOT evidence of a live Azure pass.
 *
 * Publication rules under test:
 * - Machine translations follow the source's status and publishedAt.
 * - A linked MANUAL translation keeps its own status/publishedAt when the
 *   source is published (a source publish never promotes a manual draft or
 *   rewrites its date); an unpublished source demotes it to draft; country
 *   targeting is always mirrored. These hold with the provider unconfigured.
 * - Explicit force replaces manual text and turns the translation into a
 *   machine translation, which then follows the source.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cms-publication-fix-test-secret';
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

const TAG = 'cmspubfix-it';
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
    title: `Roof insulation ${seq}`,
    slug: `${TAG}-roof-${seq}`,
    body: '<h2>Why insulate</h2><p>Warmer rooms.</p>',
    excerpt: 'Short intro',
    coverImage: cover(`c${seq}`),
    coverImageAlt: 'Insulated roof',
    tags: [TAG],
    status: 'draft',
    activeCountries: [],
    ...over,
  };
};

const doc = async (id: unknown) => (await CmsContent.findById(id).lean())!;
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : undefined);
const visitor = (country: string) => ({ 'x-fixera-content-country': country, 'x-vercel-ip-country': country });
/** The locale the public slug endpoint serves (it falls back to en), or 404. */
const servedLocale = async (slug: string, locale: string, country = 'BE') => {
  const res = await call('GET', `/api/public/cms/blog/${slug}?locale=${locale}`, { headers: visitor(country) });
  return res.status === 200 ? res.body.data.locale : res.status;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('CMS translation publication rules + localeVariants (real MongoDB, local translator fixture)', () => {
  let readOnlyCookie = '';

  beforeAll(async () => {
    skipTranslatorBackoff();
    await mongoose.connect(testUri!);
    await CmsContent.deleteMany({ $or: [{ tags: TAG }, { slug: new RegExp(`^${TAG}`) }] });
    await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
    const mk = (adminRole: string | undefined, role = 'admin', extra: Record<string, unknown> = {}) =>
      User.create({
        name: `${TAG} ${adminRole || role}`,
        email: `${adminRole || role}-${new Types.ObjectId().toHexString()}@${TAG}.example`,
        phone: `+3248${Math.floor(Math.random() * 1e7)}`,
        password: 'not-used-hash',
        role,
        ...(adminRole ? { adminRole } : {}),
        isEmailVerified: true,
        accountStatus: 'active',
        ...extra,
      });
    superCookie = cookieFor(await mk('super'));
    contentCookie = cookieFor(await mk('content_creator'));
    careCookie = cookieFor(await mk('care'));
    customerCookie = cookieFor(await mk(undefined, 'customer'));
    // Explicit per-user levels: CMS read only (no write anywhere).
    readOnlyCookie = cookieFor(await mk('care', 'admin', { adminPermissionLevels: { cms: 'read' } }));

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

  it('draft source -> publish: machine variants follow, a manual draft stays draft, a manual published keeps its own date', async () => {
    configureTranslator(true);
    const input = blog();
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    expect(created.status).toBe(201);
    expect(byLocale(created.body.translations)).toEqual({ nl: 'created', fr: 'created' });
    const id = created.body.data._id;
    const [frMachine, nlMachine] = await family(id);

    // nl: the editor rewrites it and deliberately leaves it as a draft.
    const nlEdit = await call('PUT', `/api/admin/cms/${nlMachine._id}`, { cookie: superCookie, body: { title: 'Dakisolatie (concept)' } });
    expect(nlEdit.status).toBe(200);
    expect(await doc(nlMachine._id)).toMatchObject({ autoTranslated: false, status: 'draft', title: 'Dakisolatie (concept)' });

    // fr stays a machine translation for now. Publish the source.
    fixture.requests.length = 0;
    const published = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'published' } });
    expect(published.status).toBe(200);
    expect(byLocale(published.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'synced' });
    expect(fixture.requests).toHaveLength(0); // unchanged text: no provider call
    const source = await doc(id);
    expect(source.status).toBe('published');

    const nl = await doc(nlMachine._id);
    expect(nl).toMatchObject({ status: 'draft', autoTranslated: false, title: 'Dakisolatie (concept)' });
    expect(nl.publishedAt).toBeUndefined();
    const fr = await doc(frMachine._id);
    expect(fr).toMatchObject({ status: 'published', autoTranslated: true });
    expect(iso(fr.publishedAt)).toBe(iso(source.publishedAt));

    // Public: nl falls back to en (the nl draft is never served); fr is served.
    expect(await servedLocale(input.slug, 'nl')).toBe('en');
    expect(await servedLocale(input.slug, 'fr')).toBe('fr');

    // fr: the editor rewrites it (manual, published). Its publication date is its own from now on.
    await call('PUT', `/api/admin/cms/${frMachine._id}`, { cookie: superCookie, body: { title: 'Isolation du toit' } });
    const frManual = await doc(frMachine._id);
    expect(frManual).toMatchObject({ autoTranslated: false, status: 'published' });
    const frOwnDate = iso(frManual.publishedAt);

    // Source edits: manual text wins; neither manual translation is promoted or re-dated.
    await sleep(5);
    const edited = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: 'Roof insulation explained' } });
    expect(byLocale(edited.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'skipped_manual' });
    expect(fixture.requests).toHaveLength(0);
    expect(await doc(nlMachine._id)).toMatchObject({ status: 'draft', title: 'Dakisolatie (concept)' });
    const frAfterEdit = await doc(frMachine._id);
    expect(frAfterEdit).toMatchObject({ status: 'published', title: 'Isolation du toit' });
    expect(iso(frAfterEdit.publishedAt)).toBe(frOwnDate);

    // Unchanged-hash resync: nothing promoted, nothing sent.
    const resync = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: {} });
    expect(byLocale(resync.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'skipped_manual' });
    expect(fixture.requests).toHaveLength(0);
    expect((await doc(nlMachine._id)).status).toBe('draft');
  });

  it('a manual published translation is demoted on source unpublish, mirrors countries, and is not re-published by a source republish', async () => {
    configureTranslator(true);
    const input = blog({ status: 'published' });
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const nlId = (await family(id)).find((v) => v.locale === 'nl')!._id;
    await call('PUT', `/api/admin/cms/${nlId}`, { cookie: superCookie, body: { title: 'Dakisolatie' } });
    const nlOwnDate = iso((await doc(nlId)).publishedAt);
    expect(nlOwnDate).toBeDefined();
    expect(await servedLocale(input.slug, 'nl', 'NL')).toBe('nl');

    // Country change on a published source: mirrored; publication untouched.
    const restricted = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { activeCountries: ['NL'] } });
    expect(restricted.status).toBe(200);
    const nlRestricted = await doc(nlId);
    expect(nlRestricted).toMatchObject({ status: 'published', activeCountries: ['NL'], title: 'Dakisolatie' });
    expect(iso(nlRestricted.publishedAt)).toBe(nlOwnDate);
    expect(await servedLocale(input.slug, 'nl', 'NL')).toBe('nl');
    expect(await servedLocale(input.slug, 'nl', 'BE')).toBe(404);

    // Unpublishing the source unpublishes the manual translation.
    const unpublished = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'draft' } });
    expect(byLocale(unpublished.body.translations)).toMatchObject({ nl: 'skipped_manual' });
    const nlHidden = await doc(nlId);
    expect(nlHidden).toMatchObject({ status: 'draft', title: 'Dakisolatie', activeCountries: ['NL'] });
    expect(nlHidden.publishedAt).toBeUndefined();
    expect(await servedLocale(input.slug, 'nl', 'NL')).toBe(404);

    // Republishing the source does not republish it: the editor decides.
    const republished = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'published' } });
    expect(republished.status).toBe(200);
    expect((await doc(nlId)).status).toBe('draft');
    expect(await servedLocale(input.slug, 'nl', 'NL')).toBe('en');

    // The editor republishes it explicitly.
    await call('PUT', `/api/admin/cms/${nlId}`, { cookie: superCookie, body: { status: 'published' } });
    expect((await doc(nlId)).status).toBe('published');
    expect(await servedLocale(input.slug, 'nl', 'NL')).toBe('nl');

    // Making the source global again clears the manual translation's restriction.
    await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { activeCountries: [] } });
    expect((await doc(nlId)).activeCountries).toEqual([]);
    expect(await servedLocale(input.slug, 'nl', 'BE')).toBe('nl');
  });

  it('explicit force replaces a manual draft with machine text, which then follows the published source', async () => {
    configureTranslator(true);
    const input = blog({ status: 'published' });
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const nlId = (await family(id)).find((v) => v.locale === 'nl')!._id;
    await call('PUT', `/api/admin/cms/${nlId}`, { cookie: superCookie, body: { title: 'Concept', status: 'draft' } });
    expect(await doc(nlId)).toMatchObject({ status: 'draft', autoTranslated: false });

    // A normal resync never touches it.
    const plain = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: {} });
    expect(byLocale(plain.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'synced' });
    expect(await doc(nlId)).toMatchObject({ status: 'draft', title: 'Concept' });

    fixture.requests.length = 0;
    const forced = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: { force: true } });
    expect(byLocale(forced.body.translations)).toEqual({ nl: 'updated', fr: 'updated' });
    expect(new Set(fixture.requests.map((r) => r.query.to))).toEqual(new Set(['nl', 'fr']));
    const source = await doc(id);
    const nl = await doc(nlId);
    expect(nl).toMatchObject({ autoTranslated: true, status: 'published', title: `[nl] ${input.title}` });
    expect(iso(nl.publishedAt)).toBe(iso(source.publishedAt));
    expect((await doc(id)).title).toBe(input.title); // the original is never overwritten
  });

  it('provider unconfigured: the same manual rules hold (no promotion on publish, demotion on unpublish, force keeps controls)', async () => {
    configureTranslator(true);
    const input = blog();
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const [fr, nl] = await family(id);
    await call('PUT', `/api/admin/cms/${nl._id}`, { cookie: superCookie, body: { title: 'Handmatig concept' } });

    configureTranslator(false);
    fixture.requests.length = 0;
    const published = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'published', activeCountries: ['BE'] } });
    expect(published.status).toBe(200);
    expect(byLocale(published.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'synced' });
    expect(await doc(nl._id)).toMatchObject({ status: 'draft', activeCountries: ['BE'], title: 'Handmatig concept' });
    expect(await doc(fr._id)).toMatchObject({ status: 'published', autoTranslated: true, activeCountries: ['BE'] });

    // A source text edit cannot be translated: fr reports disabled and keeps its old text.
    const edited = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: 'Edited while unconfigured' } });
    expect(byLocale(edited.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'disabled' });
    expect((await doc(fr._id)).title).toBe(fr.title);

    // The editor publishes nl; then the source is unpublished: nl is demoted even unconfigured.
    await call('PUT', `/api/admin/cms/${nl._id}`, { cookie: superCookie, body: { status: 'published' } });
    expect((await doc(nl._id)).status).toBe('published');
    await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: 'draft' } });
    const nlDemoted = await doc(nl._id);
    expect(nlDemoted.status).toBe('draft');
    expect(nlDemoted.publishedAt).toBeUndefined();

    // Force with no provider: nothing is translated, but restricting controls still apply.
    await call('PUT', `/api/admin/cms/${nl._id}`, { cookie: superCookie, body: { status: 'published' } });
    const forced = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: { force: true } });
    expect(byLocale(forced.body.translations)).toEqual({ nl: 'disabled', fr: 'disabled' });
    expect(await doc(nl._id)).toMatchObject({ status: 'draft', autoTranslated: false, title: 'Handmatig concept' });
    expect(fixture.requests).toHaveLength(0);
  });

  it('T5: GET/PUT echo localeVariants by translatedFrom family (manual slug kept), excluding self, other types and unrelated same-slug docs', async () => {
    configureTranslator(true);
    const input = blog({ status: 'published' });
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const [fr, nl] = await family(id);
    // fr: manual translation moved to its own slug — a slug search cannot find it.
    const frSlug = `${TAG}-toiture-${seq}`;
    const frMoved = await call('PUT', `/api/admin/cms/${fr._id}`, { cookie: superCookie, body: { title: 'Isolation', slug: frSlug } });
    expect(frMoved.status).toBe(200);

    // Noise: another type linked to the same origin, and an unrelated same-slug news doc.
    const otherType = await CmsContent.create({
      type: 'news', locale: 'nl', slug: input.slug, title: 'Other type', body: '<p>x</p>', tags: [TAG], status: 'published',
      translatedFrom: id, autoTranslated: false,
    });
    await CmsContent.create({ type: 'news', locale: 'fr', slug: input.slug, title: 'Unrelated', body: '<p>x</p>', tags: [TAG], status: 'draft' });

    const fromSource = await call('GET', `/api/admin/cms/${id}`, { cookie: contentCookie });
    expect(fromSource.status).toBe(200);
    const variants = fromSource.body.data.localeVariants;
    expect(variants.map((v: any) => [v.locale, v._id])).toEqual([
      ['nl', String(nl._id)],
      ['fr', String(fr._id)],
    ]);
    expect(variants[1]).toMatchObject({
      slug: frSlug, title: 'Isolation', status: 'published', autoTranslated: false, translatedFrom: String(id),
    });
    expect(variants[0]).toMatchObject({ slug: input.slug, autoTranslated: true, translatedFrom: String(id) });
    expect(typeof variants[0].updatedAt).toBe('string');
    expect(variants.some((v: any) => v._id === String(otherType._id))).toBe(false);

    // From a translation: the origin first-class, the sibling, never itself.
    const fromFr = await call('GET', `/api/admin/cms/${fr._id}`, { cookie: superCookie });
    expect(fromFr.body.data.localeVariants.map((v: any) => [v.locale, v._id])).toEqual([
      ['en', String(id)],
      ['nl', String(nl._id)],
    ]);
    expect(fromFr.body.data.localeVariants[0].translatedFrom).toBeUndefined();

    // PUT echo carries it too.
    const echo = await call('PUT', `/api/admin/cms/${nl._id}`, { cookie: superCookie, body: { title: 'Dakisolatie' } });
    expect(echo.status).toBe(200);
    expect(echo.body.data.localeVariants.map((v: any) => v.locale)).toEqual(['en', 'fr']);

    // Dedupe: a second linked nl doc (another slug) yields one nl entry, never two.
    await sleep(5);
    const dupNl = await CmsContent.create({
      type: 'blog', locale: 'nl', slug: `${TAG}-dup-${seq}`, title: 'Duplicate nl', body: '<p>x</p>', tags: [TAG],
      status: 'draft', translatedFrom: id, autoTranslated: false,
    });
    const deduped = await call('GET', `/api/admin/cms/${id}`, { cookie: superCookie });
    const nlEntries = deduped.body.data.localeVariants.filter((v: any) => v.locale === 'nl');
    expect(nlEntries).toHaveLength(1);
    expect(nlEntries[0]._id).toBe(String(dupNl._id)); // most recently updated wins

    // A standalone original with no family gets an empty list.
    const lone = await call('POST', '/api/admin/cms', { cookie: superCookie, body: blog({ locale: 'nl' }) });
    await CmsContent.deleteMany({ translatedFrom: lone.body.data._id });
    const loneGet = await call('GET', `/api/admin/cms/${lone.body.data._id}`, { cookie: superCookie });
    expect(loneGet.body.data.localeVariants).toEqual([]);

    // RBAC: cms read can see it; no cms access is refused; read-only cannot write.
    const readOnly = await call('GET', `/api/admin/cms/${id}`, { cookie: readOnlyCookie });
    expect(readOnly.status).toBe(200);
    expect(readOnly.body.data.localeVariants.map((v: any) => v.locale)).toEqual(['nl', 'fr']);
    expect((await call('PUT', `/api/admin/cms/${id}`, { cookie: readOnlyCookie, body: { title: 'x' } })).status).toBe(403);
    const care = await call('GET', `/api/admin/cms/${id}`, { cookie: careCookie });
    expect(care.status).toBe(403);
    expect(care.body.data).toBeUndefined();
    expect((await call('GET', `/api/admin/cms/${id}`, { cookie: customerCookie })).status).toBe(403);
    expect((await call('GET', `/api/admin/cms/${id}`)).status).toBe(401);
  });
});
