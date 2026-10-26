import MarketingCampaign, {
  type IMarketingCampaign,
  type MarketingLocale,
  MARKETING_LOCALES,
  campaignAudienceType,
} from '../../models/marketingCampaign';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingLead from '../../models/marketingLead';
import { randomUUID } from 'node:crypto';
import { MARKETING_AUDIENCE_LIMIT } from './audience';
import { resolveMarketingAudience } from './audienceResolver';
import {
  renderMarketingEmail,
  renderMarketingFooter,
  type MarketingFooterVariant,
} from './renderCampaign';
import {
  createBrevoCampaign,
  createCampaignList,
  fetchBrevoCampaignStats,
  isBrevoMarketingConfigured,
  isMarketingDryRun,
  sendBrevoCampaignNow,
  syncContactsToList,
  assertBrevoMarketingTemplateContract,
} from './brevoMarketing';
import { signUnsubscribePayload } from './unsubscribeToken';

function contentForLocale(campaign: IMarketingCampaign, locale: MarketingLocale) {
  const content = campaign.content as any;
  return content?.[locale] || null;
}

function localesToSend(campaign: IMarketingCampaign): MarketingLocale[] {
  const requested = (campaign.audience?.locales || []) as MarketingLocale[];
  const available = MARKETING_LOCALES.filter((l) => {
    const c = contentForLocale(campaign, l);
    return c && c.subject && (c.htmlContent || c.brevoTemplateId);
  });
  if (requested.length === 0) return available;
  return available.filter((l) => requested.includes(l));
}

function defaultReengagementInactiveDays(): number {
  const fromEnv = Number(process.env.MARKETING_REENGAGEMENT_INACTIVE_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 60;
}

function resolveReengagementInactiveDays(campaign: IMarketingCampaign): number | undefined {
  if (campaign.type !== 'reengagement') return undefined;
  const raw = Number(campaign.inactiveDays);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return defaultReengagementInactiveDays();
}

export const MARKETING_SEND_LEASE_MS = 30 * 60 * 1000;
export const MARKETING_MAX_SEND_ATTEMPTS = 3;
const MARKETING_RETRY_BASE_MS = 15 * 60 * 1000;

function nextCampaignRetryAt(attempt: number): Date {
  const exponent = Math.max(0, Math.min(attempt - 1, 5));
  return new Date(Date.now() + MARKETING_RETRY_BASE_MS * 2 ** exponent);
}

async function failOwnedCampaign(
  campaignId: string,
  claimId: string,
  error: string,
  deliveries?: IMarketingCampaign['deliveries'],
  attempt = 1,
): Promise<{ ok: false; error: string }> {
  const set: Record<string, unknown> = {
    status: 'failed',
    lastError: error,
    sendStartedAt: null,
    nextRetryAt: nextCampaignRetryAt(attempt),
  };
  if (deliveries) set.deliveries = deliveries;

  await MarketingCampaign.updateOne(
    { _id: campaignId, status: 'sending', sendClaimId: claimId },
    { $set: set, $unset: { sendClaimId: 1 } },
  );
  return { ok: false, error };
}

export async function sendMarketingCampaign(
  campaignId: string,
  opts?: { forceNow?: boolean; claimId?: string },
): Promise<{ ok: true; campaign: IMarketingCampaign } | { ok: false; error: string }> {
  let campaign = await MarketingCampaign.findById(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found' };

  if (!['draft', 'scheduled', 'failed', 'sending'].includes(campaign.status)) {
    return { ok: false, error: `Cannot send campaign in status ${campaign.status}` };
  }

  if (!opts?.forceNow && campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() + 60_000) {
    campaign.status = 'scheduled';
    await campaign.save();
    return { ok: true, campaign };
  }

  const claimId = opts?.claimId || randomUUID();
  if (opts?.claimId) {
    const owned = await MarketingCampaign.findOne({
      _id: campaignId,
      status: 'sending',
      sendClaimId: claimId,
    });
    if (!owned) {
      return { ok: false, error: 'Campaign send claim is no longer owned by this invocation' };
    }
    campaign = owned;
  } else {
    const staleBefore = new Date(Date.now() - MARKETING_SEND_LEASE_MS);
    const claimed = await MarketingCampaign.findOneAndUpdate(
      {
        _id: campaign._id,
        $or: [
          { status: { $in: ['draft', 'scheduled', 'failed'] } },
          {
            status: 'sending',
            $or: [
              { sendStartedAt: { $lte: staleBefore } },
              { sendStartedAt: null },
              { sendStartedAt: { $exists: false } },
            ],
          },
        ],
      },
      {
        $set: {
          status: 'sending',
          sendClaimId: claimId,
          sendStartedAt: new Date(),
        },
        $inc: { sendAttempts: 1 },
        $unset: { lastError: 1 },
      },
      { new: true },
    );

    if (!claimed) {
      const current = await MarketingCampaign.findById(campaignId).select('status').lean();
      return {
        ok: false,
        error: current
          ? `Cannot send campaign in status ${current.status}`
          : 'Campaign not found',
      };
    }
    campaign = claimed;
  }
  const sendAttempt = Math.max(1, campaign.sendAttempts || 1);

  const audienceType = campaignAudienceType(campaign.audienceType);
  if (!audienceType) {
    return failOwnedCampaign(
      campaignId,
      claimId,
      'This campaign has an unsupported audience type. Edit the campaign and select Subscribers, Subscribers+Leads, or Leads before sending.',
      undefined,
      sendAttempt,
    );
  }
  const campaignRoles = campaign.audience?.roles?.length
    ? campaign.audience.roles
    : (['customer', 'professional'] as Array<'customer' | 'professional'>);
  if (audienceType !== 'subscribers') {
    if (campaign.type !== 'invitation') {
      return failOwnedCampaign(
        campaignId,
        claimId,
        'Lead audiences are only available for invitation campaigns',
        undefined,
        sendAttempt,
      );
    }
    if (!campaignRoles.includes('professional')) {
      return failOwnedCampaign(
        campaignId,
        claimId,
        'Lead audiences require the professional role',
        undefined,
        sendAttempt,
      );
    }
  }
  const footerVariant: MarketingFooterVariant =
    audienceType === 'subscribers' ? 'subscriber' : 'invitation';

  const locales = localesToSend(campaign);
  if (locales.length === 0) {
    return failOwnedCampaign(
      campaignId,
      claimId,
      'Add at least one locale with subject and HTML (or Brevo template id)',
      undefined,
      sendAttempt,
    );
  }

  if (!isBrevoMarketingConfigured() && !isMarketingDryRun()) {
    return failOwnedCampaign(
      campaignId,
      claimId,
      'BREVO_API_KEY is not configured',
      undefined,
      sendAttempt,
    );
  }

  let members;
  let audienceAudit = {
    deduplicatedRecipientCount: 0,
    criteriaHash: '',
  };
  try {
    const previousCriteriaHash = campaign.deliveries.find(
      (delivery) => delivery.criteriaHash,
    )?.criteriaHash;
    const resolved = await resolveMarketingAudience({
      campaignType: campaign.type,
      audienceType,
      filters: campaign.audience,
      contentLocales: locales,
      inactiveDays: resolveReengagementInactiveDays(campaign),
      limitMode: 'delivery',
    });
    if (resolved.overLimit) throw new Error(`Audience has ${resolved.exactTotal} recipients, exceeding the configured delivery limit of ${MARKETING_AUDIENCE_LIMIT}`);
    if (previousCriteriaHash && previousCriteriaHash !== resolved.criteriaHash) {
      throw new Error(
        'Campaign audience changed since the last attempt; review the campaign before retrying',
      );
    }
    audienceAudit = {
      deduplicatedRecipientCount: resolved.deduplicated,
      criteriaHash: resolved.criteriaHash,
    };
    // Defense in depth: one mailbox, one recipient, regardless of source.
    const memberByEmail = new Map<string, (typeof resolved.recipients)[number]>();
    for (const recipient of resolved.recipients) {
      if (!memberByEmail.has(recipient.email)) memberByEmail.set(recipient.email, recipient);
    }
    members = Array.from(memberByEmail.values()).map((recipient) => ({
      email: recipient.email,
      name: recipient.firstName,
      locale: recipient.locale,
      region: recipient.country,
      subscriberId: recipient.subscriberId,
      leadId: recipient.leadId,
      userId: recipient.userId,
      source: recipient.source,
    }));
  } catch (err: any) {
    const raw = err?.message || String(err) || 'Failed to resolve campaign audience';
    console.error('[MARKETING] Failed to resolve campaign audience:', { campaignId, error: raw });
    const error = /^Audience has \d+ recipients/.test(raw) ||
      raw.startsWith('Campaign audience changed since the last attempt')
      ? raw
      : 'Failed to resolve the campaign audience. Check the campaign filters and try again.';
    return failOwnedCampaign(campaignId, claimId, error, undefined, sendAttempt);
  }

  if (members.length === 0) {
    const emptyMessage =
      audienceType === 'leads'
        ? 'Audience is empty — import leads and check filters'
        : audienceType === 'both'
          ? 'Audience is empty — sync subscribers, import leads and check filters'
          : 'Audience is empty — sync subscribers and check filters';
    return failOwnedCampaign(campaignId, claimId, emptyMessage, undefined, sendAttempt);
  }

  const stamp = Date.now().toString(36);
  const deliveries: IMarketingCampaign['deliveries'] = campaign.deliveries.map((delivery) => ({
    locale: delivery.locale,
    brevoListId: delivery.brevoListId,
    brevoCampaignId: delivery.brevoCampaignId,
    brevoStatus: delivery.brevoStatus,
    recipientCount: delivery.recipientCount,
    subscriberCount: delivery.subscriberCount,
    leadCount: delivery.leadCount,
    deduplicatedRecipientCount: delivery.deduplicatedRecipientCount,
    criteriaHash: delivery.criteriaHash,
    stats: delivery.stats,
    error: delivery.error,
  }));
  const checkpoint = async (): Promise<boolean> => {
    const result = await MarketingCampaign.updateOne(
      { _id: campaignId, status: 'sending', sendClaimId: claimId },
      { $set: { deliveries, sendStartedAt: new Date() } },
    );
    return result.matchedCount === 1;
  };
  const recordDelivery = (delivery: IMarketingCampaign['deliveries'][number]) => {
    const index = deliveries.findIndex((existing) => existing.locale === delivery.locale);
    if (index >= 0) deliveries[index] = delivery;
    else deliveries.push(delivery);
  };

  try {
    for (const locale of locales) {
      const completed = deliveries.find(
        (delivery) =>
          delivery.locale === locale &&
          delivery.brevoCampaignId &&
          delivery.brevoStatus !== 'created',
      );
      if (completed) continue;

      if (!(await checkpoint())) {
        return { ok: false, error: 'Campaign send claim was lost before completion' };
      }

      const content = contentForLocale(campaign, locale);
      if (!content) continue;

      if (content.brevoTemplateId) {
        await assertBrevoMarketingTemplateContract(content.brevoTemplateId, locale);
      }

      const localeMembers = members.filter((m) => m.locale === locale);
      // Fallback: if no one has this locale, only send en to unmatched when locale===en
      const recipients =
        locale === 'en'
          ? members.filter((m) => m.locale === 'en' || !locales.includes(m.locale))
          : localeMembers;
      const localeSourceCounts = {
        subscriberCount: recipients.filter((r) => r.source === 'subscriber').length,
        leadCount: recipients.filter((r) => r.source === 'lead').length,
      };

      if (recipients.length === 0) {
        recordDelivery({
          locale,
          recipientCount: 0,
          subscriberCount: 0,
          leadCount: 0,
          ...audienceAudit,
          error: 'No recipients for locale',
        });
        if (!(await checkpoint())) {
          return { ok: false, error: 'Campaign send claim was lost before completion' };
        }
        continue;
      }

      if (isMarketingDryRun()) {
        recordDelivery({
          locale,
          recipientCount: recipients.length,
          ...localeSourceCounts,
          ...audienceAudit,
          stats: {
            sent: recipients.length,
            delivered: 0,
            uniqueViews: 0,
            uniqueClicks: 0,
            unsubscriptions: 0,
            softBounces: 0,
            hardBounces: 0,
          },
        });
        if (!(await checkpoint())) {
          return { ok: false, error: 'Campaign send claim was lost before completion' };
        }
        continue;
      }

      const previous = deliveries.find((delivery) => delivery.locale === locale);
      const listName = `fx-${campaign.type}-${locale}-${stamp}`.slice(0, 100);
      const listId = previous?.brevoListId || (await createCampaignList(listName));
      recordDelivery({
        locale,
        brevoListId: listId,
        brevoCampaignId: previous?.brevoCampaignId,
        brevoStatus: previous?.brevoStatus,
        recipientCount: recipients.length,
        ...localeSourceCounts,
        ...audienceAudit,
      });
      if (!(await checkpoint())) {
        return { ok: false, error: 'Campaign send claim was lost before contact import' };
      }

      await syncContactsToList(
        listId,
        recipients.map((r) => ({
          email: r.email,
          attributes: {
            REGION: r.region || '',
            LOCALE: r.locale,
            FIRSTNAME: r.name || '',
            UNSUB_TOKEN: signUnsubscribePayload(r.email),
          },
        })),
      );
      // Renew lease after the long contact import so another runner cannot reclaim
      // before we persist the Brevo draft id.
      if (!(await checkpoint())) {
        return { ok: false, error: 'Campaign send claim was lost after contact import' };
      }

      let brevoCampaignId = previous?.brevoCampaignId;
      if (!brevoCampaignId) {
        const rendered = renderMarketingEmail({
          content,
          locale,
          firstName: '{{ contact.FIRSTNAME }}',
          footerVariant,
        });
        const inlineHtml = content.brevoTemplateId ? content.htmlContent : rendered.htmlContent;
        const created = await createBrevoCampaign({
          name: `${campaign.name} [${locale}]`,
          subject: rendered.subject,
          htmlContent: inlineHtml,
          previewText: rendered.previewText,
          listId,
          templateId: content.brevoTemplateId,
          // The application claims this campaign only after its persisted scheduledAt is due.
          // Brevo must send immediately at that point; passing the original timestamp here can
          // schedule it again (or leave it unsent when that timestamp is already in the past).
          scheduledAt: null,
          utmCampaign: campaign.utmCampaign || `Fixtract ${campaign.type} ${campaign._id}`,
          footer: content.brevoTemplateId
            ? renderMarketingFooter(locale, undefined, footerVariant)
            : undefined,
        });
        brevoCampaignId = created.campaignId;
        recordDelivery({
          locale,
          brevoListId: listId,
          brevoCampaignId,
          brevoStatus: 'created',
          recipientCount: recipients.length,
          ...localeSourceCounts,
          ...audienceAudit,
        });
        if (!(await checkpoint())) {
          return { ok: false, error: 'Campaign send claim was lost after Brevo draft creation' };
        }
      }

      await sendBrevoCampaignNow(brevoCampaignId);

      recordDelivery({
        locale,
        brevoListId: listId,
        brevoCampaignId,
        brevoStatus: 'sent',
        recipientCount: recipients.length,
        ...localeSourceCounts,
        ...audienceAudit,
      });
      if (!(await checkpoint())) {
        return { ok: false, error: 'Campaign send claim was lost after delivery' };
      }

      const ids = recipients.map((r) => r.subscriberId).filter(Boolean);
      if (ids.length > 0) {
        await MarketingSubscriber.updateMany(
          { _id: { $in: ids } },
          { $set: { lastCampaignSentAt: new Date() } },
        );
      }
      const leadIds = recipients.map((r) => r.leadId).filter(Boolean);
      if (leadIds.length > 0) {
        await MarketingLead.updateMany(
          { _id: { $in: leadIds } },
          { $set: { lastCampaignSentAt: new Date() } },
        );
      }
    }

    const completed = await MarketingCampaign.findOneAndUpdate(
      { _id: campaignId, status: 'sending', sendClaimId: claimId },
      {
        $set: {
          deliveries,
          status: 'sent',
          sentAt: new Date(),
          sendStartedAt: null,
        },
        $unset: { sendClaimId: 1, lastError: 1, nextRetryAt: 1 },
      },
      { new: true },
    );
    if (!completed) {
      return { ok: false, error: 'Campaign send claim was lost before completion' };
    }
    return { ok: true, campaign: completed };
  } catch (err: any) {
    console.error('[MARKETING] Campaign send failed:', {
      campaignId,
      error: err?.message || String(err) || 'Send failed',
    });
    return failOwnedCampaign(
      campaignId,
      claimId,
      'Campaign send failed. Check server logs for details.',
      deliveries,
      sendAttempt,
    );
  }
}

export async function refreshCampaignStats(campaignId: string): Promise<IMarketingCampaign | null> {
  const campaign = await MarketingCampaign.findById(campaignId);
  if (!campaign) return null;
  if (isMarketingDryRun()) return campaign;
  if (campaign.status !== 'sent') {
    throw new Error('Campaign statistics can only be refreshed after delivery');
  }

  for (const delivery of campaign.deliveries) {
    if (!delivery.brevoCampaignId) continue;
    try {
      const remoteStats = await fetchBrevoCampaignStats(delivery.brevoCampaignId);
      const stats = {
        sent: remoteStats.sent,
        delivered: remoteStats.delivered,
        uniqueViews: remoteStats.uniqueViews,
        uniqueClicks: remoteStats.uniqueClicks,
        unsubscriptions: remoteStats.unsubscriptions,
        softBounces: remoteStats.softBounces,
        hardBounces: remoteStats.hardBounces,
      };
      await MarketingCampaign.updateOne(
        { _id: campaignId, status: 'sent', 'deliveries.locale': delivery.locale },
        { $set: { 'deliveries.$.stats': stats }, $unset: { 'deliveries.$.error': 1 } },
      );
    } catch (err: any) {
      console.error('[MARKETING] Failed to refresh campaign delivery stats:', {
        campaignId,
        locale: delivery.locale,
        error: err?.message || String(err),
      });
      await MarketingCampaign.updateOne(
        { _id: campaignId, status: 'sent', 'deliveries.locale': delivery.locale },
        { $set: { 'deliveries.$.error': 'Statistics refresh failed. Check server logs for details.' } },
      );
    }
  }
  return MarketingCampaign.findById(campaignId);
}

/** Daily re-engagement: send the newest autoSend reengagement campaign that is draft/scheduled. */
export async function runReengagementSweep(): Promise<{
  attempted: boolean;
  campaignId?: string;
  error?: string;
  recipientHint?: number;
}> {
  const campaign = await MarketingCampaign.findOne({
    type: 'reengagement',
    autoSend: true,
    $or: [
      { status: 'draft' },
      { status: 'scheduled', scheduledAt: { $lte: new Date() } },
    ],
  }).sort({ updatedAt: -1 });

  if (!campaign) return { attempted: false };

  const result = await sendMarketingCampaign(String(campaign._id), { forceNow: true });
  if (!result.ok) {
    return { attempted: true, campaignId: String(campaign._id), error: result.error };
  }
  const total = result.campaign.deliveries.reduce((n, d) => n + (d.recipientCount || 0), 0);
  return { attempted: true, campaignId: String(campaign._id), recipientHint: total };
}
