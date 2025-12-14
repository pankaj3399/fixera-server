/**
 * Geocoding service for converting addresses to coordinates
 * This service provides a foundation for geocoding functionality
 * Currently uses stored coordinates; can be extended with external APIs
 */

import { Coordinates, LocationInfo, parseAddressComponents } from './geolocation';

/**
 * Extract location info from user's businessInfo
 */
export function extractLocationFromBusinessInfo(businessInfo: any): LocationInfo {
  if (!businessInfo) {
    return {};
  }

  return {
    address: businessInfo.address,
    city: businessInfo.city,
    state: businessInfo.region,
    country: businessInfo.country,
    postalCode: businessInfo.postalCode,
    region: businessInfo.region,
    province: businessInfo.region
  };
}

/**
 * Extract location info from user's location field (customer)
 */
export function extractLocationFromUserLocation(location: any): LocationInfo {
  if (!location) {
    return {};
  }

  let coordinates: Coordinates | undefined = undefined;

  // MongoDB stores coordinates as [longitude, latitude]
  if (location.coordinates && Array.isArray(location.coordinates) && location.coordinates.length === 2) {
    const [longitude, latitude] = location.coordinates;
    coordinates = { latitude, longitude };
  }

  return {
    coordinates,
    address: location.address,
    city: location.city,
    state: location.state || location.region || location.province,
    country: location.country,
    postalCode: location.postalCode
  };
}

/**
 * Extract location info from project's professional
 * Takes into account whether to use company address or custom address
 */
export async function getProjectServiceLocation(
  project: any,
  professional: any
): Promise<LocationInfo> {
  const distance = project.distance;

  // If using company address, get from professional's businessInfo
  if (distance.useCompanyAddress && professional?.businessInfo) {
    return extractLocationFromBusinessInfo(professional.businessInfo);
  }

  // Otherwise use the custom address from project
  if (distance.address) {
    // Parse the address to extract components
    const parsed = parseAddressComponents(distance.address);
    const location: LocationInfo = {
      address: distance.address,
      ...parsed
    };

    if (
      distance.coordinates &&
      typeof distance.coordinates.latitude === 'number' &&
      typeof distance.coordinates.longitude === 'number'
    ) {
      location.coordinates = {
        latitude: distance.coordinates.latitude,
        longitude: distance.coordinates.longitude
      };
    }

    return location;
  }

  // Fallback to professional's business info
  if (professional?.businessInfo) {
    return extractLocationFromBusinessInfo(professional.businessInfo);
  }

  return {};
}

/**
 * Try to get country code from country name
 * This is a basic mapping - in production, use a proper library or API
 */
export function getCountryCode(countryName: string): string | undefined {
  if (!countryName) return undefined;

  const countryMap: { [key: string]: string } = {
    // Major countries
    'netherlands': 'NL',
    'belgium': 'BE',
    'germany': 'DE',
    'france': 'FR',
    'united kingdom': 'GB',
    'uk': 'GB',
    'united states': 'US',
    'usa': 'US',
    'canada': 'CA',
    'spain': 'ES',
    'italy': 'IT',
    'portugal': 'PT',
    'austria': 'AT',
    'switzerland': 'CH',
    'luxembourg': 'LU',
    'denmark': 'DK',
    'sweden': 'SE',
    'norway': 'NO',
    'finland': 'FI',
    'poland': 'PL',
    'czech republic': 'CZ',
    'czechia': 'CZ',
    'ireland': 'IE',
    'australia': 'AU',
    'new zealand': 'NZ',
    'japan': 'JP',
    'south korea': 'KR',
    'korea': 'KR',
    'india': 'IN',
    'china': 'CN',
    'brazil': 'BR',
    'mexico': 'MX',
    'argentina': 'AR'
  };

  const normalized = countryName.trim().toLowerCase();
  return countryMap[normalized];
}

/**
 * Enhance location info with country codes if missing
 */
export function enhanceLocationInfo(location: LocationInfo): LocationInfo {
  const enhanced = { ...location };

  // Try to add country code if we have country name but no code
  if (enhanced.country && !enhanced.countryCode) {
    enhanced.countryCode = getCountryCode(enhanced.country);
  }

  return enhanced;
}

/**
 * Get coordinates for an address
 * Currently returns null - can be extended to use external geocoding APIs
 * like Google Maps, OpenStreetMap Nominatim, etc.
 */
export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  // TODO: Implement geocoding using external API
  // For now, return null and rely on stored coordinates
  return null;
}

/**
 * Reverse geocode coordinates to get address components
 * Currently returns null - can be extended to use external geocoding APIs
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<Partial<LocationInfo> | null> {
  // TODO: Implement reverse geocoding using external API
  return null;
}

/**
 * Cache for geocoded addresses (in-memory cache)
 * In production, this should use Redis or similar
 */
const geocodeCache = new Map<string, Coordinates>();

/**
 * Get cached coordinates for an address
 */
export function getCachedCoordinates(address: string): Coordinates | null {
  return geocodeCache.get(address.toLowerCase().trim()) || null;
}

/**
 * Cache coordinates for an address
 */
export function cacheCoordinates(address: string, coordinates: Coordinates): void {
  geocodeCache.set(address.toLowerCase().trim(), coordinates);
}

/**
 * Try to get coordinates for a location by various means
 * 1. Use existing coordinates if available
 * 2. Check cache
 * 3. Attempt geocoding (if implemented)
 */
export async function resolveCoordinates(location: LocationInfo): Promise<Coordinates | null> {
  // If we already have coordinates, use them
  if (location.coordinates) {
    return location.coordinates;
  }

  // If we have an address, try to get coordinates
  if (location.address) {
    // Check cache first
    const cached = getCachedCoordinates(location.address);
    if (cached) {
      return cached;
    }

    // Try geocoding (currently not implemented)
    const geocoded = await geocodeAddress(location.address);
    if (geocoded) {
      cacheCoordinates(location.address, geocoded);
      return geocoded;
    }
  }

  if ((location.city || location.state || location.region) && location.country) {
    const approx = getApproximateCoordinates(
      location.city || location.state || location.region,
      location.country,
      location.state || location.region
    );
    if (approx) {
      return approx;
    }
  }

  return null;
}

/**
 * Calculate approximate coordinates from city and country
 * This is a very rough approximation using major city centers
 * Should only be used as a last resort
 */
export function getApproximateCoordinates(
  city?: string,
  country?: string,
  stateOrRegion?: string
): Coordinates | null {
  if (!country) return null;

  // Major city coordinates mapping
  const cityCoordinates: { [key: string]: Coordinates } = {
    // Netherlands
    'amsterdam,nl': { latitude: 52.3676, longitude: 4.9041 },
    'rotterdam,nl': { latitude: 51.9225, longitude: 4.47917 },
    'the hague,nl': { latitude: 52.0705, longitude: 4.3007 },
    'utrecht,nl': { latitude: 52.0907, longitude: 5.1214 },

    // Belgium
    'brussels,be': { latitude: 50.8503, longitude: 4.3517 },
    'antwerp,be': { latitude: 51.2194, longitude: 4.4025 },

    // USA
    'new york,us': { latitude: 40.7128, longitude: -74.0060 },
    'brooklyn,us': { latitude: 40.6782, longitude: -73.9442 },
    'los angeles,us': { latitude: 34.0522, longitude: -118.2437 },

    // UK
    'london,gb': { latitude: 51.5074, longitude: -0.1278 },

    // Germany
    'berlin,de': { latitude: 52.5200, longitude: 13.4050 },
    'munich,de': { latitude: 48.1351, longitude: 11.5820 },
  };

  const normalizedCity = city?.toLowerCase().trim();
  const normalizedState = stateOrRegion?.toLowerCase().trim();
  const normalizedCountry = (getCountryCode(country)?.toLowerCase() || country?.toLowerCase()?.trim());

  if (!normalizedCountry) {
    return null;
  }

  const keysToTry = [
    normalizedCity && normalizedState ? `${normalizedCity},${normalizedState},${normalizedCountry}` : null,
    normalizedCity ? `${normalizedCity},${normalizedCountry}` : null,
    normalizedState ? `${normalizedState},${normalizedCountry}` : null,
    normalizedCity ? normalizedCity : null,
  ].filter(Boolean) as string[];

  for (const key of keysToTry) {
    if (cityCoordinates[key]) {
      return cityCoordinates[key];
    }
  }

  return null;
}
