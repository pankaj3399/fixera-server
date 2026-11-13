import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import type { Server } from 'node:http';

import publicRouter from '../../routes/Public';
import { localizeApiResponses } from '../../i18n/middleware';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
// Explicit test connection only; every run owns a fresh, isolated database.
const describeDb = testUri ? describe : describe.skip;

let server: Server;
let baseUrl = '';
let ipCounter = 0;

const MALFORMED_IDS = ['not-a-real-id', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz'];

// Every public read keyed by a path id, and the public writes keyed by one.
const ROUTES: Array<{ method: 'GET' | 'POST'; path: (id: string) => string }> = [
  { method: 'GET', path: (id) => `/api/public/projects/${id}` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/availability` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/working-hours` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/schedule-proposals` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/schedule-window` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/available-slots` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/reviews` },
  { method: 'GET', path: (id) => `/api/public/projects/${id}/favorites-count` },
  { method: 'GET', path: (id) => `/api/public/professionals/${id}` },
  { method: 'GET', path: (id) => `/api/public/professionals/${id}/reviews` },
  { method: 'GET', path: (id) => `/api/public/professionals/${id}/favorites-count` },
  { method: 'POST', path: (id) => `/api/public/professionals/${id}/view` },
  { method: 'POST', path: (id) => `/api/public/site-announcements/${id}/event` },
];

const call = (method: 'GET' | 'POST', path: string, language = 'en') =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'accept-language': language,
      // A fresh IP per request so these assertions never depend on rate-limit state.
      'x-forwarded-for': `198.18.1.${(ipCounter = (ipCounter % 250) + 1)}`,
    },
    body: method === 'POST' ? JSON.stringify({ event: 'click' }) : undefined,
  });

describeDb('public routes reject malformed ids with 400/404, never 500 (real Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_malformed_ids_it_${Date.now()}` });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(localizeApiResponses);
    app.use('/api/public', publicRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (mongoose.connection.name?.startsWith('fixera_malformed_ids_it_')) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  });

  it.each(ROUTES.flatMap((route) => MALFORMED_IDS.map((id) => ({ ...route, id, url: route.path(id) }))))(
    '$method $url',
    async ({ method, url }) => {
      const response = await call(method, url);
      const body = await response.json();
      expect([400, 404], `${method} ${url} -> ${response.status} ${JSON.stringify(body)}`).toContain(response.status);
      expect(body.success).toBe(false);
    },
  );
});
