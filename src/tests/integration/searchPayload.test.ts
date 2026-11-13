/**
 * Public search / popular-projects payloads (disposable local MongoDB).
 *
 * Seeds published projects whose stored media are inline base64 data URLs (as on
 * the probed deployment) and checks that the public card endpoints only carry
 * what the frontend cards read (components/search/ProjectCard.tsx and the home
 * carousel), while keeping that contract intact. Logs the measured sizes.
 */
import mongoose, { Types } from 'mongoose';
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isLocalMongoTestUri } from '../localMongoUri';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = isLocalMongoTestUri(testUri) ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'search-payload-test-jwt-secret';
});

const PROJECT_COUNT = 42;
const IMAGES_PER_PROJECT = 6;
const IMAGE_BYTES = 60_000;
// A stored inline image: `data:image/jpeg;base64,...` (never fetched, only measured).
const dataImage = (seed: number) =>
  `data:image/jpeg;base64,${Buffer.alloc(IMAGE_BYTES, seed % 251).toString('base64')}`;
const longText = (label: string, size: number) => `${label} `.repeat(Math.ceil(size / (label.length + 1))).slice(0, size);

let server: Server;
let baseUrl = '';
const proId = new Types.ObjectId();

const getJson = async (path: string) => {
  const started = Date.now();
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), ms: Date.now() - started, body: JSON.parse(text) };
};

describeDb('public search card payloads (disposable local MongoDB)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `search_payload_${process.pid}_${Date.now().toString(36)}` });
    const users = mongoose.connection.collection('users');
    const projects = mongoose.connection.collection('projects');
    await users.insertOne({
      _id: proId,
      role: 'professional',
      professionalStatus: 'approved',
      name: 'Payload Test Pro',
      username: 'payload-pro',
      email: 'pro@search-payload-test.example',
      phone: '+3200000000',
      professionalLevel: 'Level 2',
      adminTags: ['verified'],
      profileImage: 'https://cdn.example.test/pro.png',
      businessInfo: { timezone: 'UTC', city: 'Bruxelles', country: 'Belgium', companyName: 'Payload BV' },
      companyAvailability: {
        monday: { available: true, startTime: '09:00', endTime: '17:00' },
        tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
        wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
        thursday: { available: true, startTime: '09:00', endTime: '17:00' },
        friday: { available: true, startTime: '09:00', endTime: '17:00' },
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const docs = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
      title: `Payload project ${index}`,
      description: longText('Project description', 600),
      status: 'published',
      professionalId: proId,
      category: 'Interior',
      service: 'Painting',
      areaOfWork: 'Walls',
      priceModel: 'fixed',
      timeMode: 'days',
      executionDuration: { value: 2, unit: 'days' },
      bufferDuration: { value: 1, unit: 'days' },
      media: {
        images: Array.from({ length: IMAGES_PER_PROJECT }, (__, image) => dataImage(index * 10 + image)),
        video: `https://bucket.example.test/projects/${index}/video.mp4`,
      },
      certifications: [{ name: 'ISO 9001', fileUrl: 'https://bucket.example.test/cert.pdf', uploadedAt: new Date(), isRequired: false }],
      distance: { address: 'Rue de la Loi 1, 1000 Bruxelles', useCompanyAddress: false, maxKmRange: 50, noBorders: false },
      subprojects: ['Small', 'Medium', 'Large'].map((name, sub) => ({
        name,
        description: longText(`${name} package`, 300),
        projectType: ['Internal'],
        professionalInputs: [{ fieldName: 'range_m2_living_area', value: { min: 10, max: 200 } }],
        pricing: { type: 'fixed', amount: 100 * (sub + 1) },
        included: [{ name: 'Premium Paint', description: 'Two coats', isCustom: false }],
        materialsIncluded: true,
        materials: [{ name: 'Paint', quantity: '10', unit: 'l', description: longText('Material', 200) }],
        preparationDuration: { value: 1, unit: 'days' },
        executionDuration: { value: 2, unit: 'days' },
        warrantyPeriod: { value: 1, unit: 'years' },
      })),
      extraOptions: Array.from({ length: 5 }, (__, option) => ({ name: `Option ${option}`, description: longText('Option', 200), price: 10, isCustom: true })),
      termsConditions: Array.from({ length: 5 }, (__, term) => ({ name: `Term ${term}`, description: longText('Term', 400), isCustom: true })),
      faq: Array.from({ length: 8 }, (__, faq) => ({ question: `Question ${faq}?`, answer: longText('Answer', 500), isGenerated: false })),
      rfqQuestions: [{ question: 'Surface?', type: 'text', isRequired: true }],
      postBookingQuestions: [{ question: 'Access code?', type: 'text', isRequired: false }],
      createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
      updatedAt: new Date(Date.UTC(2026, 0, 1 + index)),
    }));
    await projects.insertMany(docs);

    const searchRouter = (await import('../../routes/Search')).default;
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/search', searchRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (mongoose.connection.name?.startsWith('search_payload_')) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('project search returns the card fields only, with every image for the carousel', async () => {
    const { status, bytes, ms, body } = await getJson('/api/search?type=projects&limit=20');
    console.log(`[search payload] /api/search?type=projects&limit=20: ${bytes} bytes, ${ms} ms, ${body.results?.length} results`);
    expect(status).toBe(200);
    expect(body.results).toHaveLength(20);
    expect(body.pagination.total).toBe(PROJECT_COUNT);

    const card = body.results[0];
    // The ProjectCard contract.
    for (const field of ['_id', 'title', 'description', 'category', 'service', 'priceModel', 'timeMode', 'executionDuration', 'bufferDuration', 'certifications', 'media', 'professionalId', 'projectAvgRating', 'projectTotalReviews', 'subprojects', 'firstAvailableDate']) {
      expect(card, field).toHaveProperty(field);
    }
    expect(card.media.images).toHaveLength(IMAGES_PER_PROJECT);
    expect(card.media.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(card.certifications[0].name).toBe('ISO 9001');
    const pkg = card.subprojects[0];
    expect(pkg).toMatchObject({ name: 'Small', projectType: ['Internal'], warrantyPeriod: { value: 1, unit: 'years' }, executionDuration: { value: 2, unit: 'days' } });
    expect(pkg.pricing.type).toBe('fixed');
    expect(typeof pkg.pricing.customerAmount).toBe('number');
    expect(pkg.included[0].name).toBe('Premium Paint');
    expect(pkg).toHaveProperty('firstAvailableDate');
    expect(card.professionalId).toMatchObject({ username: 'payload-pro', professionalLevel: 'Level 2', adminTags: ['verified'], businessInfo: { city: 'Bruxelles', country: 'Belgium' } });

    // Not read by the card: detail-page data, the video and the professional's contact details.
    for (const field of ['faq', 'extraOptions', 'termsConditions', 'rfqQuestions', 'postBookingQuestions']) {
      expect(card, field).not.toHaveProperty(field);
    }
    expect(card.media).not.toHaveProperty('video');
    expect(pkg).not.toHaveProperty('materials');
    expect(pkg).not.toHaveProperty('professionalInputs');
    expect(card.professionalId).not.toHaveProperty('email');
    expect(card.professionalId).not.toHaveProperty('phone');

    // Inline images are the stored data; everything else per card stays small.
    const imageBytes = card.media.images.reduce((sum: number, image: string) => sum + image.length, 0);
    expect(Buffer.byteLength(JSON.stringify(card)) - imageBytes).toBeLessThan(8_000);
  });

  it('popular projects return one cover image per card', async () => {
    const { status, bytes, ms, body } = await getJson('/api/search/popular-projects?limit=10');
    console.log(`[search payload] /api/search/popular-projects?limit=10: ${bytes} bytes, ${ms} ms, ${body.projects?.length} projects`);
    expect(status).toBe(200);
    expect(body.projects).toHaveLength(10);
    const card = body.projects[0];
    expect(card.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(card).toMatchObject({ category: 'Interior', service: 'Painting', location: 'Rue de la Loi 1, 1000 Bruxelles' });
    expect(typeof card.startingPrice).toBe('number');
    expect(card.professional).toMatchObject({ name: 'payload-pro', city: 'Bruxelles', country: 'Belgium' });
    expect(bytes).toBeLessThan(10 * (IMAGE_BYTES * 1.4 + 2_000));
  });
});
