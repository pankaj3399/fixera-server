/**
 * Real service/question units -> display labels + UBL UNECE unit codes.
 * SSOT for unit propagation to PDF and UBL.
 * Unknown units are REJECTED (never silently mapped to C62).
 */

const UNIT_ALIASES: Record<string, string> = {
  "m2": "m²",
  "m^2": "m²",
  "sqm": "m²",
  "sq m": "m²",
  "square meter": "m²",
  "square meters": "m²",
  "square metre": "m²",
  "square metres": "m²",
  "mètre carré": "m²",
  "m": "m",
  "meter": "m",
  "meters": "m",
  "metre": "m",
  "metres": "m",
  "m3": "m³",
  "m^3": "m³",
  "cbm": "m³",
  "m³": "m³",
  "cubic meter": "m³",
  "cubic meters": "m³",
  "cubic metre": "m³",
  "cubic metres": "m³",
  "hour": "hour",
  "hours": "hour",
  "h": "hour",
  "hr": "hour",
  "hrs": "hour",
  "heure": "hour",
  "heures": "hour",
  "uur": "hour",
  "uren": "hour",
  "day": "day",
  "days": "day",
  "dag": "day",
  "dagen": "day",
  "jour": "day",
  "jours": "day",
  "week": "week",
  "weeks": "week",
  "maand": "month",
  "maanden": "month",
  "month": "month",
  "months": "month",
  "room": "room",
  "rooms": "room",
  "kamer": "room",
  "kamers": "room",
  "piece": "piece",
  "pieces": "piece",
  "pc": "piece",
  "pcs": "piece",
  "st": "piece",
  "stuk": "piece",
  "stuks": "piece",
  "keer": "piece",
  "unit": "unit",
  "units": "unit",
};

const KNOWN_UNITS = new Set([
  "m²", "m", "m³", "km", "km²", "cm", "cm²", "mm",
  "hour", "day", "week", "month",
  "kg", "g", "ton", "tonne",
  "kwh", "kw", "kwp", "wp",
  "l", "ml", "room", "piece", "unit",
]);

const UNECE_BY_UNIT: Record<string, string> = {
  "m²": "MTK",
  "m": "MTR",
  "m³": "MTQ",
  "km": "KMT",
  "km²": "KMK",
  "cm": "CMT",
  "cm²": "CMK",
  "mm": "MMT",
  "hour": "HUR",
  "day": "DAY",
  "week": "WEE",
  "month": "MON",
  "kg": "KGM",
  "g": "GRM",
  "ton": "TNE",
  "tonne": "TNE",
  "kwh": "KWH",
  "kw": "KWT",
  "kwp": "KWT",
  "wp": "KWT",
  "l": "LTR",
  "ml": "MLT",
  "room": "C62",
  "piece": "C62",
  "unit": "C62",
};

export function normalizeUnitLabel(unit?: string | null): string | undefined {
  if (unit == null) return undefined;
  const trimmed = String(unit).trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (UNIT_ALIASES[lower]) return UNIT_ALIASES[lower];
  return trimmed;
}

/** True when the unit is in the validated catalogue (case/alias-insensitive). */
export function isKnownInvoiceUnit(unit?: string | null): boolean {
  const normalized = normalizeUnitLabel(unit)?.toLowerCase();
  if (!normalized) return false;
  return KNOWN_UNITS.has(normalized);
}

/** Throw on unknown units; callers must not silently fall back to C62. */
export function assertValidInvoiceUnit(unit?: string | null, context = "invoice unit"): string | undefined {
  if (unit == null) return undefined;
  const trimmed = String(unit).trim();
  if (!trimmed) return undefined;
  const normalized = normalizeUnitLabel(trimmed);
  if (!normalized || !KNOWN_UNITS.has(normalized.toLowerCase())) {
    throw new Error(`Unknown ${context} "${trimmed}". Use a validated UNECE unit (m², hour, day, kg, kWh, kW, room, piece, unit, ...).`);
  }
  return normalized;
}

/**
 * Best-effort unit normalization for rendering an already-issued document.
 * Unlike assertValidInvoiceUnit it never throws: malformed historical data
 * degrades to "no unit" instead of blocking invoice generation.
 */
export function tryNormalizeInvoiceUnit(unit?: string | null): string | undefined {
  try {
    return assertValidInvoiceUnit(unit);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the real service unit for a booking line.
 * Priority: checkout snapshot unit -> selected subproject pricing unit ->
 * service-config pricing option unit matching the pricing type.
 * Never throws so a bad legacy value cannot block an invoice.
 */
export function resolveInvoiceServiceUnit(params: {
  checkoutUnit?: string | null;
  subprojectUnit?: string | null;
  pricingType?: string | null;
  pricingOptions?: Array<{ pricingType?: string; unit?: string }> | null;
}): string | undefined {
  const direct =
    tryNormalizeInvoiceUnit(params.checkoutUnit) ||
    tryNormalizeInvoiceUnit(params.subprojectUnit);
  if (direct) return direct;
  if (params.pricingType === "unit") {
    const match = (params.pricingOptions || []).find(
      (option) => option?.pricingType === "price_per_unit" && tryNormalizeInvoiceUnit(option?.unit),
    );
    return tryNormalizeInvoiceUnit(match?.unit);
  }
  return undefined;
}

/**
 * UNECE Recommendation 20 unit codes for Peppol/UBL.
 * - undefined/empty (fixed-price, qty 1, no unit) -> C62 explicitly (documented
 *   service-unit default, not a silent unknown mapping).
 * - known units -> mapped code.
 * - unknown units -> throws (never silently C62).
 */
export function mapUnitToUneceCode(unit?: string | null): string {
  if (unit == null || String(unit).trim() === "") return "C62";
  const normalized = assertValidInvoiceUnit(unit, "UBL unit");
  const code = UNECE_BY_UNIT[normalized!.toLowerCase()];
  if (!code) throw new Error(`No UNECE mapping for unit "${String(unit)}".`);
  return code;
}

/** Resolve a VAT answer's configured unit from service-config questions. */
export function resolveVatAnswerUnit(
  fieldName: string,
  config?: {
    reducedVatQuestions?: Array<{ fieldName?: string; unit?: string }>;
    professionalVatQuestions?: Array<{ fieldName?: string; unit?: string }>;
  } | null,
): string | undefined {
  if (!fieldName || !config) return undefined;
  const all = [
    ...(config.reducedVatQuestions || []),
    ...(config.professionalVatQuestions || []),
  ];
  const match = all.find((q) => String(q?.fieldName || "").trim() === String(fieldName).trim());
  return normalizeUnitLabel(match?.unit);
}

/** Format a VAT answer value with its configured unit for invoices. */
export function formatVatAnswerWithUnit(
  fieldName: string,
  value: unknown,
  config?: Parameters<typeof resolveVatAnswerUnit>[1],
): string {
  const unit = resolveVatAnswerUnit(fieldName, config);
  const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (!unit) return `- ${fieldName}: ${rendered}`;
  // Booleans / yes-no answers don't take units.
  const lower = rendered.trim().toLowerCase();
  if (["true", "false", "yes", "no", "y", "n"].includes(lower)) {
    return `- ${fieldName}: ${rendered}`;
  }
  return `- ${fieldName}: ${rendered} ${unit}`;
}
