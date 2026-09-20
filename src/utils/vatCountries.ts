/**
 * Leaf VAT country helpers (no imports from vatManagement/vatFlowchart).
 * Both SSOT layers import from here to avoid import cycles.
 */

export const REVERSE_CHARGE_LABEL = "Reverse Charge";
export const ARTICLE_47_FIELD_NAME = "article47_immovable";

export const B2B_SAME_AS_B2C_COUNTRIES = new Set(["CH", "LI", "NO", "GR"]);

/**
 * Country names in every language our users can enter them. Lookups are done
 * on an upper-cased, accent-stripped form so "België", "BELGIE" and "Belgium"
 * all resolve. Name-in-text fallbacks (Google Places long_name, free-text
 * profile fields) frequently return localised names, so this table is part of
 * the correctness boundary for VAT, not just a nicety.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  AUSTRIA: "AT",
  OOSTENRIJK: "AT",
  AUTRICHE: "AT",
  OSTERREICH: "AT",
  BELGIUM: "BE",
  BELGIE: "BE",
  BELGIQUE: "BE",
  BELGIEN: "BE",
  BULGARIA: "BG",
  BULGARIJE: "BG",
  BULGARIE: "BG",
  BULGARIEN: "BG",
  CROATIA: "HR",
  KROATIE: "HR",
  CROATIE: "HR",
  KROATIEN: "HR",
  HRVATSKA: "HR",
  CYPRUS: "CY",
  ZYPERN: "CY",
  CHYPRE: "CY",
  CZECHIA: "CZ",
  "CZECH REPUBLIC": "CZ",
  TSJECHIE: "CZ",
  TCHEQUIE: "CZ",
  TSCHECHIEN: "CZ",
  CESKO: "CZ",
  DENMARK: "DK",
  DENEMARKEN: "DK",
  DANEMARK: "DK",
  ESTONIA: "EE",
  ESTLAND: "EE",
  ESTONIE: "EE",
  EESTI: "EE",
  FINLAND: "FI",
  SUOMI: "FI",
  FRANCE: "FR",
  FRANKRIJK: "FR",
  MONACO: "MC",
  GERMANY: "DE",
  DUITSLAND: "DE",
  ALLEMAGNE: "DE",
  DEUTSCHLAND: "DE",
  GREECE: "GR",
  GRIEKENLAND: "GR",
  GRECE: "GR",
  GRIECHENLAND: "GR",
  HELLAS: "GR",
  HUNGARY: "HU",
  HONGARIJE: "HU",
  HONGRIE: "HU",
  UNGARN: "HU",
  IRELAND: "IE",
  IERLAND: "IE",
  IRLANDE: "IE",
  IRLAND: "IE",
  ITALY: "IT",
  ITALIE: "IT",
  ITALIEN: "IT",
  ITALIA: "IT",
  LATVIA: "LV",
  LETLAND: "LV",
  LETTONIE: "LV",
  LETTLAND: "LV",
  LATVIJA: "LV",
  LITHUANIA: "LT",
  LITOUWEN: "LT",
  LITUANIE: "LT",
  LITAUEN: "LT",
  LIETUVA: "LT",
  LUXEMBOURG: "LU",
  LUXEMBURG: "LU",
  MALTA: "MT",
  NETHERLANDS: "NL",
  "THE NETHERLANDS": "NL",
  NEDERLAND: "NL",
  HOLLAND: "NL",
  "PAYS-BAS": "NL",
  NIEDERLANDE: "NL",
  POLAND: "PL",
  POLEN: "PL",
  POLOGNE: "PL",
  POLSKA: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  ROEMENIE: "RO",
  ROUMANIE: "RO",
  RUMANIEN: "RO",
  SLOVAKIA: "SK",
  SLOWAKIJE: "SK",
  SLOVAQUIE: "SK",
  SLOWAKEI: "SK",
  SLOVENIA: "SI",
  SLOVENIE: "SI",
  SLOWENIEN: "SI",
  SPAIN: "ES",
  SPANJE: "ES",
  ESPAGNE: "ES",
  SPANIEN: "ES",
  ESPANA: "ES",
  SWEDEN: "SE",
  ZWEDEN: "SE",
  SUEDE: "SE",
  SCHWEDEN: "SE",
  SVERIGE: "SE",
  SWITZERLAND: "CH",
  ZWITSERLAND: "CH",
  SUISSE: "CH",
  SCHWEIZ: "CH",
  LIECHTENSTEIN: "LI",
  NORWAY: "NO",
  NOORWEGEN: "NO",
  NORVEGE: "NO",
  NORWEGEN: "NO",
  NORGE: "NO",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  SCOTLAND: "GB",
  WALES: "GB",
  "VERENIGD KONINKRIJK": "GB",
  "ROYAUME-UNI": "GB",
  "VEREINIGTES KONIGREICH": "GB",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED STATES OF AMERICA": "US",
  "VERENIGDE STATEN": "US",
  "ETATS-UNIS": "US",
  "VEREINIGTE STAATEN": "US",
  CANADA: "CA",
  AUSTRALIA: "AU",
  AUSTRALIE: "AU",
  AUSTRALIEN: "AU",
  "NEW ZEALAND": "NZ",
  "NIEUW-ZEELAND": "NZ",
  "NOUVELLE-ZELANDE": "NZ",
  NEUSEELAND: "NZ",
  INDIA: "IN",
  INDIE: "IN",
  UKRAINE: "UA",
  OEKRAINE: "UA",
  UKRAINA: "UA",
  MOLDOVA: "MD",
  MOLDAVIE: "MD",
  ANDORRA: "AD",
  "SAN MARINO": "SM",
  TURKEY: "TR",
  TURKIJE: "TR",
  TURQUIE: "TR",
  TURKEI: "TR",
  TURKIYE: "TR",
};

export const STANDARD_RATES: Record<string, number> = {
  BE: 21, NL: 21, DE: 19, CH: 8.1, AT: 20, LI: 8.1, FR: 20, MC: 20, GB: 20,
  IE: 23, LT: 21, LV: 21, EE: 24, ES: 21, AD: 4.5, PT: 23, IT: 22, SM: 0,
  DK: 25, NO: 25, SE: 25, FI: 25.5, PL: 23, CZ: 21, UA: 20, RO: 21, MD: 20,
  SK: 23, HU: 27, SI: 22, HR: 25, GR: 24, CY: 19, BG: 20, TR: 20,
  US: 0, CA: 0, AU: 0, NZ: 0, IN: 0,
};

const KNOWN_COUNTRY_CODES = new Set([
  ...Object.keys(STANDARD_RATES),
  ...Object.values(COUNTRY_ALIASES),
]);

export type Article47Classification = "movable" | "immovable" | "project_dependent";

export const normalizeArticle47Classification = (
  classification?: string | null,
): Article47Classification | undefined => {
  if (classification === "movable" || classification === "immovable" || classification === "project_dependent") {
    return classification;
  }
  return undefined;
};

/** Upper-case, strip accents and collapse punctuation so localised names match. */
const canonicalCountryName = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[.,'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Pull a leading ISO-2 code from strings like "BE", "be-1000", "BE 1000", "BE1234567". */
const leadingCountryCode = (value: string): string => {
  const match = /^([A-Z]{2})(?=$|[^A-Z])/i.exec(value.trim());
  if (!match) return "";
  const code = match[1].toUpperCase();
  return KNOWN_COUNTRY_CODES.has(code) ? code : "";
};

export const parseVatCountryCode = (country?: string | null): string => {
  if (country == null || String(country).trim() === "") return "";
  const raw = String(country).trim();
  const upper = raw.toUpperCase();
  if (upper === "EL") return "GR";
  if (/^[A-Z]{2}$/.test(upper)) return KNOWN_COUNTRY_CODES.has(upper) ? upper : "";

  const canonical = canonicalCountryName(raw);
  if (COUNTRY_ALIASES[canonical]) return COUNTRY_ALIASES[canonical];

  // Country fields are free text in places: "Belgium (BE)", "BE - 1000",
  // "BE123456789". Accept an explicit code before falling through.
  const parenthesised = /\(([A-Z]{2})\)/i.exec(raw);
  if (parenthesised && KNOWN_COUNTRY_CODES.has(parenthesised[1].toUpperCase())) {
    return parenthesised[1].toUpperCase();
  }
  const leading = leadingCountryCode(raw);
  if (leading) return leading;

  return "";
};

export const firstVatCountry = (...candidates: Array<string | null | undefined>): string => {
  for (const candidate of candidates) {
    const parsed = parseVatCountryCode(candidate);
    if (parsed) return parsed;
  }
  return "";
};

export const getStandardVatRate = (country?: string | null): number => {
  const normalized = parseVatCountryCode(country);
  if (!normalized) return 0;
  return STANDARD_RATES[normalized] ?? 0;
};
