import mongoose from 'mongoose';

/**
 * Database name from a MongoDB URI, parsed without WHATWG `URL`: a replica-set
 * authority (`h1:27017,h2:27017`) has a non-numeric port for `URL` and would be
 * rejected even though the driver accepts it.
 */
export function marketingMigrationDatabase(uri: string): string {
  const scheme = /^mongodb(?:\+srv)?:\/\//i;
  if (!scheme.test(uri)) {
    throw new Error('MIGRATION_MONGO_URI is not a valid MongoDB URI');
  }
  const withoutScheme = uri.replace(scheme, '');
  const queryIndex = withoutScheme.indexOf('?');
  const withoutQuery = queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex);
  const pathIndex = withoutQuery.indexOf('/');
  const rawDatabase = pathIndex === -1
    ? ''
    : withoutQuery.slice(pathIndex + 1).split('/')[0];
  let database: string;
  try {
    database = decodeURIComponent(rawDatabase || '');
  } catch {
    throw new Error('MIGRATION_MONGO_URI has an invalid database name');
  }
  if (!database) {
    throw new Error('MIGRATION_MONGO_URI must name an explicit database');
  }
  return database;
}

/** Marketing migrations never inherit the application's implicit database target. */
export async function connectMarketingMigration(): Promise<boolean> {
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) {
    throw new Error('Choose either --apply or --dry-run');
  }
  const uri = process.env.MIGRATION_MONGO_URI?.trim();
  if (!uri) throw new Error('Set MIGRATION_MONGO_URI explicitly for this migration');
  // The driver falls back to its default database (`test`) when the URI has no
  // path, so apply mode must refuse that instead of writing somewhere implicit.
  marketingMigrationDatabase(uri);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  console.log(JSON.stringify({ database: mongoose.connection.name, dryRun: !apply }));
  return !apply;
}
