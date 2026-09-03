import { describe, expect, it } from 'vitest';
import { calculateVAT } from '../../utils/vat';

const base = {
  amount: 100,
  customerVATNumber: 'BE0123456789',
  customerVatVerified: true,
  professionalCountry: 'BE',
  customerType: 'business' as const,
};

describe('calculateVAT payment fallback', () => {
  it('keeps Belgian B2B movable work on the local rate', () => {
    const result = calculateVAT({
      ...base,
      customerCountry: 'BE',
      propertyNature: 'movable',
    });
    expect(result.reverseCharge).toBe(false);
    expect(result.vatRate).toBe(21);
    expect(result.vatAmount).toBe(21);
  });

  it('applies Reverse Charge for Belgian B2B immovable work', () => {
    const result = calculateVAT({
      ...base,
      customerCountry: 'BE',
      propertyNature: 'immovable',
    });
    expect(result.reverseCharge).toBe(true);
    expect(result.vatRate).toBe(0);
    expect(result.vatAmount).toBe(0);
    expect(result.total).toBe(100);
  });

  it('keeps the local rate when immovable Belgian work is exempt', () => {
    const result = calculateVAT({
      ...base,
      customerCountry: 'BE',
      propertyNature: 'immovable',
      exemptFromBelgianReverseCharge: true,
    });
    expect(result.reverseCharge).toBe(false);
    expect(result.vatRate).toBe(21);
  });

  it('applies Reverse Charge for Dutch B2B', () => {
    const result = calculateVAT({
      ...base,
      customerCountry: 'NL',
      customerVATNumber: 'NL123456789B01',
      propertyNature: 'movable',
    });
    expect(result.reverseCharge).toBe(true);
    expect(result.vatAmount).toBe(0);
  });
});
