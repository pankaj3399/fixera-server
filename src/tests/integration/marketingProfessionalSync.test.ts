import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-professional-sync-secret';
  process.env.EMAIL_DEV_NO_SEND = 'true';
  process.env.MARKETING_CAMPAIGN_DRY_RUN = 'true';
});

import adminRouter from '../../routes/Admin';
import userRouter from '../../routes/User';
import errorHandler from '../../handlers/error';
import User from '../../models/user';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingLead from '../../models/marketingLead';
import MarketingSuppression from '../../models/marketingSuppression';
import ServiceConfiguration from '../../models/serviceConfiguration';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';
import { leadIdentityHash, normalizeLeadServiceKeys } from '../../utils/marketing/leadIdentity';
import { resolveMarketingAudience } from '../../utils/marketing/audienceResolver';
import { providerNetworkAttempts } from '../setup/providerIsolation';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri) && /^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

let server: Server;
let baseUrl = '';
let admin: any;
let adminCookie = '';

const request = async (
  method: string,
  path: string,
  options: { body?: any; cookie?: string | null } = {},
) => {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const cookieFor = (user: any) =>
  `auth-token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;

const createAdmin = async () => {
  const password = await bcrypt.hash('secret123', 4);
  return User.create({
    name: 'Sync Admin',
    email: `sync-admin-${new Types.ObjectId().toHexString()}@example.com`,
    phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password,
    role: 'admin',
    adminRole: 'super',
    isEmailVerified: true,
    accountStatus: 'active',
  });
};

const createUser = async (input: {
  email: string;
  role: 'customer' | 'professional';
  country?: string;
  marketingLocale?: string;
  services?: string[];
  promotions?: boolean;
  consent?: Date | null;
  deletedAt?: Date | null;
}) => {
  const password = await bcrypt.hash('secret123', 4);
  return User.create({
    name: input.role === 'professional' ? 'Piet Professional' : 'Carla Customer',
    email: input.email,
    phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password,
    role: input.role,
    isEmailVerified: true,
    accountStatus: 'active',
    marketingLocale: input.marketingLocale,
    marketingLocaleSource: input.marketingLocale ? 'explicit' : undefined,
    marketingConsentAt: input.consent ?? null,
    notificationPreferences: {
      promotions: { email: Boolean(input.promotions), push: false },
    },
    serviceCategories: input.services || [],
    ...(input.role === 'professional'
      ? {
          professionalStatus: 'approved',
          businessInfo: {
            companyName: 'Professional Company',
            country: input.country || 'Belgium',
            city: 'Ghent',
            timezone: 'Europe/Brussels',
          },
        }
      : {
          customerType: 'individual',
          location: {
            type: 'Point',
            coordinates: [4.35, 50.85],
            country: input.country || 'Belgium',
            city: 'Brussels',
          },
        }),
    ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
  });
};

const seedLead = async (email: string) => {
  const normalized = normalizeEmail(email);
  const serviceKeys = normalizeLeadServiceKeys(['plumbing']);
  return MarketingLead.create({
    email: normalized,
    emailNormalized: normalized,
    country: 'BE',
    locale: 'nl',
    serviceKeys,
    primaryServiceKey: serviceKeys[0],
    interestedServices: ['Plumbing'],
    identityHash: leadIdentityHash({
      emailNormalized: normalized,
      country: 'BE',
      locale: 'nl',
      serviceKeys,
    }),
    status: 'active',
  });
};

const sync = () =>
  request('POST', '/api/admin/marketing-subscribers/sync', { cookie: adminCookie });

const preview = (audienceType: 'subscribers' | 'leads' | 'both') =>
  resolveMarketingAudience({
    campaignType: 'invitation',
    audienceType,
    filters: {
      countries: ['BE'],
      serviceKeys: ['plumbing'],
      interestedServices: ['Plumbing'],
      locales: ['nl'],
      roles: ['professional'],
    },
    contentLocales: ['nl'],
    limitMode: 'preview',
  });

const cleanDb = async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({}),
    ),
  );
};

beforeAll(async () => {
  if (!hasDisposableMongo) return;
  await mongoose.connect(testUri!, { dbName: 'fixera_professional_sync_test' });
  await Promise.all([
    User.createIndexes(),
    MarketingSubscriber.createIndexes(),
    MarketingLead.createIndexes(),
    MarketingSuppression.createIndexes(),
    ServiceConfiguration.createIndexes(),
  ]);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/user', userRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  if (!hasDisposableMongo) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (!hasDisposableMongo) return;
  await cleanDb();
  await Promise.all([
    ServiceConfiguration.create({
      category: 'Home',
      service: 'Plumbing',
      isActive: true,
      activeCountries: ['BE'],
    }),
    ServiceConfiguration.create({
      category: 'Home',
      service: 'Painting',
      isActive: true,
      activeCountries: ['BE'],
    }),
  ]);
  admin = await createAdmin();
  adminCookie = cookieFor(admin);
});

describeDb('professional subscriber sync', () => {
  it('maps an opted-in professional with a country name, explicit language and raw service label', async () => {
    const professional = await createUser({
      email: 'pro@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent: new Date('2026-01-01T00:00:00.000Z'),
    });
    const customer = await createUser({
      email: 'customer@example.com',
      role: 'customer',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent: new Date('2026-01-01T00:00:00.000Z'),
    });

    const response = await sync();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      upserted: 2,
      unsubscribed: 0,
      eligibleByRole: { customer: 1, professional: 1 },
      syncedByRole: { customer: 1, professional: 1 },
      skippedByRole: { customer: 0, professional: 0 },
    });

    const proSubscriber = await MarketingSubscriber.findOne({ email: 'pro@example.com' }).lean();
    expect(proSubscriber).toMatchObject({
      role: 'professional',
      region: 'BE',
      locale: 'nl',
      localeSource: 'explicit',
      serviceKeys: ['plumbing'],
      interestedServices: ['Plumbing'],
      unsubscribedAt: null,
    });
    expect(proSubscriber?.consentVerifiedAt).toBeInstanceOf(Date);
    expect(proSubscriber?.userId?.toString()).toBe(String(professional._id));

    const customerSubscriber = await MarketingSubscriber.findOne({ email: 'customer@example.com' }).lean();
    expect(customerSubscriber).toMatchObject({
      role: 'customer',
      region: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
      interestedServices: ['Plumbing'],
    });

    const segment = await preview('subscribers');
    expect(segment.bySource).toEqual({ subscribers: 1, leads: 0 });
    expect(segment.recipients[0]).toMatchObject({
      email: 'pro@example.com',
      role: 'professional',
      locale: 'nl',
    });

    const beforeRepeat = {
      region: proSubscriber?.region,
      locale: proSubscriber?.locale,
      serviceKeys: proSubscriber?.serviceKeys,
      interestedServices: proSubscriber?.interestedServices,
      consentVerifiedAt: proSubscriber?.consentVerifiedAt,
      unsubscribedAt: proSubscriber?.unsubscribedAt,
    };
    const repeated = await sync();
    expect(repeated.status).toBe(200);
    expect(repeated.body.data).toMatchObject({
      upserted: 2,
      eligibleByRole: { customer: 1, professional: 1 },
      syncedByRole: { customer: 1, professional: 1 },
      skippedByRole: { customer: 0, professional: 0 },
    });
    const afterRepeat = await MarketingSubscriber.findOne({ email: 'pro@example.com' }).lean();
    expect({
      region: afterRepeat?.region,
      locale: afterRepeat?.locale,
      serviceKeys: afterRepeat?.serviceKeys,
      interestedServices: afterRepeat?.interestedServices,
      consentVerifiedAt: afterRepeat?.consentVerifiedAt,
      unsubscribedAt: afterRepeat?.unsubscribedAt,
    }).toEqual(beforeRepeat);
    expect(customer._id).toBeTruthy();
  });

  it('repairs a legacy professional subscriber row without clearing consent', async () => {
    const consent = new Date('2026-01-01T00:00:00.000Z');
    await createUser({
      email: 'legacy-pro@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent,
    });
    await MarketingSubscriber.create({
      email: 'legacy-pro@example.com',
      emailNormalized: 'legacy-pro@example.com',
      region: 'BELGIUM',
      locale: 'en',
      interestedServices: ['Plumbing'],
      serviceKeys: ['Plumbing'],
      subscribedAt: consent,
      consentVerifiedAt: consent,
      unsubscribedAt: null,
      unsubscribeToken: new Types.ObjectId().toHexString(),
      source: 'user_sync',
    });

    const response = await sync();
    expect(response.status).toBe(200);
    const repaired = await MarketingSubscriber.findOne({ email: 'legacy-pro@example.com' }).lean();
    expect(repaired).toMatchObject({
      role: 'professional',
      region: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
      interestedServices: ['Plumbing'],
      unsubscribedAt: null,
    });
    expect(repaired?.consentVerifiedAt?.toISOString()).toBe(consent.toISOString());

    const segment = await preview('subscribers');
    expect(segment.recipients.map((recipient) => recipient.email)).toEqual(['legacy-pro@example.com']);
  });

  it('does not create subscribers or consent for opted-out, unconsented or deleted professionals', async () => {
    const optedOut = await createUser({
      email: 'opted-out@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: false,
      consent: null,
    });
    const unconsented = await createUser({
      email: 'unconsented@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: false,
      consent: null,
    });
    const deleted = await createUser({
      email: 'deleted-pro@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const response = await sync();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      upserted: 0,
      unsubscribed: 0,
      eligibleByRole: { customer: 0, professional: 0 },
      syncedByRole: { customer: 0, professional: 0 },
      skippedByRole: { customer: 0, professional: 0 },
    });
    expect(await MarketingSubscriber.countDocuments({})).toBe(0);
    const rows = await User.find({
      _id: { $in: [optedOut._id, unconsented._id] },
    }).lean();
    expect(rows.every((row) => row.marketingConsentAt == null)).toBe(true);
    const deletedRow = await User.findById(deleted._id).lean();
    expect(deletedRow?.marketingConsentAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const segment = await preview('subscribers');
    expect(segment.recipients).toEqual([]);
  });

  it('backfills an explicit toggle with a missing consent date without enabling anyone else', async () => {
    await createUser({
      email: 'toggle-on@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent: null,
    });
    const response = await sync();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      upserted: 1,
      eligibleByRole: { customer: 0, professional: 1 },
      syncedByRole: { customer: 0, professional: 1 },
      skippedByRole: { customer: 0, professional: 0 },
    });
    const user = await User.findOne({ email: 'toggle-on@example.com' }).lean();
    expect(user?.marketingConsentAt).toBeInstanceOf(Date);
    expect(await MarketingSubscriber.countDocuments({ email: 'toggle-on@example.com' })).toBe(1);
  });

  it('reports a skipped professional when the local write does not persist a subscriber', async () => {
    await createUser({ email: 'missed@example.com', role: 'professional', country: 'BE', marketingLocale: 'nl', promotions: true, consent: new Date() });
    const write = vi.spyOn(MarketingSubscriber, 'bulkWrite').mockResolvedValueOnce({ mongoose: { validationErrors: [] } } as any);
    try {
      const response = await sync();
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        upserted: 0,
        eligibleByRole: { customer: 0, professional: 1 },
        syncedByRole: { customer: 0, professional: 0 },
        skippedByRole: { customer: 0, professional: 1 },
      });
    } finally { write.mockRestore(); }
  });

  it('opts out subscribers and leads together, then restores only the subscriber on re-opt-in', async () => {
    const user = await createUser({
      email: 'toggle@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent: new Date('2026-01-01T00:00:00.000Z'),
    });
    const lead = await seedLead('toggle@example.com');
    await sync();
    const userCookie = cookieFor(user);

    const disabled = await request('PATCH', '/api/user/notification-preferences', {
      cookie: userCookie,
      body: { type: 'promotions', channel: 'email', enabled: false },
    });
    expect(disabled.status).toBe(200);
    const subscriber = await MarketingSubscriber.findOne({ email: 'toggle@example.com' }).lean();
    expect(subscriber?.unsubscribedAt).toBeInstanceOf(Date);
    expect(subscriber?.consentVerifiedAt ?? null).toBeNull();
    const suppression = await MarketingSuppression.findOne({
      emailNormalized: 'toggle@example.com',
    }).lean();
    expect(suppression).toMatchObject({ reason: 'unsubscribe', source: 'subscriber' });
    const optedOutLead = await MarketingLead.findById(lead._id).lean();
    expect(optedOutLead?.unsubscribedAt).toBeInstanceOf(Date);
    expect((await preview('subscribers')).recipients).toEqual([]);
    expect((await preview('leads')).recipients).toEqual([]);

    const enabled = await request('PATCH', '/api/user/notification-preferences', {
      cookie: userCookie,
      body: { type: 'promotions', channel: 'email', enabled: true },
    });
    expect(enabled.status).toBe(200);
    const restored = await MarketingSubscriber.findOne({ email: 'toggle@example.com' }).lean();
    expect(restored?.unsubscribedAt).toBeNull();
    expect(restored?.consentVerifiedAt).toBeInstanceOf(Date);
    expect(await MarketingSuppression.countDocuments({ emailNormalized: 'toggle@example.com' })).toBe(0);
    const stillOptedOutLead = await MarketingLead.findById(lead._id).lean();
    expect(stillOptedOutLead?.unsubscribedAt).toBeInstanceOf(Date);
    expect((await preview('subscribers')).recipients.map((recipient) => recipient.email)).toEqual([
      'toggle@example.com',
    ]);
    expect((await preview('leads')).recipients).toEqual([]);
    expect(providerNetworkAttempts).toEqual([]);
  });

  it('repairs an existing subscriber profile after the professional changes services and country', async () => {
    const user = await createUser({
      email: 'profile@example.com',
      role: 'professional',
      country: 'Belgium',
      marketingLocale: 'nl',
      services: ['Plumbing'],
      promotions: true,
      consent: new Date('2026-01-01T00:00:00.000Z'),
    });
    await sync();
    const before = await MarketingSubscriber.findOne({ email: 'profile@example.com' }).lean();
    expect(before?.serviceKeys).toEqual(['plumbing']);

    const updated = await request('PUT', '/api/user/professional-profile', {
      cookie: cookieFor(user),
      body: {
        serviceCategories: ['Painting'],
        businessInfo: { country: 'België' },
      },
    });
    expect(updated.status).toBe(200);

    const after = await MarketingSubscriber.findOne({ email: 'profile@example.com' }).lean();
    expect(after).toMatchObject({
      role: 'professional',
      region: 'BE',
      locale: 'nl',
      serviceKeys: ['painting'],
      interestedServices: ['Painting'],
      unsubscribedAt: null,
    });
    expect(after?.consentVerifiedAt?.toISOString()).toBe(
      before?.consentVerifiedAt?.toISOString(),
    );

    const language = await request('PATCH', '/api/user/notification-preferences', {
      cookie: cookieFor(user),
      body: { marketingLocale: 'fr' },
    });
    expect(language.status).toBe(200);
    const afterLanguage = await MarketingSubscriber.findOne({
      email: 'profile@example.com',
    }).lean();
    expect(afterLanguage?.locale).toBe('fr');
    expect(afterLanguage?.localeSource).toBe('explicit');
    expect(afterLanguage?.serviceKeys).toEqual(['painting']);
    expect(afterLanguage?.consentVerifiedAt?.toISOString()).toBe(
      before?.consentVerifiedAt?.toISOString(),
    );
  });

  it('uses a neutral explicit language default for Belgium when none is stored', async () => {
    await createUser({
      email: 'no-language@example.com',
      role: 'professional',
      country: 'Belgium',
      services: ['Plumbing'],
      promotions: true,
      consent: new Date('2026-01-01T00:00:00.000Z'),
    });
    const response = await sync();
    expect(response.status).toBe(200);
    const subscriber = await MarketingSubscriber.findOne({
      email: 'no-language@example.com',
    }).lean();
    expect(subscriber?.region).toBe('BE');
    expect(subscriber?.locale).toBe('en');
    expect(subscriber?.localeSource).toBe('fallback');
  });
});
