/**
 * Try to get country code from country name
 */
export function getCountryCode(countryName: string): string | undefined {
  if (!countryName) return undefined;

  const countryMap: Record<string, string> = {
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
    'argentina': 'AR',
  };

  const normalized = countryName.trim().toLowerCase();
  return countryMap[normalized];
}
