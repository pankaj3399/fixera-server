import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  LeadWorkbookError,
  safeLeadFilename,
  validateLeadWorkbook,
} from '../../../utils/marketing/leadImport';
import { indexMarketingServiceOptions } from '../../../utils/marketing/serviceCatalog';

const serviceIndex = indexMarketingServiceOptions([
  { key: 'plumbing', label: 'Plumbing', countries: ['BE', 'NL'] },
  { key: 'painting', label: 'Painting', countries: ['BE'] },
  { key: 'plumbing-heating', label: 'Plumbing, Heating', countries: ['BE'] },
  { key: 'electrical', label: 'Electrical', countries: ['BE'] },
]);

function workbookBuffer(rows: unknown[][], bookType: XLSX.BookType = 'xlsx'): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Leads');
  return XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;
}

const header = ['Email', 'Country', 'Language', 'Service'];

function parse(rows: unknown[][], index = serviceIndex) {
  return validateLeadWorkbook(workbookBuffer(rows), { serviceIndex: index });
}

describe('marketing lead workbook validation', () => {
  it('accepts .xlsx and .xls buffers', () => {
    for (const bookType of ['xlsx', 'biff8'] as const) {
      const result = validateLeadWorkbook(
        workbookBuffer([header, ['person@example.com', 'Belgium', 'Nederlands', 'Plumbing']], bookType),
        { serviceIndex },
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        emailNormalized: 'person@example.com',
        country: 'BE',
        locale: 'nl',
        serviceKeys: ['plumbing'],
        interestedServices: ['Plumbing'],
      });
    }
  });

  it('keeps physical Excel row numbers after blank rows', () => {
    const result = parse([header, [], ['bad-email', 'BE', 'nl', 'Plumbing']]);
    expect(result.errors[0]).toMatchObject({ row: 3, field: 'email' });
    expect(result.totalRows).toBe(1);
  });

  it('normalizes headers, collapses spaces and ignores extra columns', () => {
    const result = parse([
      ['  EMAIL ', 'Country', 'Language', 'Service', 'Notes'],
      ['Person@Example.COM', 'BE', 'nl', 'plumbing', 'ignore me'],
    ]);
    expect(result.rows[0].email).toBe('person@example.com');
  });

  it('rejects missing and duplicate required headers', () => {
    expect(() => parse([['Email', 'Country'], ['a@example.com', 'BE']])).toThrow(
      /Missing required columns: Language, Service/,
    );
    expect(() =>
      parse([['Email', 'Country', 'Language', 'Service', 'Email'], ['a@example.com', 'BE', 'nl', 'Plumbing', 'x']]),
    ).toThrow(/Duplicate column header: Email/);
  });

  it('accepts localized country and language names', () => {
    const result = parse([
      header,
      ['a@example.com', 'België', 'Frans', 'Plumbing'],
      ['b@example.com', 'Belgium', 'English', 'Plumbing'],
    ]);
    expect(result.rows[0]).toMatchObject({ country: 'BE', locale: 'fr' });
    expect(result.rows[1]).toMatchObject({ country: 'BE', locale: 'en' });
  });

  it('resolves a whole service cell before splitting, so commas in names work', () => {
    const result = parse([
      header,
      ['a@example.com', 'BE', 'nl', 'Plumbing, Heating'],
      ['b@example.com', 'BE', 'nl', 'Plumbing; Painting'],
    ]);
    expect(result.rows[0].serviceKeys).toEqual(['plumbing-heating']);
    expect(result.rows[0].interestedServices).toEqual(['Plumbing, Heating']);
    expect(result.rows[1].serviceKeys).toEqual(['painting', 'plumbing']);
    expect(result.rows[1].interestedServices).toEqual(['Painting', 'Plumbing']);
  });

  it('keeps same-email rows with different dimensions and skips exact duplicates', () => {
    const result = parse([
      header,
      ['Person@Example.com', 'Belgium', 'Nederlands', 'Plumbing'],
      ['person@example.com', 'BE', 'nl', 'plumbing'],
      ['person@example.com', 'NL', 'nl', 'Plumbing'],
      ['person@example.com', 'BE', 'fr', 'Plumbing'],
    ]);
    expect(result.rows).toHaveLength(3);
    expect(result.duplicateRows).toBe(1);
    expect(result.failedRows).toBe(0);
    expect(result.rows.map((row) => row.country)).toEqual(['BE', 'NL', 'BE']);
    expect(result.rows.map((row) => row.locale)).toEqual(['nl', 'nl', 'fr']);
  });

  it('reports invalid email, country, language, service and country availability', () => {
    const result = parse([
      header,
      ['not-an-email', 'BE', 'nl', 'Plumbing'],
      ['a@example.com', 'Atlantis', 'nl', 'Plumbing'],
      ['b@example.com', 'BE', 'Klingon', 'Plumbing'],
      ['c@example.com', 'BE', 'nl', 'Underwater basket weaving'],
      ['d@example.com', 'NL', 'nl', 'Painting'],
    ]);
    expect(result.failedRows).toBe(5);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email', message: 'Enter a valid email address' }),
        expect.objectContaining({ field: 'country', message: 'Unknown country: Atlantis' }),
        expect.objectContaining({ field: 'language', message: 'Unsupported language: Klingon' }),
        expect.objectContaining({
          field: 'service',
          message: 'Unknown service: Underwater basket weaving',
        }),
        expect.objectContaining({
          field: 'service',
          message: 'Service is not available in NL: Painting',
        }),
      ]),
    );
  });

  it('rejects empty workbooks and missing data rows', () => {
    expect(() =>
      validateLeadWorkbook(workbookBuffer([[]]), { serviceIndex }),
    ).toThrow(/non-empty worksheet/);
    expect(() =>
      validateLeadWorkbook(workbookBuffer([header]), { serviceIndex }),
    ).toThrow(/no data rows/);
  });

  it('enforces the file size and row limits', () => {
    expect(() =>
      validateLeadWorkbook(Buffer.alloc(5 * 1024 * 1024 + 1), { serviceIndex }),
    ).toThrow(/5 MB or smaller/);

    const rows = [header];
    for (let i = 0; i <= 5000; i += 1) {
      rows.push([`person-${i}@example.com`, 'BE', 'nl', 'Plumbing']);
    }
    expect(() => parse(rows)).toThrow(/more than 5000 data rows/);
  });

  it('bounds stored errors while counting every failed row', () => {
    const rows = [header];
    for (let i = 0; i < 250; i += 1) {
      rows.push([`bad-${i}`, 'BE', 'nl', 'Plumbing']);
    }
    const result = parse(rows);
    expect(result.failedRows).toBe(250);
    expect(result.errors).toHaveLength(200);
  });

  it('enforces the per-row service cap', () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      key: `service-${index}`,
      label: `Service ${index}`,
      countries: ['BE'],
    }));
    const index = indexMarketingServiceOptions(many);
    const result = parse(
      [header, ['a@example.com', 'BE', 'nl', many.map((service) => service.label).join(', ')]],
      index,
    );
    expect(result.failedRows).toBe(1);
    expect(result.errors[0].message).toMatch(/at most 20 services/);
  });

  it('sanitizes upload filenames and never returns workbook bytes', () => {
    expect(safeLeadFilename('..\\..\\evil/leads.xlsx')).toBe('leads.xlsx');
    expect(safeLeadFilename('')).toBe('marketing-leads.xlsx');
    const result = parse([header, ['a@example.com', 'BE', 'nl', 'Plumbing']]);
    expect(JSON.stringify(result)).not.toContain('PK');
    expect(Object.keys(result).sort()).toEqual(
      ['duplicateRows', 'errors', 'failedRows', 'rows', 'totalRows'],
    );
  });
});
