import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEcbRates, parseEcbRatesXml } from '../../utils/ecbRates';

const VALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
  <Cube>
    <Cube time="2026-10-23">
      <Cube currency="USD" rate="1.0812"/>
      <Cube currency="JPY" rate="162.35"/>
      <Cube currency="GBP" rate="0.86123"/>
      <Cube currency="BGN" rate="1.9558"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('ECB rates parser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the daily XML into EUR-based rates', () => {
    const parsed = parseEcbRatesXml(VALID_XML);
    expect(parsed.date).toBe('2026-10-23');
    expect(parsed.rates).toEqual({
      EUR: 1,
      USD: 1.0812,
      JPY: 162.35,
      GBP: 0.86123,
      BGN: 1.9558,
    });
  });

  it('parses the live feed format with single-quoted attributes', () => {
    const liveXml = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<Cube>
		<Cube time='2026-10-23'>
			<Cube currency='USD' rate='1.1193'/>
			<Cube currency='GBP' rate='0.83728'/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;
    expect(parseEcbRatesXml(liveXml)).toEqual({
      date: '2026-10-23',
      rates: { EUR: 1, USD: 1.1193, GBP: 0.83728 },
    });
  });

  it('ignores non-numeric and non-positive rates instead of poisoning the payload', () => {
    const xml = VALID_XML.replace(
      '<Cube currency="USD" rate="1.0812"/>',
      '<Cube currency="USD" rate="n/a"/><Cube currency="CAD" rate="-1"/>'
    );
    const parsed = parseEcbRatesXml(xml);
    expect(parsed.rates.EUR).toBe(1);
    expect(parsed.rates.USD).toBeUndefined();
    expect(parsed.rates.CAD).toBeUndefined();
    expect(parsed.rates.JPY).toBe(162.35);
  });

  it('rejects malformed XML', () => {
    expect(() => parseEcbRatesXml('')).toThrow(/empty|no <Cube>/i);
    expect(() => parseEcbRatesXml('<html><body>nope</body></html>')).toThrow(/no <Cube>/i);
  });

  it('rejects XML without the reference date', () => {
    const withoutTime = VALID_XML.replace(' time="2026-10-23"', '');
    expect(() => parseEcbRatesXml(withoutTime)).toThrow(/no Cube element with a time attribute/i);
  });

  it('rejects XML with an invalid reference date', () => {
    const invalidDate = VALID_XML.replace('time="2026-10-23"', 'time="23-10-2026"');
    expect(() => parseEcbRatesXml(invalidDate)).toThrow(/invalid date/i);
  });

  it('rejects XML with no currency entries', () => {
    const noRates = VALID_XML.replace(/<Cube currency="[A-Z]{3}" rate="[^"]+"\/>/g, '');
    expect(() => parseEcbRatesXml(noRates)).toThrow(/no currency rate entries/i);
  });

  it('fetches the ECB URL and parses the body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => VALID_XML,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await fetchEcbRates();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
    );
    expect(parsed.rates.USD).toBe(1.0812);
  });

  it('throws on a non-2xx ECB response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => 'unavailable' }))
    );
    await expect(fetchEcbRates()).rejects.toThrow(/HTTP status 503/);
  });
});
