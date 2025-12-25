/**
 * VAT Calculation Utilities for Fixera Platform
 * Based on EU VAT rules and Belgian regulations
 * Version: 2.1
 */

import { VATCalculation, VATCalculationParams } from '../Types/stripe';

// EU Member States (as of 2024)
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

// VAT rates by country (standard rates)
const VAT_RATES: Record<string, number> = {
  BE: 21, // Belgium
  NL: 21, // Netherlands
  FR: 20, // France
  DE: 19, // Germany
  IT: 22, // Italy
  ES: 21, // Spain
  PT: 23, // Portugal
  // Add more as needed
};

/**
 * Check if country is in EU
 * @param countryCode - ISO 2-letter country code
 * @returns True if country is in EU
 */
export function isEUCountry(countryCode: string): boolean {
  return EU_COUNTRIES.includes(countryCode.toUpperCase());
}

/**
 * Get VAT rate for a country
 * @param countryCode - ISO 2-letter country code
 * @returns VAT rate as percentage (e.g., 21 for 21%)
 */
export function getVATRate(countryCode: string): number {
  return VAT_RATES[countryCode.toUpperCase()] || 21; // Default to Belgian rate
}

/**
 * Validate EU VAT number format (basic check)
 * Format: Country code + 8-12 digits
 * @param vatNumber - VAT number to validate
 * @returns True if format is valid
 */
export function validateVATNumberFormat(vatNumber: string | null): boolean {
  if (!vatNumber) return false;

  // Remove spaces and convert to uppercase
  const cleaned = vatNumber.replace(/\s/g, '').toUpperCase();

  // Basic format: Country code (2 letters) + digits
  const regex = /^[A-Z]{2}[0-9]{8,12}$/;

  return regex.test(cleaned);
}

/**
 * Calculate VAT based on customer and professional locations
 *
 * VAT Rules (Fixera - Belgian company):
 * 1. Belgium B2C (no VAT number): 21% VAT
 * 2. Belgium B2B (with VAT number): 21% VAT
 * 3. EU (ex-BE) B2C (no VAT number): 21% Belgian VAT
 * 4. EU (ex-BE) B2B (with VAT number): 0% VAT (Reverse charge)
 * 5. Non-EU: 0% VAT
 *
 * @param params - VAT calculation parameters
 * @returns VAT calculation result
 */
export function calculateVAT(params: VATCalculationParams): VATCalculation {
  const {
    amount,
    customerCountry,
    customerVATNumber,
    professionalCountry,
    customerType,
  } = params;

  // Normalize country codes
  const customerCountryUpper = customerCountry.toUpperCase();
  const professionalCountryUpper = professionalCountry.toUpperCase();

  // Assume professional is in Belgium (Fixera platform)
  // If professional is not in Belgium, adjust logic as needed
  const platformCountry = 'BE';

  // ==================== Belgium B2C ====================
  if (customerCountryUpper === platformCountry && customerType === 'individual') {
    const vatRate = 21;
    const vatAmount = (amount * vatRate) / 100;
    return {
      vatRate,
      vatAmount: Math.round(vatAmount * 100) / 100, // Round to 2 decimals
      total: amount + vatAmount,
      reverseCharge: false,
    };
  }

  // ==================== Belgium B2B ====================
  if (
    customerCountryUpper === platformCountry &&
    customerType === 'business'
  ) {
    const vatRate = 21;
    const vatAmount = (amount * vatRate) / 100;
    return {
      vatRate,
      vatAmount: Math.round(vatAmount * 100) / 100,
      total: amount + vatAmount,
      reverseCharge: false,
      vatRegistrationNumber: customerVATNumber || undefined,
    };
  }

  // ==================== EU (ex-BE) B2C ====================
  if (
    isEUCountry(customerCountryUpper) &&
    customerCountryUpper !== platformCountry &&
    customerType === 'individual'
  ) {
    // Apply Belgian VAT rate
    const vatRate = 21;
    const vatAmount = (amount * vatRate) / 100;
    return {
      vatRate,
      vatAmount: Math.round(vatAmount * 100) / 100,
      total: amount + vatAmount,
      reverseCharge: false,
    };
  }

  // ==================== EU (ex-BE) B2B ====================
  if (
    isEUCountry(customerCountryUpper) &&
    customerCountryUpper !== platformCountry &&
    customerType === 'business' &&
    validateVATNumberFormat(customerVATNumber)
  ) {
    // Reverse charge - customer pays VAT in their country
    return {
      vatRate: 0,
      vatAmount: 0,
      total: amount,
      reverseCharge: true,
      vatRegistrationNumber: customerVATNumber || undefined,
    };
  }

  // ==================== EU (ex-BE) B2B without valid VAT ====================
  if (
    isEUCountry(customerCountryUpper) &&
    customerCountryUpper !== platformCountry &&
    customerType === 'business' &&
    !validateVATNumberFormat(customerVATNumber)
  ) {
    // Treat as B2C if VAT number is invalid
    const vatRate = 21;
    const vatAmount = (amount * vatRate) / 100;
    return {
      vatRate,
      vatAmount: Math.round(vatAmount * 100) / 100,
      total: amount + vatAmount,
      reverseCharge: false,
    };
  }

  // ==================== Non-EU ====================
  if (!isEUCountry(customerCountryUpper)) {
    // No VAT for non-EU customers
    return {
      vatRate: 0,
      vatAmount: 0,
      total: amount,
      reverseCharge: false,
    };
  }

  // ==================== Default (Fallback) ====================
  // Apply Belgian VAT by default
  const vatRate = 21;
  const vatAmount = (amount * vatRate) / 100;
  return {
    vatRate,
    vatAmount: Math.round(vatAmount * 100) / 100,
    total: amount + vatAmount,
    reverseCharge: false,
  };
}

/**
 * Get VAT explanation text for invoice
 * @param calculation - VAT calculation result
 * @param customerCountry - Customer country code
 * @returns Explanation text for invoice
 */
export function getVATExplanation(
  calculation: VATCalculation,
  customerCountry: string
): string {
  if (calculation.reverseCharge) {
    return `VAT reverse charge applies. Customer is responsible for declaring VAT in ${customerCountry}.`;
  }

  if (calculation.vatRate === 0 && !isEUCountry(customerCountry)) {
    return 'No VAT charged for non-EU customers.';
  }

  if (calculation.vatRate > 0) {
    return `VAT (${calculation.vatRate}%) charged under Belgian VAT regulations.`;
  }

  return '';
}

/**
 * Calculate VAT breakdown for display
 * @param netAmount - Amount before VAT
 * @param params - VAT calculation parameters
 * @returns Object with net, VAT, and total
 */
export function getVATBreakdown(
  netAmount: number,
  params: VATCalculationParams
): {
  netAmount: number;
  vatAmount: number;
  vatRate: number;
  totalAmount: number;
  reverseCharge: boolean;
  explanation: string;
} {
  const calculation = calculateVAT({ ...params, amount: netAmount });
  const explanation = getVATExplanation(calculation, params.customerCountry);

  return {
    netAmount,
    vatAmount: calculation.vatAmount,
    vatRate: calculation.vatRate,
    totalAmount: calculation.total,
    reverseCharge: calculation.reverseCharge,
    explanation,
  };
}

// ==================== Export ====================

export default {
  isEUCountry,
  getVATRate,
  validateVATNumberFormat,
  calculateVAT,
  getVATExplanation,
  getVATBreakdown,
};
