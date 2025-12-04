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
    return normalizeCountryCode(location1.countryCode) ===
           normalizeCountryCode(location2.countryCode);
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
 * Normalize country code to uppercase 2-letter ISO format
 */
function normalizeCountryCode(code: string): string {
  return code.trim().toUpperCase().slice(0, 2);
}

/**
 * Normalize country name for comparison
 */
function normalizeCountryName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ''); // Remove special characters
}

/**
 * Normalize region/state/province name for comparison
 */
function normalizeRegionName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ''); // Remove special characters
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
 * @param noBorders - Whether professional crosses borders
 * @param borderLevel - Level of border restriction
 * @returns true if the location is acceptable (doesn't violate border settings)
 */
export function checkBorderCrossing(
  professionalLocation: LocationInfo,
  customerLocation: LocationInfo,
  noBorders: boolean,
  borderLevel: 'none' | 'country' | 'province' = 'country'
): boolean {
  // If noBorders is true, professional crosses all borders
  if (noBorders) {
    return true;
  }

  // If noBorders is false, check based on borderLevel
  switch (borderLevel) {
    case 'none':
      // No border restrictions
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
 * Parse address string to extract location components
 * This is a basic parser - a geocoding service would be more accurate
 */
export function parseAddressComponents(address: string): Partial<LocationInfo> {
  if (!address || typeof address !== 'string') {
    return {};
  }

  const parts = address.split(',').map(p => p.trim());
  const result: Partial<LocationInfo> = {
    address: address.trim()
  };

  // Try to extract postal code (common patterns)
  const postalCodePattern = /\b\d{4,6}\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;
  const postalMatch = address.match(postalCodePattern);
  if (postalMatch) {
    result.postalCode = postalMatch[0];
  }

  // Last part is often country
  if (parts.length > 1) {
    result.country = parts[parts.length - 1];
  }

  // Second to last might be city or state
  if (parts.length > 2) {
    result.city = parts[parts.length - 2];
  }

  return result;
}
