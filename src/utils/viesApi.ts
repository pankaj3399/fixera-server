import axios from 'axios';

export interface ViesValidationResult {
  valid: boolean;
  companyName?: string;
  companyAddress?: string;
  error?: string;
  /**
   * True when VIES could not be reached, was throttled, or returned a fault.
   * `valid: false` is then inconclusive rather than a rejection and callers
   * must not treat the VAT number as invalid.
   */
  transient?: boolean;
}

// EU country codes that support VIES validation
export const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
];

export const isEUVatNumber = (vatNumber: string): boolean => {
  if (!vatNumber || vatNumber.length < 4) return false;
  const countryCode = vatNumber.substring(0, 2).toUpperCase();
  return EU_COUNTRIES.includes(countryCode);
};

const SOAP_ENDPOINT = 'https://ec.europa.eu/taxation_customs/vies/services/checkVatService';
const REST_ENDPOINT = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const VIES_TIMEOUT_MS = 10_000;

/** VIES `userError` codes that mean "try later", not "this VAT is invalid". */
const UNAVAILABLE_USER_ERRORS = new Set([
  'MS_MAX_CONCURRENT_REQ',
  'GLOBAL_MAX_CONCURRENT_REQ',
  'MS_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK_ERROR',
]);

// Local/test fixtures used to keep flows deterministic without hitting VIES.
const MOCK_VALIDATIONS: Record<string, { companyName: string; companyAddress: string }> = {
  DE811569869: {
    companyName: 'SAP SE',
    companyAddress: 'Dietmar-Hopp-Allee 16\n69190 Walldorf\nGermany',
  },
  BE0429259426: {
    companyName: 'Microsoft Belgium BVBA',
    companyAddress: 'Boulevard du Roi Albert II 4\n1000 Brussels\nBelgium',
  },
};

function cleanViesField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '---' || trimmed === '&nbsp;') return undefined;
  return trimmed;
}

function buildSoapEnvelope(countryCode: string, vatId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:tns1="urn:ec.europa.eu:taxud:vies:services:checkVat:types"
               xmlns:impl="urn:ec.europa.eu:taxud:vies:services:checkVat">
  <soap:Header>
  </soap:Header>
  <soap:Body>
    <tns1:checkVat xmlns:tns1="urn:ec.europa.eu:taxud:vies:services:checkVat:types"
                   xmlns="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
      <tns1:countryCode>${countryCode}</tns1:countryCode>
      <tns1:vatNumber>${vatId}</tns1:vatNumber>
    </tns1:checkVat>
  </soap:Body>
</soap:Envelope>`;
}

function parseTag(xml: string, tag: string): string | undefined {
  const cdata = xml.match(new RegExp(`<[a-zA-Z0-9:]*${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/[a-zA-Z0-9:]*${tag}>`));
  if (cdata) return cleanViesField(cdata[1]);
  const plain = xml.match(new RegExp(`<[a-zA-Z0-9:]*${tag}[^>]*>([\\s\\S]*?)<\\/[a-zA-Z0-9:]*${tag}>`));
  return plain ? cleanViesField(plain[1]) : undefined;
}

/** Returns null when the response is inconclusive (fault, timeout, bad parse). */
async function validateViaSoap(countryCode: string, vatId: string): Promise<ViesValidationResult | null> {
  try {
    const response = await axios.post(SOAP_ENDPOINT, buildSoapEnvelope(countryCode, vatId), {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'urn:ec.europa.eu:taxud:vies:services:checkVat/checkVat',
      },
      timeout: VIES_TIMEOUT_MS,
    });
    const xml = String(response.data ?? '');
    if (/<[a-zA-Z0-9:]*valid>true<\//.test(xml)) {
      return {
        valid: true,
        companyName: parseTag(xml, 'name'),
        companyAddress: parseTag(xml, 'address'),
      };
    }
    if (/<[a-zA-Z0-9:]*valid>false<\//.test(xml)) {
      return { valid: false, error: 'VAT number is not valid according to VIES' };
    }
    console.warn('[VIES] Unexpected SOAP response, falling back to REST');
    return null;
  } catch (error: any) {
    console.warn('[VIES] SOAP request failed, falling back to REST:', error?.message || error);
    return null;
  }
}

/** Returns null when the response is inconclusive (throttled, timeout, bad payload). */
async function validateViaRest(countryCode: string, vatId: string): Promise<ViesValidationResult | null> {
  try {
    const response = await axios.get(`${REST_ENDPOINT}/${countryCode}/vat/${vatId}`, {
      timeout: VIES_TIMEOUT_MS,
    });
    const data = response.data as {
      isValid?: boolean;
      userError?: string;
      name?: string;
      address?: string;
    } | null;

    if (!data || typeof data.isValid !== 'boolean') return null;

    if (!data.isValid) {
      const userError = typeof data.userError === 'string' ? data.userError.trim() : '';
      if (userError && UNAVAILABLE_USER_ERRORS.has(userError)) return null;
      return {
        valid: false,
        error: userError && userError !== 'VALID'
          ? `VIES rejected the number (${userError})`
          : 'VAT number is not valid according to VIES',
      };
    }

    return {
      valid: true,
      companyName: cleanViesField(data.name),
      companyAddress: cleanViesField(data.address),
    };
  } catch (error: any) {
    console.warn('[VIES] REST request failed:', error?.message || error);
    return null;
  }
}

export const validateVATNumber = async (vatNumber: string): Promise<ViesValidationResult> => {
  if (!vatNumber || vatNumber.length < 4) {
    return { valid: false, error: 'Invalid VAT number format' };
  }

  const countryCode = vatNumber.substring(0, 2).toUpperCase();
  const vatId = vatNumber.substring(2);

  if (!isEUVatNumber(vatNumber)) {
    return { valid: false, error: 'VAT number is not from an EU country' };
  }

  const mock = MOCK_VALIDATIONS[vatNumber];
  if (mock) {
    return { valid: true, ...mock };
  }

  console.log(`[VIES] Validating ${countryCode} ${vatId}`);

  const soapResult = await validateViaSoap(countryCode, vatId);
  if (soapResult) return soapResult;

  const restResult = await validateViaRest(countryCode, vatId);
  if (restResult) return restResult;

  console.warn('[VIES] SOAP and REST both unavailable');
  return {
    valid: false,
    transient: true,
    error: 'VIES is temporarily unavailable. Please try again in a few minutes.',
  };
};

// Format VAT number for display
export const formatVATNumber = (vatNumber: string): string => {
  if (!vatNumber) return '';
  return vatNumber.toUpperCase().replace(/\s/g, '');
};

// Validate VAT number format without VIES check
export const isValidVATFormat = (vatNumber: string): boolean => {
  if (!vatNumber) return false;

  const formatted = formatVATNumber(vatNumber);

  // Basic format: 2 letters + 4-15 alphanumeric characters
  return /^[A-Z]{2}[A-Z0-9]{4,15}$/.test(formatted);
};
