import bcrypt from "bcrypt";
import { formatVATNumber, isValidVATFormat, validateVATNumber } from "./viesApi";

/**
 * Validation shared by account creation (Auth SignUp) and the signup edit
 * step (User updateSignupContact, FT2-6C), so both accept exactly the same
 * input and store it the same way.
 */

export const SIGNUP_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SIGNUP_PASSWORD_MIN_LENGTH = 6;
const SIGNUP_PASSWORD_SALT_ROUNDS = 12;

export const SIGNUP_CUSTOMER_TYPES = ["individual", "business"] as const;
export type SignupCustomerType = (typeof SIGNUP_CUSTOMER_TYPES)[number];

/** The English message for a password that fails the signup strength rules, or null. */
export function signupPasswordError(password: string): string | null {
  if (password.length < SIGNUP_PASSWORD_MIN_LENGTH) {
    return "Password must be at least 6 characters long";
  }
  return null;
}

export function hashSignupPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SIGNUP_PASSWORD_SALT_ROUNDS);
}

export type SignupLocation = {
  type?: "Point";
  coordinates?: [number, number];
  address: string;
  city: string;
  country: string;
  postalCode: string;
};

/**
 * The customer location stored at signup: only when street, city, country and
 * postal code are all given; GeoJSON coordinates ([lng, lat]) when the
 * geocoded latitude and longitude came along.
 */
export function buildSignupLocation(input: {
  address?: unknown;
  city?: unknown;
  country?: unknown;
  postalCode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}): SignupLocation | null {
  const { address, city, country, postalCode, latitude, longitude } = input;
  if (
    typeof address !== "string" || !address.trim()
    || typeof city !== "string" || !city.trim()
    || typeof country !== "string" || !country.trim()
    || typeof postalCode !== "string" || !postalCode.trim()
  ) {
    return null;
  }
  const location: SignupLocation = {
    address: address.trim(),
    city: city.trim(),
    country: country.trim(),
    postalCode: postalCode.trim(),
  };
  if (latitude !== undefined && longitude !== undefined && latitude !== null && longitude !== null) {
    const lat = parseFloat(String(latitude));
    const lng = parseFloat(String(longitude));
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      location.type = "Point";
      location.coordinates = [lng, lat];
    }
  }
  return location;
}

export type BusinessCustomerFields =
  | { ok: true; companyName: string; vatNumber: string; isVatVerified: boolean }
  | { ok: false; msg: string };

/**
 * Company name and VAT number of a business customer: both required, VAT in
 * a valid format, VIES-checked. `current` skips the VIES call when the VAT
 * number is the one already stored (its stored result still applies).
 */
export async function resolveBusinessCustomerFields(
  companyName: unknown,
  vatNumber: unknown,
  current?: { vatNumber?: string | null; isVatVerified?: boolean | null },
): Promise<BusinessCustomerFields> {
  if (typeof companyName !== "string" || !companyName.trim()) {
    return { ok: false, msg: "Company name is required for business customers" };
  }
  if (typeof vatNumber !== "string" || !vatNumber.trim()) {
    return { ok: false, msg: "VAT number is required for business customers" };
  }
  const formattedVAT = formatVATNumber(vatNumber);
  if (!isValidVATFormat(formattedVAT)) {
    return { ok: false, msg: "Invalid VAT number format" };
  }
  if (current?.vatNumber && current.vatNumber === formattedVAT) {
    return { ok: true, companyName: companyName.trim(), vatNumber: formattedVAT, isVatVerified: Boolean(current.isVatVerified) };
  }
  const vies = await validateVATNumber(formattedVAT);
  return { ok: true, companyName: companyName.trim(), vatNumber: formattedVAT, isVatVerified: vies.valid };
}
