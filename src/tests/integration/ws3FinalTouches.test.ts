/**
 * WS3 (final touches part 3) disposable-DB tests.
 *
 * Run only when FIXERA_TEST_MONGODB_URI points at a disposable LOCAL test
 * database (repo convention: skipped otherwise). Never point it at Atlas.
 *
 * Covers, against a real MongoDB aggregation engine:
 * - 20: a 10 km project on the same street is found by geo search;
 *       a non-numeric maxKmRange cannot fail the whole geo search;
 *       noBorders country names ("belgium") match ISO codes ("BE").
 * - 21: company closures are exposed through the employee-list calendar source.
 */
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'ws3-test-jwt-secret';
});

describeDb('WS3 final touches (disposable local MongoDB)', () => {
  const proId = new Types.ObjectId();
  const brussels: [number, number] = [4.3622, 50.8453];

  beforeAll(async () => {
    await mongoose.connect(testUri!);
    const users = mongoose.connection.collection('users');
    const projects = mongoose.connection.collection('projects');
    await users.deleteMany({ email: /ws3-test\.example$/ });
    await projects.deleteMany({ title: /WS3 geo/ });
    try {
      await projects.createIndex({ 'distance.location': '2dsphere' });
    } catch {
      // Index may already exist.
    }

    await users.insertOne({
      _id: proId,
      role: 'professional',
      professionalStatus: 'approved',
      name: 'WS3 Test Pro',
      email: 'pro-ws3-test.example',
      businessInfo: { timezone: 'UTC', city: 'Bruxelles', country: 'Belgium' },
      companyAvailability: {
        monday: { available: true, startTime: '09:00', endTime: '17:00' },
        tuesday: { available: true, startTime: '09:00', endTime: '17:00' },
        wednesday: { available: true, startTime: '09:00', endTime: '17:00' },
        thursday: { available: true, startTime: '09:00', endTime: '17:00' },
        friday: { available: true, startTime: '09:00', endTime: '17:00' },
      },
      companyBlockedDates: [{ date: new Date('2026-11-10T00:00:00.000Z'), reason: 'Company closure' }],
      companyBlockedRanges: [
        {
          startDate: new Date('2026-11-20T00:00:00.000Z'),
          endDate: new Date('2026-11-22T00:00:00.000Z'),
          reason: 'Team holiday',
        },
      ],
      createdAt: new Date(),
    });

    await users.insertOne({
      role: 'employee',
      name: 'WS3 Test Employee',
      email: 'emp-ws3-test.example',
      employee: { companyId: proId.toString(), isActive: true, hasEmail: true, managedByCompany: true },
      blockedDates: [],
      blockedRanges: [],
      createdAt: new Date(),
    });

    await projects.insertMany([
      {
        title: 'WS3 geo 10km same street',
        status: 'published',
        professionalId: proId,
        category: 'Home',
        service: 'Plumbing',
        subprojects: [],
        distance: {
          address: 'Rue de la Loi 201, 1000 Bruxelles, Belgium',
          useCompanyAddress: false,
          maxKmRange: 10,
          noBorders: false,
          location: { type: 'Point', coordinates: brussels },
        },
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        title: 'WS3 geo string radius',
        status: 'published',
        professionalId: proId,
        category: 'Home',
        service: 'Plumbing',
        subprojects: [],
        distance: {
          address: 'Elsewhere street 5, Antwerp, Belgium',
          useCompanyAddress: false,
          maxKmRange: '10',
          noBorders: false,
          location: { type: 'Point', coordinates: [4.4, 51.22] },
        },
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
      },
      {
        title: 'WS3 geo noBorders BE code',
        status: 'published',
        professionalId: proId,
        category: 'Home',
        service: 'Plumbing',
        subprojects: [],
        distance: {
          address: 'Rue de la Loi 202, 1000 Bruxelles',
          useCompanyAddress: false,
          maxKmRange: 10,
          noBorders: true,
          countryCode: 'BE',
          location: { type: 'Point', coordinates: brussels },
        },
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
      },
    ]);
  }, 60000);

  afterAll(async () => {
    await mongoose.connection.collection('users').deleteMany({ email: /ws3-test\.example$/ });
    await mongoose.connection.collection('projects').deleteMany({ title: /WS3 geo/ });
    await mongoose.disconnect();
  });

  it('finds the same-street 10km project and survives the string-radius project', async () => {
    const { search } = await import('../../handlers/Search');
    const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await search(
      {
        query: {
          type: 'projects',
          limit: '20',
          loc: 'Rue de la Loi 201',
          customerCity: 'Bruxelles',
          customerCountry: 'belgium',
          customerLat: '50.8454',
          customerLon: '4.3624',
        },
      } as any,
      response as any
    );
    expect(response.json).toHaveBeenCalled();
    const body = response.json.mock.calls[0][0];
    const titles = (body.results || []).map((project: any) => project.title);
    // Same street (~20m away) inside the 10 km radius.
    expect(titles).toContain('WS3 geo 10km same street');
    // noBorders project with ISO code BE found via country name "belgium".
    expect(titles).toContain('WS3 geo noBorders BE code');
    // The string-radius project must not fail the whole search (Antwerp is
    // outside every 10 km window, so it is simply absent, not an error).
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('exposes company closures through the employee-list calendar source', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { getEmployees } = await import('../../handlers/User/employeeManagement');
    const token = jwt.sign({ id: proId.toString() }, process.env.JWT_SECRET!);
    const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await getEmployees(
      { cookies: { 'auth-token': token }, query: { includeInactive: 'true' } } as any,
      response as any,
      (() => undefined) as any
    );
    expect(response.status).toHaveBeenCalledWith(200);
    const body = response.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.companyBlockedDates).toHaveLength(1);
    expect(body.data.companyBlockedDates[0]).toMatchObject({ reason: 'Company closure' });
    expect(body.data.companyBlockedRanges).toHaveLength(1);
    expect(body.data.companyBlockedRanges[0]).toMatchObject({ reason: 'Team holiday' });
  });
});
