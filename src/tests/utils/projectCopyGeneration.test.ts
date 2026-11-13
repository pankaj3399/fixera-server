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

  it('rejects unsupported locale, missing required context, wrong types and absurd list sizes', () => {
    expect(() => parseProjectCopyRequest({ ...request(), locale: 'de' })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), context: { service: 'Painting' } })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), context: { ...context, description: 42 } })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), context: { ...context, keywords: Array(101).fill('tile') } })).toThrow(ProjectCopyInputError);
    expect(() => parseProjectCopyRequest({ ...request(), projectId: 'x'.repeat(65) })).toThrow(ProjectCopyInputError);
  });

  // FT1 #3/#8: a valid but detailed project must never fail generation.
  it('clips oversized texts and lists instead of rejecting a detailed project', () => {
    const parsed = parseProjectCopyRequest({ ...request(), context: {
      ...context,
      description: 'x'.repeat(2401),
      keywords: Array.from({ length: 14 }, (_, i) => `keyword ${i} ${'k'.repeat(90)}`),
      subprojects: Array(9).fill(context.subprojects[0]),
    } });
    expect(parsed.context.description.length).toBeLessThanOrEqual(2400);
    expect(parsed.context.description.endsWith('…')).toBe(true);
    expect(parsed.context.keywords).toHaveLength(10);
    expect(parsed.context.keywords?.every((k) => k.length <= 80)).toBe(true);
    expect(parsed.context.subprojects).toHaveLength(8);
  });

  it('accepts what the project model allows (1000-char FAQ answers, 500-char materials, many items) within the prompt budget', () => {
    const longFaq = Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i} about the work?`, answer: 'a'.repeat(1000) }));
    const richSubproject = {
      ...context.subprojects[0],
      description: 'd'.repeat(600),
      included: Array.from({ length: 12 }, (_, i) => ({ name: `Item ${i}`, description: 'i'.repeat(400) })),
      materials: Array.from({ length: 12 }, (_, i) => ({ name: `Material ${i}`, description: 'm'.repeat(500) })),
    };
    const parsed = parseProjectCopyRequest({ ...request('faqs'), context: {
      ...context,
      description: 'p'.repeat(1300),
      faq: longFaq,
      subprojects: Array(8).fill(richSubproject),
      extraOptions: Array.from({ length: 10 }, (_, i) => ({ name: `Option ${i}`, description: 'o'.repeat(500) })),
    } });
    expect(JSON.stringify(parsed.context).length).toBeLessThanOrEqual(12_000);
    // The most important facts survive the shrink: service, packages, options.
    expect(parsed.context.service).toBe('Bathroom renovation');
    expect(parsed.context.subprojects?.length).toBeGreaterThan(0);
    expect(parsed.context.subprojects?.[0]?.name).toBe('Shower replacement');
    expect(parsed.context.extraOptions?.length).toBe(10);
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
    expect(payload.reasoning).toBeUndefined();
    expect(payload.max_output_tokens).toBe(240);
    expect(payload.store).toBe(false);
    expect(payload.text.format).toMatchObject({ type: 'json_schema', name: 'project_title', strict: true });
    expect(payload.instructions).toContain('French');
    expect(payload.input[0].content[0].text).toContain('Shower replacement');
    expect(payload.input[0].content[0].text).not.toContain('contactEmail');
  });

  it('uses the lowest supported reasoning effort for o-series models', async () => {
    const fetchMock = vi.fn(async () => response(titleOutput));
    await generateProjectCopy(request('title') as any, {
      env: { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'o3-mini' },
      fetchImpl: fetchMock as any,
    });
    const payload = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    // o-series reject `none`; `low` is the cheapest supported effort.
    expect(payload.reasoning).toEqual({ effort: 'low' });
  });

  it('requests no reasoning for gpt-5.1+ models', async () => {
    const fetchMock = vi.fn(async () => response(titleOutput));
    await generateProjectCopy(request('title') as any, {
      env: { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-5.1' },
      fetchImpl: fetchMock as any,
    });
    const payload = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(payload.reasoning).toEqual({ effort: 'none' });
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
