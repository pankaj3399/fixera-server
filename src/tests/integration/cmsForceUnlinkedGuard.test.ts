/**
 * Forced CMS resync data-loss boundary, end-to-end against the real admin
 * router and REAL MongoDB, with the Azure Translator replaced by the LOCAL
 * Translator-v3 transport fixture used by cmsAutoTranslation.test.ts. No
 * request leaves the machine; this is NOT evidence of a live Azure pass.
 *
 * Contract under test (2026-11-03): `force: true` may only replace this
 * source's explicitly LINKED manual translations (translatedFrom = source)
 * and adopt orphan MACHINE rows. A same-slug MANUAL document that is not
 * linked to the source (an independent original, another original's manual
 * translation, a dangling link) is never touched: reported skipped_manual,
 * no write at all (updatedAt and __v unchanged), no re-link, no provider call.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cms-force-guard-test-secret';
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

const TAG = 'cmsforceguard-it';
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

type Mode = 'configured' | 'unconfigured' | 'failing';
const setMode = (mode: Mode) => {
  configureTranslator(mode !== 'unconfigured');
  fixture.failLocales.clear();
  if (mode === 'failing') CMS_TARGETS.forEach((l) => fixture.failLocales.add(l));
};
const CMS_TARGETS = ['en', 'nl', 'fr'];
const providerCallsTo = (locale: string) => fixture.requests.filter((r) => r.query.to === locale).length;
/** Full persisted state; any write (even an identical $set) bumps updatedAt. */
const snapshot = async (id: unknown) => JSON.parse(JSON.stringify(await CmsContent.findById(id).lean()));

/** A legacy/independent original inserted directly: no translatedFrom, manual, its own controls. */
const insertIndependent = async (over: Record<string, unknown>) =>
  CmsContent.create({
    type: 'blog',
    title: 'Eigen origineel',
    body: '<p>Met de hand geschreven.</p>',
    excerpt: 'Eigen intro',
    coverImage: cover(`independent-${seq}`),
    coverImageAlt: 'Eigen omslag',
    tags: [TAG],
    status: 'published',
    publishedAt: new Date('2025-06-01T08:00:00.000Z'),
    activeCountries: ['NL'],
    autoTranslated: false,
    ...over,
  });

describeDb('CMS forced resync never overwrites unlinked manual documents (real MongoDB, local translator fixture)', () => {
  beforeAll(async () => {
    skipTranslatorBackoff();
    await mongoose.connect(testUri!);
    await CmsContent.deleteMany({ $or: [{ tags: TAG }, { slug: new RegExp(`^${TAG}`) }] });
    await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
    const admin = await User.create({
      name: `${TAG} super`,
      email: `super-${new Types.ObjectId().toHexString()}@${TAG}.example`,
      phone: `+3248${Math.floor(Math.random() * 1e7)}`,
      password: 'not-used-hash',
      role: 'admin',
      adminRole: 'super',
      isEmailVerified: true,
      accountStatus: 'active',
    });
    superCookie = cookieFor(admin);

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

  it('an independent same-slug nl original is never touched: configured/unconfigured/failing x force false/true x draft/published source', async () => {
    const input = blog({ status: 'draft' });
    const independent = await insertIndependent({ locale: 'nl', slug: input.slug });
    const before = await snapshot(independent._id);

    setMode('configured');
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    expect(created.status).toBe(201);
    expect(byLocale(created.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'created' });
    const id = created.body.data._id;
    expect(providerCallsTo('nl')).toBe(0);
    const frId = (await family(id)).find((v) => v.locale === 'fr')!._id;

    // The UI's localeVariants (and so the force confirmation) never name the independent original.
    const read = await call('GET', `/api/admin/cms/${id}`, { cookie: superCookie });
    expect(read.body.data.localeVariants.map((v: any) => v.locale)).toEqual(['fr']);

    const runs: string[] = [];
    for (const sourceStatus of ['draft', 'published'] as const) {
      setMode('configured');
      const statusSave = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { status: sourceStatus, activeCountries: ['BE'] } });
      expect(statusSave.status).toBe(200);
      expect(byLocale(statusSave.body.translations).nl).toBe('skipped_manual');

      for (const mode of ['configured', 'unconfigured', 'failing'] as Mode[]) {
        for (const force of [false, true]) {
          setMode(mode);
          fixture.requests.length = 0;
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const err = vi.spyOn(console, 'error').mockImplementation(() => {});
          const res = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: { force } });
          warn.mockRestore();
          err.mockRestore();
          expect(res.status).toBe(200);
          const statuses = byLocale(res.body.translations);
          runs.push(`${sourceStatus}/${mode}/force=${force}: nl=${statuses.nl} fr=${statuses.fr}`);
          expect(statuses.nl).toBe('skipped_manual');
          // The linked machine fr still follows the source's rules.
          const expectedFr = !force ? 'synced' : mode === 'configured' ? 'updated' : mode === 'failing' ? 'failed' : 'disabled';
          expect(statuses.fr).toBe(expectedFr);
          expect(providerCallsTo('nl')).toBe(0);
          expect(await snapshot(independent._id)).toEqual(before);
        }
      }
      // A text edit of the source (save-time sync) does not touch it either.
      setMode('configured');
      fixture.requests.length = 0;
      const edited = await call('PUT', `/api/admin/cms/${id}`, { cookie: superCookie, body: { title: `Edited ${sourceStatus}` } });
      expect(byLocale(edited.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'updated' });
      expect(providerCallsTo('nl')).toBe(0);
      expect(await snapshot(independent._id)).toEqual(before);
    }
    expect(runs).toHaveLength(12);

    // fr really was translated and follows the published source; the independent original is still its own.
    const fr = await doc(frId);
    expect(fr).toMatchObject({ autoTranslated: true, status: 'published', activeCountries: ['BE'], title: '[fr] Edited published' });
    const nl = await doc(independent._id);
    expect(nl.translatedFrom).toBeUndefined();
    expect(nl).toMatchObject({ status: 'published', activeCountries: ['NL'], title: 'Eigen origineel', autoTranslated: false });
    expect(nl.sourceHash).toBeUndefined();
  });

  it('explicit force still replaces linked manual translations, including one moved to its own slug', async () => {
    setMode('configured');
    const input = blog({ status: 'published' });
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: input });
    const id = created.body.data._id;
    const [fr, nl] = await family(id);
    await call('PUT', `/api/admin/cms/${nl._id}`, { cookie: superCookie, body: { title: 'Handmatig' } });
    const ownSlug = `${TAG}-eigen-${seq}`;
    const moved = await call('PUT', `/api/admin/cms/${fr._id}`, { cookie: superCookie, body: { title: 'Manuel', slug: ownSlug } });
    expect(moved.status).toBe(200);
    expect(await doc(fr._id)).toMatchObject({ autoTranslated: false, slug: ownSlug, translatedFrom: new Types.ObjectId(id) });

    const variants = (await call('GET', `/api/admin/cms/${id}`, { cookie: superCookie })).body.data.localeVariants;
    expect(variants.map((v: any) => [v.locale, v.autoTranslated])).toEqual([['nl', false], ['fr', false]]);

    fixture.requests.length = 0;
    const plain = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: { force: false } });
    expect(byLocale(plain.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'skipped_manual' });
    expect(fixture.requests).toHaveLength(0);

    const forced = await call('POST', `/api/admin/cms/${id}/translate`, { cookie: superCookie, body: { force: true } });
    expect(byLocale(forced.body.translations)).toEqual({ nl: 'updated', fr: 'updated' });
    expect(providerCallsTo('nl')).toBeGreaterThan(0);
    expect(providerCallsTo('fr')).toBeGreaterThan(0);
    expect(await doc(nl._id)).toMatchObject({ autoTranslated: true, title: `[nl] ${input.title}`, slug: input.slug });
    // The linked translation on its own slug is replaced and returns to the source's slug, as before.
    expect(await doc(fr._id)).toMatchObject({ autoTranslated: true, title: `[fr] ${input.title}`, slug: input.slug, status: 'published' });
  });

  it("another live original's machine variant and that original itself are protected from a forced resync", async () => {
    setMode('configured');
    const slug = `${TAG}-shared-${++seq}`;
    // nl: a legacy independent original (inserted directly, never translated).
    const nlOriginal = await insertIndependent({ locale: 'nl', slug, status: 'draft', publishedAt: undefined, activeCountries: [] });
    // en: a second original with the same slug; it creates and owns the fr machine variant.
    const enCreated = await call('POST', '/api/admin/cms', { cookie: superCookie, body: blog({ slug, status: 'published' }) });
    expect(byLocale(enCreated.body.translations)).toEqual({ nl: 'skipped_manual', fr: 'created' });
    const enId = enCreated.body.data._id;
    const frId = (await family(enId)).find((v) => v.locale === 'fr')!._id;

    const enBefore = await snapshot(enId);
    const frBefore = await snapshot(frId);
    const nlBefore = await snapshot(nlOriginal._id);
    for (const force of [false, true]) {
      fixture.requests.length = 0;
      const res = await call('POST', `/api/admin/cms/${nlOriginal._id}/translate`, { cookie: superCookie, body: { force } });
      expect(res.status).toBe(200);
      // en is an independent original; fr is owned by the live en original.
      expect(byLocale(res.body.translations)).toEqual({ en: 'skipped_manual', fr: 'skipped_manual' });
      expect(fixture.requests).toHaveLength(0);
      expect(await snapshot(enId)).toEqual(enBefore);
      expect(await snapshot(frId)).toEqual(frBefore);
      expect(await snapshot(nlOriginal._id)).toEqual(nlBefore);
    }
  });

  it('missing originals: an orphan machine row is adopted; an unlinked manual row with a dangling link is not', async () => {
    setMode('configured');
    const first = blog({ status: 'published' });
    const firstCreated = await call('POST', '/api/admin/cms', { cookie: superCookie, body: first });
    const firstId = firstCreated.body.data._id;
    const orphanNl = (await family(firstId)).find((v) => v.locale === 'nl')!;
    const orphanFr = (await family(firstId)).find((v) => v.locale === 'fr')!;
    // The fr row becomes a manual row, then the original disappears without the
    // delete handler (no detach), leaving both rows with a dangling translatedFrom.
    await CmsContent.updateOne({ _id: orphanFr._id }, { $set: { autoTranslated: false, title: 'Manuel orphelin' } });
    await CmsContent.deleteOne({ _id: firstId });
    const frBefore = await snapshot(orphanFr._id);

    const second = { ...first, title: 'A new original', tags: [TAG] };
    for (const force of [false, true]) {
      fixture.requests.length = 0;
      const res = force
        ? await call('POST', `/api/admin/cms/${secondId!}/translate`, { cookie: superCookie, body: { force: true } })
        : await call('POST', '/api/admin/cms', { cookie: superCookie, body: second });
      if (!force) secondId = res.body.data._id;
      expect(byLocale(res.body.translations)).toEqual({ nl: 'updated', fr: 'skipped_manual' });
      expect(providerCallsTo('fr')).toBe(0);
      expect(await snapshot(orphanFr._id)).toEqual(frBefore);
    }
    // The orphan machine nl now belongs to the new original and carries its text.
    expect(await doc(orphanNl._id)).toMatchObject({
      autoTranslated: true,
      translatedFrom: new Types.ObjectId(secondId!),
      title: '[nl] A new original',
    });
    expect((await doc(orphanFr._id)).translatedFrom).toEqual(new Types.ObjectId(firstId));
  });
});
let secondId: string | undefined;
