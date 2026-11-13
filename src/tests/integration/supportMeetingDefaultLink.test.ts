import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';

/**
 * Real-Mongo coverage for the per-admin default meeting link: on submit the
 * admin the slot is assigned to supplies the link, the meeting is confirmed
 * and the professional is emailed at once. Without a default link the old
 * pending/manual flow is unchanged.
 */
const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_support_default_link';
});

const { sendConfirmed, sendLinkUpdated, sendRescheduled, sendCancelled, sendAck, sendReply } = vi.hoisted(() => ({
  sendConfirmed: vi.fn(async (_owner: any, _ticket: any) => true),
  sendLinkUpdated: vi.fn(async (_owner: any, _ticket: any) => true),
  sendRescheduled: vi.fn(async () => true),
  sendCancelled: vi.fn(async () => true),
  sendAck: vi.fn(async (_owner: any, _ticket: any, _kind?: string) => true),
  sendReply: vi.fn(async () => true),
}));

// Emails are always captured, never sent.
vi.mock('../../utils/support/emails', () => ({
  sendSupportMeetingConfirmedEmail: sendConfirmed,
  sendSupportMeetingLinkUpdatedEmail: sendLinkUpdated,
  sendSupportMeetingRescheduledEmail: sendRescheduled,
  sendSupportMeetingCancelledEmail: sendCancelled,
  sendSupportTicketAcknowledgementEmail: sendAck,
  sendSupportReplyEmail: sendReply,
  supportEmailWouldSend: (user: any) => Boolean(user?.email && !user?.deletedAt),
}));

vi.mock('../../config/db', () => ({ default: vi.fn(async () => undefined) }));

import AccountDataGuard from '../../models/accountDataGuard';
import CalendarReservation from '../../models/calendarReservation';
import SupportMeetingNotification from '../../models/supportMeetingNotification';
import SupportTicket from '../../models/supportTicket';
import User from '../../models/user';
import { createSupportItemForUser } from '../../handlers/Support/service';
import {
  getSupportMeetingLinkSettings,
  updateSupportMeetingLinkSettings,
} from '../../handlers/Admin/supportMeetingLinkSettings';
import { setSupportMeetingLink } from '../../utils/support/meetingReservation';
import { serializeSupportTicketUser } from '../../utils/support/serializers';

// Lower id sorts first: combined slots are assigned to the lowest eligible id.
const adminAId = new Types.ObjectId('607f1f77bcf86cd799439101');
const adminBId = new Types.ObjectId('607f1f77bcf86cd799439102');
const proOneId = new Types.ObjectId('607f1f77bcf86cd799439201');
const proTwoId = new Types.ObjectId('607f1f77bcf86cd799439202');

const meetingStart = new Date('2031-03-04T09:00:00.000Z');
const ZOOM = 'https://us02web.zoom.us/j/1234567890?pwd=abc';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc';

const fullWeek = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => [
    day,
    { available: true, startTime: '00:00', endTime: '23:59' },
  ]),
);

const insertAdmin = async (
  _id: Types.ObjectId,
  name: string,
  supportMeetingLink?: Record<string, unknown>,
) => {
  await User.collection.insertOne({
    _id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    password: 'admin-test-password-hash',
    role: 'admin',
    adminPermissionLevels: { support: 'write' },
    accountStatus: 'active',
    isEmailVerified: true,
    deletedAt: null,
    timeZone: 'UTC',
    availability: fullWeek,
    blockedDates: [],
    blockedRanges: [],
    adminAvailabilityConfigured: true,
    ...(supportMeetingLink ? { supportMeetingLink } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const insertProfessional = async (_id: Types.ObjectId, name: string) => {
  await User.collection.insertOne({
    _id,
    name,
    email: `${name.toLowerCase()}@example.com`,
    phone: `+3247${String(_id).slice(-7)}`,
    password: 'pro-test-password-hash',
    role: 'professional',
    professionalStatus: 'approved',
    accountStatus: 'active',
    isEmailVerified: true,
    deletedAt: null,
    timeZone: 'Europe/Brussels',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const loadUser = async (id: Types.ObjectId) => {
  const user = await User.findById(id);
  if (!user) throw new Error('fixture user missing');
  return user;
};

const submitMeeting = async (professionalId: Types.ObjectId, start = meetingStart) =>
  createSupportItemForUser({
    user: await loadUser(professionalId),
    body: {
      kind: 'meeting',
      subject: 'Payout question',
      description: 'Please help me with a payout.',
      reason: 'payment_payout',
      locale: 'nl',
      scheduledAt: start.toISOString(),
      timeZone: 'Europe/Brussels',
    },
  });

const mockRes = () => ({
  statusCode: 200,
  body: undefined as any,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(payload: unknown) {
    this.body = payload;
    return this;
  },
});

const putSettings = async (adminId: Types.ObjectId, meetingLink: unknown) => {
  const res = mockRes();
  await updateSupportMeetingLinkSettings(
    { admin: await loadUser(adminId), body: { meetingLink } } as any,
    res as any,
  );
  return res;
};

describeDb('support meeting default link (real Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_support_default_link_test_${Date.now()}` });
    await Promise.all([
      SupportTicket.createIndexes(),
      SupportMeetingNotification.createIndexes(),
      AccountDataGuard.createIndexes(),
      CalendarReservation.createIndexes(),
      User.createIndexes(),
    ]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    sendConfirmed.mockResolvedValue(true);
    sendLinkUpdated.mockResolvedValue(true);
    sendAck.mockResolvedValue(true);
    delete process.env.SUPPORT_MEETING_EMAIL_TIMEOUT_MS;
    await Promise.all([
      SupportTicket.deleteMany({}),
      SupportMeetingNotification.deleteMany({}),
      CalendarReservation.deleteMany({}),
      AccountDataGuard.deleteMany({}),
      User.deleteMany({}),
      mongoose.connection.collection('counters').deleteMany({}),
    ]);
    await insertProfessional(proOneId, 'ProOne');
    await insertProfessional(proTwoId, 'ProTwo');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('puts the assigned admin default link in the ticket on submit and emails time + link at once', async () => {
    await insertAdmin(adminAId, 'Alice', { url: ZOOM, provider: 'zoom', updatedAt: new Date() });

    const result = await submitMeeting(proOneId);

    expect(result.emailSent).toBe(true);
    const ticket = await SupportTicket.findById(result.ticket._id).lean();
    expect(ticket?.meeting).toMatchObject({
      status: 'scheduled',
      meetingLink: ZOOM,
      linkSource: 'admin_default',
      revision: 1,
    });
    expect(String(ticket?.meeting?.adminId)).toBe(String(adminAId));
    expect(String(ticket?.meeting?.linkAddedBy)).toBe(String(adminAId));
    expect(ticket?.meeting?.linkEmailSentAt).toBeInstanceOf(Date);

    // One confirmation with the time and the link; no "link follows" ack.
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    const [recipient, mailed] = sendConfirmed.mock.calls[0];
    expect(String(recipient._id)).toBe(String(proOneId));
    expect(mailed.meeting.meetingLink).toBe(ZOOM);
    expect(new Date(mailed.meeting.scheduledAt).toISOString()).toBe(meetingStart.toISOString());
    expect(mailed.locale).toBe('nl');
    expect(sendAck).not.toHaveBeenCalled();

    // Both calendars stay booked exactly as before.
    const reservations = await CalendarReservation.find({ sourceId: result.ticket._id }).lean();
    const keys = reservations.map((row: any) => row.key).join(' ');
    expect(keys).toContain(`admin:${adminAId}`);
    expect(keys).toContain(`professional:${proOneId}`);
    expect(reservations).toHaveLength(4);

    const sent = await SupportMeetingNotification.find({ ticketId: result.ticket._id }).lean();
    expect(sent.map((row: any) => [row.type, row.status])).toEqual([['confirmed', 'sent']]);

    // The owner sees an active join link right away.
    const serialized: any = await serializeSupportTicketUser(result.ticket, {
      requester: { _id: String(proOneId), id: String(proOneId), name: 'ProOne', role: 'professional' },
    });
    expect(serialized.meeting).toMatchObject({
      status: 'scheduled',
      meetingLink: ZOOM,
      linkActive: true,
      linkSource: 'admin_default',
    });
  });

  it('keeps the pending manual flow when the assigned admin has no default link', async () => {
    await insertAdmin(adminAId, 'Alice');

    const result = await submitMeeting(proOneId);

    expect(result.emailSent).toBe(true);
    const ticket = await SupportTicket.findById(result.ticket._id).lean();
    expect(ticket?.meeting?.status).toBe('pending');
    expect(ticket?.meeting?.meetingLink).toBeUndefined();
    expect(ticket?.meeting?.linkSource).toBeUndefined();
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendAck.mock.calls[0][2]).toBe('meeting');
    expect(sendConfirmed).not.toHaveBeenCalled();
    expect(await CalendarReservation.countDocuments({ sourceId: result.ticket._id })).toBe(4);

    // An admin pasting a link later still confirms it and sends the email.
    const fresh = await SupportTicket.findById(result.ticket._id);
    const linked = await setSupportMeetingLink({
      ticket: fresh!,
      adminId: adminAId,
      owner: await loadUser(proOneId),
      meetingLink: TEAMS,
    });
    expect(linked.emailSent).toBe(true);
    expect(linked.ticket.meeting).toMatchObject({
      status: 'scheduled',
      meetingLink: TEAMS,
      linkSource: 'manual',
    });
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
  });

  it('ignores a stored default link that is no longer a valid https URL', async () => {
    await insertAdmin(adminAId, 'Alice', { url: 'http://insecure.example.com/room', provider: 'other' });

    const result = await submitMeeting(proOneId);

    const ticket = await SupportTicket.findById(result.ticket._id).lean();
    expect(ticket?.meeting?.status).toBe('pending');
    expect(ticket?.meeting?.meetingLink).toBeUndefined();
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendConfirmed).not.toHaveBeenCalled();
  });

  it('lets an admin override the default link on the ticket (link-updated email)', async () => {
    await insertAdmin(adminAId, 'Alice', { url: ZOOM, provider: 'zoom' });
    await insertAdmin(adminBId, 'Bob');
    const created = await submitMeeting(proOneId);
    expect(created.ticket.meeting?.meetingLink).toBe(ZOOM);

    const current = await SupportTicket.findById(created.ticket._id);
    const override = await setSupportMeetingLink({
      ticket: current!,
      adminId: adminBId,
      owner: await loadUser(proOneId),
      meetingLink: TEAMS,
    });

    expect(override.unchanged).toBe(false);
    expect(override.emailSent).toBe(true);
    expect(override.ticket.meeting).toMatchObject({
      status: 'scheduled',
      meetingLink: TEAMS,
      linkSource: 'manual',
    });
    expect(String(override.ticket.meeting?.linkAddedBy)).toBe(String(adminBId));
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    expect(sendLinkUpdated).toHaveBeenCalledTimes(1);
    expect(sendLinkUpdated.mock.calls[0][1].meeting.meetingLink).toBe(TEAMS);
    // Overriding never touches the reservation.
    expect(await CalendarReservation.countDocuments({ sourceId: created.ticket._id })).toBe(4);
  });

  it('uses the admin the combined slot is assigned to, never another admin link', async () => {
    // Both admins share the slot. Alice (lowest id) gets it and has no link,
    // so the meeting stays pending even though Bob has one.
    await insertAdmin(adminAId, 'Alice');
    await insertAdmin(adminBId, 'Bob', { url: TEAMS, provider: 'teams' });

    const first = await submitMeeting(proOneId);
    expect(String(first.ticket.meeting?.adminId)).toBe(String(adminAId));
    const firstStored = await SupportTicket.findById(first.ticket._id).lean();
    expect(firstStored?.meeting?.status).toBe('pending');
    expect(firstStored?.meeting?.meetingLink).toBeUndefined();

    // Alice is now busy at that time, so the same slot goes to Bob for the
    // next professional and Bob's own default link is applied.
    const second = await submitMeeting(proTwoId);
    const secondStored = await SupportTicket.findById(second.ticket._id).lean();
    expect(String(secondStored?.meeting?.adminId)).toBe(String(adminBId));
    expect(secondStored?.meeting).toMatchObject({
      status: 'scheduled',
      meetingLink: TEAMS,
      linkSource: 'admin_default',
    });
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    expect(sendConfirmed.mock.calls[0][1].meeting.meetingLink).toBe(TEAMS);
  });

  it('keeps the link on the ticket when the confirmation email times out', async () => {
    process.env.SUPPORT_MEETING_EMAIL_TIMEOUT_MS = '50';
    sendConfirmed.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    await insertAdmin(adminAId, 'Alice', { url: ZOOM, provider: 'zoom' });

    const result = await submitMeeting(proOneId);

    expect(result.emailSent).toBe(false);
    const ticket = await SupportTicket.findById(result.ticket._id).lean();
    expect(ticket?.meeting).toMatchObject({ status: 'scheduled', meetingLink: ZOOM });
    expect(ticket?.meeting?.linkEmailSentAt).toBeUndefined();
    // A confirmed meeting never gets the misleading "link follows" ack.
    expect(sendAck).not.toHaveBeenCalled();
    const ledger = await SupportMeetingNotification.findOne({ ticketId: result.ticket._id }).lean();
    expect(ledger?.status).toBe('failed');

    // Re-saving the same link retries the confirmation through the ledger.
    const fresh = await SupportTicket.findById(result.ticket._id);
    const retry = await setSupportMeetingLink({
      ticket: fresh!,
      adminId: adminAId,
      owner: await loadUser(proOneId),
      meetingLink: ZOOM,
    });
    expect(retry.unchanged).toBe(true);
    expect(retry.emailSent).toBe(true);
  });

  describe('admin default link settings', () => {
    it('saves a valid https link with the inferred provider and clears it', async () => {
      await insertAdmin(adminAId, 'Alice');

      const zoom = await putSettings(adminAId, `  ${ZOOM}  `);
      expect(zoom.statusCode).toBe(200);
      expect(zoom.body.data).toMatchObject({ meetingLink: ZOOM, provider: 'zoom', receivesMeetings: true });

      const teams = await putSettings(adminAId, TEAMS);
      expect(teams.body.data.provider).toBe('teams');

      const other = await putSettings(adminAId, 'https://meet.google.com/abc-defg-hij');
      expect(other.body.data.provider).toBe('other');

      const read = mockRes();
      await getSupportMeetingLinkSettings({ admin: await loadUser(adminAId) } as any, read as any);
      expect(read.body.data.meetingLink).toBe('https://meet.google.com/abc-defg-hij');

      const cleared = await putSettings(adminAId, '');
      expect(cleared.statusCode).toBe(200);
      expect(cleared.body.data).toMatchObject({ meetingLink: null, provider: null });
      const stored = await User.findById(adminAId).lean();
      expect(stored?.supportMeetingLink).toBeUndefined();
    });

    it.each([
      ['http://zoom.us/j/1', 'https://'],
      ['zoom.us/j/1', 'complete meeting link'],
      ['javascript:alert(1)', 'https://'],
      ['https://user:secret@zoom.us/j/1', 'username or password'],
      [`https://zoom.us/${'a'.repeat(600)}`, '500 characters'],
      [12345, 'valid meeting link'],
    ])('rejects %s', async (value, message) => {
      await insertAdmin(adminAId, 'Alice', { url: ZOOM, provider: 'zoom' });

      const res = await putSettings(adminAId, value);

      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.body)).toContain(message);
      // The previous valid default is kept.
      const stored = await User.findById(adminAId).lean();
      expect(stored?.supportMeetingLink?.url).toBe(ZOOM);
    });

    it('requires an explicit meetingLink field', async () => {
      await insertAdmin(adminAId, 'Alice');
      const res = mockRes();
      await updateSupportMeetingLinkSettings({ admin: await loadUser(adminAId), body: {} } as any, res as any);
      expect(res.statusCode).toBe(400);
    });
  });
});
