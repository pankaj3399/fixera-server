import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import * as XLSX from 'xlsx';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-marketing-leads-secret';
  process.env.MARKETING_CAMPAIGN_DRY_RUN = 'true';
  process.env.EMAIL_DEV_NO_SEND = 'true';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
});

import adminRouter from '../../routes/Admin';
import publicRouter from '../../routes/Public';
import errorHandler from '../../handlers/error';
import User from '../../models/user';
import MarketingLead from '../../models/marketingLead';
import MarketingLeadImport from '../../models/marketingLeadImport';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import ServiceConfiguration from '../../models/serviceConfiguration';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';
import {
  leadIdentityHash,
  normalizeLeadServiceKeys,
} from '../../utils/marketing/leadIdentity';
import { signUnsubscribePayload } from '../../utils/marketing/unsubscribeToken';
import { providerNetworkAttempts } from '../setup/providerIsolation';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri) && /^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

let server: Server;
let baseUrl = '';
let superAdmin: any;
let superCookie = '';
let serviceConfigs: any[] = [];

const jwtCookie = (user: any) =>
  `auth-token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;

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

const requestMultipart = async (
  path: string,
  form: FormData,
  cookie: string | null = superCookie,
) => {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

function workbookBuffer(
  rows: unknown[][],
  bookType: XLSX.BookType = 'xlsx',
): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Leads');
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;
}

const importWorkbook = async (
  rows: unknown[][],
  filename = 'leads.xlsx',
  cookie: string | null = superCookie,
  path = '/api/admin/marketing-leads/import',
) => {
  const form = new FormData();
  form.append(
    'file',
    new Blob([workbookBuffer(rows)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    filename,
  );
  return requestMultipart(path, form, cookie);
};

const importBytes = async (bytes: Buffer, filename: string, cookie: string | null = superCookie) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  return requestMultipart('/api/admin/marketing-leads/import', form, cookie);
};

const createAdmin = async (overrides: Record<string, any> = {}) => {
  const password = await bcrypt.hash('secret123', 4);
  return User.create({
    name: 'Marketing Admin',
    email: `admin-${new Types.ObjectId().toHexString()}@example.com`,
    phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password,
    role: 'admin',
    adminRole: 'marketing',
    isEmailVerified: true,
    accountStatus: 'active',
    ...overrides,
  });
};

const seedLead = async (input: {
  email: string;
  country?: string;
  locale?: string;
  serviceKeys?: string[];
  interestedServices?: string[];
  status?: 'active' | 'deleted';
  unsubscribedAt?: Date | null;
  lastCampaignSentAt?: Date | null;
}) => {
  const email = normalizeEmail(input.email);
  const serviceKeys = normalizeLeadServiceKeys(input.serviceKeys || ['plumbing']);
  return MarketingLead.create({
    email,
    emailNormalized: email,
    country: input.country || 'BE',
    locale: input.locale || 'nl',
    serviceKeys,
    primaryServiceKey: serviceKeys[0],
    interestedServices:
      input.interestedServices || serviceKeys.map((key) => key.charAt(0).toUpperCase() + key.slice(1)),
    identityHash: leadIdentityHash({
      emailNormalized: email,
      country: input.country || 'BE',
      locale: input.locale || 'nl',
      serviceKeys,
    }),
    status: input.status || 'active',
    unsubscribedAt: input.unsubscribedAt ?? null,
    lastCampaignSentAt: input.lastCampaignSentAt ?? null,
  });
};

const cleanDb = async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) =>
      collection.deleteMany({}),
    ),
  );
};

beforeAll(async () => {
  if (!hasDisposableMongo) return;
  await mongoose.connect(testUri!, { dbName: 'fixera_marketing_leads_test' });
  await Promise.all([
    User.createIndexes(),
    MarketingLead.createIndexes(),
    MarketingLeadImport.createIndexes(),
    MarketingSubscriber.createIndexes(),
    MarketingSuppression.createIndexes(),
    ServiceConfiguration.createIndexes(),
  ]);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/public', publicRouter);
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
  serviceConfigs = await Promise.all([
    ServiceConfiguration.create({
      category: 'Home',
      service: 'Plumbing',
      isActive: true,
      activeCountries: ['BE', 'NL'],
    }),
    ServiceConfiguration.create({
      category: 'Home',
      service: 'Painting',
      isActive: true,
      activeCountries: ['BE'],
    }),
  ]);
  superAdmin = await createAdmin({ adminRole: 'super' });
  superCookie = jwtCookie(superAdmin);
});

describeDb('marketing leads admin API', () => {
  it('imports leads, canonicalizes values, reports actual counts and records history', async () => {
    await MarketingSuppression.create({
      emailNormalized: 'suppressed@example.com',
      reason: 'provider',
      source: 'brevo',
    });

    const response = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service', 'Ignored'],
      ['Person@Example.com', 'Belgium', 'Nederlands', 'Plumbing', 'x'],
      ['person@example.com', 'BE', 'nl', 'plumbing', 'x'],
      ['person@example.com', 'NL', 'nl', 'Plumbing', 'x'],
      ['bad-email', 'BE', 'nl', 'Plumbing', 'x'],
      ['other@example.com', 'BE', 'English', 'Painting', 'x'],
      ['suppressed@example.com', 'BE', 'nl', 'Plumbing', 'x'],
    ]);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    const record = response.body.data.import;
    expect(record).toMatchObject({
      filename: 'leads.xlsx',
      status: 'partial',
      totalRows: 6,
      importedRows: 4,
      duplicateRows: 1,
      failedRows: 1,
      suppressedRows: 1,
      errorCount: 1,
    });
    expect(record.uploadedAt).toBeTruthy();
    expect(record.uploadedBy).toBe(String(superAdmin._id));
    expect(response.body.data.summary).toEqual({
      totalRows: 6,
      importedRows: 4,
      duplicateRows: 1,
      failedRows: 1,
      suppressedRows: 1,
    });
    expect(response.body.data.errors[0]).toMatchObject({
      row: 5,
      field: 'email',
      message: 'Enter a valid email address',
    });

    const leads = await MarketingLead.find({}).sort({ emailNormalized: 1, country: 1 }).lean();
    expect(leads).toHaveLength(4);
    const person = leads.filter((lead) => lead.emailNormalized === 'person@example.com');
    expect(person.map((lead) => lead.country).sort()).toEqual(['BE', 'NL']);
    expect(person.every((lead) => lead.locale === 'nl')).toBe(true);
    expect(person.every((lead) => lead.serviceKeys.join(',') === 'plumbing')).toBe(true);
    expect(person.every((lead) => lead.interestedServices.join(',') === 'Plumbing')).toBe(true);
    expect(person.every((lead) => lead.identityHash.length === 64)).toBe(true);
    expect(person.every((lead) => lead.primaryServiceKey === 'plumbing')).toBe(true);

    const history = await MarketingLeadImport.findOne({ filename: 'leads.xlsx' }).lean();
    expect(history?.status).toBe('partial');
    expect(history?.rowErrors).toHaveLength(1);

    const second = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['Person@Example.com', 'Belgium', 'Nederlands', 'Plumbing'],
      ['person@example.com', 'BE', 'nl', 'plumbing'],
      ['person@example.com', 'NL', 'nl', 'Plumbing'],
      ['other@example.com', 'BE', 'English', 'Painting'],
    ]);
    expect(second.status).toBe(201);
    expect(second.body.data.import).toMatchObject({
      status: 'duplicate_only',
      importedRows: 0,
      duplicateRows: 4,
      failedRows: 0,
    });
    expect(await MarketingLead.countDocuments({ status: 'active' })).toBe(4);

    const historyPage = await request('GET', '/api/admin/marketing-lead-imports?limit=10', {
      cookie: superCookie,
    });
    const firstHistory = historyPage.body.data.imports.find(
      (row: any) => row.filename === 'leads.xlsx' && row.status === 'partial',
    );
    expect(firstHistory).toMatchObject({ status: 'partial', errorCount: 1 });
    expect(firstHistory.errors).toEqual([
      expect.objectContaining({ row: 5, field: 'email' }),
    ]);
  });

  it('counts every imported suppressed row when one mailbox has multiple identities', async () => {
    await MarketingSuppression.create({
      emailNormalized: 'blocked@example.com',
      reason: 'unsubscribe',
      source: 'subscriber',
    });
    const response = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['blocked@example.com', 'BE', 'nl', 'Plumbing'],
      ['blocked@example.com', 'NL', 'nl', 'Plumbing'],
      ['blocked@example.com', 'BE', 'nl', 'Painting'],
      ['blocked@example.com', 'BE', 'nl', 'Plumbing'],
    ], 'suppressed-variants.xlsx');
    expect(response.status).toBe(201);
    expect(response.body.data.import).toMatchObject({
      status: 'completed',
      importedRows: 3,
      duplicateRows: 1,
      suppressedRows: 3,
    });
    expect(response.body.data.summary.suppressedRows).toBe(3);
    const history = await MarketingLeadImport.findOne({ filename: 'suppressed-variants.xlsx' }).lean();
    expect(history?.suppressedRows).toBe(3);
    expect(await MarketingLead.countDocuments({ emailNormalized: 'blocked@example.com', status: 'active' })).toBe(3);
  });

  it('keeps one active row per identity under concurrent imports without 500s', async () => {
    const rows: unknown[][] = [['Email', 'Country', 'Language', 'Service']];
    for (let index = 0; index < 10; index += 1) {
      rows.push([`concurrent-${index}@example.com`, 'BE', 'nl', 'Plumbing']);
    }

    const [first, second] = await Promise.all([
      importWorkbook(rows, 'concurrent-a.xlsx'),
      importWorkbook(rows, 'concurrent-b.xlsx'),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.import.status).not.toBe('failed');
    expect(second.body.data.import.status).not.toBe('failed');

    expect(await MarketingLead.countDocuments({ status: 'active' })).toBe(10);
    const imported = first.body.data.import.importedRows + second.body.data.import.importedRows;
    const duplicates = first.body.data.import.duplicateRows + second.body.data.import.duplicateRows;
    expect(imported).toBe(10);
    expect(duplicates).toBe(10);
    expect(await MarketingLeadImport.countDocuments({})).toBe(2);
    expect(providerNetworkAttempts).toEqual([]);
  });

  it('edits canonical fields, rejects email changes and returns a safe 409 for identity collisions', async () => {
    const plumbing = await seedLead({ email: 'same@example.com', serviceKeys: ['plumbing'] });
    const painting = await seedLead({
      email: 'same@example.com',
      serviceKeys: ['painting'],
      interestedServices: ['Painting'],
    });

    const conflict = await request('PATCH', `/api/admin/marketing-leads/${plumbing._id}`, {
      cookie: superCookie,
      body: { serviceKeys: ['painting'] },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      success: false,
      msg: 'A lead with this email, country, language and service already exists.',
      code: 'CONFLICT',
    });

    const emailChange = await request('PATCH', `/api/admin/marketing-leads/${plumbing._id}`, {
      cookie: superCookie,
      body: { email: 'new@example.com' },
    });
    expect(emailChange.status).toBe(400);
    expect(emailChange.body).toMatchObject({
      success: false,
      code: 'VALIDATION',
      field: 'email',
      msg: 'Email cannot be changed; delete and re-import the lead instead.',
    });

    const edit = await request('PATCH', `/api/admin/marketing-leads/${plumbing._id}`, {
      cookie: superCookie,
      body: { country: 'België', locale: 'Frans', serviceKeys: ['Plumbing', 'plumbing'] },
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data.lead).toMatchObject({
      email: 'same@example.com',
      country: 'BE',
      locale: 'fr',
      serviceKeys: ['plumbing'],
      interestedServices: ['Plumbing'],
    });

    const unchanged = await request('PATCH', `/api/admin/marketing-leads/${plumbing._id}`, {
      cookie: superCookie,
      body: { locale: 'fr' },
    });
    expect(unchanged.status).toBe(200);

    await request('DELETE', `/api/admin/marketing-leads/${painting._id}`, { cookie: superCookie });
    const deletedEdit = await request('PATCH', `/api/admin/marketing-leads/${painting._id}`, {
      cookie: superCookie,
      body: { locale: 'nl' },
    });
    expect(deletedEdit.status).toBe(404);
    expect(deletedEdit.body.msg).toBe('This lead was removed. Refresh the list.');
  });

  it('retains an existing unavailable service but rejects newly added unavailable services', async () => {
    const lead = await seedLead({ email: 'retained@example.com', serviceKeys: ['painting'], interestedServices: ['Painting'] });
    const retained = await request('PATCH', `/api/admin/marketing-leads/${lead._id}`, {
      cookie: superCookie, body: { country: 'NL', locale: 'nl', serviceKeys: ['painting'] },
    });
    expect(retained.status).toBe(200);
    expect(retained.body.data.lead).toMatchObject({ country: 'NL', serviceKeys: ['painting'] });
    const other = await seedLead({ email: 'new-service@example.com', country: 'NL' });
    const rejected = await request('PATCH', `/api/admin/marketing-leads/${other._id}`, {
      cookie: superCookie, body: { serviceKeys: ['painting'] },
    });
    expect(rejected.status).toBe(400);
  });

  it('reports legacy committed imports with rejected rows as partial', async () => {
    await MarketingLeadImport.collection.insertOne({ filename: 'legacy.xlsx', status: 'committed', insertedRows: 3, rejectedRows: 1 });
    const response = await request('GET', '/api/admin/marketing-lead-imports', { cookie: superCookie });
    expect(response.body.data.imports[0]).toMatchObject({ status: 'partial', importedRows: 3, failedRows: 1 });
  });

  it('filters, sorts, pages and reports suppression without deduping emails', async () => {
    const alpha = await seedLead({
      email: 'alpha@example.com',
      country: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
    });
    const beta = await seedLead({
      email: 'beta@example.com',
      country: 'NL',
      locale: 'nl',
      serviceKeys: ['plumbing'],
    });
    const gamma = await seedLead({
      email: 'gamma@example.com',
      country: 'BE',
      locale: 'fr',
      serviceKeys: ['painting'],
      interestedServices: ['Painting'],
    });
    const suppressed = await seedLead({
      email: 'blocked@example.com',
      country: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
    });
    const ownOptOut = await seedLead({
      email: 'own-optout@example.com',
      country: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
      unsubscribedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const subscriberOptOut = await seedLead({
      email: 'subscriber-optout@example.com',
      country: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
    });
    await MarketingSuppression.create({
      emailNormalized: 'blocked@example.com',
      reason: 'provider',
      source: 'brevo',
    });
    await MarketingSubscriber.create({
      email: 'subscriber-optout@example.com',
      emailNormalized: 'subscriber-optout@example.com',
      unsubscribedAt: new Date('2026-01-01T00:00:00.000Z'),
      locale: 'nl',
      interestedServices: [],
      unsubscribeToken: 'sub-token',
    });
    const deleted = await seedLead({
      email: 'deleted@example.com',
      status: 'deleted',
    });

    const byCountry = await request('GET', '/api/admin/marketing-leads?country=Belgium&limit=100', {
      cookie: superCookie,
    });
    expect(byCountry.status).toBe(200);
    expect(byCountry.body.data.leads.every((lead: any) => lead.country === 'BE')).toBe(true);
    expect(byCountry.body.data.pagination.total).toBe(5);

    const byLocale = await request('GET', '/api/admin/marketing-leads?locale=Dutch&limit=100', {
      cookie: superCookie,
    });
    expect(byLocale.body.data.leads.every((lead: any) => lead.locale === 'nl')).toBe(true);

    const byService = await request('GET', '/api/admin/marketing-leads?serviceKey=plumbing&limit=100', {
      cookie: superCookie,
    });
    expect(byService.body.data.leads.map((lead: any) => lead.email).sort()).toEqual([
      'alpha@example.com',
      'beta@example.com',
      'blocked@example.com',
      'own-optout@example.com',
      'subscriber-optout@example.com',
    ]);

    const byEmail = await request('GET', '/api/admin/marketing-leads?q=alpha', {
      cookie: superCookie,
    });
    expect(byEmail.body.data.leads).toHaveLength(1);
    expect(byEmail.body.data.leads[0]._id).toBe(String(alpha._id));

    const pageOne = await request(
      'GET',
      '/api/admin/marketing-leads?sort=service&direction=asc&limit=2&page=1',
      { cookie: superCookie },
    );
    const pageTwo = await request(
      'GET',
      '/api/admin/marketing-leads?sort=service&direction=asc&limit=2&page=2',
      { cookie: superCookie },
    );
    expect(pageOne.body.data.pagination.totalPages).toBe(3);
    expect(pageOne.body.data.leads).toHaveLength(2);
    expect(pageTwo.body.data.leads).toHaveLength(2);
    const ids = [...pageOne.body.data.leads, ...pageTwo.body.data.leads].map((lead: any) => lead._id);
    expect(new Set(ids).size).toBe(4);

    const blockedRow = (await request('GET', '/api/admin/marketing-leads?q=blocked', {
      cookie: superCookie,
    })).body.data.leads[0];
    expect(blockedRow).toMatchObject({ suppressed: true, suppressionReason: 'provider' });
    expect(blockedRow).not.toHaveProperty('emailNormalized');
    expect(blockedRow).not.toHaveProperty('identityHash');
    expect(blockedRow).not.toHaveProperty('deletedAt');

    const ownOptOutRow = (await request('GET', '/api/admin/marketing-leads?q=own-optout', {
      cookie: superCookie,
    })).body.data.leads[0];
    expect(ownOptOutRow).toMatchObject({ suppressed: true, suppressionReason: 'unsubscribe' });

    const subscriberOptOutRow = (await request('GET', '/api/admin/marketing-leads?q=subscriber-optout', {
      cookie: superCookie,
    })).body.data.leads[0];
    expect(subscriberOptOutRow).toMatchObject({ suppressed: true, suppressionReason: 'subscriber' });

    const defaultList = await request('GET', '/api/admin/marketing-leads?limit=100', {
      cookie: superCookie,
    });
    expect(defaultList.body.data.leads.some((lead: any) => lead._id === String(deleted._id))).toBe(false);
    const deletedList = await request('GET', '/api/admin/marketing-leads?status=deleted', {
      cookie: superCookie,
    });
    expect(deletedList.body.data.leads.map((lead: any) => lead._id)).toEqual([String(deleted._id)]);

    expect((await request('GET', '/api/admin/marketing-leads?sort=password', { cookie: superCookie })).status).toBe(400);
    expect((await request('GET', '/api/admin/marketing-leads?direction=sideways', { cookie: superCookie })).status).toBe(400);
    expect((await request('GET', '/api/admin/marketing-leads?country=Atlantis', { cookie: superCookie })).status).toBe(400);
    expect((await request('GET', '/api/admin/marketing-leads?locale=Klingon', { cookie: superCookie })).status).toBe(400);
  });

  it('deletes only the selected row and allows a later re-import', async () => {
    const plumbing = await seedLead({ email: 'row@example.com', serviceKeys: ['plumbing'] });
    const painting = await seedLead({
      email: 'row@example.com',
      serviceKeys: ['painting'],
      interestedServices: ['Painting'],
    });

    const deleted = await request('DELETE', `/api/admin/marketing-leads/${plumbing._id}`, {
      cookie: superCookie,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ success: true, data: { deleted: true } });

    const remaining = await MarketingLead.find({ emailNormalized: 'row@example.com' }).lean();
    expect(remaining.map((lead) => lead.status).sort()).toEqual(['active', 'deleted']);
    expect(remaining.find((lead) => String(lead._id) === String(painting._id))?.status).toBe('active');

    const again = await request('DELETE', `/api/admin/marketing-leads/${plumbing._id}`, {
      cookie: superCookie,
    });
    expect(again.status).toBe(404);

    const reimport = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['row@example.com', 'BE', 'nl', 'Plumbing'],
      ['row@example.com', 'BE', 'nl', 'Painting'],
    ]);
    expect(reimport.status).toBe(201);
    expect(reimport.body.data.import).toMatchObject({
      importedRows: 1,
      duplicateRows: 1,
      failedRows: 0,
      status: 'completed',
    });
    expect(await MarketingLead.countDocuments({ emailNormalized: 'row@example.com', status: 'active' })).toBe(2);
  });

  it('returns file-level failures with a failed history row and no false success', async () => {
    const missingHeader = await importWorkbook([
      ['Email', 'Country'],
      ['a@example.com', 'BE'],
    ], 'missing.xlsx');
    expect(missingHeader.status).toBe(400);
    expect(missingHeader.body).toMatchObject({
      success: false,
      code: 'VALIDATION',
      msg: 'Missing required columns: Language, Service',
    });
    expect(missingHeader.body.data.import).toMatchObject({
      filename: 'missing.xlsx',
      status: 'failed',
      fileError: 'Missing required columns: Language, Service',
    });

    const wrongMagic = await importBytes(Buffer.from('not a workbook'), 'fake.xlsx');
    expect(wrongMagic.status).toBe(400);
    expect(wrongMagic.body.msg).toBe('The uploaded file is not a valid .xlsx or .xls workbook');
    expect(wrongMagic.body.data.import.status).toBe('failed');

    const noRows = await importWorkbook([['Email', 'Country', 'Language', 'Service']], 'empty.xlsx');
    expect(noRows.status).toBe(400);
    expect(noRows.body.msg).toBe('The workbook has no data rows');

    const duplicateHeader = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service', 'Email'],
      ['a@example.com', 'BE', 'nl', 'Plumbing', 'x'],
    ], 'duplicate.xlsx');
    expect(duplicateHeader.status).toBe(400);
    expect(duplicateHeader.body.msg).toBe('Duplicate column header: Email');

    const csv = await importBytes(Buffer.from('Email,Country\nx@example.com,BE'), 'leads.csv');
    expect(csv.status).toBe(400);

    const history = await request('GET', '/api/admin/marketing-lead-imports?limit=10', {
      cookie: superCookie,
    });
    expect(history.status).toBe(200);
    const filenames = history.body.data.imports.map((row: any) => row.filename);
    expect(filenames).toEqual(expect.arrayContaining(['missing.xlsx', 'fake.xlsx', 'empty.xlsx', 'duplicate.xlsx']));
    const failed = history.body.data.imports.find((row: any) => row.filename === 'missing.xlsx');
    expect(failed).toMatchObject({ status: 'failed', importedRows: 0, duplicateRows: 0, failedRows: 0 });
    expect(failed.errors).toEqual([]);
    expect(failed).not.toHaveProperty('validatedRows');
  });

  it('accepts legacy .xls magic and rejects an extension/magic mismatch', async () => {
    const rows = [
      ['Email', 'Country', 'Language', 'Service'],
      ['xls@example.com', 'BE', 'nl', 'Plumbing'],
    ];
    const accepted = await importBytes(workbookBuffer(rows, 'biff8'), 'leads.xls');
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.import.importedRows).toBe(1);

    const mismatch = await importBytes(workbookBuffer(rows, 'biff8'), 'leads.xlsx');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.msg).toBe('The uploaded file is not a valid .xlsx or .xls workbook');
  });

  it('caps row errors while keeping actual failed counts', async () => {
    const rows: unknown[][] = [['Email', 'Country', 'Language', 'Service']];
    for (let index = 0; index < 230; index += 1) {
      rows.push([`bad-${index}`, 'BE', 'nl', 'Plumbing']);
    }
    const response = await importWorkbook(rows, 'many-errors.xlsx');
    expect(response.status).toBe(201);
    expect(response.body.data.import).toMatchObject({
      status: 'failed',
      importedRows: 0,
      duplicateRows: 0,
      failedRows: 230,
      errorCount: 200,
    });
    expect(response.body.data.errors).toHaveLength(200);
  });

  it('supports the proposed import alias and legacy history projection', async () => {
    const alias = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['alias@example.com', 'BE', 'nl', 'Plumbing'],
    ], 'alias.xlsx', superCookie, '/api/admin/marketing-lead-imports');
    expect(alias.status).toBe(201);
    expect(alias.body.data.import.importedRows).toBe(1);

    await mongoose.connection.collection('marketingleadimports').insertOne({
      filename: 'legacy.xlsx',
      uploadedBy: superAdmin._id,
      uploadedAt: new Date('2025-01-01T00:00:00.000Z'),
      status: 'validated',
      totalRows: 5,
      insertedRows: 2,
      updatedRows: 1,
      rejectedRows: 2,
      duplicateRows: 0,
      suppressedRows: 0,
      validatedRows: [{ email: 'secret@example.com' }],
      errors: [{ row: 2, message: 'legacy error' }],
    });
    await mongoose.connection.collection('marketingleadimports').insertOne({
      filename: 'committed.xlsx',
      uploadedBy: superAdmin._id,
      uploadedAt: new Date('2025-01-02T00:00:00.000Z'),
      status: 'committed',
      totalRows: 3,
      insertedRows: 2,
      updatedRows: 1,
      rejectedRows: 0,
      validatedRows: [],
      errors: [],
    });

    const history = await request('GET', '/api/admin/marketing-lead-imports?limit=10', {
      cookie: superCookie,
    });
    const legacy = history.body.data.imports.find((row: any) => row.filename === 'legacy.xlsx');
    expect(legacy).toMatchObject({
      status: 'failed',
      importedRows: 3,
      failedRows: 2,
      duplicateRows: 0,
      totalRows: 5,
      errorCount: 1,
    });
    expect(legacy).not.toHaveProperty('validatedRows');
    expect(legacy.errors).toEqual([
      { row: 2, message: 'legacy error' },
    ]);
    const committed = history.body.data.imports.find((row: any) => row.filename === 'committed.xlsx');
    expect(committed).toMatchObject({ status: 'completed', importedRows: 3 });

    const raw = await mongoose.connection
      .collection('marketingleadimports')
      .findOne({ filename: 'legacy.xlsx' });
    expect(raw?.validatedRows).toHaveLength(1);
  });

  it('does not create users, subscribers or consent during import', async () => {
    const user = await User.create({
      name: 'Existing Customer',
      email: 'existing@example.com',
      phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
      password: await bcrypt.hash('secret123', 4),
      role: 'customer',
      isEmailVerified: true,
      accountStatus: 'active',
    });
    expect(user.marketingConsentAt).toBeNull();

    const response = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['existing@example.com', 'BE', 'nl', 'Plumbing'],
    ]);
    expect(response.status).toBe(201);

    const after = await User.findById(user._id).lean();
    expect(after?.marketingConsentAt).toBeNull();
    expect(after?.notificationPreferences?.promotions?.email).toBe(false);
    expect(await MarketingSubscriber.countDocuments({})).toBe(0);
  });

  it('handles unsubscribe, reimport and lead opt-out inheritance without creating consent', async () => {
    await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['unsub@example.com', 'BE', 'nl', 'Plumbing'],
    ]);
    const token = signUnsubscribePayload('unsub@example.com');

    const preview = await request(
      'GET',
      `/api/public/marketing/unsubscribe?token=${encodeURIComponent(token)}`,
      {},
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.alreadyUnsubscribed).toBe(false);

    const unsubscribe = await request('POST', '/api/public/marketing/unsubscribe', {
      body: { token },
    });
    expect(unsubscribe.status).toBe(200);

    const lead = await MarketingLead.findOne({ emailNormalized: 'unsub@example.com' }).lean();
    expect(lead?.unsubscribedAt).toBeInstanceOf(Date);
    expect(await MarketingSuppression.countDocuments({ emailNormalized: 'unsub@example.com' })).toBe(1);
    const subscriber = await MarketingSubscriber.findOne({ email: 'unsub@example.com' }).lean();
    expect(subscriber?.unsubscribedAt).toBeInstanceOf(Date);
    expect(subscriber?.consentVerifiedAt ?? null).toBeNull();

    const already = await request(
      'GET',
      `/api/public/marketing/unsubscribe?token=${encodeURIComponent(token)}`,
      {},
    );
    expect(already.body.data.alreadyUnsubscribed).toBe(true);

    const reimport = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['unsub@example.com', 'BE', 'nl', 'Plumbing'],
    ]);
    expect(reimport.status).toBe(201);
    expect(reimport.body.data.import.status).toBe('duplicate_only');
    expect((await MarketingLead.findOne({ emailNormalized: 'unsub@example.com' }).lean())?.unsubscribedAt)
      .toBeInstanceOf(Date);
    expect(await MarketingSuppression.countDocuments({ emailNormalized: 'unsub@example.com' })).toBe(1);

    await request('DELETE', `/api/admin/marketing-leads/${lead!._id}`, { cookie: superCookie });
    const afterDelete = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['unsub@example.com', 'BE', 'nl', 'Plumbing'],
    ]);
    expect(afterDelete.status).toBe(201);
    expect(afterDelete.body.data.import.importedRows).toBe(1);
    expect(afterDelete.body.data.import.suppressedRows).toBe(1);
    const recreated = await MarketingLead.findOne({
      emailNormalized: 'unsub@example.com',
      status: 'active',
    }).lean();
    expect(recreated?.unsubscribedAt).toBeInstanceOf(Date);
  });

  it('enforces campaigns.manage read and write levels for leads and imports', async () => {
    const readAdmin = await createAdmin({
      adminPermissionLevels: { campaigns: 'read' },
    });
    const readCookie = jwtCookie(readAdmin);
    expect((await request('GET', '/api/admin/marketing-leads', { cookie: readCookie })).status).toBe(200);
    expect((await request('GET', '/api/admin/marketing-lead-imports', { cookie: readCookie })).status).toBe(200);
    expect((await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['read@example.com', 'BE', 'nl', 'Plumbing'],
    ], 'read.xlsx', readCookie)).status).toBe(403);

    const writeAdmin = await createAdmin({
      adminPermissionLevels: { campaigns: 'write' },
    });
    const writeCookie = jwtCookie(writeAdmin);
    const imported = await importWorkbook([
      ['Email', 'Country', 'Language', 'Service'],
      ['write@example.com', 'BE', 'nl', 'Plumbing'],
    ], 'write.xlsx', writeCookie);
    expect(imported.status).toBe(201);
    const lead = await MarketingLead.findOne({ emailNormalized: 'write@example.com' });
    expect((await request('PATCH', `/api/admin/marketing-leads/${lead!._id}`, {
      cookie: writeCookie,
      body: { locale: 'fr' },
    })).status).toBe(200);
    expect((await request('DELETE', `/api/admin/marketing-leads/${lead!._id}`, {
      cookie: writeCookie,
    })).status).toBe(200);

    const customer = await User.create({
      name: 'Not Admin',
      email: 'not-admin@example.com',
      phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
      password: await bcrypt.hash('secret123', 4),
      role: 'customer',
      isEmailVerified: true,
      accountStatus: 'active',
    });
    expect((await request('GET', '/api/admin/marketing-leads', {
      cookie: jwtCookie(customer),
    })).status).toBe(403);
  });

  it('validates and sanitizes import inputs without user-controlled query injection', async () => {
    const injection = await request(
      'GET',
      '/api/admin/marketing-leads?q=' + encodeURIComponent('.*') + '&sort=' + encodeURIComponent('$where'),
      { cookie: superCookie },
    );
    expect(injection.status).toBe(400);

    const minimumQuery = await request('GET', '/api/admin/marketing-leads?q=a', {
      cookie: superCookie,
    });
    expect(minimumQuery.status).toBe(200);
    expect(minimumQuery.body.data.leads).toEqual([]);

    await seedLead({ email: 'literal.*@example.com' });
    const literal = await request('GET', '/api/admin/marketing-leads?q=' + encodeURIComponent('.*'), {
      cookie: superCookie,
    });
    expect(literal.status).toBe(200);
    expect(literal.body.data.leads).toHaveLength(1);
  });
});
