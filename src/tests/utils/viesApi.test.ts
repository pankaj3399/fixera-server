import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosPost, axiosGet } = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  axiosGet: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: axiosPost, get: axiosGet },
}));

import { validateVATNumber } from '../../utils/viesApi';

const SOAP_VALID = `<env:Envelope><env:Body><ns2:checkVatResponse>
  <ns2:countryCode>BE</ns2:countryCode>
  <ns2:valid>true</ns2:valid>
  <ns2:name>ACME BVBA</ns2:name>
  <ns2:address>Meidoorn 10/4\n2640 Mortsel</ns2:address>
</ns2:checkVatResponse></env:Body></env:Envelope>`;

const SOAP_INVALID = SOAP_VALID.replace('<ns2:valid>true</ns2:valid>', '<ns2:valid>false</ns2:valid>');

const SOAP_FAULT = `<env:Envelope><env:Body><env:Fault>
  <faultstring>MS_MAX_CONCURRENT_REQ</faultstring>
</env:Fault></env:Body></env:Envelope>`;

describe('VIES validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the SOAP result without calling REST when SOAP succeeds', async () => {
    axiosPost.mockResolvedValue({ data: SOAP_VALID });

    const result = await validateVATNumber('BE1001343569');

    expect(result).toMatchObject({ valid: true, companyName: 'ACME BVBA', companyAddress: 'Meidoorn 10/4\n2640 Mortsel' });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('returns a definitive invalid result from SOAP', async () => {
    axiosPost.mockResolvedValue({ data: SOAP_INVALID });

    const result = await validateVATNumber('BE1001343569');

    expect(result.valid).toBe(false);
    expect(result.transient).toBeUndefined();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('falls back to the REST API when SOAP faults', async () => {
    axiosPost.mockResolvedValue({ data: SOAP_FAULT });
    axiosGet.mockResolvedValue({
      data: { isValid: true, name: 'REST Co', address: 'REST Street 1' },
    });

    const result = await validateVATNumber('BE1001343569');

    expect(result).toMatchObject({ valid: true, companyName: 'REST Co', companyAddress: 'REST Street 1' });
    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/BE/vat/1001343569'),
      expect.anything(),
    );
  });

  it('treats a throttled VIES response as transient, not invalid', async () => {
    axiosPost.mockRejectedValue(new Error('socket hang up'));
    axiosGet.mockResolvedValue({ data: { isValid: false, userError: 'MS_MAX_CONCURRENT_REQ' } });

    const result = await validateVATNumber('BE1001343569');

    expect(result.valid).toBe(false);
    expect(result.transient).toBe(true);
  });

  it('marks the result transient when SOAP and REST are both unreachable', async () => {
    axiosPost.mockRejectedValue(new Error('timeout'));
    axiosGet.mockRejectedValue(new Error('timeout'));

    const result = await validateVATNumber('BE1001343569');

    expect(result.valid).toBe(false);
    expect(result.transient).toBe(true);
  });
});
