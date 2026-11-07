/**
 * Final Touches Part 3 #2 (client bug list #2): a day is available in day-mode
 * planning only when at least 3 working-schedule hours are FREE. This must hold
 * for untouched days too: a working day whose whole schedule is shorter than
 * 3 h is never available, not only once something is booked on it.
 *
 * Real MongoDB (FIXERA_TEST_MONGODB_URI, disposable local DB; skipped otherwise).
 * Drives the public availability handler (calendar) and the engine's start-date
 * validation (booking guard) so both views agree.
 */
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const describeDb = testUri && /test/i.test(testUri) ? describe : describe.skip;

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'min-free-hours-test-secret';
});

import { getProjectTeamAvailability } from '../../handlers/Project';
import { validateProjectScheduleSelection } from '../../utils/scheduleEngine';

const TAG = 'minfreehours-it';

const weekdays = (start: string, end: string) =>
  Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [
      d,
      { available: true, startTime: start, endTime: end },
    ])
  );

/** Wall time in `timeZone` -> UTC Date (no DST edge used in these fixtures). */
const wall = (timeZone: string, ymd: string, hhmm: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asUtc - guess));
};

const localYmd = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso)
  );

const callAvailability = async (projectId: string, startDate: string, endDate: string) => {
  let statusCode = 200;
  let body: any;
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: any) {
      body = payload;
      return res;
    },
  };
  await getProjectTeamAvailability(
    { params: { id: projectId }, query: { startDate, endDate }, headers: {} } as any,
    res
  );
  return { statusCode, body };
};

describeDb('day availability requires 3 free working hours (real MongoDB)', () => {
  const brusselsPro = new Types.ObjectId();
  const brusselsProject = new Types.ObjectId();
  const nyPro = new Types.ObjectId();
  const nyProject = new Types.ObjectId();
  const BXL = 'Europe/Brussels';
  const NY = 'America/New_York';

  const projectDoc = (_id: Types.ObjectId, professionalId: Types.ObjectId) => ({
    _id,
    title: `${TAG} day-mode project`,
    status: 'published',
    professionalId,
    category: 'Interior',
    service: 'Plumbing',
    priceModel: 'Fixed price',
    timeMode: 'days',
    resources: [String(professionalId)],
    minResources: 1,
    executionDuration: { value: 1, unit: 'days' },
    subprojects: [
      {
        name: 'One day job',
        description: 'Day-mode package',
        pricing: { type: 'fixed', amount: 450 },
        executionDuration: { value: 1, unit: 'days' },
      },
    ],
    createdAt: new Date(),
  });

  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `ft3_avail_${process.pid}_${Date.now().toString(36)}` });
    const users = mongoose.connection.collection('users');
    const projects = mongoose.connection.collection('projects');
    await users.deleteMany({ email: new RegExp(`${TAG}\\.example$`) });
    await projects.deleteMany({ title: new RegExp(`^${TAG}`) });

    const r = (ymd: string, from: string, to: string, tz = BXL) => ({
      startDate: wall(tz, ymd, from),
      endDate: wall(tz, ymd, to),
      reason: TAG,
    });

    // Brussels (CET, before the 28 Mar 2027 DST switch). Week of Mon 1 Mar 2027.
    await users.insertOne({
      _id: brusselsPro,
      role: 'professional',
      professionalStatus: 'approved',
      name: `${TAG} Brussels`,
      email: `bxl-${TAG}.example`,
      businessInfo: { timezone: BXL, country: 'BE' },
      companyAvailability: {
        ...weekdays('09:00', '17:00'), // 8 h
        saturday: { available: true, startTime: '09:00', endTime: '11:00' }, // 2 h schedule
        sunday: { available: true, startTime: '09:00', endTime: '12:00' }, // 3 h schedule
      },
      blockedRanges: [
        r('2027-03-02', '10:00', '16:00'), // Tue: 6 h blocked -> 2 h free
        r('2027-03-03', '10:00', '15:00'), // Wed: 5 h blocked -> 3 h free
        r('2027-03-04', '09:00', '12:00'), // Thu: split 3 h + 3 h -> 2 h free
        r('2027-03-04', '13:00', '16:00'),
        r('2027-03-05', '09:00', '13:00'), // Fri: 4 h + 3 h overlapping (5 h merged) -> 3 h free
        r('2027-03-05', '11:00', '14:00'),
        r('2027-03-08', '09:00', '10:00'), // Mon: 1 h inside ...
        r('2027-03-08', '17:00', '21:00'), // ... + 4 h outside working hours -> 7 h free
        r('2027-03-14', '09:00', '09:01'), // Sun (3 h schedule) with 1 minute blocked
      ],
      createdAt: new Date(),
    });

    // New York: local days differ from UTC days (evening local = next UTC day).
    await users.insertOne({
      _id: nyPro,
      role: 'professional',
      professionalStatus: 'approved',
      name: `${TAG} New York`,
      email: `ny-${TAG}.example`,
      businessInfo: { timezone: NY, country: 'US' },
      companyAvailability: {
        ...weekdays('15:00', '23:00'), // 8 h, crosses UTC midnight
        saturday: { available: true, startTime: '21:00', endTime: '23:00' }, // 2 h, entirely next UTC day
        sunday: { available: false },
      },
      blockedRanges: [
        r('2027-03-02', '16:00', '22:00', NY), // Tue: 6 h -> 2 h free
        r('2027-03-03', '17:00', '22:00', NY), // Wed: 5 h -> 3 h free
      ],
      createdAt: new Date(),
    });

    await projects.insertMany([projectDoc(brusselsProject, brusselsPro), projectDoc(nyProject, nyPro)]);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.collection('users').deleteMany({ email: new RegExp(`${TAG}\\.example$`) });
      await mongoose.connection.collection('projects').deleteMany({ title: new RegExp(`^${TAG}`) });
      await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    }
  });

  const blockedLocalDays = async (projectId: Types.ObjectId, tz: string) => {
    const { statusCode, body } = await callAvailability(
      String(projectId),
      '2027-02-28T12:00:00.000Z',
      '2027-03-16T12:00:00.000Z'
    );
    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    return new Set<string>((body.blockedDates as string[]).map((iso) => localYmd(iso, tz)));
  };

  const engineAccepts = async (projectId: Types.ObjectId, ymd: string) => {
    const result: any = await validateProjectScheduleSelection({
      projectId: String(projectId),
      subprojectIndex: 0,
      startDate: ymd,
    });
    return result.valid === true;
  };

  it('calendar: empty 2 h working day is blocked, empty 3 h working day is available', async () => {
    const blocked = await blockedLocalDays(brusselsProject, BXL);
    expect(blocked.has('2027-03-06')).toBe(true); // Sat 2 h, nothing booked
    expect(blocked.has('2027-03-13')).toBe(true); // next Sat, same
    expect(blocked.has('2027-03-07')).toBe(false); // Sun 3 h, nothing booked (inclusive)
    expect(blocked.has('2027-03-14')).toBe(true); // Sun 3 h with 1 minute blocked -> < 3 h free
  });

  it('calendar: 8 h days keep the 2-free/3-free, split, overlap and outside-hours results', async () => {
    const blocked = await blockedLocalDays(brusselsProject, BXL);
    expect(blocked.has('2027-03-01')).toBe(false); // Mon untouched
    expect(blocked.has('2027-03-02')).toBe(true); // 2 h free
    expect(blocked.has('2027-03-03')).toBe(false); // 3 h free
    expect(blocked.has('2027-03-04')).toBe(true); // split -> 2 h free
    expect(blocked.has('2027-03-05')).toBe(false); // overlapping -> 3 h free
    expect(blocked.has('2027-03-08')).toBe(false); // outside-hours block ignored -> 7 h free
  });

  it('engine start-date validation agrees with the calendar', async () => {
    expect(await engineAccepts(brusselsProject, '2027-03-06')).toBe(false); // empty 2 h Saturday
    expect(await engineAccepts(brusselsProject, '2027-03-07')).toBe(true); // empty 3 h Sunday
    expect(await engineAccepts(brusselsProject, '2027-03-02')).toBe(false); // 2 h free
    expect(await engineAccepts(brusselsProject, '2027-03-03')).toBe(true); // 3 h free
    expect(await engineAccepts(brusselsProject, '2027-03-04')).toBe(false); // split
    expect(await engineAccepts(brusselsProject, '2027-03-05')).toBe(true); // overlapping
    expect(await engineAccepts(brusselsProject, '2027-03-08')).toBe(true); // outside hours
  });

  it('evaluates local days in the professional time zone (New York)', async () => {
    const blocked = await blockedLocalDays(nyProject, NY);
    expect(blocked.has('2027-03-06')).toBe(true); // Sat 21:00-23:00 local, empty
    expect(blocked.has('2027-03-07')).toBe(true); // Sun non-working
    expect(blocked.has('2027-03-01')).toBe(false); // Mon untouched 8 h
    expect(blocked.has('2027-03-02')).toBe(true); // 2 h free
    expect(blocked.has('2027-03-03')).toBe(false); // 3 h free
    expect(await engineAccepts(nyProject, '2027-03-06')).toBe(false);
    expect(await engineAccepts(nyProject, '2027-03-02')).toBe(false);
    expect(await engineAccepts(nyProject, '2027-03-03')).toBe(true);
    expect(await engineAccepts(nyProject, '2027-03-01')).toBe(true);
  });

  it('uses Brussels working hours without the execution-window fallback', async () => {
    const projects = mongoose.connection.collection('projects');
    const id = new Types.ObjectId();
    const doc: any = projectDoc(id, brusselsPro);
    delete doc.executionDuration;
    delete doc.subprojects;
    await projects.insertOne(doc);
    const blocked = await blockedLocalDays(id, BXL);
    expect(blocked.has('2027-03-02')).toBe(true);
    expect(blocked.has('2027-03-03')).toBe(false);
  });

  it('clips ranges to the actual local day across the Brussels DST transition', async () => {
    const pro = new Types.ObjectId(), project = new Types.ObjectId();
    await mongoose.connection.collection('users').insertOne({ _id: pro, role: 'professional', email: `dst-${pro}@test.example`,
      businessInfo: { timezone: BXL, country: 'BE' },
      companyAvailability: { sunday: { available: true, startTime: '00:00', endTime: '08:00' } },
      blockedRanges: [{ startDate: new Date('2027-03-27T23:00:00Z'), endDate: new Date('2027-03-28T03:30:00Z') }],
    });
    await mongoose.connection.collection('projects').insertOne({ _id: project, professionalId: pro,
      resources: [String(pro)], minResources: 1, status: 'published' });
    const { body } = await callAvailability(String(project), '2027-03-28T12:00:00Z', '2027-03-29T12:00:00Z');
    expect(body.success).toBe(true);
    // Seven real working hours, 4.5 blocked: only 2.5 free.
    expect(body.blockedDates.map((iso: string) => localYmd(iso, BXL))).toContain('2027-03-28');
  });

  it('blocks planned members on their planned days rather than the whole booking window', async () => {
    const a = new Types.ObjectId(), b = new Types.ObjectId(), pro = new Types.ObjectId(), project = new Types.ObjectId();
    await mongoose.connection.collection('users').insertMany([a, b, pro].map(_id => ({ _id, role: 'professional', email: `plan-${_id}@test.example`,
      businessInfo: { timezone: 'UTC' }, companyAvailability: weekdays('09:00', '17:00') })));
    await mongoose.connection.collection('projects').insertOne({ _id: project, professionalId: pro,
      resources: [String(a), String(b)], minResources: 1, status: 'published' });
    await mongoose.connection.collection('bookings').insertOne({ bookingNumber: `PLAN-${new Types.ObjectId()}`, professional: pro, project,
      status: 'booked', assignedTeamMembers: [a, b], scheduledStartDate: new Date('2027-03-01T09:00:00Z'),
      scheduledExecutionEndDate: new Date('2027-03-03T17:00:00Z'),
      resourcePlan: [{ resourceId: a, days: [new Date('2027-03-01')] }, { resourceId: b, days: [new Date('2027-03-02')] }],
    });
    const { body } = await callAvailability(String(project), '2027-03-01', '2027-03-03');
    expect(body.blockedDates).toEqual([]);
  });

  it('finds bookings through a planned resource and leaves gaps in its plan free', async () => {
    const member = new Types.ObjectId(), pro = new Types.ObjectId(), project = new Types.ObjectId();
    await mongoose.connection.collection('users').insertMany([member, pro].map(_id => ({ _id, role: 'professional', email: `plan-${_id}@test.example`,
      businessInfo: { timezone: 'UTC' }, companyAvailability: weekdays('09:00', '17:00') })));
    await mongoose.connection.collection('projects').insertOne({ _id: project, professionalId: pro,
      resources: [String(member)], minResources: 1, status: 'published' });
    await mongoose.connection.collection('bookings').insertOne({ bookingNumber: `PLAN-${new Types.ObjectId()}`, professional: new Types.ObjectId(), project: new Types.ObjectId(),
      status: 'booked', assignedTeamMembers: [], scheduledStartDate: new Date('2027-03-01T09:00:00Z'),
      scheduledExecutionEndDate: new Date('2027-03-03T17:00:00Z'),
      resourcePlan: [{ resourceId: member, days: [new Date('2027-03-01'), new Date('2027-03-03')] }],
    });
    const { body } = await callAvailability(String(project), '2027-03-01', '2027-03-03');
    expect(body.blockedDates.map((iso: string) => localYmd(iso, 'UTC'))).toEqual(['2027-03-01', '2027-03-03']);
  });

});
