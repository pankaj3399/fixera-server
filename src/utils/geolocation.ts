/**
 * Geolocation utilities for distance calculation and border checking
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface LocationInfo {
  coordinates?: Coordinates;
  address?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  state?: string;
  province?: string;
  region?: string;
  postalCode?: string;
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param lat1 - Latitude of first point
 * @param lon1 - Longitude of first point
 * @param lat2 - Latitude of second point
 * @param lon2 - Longitude of second point
 * @returns Distance in kilometers
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  // Validate inputs
  if (!isValidLatitude(lat1) || !isValidLatitude(lat2) ||
      !isValidLongitude(lon1) || !isValidLongitude(lon2)) {
    throw new Error('Invalid coordinates provided');
  }

  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return Math.round(distance * 100) / 100; // Round to 2 decimal places
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Validate latitude value
 */
function isValidLatitude(lat: number): boolean {
  return typeof lat === 'number' && !isNaN(lat) && lat >= -90 && lat <= 90;
}

/**
 * Validate longitude value
 */
function isValidLongitude(lon: number): boolean {
  return typeof lon === 'number' && !isNaN(lon) && lon >= -180 && lon <= 180;
}

/**
 * Check if two locations are in the same country
 * @param location1 - First location info
 * @param location2 - Second location info
 * @returns true if both locations are in the same country
 */
export function isSameCountry(
  location1: LocationInfo,
  location2: LocationInfo
): boolean {
  // Try to compare using country codes first (more reliable)
  if (location1.countryCode && location2.countryCode) {
    const code1 = normalizeCountryCode(location1.countryCode);
    const code2 = normalizeCountryCode(location2.countryCode);
    if (code1 && code2) {
      return code1 === code2;
    }
    // Fall through to country name comparison if codes are invalid
  }

  // Fall back to country names
  if (location1.country && location2.country) {
    return normalizeCountryName(location1.country) ===
           normalizeCountryName(location2.country);
  }

  // If we don't have enough information, assume different countries (safer)
  return false;
}

/**
 * Check if two locations are in the same state/province/region
 * @param location1 - First location info
 * @param location2 - Second location info
 * @returns true if both locations are in the same state/province/region
 */
export function isSameProvince(
  location1: LocationInfo,
  location2: LocationInfo
): boolean {
  // First check if they're in the same country
  if (!isSameCountry(location1, location2)) {
    return false;
  }

  // Try state first
  const state1 = location1.state || location1.province || location1.region;
  const state2 = location2.state || location2.province || location2.region;

  if (state1 && state2) {
    return normalizeRegionName(state1) === normalizeRegionName(state2);
  }

  // If we don't have state/province info, assume different provinces (safer)
  return false;
}

/**
 * ISO 3166-1 alpha-2 country codes
 */
const ISO_ALPHA2_CODES = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW',
]);

/**
 * Normalize country code to uppercase 2-letter ISO format.
 * Returns undefined if the input is not a valid ISO 3166-1 alpha-2 code.
 */
function normalizeCountryCode(code: string): string | undefined {
  const normalized = code.trim().toUpperCase();
  if (normalized.length !== 2 || !ISO_ALPHA2_CODES.has(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * Fold accented/unicode characters to their base letters via NFD decomposition,
 * then strip non-letter/number/space characters using Unicode-aware patterns.
 */
function normalizeUnicodeName(name: string): string {
  return name.trim().toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')         // Remove combining marks (accents)
    .replace(/[^\p{L}\p{N}\s]/gu, '') // Keep only letters, numbers, whitespace
    .replace(/\s+/g, ' ');
}

/**
 * Normalize country name for comparison
 */
function normalizeCountryName(name: string): string {
  return normalizeUnicodeName(name);
}

/**
 * Normalize region/state/province name for comparison
 */
function normalizeRegionName(name: string): string {
  return normalizeUnicodeName(name);
}

/**
 * Extract coordinates from MongoDB GeoJSON format
 * MongoDB stores as [longitude, latitude]
 */
export function extractCoordinatesFromGeoJSON(
  coordinates: [number, number]
): Coordinates | null {
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return null;
  }

  const [longitude, latitude] = coordinates;

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

/**
 * Check if location info has valid coordinates
 */
export function hasValidCoordinates(location: LocationInfo): boolean {
  if (!location.coordinates) {
    return false;
  }

  return isValidLatitude(location.coordinates.latitude) &&
         isValidLongitude(location.coordinates.longitude);
}

/**
 * Get distance between two locations with coordinates
 * @param location1 - First location with coordinates
 * @param location2 - Second location with coordinates
 * @returns Distance in kilometers, or null if coordinates are invalid
 */
export function getDistanceBetweenLocations(
  location1: LocationInfo,
  location2: LocationInfo
): number | null {
  if (!hasValidCoordinates(location1) || !hasValidCoordinates(location2)) {
    return null;
  }

  return calculateDistance(
    location1.coordinates!.latitude,
    location1.coordinates!.longitude,
    location2.coordinates!.latitude,
    location2.coordinates!.longitude
  );
}

/**
 * Check if location crosses borders based on border level
 * @param professionalLocation - Professional's service location
 * @param customerLocation - Customer's location
 * @param noBorders - If true, professional does NOT cross borders (stays within their area)
 *                    This corresponds to the UI checkbox "Don't cross country borders"
 * @param borderLevel - Level of border restriction (country or province)
 * @returns true if the location is acceptable (doesn't violate border settings)
 */
export function checkBorderCrossing(
  professionalLocation: LocationInfo,
  customerLocation: LocationInfo,
  noBorders: boolean,
  borderLevel: 'none' | 'country' | 'province' = 'country'
): boolean {
  // If noBorders is FALSE (checkbox unchecked), professional CAN cross borders freely
  if (!noBorders) {
    return true;
  }

  // If noBorders is TRUE (checkbox checked = "Don't cross country borders"),
  // enforce border restrictions based on borderLevel
  switch (borderLevel) {
    case 'none':
      // No border restrictions - allows crossing
      return true;

    case 'country':
      // Must be in same country
      return isSameCountry(professionalLocation, customerLocation);

    case 'province':
      // Must be in same province/state
      return isSameProvince(professionalLocation, customerLocation);

    default:
      // Default to country-level checking for safety
      return isSameCountry(professionalLocation, customerLocation);
  }
}

/**
 * Check if two locations are in the same city
 * @param location1 - First location info
 * @param location2 - Second location info
 * @returns true if both locations are in the same city
 */
export function isSameCity(
  location1: LocationInfo,
  location2: LocationInfo
): boolean {
  // First check if they're in the same country
  if (!isSameCountry(location1, location2)) {
    return false;
  }

  // Compare cities
  if (location1.city && location2.city) {
    return normalizeCityName(location1.city) === normalizeCityName(location2.city);
  }

  // If we don't have city info, assume different cities (safer)
  return false;
}

/**
 * Normalize city name for comparison
 */
function normalizeCityName(name: string): string {
  return normalizeUnicodeName(name);
}

/**
 * Check if location has sufficient text-based location data (city, state, country)
 */
export function hasLocationTextData(location: LocationInfo): boolean {
  return !!(location.city || location.state || location.province || location.country);
}

/**
 * Validate location match based on text data (city/state/country) when coordinates unavailable
 * This is a fallback validation when coordinates cannot be determined
 * @param projectLocation - Project/service provider location
 * @param customerLocation - Customer's location
 * @param maxKmRange - The max range setting (used to determine strictness)
 * @returns Object with isValid flag and reason
 */
export function validateLocationByTextData(
  projectLocation: LocationInfo,
  customerLocation: LocationInfo,
  maxKmRange: number
): { isValid: boolean; reason?: string } {
  // If neither has text data, we can't validate - allow booking
  if (!hasLocationTextData(projectLocation) && !hasLocationTextData(customerLocation)) {
    return { isValid: true, reason: 'No location data available for validation' };
  }

  // For very local services (< 50km range), require same city or nearby
  if (maxKmRange < 50) {
    // Must be same city for very local services
    if (isSameCity(projectLocation, customerLocation)) {
      return { isValid: true };
    }
    // If same province/state, might still be okay for services up to 50km
    if (isSameProvince(projectLocation, customerLocation)) {
      return { isValid: true };
    }
    // Different city/province - likely outside range
    if (projectLocation.city && customerLocation.city) {
      return {
        isValid: false,
        reason: `This service is only available locally. Your location (${customerLocation.city}) appears to be outside the service area (${projectLocation.city}).`
      };
    }

    return {
      isValid: false,
      reason: 'This service is only available locally. Precise city information is required to verify availability.'
    };
  }

  // For regional services (50-200km range), require same province/state
  if (maxKmRange < 200) {
    if (isSameProvince(projectLocation, customerLocation)) {
      return { isValid: true };
    }
    // Same country but different province might be okay for larger ranges
    if (isSameCountry(projectLocation, customerLocation)) {
      return { isValid: true };
    }
    // Different country
    if (projectLocation.country && customerLocation.country) {
      return {
        isValid: false,
        reason: `This service is only available regionally. Your location appears to be outside the service area.`
      };
    }
  }

  // For national/international services (>= 200km), just check country
  if (!isSameCountry(projectLocation, customerLocation)) {
    if (projectLocation.country && customerLocation.country) {
      return {
        isValid: false,
        reason: `This service is not available in your country (${customerLocation.country}).`
      };
    }
  }

  // Default: allow if we can't determine
  return { isValid: true };
}

/**
 * Parse address string to extract location components
 * This is a basic parser - a geocoding service would be more accurate
 */
export function parseAddressComponents(address: string): Partial<LocationInfo> {
  if (!address || typeof address !== 'string') {
    return {};
  }

  const parts = address.split(',').map(p => p.trim()).filter(Boolean);
  const result: Partial<LocationInfo> = {
    address: address.trim()
  };

  // Try to extract postal code (common patterns)
  const postalCodePattern = /\b\d{4,6}\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;
  const postalMatch = address.match(postalCodePattern);
  if (postalMatch) {
    result.postalCode = postalMatch[0];
  }

  const partCount = parts.length;
  if (partCount === 0) {
    return result;
  }

  const countryPart = partCount > 1 ? parts[partCount - 1] : undefined;
  let statePart: string | undefined;
  let cityPart: string | undefined;

  if (partCount >= 3) {
    statePart = parts[partCount - 2];
    cityPart = parts[partCount - 3];
  } else if (partCount === 2) {
    cityPart = parts[0];
    statePart = parts[1];
  } else if (partCount === 1) {
    cityPart = parts[0];
  }

  if (countryPart) {
    result.country = countryPart;
  }

  if (statePart) {
    result.state = statePart;
    result.province = statePart;
    result.region = statePart;
  }

  if (cityPart) {
    result.city = cityPart;
  }

  return result;
}
