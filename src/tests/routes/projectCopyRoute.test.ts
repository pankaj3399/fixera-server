import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../middlewares/auth', () => ({
  protect: (req: any, res: any, next: any) => {
    if (!req.get('x-test-user')) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
    req.user = {
      _id: '000000000000000000000001',
      role: req.get('x-test-role') || 'professional',
      professionalStatus: req.get('x-test-status') || 'approved',
    };
    next();
  },
}));
vi.mock('../../models/project', () => ({
  default: { findById: vi.fn(async () => ({ professionalId: '000000000000000000000002' })) },
}));
vi.mock('../../utils/projectCopyGeneration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/projectCopyGeneration')>();
  return { ...actual, generateProjectCopy: vi.fn(async () => ({ titles: ['A grounded service title longer than thirty characters', 'A second grounded service title longer than thirty chars', 'Another descriptive service title over thirty characters'] })) };
});

import Project from '../../models/project';
import { generateProjectCopy, ProjectCopyConfigurationError } from '../../utils/projectCopyGeneration';
import projectRouter from '../../routes/Project';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use('/api/projects', projectRouter);
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateProjectCopy).mockResolvedValue({ titles: ['A grounded service title longer than thirty characters', 'A second grounded service title longer than thirty chars', 'Another descriptive service title over thirty characters'] });
});

const post = (input: { user?: string; role?: string; status?: string; ip: string; body?: unknown }) => fetch(`${baseUrl}/api/projects/generate-copy`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-forwarded-for': input.ip,
    ...(input.user ? { 'x-test-user': input.user } : {}),
    ...(input.role ? { 'x-test-role': input.role } : {}),
    ...(input.status ? { 'x-test-status': input.status } : {}),
  },
  body: JSON.stringify(input.body || { kind: 'title', locale: 'en', context: { service: 'Painting', description: 'Paint two bedrooms.' } }),
});

describe('project copy endpoint access and limits', () => {
  it('requires authentication, an approved professional account, and hides another professional project', async () => {
    expect((await post({ ip: '198.51.100.1' })).status).toBe(401);
    expect((await post({ user: 'yes', role: 'customer', ip: '198.51.100.2' })).status).toBe(403);
    expect((await post({ user: 'yes', status: 'pending', ip: '198.51.100.3' })).status).toBe(403);

    const ownership = await post({
      user: 'yes', ip: '198.51.100.4',
      body: { kind: 'title', locale: 'en', projectId: '000000000000000000000099', context: { service: 'Painting', description: 'Paint two bedrooms.' } },
    });
    expect(ownership.status).toBe(404);
    expect(await ownership.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(Project.findById).toHaveBeenCalledWith('000000000000000000000099');
  });

  it('returns generated output for the authenticated professional and does not persist it', async () => {
    const response = await post({ user: 'yes', ip: '198.51.100.5' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { titles: expect.any(Array) } });
    expect(generateProjectCopy).toHaveBeenCalledTimes(1);
  });

  it('returns a safe 503 when provider configuration is unavailable', async () => {
    vi.mocked(generateProjectCopy).mockRejectedValueOnce(new ProjectCopyConfigurationError());
    const response = await post({ user: 'yes', ip: '198.51.100.6' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });

  it('rate limits repeated requests', async () => {
    const ip = '198.51.100.7';
    let response: Response | undefined;
    for (let index = 0; index < 13; index += 1) response = await post({ user: 'yes', ip });
    expect(response?.status).toBe(429);
    expect(await response?.json()).toMatchObject({ code: 'AI_RATE_LIMITED' });
    expect(generateProjectCopy).toHaveBeenCalledTimes(12);
  });
});
