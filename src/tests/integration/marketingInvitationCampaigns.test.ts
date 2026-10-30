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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-invitation-campaign-secret';
  process.env.EMAIL_DEV_NO_SEND = 'true';
  process.env.MARKETING_CAMPAIGN_DRY_RUN = 'true';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
});

const brevo = vi.hoisted(() => ({
  createCampaignList: vi.fn(),
  syncContactsToList: vi.fn(),
  createBrevoCampaign: vi.fn(),
  sendBrevoCampaignNow: vi.fn(),
  fetchBrevoCampaignStats: vi.fn(),
  isMarketingDryRun: vi.fn(() => true),
  listId: 500,
  campaignId: 9000,
}));

vi.mock('../../utils/marketing/brevoMarketing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/marketing/brevoMarketing')>();
  return {
    ...actual,
    createCampaignList: brevo.createCampaignList,
    syncContactsToList: brevo.syncContactsToList,
    createBrevoCampaign: brevo.createBrevoCampaign,
    sendBrevoCampaignNow: brevo.sendBrevoCampaignNow,
    fetchBrevoCampaignStats: brevo.fetchBrevoCampaignStats,
    isBrevoMarketingConfigured: () => true,
    isMarketingDryRun: brevo.isMarketingDryRun,
    assertBrevoMarketingTemplateContract: vi.fn(),
  };
});

import adminRouter from '../../routes/Admin';
import errorHandler from '../../handlers/error';
import User from '../../models/user';
import MarketingCampaign from '../../models/marketingCampaign';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingLead from '../../models/marketingLead';
import MarketingSuppression from '../../models/marketingSuppression';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';
import {
  leadIdentityHash,
  normalizeLeadServiceKeys,
} from '../../utils/marketing/leadIdentity';
import { renderMarketingEmail } from '../../utils/marketing/renderCampaign';
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

const createAdmin = async () => {
  const password = await bcrypt.hash('secret123', 4);
  return User.create({
    name: 'Campaign Admin',
    email: `campaign-admin-${new Types.ObjectId().toHexString()}@example.com`,
    phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password,
    role: 'admin',
    adminRole: 'super',
    isEmailVerified: true,
    accountStatus: 'active',
  });
};

const seedSubscriber = async (input: {
  email: string;
  role?: 'customer' | 'professional';
  region?: string;
  locale?: string;
  serviceKeys?: string[];
  unsubscribedAt?: Date | null;
  brevoUnsubscribedAt?: Date | null;
  consent?: boolean;
}) => {
  const email = normalizeEmail(input.email);
  return MarketingSubscriber.create({
    email,
    emailNormalized: email,
    name: 'Subscriber Person',
    role: input.role || 'professional',
    region: input.region || 'BE',
    locale: input.locale || 'nl',
    interestedServices: (input.serviceKeys || ['plumbing']).map(
      (key) => key.charAt(0).toUpperCase() + key.slice(1),
    ),
    serviceKeys: input.serviceKeys || ['plumbing'],
    subscribedAt: new Date('2026-01-01T00:00:00.000Z'),
    consentVerifiedAt: input.consent === false ? null : new Date('2026-01-01T00:00:00.000Z'),
    unsubscribedAt: input.unsubscribedAt ?? null,
    brevoUnsubscribedAt: input.brevoUnsubscribedAt ?? null,
    unsubscribeToken: new Types.ObjectId().toHexString(),
    source: 'user_sync',
  });
};

const seedLead = async (input: {
  email: string;
  country?: string;
  locale?: string;
  serviceKeys?: string[];
  unsubscribedAt?: Date | null;
}) => {
  const email = normalizeEmail(input.email);
  const serviceKeys = normalizeLeadServiceKeys(input.serviceKeys || ['plumbing']);
  const country = input.country || 'BE';
  const locale = input.locale || 'nl';
  return MarketingLead.create({
    email,
    emailNormalized: email,
    country,
    locale,
    serviceKeys,
    primaryServiceKey: serviceKeys[0],
    interestedServices: serviceKeys.map(
      (key) => key.charAt(0).toUpperCase() + key.slice(1),
    ),
    identityHash: leadIdentityHash({
      emailNormalized: email,
      country,
      locale,
      serviceKeys,
    }),
    status: 'active',
    unsubscribedAt: input.unsubscribedAt ?? null,
  });
};

const campaignPayload = (overrides: Record<string, any> = {}) => ({
  name: 'Invite professionals',
  type: 'invitation',
  audienceType: 'both',
  content: {
    nl: {
      subject: 'Professional invitation',
      htmlContent: '<p>Join our professional network.</p>',
    },
    fr: {
      subject: 'Invitation professionnelle',
      htmlContent: '<p>Rejoignez notre réseau professionnel.</p>',
    },
  },
  audience: {
    countries: ['BE'],
    serviceKeys: ['plumbing'],
    interestedServices: ['Plumbing'],
    locales: ['nl', 'fr'],
    roles: ['professional'],
  },
  ...overrides,
});

const createCampaign = (overrides: Record<string, any> = {}) =>
  request('POST', '/api/admin/marketing-campaigns', {
    cookie: adminCookie,
    body: campaignPayload(overrides),
  });

const preview = (body: Record<string, any>) =>
  request('POST', '/api/admin/marketing-campaigns/preview-audience', {
    cookie: adminCookie,
    body,
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
  await mongoose.connect(testUri!, { dbName: 'fixera_invitation_campaigns_test' });
  await Promise.all([
    User.createIndexes(),
    MarketingCampaign.createIndexes(),
    MarketingSubscriber.createIndexes(),
    MarketingLead.createIndexes(),
    MarketingSuppression.createIndexes(),
  ]);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin', adminRouter);
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
  admin = await createAdmin();
  adminCookie = `auth-token=${jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
  brevo.listId = 500;
  brevo.campaignId = 9000;
  brevo.isMarketingDryRun.mockReturnValue(true);
  brevo.createCampaignList.mockReset();
  brevo.createCampaignList.mockImplementation(async () => {
    brevo.listId += 1;
    return brevo.listId;
  });
  brevo.syncContactsToList.mockReset();
  brevo.syncContactsToList.mockResolvedValue({ imported: 0 });
  brevo.createBrevoCampaign.mockReset();
  brevo.createBrevoCampaign.mockImplementation(async () => {
    brevo.campaignId += 1;
    return { campaignId: brevo.campaignId };
  });
  brevo.sendBrevoCampaignNow.mockReset();
  brevo.sendBrevoCampaignNow.mockResolvedValue(undefined);
  brevo.fetchBrevoCampaignStats.mockReset();
  brevo.fetchBrevoCampaignStats.mockResolvedValue({
    sent: 0,
    delivered: 0,
    uniqueViews: 0,
    uniqueClicks: 0,
    unsubscriptions: 0,
    softBounces: 0,
    hardBounces: 0,
  });
});

describeDb('invitation campaigns and lead audiences', () => {
  it('defaults every new campaign to subscribers and validates the invitation policy', async () => {
    const defaulted = await createCampaign({ audienceType: undefined });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.data).toMatchObject({ type: 'invitation', audienceType: 'subscribers' });

    const invalid = await createCampaign({ audienceType: 'everyone' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.msg).toBe('Audience type must be one of: subscribers, both, leads');

    const newsletterLeads = await createCampaign({ type: 'newsletter', audienceType: 'leads' });
    expect(newsletterLeads.status).toBe(400);
    expect(newsletterLeads.body.msg).toBe('Lead audiences are only available for invitation campaigns');

    const noProfessional = await createCampaign({
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['customer'],
      },
    });
    expect(noProfessional.status).toBe(400);
    expect(noProfessional.body.msg).toBe('Lead audiences require the professional role');

    const invitationSubscribers = await createCampaign({
      audienceType: 'subscribers',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['customer', 'professional'],
      },
    });
    expect(invitationSubscribers.status).toBe(201);
    expect(invitationSubscribers.body.data.audienceType).toBe('subscribers');
  });

  it('serializes legacy and invitation campaigns without hiding or relabeling unknown audiences', async () => {
    const legacy = await mongoose.connection.collection('marketingcampaigns').insertOne({
      name: 'Legacy newsletter',
      type: 'newsletter',
      status: 'draft',
      content: { nl: { subject: 'Legacy', htmlContent: '<p>Legacy content</p>' } },
      audience: { countries: [], interestedServices: [], serviceKeys: [], locales: ['nl'], roles: ['customer', 'professional'] },
      deliveries: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const invitation = await mongoose.connection.collection('marketingcampaigns').insertOne({
      name: 'Legacy invitation',
      type: 'invitation',
      audienceType: 'leads',
      status: 'draft',
      content: { nl: { subject: 'Legacy invite', htmlContent: '<p>Legacy invite content</p>' } },
      audience: { countries: [], interestedServices: [], serviceKeys: [], locales: ['nl'], roles: ['professional'] },
      deliveries: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const unknown = await mongoose.connection.collection('marketingcampaigns').insertOne({
      name: 'Unknown audience',
      type: 'invitation',
      audienceType: 'mystery',
      status: 'draft',
      content: { nl: { subject: 'Unknown', htmlContent: '<p>Unknown audience content</p>' } },
      audience: { countries: [], interestedServices: [], serviceKeys: [], locales: ['nl'], roles: ['professional'] },
      deliveries: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const list = await request('GET', '/api/admin/marketing-campaigns?limit=100', {
      cookie: adminCookie,
    });
    expect(list.status).toBe(200);
    const byId = new Map(list.body.data.campaigns.map((campaign: any) => [campaign._id, campaign]));
    expect(byId.get(String(legacy.insertedId))).toMatchObject({
      type: 'newsletter',
      audienceType: 'subscribers',
    });
    expect(byId.get(String(legacy.insertedId))).not.toHaveProperty('audienceTypeInvalid');
    expect(byId.get(String(invitation.insertedId))).toMatchObject({
      type: 'invitation',
      audienceType: 'leads',
    });
    expect(byId.get(String(unknown.insertedId))).toMatchObject({
      audienceType: 'mystery',
      audienceTypeInvalid: true,
    });

    const filtered = await request('GET', '/api/admin/marketing-campaigns?type=invitation', {
      cookie: adminCookie,
    });
    expect(filtered.body.data.campaigns.map((campaign: any) => campaign._id).sort()).toEqual(
      [String(invitation.insertedId), String(unknown.insertedId)].sort(),
    );

    const legacyUpdate = await request('PATCH', `/api/admin/marketing-campaigns/${legacy.insertedId}`, {
      cookie: adminCookie,
      body: { name: 'Legacy newsletter renamed' },
    });
    expect(legacyUpdate.status).toBe(200);
    expect(legacyUpdate.body.data.audienceType).toBe('subscribers');

    const unknownRename = await request('PATCH', `/api/admin/marketing-campaigns/${unknown.insertedId}`, {
      cookie: adminCookie,
      body: { name: 'Still unknown' },
    });
    expect(unknownRename.status).toBe(400);
    expect(unknownRename.body.msg).toBe('Select an audience type: subscribers, both, leads');

    const corrected = await request('PATCH', `/api/admin/marketing-campaigns/${unknown.insertedId}`, {
      cookie: adminCookie,
      body: { audienceType: 'subscribers' },
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data).toMatchObject({ audienceType: 'subscribers' });
    expect(corrected.body.data).not.toHaveProperty('audienceTypeInvalid');

    const sendUnknown = await request('POST', `/api/admin/marketing-campaigns/${invitation.insertedId}/send`, {
      cookie: adminCookie,
    });
    expect(sendUnknown.status).not.toBe(500);
  });

  it('blocks changing invitation with leads away from invitation unless subscribers is selected', async () => {
    const created = await createCampaign();
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    const blocked = await request('PATCH', `/api/admin/marketing-campaigns/${id}`, {
      cookie: adminCookie,
      body: { type: 'newsletter' },
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.msg).toBe('Select Subscribers before changing this campaign type');

    const allowed = await request('PATCH', `/api/admin/marketing-campaigns/${id}`, {
      cookie: adminCookie,
      body: { type: 'newsletter', audienceType: 'subscribers' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toMatchObject({ type: 'newsletter', audienceType: 'subscribers' });
  });

  it('treats a created provider list as immutable campaign state', async () => {
    const created = await createCampaign();
    const id = created.body.data._id;
    await MarketingCampaign.updateOne(
      { _id: id },
      { $set: { deliveries: [{ locale: 'nl', brevoListId: 777, recipientCount: 0 }] } },
    );
    const update = await request('PATCH', `/api/admin/marketing-campaigns/${id}`, {
      cookie: adminCookie,
      body: { name: 'Changed' },
    });
    expect(update.status).toBe(400);
    expect(update.body.msg).toContain('immutable');

    const deleted = await request('DELETE', `/api/admin/marketing-campaigns/${id}`, {
      cookie: adminCookie,
    });
    expect(deleted.status).toBe(400);
  });

  it('resolves subscribers, leads and both with source counts and subscriber precedence', async () => {
    await seedSubscriber({ email: 'sub-one@example.com', locale: 'nl' });
    await seedSubscriber({ email: 'sub-two@example.com', locale: 'nl', role: 'customer' });
    await seedSubscriber({ email: 'sub-fr@example.com', locale: 'fr' });
    const shared = 'precedence@example.com';
    await seedSubscriber({ email: shared, locale: 'nl', serviceKeys: ['plumbing'] });
    await seedLead({ email: shared, locale: 'nl' });
    await seedLead({ email: shared, locale: 'fr' });
    await seedLead({ email: 'lead-one@example.com', locale: 'nl' });
    await seedLead({ email: 'lead-one@example.com', locale: 'fr' });
    await seedLead({ email: 'lead-painting@example.com', locale: 'nl', serviceKeys: ['painting'] });
    await seedLead({ email: 'lead-nl@example.com', country: 'NL', locale: 'nl' });
    await seedLead({ email: 'lead-suppressed@example.com', locale: 'nl', unsubscribedAt: new Date() });
    await MarketingSuppression.create({
      emailNormalized: 'lead-global-suppressed@example.com',
      reason: 'provider',
      source: 'brevo',
    });
    await seedLead({ email: 'lead-global-suppressed@example.com', locale: 'nl' });

    const subscriberPreview = await preview({
      type: 'invitation',
      audienceType: 'subscribers',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
      contentLocales: ['nl'],
    });
    expect(subscriberPreview.status).toBe(200);
    expect(subscriberPreview.body.data).toMatchObject({
      audienceType: 'subscribers',
      includesLeads: false,
      bySource: { subscribers: 2, leads: 0 },
    });
    expect(subscriberPreview.body.data.byLocale).toEqual({ nl: 2 });

    const leadPreview = await preview({
      type: 'invitation',
      audienceType: 'leads',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
      contentLocales: ['nl'],
    });
    expect(leadPreview.status).toBe(200);
    expect(leadPreview.body.data).toMatchObject({
      audienceType: 'leads',
      includesLeads: true,
      bySource: { subscribers: 0, leads: 2 },
      deduplicated: 0,
      excluded: expect.objectContaining({ suppressed: 2 }),
    });

    const bothPreview = await preview({
      type: 'invitation',
      audienceType: 'both',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
      contentLocales: ['nl'],
    });
    expect(bothPreview.status).toBe(200);
    expect(bothPreview.body.data).toMatchObject({
      audienceType: 'both',
      includesLeads: true,
      bySource: { subscribers: 2, leads: 1 },
      deduplicated: 1,
      exactTotalIsEstimate: false,
    });
    expect(bothPreview.body.data.exactTotal).toBe(3);

    const policy = await preview({
      type: 'invitation',
      audienceType: 'leads',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['customer'],
      },
      contentLocales: ['nl'],
    });
    expect(policy.status).toBe(400);
    expect(policy.body.msg).toBe('Lead audiences require the professional role');

    const invalidType = await preview({
      type: 'mystery',
      audienceType: 'subscribers',
      audience: {},
      contentLocales: ['nl'],
    });
    expect(invalidType.status).toBe(400);
    expect(invalidType.body.msg).toBe('Invalid campaign type');
  });

  it('preserves invitation audience type on a scheduled campaign and lists it', async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await createCampaign({ scheduledAt });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      type: 'invitation',
      audienceType: 'both',
      status: 'scheduled',
    });

    const list = await request('GET', '/api/admin/marketing-campaigns?type=invitation&limit=100', {
      cookie: adminCookie,
    });
    expect(list.status).toBe(200);
    expect(list.body.data.campaigns.map((campaign: any) => campaign._id)).toContain(
      created.body.data._id,
    );
  });

  it('does not fall back to a lead variant when a subscriber is ineligible for the filters', async () => {
    await seedSubscriber({
      email: 'ineligible@example.com',
      locale: 'fr',
      role: 'professional',
      serviceKeys: ['plumbing'],
    });
    await seedLead({ email: 'ineligible@example.com', locale: 'nl' });

    const both = await preview({
      type: 'invitation',
      audienceType: 'both',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
      contentLocales: ['nl'],
    });
    expect(both.status).toBe(200);
    expect(both.body.data.bySource).toEqual({ subscribers: 0, leads: 0 });
    expect(both.body.data.exactTotal).toBe(0);
    expect(both.body.data.deduplicated).toBe(1);

    const leadsOnly = await preview({
      type: 'invitation',
      audienceType: 'leads',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
      contentLocales: ['nl'],
    });
    expect(leadsOnly.body.data.bySource).toEqual({ subscribers: 0, leads: 1 });
    expect(leadsOnly.body.data.exactTotal).toBe(1);
  });

  it('sends one email per mailbox in dry run and records per-locale source counts', async () => {
    await seedSubscriber({ email: 'subscriber@example.com', locale: 'nl' });
    await seedLead({ email: 'lead@example.com', locale: 'nl' });
    await seedLead({ email: 'subscriber@example.com', locale: 'nl' });

    const created = await createCampaign({
      audienceType: 'both',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
    });
    expect(created.status).toBe(201);
    const sent = await request('POST', `/api/admin/marketing-campaigns/${created.body.data._id}/send`, {
      cookie: adminCookie,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe('sent');
    const delivery = sent.body.data.deliveries.find((entry: any) => entry.locale === 'nl');
    expect(delivery).toMatchObject({
      recipientCount: 2,
      subscriberCount: 1,
      leadCount: 1,
      deduplicatedRecipientCount: 1,
    });
    expect(delivery.criteriaHash).toMatch(/^[a-f0-9]{8}$/);
    expect(brevo.createCampaignList).not.toHaveBeenCalled();
    expect(brevo.syncContactsToList).not.toHaveBeenCalled();
    expect(providerNetworkAttempts).toEqual([]);
  });

  it('sends leads only by their own language and one row per mailbox, then updates lead send stamps', async () => {
    brevo.isMarketingDryRun.mockReturnValue(false);
    const shared = await seedLead({ email: 'shared-lead@example.com', locale: 'nl' });
    await seedLead({ email: 'shared-lead@example.com', locale: 'fr' });
    const french = await seedLead({ email: 'french-lead@example.com', locale: 'fr' });

    const created = await createCampaign({
      audienceType: 'leads',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl', 'fr'],
        roles: ['professional'],
      },
    });
    expect(created.status).toBe(201);

    const sent = await request('POST', `/api/admin/marketing-campaigns/${created.body.data._id}/send`, {
      cookie: adminCookie,
    });
    expect(sent.status).toBe(200);
    const nl = sent.body.data.deliveries.find((entry: any) => entry.locale === 'nl');
    const fr = sent.body.data.deliveries.find((entry: any) => entry.locale === 'fr');
    expect(nl).toMatchObject({ recipientCount: 1, subscriberCount: 0, leadCount: 1 });
    expect(fr).toMatchObject({ recipientCount: 1, subscriberCount: 0, leadCount: 1 });
    expect(brevo.syncContactsToList).toHaveBeenCalledTimes(2);
    const nlEmails = brevo.syncContactsToList.mock.calls
      .find((call: any[]) => call[0] === 501)?.[1]
      ?.map((contact: any) => contact.email);
    const frEmails = brevo.syncContactsToList.mock.calls
      .find((call: any[]) => call[0] === 502)?.[1]
      ?.map((contact: any) => contact.email);
    expect(nlEmails).toEqual(['shared-lead@example.com']);
    expect(frEmails).toEqual(['french-lead@example.com']);

    const sentHtml = brevo.createBrevoCampaign.mock.calls[0][0].htmlContent;
    expect(sentHtml).toContain('uitnodiging');
    expect(sentHtml).not.toContain('opted in');
    expect(sentHtml).not.toContain('/profile?tab=notifications');

    const refreshedShared = await MarketingLead.findById(shared._id).lean();
    const refreshedFrench = await MarketingLead.findById(french._id).lean();
    expect(refreshedShared?.lastCampaignSentAt).toBeInstanceOf(Date);
    expect(refreshedFrench?.lastCampaignSentAt).toBeInstanceOf(Date);
  });

  it('skips completed locales on retry, re-resolves unfinished ones and blocks audience drift', async () => {
    brevo.isMarketingDryRun.mockReturnValue(false);
    await seedSubscriber({ email: 'retry-nl@example.com', locale: 'nl' });
    await seedSubscriber({ email: 'retry-fr@example.com', locale: 'fr' });

    const created = await createCampaign({
      audienceType: 'subscribers',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl', 'fr'],
        roles: ['professional'],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    const previewResponse = await preview({
      type: 'invitation',
      audienceType: 'subscribers',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl', 'fr'],
        roles: ['professional'],
      },
      contentLocales: ['nl', 'fr'],
    });
    const criteriaHash = previewResponse.body.data.criteriaHash;

    await MarketingCampaign.updateOne(
      { _id: id },
      {
        $set: {
          status: 'failed',
          sendAttempts: 1,
          nextRetryAt: new Date(Date.now() - 1000),
          deliveries: [
            {
              locale: 'nl',
              brevoListId: 601,
              brevoCampaignId: 7001,
              brevoStatus: 'sent',
              recipientCount: 1,
              subscriberCount: 1,
              leadCount: 0,
              deduplicatedRecipientCount: 0,
              criteriaHash,
            },
            {
              locale: 'fr',
              brevoListId: 602,
              recipientCount: 0,
              subscriberCount: 0,
              leadCount: 0,
              deduplicatedRecipientCount: 0,
              criteriaHash,
            },
          ],
        },
      },
    );

    const retried = await request('POST', `/api/admin/marketing-campaigns/${id}/send`, {
      cookie: adminCookie,
    });
    expect(retried.status).toBe(200);
    expect(brevo.syncContactsToList).toHaveBeenCalledTimes(1);
    expect(brevo.syncContactsToList.mock.calls[0][0]).toBe(602);
    expect(brevo.syncContactsToList.mock.calls[0][1].map((contact: any) => contact.email)).toEqual([
      'retry-fr@example.com',
    ]);
    expect(brevo.createBrevoCampaign).toHaveBeenCalledTimes(1);

    const drift = await createCampaign({
      audienceType: 'subscribers',
      audience: {
        countries: ['BE'],
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
        locales: ['nl'],
        roles: ['professional'],
      },
    });
    await MarketingCampaign.updateOne(
      { _id: drift.body.data._id },
      {
        $set: {
          status: 'failed',
          sendAttempts: 1,
          nextRetryAt: new Date(Date.now() - 1000),
          deliveries: [
            {
              locale: 'nl',
              brevoListId: 603,
              recipientCount: 1,
              criteriaHash: 'deadbeef',
            },
          ],
        },
      },
    );
    const drifted = await request('POST', `/api/admin/marketing-campaigns/${drift.body.data._id}/send`, {
      cookie: adminCookie,
    });
    expect(drifted.status).toBe(400);
    expect(drifted.body.msg).toBe(
      'Campaign audience changed since the last attempt; review the campaign before retrying',
    );
  });

  it('excludes suppressed and opted-out mailboxes from both sources', async () => {
    await seedSubscriber({
      email: 'unsubscribed-subscriber@example.com',
      locale: 'nl',
      unsubscribedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await MarketingSubscriber.create({
      email: 'provider-blocked@example.com',
      emailNormalized: 'provider-blocked@example.com',
      role: 'professional',
      region: 'BE',
      locale: 'nl',
      interestedServices: ['Plumbing'],
      serviceKeys: ['plumbing'],
      subscribedAt: new Date(),
      consentVerifiedAt: new Date(),
      brevoUnsubscribedAt: new Date(),
      unsubscribedAt: null,
      unsubscribeToken: new Types.ObjectId().toHexString(),
      source: 'user_sync',
    });
    await seedLead({ email: 'provider-blocked@example.com', locale: 'nl' });
    await seedLead({ email: 'own-unsubscribed@example.com', locale: 'nl', unsubscribedAt: new Date() });
    await MarketingSuppression.create({
      emailNormalized: 'global-suppressed@example.com',
      reason: 'admin',
      source: 'subscriber',
    });
    await seedLead({ email: 'global-suppressed@example.com', locale: 'nl' });
    await seedLead({ email: 'cross-dimension@example.com', locale: 'fr', unsubscribedAt: new Date() });
    await seedLead({ email: 'cross-dimension@example.com', locale: 'nl' });

    const result = await resolveMarketingAudience({
      campaignType: 'invitation',
      audienceType: 'both',
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

    expect(result.recipients).toHaveLength(0);
    expect(result.bySource).toEqual({ subscribers: 0, leads: 0 });
    expect(result.excluded.suppressed).toBe(4);
  });

  it('renders a neutral invitation footer and keeps the subscriber footer unchanged', () => {
    const invitation = renderMarketingEmail({
      locale: 'en',
      firstName: 'Ada',
      content: { subject: 'Invite', htmlContent: '<p>Body</p>' },
      footerVariant: 'invitation',
    });
    expect(invitation.htmlContent).toContain('professional invitation');
    expect(invitation.htmlContent).not.toContain('opted in');
    expect(invitation.htmlContent).not.toContain('/profile?tab=notifications');
    expect(invitation.htmlContent).toContain('/unsubscribe?token=');

    const subscriber = renderMarketingEmail({
      locale: 'en',
      firstName: 'Ada',
      content: { subject: 'News', htmlContent: '<p>Body</p>' },
    });
    expect(subscriber.htmlContent).toContain('opted in');
    expect(subscriber.htmlContent).toContain('/profile?tab=notifications');
  });
});
