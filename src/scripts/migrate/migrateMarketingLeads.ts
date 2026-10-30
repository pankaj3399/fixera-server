import mongoose from 'mongoose';
import MarketingLead from '../../models/marketingLead';
import MarketingLeadImport from '../../models/marketingLeadImport';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';
import { normalizeMarketingCountry } from '../../utils/marketing/canonical';
import { normalizeMarketingLanguage } from '../../utils/marketing/marketingCatalog';
import {
  canonicalizeServiceValues,
  indexMarketingServiceOptions,
  loadMarketingServiceOptions,
} from '../../utils/marketing/serviceCatalog';
import { leadIdentityHash, primaryLeadServiceKey } from '../../utils/marketing/leadIdentity';

import { connectMarketingMigration } from './marketingMigration';

/**
 * Safe, explicit rollout for the removed lead flow.
 *
 *   npx tsx src/scripts/migrate/migrateMarketingLeads.ts            # dry run
 *   npx tsx src/scripts/migrate/migrateMarketingLeads.ts --apply    # mutate
 *
 * Requires MIGRATION_MONGO_URI. Default is read-only; use --apply to write.
 * Stop API writes during apply.
 *
 * Apply:
 *  - drops ONLY the obsolete exact single-key unique index on
 *    marketingleads.emailNormalized (the removed flow's index);
 *  - normalizes legacy country/locale/service values and computes
 *    identityHash/primaryServiceKey;
 *  - merges only exact normalized-tuple active duplicates, earliest _id
 *    surviving, earliest opt-out and latest send preserved;
 *  - keeps same-email/different-dimension rows and every upload-history row;
 *  - removes legacy validatedRows payloads and maps legacy statuses/counts;
 *  - creates the new lead and import indexes.
 *
 * It does not run automatically and is never called by a request or cron.
 */

type NormalizedLead = {
  doc: any;
  email: string;
  emailNormalized: string;
  country: string;
  locale: string;
  serviceKeys: string[];
  interestedServices: string[];
  status: 'active' | 'deleted';
  identityHash: string;
};

function earliestDate(values: Array<Date | null | undefined>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((value) => value.getTime())));
}

function latestDate(values: Array<Date | null | undefined>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((value) => value.getTime())));
}

async function main(): Promise<void> {
  const dryRun = await connectMarketingMigration();
  const apply = !dryRun;
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection has no database handle');

  const services = await loadMarketingServiceOptions();
  const serviceIndex = indexMarketingServiceOptions(services);

  const leadCollection = db.collection('marketingleads');
  const importCollection = db.collection('marketingleadimports');

  let indexes: any[] = [];
  try {
    indexes = await leadCollection.indexes();
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 26) throw error; // NamespaceNotFound: fresh install
  }

  const obsoleteEmailIndexes = indexes.filter((index) => {
    const keys = Object.keys(index.key || {});
    return Boolean(index.unique) && keys.length === 1 && keys[0] === 'emailNormalized';
  });
  const otherUniqueEmailIndexes = indexes.filter((index) => {
    const keys = Object.keys(index.key || {});
    return (
      Boolean(index.unique) &&
      !obsoleteEmailIndexes.some((candidate) => candidate.name === index.name) &&
      keys.some((key) => key === 'email' || key === 'emailNormalized')
    );
  });

  if (!dryRun) {
    for (const obsolete of obsoleteEmailIndexes) {
      if (!obsolete.name) continue;
      console.log(`Dropping obsolete lead email index "${obsolete.name}"`);
      await leadCollection.dropIndex(obsolete.name);
    }
  }

  const documents = await leadCollection.find({}).toArray();
  const normalized: NormalizedLead[] = [];
  const unnormalizable: Array<{ id: string; reason: string }> = [];

  for (const doc of documents) {
    const email = normalizeEmail(doc.emailNormalized || doc.email);
    const country = normalizeMarketingCountry(doc.country);
    const locale = normalizeMarketingLanguage(doc.locale);
    const rawServices = [
      ...(Array.isArray(doc.serviceKeys) ? doc.serviceKeys : []),
      ...(Array.isArray(doc.interestedServices) ? doc.interestedServices : []),
    ].map(String);
    const canonical = canonicalizeServiceValues(rawServices, serviceIndex, country);
    const labelByKey = new Map(
      canonical.serviceKeys.map((key, index) => [key, canonical.interestedServices[index] || key]),
    );
    const sortedServiceKeys = [...canonical.serviceKeys].sort();
    const sortedInterestedServices = sortedServiceKeys.map((key) => labelByKey.get(key) || key);
    const reason = !email
      ? 'missing email'
      : !country
        ? 'unknown country'
        : !locale
          ? 'unknown locale'
          : canonical.serviceKeys.length === 0
            ? 'missing service'
            : '';
    if (reason) {
      unnormalizable.push({ id: String(doc._id), reason });
      continue;
    }
    const rawStatus = typeof doc.status === 'string' ? doc.status : 'active';
    const status: 'active' | 'deleted' =
      rawStatus === 'active'
        ? 'active'
        : rawStatus === 'deleted'
          ? 'deleted'
          : 'deleted'; // unknown statuses fail safe, never sendable
    const identityHash = leadIdentityHash({
      emailNormalized: email!,
      country: country!,
      locale: locale!,
      serviceKeys: sortedServiceKeys,
    });
    normalized.push({
      doc,
      email: email!,
      emailNormalized: email!,
      country: country!,
      locale: locale!,
      serviceKeys: sortedServiceKeys,
      interestedServices: sortedInterestedServices,
      status,
      identityHash,
    });
  }

  const activeGroups = new Map<string, NormalizedLead[]>();
  for (const row of normalized) {
    if (row.status !== 'active') continue;
    const group = activeGroups.get(row.identityHash) || [];
    group.push(row);
    activeGroups.set(row.identityHash, group);
  }

  const duplicateGroups = Array.from(activeGroups.values()).filter((group) => group.length > 1);
  let mergedRows = 0;
  let normalizedRows = 0;

  for (const row of normalized) {
    if (row.status !== 'active') {
      // Deleted rows keep their history and normalized fields, but do not
      // participate in active identity uniqueness.
      const set = {
        email: row.email,
        emailNormalized: row.emailNormalized,
        country: row.country,
        locale: row.locale,
        serviceKeys: row.serviceKeys,
        primaryServiceKey: primaryLeadServiceKey(row.serviceKeys),
        interestedServices: row.interestedServices,
        identityHash: row.identityHash,
      };
      if (!dryRun) {
        await leadCollection.updateOne({ _id: row.doc._id }, { $set: set });
      }
      normalizedRows += 1;
      continue;
    }
  }

  for (const group of activeGroups.values()) {
    const sorted = [...group].sort((a, b) => String(a.doc._id).localeCompare(String(b.doc._id)));
    const survivor = sorted[0];
    const duplicates = sorted.slice(1);
    const unsubscribedAt = earliestDate(group.map((row) => row.doc.unsubscribedAt));
    const lastCampaignSentAt = latestDate(group.map((row) => row.doc.lastCampaignSentAt));
    const sourceImportId =
      survivor.doc.sourceImportId ||
      group.find((row) => row.doc.sourceImportId)?.doc.sourceImportId;
    const survivorSet = {
      email: survivor.email,
      emailNormalized: survivor.emailNormalized,
      country: survivor.country,
      locale: survivor.locale,
      serviceKeys: survivor.serviceKeys,
      primaryServiceKey: primaryLeadServiceKey(survivor.serviceKeys),
      interestedServices: survivor.interestedServices,
      identityHash: survivor.identityHash,
      status: 'active',
      unsubscribedAt,
      lastCampaignSentAt,
      ...(sourceImportId ? { sourceImportId } : {}),
    };
    if (!dryRun) {
      await leadCollection.updateOne({ _id: survivor.doc._id }, { $set: survivorSet });
    }
    normalizedRows += 1;
    for (const duplicate of duplicates) {
      mergedRows += 1;
      if (!dryRun) {
        await leadCollection.updateOne(
          { _id: duplicate.doc._id },
          {
            $set: {
              email: duplicate.email,
              emailNormalized: duplicate.emailNormalized,
              country: duplicate.country,
              locale: duplicate.locale,
              serviceKeys: duplicate.serviceKeys,
              primaryServiceKey: primaryLeadServiceKey(duplicate.serviceKeys),
              interestedServices: duplicate.interestedServices,
              identityHash: duplicate.identityHash,
              status: 'deleted',
              deletedAt: duplicate.doc.deletedAt || new Date(),
            },
          },
        );
      }
    }
  }

  const imports = await importCollection.find({}).toArray();
  let importsUpdated = 0;
  for (const imported of imports) {
    const set: Record<string, unknown> = {};
    if (imported.status === 'validated') set.status = 'failed';
    const importedRows =
      imported.importedRows !== undefined
        ? Number(imported.importedRows)
        : Number(imported.insertedRows || 0) + Number(imported.updatedRows || 0);
    const failedRows =
      imported.failedRows !== undefined
        ? Number(imported.failedRows)
        : Number(imported.rejectedRows || 0);
    if (imported.status === 'committed') {
      set.status = failedRows > 0 ? (importedRows > 0 ? 'partial' : 'failed') : 'completed';
    }
    const duplicateRows = Number(imported.duplicateRows || 0);
    if (imported.importedRows === undefined) set.importedRows = importedRows;
    if (imported.failedRows === undefined) set.failedRows = failedRows;
    if (imported.duplicateRows === undefined) set.duplicateRows = duplicateRows;
    if (imported.suppressedRows === undefined) set.suppressedRows = 0;
    if (imported.totalRows === undefined) {
      set.totalRows = importedRows + failedRows + duplicateRows;
    }
    const shouldTouch = Object.keys(set).length > 0 || imported.validatedRows !== undefined;
    if (!shouldTouch) continue;
    importsUpdated += 1;
    if (!dryRun) {
      await importCollection.updateOne(
        { _id: imported._id },
        {
          ...(Object.keys(set).length > 0 ? { $set: set } : {}),
          $unset: { validatedRows: 1 },
        },
      );
    }
  }

  if (!dryRun) {
    await MarketingLead.createIndexes();
    await MarketingLeadImport.createIndexes();
  }

  console.log(JSON.stringify({
    apply,
    dryRun,
    servicesConfigured: services.length,
    leadDocuments: documents.length,
    normalizedRows,
    activeIdentityGroups: activeGroups.size,
    exactDuplicateGroups: duplicateGroups.length,
    duplicateRowsMerged: mergedRows,
    unnormalizableRows: unnormalizable,
    importsProcessed: imports.length,
    importsUpdated,
    obsoleteEmailIndexes: obsoleteEmailIndexes.map((index) => index.name),
    otherUniqueEmailIndexes: otherUniqueEmailIndexes.map((index) => index.name),
    indexesCreated: dryRun ? false : true,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Marketing lead migration failed:', error);
  process.exit(1);
});
