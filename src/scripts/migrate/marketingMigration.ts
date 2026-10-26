import mongoose from 'mongoose';

/** Marketing migrations never inherit the application's implicit database target. */
export async function connectMarketingMigration(): Promise<boolean> {
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) {
    throw new Error('Choose either --apply or --dry-run');
  }
  const uri = process.env.MIGRATION_MONGO_URI?.trim();
  if (!uri) throw new Error('Set MIGRATION_MONGO_URI explicitly for this migration');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  console.log(JSON.stringify({ database: mongoose.connection.name, dryRun: !apply }));
  return !apply;
}
