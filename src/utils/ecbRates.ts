/**
 * ECB daily reference rates (eurofxref-daily.xml) — free, no key.
 *
 * Document shape:
 *   <gesmes:Envelope>
 *     <Cube>
 *       <Cube time='2026-10-23'>
 *         <Cube currency='USD' rate='1.1193'/>
 *         ...
 *       </Cube>
 *     </Cube>
 *   </gesmes:Envelope>
 *
 * A small regex parser is intentionally enough (ECB format is stable). The
 * live feed uses single-quoted attributes; both quote styles are accepted.
 */

export interface EcbRates {
  date: string;
  /** EUR-based rates; EUR itself is always 1. */
  rates: Record<string, number>;
}

const ECB_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_FETCH_TIMEOUT_MS = 10_000;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Parses the daily rates XML into { date, rates }.
 * Throws descriptive errors for malformed XML / missing date / no rates so
 * callers can log-and-fall-back instead of serving garbage.
 */
export function parseEcbRatesXml(xml: string): EcbRates {
  if (typeof xml !== "string" || !/<Cube/i.test(xml)) {
    throw new Error("ECB rates XML is empty or contains no <Cube> elements");
  }

  // The time attribute only appears on the inner day container.
  const dayMatch = /<Cube\s+[^>]*time=["']([^"']+)["']/gi.exec(xml);
  if (!dayMatch) {
    throw new Error("ECB rates XML has no Cube element with a time attribute");
  }
  const date = dayMatch[1];
  if (!DATE_RE.test(date)) {
    throw new Error(`ECB rates XML has an invalid date " ${date}"`);
  }

  const rates: Record<string, number> = { EUR: 1 };
  const entryRe = /<Cube\s+[^>]*currency=["']([A-Z]{3})["'][^>]*rate=["']([^"']+)["']/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(xml)) !== null) {
    const currency = entry[1];
    const rate = Number(entry[2]);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rates[currency] = rate;
  }

  if (Object.keys(rates).length <= 1) {
    throw new Error("ECB rates XML contains no currency rate entries");
  }

  return { date, rates };
}

/** Fetches and parses the ECB daily reference rates. Throws on failure. */
export async function fetchEcbRates(url: string = ECB_RATES_URL): Promise<EcbRates> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(ECB_FETCH_TIMEOUT_MS),
      headers: { Accept: "application/xml" },
    });
  } catch (err: any) {
    throw new Error(`ECB rates fetch failed: ${err?.name === "TimeoutError" ? "timeout" : err?.message ?? "network error"}`);
  }
  if (!response.ok) {
    throw new Error(`ECB rates fetch failed with HTTP status ${response.status}`);
  }
  const xml = await response.text();
  return parseEcbRatesXml(xml);
}
