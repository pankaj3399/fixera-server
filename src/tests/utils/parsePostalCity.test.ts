import { describe, expect, it } from 'vitest';
import { parsePostalCity } from '../../handlers/User/validateVat';

describe('parsePostalCity', () => {
  it('parses spaceless Dutch postcodes without losing the postal code', () => {
    expect(parsePostalCity('5026SL TILBURG')).toEqual({ postalCode: '5026SL', city: 'TILBURG' });
  });

  it('still parses spaced Dutch postcodes', () => {
    expect(parsePostalCity('5026 SL TILBURG')).toEqual({ postalCode: '5026SL', city: 'TILBURG' });
  });

  it('keeps existing BE/FR/UK shapes intact', () => {
    expect(parsePostalCity('1000 BRUSSELS')).toEqual({ postalCode: '1000', city: 'BRUSSELS' });
    expect(parsePostalCity('75001 PARIS')).toEqual({ postalCode: '75001', city: 'PARIS' });
    const uk = parsePostalCity('W1A 1AA LONDON');
    expect(uk.city).toBe('LONDON');
    expect(uk.postalCode).toBeTruthy();
  });
});
