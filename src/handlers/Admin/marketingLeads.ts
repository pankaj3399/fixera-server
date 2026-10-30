import { Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import MarketingLead from '../../models/marketingLead';
import MarketingLeadImport from '../../models/marketingLeadImport';
import { params } from '../../utils/requestParams';
import { UserFacingError } from '../../utils/appErrors';
import { safeErrorSummary } from '../../utils/safeErrorLog';
import { normalizeMarketingCountry } from '../../utils/marketing/canonical';
import { normalizeMarketingLanguage } from '../../utils/marketing/marketingCatalog';
import {
  indexMarketingServiceOptions,
  loadMarketingServiceOptions,
  resolveMarketingService,
} from '../../utils/marketing/serviceCatalog';
import {
  leadIdentityHash,
  normalizeLeadServiceKeys,
  primaryLeadServiceKey,
} from '../../utils/marketing/leadIdentity';
import {
  leadSuppressionState,
  loadGlobalSuppressionReasons,
  loadSuppressedEmailSet,
  loadUnsubscribedSubscriberReasons,
} from '../../utils/marketing/suppression';
import {
  LeadWorkbookError,
  MARKETING_LEAD_MAX_ERRORS,
  MARKETING_LEAD_MAX_FILE_BYTES,
  type LeadImportError,
  type LeadImportRow,
  safeLeadFilename,
  validateLeadWorkbook,
} from '../../utils/marketing/leadImport';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const SORT_FIELDS: Record<string, string> = {
  email: 'emailNormalized',
  country: 'country',
  locale: 'locale',
  service: 'primaryServiceKey',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  lastCampaignSentAt: 'lastCampaignSentAt',
};

const storage = multer.memoryStorage();

function workbookExtension(originalName: string): 'xlsx' | 'xls' | undefined {
  const lower = String(originalName || '').toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.xls')) return 'xls';
  return undefined;
}

const workbookFileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  if (!workbookExtension(file.originalname)) {
    cb(new UserFacingError(400, 'Choose an Excel workbook (.xlsx or .xls) to import', 'VALIDATION'));
    return;
  }
  cb(null, true);
};

/** Dedicated memory upload. The general 50 MB profile upload is never used. */
export const marketingLeadUpload = multer({
  storage,
  fileFilter: workbookFileFilter,
  limits: {
    fileSize: MARKETING_LEAD_MAX_FILE_BYTES,
    files: 1,
  },
});

function adminId(req: Request): mongoose.Types.ObjectId | undefined {
  const raw = (req as any).admin?._id ?? (req as any).user?._id;
  return raw && mongoose.Types.ObjectId.isValid(String(raw))
    ? new mongoose.Types.ObjectId(String(raw))
    : undefined;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ((error as { code?: unknown }).code === 11000 ||
        (error as { code?: unknown }).code === '11000'),
  );
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function serializeImport(doc: any, options: { includeErrors?: boolean } = {}) {
  const value = doc?.toObject ? doc.toObject() : doc || {};
  const rawStatus = typeof value.status === 'string' ? value.status.trim() : '';
  const importedRows =
    value.importedRows !== undefined
      ? numberOr(value.importedRows, 0)
      : numberOr(value.insertedRows, 0) + numberOr(value.updatedRows, 0);
  const duplicateRows = numberOr(value.duplicateRows, 0);
  const failedRows =
    value.failedRows !== undefined ? numberOr(value.failedRows, 0) : numberOr(value.rejectedRows, 0);
  const status = rawStatus === 'committed'
    ? (failedRows > 0 ? (importedRows > 0 ? 'partial' : 'failed') : 'completed')
    : rawStatus === 'validated' ? 'failed' : rawStatus || 'failed';
  const totalRows =
    value.totalRows !== undefined
      ? numberOr(value.totalRows, importedRows + duplicateRows + failedRows)
      : importedRows + duplicateRows + failedRows;
  const rawErrors = Array.isArray(value.rowErrors)
    ? value.rowErrors
    : Array.isArray(value.errors)
      ? value.errors
      : [];
  const errors = rawErrors.slice(0, 200).map((error: any) => ({
    row: Number(error?.row) || 0,
    ...(error?.field ? { field: String(error.field) } : {}),
    message: String(error?.message || ''),
  }));
  return {
    _id: String(value._id),
    filename: typeof value.filename === 'string' && value.filename.trim()
      ? value.filename.trim()
      : 'Workbook',
    uploadedAt: value.uploadedAt || value.createdAt || null,
    uploadedBy: value.uploadedBy ? String(value.uploadedBy) : undefined,
    status,
    totalRows,
    importedRows,
    duplicateRows,
    failedRows,
    suppressedRows: numberOr(value.suppressedRows, 0),
    fileError: value.fileError ?? null,
    errorCount: rawErrors.length,
    ...(options.includeErrors ? { errors } : {}),
  };
}

function serializeLead(
  lead: any,
  state: { suppressed: boolean; suppressionReason: string | null },
) {
  return {
    _id: String(lead._id),
    email: lead.email,
    country: lead.country,
    locale: lead.locale,
    serviceKeys: Array.isArray(lead.serviceKeys) ? lead.serviceKeys : [],
    interestedServices: Array.isArray(lead.interestedServices) ? lead.interestedServices : [],
    status: lead.status,
    unsubscribedAt: lead.unsubscribedAt ?? null,
    lastCampaignSentAt: lead.lastCampaignSentAt ?? null,
    suppressed: state.suppressed,
    suppressionReason: state.suppressionReason,
    sourceImportId: lead.sourceImportId ? String(lead.sourceImportId) : undefined,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

type WriteOutcome = {
  imported: boolean;
  duplicate: boolean;
  failed: boolean;
};

async function writeLeadRows(
  rows: LeadImportRow[],
  sourceImportId: mongoose.Types.ObjectId,
): Promise<{
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
  errors: LeadImportError[];
  suppressedRows: number;
}> {
  const emails = Array.from(new Set(rows.map((row) => row.emailNormalized)));
  const inheritedOptOuts = new Map<string, Date>();
  if (emails.length > 0) {
    const previousOptOuts = await MarketingLead.find({
      emailNormalized: { $in: emails },
      unsubscribedAt: { $ne: null },
    })
      .select('emailNormalized unsubscribedAt')
      .sort({ unsubscribedAt: 1 })
      .lean();
    for (const previous of previousOptOuts) {
      const email = String(previous.emailNormalized || '');
      if (!email || inheritedOptOuts.has(email) || !previous.unsubscribedAt) continue;
      inheritedOptOuts.set(email, previous.unsubscribedAt);
    }
  }

  const outcomes: Array<{ row: LeadImportRow; outcome: WriteOutcome }> = [];
  const WRITE_CONCURRENCY = 50;
  for (let index = 0; index < rows.length; index += WRITE_CONCURRENCY) {
    const chunk = rows.slice(index, index + WRITE_CONCURRENCY);
    const chunkOutcomes = await Promise.all(
      chunk.map(async (row): Promise<{ row: LeadImportRow; outcome: WriteOutcome }> => {
        const now = new Date();
        const identityHash = leadIdentityHash(row);
        try {
          const result = await MarketingLead.updateOne(
            { identityHash, status: 'active' },
            {
              $setOnInsert: {
                email: row.email,
                emailNormalized: row.emailNormalized,
                country: row.country,
                locale: row.locale,
                serviceKeys: row.serviceKeys,
                primaryServiceKey: primaryLeadServiceKey(row.serviceKeys),
                interestedServices: row.interestedServices,
                identityHash,
                status: 'active',
                unsubscribedAt: inheritedOptOuts.get(row.emailNormalized) ?? null,
                sourceImportId,
                createdAt: now,
                updatedAt: now,
              },
            },
            { upsert: true, timestamps: false },
          );
          return {
            row,
            outcome: result.upsertedCount > 0
              ? { imported: true, duplicate: false, failed: false }
              : result.matchedCount > 0
                ? { imported: false, duplicate: true, failed: false }
                : { imported: false, duplicate: false, failed: true },
          };
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            return { row, outcome: { imported: false, duplicate: true, failed: false } };
          }
          console.error('[MARKETING] Lead import row write failed', {
            importId: String(sourceImportId),
            row: row.rowNumber,
            ...safeErrorSummary(error),
          });
          return { row, outcome: { imported: false, duplicate: false, failed: true } };
        }
      }),
    );
    outcomes.push(...chunkOutcomes);
  }

  const importedEmails = new Set(
    outcomes
      .filter((entry) => entry.outcome.imported)
      .map((entry) => entry.row.emailNormalized),
  );
  const suppressedEmails = await loadSuppressedEmailSet(Array.from(importedEmails));
  const suppressedRows = outcomes.filter(
    ({ row, outcome }) => outcome.imported && (
      suppressedEmails.has(row.emailNormalized) || inheritedOptOuts.has(row.emailNormalized)
    ),
  ).length;

  const errors: LeadImportError[] = [];
  for (const entry of outcomes) {
    if (!entry.outcome.failed) continue;
    if (errors.length >= MARKETING_LEAD_MAX_ERRORS) break;
    errors.push({
      row: entry.row.rowNumber,
      message: 'This row could not be saved. Try again.',
    });
  }

  return {
    importedRows: outcomes.filter((entry) => entry.outcome.imported).length,
    duplicateRows: outcomes.filter((entry) => entry.outcome.duplicate).length,
    failedRows: outcomes.filter((entry) => entry.outcome.failed).length,
    errors,
    suppressedRows,
  };
}

function importStatus(input: {
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
}): 'completed' | 'partial' | 'duplicate_only' | 'failed' {
  if (input.importedRows > 0) return input.failedRows > 0 ? 'partial' : 'completed';
  if (input.duplicateRows > 0 && input.failedRows === 0) return 'duplicate_only';
  return 'failed';
}

export const importMarketingLeads = async (req: Request, res: Response) => {
  const file = req.file;
  const uploadedBy = adminId(req);
  if (!uploadedBy) {
    return res.status(401).json({ success: false, msg: 'Admin identity is required', code: 'AUTH_REQUIRED' });
  }
  if (!file) {
    return res.status(400).json({
      success: false,
      msg: 'Choose an Excel workbook (.xlsx or .xls) to import',
      code: 'VALIDATION',
    });
  }

  let importDoc;
  try {
    importDoc = await MarketingLeadImport.create({
      filename: safeLeadFilename(file.originalname),
      uploadedBy,
      uploadedAt: new Date(),
      status: 'processing',
      totalRows: 0,
      importedRows: 0,
      duplicateRows: 0,
      failedRows: 0,
      suppressedRows: 0,
      rowErrors: [],
    });
  } catch (error) {
    console.error('[MARKETING] Could not start lead import', safeErrorSummary(error));
    return res.status(500).json({
      success: false,
      msg: 'The import could not be started. Try again.',
      code: 'INTERNAL',
    });
  }

  const failFile = async (message: string) => {
    importDoc.status = 'failed';
    importDoc.fileError = message;
    importDoc.totalRows = 0;
    importDoc.importedRows = 0;
    importDoc.duplicateRows = 0;
    importDoc.failedRows = 0;
    importDoc.suppressedRows = 0;
    importDoc.rowErrors = [];
    await importDoc.save();
    return res.status(400).json({
      success: false,
      msg: message,
      code: 'VALIDATION',
      data: {
        import: serializeImport(importDoc),
        errors: [],
      },
    });
  };

  try {
    const extension = workbookExtension(file.originalname);
    if (!extension) {
      return await failFile('Choose an Excel workbook (.xlsx or .xls) to import');
    }
    const detected = await fileTypeFromBuffer(file.buffer);
    if (
      !detected ||
      (extension === 'xlsx' && detected.ext !== 'xlsx') ||
      (extension === 'xls' && detected.ext !== 'cfb')
    ) {
      return await failFile('The uploaded file is not a valid .xlsx or .xls workbook');
    }

    const services = await loadMarketingServiceOptions();
    if (services.length === 0) {
      return await failFile('No active services are configured');
    }
    const serviceIndex = indexMarketingServiceOptions(services);
    const validation = validateLeadWorkbook(file.buffer, { serviceIndex });

    const writes = await writeLeadRows(
      validation.rows,
      importDoc._id as mongoose.Types.ObjectId,
    );
    const errors = [...validation.errors, ...writes.errors].slice(
      0,
      MARKETING_LEAD_MAX_ERRORS,
    );
    const importedRows = writes.importedRows;
    const duplicateRows = validation.duplicateRows + writes.duplicateRows;
    const failedRows = validation.failedRows + writes.failedRows;

    importDoc.totalRows = validation.totalRows;
    importDoc.importedRows = importedRows;
    importDoc.duplicateRows = duplicateRows;
    importDoc.failedRows = failedRows;
    importDoc.suppressedRows = writes.suppressedRows;
    importDoc.rowErrors = errors;
    importDoc.fileError = null;
    importDoc.status = importStatus({ importedRows, duplicateRows, failedRows });
    await importDoc.save();

    return res.status(201).json({
      success: true,
      data: {
        import: serializeImport(importDoc),
        summary: {
          totalRows: importDoc.totalRows,
          importedRows: importDoc.importedRows,
          duplicateRows: importDoc.duplicateRows,
          failedRows: importDoc.failedRows,
          suppressedRows: importDoc.suppressedRows,
        },
        errors,
      },
    });
  } catch (error) {
    if (error instanceof LeadWorkbookError) {
      return await failFile(error.message);
    }
    console.error('[MARKETING] Lead import failed', {
      importId: String(importDoc._id),
      ...safeErrorSummary(error),
    });
    try {
      importDoc.status = 'failed';
      importDoc.fileError = 'The import could not be completed. Try again.';
      await importDoc.save();
    } catch (saveError) {
      console.error('[MARKETING] Could not mark lead import failed', {
        importId: String(importDoc._id),
        ...safeErrorSummary(saveError),
      });
    }
    return res.status(500).json({
      success: false,
      msg: 'The import could not be completed. Try again.',
      code: 'INTERNAL',
    });
  }
};

export const listMarketingLeads = async (req: Request, res: Response) => {
  try {
    const { page, limit, q, country, locale, serviceKey, status, sort, direction } = req.query;
    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(
      Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1),
      MAX_LIMIT,
    );
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, unknown> = {
      identityHash: { $exists: true },
    };

    const statusValue = typeof status === 'string' && status.trim() ? status.trim() : 'active';
    if (!['active', 'deleted', 'all'].includes(statusValue)) {
      return res.status(400).json({ success: false, msg: 'Invalid lead status', code: 'VALIDATION' });
    }
    if (statusValue !== 'all') query.status = statusValue;

    if (typeof q === 'string' && q.trim().length >= 2) {
      const escaped = q.trim().slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.emailNormalized = new RegExp(escaped, 'i');
    }
    if (typeof country === 'string' && country.trim()) {
      const canonicalCountry = normalizeMarketingCountry(country);
      if (!canonicalCountry) {
        return res.status(400).json({ success: false, msg: 'Enter a valid country', code: 'VALIDATION' });
      }
      query.country = canonicalCountry;
    }
    if (typeof locale === 'string' && locale.trim()) {
      const canonicalLocale = normalizeMarketingLanguage(locale);
      if (!canonicalLocale) {
        return res.status(400).json({ success: false, msg: 'Unsupported language', code: 'VALIDATION' });
      }
      query.locale = canonicalLocale;
    }
    if (typeof serviceKey === 'string' && serviceKey.trim()) {
      query.serviceKeys = serviceKey.trim().slice(0, 120);
    }

    const sortKey = typeof sort === 'string' && sort.trim() ? sort.trim() : 'createdAt';
    const sortField = SORT_FIELDS[sortKey];
    if (!sortField) {
      return res.status(400).json({ success: false, msg: 'Invalid sort field', code: 'VALIDATION' });
    }
    const directionValue = typeof direction === 'string' && direction.trim()
      ? direction.trim().toLowerCase()
      : 'desc';
    if (directionValue !== 'asc' && directionValue !== 'desc') {
      return res.status(400).json({ success: false, msg: 'Invalid sort direction', code: 'VALIDATION' });
    }
    const sortDirection = directionValue === 'asc' ? 1 : -1;

    const [rows, total] = await Promise.all([
      MarketingLead.find(query)
        .sort({ [sortField]: sortDirection, _id: sortDirection })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      MarketingLead.countDocuments(query),
    ]);

    const emails = rows
      .map((row) => String(row.emailNormalized || row.email || ''))
      .filter(Boolean);
    const [globalReasons, subscriberReasons] = await Promise.all([
      loadGlobalSuppressionReasons(emails),
      loadUnsubscribedSubscriberReasons(emails),
    ]);

    return res.json({
      success: true,
      data: {
        leads: rows.map((row) =>
          serializeLead(
            row,
            leadSuppressionState({
              emailNormalized: row.emailNormalized,
              email: row.email,
              unsubscribedAt: row.unsubscribedAt,
              globalReasons,
              subscriberReasons,
            }),
          ),
        ),
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total,
          totalPages: Math.max(1, Math.ceil(total / limitNumber)),
        },
      },
    });
  } catch (error) {
    console.error('listMarketingLeads:', safeErrorSummary(error));
    return res.status(500).json({ success: false, msg: 'Failed to load leads', code: 'INTERNAL' });
  }
};

export const updateMarketingLead = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid lead id', code: 'VALIDATION' });
    }
    const lead = await MarketingLead.findOne({
      _id: id,
      status: 'active',
      identityHash: { $exists: true },
    });
    if (!lead) {
      return res.status(404).json({
        success: false,
        msg: 'This lead was removed. Refresh the list.',
        code: 'NOT_FOUND',
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (Object.prototype.hasOwnProperty.call(body, 'email')) {
      return res.status(400).json({
        success: false,
        msg: 'Email cannot be changed; delete and re-import the lead instead.',
        code: 'VALIDATION',
        field: 'email',
      });
    }

    const hasCountry = body.country !== undefined;
    const hasLocale = body.locale !== undefined;
    const hasServices = body.serviceKeys !== undefined;
    if (!hasCountry && !hasLocale && !hasServices) {
      return res.status(400).json({
        success: false,
        msg: 'Select at least one field to update',
        code: 'VALIDATION',
      });
    }

    let country = String(lead.country || '');
    if (hasCountry) {
      const canonicalCountry = normalizeMarketingCountry(body.country);
      if (!canonicalCountry) {
        return res.status(400).json({ success: false, msg: 'Enter a valid country', code: 'VALIDATION' });
      }
      country = canonicalCountry;
    }

    let locale = String(lead.locale || '');
    if (hasLocale) {
      const canonicalLocale = normalizeMarketingLanguage(body.locale);
      if (!canonicalLocale) {
        return res.status(400).json({ success: false, msg: 'Unsupported language', code: 'VALIDATION' });
      }
      locale = canonicalLocale;
    }

    let serviceKeys = normalizeLeadServiceKeys(Array.isArray(lead.serviceKeys) ? lead.serviceKeys : []);
    let interestedServices = Array.isArray(lead.interestedServices)
      ? lead.interestedServices.map(String)
      : [];

    if (hasServices) {
      if (!Array.isArray(body.serviceKeys)) {
        return res.status(400).json({
          success: false,
          msg: 'Select at least one service',
          code: 'VALIDATION',
        });
      }
      const rawValues = body.serviceKeys
        .map((value: unknown) => String(value ?? '').trim())
        .filter(Boolean);
      if (rawValues.length === 0) {
        return res.status(400).json({
          success: false,
          msg: 'Select at least one service',
          code: 'VALIDATION',
        });
      }
      if (rawValues.length > 20) {
        return res.status(400).json({
          success: false,
          msg: 'Select no more than 20 services',
          code: 'VALIDATION',
        });
      }

      const services = await loadMarketingServiceOptions();
      const serviceIndex = indexMarketingServiceOptions(services);
      const existingLabelByKey = new Map<string, string>();
      serviceKeys.forEach((key, index) => {
        existingLabelByKey.set(key, interestedServices[index] || key);
      });
      const existingKeyByLabel = new Map<string, string>();
      for (const [key, label] of existingLabelByKey) {
        existingKeyByLabel.set(String(label).trim().toLowerCase(), key);
      }

      const resolved = new Map<string, string>();
      for (const value of rawValues) {
        const displayValue = value.length > 120 ? `${value.slice(0, 120)}…` : value;
        if (value.length > 120) {
          return res.status(400).json({
            success: false,
            msg: `Unknown service: ${displayValue}`,
            code: 'VALIDATION',
            field: 'serviceKeys',
          });
        }
        const result = resolveMarketingService(value, country, serviceIndex);
        const existingKey = existingLabelByKey.has(value)
          ? value
          : existingKeyByLabel.get(value.toLowerCase())
            || (result.option && existingLabelByKey.has(result.option.key) ? result.option.key : undefined);
        if (existingKey) {
          resolved.set(existingKey, existingLabelByKey.get(existingKey) || existingKey);
          continue;
        }
        if (result.reason === 'unavailable') {
          return res.status(400).json({
            success: false,
            msg: `Service is not available in ${country}: ${displayValue}`,
            code: 'VALIDATION',
            field: 'serviceKeys',
          });
        }
        if (result.option) {
          resolved.set(result.option.key, result.option.label);
          continue;
        }
        return res.status(400).json({
          success: false,
          msg: `Unknown service: ${displayValue}`,
          code: 'VALIDATION',
          field: 'serviceKeys',
        });
      }

      serviceKeys = Array.from(resolved.keys()).sort();
      interestedServices = serviceKeys.map((key) => resolved.get(key) || key);
    }

    const identityHash = leadIdentityHash({
      emailNormalized: lead.emailNormalized,
      country,
      locale,
      serviceKeys,
    });

    let updated;
    try {
      updated = await MarketingLead.findOneAndUpdate(
        { _id: lead._id, status: 'active' },
        {
          $set: {
            country,
            locale,
            serviceKeys,
            primaryServiceKey: primaryLeadServiceKey(serviceKeys),
            interestedServices,
            identityHash,
          },
        },
        { new: true },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return res.status(409).json({
          success: false,
          msg: 'A lead with this email, country, language and service already exists.',
          code: 'CONFLICT',
        });
      }
      throw error;
    }
    if (!updated) {
      return res.status(404).json({
        success: false,
        msg: 'This lead was removed. Refresh the list.',
        code: 'NOT_FOUND',
      });
    }

    const [globalReasons, subscriberReasons] = await Promise.all([
      loadGlobalSuppressionReasons([updated.emailNormalized]),
      loadUnsubscribedSubscriberReasons([updated.emailNormalized]),
    ]);
    return res.json({
      success: true,
      data: {
        lead: serializeLead(
          updated,
          leadSuppressionState({
            emailNormalized: updated.emailNormalized,
            email: updated.email,
            unsubscribedAt: updated.unsubscribedAt,
            globalReasons,
            subscriberReasons,
          }),
        ),
      },
    });
  } catch (error) {
    console.error('updateMarketingLead:', safeErrorSummary(error));
    return res.status(500).json({ success: false, msg: 'Failed to save lead', code: 'INTERNAL' });
  }
};

export const deleteMarketingLead = async (req: Request, res: Response) => {
  try {
    const { id } = params(req.params);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, msg: 'Invalid lead id', code: 'VALIDATION' });
    }
    const deleted = await MarketingLead.findOneAndUpdate(
      { _id: id, status: 'active', identityHash: { $exists: true } },
      { $set: { status: 'deleted', deletedAt: new Date() } },
      { new: true },
    );
    if (!deleted) {
      return res.status(404).json({
        success: false,
        msg: 'This lead was removed. Refresh the list.',
        code: 'NOT_FOUND',
      });
    }
    return res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    console.error('deleteMarketingLead:', safeErrorSummary(error));
    return res.status(500).json({ success: false, msg: 'Failed to delete lead', code: 'INTERNAL' });
  }
};

export const listMarketingLeadImports = async (req: Request, res: Response) => {
  try {
    const { page, limit } = req.query;
    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(
      Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1),
      MAX_LIMIT,
    );
    const skip = (pageNumber - 1) * limitNumber;

    const [rows, total] = await Promise.all([
      MarketingLeadImport.find({})
        .select('-validatedRows')
        .sort({ uploadedAt: -1, _id: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      MarketingLeadImport.countDocuments({}),
    ]);

    return res.json({
      success: true,
      data: {
        imports: rows.map((row) => serializeImport(row, { includeErrors: true })),
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total,
          totalPages: Math.max(1, Math.ceil(total / limitNumber)),
        },
      },
    });
  } catch (error) {
    console.error('listMarketingLeadImports:', safeErrorSummary(error));
    return res.status(500).json({
      success: false,
      msg: 'Failed to load upload history',
      code: 'INTERNAL',
    });
  }
};
