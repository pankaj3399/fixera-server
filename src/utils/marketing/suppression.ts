import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import { normalizeEmail } from './normalizeEmail';

function uniqueEmails(emails: readonly string[]): string[] {
  return Array.from(
    new Set(emails.map((email) => normalizeEmail(email)).filter(Boolean)),
  );
}

/** Global suppression reason by normalized email. */
export async function loadGlobalSuppressionReasons(
  emails: readonly string[],
): Promise<Map<string, string>> {
  const normalized = uniqueEmails(emails);
  if (normalized.length === 0) return new Map();
  const rows = await MarketingSuppression.find({ emailNormalized: { $in: normalized } })
    .select('emailNormalized reason')
    .lean();
  return new Map(
    rows.map((row) => [normalizeEmail(row.emailNormalized), String(row.reason || 'unsubscribe')]),
  );
}

/**
 * Subscribers that must suppress a mailbox even when the source is a lead:
 * locally unsubscribed rows and provider-blacklisted rows.
 */
export async function loadUnsubscribedSubscriberReasons(
  emails: readonly string[],
): Promise<Map<string, string>> {
  const normalized = uniqueEmails(emails);
  if (normalized.length === 0) return new Map();
  const rows = await MarketingSubscriber.find({
    $and: [
      {
        $or: [
          { emailNormalized: { $in: normalized } },
          { email: { $in: normalized } },
        ],
      },
      {
        $or: [
          { unsubscribedAt: { $ne: null } },
          { brevoUnsubscribedAt: { $ne: null } },
        ],
      },
    ],
  })
    .select('emailNormalized email unsubscribedAt brevoUnsubscribedAt')
    .lean();
  const result = new Map<string, string>();
  for (const row of rows) {
    const email = normalizeEmail(row.emailNormalized || row.email);
    if (!email) continue;
    result.set(email, row.unsubscribedAt ? 'subscriber' : 'provider');
  }
  return result;
}

/** Emails that must never receive a campaign, from any source. */
export async function loadSuppressedEmailSet(emails: readonly string[]): Promise<Set<string>> {
  const normalized = uniqueEmails(emails);
  if (normalized.length === 0) return new Set();
  const [global, subscribers] = await Promise.all([
    loadGlobalSuppressionReasons(normalized),
    loadUnsubscribedSubscriberReasons(normalized),
  ]);
  return new Set<string>([...global.keys(), ...subscribers.keys()]);
}

export function leadSuppressionState(input: {
  emailNormalized?: string | null;
  email?: string | null;
  unsubscribedAt?: Date | string | null;
  globalReasons: Map<string, string>;
  subscriberReasons: Map<string, string>;
}): { suppressed: boolean; suppressionReason: string | null } {
  const email = normalizeEmail(input.emailNormalized || input.email);
  if (!email) return { suppressed: false, suppressionReason: null };
  const globalReason = input.globalReasons.get(email);
  if (globalReason) return { suppressed: true, suppressionReason: globalReason };
  if (input.unsubscribedAt) return { suppressed: true, suppressionReason: 'unsubscribe' };
  const subscriberReason = input.subscriberReasons.get(email);
  if (subscriberReason) return { suppressed: true, suppressionReason: subscriberReason };
  return { suppressed: false, suppressionReason: null };
}
