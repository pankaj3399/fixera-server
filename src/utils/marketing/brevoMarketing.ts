import {
  ContactsApi,
  ContactsApiApiKeys,
  EmailCampaignsApi,
  EmailCampaignsApiApiKeys,
  CreateList,
  CreateUpdateFolder,
  CreateEmailCampaign,
  CreateEmailCampaignSender,
  CreateEmailCampaignRecipients,
  RequestContactImport,
  RequestContactImportJsonBodyInner,
  ProcessApi,
  ProcessApiApiKeys,
  CreateAttribute,
  RemoveContactFromList,
  UpdateContact,
  TransactionalEmailsApi,
  TransactionalEmailsApiApiKeys,
} from '@getbrevo/brevo';
import { assertTemplateGreetingContract, MarketingContentError } from './renderCampaign';

const FOLDER_NAME = 'Fixtract Campaigns';
const CONTACT_ATTRIBUTES = ['FIRSTNAME', 'REGION', 'LOCALE', 'UNSUB_TOKEN'] as const;
let folderIdPromise: Promise<number> | undefined;
let attributesPromise: Promise<void> | undefined;

function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return '***';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

function requireApiKey(): string {
  const key = process.env.BREVO_API_KEY?.trim();
  if (!key) throw new Error('BREVO_API_KEY is not configured');
  return key;
}

function createContactsApi(): ContactsApi {
  const api = new ContactsApi();
  api.setApiKey(ContactsApiApiKeys.apiKey, requireApiKey());
  return api;
}

function createCampaignsApi(): EmailCampaignsApi {
  const api = new EmailCampaignsApi();
  api.setApiKey(EmailCampaignsApiApiKeys.apiKey, requireApiKey());
  return api;
}

function createProcessApi(): ProcessApi {
  const api = new ProcessApi();
  api.setApiKey(ProcessApiApiKeys.apiKey, requireApiKey());
  return api;
}

function createTransactionalEmailsApi(): TransactionalEmailsApi {
  const api = new TransactionalEmailsApi();
  api.setApiKey(TransactionalEmailsApiApiKeys.apiKey, requireApiKey());
  return api;
}

function sanitizedBrevoError(error: unknown): { status?: number | string; code?: string; message: string } {
  const value = error as {
    status?: number | string;
    code?: string;
    message?: string;
    response?: { status?: number | string };
  };
  return {
    status: value?.response?.status || value?.status,
    code: value?.code,
    message: typeof value?.message === 'string' ? value.message.slice(0, 200) : 'Brevo request failed',
  };
}

function brevoRequestTimeoutMs(): number {
  const configured = Number(process.env.BREVO_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), 1_000), 120_000)
    : 15_000;
}

async function requestBrevoJson<T>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), brevoRequestTimeoutMs());
  try {
    const response = await fetch(`https://api.brevo.com/v3${path}`, {
      method: options.method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': requireApiKey(),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    const raw = await response.text();
    let body: unknown = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { message: raw.slice(0, 200) };
    }
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : `Brevo request failed with status ${response.status}`;
      const error = new Error(message) as Error & {
        status?: number;
        response?: { status: number };
      };
      error.status = response.status;
      error.response = { status: response.status };
      throw error;
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function isBrevoMarketingConfigured(): boolean {
  return Boolean(process.env.BREVO_API_KEY?.trim());
}

export function isMarketingDryRun(): boolean {
  return process.env.EMAIL_DEV_NO_SEND === 'true' || process.env.MARKETING_CAMPAIGN_DRY_RUN === 'true';
}

export async function sendBrevoTransactionalMarketingEmail(input: {
  to: string;
  subject: string;
  htmlContent: string;
  previewText?: string;
}): Promise<void> {
  if (isMarketingDryRun()) return;
  const fromEmail = process.env.FROM_EMAIL?.trim();
  if (!fromEmail) throw new Error('FROM_EMAIL is required to send a test email');
  try {
    await requestBrevoJson('/smtp/email', {
      method: 'POST',
      body: {
        sender: {
          email: fromEmail,
          name: process.env.BREVO_SENDER_NAME?.trim() || 'Fixtract',
        },
        to: [{ email: input.to }],
        subject: input.subject,
        htmlContent: input.htmlContent,
        ...(input.previewText ? { textContent: input.previewText } : {}),
      },
    });
  } catch (error) {
    console.error('[Brevo] test transactional email failed', sanitizedBrevoError(error));
    throw new Error('Brevo test email failed');
  }
}

async function setBrevoContactBlacklist(
  email: string,
  emailBlacklisted: boolean,
  operationLabel: 'suppression' | 'reactivation',
): Promise<boolean> {
  if (!isBrevoMarketingConfigured() || isMarketingDryRun()) return false;

  const contact = new UpdateContact();
  contact.emailBlacklisted = emailBlacklisted;
  try {
    await createContactsApi().updateContact(email.trim().toLowerCase(), contact);
    return true;
  } catch (error) {
    const details = sanitizedBrevoError(error);
    // No Brevo contact means there is nothing provider-side left to change.
    if (Number(details.status) === 404) return true;
    console.error(`[Brevo] contact ${operationLabel} failed`, {
      email: maskEmail(email),
      ...details,
    });
    throw new Error(`Brevo contact ${operationLabel} failed`);
  }
}

/**
 * GDPR erasure: delete the marketing contact (and its list memberships) from
 * Brevo. 'not_configured' when Brevo is off or in dry-run (nothing synced);
 * a missing contact counts as removed. Throws a sanitized error otherwise.
 */
export async function deleteBrevoMarketingContact(email: string): Promise<'removed' | 'not_configured'> {
  if (!isBrevoMarketingConfigured() || isMarketingDryRun()) return 'not_configured';
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 'removed';
  try {
    await createContactsApi().deleteContact(normalized);
    return 'removed';
  } catch (error) {
    const details = sanitizedBrevoError(error);
    if (Number(details.status) === 404) return 'removed';
    console.error('[Brevo] contact deletion failed', { email: maskEmail(normalized), ...details });
    throw new Error('Brevo contact deletion failed');
  }
}

/**
 * Globally suppress a contact in Brevo so an opt-out applies to any Brevo
 * campaign/list, not only future Fixtract audience resolutions.
 * Returns false when delivery is intentionally disabled and should be retried
 * after Brevo is configured.
 */
export async function suppressBrevoMarketingContact(email: string): Promise<boolean> {
  return setBrevoContactBlacklist(email, true, 'suppression');
}

/**
 * Reverse a previous global marketing suppression after the user explicitly
 * opts back in. A missing provider contact is already safe: the next audience
 * import will create it without a blacklist.
 */
export async function restoreBrevoMarketingContact(email: string): Promise<boolean> {
  return setBrevoContactBlacklist(email, false, 'reactivation');
}

export async function listActiveBrevoTemplates(): Promise<
  Array<{ id: number; name: string; subject: string; tag: string; modifiedAt: string }>
> {
  const api = createTransactionalEmailsApi();
  const templates: Array<{
    id: number;
    name: string;
    subject: string;
    tag: string;
    modifiedAt: string;
  }> = [];
  let offset = 0;

  while (offset < 500) {
    const response = await api.getSmtpTemplates(true, 100, offset, 'desc');
    const page = response.body?.templates || [];
    templates.push(
      ...page.map((template) => ({
        id: template.id,
        name: template.name,
        subject: template.subject,
        tag: template.tag,
        modifiedAt: template.modifiedAt,
      })),
    );
    if (page.length < 100) break;
    offset += page.length;
  }

  return templates;
}

export async function assertBrevoMarketingTemplateContract(
  templateId: number,
  locale: 'en' | 'nl' | 'fr' | 'de',
): Promise<void> {
  await getBrevoMarketingTemplateHtml(templateId, locale);
}

export async function getBrevoMarketingTemplateHtml(
  templateId: number,
  locale: 'en' | 'nl' | 'fr' | 'de',
): Promise<string> {
  try {
    const response = await requestBrevoJson<{ htmlContent?: string }>(
      `/smtp/templates/${encodeURIComponent(String(templateId))}`,
      { method: 'GET' },
    );
    const htmlContent = response.htmlContent || '';
    assertTemplateGreetingContract(htmlContent, locale);
    return htmlContent;
  } catch (error) {
    if (error instanceof MarketingContentError) throw error;
    console.error('[Brevo] template contract lookup failed', {
      templateId,
      ...sanitizedBrevoError(error),
    });
    throw new Error(`Brevo template ${templateId} could not be validated`);
  }
}

/** Resolve or create the Fixtract marketing folder in Brevo. */
export async function resolveMarketingFolderId(): Promise<number> {
  const configured = Number(process.env.BREVO_MARKETING_FOLDER_ID);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const api = createContactsApi();
  const folders = await api.getFolders(50, 0);
  const existing = (folders.body?.folders || []).find(
    (f: { name?: string; id?: number }) => f.name === FOLDER_NAME,
  );
  if (existing?.id) return existing.id;

  const body = new CreateUpdateFolder();
  body.name = FOLDER_NAME;
  const created = await api.createFolder(body);
  const id = created.body?.id;
  if (!id) throw new Error('Failed to create Brevo marketing folder');
  return id;
}

export async function createCampaignList(name: string): Promise<number> {
  if (!folderIdPromise) {
    folderIdPromise = resolveMarketingFolderId().catch((error) => {
      folderIdPromise = undefined;
      throw error;
    });
  }
  const folderId = await folderIdPromise;
  const api = createContactsApi();
  const list = new CreateList();
  list.name = name.slice(0, 100);
  list.folderId = folderId;
  const created = await api.createList(list);
  const id = created.body?.id;
  if (!id) throw new Error('Failed to create Brevo list');
  return id;
}

export type BrevoContactInput = {
  email: string;
  attributes?: Record<string, string | number | boolean>;
};

async function ensureMarketingContactAttributes(): Promise<void> {
  if (!attributesPromise) {
    attributesPromise = (async () => {
      const api = createContactsApi();
      const current = await api.getAttributes();
      const names = new Set((current.body?.attributes || []).map((attribute) => attribute.name));
      for (const name of CONTACT_ATTRIBUTES) {
        if (names.has(name)) continue;
        const attribute = new CreateAttribute();
        attribute.type = CreateAttribute.TypeEnum.Text;
        try {
          await api.createAttribute('normal', name, attribute);
        } catch (error) {
          // Another cold start may have created it after our initial read.
          const refreshed = await api.getAttributes();
          const nowExists = (refreshed.body?.attributes || []).some(
            (candidate) => candidate.name === name,
          );
          if (!nowExists) throw error;
        }
      }
    })().catch((error) => {
      attributesPromise = undefined;
      throw error;
    });
  }
  return attributesPromise;
}

async function waitForImport(processId: number): Promise<void> {
  const api = createProcessApi();
  const timeout = Math.min(
    Math.max(Number(process.env.BREVO_IMPORT_TIMEOUT_MS) || 60_000, 5_000),
    120_000,
  );
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const processState = await api.getProcess(processId);
    if (String(processState.body?.status) === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Brevo contact import ${processId} did not complete within ${timeout}ms`);
}

/** Upsert contacts into a list and wait until Brevo has finished the asynchronous import. */
export async function syncContactsToList(
  listId: number,
  contacts: BrevoContactInput[],
): Promise<{ imported: number }> {
  if (contacts.length === 0) return { imported: 0 };

  await ensureMarketingContactAttributes();
  const api = createContactsApi();
  const targetEmails = new Set(contacts.map((contact) => contact.email.trim().toLowerCase()));
  const staleEmails: string[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const page = await api.getContactsFromList(listId, undefined, pageSize, offset, 'asc');
    const current = page.body?.contacts || [];
    for (const contact of current) {
      const email = contact.email?.trim().toLowerCase();
      if (email && !targetEmails.has(email)) staleEmails.push(email);
    }
    offset += current.length;
    if (current.length < pageSize || offset >= (page.body?.count || 0)) break;
  }

  // Brevo imports add list membership. Remove stale recipients first so retries
  // use the current consent/audience snapshot instead of an additive old list.
  for (let i = 0; i < staleEmails.length; i += 150) {
    const removal = new RemoveContactFromList();
    removal.emails = staleEmails.slice(i, i + 150);
    await api.removeContactFromList(listId, removal);
  }

  const chunkSize = 5000;
  let imported = 0;
  for (let i = 0; i < contacts.length; i += chunkSize) {
    const slice = contacts.slice(i, i + chunkSize);
    const req = new RequestContactImport();
    req.listIds = [listId];
    req.updateExistingContacts = true;
    req.jsonBody = slice.map((c) => {
      const row = new RequestContactImportJsonBodyInner();
      row.email = c.email;
      if (c.attributes) row.attributes = c.attributes;
      return row;
    });
    try {
      const result = await api.importContacts(req);
      await waitForImport(result.body.processId);
    } catch (error) {
      console.error('[Brevo] contact import failed', {
        listId,
        contacts: slice.length,
        sample: maskEmail(slice[0]?.email || ''),
        ...sanitizedBrevoError(error),
      });
      throw new Error('Brevo contact import failed');
    }
    imported += slice.length;
  }
  return { imported };
}

export type CreateBrevoCampaignInput = {
  name: string;
  subject: string;
  htmlContent: string;
  previewText?: string;
  listId: number;
  templateId?: number;
  scheduledAt?: Date | null;
  utmCampaign?: string;
  replyTo?: string;
  footer?: string;
};

export async function createBrevoCampaign(
  input: CreateBrevoCampaignInput,
): Promise<{ campaignId: number }> {
  const api = createCampaignsApi();
  const fromEmail = process.env.FROM_EMAIL?.trim();
  if (!fromEmail) throw new Error('FROM_EMAIL is required to send Brevo campaigns');

  const sender = new CreateEmailCampaignSender();
  sender.email = fromEmail;
  sender.name = process.env.BREVO_SENDER_NAME?.trim() || 'Fixtract';

  const recipients = new CreateEmailCampaignRecipients();
  recipients.listIds = [input.listId];

  const campaign = new CreateEmailCampaign();
  campaign.name = input.name.slice(0, 128);
  campaign.subject = input.subject;
  campaign.sender = sender;
  campaign.recipients = recipients;
  campaign.replyTo = input.replyTo || fromEmail;
  if (input.previewText) campaign.previewText = input.previewText;
  if (input.utmCampaign) {
    const utmCampaign = input.utmCampaign
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (utmCampaign) campaign.utmCampaign = utmCampaign;
  }
  // Inline HTML is already rendered with the application footer. Passing a
  // Brevo footer as well would append it a second time. Template-backed
  // campaigns rely on Brevo to append the footer remotely.
  if (input.footer && !/data-fixera-marketing-footer\s*=\s*["']true["']/i.test(input.htmlContent)) {
    campaign.footer = input.footer;
  }
  if (input.templateId && Number.isFinite(input.templateId)) {
    campaign.templateId = input.templateId;
  } else {
    campaign.htmlContent = input.htmlContent;
  }
  if (input.scheduledAt && input.scheduledAt.getTime() > Date.now() + 60_000) {
    campaign.scheduledAt = input.scheduledAt.toISOString();
  }

  let created;
  try {
    created = await api.createEmailCampaign(campaign);
  } catch (error) {
    console.error('[Brevo] createEmailCampaign failed', sanitizedBrevoError(error));
    throw new Error('Brevo campaign creation failed');
  }
  const campaignId = created.body?.id;
  if (!campaignId) throw new Error('Brevo createEmailCampaign returned no id');

  return { campaignId };
}

export async function sendBrevoCampaignNow(campaignId: number): Promise<void> {
  const api = createCampaignsApi();
  try {
    await api.sendEmailCampaignNow(campaignId);
  } catch (error) {
    const current = await api.getEmailCampaign(campaignId, 'globalStats').catch(() => null);
    if (['sent', 'queued', 'in_process'].includes(String(current?.body?.status))) return;
    console.error('[Brevo] sendEmailCampaignNow failed', {
      campaignId,
      ...sanitizedBrevoError(error),
    });
    throw new Error('Brevo campaign send failed');
  }
}

export async function fetchBrevoCampaignStats(campaignId: number): Promise<{
  sent: number;
  delivered: number;
  uniqueViews: number;
  uniqueClicks: number;
  unsubscriptions: number;
  softBounces: number;
  hardBounces: number;
  status?: string;
}> {
  const api = createCampaignsApi();
  const res = await api.getEmailCampaign(campaignId, 'globalStats');
  const body = res.body;
  const global = body?.statistics?.globalStats;
  return {
    sent: global?.sent ?? 0,
    delivered: global?.delivered ?? 0,
    uniqueViews: global?.uniqueViews ?? 0,
    uniqueClicks: global?.uniqueClicks ?? 0,
    unsubscriptions: global?.unsubscriptions ?? 0,
    softBounces: global?.softBounces ?? 0,
    hardBounces: global?.hardBounces ?? 0,
    status: body?.status != null ? String(body.status) : undefined,
  };
}
