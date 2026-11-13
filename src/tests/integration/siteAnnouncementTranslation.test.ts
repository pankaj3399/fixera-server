/**
 * Site announcement auto-translation: admin routes + public route + REAL
 * MongoDB, with the Azure Translator replaced by a LOCAL 127.0.0.1 HTTP
 * fixture speaking the Translator v3 wire format. Nothing leaves the machine
 * (tests/setup/providerIsolation).
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'announcement-translate-test-secret';
  process.env.AZURE_TRANSLATOR_KEY = '';
  process.env.AZURE_TRANSLATOR_REGION = '';
});

import adminRouter from '../../routes/Admin';
import publicRouter from '../../routes/Public';
import SiteAnnouncement from '../../models/siteAnnouncement';
import User from '../../models/user';
import { translatorTiming } from '../../utils/cms/azureTranslator';
import { waitForAnnouncementTranslationJobs } from '../../utils/siteAnnouncements/translation';
import { fakeTranslateHtml } from '../utils/translation/fakeAzure';

const TAG = 'anntr-it';

const fixture = {
  requests: [] as Array<{ from: string; to: string; texts: string[] }>,
  failLocales: new Set<string>(),
};

const translatorServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const texts = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]') as Array<{ Text: string }>).map(
      (e) => e.Text,
    );
    const to = url.searchParams.get('to') || '';
    const from = url.searchParams.get('from') || '';
    fixture.requests.push({ from, to, texts });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['ocp-apim-subscription-key'] !== FIXTURE_KEY) {
      return send(401, { error: { code: 401000, message: 'not authorized' } });
    }
    if (fixture.failLocales.has(to)) return send(400, { error: { code: 400000, message: 'boom' } });
    send(
      200,
      texts.map((text) => ({ translations: [{ to, text: fakeTranslateHtml(text, to) }] })),
    );
  });
});

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

const call = async (method: string, path: string, options: { cookie?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
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

let seq = 0;
const announcement = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    name: `${TAG} promo ${seq}`,
    type: 'modal',
    title: `Spring deal ${seq}`,
    message: 'Use code SPRING10 for 10% off your first booking.',
    ctaLabel: 'Book now',
    ctaUrl: '/services',
    discountCode: 'SPRING10',
    activeCountries: ['BE'],
    locale: 'en',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    // Highest priority so this test's announcement wins its type.
    priority: 1_000 + seq,
    ...over,
  };
};

async function create(over: Record<string, unknown> = {}) {
  const created = await call('POST', '/api/admin/site-announcements', { cookie: superCookie, body: announcement(over) });
  expect(created.status).toBe(201);
  await waitForAnnouncementTranslationJobs();
  return created.body.data.announcement as Record<string, any>;
}

const statusOf = async (id: string) => {
  const res = await call('GET', `/api/admin/site-announcements/${id}/translations`, { cookie: superCookie });
  expect(res.status).toBe(200);
  return res.body.data.translationStatus as Record<string, any>;
};
const states = (status: { locales: Array<{ locale: string; state: string }> }) =>
  Object.fromEntries(status.locales.map((l) => [l.locale, l.state]));

const publicModal = async (locale: string, id: string) => {
  const res = await call('GET', `/api/public/site-announcements?locale=${locale}&country=BE&type=modal`);
  expect(res.status).toBe(200);
  const found = (res.body.data.announcements as Array<Record<string, any>>).find((a) => a._id === id);
  return found;
};

describeDb('site announcement auto-translation (real MongoDB, local translator fixture)', () => {
  beforeAll(async () => {
    translatorTiming.sleep = async () => undefined;
    await mongoose.connect(testUri!);
    await SiteAnnouncement.deleteMany({ name: new RegExp(`^${TAG}`) });
    await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
    const mk = (adminRole: string, extra: Record<string, unknown> = {}) =>
      User.create({
        name: `${TAG} ${adminRole}`,
        email: `${adminRole}-${new Types.ObjectId().toHexString()}@${TAG}.example`,
        phone: `+3249${Math.floor(Math.random() * 1e7)}`,
        password: 'not-used-hash',
        role: 'admin',
        adminRole,
        isEmailVerified: true,
        accountStatus: 'active',
        ...extra,
      });
    superCookie = cookieFor(await mk('super'));
    readOnlyCookie = cookieFor(await mk('care', { adminPermissionLevels: { cms: 'read' } }));

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
    await waitForAnnouncementTranslationJobs();
    configureTranslator(false);
    await new Promise<void>((resolve) => (apiServer ? apiServer.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => translatorServer.close(() => resolve()));
    if (mongoose.connection.readyState === 1) {
      await SiteAnnouncement.deleteMany({ name: new RegExp(`^${TAG}`) });
      await User.deleteMany({ email: new RegExp(`@${TAG}\\.example$`) });
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await waitForAnnouncementTranslationJobs();
    fixture.requests.length = 0;
    fixture.failLocales.clear();
    configureTranslator(true);
  });

  it('without a translator key behaves exactly as before: nothing scheduled, source text served', async () => {
    configureTranslator(false);
    const created = await create();
    expect(fixture.requests).toHaveLength(0);
    const stored = await SiteAnnouncement.findById(created._id).lean();
    expect(stored?.translationRun?.requested).toBeUndefined();
    expect(stored?.translations?.nl).toBeUndefined();

    const status = await statusOf(created._id);
    expect(status.enabled).toBe(false);
    expect(states(status as any)).toEqual({ en: 'source', nl: 'missing', fr: 'missing' });

    const served = await publicModal('nl', created._id);
    expect(served).toMatchObject({ title: created.title, message: created.message, locale: 'en', translated: false });

    const retry = await call('POST', `/api/admin/site-announcements/${created._id}/translations/run`, {
      cookie: superCookie,
      body: {},
    });
    expect(retry.status).toBe(409);
  });

  it('translates after the response into nl and fr, protects the discount code, and serves the visitor language', async () => {
    const created = await create();
    const stored = (await SiteAnnouncement.findById(created._id).lean()) as Record<string, any>;
    expect(stored.translations.nl).toMatchObject({ mode: 'machine', sourceHash: stored.translationSourceHash });
    expect(stored.translations.nl.title).toBe(`nl:${created.title}`);
    expect(stored.translations.fr.ctaLabel).toBe('fr:Book now');
    // The discount code was protected (sent inside translate="no"), so it is byte-identical.
    expect(stored.translations.nl.message).toContain('SPRING10');
    expect(fixture.requests.map((r) => r.to).sort()).toEqual(['fr', 'nl']);
    expect(fixture.requests.every((r) => r.texts.every((t) => !/(^|[^_])SPRING10/.test(t.replace(/<span[^>]*>[^<]*<\/span>/g, ''))))).toBe(true);
    // Translation bookkeeping never bumps updatedAt (visitor dismissal version).
    expect(new Date(stored.updatedAt).toISOString()).toBe(new Date(created.updatedAt).toISOString());

    expect(states((await statusOf(created._id)) as any)).toEqual({ en: 'source', nl: 'up_to_date', fr: 'up_to_date' });

    const nl = await publicModal('nl', created._id);
    expect(nl).toMatchObject({ title: `nl:${created.title}`, locale: 'nl', sourceLocale: 'en', translated: true });
    expect(nl).not.toHaveProperty('translations');
    expect(nl).not.toHaveProperty('translationRun');
    const en = await publicModal('en', created._id);
    expect(en).toMatchObject({ title: created.title, locale: 'en', translated: false });

    // Admin responses never expose run bookkeeping.
    const adminGet = await call('GET', `/api/admin/site-announcements/${created._id}`, { cookie: superCookie });
    expect(adminGet.body.data.announcement).not.toHaveProperty('translationRun');
    expect(adminGet.body.data.translationStatus.locales).toHaveLength(3);
  });

  it('keeps a manual translation when the source changes, refreshes machine ones, and overwrites only when forced', async () => {
    const created = await create();
    const manual = await call('PUT', `/api/admin/site-announcements/${created._id}/translations/nl`, {
      cookie: superCookie,
      body: { title: 'Lentedeal (handmatig)', message: 'Gebruik SPRING10 voor korting.', ctaLabel: 'Boek nu' },
    });
    expect(manual.status).toBe(200);
    expect(states(manual.body.data.translationStatus)).toMatchObject({ nl: 'manual' });

    fixture.requests.length = 0;
    const patched = await call('PATCH', `/api/admin/site-announcements/${created._id}`, {
      cookie: superCookie,
      body: { title: 'Summer deal' },
    });
    expect(patched.status).toBe(200);
    await waitForAnnouncementTranslationJobs();
    expect(fixture.requests.map((r) => r.to)).toEqual(['fr']);

    const stored = (await SiteAnnouncement.findById(created._id).lean()) as Record<string, any>;
    expect(stored.translations.nl).toMatchObject({ mode: 'manual', title: 'Lentedeal (handmatig)' });
    expect(stored.translations.fr.title).toBe('fr:Summer deal');
    const status = await statusOf(created._id);
    const nlStatus = status.locales.find((l: any) => l.locale === 'nl');
    expect(nlStatus).toMatchObject({ state: 'manual', sourceChanged: true });
    expect((await publicModal('nl', created._id))?.title).toBe('Lentedeal (handmatig)');

    // Retry without force leaves manual text alone.
    await call('POST', `/api/admin/site-announcements/${created._id}/translations/run`, { cookie: superCookie, body: {} });
    await waitForAnnouncementTranslationJobs();
    expect(((await SiteAnnouncement.findById(created._id).lean()) as any).translations.nl.mode).toBe('manual');

    // Forcing nl overwrites the manual translation with a fresh machine one.
    const forced = await call('POST', `/api/admin/site-announcements/${created._id}/translations/run`, {
      cookie: superCookie,
      body: { locales: ['nl'], force: true },
    });
    expect(forced.status).toBe(202);
    await waitForAnnouncementTranslationJobs();
    const after = (await SiteAnnouncement.findById(created._id).lean()) as any;
    expect(after.translations.nl).toMatchObject({ mode: 'machine', title: 'nl:Summer deal' });
  });

  it('reports a failed locale and retries it', async () => {
    fixture.failLocales.add('fr');
    const created = await create();
    let status = await statusOf(created._id);
    expect(states(status as any)).toEqual({ en: 'source', nl: 'up_to_date', fr: 'failed' });
    const fr = status.locales.find((l: any) => l.locale === 'fr');
    expect(fr.lastResult).toMatchObject({ status: 'failed', errorCode: 'provider_error' });
    expect(fr.lastResult.error).not.toContain('boom'); // fixed copy, never provider text
    // Visitors in fr get the source text meanwhile.
    expect(await publicModal('fr', created._id)).toMatchObject({ title: created.title, translated: false });

    fixture.failLocales.clear();
    const retry = await call('POST', `/api/admin/site-announcements/${created._id}/translations/run`, {
      cookie: superCookie,
      body: {},
    });
    expect(retry.status).toBe(202);
    await waitForAnnouncementTranslationJobs();
    status = await statusOf(created._id);
    expect(states(status as any)).toEqual({ en: 'source', nl: 'up_to_date', fr: 'up_to_date' });
  });

  it('never serves a stale machine translation (source edited while the translator is off)', async () => {
    const created = await create();
    configureTranslator(false);
    await call('PATCH', `/api/admin/site-announcements/${created._id}`, {
      cookie: superCookie,
      body: { message: 'New terms apply from June.' },
    });
    const nl = await publicModal('nl', created._id);
    expect(nl).toMatchObject({ message: 'New terms apply from June.', translated: false, locale: 'en' });
    expect(states((await statusOf(created._id)) as any)).toMatchObject({ nl: 'stale', fr: 'stale' });
  });

  it('a French-source announcement reaches Dutch visitors only through its translation', async () => {
    configureTranslator(false);
    const created = await create({ locale: 'fr', title: 'Offre de printemps', message: 'Réservez maintenant.' });
    expect(await publicModal('nl', created._id)).toBeUndefined();

    configureTranslator(true);
    await call('POST', `/api/admin/site-announcements/${created._id}/translations/run`, { cookie: superCookie, body: {} });
    await waitForAnnouncementTranslationJobs();
    expect(fixture.requests.every((r) => r.from === 'fr')).toBe(true);
    expect(await publicModal('nl', created._id)).toMatchObject({ title: 'nl:Offre de printemps', locale: 'nl', translated: true });
  });

  it('changing the source language drops the translation for the new source language', async () => {
    const created = await create();
    await call('PATCH', `/api/admin/site-announcements/${created._id}`, {
      cookie: superCookie,
      body: { locale: 'nl', title: 'Lentedeal', message: 'Gebruik SPRING10.', ctaLabel: 'Boek' },
    });
    await waitForAnnouncementTranslationJobs();
    const stored = (await SiteAnnouncement.findById(created._id).lean()) as any;
    expect(stored.translations.nl).toBeUndefined();
    expect(stored.translations.en.title).toBe('en:Lentedeal');
    expect(states((await statusOf(created._id)) as any)).toEqual({ en: 'up_to_date', nl: 'source', fr: 'up_to_date' });
  });

  it('validates manual translation input and permissions', async () => {
    const created = await create();
    const source = await call('PUT', `/api/admin/site-announcements/${created._id}/translations/en`, {
      cookie: superCookie,
      body: { title: 'x title', message: 'x message' },
    });
    expect(source.status).toBe(400);
    const bad = await call('PUT', `/api/admin/site-announcements/${created._id}/translations/de`, {
      cookie: superCookie,
      body: { title: 'Titel', message: 'Nachricht' },
    });
    expect(bad.status).toBe(400);
    const empty = await call('PUT', `/api/admin/site-announcements/${created._id}/translations/nl`, {
      cookie: superCookie,
      body: { title: '', message: '' },
    });
    expect(empty.status).toBe(400);
    const readOnly = await call('PUT', `/api/admin/site-announcements/${created._id}/translations/nl`, {
      cookie: readOnlyCookie,
      body: { title: 'Titel', message: 'Bericht' },
    });
    expect(readOnly.status).toBe(403);
  });
});
