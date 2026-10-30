import mongoose from 'mongoose';
import { connectMarketingMigration } from './marketingMigration';
import MarketingCampaign from '../../models/marketingCampaign';
import MarketingSubscriber from '../../models/marketingSubscriber';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';
import { normalizeMarketingCountry } from '../../utils/marketing/canonical';
import { normalizeMarketingLanguage } from '../../utils/marketing/marketingCatalog';
import {
  canonicalizeServiceValues,
  indexMarketingServiceOptions,
  loadMarketingServiceOptions,
  resolveMarketingService,
} from '../../utils/marketing/serviceCatalog';


/**
 * Repair legacy marketing identities with the same canonicalizers used by the
 * live sync, opt-in toggle, profile update and lead import.
 *
 *   npx tsx src/scripts/migrate/backfillMarketingIdentities.ts --dry-run
 *   npx tsx src/scripts/migrate/backfillMarketingIdentities.ts --apply
 *
 * Requires MIGRATION_MONGO_URI. Safe to re-run. Default is read-only;
 * pass --apply to write. No application startup/index helpers run.
 */
async function main(): Promise<void> {
  const dryRun = await connectMarketingMigration();

  const services = await loadMarketingServiceOptions();
  const serviceIndex = indexMarketingServiceOptions(services);

  const unresolved: Array<{ collection: string; id: string; value: string }> = [];
  const subscriberEmails = new Map<string, string[]>();
  const subscribers = await MarketingSubscriber.find()
    .select('email emailNormalized region locale interestedServices serviceKeys')
    .lean();
  for (const subscriber of subscribers) {
    const emailNormalized = normalizeEmail(subscriber.emailNormalized || subscriber.email);
    const ids = subscriberEmails.get(emailNormalized) || [];
    ids.push(String(subscriber._id));
    subscriberEmails.set(emailNormalized, ids);
  }

  const collisions = Array.from(subscriberEmails.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([emailNormalized, ids]) => ({ emailNormalized, ids }));
  if (collisions.length > 0) {
    throw new Error(
      `Marketing identity backfill found ${collisions.length} normalized email collision(s)`,
    );
  }

  let subscribersChanged = 0;
  for (const subscriber of subscribers) {
    const emailNormalized = normalizeEmail(subscriber.emailNormalized || subscriber.email);
    const region = normalizeMarketingCountry(subscriber.region);
    const locale = normalizeMarketingLanguage(subscriber.locale);
    const rawServices = [
      ...(Array.isArray(subscriber.interestedServices) ? subscriber.interestedServices : []),
      ...(Array.isArray(subscriber.serviceKeys) ? subscriber.serviceKeys : []),
    ].map(String);
    const canonical = canonicalizeServiceValues(rawServices, serviceIndex, region);
    for (const value of rawServices) {
      const raw = value.trim();
      if (!raw) continue;
      if (!resolveMarketingService(raw, region, serviceIndex).option) {
        unresolved.push({ collection: 'MarketingSubscriber', id: String(subscriber._id), value: raw });
      }
    }

    const set: Record<string, unknown> = {
      emailNormalized,
      serviceKeys: canonical.serviceKeys,
      interestedServices: canonical.interestedServices,
    };
    if (region) set.region = region;
    if (locale) set.locale = locale;

    const changed =
      subscriber.emailNormalized !== emailNormalized ||
      (region && subscriber.region !== region) ||
      (locale && subscriber.locale !== locale) ||
      JSON.stringify(subscriber.serviceKeys || []) !== JSON.stringify(canonical.serviceKeys) ||
      JSON.stringify(subscriber.interestedServices || []) !== JSON.stringify(canonical.interestedServices);
    if (!changed) continue;
    subscribersChanged += 1;
    if (!dryRun) {
      await MarketingSubscriber.updateOne({ _id: subscriber._id }, { $set: set });
    }
  }

  let campaignsChanged = 0;
  const campaigns = await MarketingCampaign.find().select('audience').lean();
  for (const campaign of campaigns) {
    const audience = campaign.audience || ({} as any);
    const rawServices = [
      ...(Array.isArray(audience.interestedServices) ? audience.interestedServices : []),
      ...(Array.isArray(audience.serviceKeys) ? audience.serviceKeys : []),
    ].map(String);
    const canonical = canonicalizeServiceValues(rawServices, serviceIndex);
    const set: Record<string, unknown> = {
      'audience.serviceKeys': canonical.serviceKeys,
      'audience.interestedServices': canonical.interestedServices,
    };
    const changed =
      JSON.stringify(audience.serviceKeys || []) !== JSON.stringify(canonical.serviceKeys) ||
      JSON.stringify(audience.interestedServices || []) !== JSON.stringify(canonical.interestedServices);
    if (!changed) continue;
    campaignsChanged += 1;
    if (!dryRun) {
      await MarketingCampaign.updateOne({ _id: campaign._id }, { $set: set });
    }
  }

  console.log(JSON.stringify({
    dryRun,
    servicesConfigured: services.length,
    subscribersProcessed: subscribers.length,
    subscribersChanged,
    campaignsProcessed: campaigns.length,
    campaignsChanged,
    unresolvedServices: unresolved,
    emailCollisions: collisions.length,
  }, null, 2));
}

main().then(() => mongoose.disconnect()).catch((error) => {
  console.error('Marketing identity backfill failed:', error);
  process.exit(1);
});
