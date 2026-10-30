import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateProjectCopy,
  parseProjectCopyRequest,
  validateProjectCopyOutput,
  ProjectCopyConfigurationError,
  ProjectCopyInputError,
  ProjectCopyOutputError,
  ProjectCopyProviderError,
  ProjectCopyRefusalError,
  ProjectCopyTimeoutError,
} from '../../utils/projectCopyGeneration';

const context = {
  category: 'Home services',
  service: 'Bathroom renovation',
  areaOfWork: 'Utrecht',
  description: 'Replace the existing shower. Customer supplies tiles.',
  subprojects: [{
    name: 'Shower replacement',
    description: 'Remove the existing shower and install the selected replacement.',
    pricing: { type: 'fixed', amount: 850 },
    included: [{ name: 'Removal', description: 'Remove the old shower enclosure' }],
    executionDuration: { value: 2, unit: 'days' },
  }],
  extraOptions: [{ name: 'Tile removal', description: 'Remove existing wall tiles', price: 120 }],
  termsConditions: [{ name: 'Customer supplies tiles', description: 'Tiles are provided by the customer', type: 'condition' }],
  faq: [{ question: 'Who supplies tiles?', answer: 'The customer supplies the tiles.' }],
};

const titleOutput = {
  titles: [
    'Bathroom shower replacement in Utrecht with customer supplied tiles',
    'Shower renovation in Utrecht: removal and selected replacement',
    'Bathroom shower installation with existing enclosure removal',
  ],
};
const faqOutput = { faqs: Array.from({ length: 8 }, (_, index) => ({
  question: `Question ${index + 1}: what does the service include?`,
  answer: `The project details list shower replacement and removal. Confirm other details with the professional.`,
})) };
const response = (data: unknown, status: 'completed' | 'incomplete' = 'completed') => new Response(JSON.stringify({
  status,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
}), { status: 200, headers: { 'content-type': 'application/json' } });
const request = (kind: 'title' | 'faqs' = 'title', locale: 'en' | 'nl' | 'fr' = 'en') => ({ kind, locale, context: context as any });

afterEach(() => vi.restoreAllMocks());

describe('project copy request validation', () => {
  it('accepts supported locales and whitelists wizard copy fields only', () => {
    const parsed = parseProjectCopyRequest({ ...request('faqs', 'nl'), context: { ...context, contactEmail: 'private@example.test', customerAnswer: 'private' } });
    expect(parsed.locale).toBe('nl');
    expect(parsed.context).not.toHaveProperty('contactEmail');
    expect(parsed.context).not.toHaveProperty('customerAnswer');
    expect(parsed.context.subprojects?.[0]).toMatchObject({ name: 'Shower replacement', pricing: { amount: 850 }, executionDuration: { value: 2, unit: 'days' } });
  });

  it('preserves per-unit timing and range-only RFQ duration facts', () => {
    const parsed = parseProjectCopyRequest({ ...request('faqs'), context: { ...context, subprojects: [
      { name: 'Paint by area', pricing: { type: 'unit', unit: 'm2', durationBasis: 'per_unit' }, executionDuration: { value: 2, unit: 'days' } },
      { name: 'Custom quotation', pricing: { type: 'rfq' }, executionDuration: { unit: 'days', range: { min: 2, max: 5 } } },
    ] } });
    expect(parsed.context.subprojects?.[0]).toMatchObject({ pricing: { durationBasis: 'per_unit' }, executionDuration: { value: 2, unit: 'days' } });
    expect(parsed.context.subprojects?.[1]?.executionDuration).toEqual({ unit: 'days', range: { min: 2, max: 5 } });
    expect(() => validateProjectCopyOutput('title', { titles: [titleOutput.titles[0], titleOutput.titles[0].toUpperCase(), titleOutput.titles[2]] })).toThrow(ProjectCopyOutputError);
  });

  it('rejects unsupported locale, missing required context, oversized content, and oversized item lists', () => {
    expect(() => parseProjectCopyRequest({ ...request(), locale: 'de' })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), context: { service: 'Painting' } })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), context: { ...context, description: 'x'.repeat(2401) } })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), context: { ...context, subprojects: Array(9).fill(context.subprojects[0]) } })).toThrow(ProjectCopyInputError);
  });
});

describe('OpenAI Responses API generation', () => {
  it('sends a structured title request with configured model, locale instructions, bounded tokens and no stored response', async () => {
    const fetchMock = vi.fn(async () => response(titleOutput));
    const result = await generateProjectCopy(request('title', 'fr') as any, {
      env: { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test-model' },
      fetchImpl: fetchMock as any,
    });
    expect(result).toEqual(titleOutput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const payload = JSON.parse(init.body);
    expect(payload.model).toBe('gpt-test-model');
    expect(payload.max_output_tokens).toBe(240);
    expect(payload.store).toBe(false);
    expect(payload.text.format).toMatchObject({ type: 'json_schema', name: 'project_title', strict: true });
    expect(payload.instructions).toContain('French');
    expect(payload.input[0].content[0].text).toContain('Shower replacement');
    expect(payload.input[0].content[0].text).not.toContain('contactEmail');
  });

  it('uses the default model for FAQ generation and returns eight grounded pairs', async () => {
    const fetchMock = vi.fn(async () => response(faqOutput));
    const result = await generateProjectCopy(request('faqs', 'nl') as any, {
      env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: fetchMock as any,
    });
    const payload = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(payload.model).toBe('gpt-5.4-mini');
    expect(payload.max_output_tokens).toBe(900);
    expect(payload.text.format.name).toBe('project_faqs');
    expect(payload.instructions).toContain('Dutch');
    expect(payload.instructions).toContain('PER pricing unit');
    expect(result).toEqual(faqOutput);
  });

  it('fails without configuration and never makes a provider request', async () => {
    const fetchMock = vi.fn();
    await expect(generateProjectCopy(request() as any, { env: {}, fetchImpl: fetchMock as any })).rejects.toThrow(ProjectCopyConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps provider failure, timeout, refusal, truncation, invalid JSON and wrong shape safely', async () => {
    const badStatus = vi.fn(async () => new Response('', { status: 429 }));
    await expect(generateProjectCopy(request() as any, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: badStatus as any })).rejects.toThrow(ProjectCopyProviderError);

    const timeout = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await expect(generateProjectCopy(request() as any, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: timeout as any, timeoutMs: 5 })).rejects.toThrow(ProjectCopyTimeoutError);

    const refusal = vi.fn(async () => response({}),);
    refusal.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })));
    await expect(generateProjectCopy(request() as any, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: refusal as any })).rejects.toThrow(ProjectCopyRefusalError);

    const truncated = vi.fn(async () => response(titleOutput, 'incomplete'));
    await expect(generateProjectCopy(request() as any, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: truncated as any })).rejects.toThrow(ProjectCopyOutputError);

    const malformed = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad json' }] }] }), { status: 200 }));
    await expect(generateProjectCopy(request() as any, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: malformed as any })).rejects.toThrow(ProjectCopyOutputError);

    const invalidShape = vi.fn(async () => response({ titles: ['x', 'y', 'z'] }));
    await expect(generateProjectCopy(request() as any, { env: { OPENAI_API_KEY: 'test-key' }, fetchImpl: invalidShape as any })).rejects.toThrow(ProjectCopyOutputError);
  });
});
