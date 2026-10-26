import * as XLSX from 'xlsx';
import { isValidEmail, normalizeEmail } from './normalizeEmail';
import {
  type MarketingLocale,
  normalizeMarketingLanguage,
} from './marketingCatalog';
import { normalizeMarketingCountry } from './canonical';
import {
  resolveServiceCell,
  type MarketingServiceIndex,
} from './serviceCatalog';
import { leadTupleKey } from './leadIdentity';

export const MARKETING_LEAD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MARKETING_LEAD_MAX_ROWS = 5000;
export const MARKETING_LEAD_MAX_ERRORS = 200;
export const MARKETING_LEAD_MAX_SERVICES = 20;
export const MARKETING_LEAD_MAX_EMAIL_LENGTH = 320;

const REQUIRED_HEADERS = [
  { key: 'email', label: 'Email' },
  { key: 'country', label: 'Country' },
  { key: 'language', label: 'Language' },
  { key: 'service', label: 'Service' },
] as const;

type RequiredHeaderKey = (typeof REQUIRED_HEADERS)[number]['key'];

export type LeadImportRow = {
  rowNumber: number;
  email: string;
  emailNormalized: string;
  country: string;
  locale: MarketingLocale;
  serviceKeys: string[];
  interestedServices: string[];
};

export type LeadImportError = {
  row: number;
  field?: string;
  message: string;
};

export type LeadImportValidation = {
  totalRows: number;
  duplicateRows: number;
  failedRows: number;
  rows: LeadImportRow[];
  errors: LeadImportError[];
};

/** A file-level problem. These reject the whole workbook but keep history. */
export class LeadWorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadWorkbookError';
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function boundedDisplay(value: string, max = 120): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function normalizedHeader(value: unknown): string {
  return cellText(value)
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerKey(value: unknown): RequiredHeaderKey | null {
  const normalized = normalizedHeader(value);
  if (normalized === 'email') return 'email';
  if (normalized === 'country') return 'country';
  if (normalized === 'language' || normalized === 'locale') return 'language';
  if (normalized === 'service') return 'service';
  return null;
}

function firstNonEmptyMatrixRow(matrix: unknown[][]): number {
  return matrix.findIndex((row) => row.some((cell) => cellText(cell).length > 0));
}

function readFirstNonEmptySheet(buffer: Buffer): unknown[][] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      raw: false,
      cellDates: false,
    });
  } catch {
    throw new LeadWorkbookError('The uploaded file is not a valid .xlsx or .xls workbook');
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: true,
    });
    if (firstNonEmptyMatrixRow(matrix) >= 0) return matrix;
  }
  throw new LeadWorkbookError('The workbook does not contain a non-empty worksheet');
}

function boundedErrors(errors: LeadImportError[]): LeadImportError[] {
  return errors.slice(0, MARKETING_LEAD_MAX_ERRORS);
}

export function safeLeadFilename(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const basename = raw.split(/[\\/]/).pop() || '';
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'marketing-leads.xlsx';
  return cleaned;
}

/**
 * Parse and validate an Excel workbook in memory. Writes nothing.
 *
 * File-level problems throw LeadWorkbookError. Row-level problems are counted
 * and reported; valid unique rows are returned for the atomic writer.
 */
export function validateLeadWorkbook(
  buffer: Buffer,
  options: { serviceIndex: MarketingServiceIndex },
): LeadImportValidation {
  if (!buffer || buffer.length === 0) {
    throw new LeadWorkbookError('The uploaded file is not a valid .xlsx or .xls workbook');
  }
  if (buffer.length > MARKETING_LEAD_MAX_FILE_BYTES) {
    throw new LeadWorkbookError('The workbook must be 5 MB or smaller');
  }

  const matrix = readFirstNonEmptySheet(buffer);
  const headerIndex = firstNonEmptyMatrixRow(matrix);
  const rawHeaders = matrix[headerIndex] || [];
  const headerPositions = new Map<RequiredHeaderKey, number>();

  rawHeaders.forEach((rawHeader, index) => {
    const key = headerKey(rawHeader);
    if (!key) return;
    if (headerPositions.has(key)) {
      throw new LeadWorkbookError(
        `Duplicate column header: ${boundedDisplay(cellText(rawHeader), 80)}`,
      );
    }
    headerPositions.set(key, index);
  });

  const missing = REQUIRED_HEADERS.filter((header) => !headerPositions.has(header.key));
  if (missing.length > 0) {
    throw new LeadWorkbookError(
      `Missing required columns: ${missing.map((header) => header.label).join(', ')}`,
    );
  }

  const dataRows = matrix
    .slice(headerIndex + 1)
    .map((row, offset) => ({ row, rowNumber: headerIndex + offset + 2 }))
    .filter(({ row }) => row.some((cell) => cellText(cell).length > 0));
  if (dataRows.length === 0) {
    throw new LeadWorkbookError('The workbook has no data rows');
  }
  if (dataRows.length > MARKETING_LEAD_MAX_ROWS) {
    throw new LeadWorkbookError(
      `The workbook contains more than ${MARKETING_LEAD_MAX_ROWS} data rows`,
    );
  }

  const valueAt = (row: unknown[], key: RequiredHeaderKey): string => {
    const index = headerPositions.get(key);
    return index === undefined ? '' : cellText(row[index]);
  };

  const errors: LeadImportError[] = [];
  const rows: LeadImportRow[] = [];
  const seen = new Set<string>();
  let duplicateRows = 0;
  let failedRows = 0;

  dataRows.forEach(({ row: rawRow, rowNumber }) => {
    const rawEmail = valueAt(rawRow, 'email');
    const rawCountry = valueAt(rawRow, 'country');
    const rawLanguage = valueAt(rawRow, 'language');
    const rawService = valueAt(rawRow, 'service');
    const emailNormalized = normalizeEmail(rawEmail);
    const rowErrors: LeadImportError[] = [];

    if (!rawEmail) {
      rowErrors.push({ row: rowNumber, field: 'email', message: 'Enter a valid email address' });
    } else if (rawEmail.length > MARKETING_LEAD_MAX_EMAIL_LENGTH) {
      rowErrors.push({
        row: rowNumber,
        field: 'email',
        message: `Email must be ${MARKETING_LEAD_MAX_EMAIL_LENGTH} characters or fewer`,
      });
    } else if (!isValidEmail(emailNormalized)) {
      rowErrors.push({ row: rowNumber, field: 'email', message: 'Enter a valid email address' });
    }

    const country = normalizeMarketingCountry(rawCountry);
    if (!rawCountry) {
      rowErrors.push({ row: rowNumber, field: 'country', message: 'Enter a country' });
    } else if (!country) {
      rowErrors.push({
        row: rowNumber,
        field: 'country',
        message: `Unknown country: ${boundedDisplay(rawCountry)}`,
      });
    }

    const locale = normalizeMarketingLanguage(rawLanguage);
    if (!rawLanguage) {
      rowErrors.push({ row: rowNumber, field: 'language', message: 'Enter a language' });
    } else if (!locale) {
      rowErrors.push({
        row: rowNumber,
        field: 'language',
        message: `Unsupported language: ${boundedDisplay(rawLanguage)}`,
      });
    }

    let serviceKeys: string[] = [];
    let interestedServices: string[] = [];
    if (!rawService) {
      rowErrors.push({ row: rowNumber, field: 'service', message: 'Service is required' });
    } else if (country && locale) {
      const resolved = resolveServiceCell(rawService, country, options.serviceIndex);
      if (resolved.unknown.length > 0) {
        rowErrors.push({
          row: rowNumber,
          field: 'service',
          message: `Unknown service: ${boundedDisplay(resolved.unknown.join(', '))}`,
        });
      }
      if (resolved.unavailable.length > 0) {
        rowErrors.push({
          row: rowNumber,
          field: 'service',
          message: `Service is not available in ${country}: ${boundedDisplay(resolved.unavailable.join(', '))}`,
        });
      }
      if (resolved.options.length === 0 && resolved.unknown.length === 0 && resolved.unavailable.length === 0) {
        rowErrors.push({ row: rowNumber, field: 'service', message: 'Service is required' });
      }
      if (resolved.options.length > MARKETING_LEAD_MAX_SERVICES) {
        rowErrors.push({
          row: rowNumber,
          field: 'service',
          message: `Enter at most ${MARKETING_LEAD_MAX_SERVICES} services`,
        });
      }
      const sorted = [...resolved.options].sort((a, b) => a.key.localeCompare(b.key));
      serviceKeys = sorted.map((option) => option.key);
      interestedServices = sorted.map((option) => option.label);
    }

    if (rowErrors.length > 0) {
      failedRows += 1;
      for (const error of rowErrors) {
        if (errors.length < MARKETING_LEAD_MAX_ERRORS) errors.push(error);
      }
      return;
    }

    const tupleKey = leadTupleKey({
      emailNormalized,
      country: country!,
      locale: locale!,
      serviceKeys,
    });
    if (seen.has(tupleKey)) {
      duplicateRows += 1;
      return;
    }
    seen.add(tupleKey);
    rows.push({
      rowNumber,
      email: emailNormalized,
      emailNormalized,
      country: country!,
      locale: locale!,
      serviceKeys,
      interestedServices,
    });
  });

  return {
    totalRows: dataRows.length,
    duplicateRows,
    failedRows,
    rows,
    errors: boundedErrors(errors),
  };
}
