import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const configured = process.env.FIXERA_TEST_MONGODB_URI;
const local = Boolean(configured && /^mongodb:\/\/(127\.0\.0\.1|localhost)/.test(configured) && /test/i.test(configured));
const suite = local ? describe : describe.skip;
const database = `fixera_marketing_migration_test_${process.pid}`;
// Replace (or append) the database segment without relying on a regex that
// misses `mongodb://host:27017/?x=test` and silently keeps the default `test`.
const uri = (() => {
  if (!local) return '';
  const raw = configured!;
  const queryIndex = raw.indexOf('?');
  const base = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : raw.slice(queryIndex);
  const schemeEnd = base.indexOf('://') + 3;
  const pathStart = base.indexOf('/', schemeEnd);
  return pathStart === -1
    ? `${base}/${database}${query}`
    : `${base.slice(0, pathStart)}/${database}${query}`;
})();
const scripts = ['migrateMarketingLeads.ts', 'backfillMarketingIdentities.ts'];

async function run(script: string, args: string[] = [], target = uri) {
  return exec(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), `src/scripts/migrate/${script}`, ...args], {
    env: { ...process.env, MIGRATION_MONGO_URI: target, MONGO_URI: 'mongodb://invalid.invalid/test', MONGODB_URI: 'mongodb://invalid.invalid/test' },
    timeout: 20000,
  });
}

describe('migration database parsing', () => {
  it('accepts multi-host replica-set URIs and requires an explicit database', async () => {
    const { marketingMigrationDatabase } = await import('../../scripts/migrate/marketingMigration');
    expect(marketingMigrationDatabase('mongodb://u:p@h1:27017,h2:27017/fixtract?replicaSet=rs0')).toBe('fixtract');
    expect(marketingMigrationDatabase('mongodb+srv://user:pw@cluster.example.net/leads')).toBe('leads');
    expect(() => marketingMigrationDatabase('mongodb://host:27017')).toThrow('must name an explicit database');
    expect(() => marketingMigrationDatabase('mongodb://host:27017/?x=test')).toThrow('must name an explicit database');
    expect(() => marketingMigrationDatabase('http://host/db')).toThrow('not a valid MongoDB URI');
  });
});

suite('explicit offline marketing migrations', () => {
  beforeAll(async () => {
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    // Never run the drop below against whatever database the URI fell back to.
    expect(mongoose.connection.name).toBe(database);
  });
  afterAll(async () => {
    if (mongoose.connection.name === database) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  });

  it('refuses implicit application targets and conflicting mode flags before connecting', async () => {
    for (const script of scripts) {
      await expect(run(script, [], '')).rejects.toMatchObject({ stderr: expect.stringContaining('Set MIGRATION_MONGO_URI explicitly') });
      await expect(run(script, ['--apply', '--dry-run'])).rejects.toMatchObject({ stderr: expect.stringContaining('Choose either --apply or --dry-run') });
    }
  }, 30000);

  it('keeps both default dry runs read-only, then applies case collisions and reruns safely', async () => {
    const db = mongoose.connection.db!;
    const leads = db.collection('marketingleads');
    await leads.createIndex({ emailNormalized: 1 }, { unique: true });
    await db.collection('users').createIndex({ phone: 1 }, { unique: true });
    await db.collection('serviceconfigurations').insertOne({ service: 'Plumbing', isActive: true, activeCountries: ['BE', 'NL'] });
    await leads.insertMany([
      { emailNormalized: 'A@example.com', country: 'Belgium', locale: 'Nederlands', interestedServices: ['Plumbing'], status: 'active' },
      { emailNormalized: 'a@example.com', country: 'NL', locale: 'nl', interestedServices: ['Plumbing'], status: 'active' },
      { emailNormalized: 'A@EXAMPLE.COM', country: 'BE', locale: 'nl', interestedServices: ['Plumbing'], status: 'active' },
    ]);
    await db.collection('marketingleadimports').insertOne({ status: 'committed', insertedRows: 3, rejectedRows: 1, validatedRows: [{ email: 'legacy@example.com' }] });
    await db.collection('marketingsubscribers').insertOne({ email: 'subscriber@example.com', emailNormalized: 'subscriber@example.com', region: 'BELGIUM', locale: 'Nederlands', interestedServices: ['Plumbing'] });
    await db.collection('marketingcampaigns').insertOne({ name: 'Legacy', audience: { interestedServices: ['Plumbing'] } });
    const snapshot = async () => {
      const names = (await db.listCollections().toArray()).map(c => c.name).sort();
      return Promise.all(names.map(async name => ({ name, docs: await db.collection(name).find().sort({ _id: 1 }).toArray(), indexes: await db.collection(name).indexes() })));
    };
    const before = await snapshot();
    for (const script of scripts) {
      const result = await run(script);
      expect(result.stdout).toContain(database);
      expect(result.stdout).toContain('"dryRun":true');
      expect(await snapshot()).toEqual(before);
    }
    await run(scripts[0], ['--apply']);
    expect(await leads.countDocuments({ status: 'active', emailNormalized: 'a@example.com' })).toBe(2);
    expect(await leads.countDocuments({ status: 'deleted' })).toBe(1);
    const indexes = await leads.indexes();
    expect(indexes.some(i => i.name === 'emailNormalized_1' && i.unique)).toBe(false);
    expect(indexes.some(i => i.name === 'identityHash_1' && i.unique)).toBe(true);
    expect(await db.collection('marketingleadimports').findOne()).toMatchObject({ status: 'partial', importedRows: 3, failedRows: 1 });
    expect(await db.collection('marketingleadimports').findOne()).not.toHaveProperty('validatedRows');
    await run(scripts[0], ['--apply']);
    expect(await leads.countDocuments({ status: 'active' })).toBe(2);
    await run(scripts[1], ['--apply']);
    expect(await db.collection('marketingsubscribers').findOne()).toMatchObject({ region: 'BE', locale: 'nl', serviceKeys: ['plumbing'] });
    expect((await db.collection('users').indexes()).find(i => i.name === 'phone_1')?.unique).toBe(true);
  }, 60000);
});
