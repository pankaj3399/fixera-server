/**
 * CMS auto-translation, async design (v2 contract): background runs, the
 * status endpoint, the lease, and the races a background run must survive.
 *
 * Real admin + public routers and REAL MongoDB; the Azure Translator is a
 * LOCAL 127.0.0.1 HTTP fixture speaking the Translator v3 wire format, with a
 * per-locale "hold" so a test can act while a run is mid-flight. Nothing
 * leaves the machine (tests/setup/providerIsolation).
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cms-translate-async-test-secret';
  process.env.S3_BUCKET_NAME = 'fixera-test-bucket';
  process.env.AZURE_TRANSLATOR_KEY = '';
  process.env.AZURE_TRANSLATOR_REGION = '';
});

vi.mock('../../utils/s3Upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/s3Upload')>();
  return { ...actual, deleteFromS3: vi.fn(async () => undefined) };
});

import adminRouter from '../../routes/Admin';
import publicRouter from '../../routes/Public';
import CmsContent from '../../models/cmsContent';
import User from '../../models/user';
import { computeSourceHash } from '../../utils/cms/syncTranslations';
import { waitForCmsTranslationJobs } from '../../utils/cms/translationQueue';
import { skipTranslatorBackoff } from './cmsTranslationSettle';

const TAG = 'cmstrasync-it';
const cover = (name: string) => `https://fixera-test-bucket.s3.eu-west-1.amazonaws.com/cms/${TAG}-${name}.jpg`;

// ---------------------------------------------------------------- transport fixture
type Held = { to: string; release: () => void };
const fixture = {
  requests: [] as Array<{ to: string; textType: string; texts: string[] }>,
  failLocales: new Set<string>(),
  holdLocales: new Set<string>(),
  held: [] as Held[],
};

const translatorServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    let texts: string[] = [];
    try {
      texts = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Array<{ Text: string }>).map((e) => e.Text);
    } catch {
      texts = [];
    }
    const to = url.searchParams.get('to') || '';
    const textType = url.searchParams.get('textType') || '';
    fixture.requests.push({ to, textType, texts });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['ocp-apim-subscription-key'] !== FIXTURE_KEY) {
      return send(401, { error: { code: 401000, message: 'not authorized' } });
    }
    if (fixture.holdLocales.has(to)) {
      await new Promise<void>((release) => fixture.held.push({ to, release }));
    }
    if (fixture.failLocales.has(to)) return send(500, { error: { code: 500000, message: 'boom' } });
    send(
      200,
      texts.map((text) => ({
        translations: [
          { to, text: textType === 'html' ? text.replace(/>([^<])/, `>[${to}] $1`) : `[${to}] ${text}` },
        ],
      })),
    );
  });
});

/** Waits until the fixture is holding a request for `to`. */
async function heldRequest(to: string): Promise<Held> {
  for (let i = 0; i < 500; i += 1) {
    const found = fixture.held.find((h) => h.to === to);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no held translator request for ${to}`);
}

function releaseAll() {
  fixture.holdLocales.clear();
  for (const held of fixture.held.splice(0)) held.release();
}

// ---------------------------------------------------------------- app + auth
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/public', publicRouter);
let apiServer: Server;
let api = '';

const cookieFor = (user: { _id: unknown }) =>
  `auth-token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
let superCookie = '';
let readOnlyCookie = '';
let customerCookie = '';

/** Raw call: no waiting for background runs (tests here control that). */
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
  expect(text).not.toContain(FIXTURE_KEY);
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

const configureTranslator = (on: boolean) => {
  process.env.AZURE_TRANSLATOR_KEY = on ? FIXTURE_KEY : '';
};
const states = (status: { locales: Array<{ locale: string; state: string }> }) =>
  Object.fromEntries(status.locales.map((l) => [l.locale, l.state]));
const statusOf = async (id: string) => {
  const res = await call('GET', `/api/admin/cms/${id}/translations`, { cookie: superCookie });
  expect(res.status).toBe(200);
  return res.body.data;
};
const lastResults = async (id: string) =>
  Object.fromEntries(
    (((await CmsContent.findById(id).lean())?.translationResults ?? []) as any[]).map((r) => [
      r.locale,
      r.errorCode ? `${r.status}:${r.errorCode}` : r.status,
    ]),
  );
const variant = (sourceId: string, locale: string) =>
  CmsContent.findOne({ translatedFrom: sourceId, locale }).lean();

let seq = 0;
const blog = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    type: 'blog',
    locale: 'en',
    title: `Insulation guide ${seq}`,
    slug: `${TAG}-guide-${seq}`,
    body: '<p>Warm homes.</p>',
    excerpt: 'Intro',
    coverImage: cover(`c${seq}`),
    tags: [TAG],
    status: 'published',
    activeCountries: [],
    ...over,
  };
};

/** Creates a source and waits for its first background run. */
async function createSettled(over: Record<string, unknown> = {}) {
  const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: blog(over) });
  expect(created.status).toBe(201);
  await waitForCmsTranslationJobs();
  return created.body.data as Record<string, any>;
}

describeDb('CMS auto-translation async runs (real MongoDB, local translator fixture)', () => {
  beforeAll(async () => {
    skipTranslatorBackoff();
    await mongoose.connect(testUri!);
    await CmsContent.deleteMany({ $or: [{ tags: TAG }, { slug: new RegExp(`^${TAG}`) }] });
    await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
    const mk = (adminRole: string | undefined, role = 'admin', extra: Record<string, unknown> = {}) =>
      User.create({
        name: `${TAG} ${adminRole || role}`,
        email: `${adminRole || role}-${new Types.ObjectId().toHexString()}@${TAG}.example`,
        phone: `+3249${Math.floor(Math.random() * 1e7)}`,
        password: 'not-used-hash',
        role,
        ...(adminRole ? { adminRole } : {}),
        isEmailVerified: true,
        accountStatus: 'active',
        ...extra,
      });
    superCookie = cookieFor(await mk('super'));
    readOnlyCookie = cookieFor(await mk('care', 'admin', { adminPermissionLevels: { cms: 'read' } }));
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
    releaseAll();
    await waitForCmsTranslationJobs();
    configureTranslator(false);
    await new Promise<void>((resolve) => (apiServer ? apiServer.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => translatorServer.close(() => resolve()));
    if (mongoose.connection.readyState === 1) {
      await CmsContent.deleteMany({ $or: [{ tags: TAG }, { slug: new RegExp(`^${TAG}`) }] });
      await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    releaseAll();
    await waitForCmsTranslationJobs();
    fixture.requests.length = 0;
    fixture.failLocales.clear();
    configureTranslator(true);
  });

  it('a save answers pending before the provider runs; the status endpoint reports progress and the outcome', async () => {
    fixture.holdLocales.add('nl');
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: blog() });
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    expect(created.body.translations).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'pending' },
    ]);
    expect(created.body.data.translationStatus).toMatchObject({ enabled: true, sourceId: id, sourceLocale: 'en' });
    expect(created.body.data.localeVariants).toEqual([]);

    // Mid-run: the lease is held and both targets are still pending.
    await heldRequest('nl');
    const running = await statusOf(id);
    expect(running).toMatchObject({ running: true, queued: false });
    expect(states(running)).toEqual({ en: 'source', nl: 'pending', fr: 'pending' });
    expect(running.locales[0].document).toMatchObject({ _id: id, autoTranslated: false });

    releaseAll();
    await waitForCmsTranslationJobs();
    const done = await statusOf(id);
    expect(done).toMatchObject({ running: false, queued: false });
    expect(typeof done.lastRunAt).toBe('string');
    expect(states(done)).toEqual({ en: 'source', nl: 'up_to_date', fr: 'up_to_date' });
    expect(done.locales[1].lastResult).toMatchObject({ locale: 'nl', status: 'created' });
    expect(done.locales[1].document).toMatchObject({ autoTranslated: true, translatedFrom: id, status: 'published' });

    // Any member of the family resolves to the source; GET by id embeds the status.
    const nl = await variant(id, 'nl');
    expect((await statusOf(String(nl!._id))).sourceId).toBe(id);
    const byId = await call('GET', `/api/admin/cms/${nl!._id}`, { cookie: superCookie });
    expect(byId.body.data.translationStatus.sourceId).toBe(id);
    expect(byId.body.data.localeVariants.map((v: any) => v.locale)).toEqual(['en', 'fr']);

    // Bookkeeping never touches the source's updatedAt.
    const source = await CmsContent.findById(id).lean();
    expect(source!.updatedAt.toISOString()).toBe(created.body.data.updatedAt);
  });

  it('status endpoint: 400 / 404 / auth, read access is enough to poll', async () => {
    const source = await createSettled();
    expect((await call('GET', '/api/admin/cms/not-an-id/translations', { cookie: superCookie })).body).toEqual({
      success: false,
      msg: 'Invalid content ID',
    });
    const missing = await call('GET', `/api/admin/cms/${new Types.ObjectId()}/translations`, { cookie: superCookie });
    expect(missing).toEqual({ status: 404, body: { success: false, msg: 'Content not found' } });
    expect((await call('GET', `/api/admin/cms/${source._id}/translations`)).status).toBe(401);
    expect((await call('GET', `/api/admin/cms/${source._id}/translations`, { cookie: customerCookie })).status).toBe(403);

    const readOnly = await call('GET', `/api/admin/cms/${source._id}/translations`, { cookie: readOnlyCookie });
    expect(readOnly.status).toBe(200);
    expect(readOnly.body.data.sourceId).toBe(source._id);
    expect((await call('POST', `/api/admin/cms/${source._id}/translate`, { cookie: readOnlyCookie, body: {} })).status).toBe(403);

    for (const body of [{ locales: ['de'] }, { locales: 'fr' }, { force: 'true' }]) {
      const bad = await call('POST', `/api/admin/cms/${source._id}/translate`, { cookie: superCookie, body });
      expect(bad.status).toBe(400);
    }
  });

  it('reports every per-locale state: source, up_to_date, stale, missing, failed, manual, blocked', async () => {
    // up_to_date -> manual / stale
    const a = await createSettled();
    expect(states(await statusOf(a._id))).toEqual({ en: 'source', nl: 'up_to_date', fr: 'up_to_date' });
    const aNl = await variant(a._id, 'nl');
    await call('PUT', `/api/admin/cms/${aNl!._id}`, { cookie: superCookie, body: { title: 'Eigen titel' } });
    configureTranslator(false);
    const edited = await call('PUT', `/api/admin/cms/${a._id}`, { cookie: superCookie, body: { title: 'Changed' } });
    expect(edited.body.translations).toEqual([
      { locale: 'nl', status: 'skipped_manual' },
      { locale: 'fr', status: 'disabled' },
    ]);
    const aStatus = await statusOf(a._id);
    expect(aStatus.enabled).toBe(false);
    expect(states(aStatus)).toEqual({ en: 'source', nl: 'manual', fr: 'stale' });

    // missing (translator off at create)
    const b = await createSettled();
    expect(states(await statusOf(b._id))).toEqual({ en: 'source', nl: 'missing', fr: 'missing' });

    // blocked: an independent fr original already owns the slug
    const slug = `${TAG}-blocked-${++seq}`;
    await createSettled({ slug, locale: 'fr', title: 'Guide indépendant' });
    configureTranslator(true);
    const c = await createSettled({ slug });
    const cStatus = await statusOf(c._id);
    expect(states(cStatus)).toEqual({ en: 'source', nl: 'up_to_date', fr: 'blocked' });
    expect(cStatus.locales[2].document).toMatchObject({ slug, autoTranslated: false });
    expect(cStatus.locales[2].document.translatedFrom).toBeUndefined();

    // failed: the provider keeps failing for nl
    fixture.failLocales.add('nl');
    const d = await createSettled();
    const dStatus = await statusOf(d._id);
    expect(states(dStatus)).toEqual({ en: 'source', nl: 'failed', fr: 'up_to_date' });
    expect(dStatus.locales[1].lastResult).toMatchObject({ status: 'failed', errorCode: 'provider_error' });
    expect(dStatus.locales[1].document).toBeUndefined();

    // a retry clears it
    fixture.failLocales.clear();
    const retry = await call('POST', `/api/admin/cms/${d._id}/translate`, { cookie: superCookie, body: {} });
    expect(retry.body.translations).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'synced' },
    ]);
    expect(states(retry.body.data)).toMatchObject({ nl: 'pending' });
    await waitForCmsTranslationJobs();
    expect(states(await statusOf(d._id))).toEqual({ en: 'source', nl: 'up_to_date', fr: 'up_to_date' });
  });

  it('a machine translation an admin takes over mid-run is not overwritten', async () => {
    const source = await createSettled();
    const nl = await variant(source._id, 'nl');

    fixture.holdLocales.add('nl');
    const edited = await call('PUT', `/api/admin/cms/${source._id}`, { cookie: superCookie, body: { title: 'Retitled' } });
    expect(edited.body.translations).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'pending' },
    ]);
    const held = await heldRequest('nl');

    // The admin saves the nl machine row while its new text is being translated.
    const takeover = await call('PUT', `/api/admin/cms/${nl!._id}`, { cookie: superCookie, body: { title: 'Mijn titel' } });
    expect(takeover.status).toBe(200);
    held.release();
    releaseAll();
    await waitForCmsTranslationJobs();

    expect(await CmsContent.findById(nl!._id).lean()).toMatchObject({ title: 'Mijn titel', autoTranslated: false });
    expect(await lastResults(source._id)).toEqual({ nl: 'skipped_manual', fr: 'updated' });
    expect((await variant(source._id, 'fr'))!.title).toBe('[fr] Retitled');
    expect(states(await statusOf(source._id))).toEqual({ en: 'source', nl: 'manual', fr: 'up_to_date' });
  });

  it('a forced manual translation edited mid-run is kept and reported changed_during_run', async () => {
    const source = await createSettled();
    const nl = await variant(source._id, 'nl');
    await call('PUT', `/api/admin/cms/${nl!._id}`, { cookie: superCookie, body: { title: 'Handmatig' } });

    fixture.holdLocales.add('nl');
    const forced = await call('POST', `/api/admin/cms/${source._id}/translate`, {
      cookie: superCookie,
      body: { force: true, locales: ['nl'] },
    });
    expect(forced.body.translations).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'synced' },
    ]);
    expect(states(forced.body.data)).toMatchObject({ nl: 'pending', fr: 'up_to_date' });
    await heldRequest('nl');
    await call('PUT', `/api/admin/cms/${nl!._id}`, { cookie: superCookie, body: { title: 'Handmatig, net bewerkt' } });
    releaseAll();
    await waitForCmsTranslationJobs();

    expect(await CmsContent.findById(nl!._id).lean()).toMatchObject({
      title: 'Handmatig, net bewerkt',
      autoTranslated: false,
    });
    expect(await lastResults(source._id)).toMatchObject({ nl: 'failed:changed_during_run' });
    expect(states(await statusOf(source._id))).toMatchObject({ nl: 'manual' });

    // Without a concurrent edit the forced overwrite goes through.
    await call('POST', `/api/admin/cms/${source._id}/translate`, { cookie: superCookie, body: { force: true, locales: ['nl'] } });
    await waitForCmsTranslationJobs();
    expect(await CmsContent.findById(nl!._id).lean()).toMatchObject({
      title: `[nl] ${source.title}`,
      autoTranslated: true,
    });
    expect(await lastResults(source._id)).toMatchObject({ nl: 'updated' });
  });

  it('two quick saves coalesce under one lease and end with the latest text', async () => {
    const source = await createSettled();
    fixture.requests.length = 0;
    fixture.holdLocales.add('nl');
    await call('PUT', `/api/admin/cms/${source._id}`, { cookie: superCookie, body: { title: 'Second title' } });
    await heldRequest('nl');

    // Saved while the first run holds the lease: only marks a re-run, and
    // unpublishes, which must not be undone by the in-flight run's write.
    const third = await call('PUT', `/api/admin/cms/${source._id}`, {
      cookie: superCookie,
      body: { title: 'Third title', status: 'draft' },
    });
    expect(third.body.translations).toEqual([
      { locale: 'nl', status: 'pending' },
      { locale: 'fr', status: 'pending' },
    ]);
    const mid = await CmsContent.findById(source._id).lean();
    expect(mid!.translationRun).toMatchObject({ requested: true });
    expect(mid!.translationRun!.runId).toBeTruthy();
    // The request-time pass already mirrored the unpublish.
    expect((await variant(source._id, 'nl'))!.status).toBe('draft');

    releaseAll();
    await waitForCmsTranslationJobs();

    const final = await CmsContent.findById(source._id).lean();
    expect(final!.translationRun).toMatchObject({ requested: false });
    expect(final!.translationRun!.runId).toBeUndefined();
    // One final result per locale from the last run: nl was re-translated;
    // fr was first translated after the third save (each locale re-reads the
    // source), so the re-run found it current.
    expect(final!.translationResults!.map((r) => [r.locale, r.status])).toEqual([
      ['nl', 'updated'],
      ['fr', 'synced'],
    ]);
    const hash = computeSourceHash(final!);
    for (const locale of ['nl', 'fr']) {
      const row = await variant(source._id, locale);
      expect(row).toMatchObject({ title: `[${locale}] Third title`, sourceHash: hash, status: 'draft' });
      expect(row!.publishedAt).toBeUndefined();
    }
    // Both texts were sent; the first run's (stale) result was replaced.
    const titles = (to: string) =>
      fixture.requests.filter((r) => r.to === to && r.textType === 'plain').map((r) => r.texts[0]);
    expect(titles('nl')).toEqual(['Second title', 'Third title']);
    expect(titles('fr')).toEqual(['Third title']);
  });

  it('a run whose worker died is reported interrupted and re-scheduled by the next status read', async () => {
    configureTranslator(false);
    const source = await createSettled();
    configureTranslator(true);
    const past = new Date(Date.now() - 60_000);

    // Dead worker, nothing else requested: interrupted, not retried by itself.
    await CmsContent.updateOne(
      { _id: source._id },
      { $set: { translationRun: { requested: false, runId: 'dead-run', leaseUntil: past, startedAt: past } } },
      { timestamps: false },
    );
    const dead = await statusOf(source._id);
    expect(dead).toMatchObject({ running: false, queued: false });
    expect(states(dead)).toEqual({ en: 'source', nl: 'failed', fr: 'failed' });
    expect(dead.locales[1].lastResult).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect((await CmsContent.findById(source._id).lean())!.translationRun!.runId).toBeUndefined();
    await waitForCmsTranslationJobs();
    expect(fixture.requests).toHaveLength(0);

    // Dead worker with a pending request: the status read schedules a new run.
    await CmsContent.updateOne(
      { _id: source._id },
      { $set: { translationRun: { requested: true, runId: 'dead-run-2', leaseUntil: past, startedAt: past } } },
      { timestamps: false },
    );
    const healed = await statusOf(source._id);
    expect(healed.queued || healed.running).toBe(true);
    expect(states(healed)).toEqual({ en: 'source', nl: 'pending', fr: 'pending' });
    await waitForCmsTranslationJobs();
    const done = await statusOf(source._id);
    expect(states(done)).toEqual({ en: 'source', nl: 'up_to_date', fr: 'up_to_date' });
    expect(await lastResults(source._id)).toEqual({ nl: 'created', fr: 'created' });
  });

  it('a source deleted mid-run leaves no machine translation behind', async () => {
    fixture.holdLocales.add('fr');
    const created = await call('POST', '/api/admin/cms', { cookie: superCookie, body: blog() });
    const id = created.body.data._id;
    await heldRequest('fr'); // nl is already written, fr is in flight
    expect(await variant(id, 'nl')).not.toBeNull();

    const removed = await call('DELETE', `/api/admin/cms/${id}`, { cookie: superCookie });
    expect(removed.status).toBe(200);
    releaseAll();
    await waitForCmsTranslationJobs();

    expect(await CmsContent.countDocuments({ translatedFrom: id })).toBe(0);
    expect(await CmsContent.countDocuments({ slug: created.body.data.slug })).toBe(0);
    expect((await call('GET', `/api/admin/cms/${id}/translations`, { cookie: superCookie })).status).toBe(404);
  });

  it('translated plain fields are clamped to the schema limits instead of failing the write', async () => {
    const longTitle = `${'Insulation '.repeat(27)}end`.slice(0, 298); // "[fr] " pushes it past 300
    const source = await createSettled({ title: longTitle, excerpt: 'x'.repeat(498) });
    expect(await lastResults(source._id)).toEqual({ nl: 'created', fr: 'created' });
    const fr = await variant(source._id, 'fr');
    expect(fr!.title.length).toBeLessThanOrEqual(300);
    expect(fr!.title.startsWith('[fr] Insulation')).toBe(true);
    expect(fr!.title.endsWith('…')).toBe(true);
    expect(fr!.excerpt!.length).toBeLessThanOrEqual(500);
  });

  it('public reads never expose translation bookkeeping, but keep autoTranslated', async () => {
    const source = await createSettled();
    const headers = { 'x-fixera-content-country': 'BE', 'x-vercel-ip-country': 'BE' };
    const internal = ['sourceHash', 'translationRun', 'translationResults'];

    const nl = await call('GET', `/api/public/cms/blog/${source.slug}?locale=nl`, { headers });
    expect(nl.status).toBe(200);
    expect(nl.body.data).toMatchObject({ locale: 'nl', autoTranslated: true });
    const en = await call('GET', `/api/public/cms/blog/${source.slug}?locale=en`, { headers });
    expect(en.body.data).toMatchObject({ locale: 'en', autoTranslated: false });
    // The source really carries the bookkeeping in the DB.
    expect((await CmsContent.findById(source._id).lean())!.translationResults).toHaveLength(2);

    const list = await call('GET', `/api/public/cms/blog?locale=nl&limit=50`, { headers });
    const items = list.body.data.items as any[];
    expect(items.some((item) => item.slug === source.slug)).toBe(true);
    for (const payload of [nl.body.data, en.body.data, ...items]) {
      for (const field of internal) expect(payload).not.toHaveProperty(field);
    }
  });
});
