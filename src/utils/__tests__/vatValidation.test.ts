import { describe, expect, it } from 'vitest';
import { normalizeVATNumberFormat, validateVATNumberFormat } from '../vatValidation';

describe('validateVATNumberFormat — Belgium', () => {
  it('accepts legacy BE0 + 9 digit enterprise numbers', () => {
    expect(validateVATNumberFormat('BE0123456789')).toBe(true);
    expect(validateVATNumberFormat('BE0429259426')).toBe(true);
  });

  it('accepts current BE1 + 9 digit enterprise numbers (e.g. QLab)', () => {
    expect(validateVATNumberFormat('BE1002103337')).toBe(true);
    expect(validateVATNumberFormat('be1002103337')).toBe(true);
    expect(validateVATNumberFormat('BE 1002.103.337')).toBe(true);
  });

  it('pads legacy 9-digit BE numbers with a leading 0', () => {
    expect(normalizeVATNumberFormat('BE123456789')).toBe('BE0123456789');
    expect(validateVATNumberFormat('BE123456789')).toBe(true);
  });

  it('rejects malformed Belgian numbers', () => {
    expect(validateVATNumberFormat('BE123')).toBe(false);
    expect(validateVATNumberFormat('BE12345678')).toBe(false); // 8 digits — too short
    expect(validateVATNumberFormat('BE21002103337')).toBe(false); // 11 digits — too long
    expect(validateVATNumberFormat('FR1002103337')).toBe(false);
  });
});
