import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const {
  sendConfirmed,
  sendLinkUpdated,
  sendRescheduled,
  sendCancelled,
  releaseReservations,
  reserveKeys,
  availability,
  claimNotification,
  markSent,
  markFailed,
  notificationState,
  ticketUpdateOne,
  ticketRegistry,
  supportTicketFindById,
  supportTicketFindOneAndUpdate,
  startDispatch,
  markSuperseded,
  supersede,
} = vi.hoisted(() => {
  const notificationState = new Map<string, 'pending' | 'sent' | 'failed'>();
  const ticketRegistry = new Map<string, any>();
  const setPath = (target: any, path: string, value: any) => {
    const parts = path.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (cursor[parts[index]] == null) cursor[parts[index]] = {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
  };
  const unsetPath = (target: any, path: string) => {
    const parts = path.split('.');
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (cursor[parts[index]] == null) return;
      cursor = cursor[parts[index]];
    }
    delete cursor[parts[parts.length - 1]];
  };
  return {
    sendConfirmed: vi.fn(async () => true),
    sendLinkUpdated: vi.fn(async () => true),
    sendRescheduled: vi.fn(async () => true),
    sendCancelled: vi.fn(async () => true),
    releaseReservations: vi.fn(async () => undefined),
    reserveKeys: vi.fn(async () => undefined),
    availability: vi.fn(),
    notificationState,
    ticketRegistry,
    // Applies the conditional transition update to the in-memory ticket so a
    // subsequent reload observes the persisted state, like the real database.
    ticketUpdateOne: vi.fn(async (filter: any, update: any) => {
      const ticket = ticketRegistry.get(String(filter?._id));
      if (!ticket) return { matchedCount: 0, modifiedCount: 0 };
      if (update?.$set) {
        for (const [path, value] of Object.entries(update.$set)) setPath(ticket, path, value);
      }
      if (update?.$unset) {
        for (const path of Object.keys(update.$unset)) unsetPath(ticket, path);
      }
      if (update?.$inc) {
        for (const [path, value] of Object.entries(update.$inc)) {
          const current = path.split('.').reduce((cursor: any, key: string) => cursor?.[key], ticket);
          setPath(ticket, path, Number(current || 0) + Number(value));
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    supportTicketFindById: vi.fn((id: any) => {
      const query = {
        populate: () => query,
        then: (resolve: (value: any) => unknown) => resolve(ticketRegistry.get(String(id)) || null),
      };
      return query;
    }),
    supportTicketFindOneAndUpdate: vi.fn(async (filter: any) => {
      const ticket = ticketRegistry.get(String(filter?._id));
      if (!ticket) return null;
      ticket.__v = Number(ticket.__v || 0) + 1;
      return ticket;
    }),
    claimNotification: vi.fn(async ({ ticketId, eventId }: any) => {
      const key = `${ticketId}:${eventId}`;
      const status = notificationState.get(key);
      if (status === 'sent') return { claimed: false, status: 'sent' as const };
      if (status === 'pending') return { claimed: false, status: 'pending' as const };
      notificationState.set(key, 'pending');
      return { claimed: true, notificationId: key, attempts: 1 } as any;
    }),
    markSent: vi.fn(async (id: string) => { notificationState.set(id, 'sent'); }),
    markFailed: vi.fn(async (id: string) => { notificationState.set(id, 'failed'); }),
    markSuperseded: vi.fn(async () => undefined),
    supersede: vi.fn(async () => undefined),
    startDispatch: vi.fn(async () => true),
  };
});

vi.mock('../../../utils/support/emails', () => ({
  sendSupportMeetingConfirmedEmail: sendConfirmed,
  sendSupportMeetingLinkUpdatedEmail: sendLinkUpdated,
  sendSupportMeetingRescheduledEmail: sendRescheduled,
  sendSupportMeetingCancelledEmail: sendCancelled,
  supportEmailWouldSend: (user: any) => Boolean(user?.email && !user?.deletedAt && user?.isEmailVerified !== false),
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  fenceAccountWritesInSession: vi.fn(async () => undefined),
}));
vi.mock('../../../utils/support/meetingNotifications', () => ({
  claimSupportMeetingNotification: claimNotification,
  markSupportMeetingNotificationSent: markSent,
  markSupportMeetingNotificationFailed: markFailed,
  markSupportMeetingNotificationSuperseded: markSuperseded,
  startSupportMeetingNotificationDispatch: startDispatch,
  supersedeSupportMeetingNotifications: supersede,
  findSentSupportMeetingNotification: vi.fn(async () => null),
  supportMeetingEventId: (type: string, revision: number) => `${type}:${revision}`,
}));
vi.mock('../../../utils/support/calendarReservations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/calendarReservations')>();
  return {
    ...actual,
    withCalendarTransaction: vi.fn(async (fn: (session: unknown) => Promise<unknown>) => fn({})),
    reserveCalendarKeys: reserveKeys,
    releaseCalendarReservations: releaseReservations,
  };
});
vi.mock('../../../utils/support/availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/support/availability')>();
  return { ...actual, getSupportAvailabilityForProfessional: availability };
});
vi.mock('../../../models/supportTicket', () => ({
  default: {
    create: vi.fn(),
    updateOne: ticketUpdateOne,
    findById: supportTicketFindById,
    findOneAndUpdate: supportTicketFindOneAndUpdate,
  },
}));
vi.mock('../../../models/calendarReservation', () => ({ default: { insertMany: vi.fn(), deleteMany: vi.fn() } }));

import { assertRealHttpsMeetingLink } from '../../../utils/support/meetingLink';
import { sanitizeAdminAuditBody, sanitizeForAudit } from '../../../utils/auditLogger';
import {
  cancelSupportMeeting,
  completeSupportMeeting,
  rescheduleSupportMeeting,
  setSupportMeetingLink,
} from '../../../utils/support/meetingReservation';

const future = new Date('2030-11-04T08:30:00.000Z');
const later = new Date('2030-11-05T09:00:00.000Z');
const adminId = '507f1f77bcf86cd799439014';
const owner = { _id: '507f1f77bcf86cd799439012', name: 'Piet', email: 'piet@example.com', isEmailVerified: true };

const meetingTicket = (overrides: Record<string, unknown> = {}) => {
  const ticket: any = {
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    kind: 'meeting',
    status: 'open',
    userId: owner._id,
    ticketNumber: 'SUP-2030-000001',
    subject: 'Support meeting',
    reason: 'technical_problem',
    locale: 'en',
    meeting: {
      status: 'pending',
      scheduledAt: future,
      durationMinutes: 30,
      timeZone: 'Europe/Brussels',
      adminId: new Types.ObjectId(adminId),
      slotKeys: ['admin:slot', 'professional:slot'],
    },
    markModified: vi.fn(),
    save: vi.fn(async () => ticket),
  };
  Object.assign(ticket, overrides);
  ticketRegistry.set(String(ticket._id), ticket);
  return ticket;
};

describe('manual support meeting links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notificationState.clear();
    ticketRegistry.clear();
    sendConfirmed.mockResolvedValue(true);
    sendLinkUpdated.mockResolvedValue(true);
    sendRescheduled.mockResolvedValue(true);
    sendCancelled.mockResolvedValue(true);
    availability.mockResolvedValue({
      timeZone: 'UTC',
      durationMinutes: 30,
      admins: [{ _id: adminId, name: 'Admin', timeZone: 'UTC' }],
      slots: [{
        start: later.toISOString(),
        end: new Date(later.getTime() + 30 * 60 * 1000).toISOString(),
        localStart: later.toISOString(),
        localEnd: new Date(later.getTime() + 30 * 60 * 1000).toISOString(),
        adminIds: [adminId],
      }],
    });
  });

  it('rejects malformed, unsafe and credential-bearing URLs', () => {
    for (const value of [
      '',
      'not a url',
      'http://meet.example/abc',
      'javascript:alert(1)',
      'ftp://meet.example/abc',
      'https://user:secret@meet.example/abc',
      `https://meet.example/${'a'.repeat(600)}`,
    ]) {
      expect(() => assertRealHttpsMeetingLink(value)).toThrow();
    }
    expect(assertRealHttpsMeetingLink('  https://meet.example/room?p=123  ')).toBe(
      'https://meet.example/room?p=123',
    );
  });

  it('redacts meeting links from admin audit details', () => {
    const sanitized = sanitizeForAudit({
      meeting: { action: 'set_link', meetingLink: 'https://meet.example/room?p=secret' },
    });
    expect(sanitized.meeting.meetingLink).toBe('[redacted]');
    expect(JSON.stringify(sanitized)).not.toContain('secret');
  });

  it('redacts private internal note bodies from admin audit details', () => {
    const sanitized = sanitizeForAudit({
      internalNote: 'PRIVATE-NOTE-BODY',
      reply: 'visible reply',
    });
    expect(sanitized.internalNote).toBe('[redacted]');
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE-NOTE-BODY');
    expect(sanitized.reply).toBe('visible reply');

    const noteRouteBody = sanitizeAdminAuditBody(
      '/api/admin/support/items/ticket/665000000000000000000001/notes',
      { body: 'PRIVATE-NOTE-BODY' },
    );
    expect(noteRouteBody.body).toBe('[redacted:private-note]');
    expect(JSON.stringify(noteRouteBody)).not.toContain('PRIVATE-NOTE-BODY');
  });

  it('persists the real link before confirming and moves pending to scheduled exactly once', async () => {
    const ticket = meetingTicket();
    const result = await setSupportMeetingLink({
      ticket,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room?p=123',
    });

    expect(ticket.meeting.meetingLink).toBe('https://meet.example/room?p=123');
    expect(ticket.meeting.status).toBe('scheduled');
    expect(ticket.meeting.linkAddedAt).toBeInstanceOf(Date);
    expect(ticket.meeting.linkAddedBy).toBeInstanceOf(Types.ObjectId);
    expect(ticketUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ticket._id }),
      expect.objectContaining({
        $set: expect.objectContaining({
          'meeting.meetingLink': 'https://meet.example/room?p=123',
          'meeting.status': 'scheduled',
          'meeting.revision': 1,
          'meeting.confirmationEventId': 'confirmed:1',
        }),
        $inc: { __v: 1 },
      }),
      { session: {} },
    );
    expect(ticket.save).not.toHaveBeenCalled();
    expect(sendConfirmed).toHaveBeenCalledWith(owner, ticket);
    expect(sendLinkUpdated).not.toHaveBeenCalled();
    expect(markSent).toHaveBeenCalled();
    expect(result).toMatchObject({ emailSent: true, emailAttempted: true, unchanged: false });
  });

  it('does not send a duplicate confirmation or recreate reservations on the same link', async () => {
    const ticket = meetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: future,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId: new Types.ObjectId(adminId),
        meetingLink: 'https://meet.example/room',
        linkAddedAt: new Date('2030-11-01T08:00:00Z'),
        linkEmailSentAt: new Date('2030-11-01T08:00:01Z'),
        slotKeys: ['admin:slot', 'professional:slot'],
      },
    });
    const result = await setSupportMeetingLink({
      ticket,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });

    expect(result).toMatchObject({ unchanged: true, emailAttempted: false, emailSent: false });
    expect(ticket.save).not.toHaveBeenCalled();
    expect(sendConfirmed).not.toHaveBeenCalled();
    expect(reserveKeys).not.toHaveBeenCalled();
  });

  it('retries a failed confirmation only, keeping the saved link', async () => {
    const ticket = meetingTicket();
    sendConfirmed.mockResolvedValueOnce(false);
    const first = await setSupportMeetingLink({
      ticket,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });
    expect(first.emailSent).toBe(false);
    expect(ticket.meeting.meetingLink).toBe('https://meet.example/room');
    expect(ticket.meeting.linkEmailSentAt).toBeUndefined();

    sendConfirmed.mockClear();
    sendConfirmed.mockResolvedValue(true);
    const retry = await setSupportMeetingLink({
      ticket,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });
    expect(retry).toMatchObject({ unchanged: true, emailAttempted: true, emailSent: true });
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    expect(markSent).toHaveBeenCalled();
  });

  it('replacing a link updates the link and sends the link-updated email', async () => {
    const ticket = meetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: future,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId: new Types.ObjectId(adminId),
        meetingLink: 'https://meet.example/old',
        linkAddedAt: new Date('2030-11-01T08:00:00Z'),
        linkEmailSentAt: new Date('2030-11-01T08:00:01Z'),
      },
    });
    const result = await setSupportMeetingLink({
      ticket,
      adminId,
      owner,
      meetingLink: 'https://meet.example/new',
    });

    expect(ticket.meeting.meetingLink).toBe('https://meet.example/new');
    expect(ticket.meeting.status).toBe('scheduled');
    expect(ticket.meeting.linkUpdatedAt).toBeInstanceOf(Date);
    expect(sendLinkUpdated).toHaveBeenCalledTimes(1);
    expect(sendConfirmed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unchanged: false, emailAttempted: true, emailSent: true });
  });

  it('never reactivates cancelled/completed meetings and rejects a new past link', async () => {
    const cancelled = meetingTicket({
      meeting: { status: 'cancelled', scheduledAt: future, durationMinutes: 30 },
    });
    await expect(setSupportMeetingLink({
      ticket: cancelled,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(cancelled.save).not.toHaveBeenCalled();

    const completed = meetingTicket({
      meeting: { status: 'completed', scheduledAt: future, durationMinutes: 30 },
    });
    await expect(setSupportMeetingLink({
      ticket: completed,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });

    const closed = meetingTicket({ status: 'closed' });
    await expect(setSupportMeetingLink({
      ticket: closed,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(closed.save).not.toHaveBeenCalled();

    const past = meetingTicket({
      meeting: {
        status: 'pending',
        scheduledAt: new Date('2020-01-01T08:00:00.000Z'),
        durationMinutes: 30,
      },
    });
    await expect(setSupportMeetingLink({
      ticket: past,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(past.meeting.status).toBe('pending');
    expect(past.save).not.toHaveBeenCalled();
  });

  it('rescheduling a pending meeting keeps it pending and does not claim a link', async () => {
    const ticket = meetingTicket({
      meeting: {
        status: 'pending',
        scheduledAt: future,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId: new Types.ObjectId(adminId),
        slotKeys: ['old-admin-slot', 'old-professional-slot'],
      },
    });
    const result = await rescheduleSupportMeeting({
      ticket,
      professional: { _id: owner._id },
      start: later,
      timeZone: 'UTC',
      owner,
    });

    expect(ticket.meeting.status).toBe('pending');
    expect(ticket.meeting.meetingLink).toBeUndefined();
    expect(ticket.meeting.scheduledAt).toEqual(later);
    expect(ticket.meeting.slotKeys).toEqual([
      `admin:${adminId}:${later.toISOString()}`,
      `professional:${owner._id}:${later.toISOString()}`,
    ]);
    expect(sendRescheduled).toHaveBeenCalledWith(owner, ticket);
    expect(sendConfirmed).not.toHaveBeenCalled();
    expect(result.emailSent).toBe(true);
    expect(releaseReservations).toHaveBeenCalled();
    expect(reserveKeys).toHaveBeenCalled();
  });

  it('rescheduling a confirmed meeting keeps scheduled with its existing link', async () => {
    const ticket = meetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: future,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId: new Types.ObjectId(adminId),
        meetingLink: 'https://meet.example/room',
        linkEmailSentAt: new Date('2030-11-01T08:00:01Z'),
        slotKeys: ['old-admin-slot', 'old-professional-slot'],
      },
    });
    await rescheduleSupportMeeting({
      ticket,
      professional: { _id: owner._id },
      start: later,
      timeZone: 'UTC',
      owner,
    });
    expect(ticket.meeting.status).toBe('scheduled');
    expect(ticket.meeting.meetingLink).toBe('https://meet.example/room');
    expect(sendRescheduled).toHaveBeenCalledWith(owner, ticket);
  });

  it('cancelling a pending meeting releases its reservation and emails no false confirmation', async () => {
    const ticket = meetingTicket();
    const result = await cancelSupportMeeting({
      ticket,
      actorId: owner._id,
      actorRole: 'user',
      owner,
    });

    expect(ticket.meeting.status).toBe('cancelled');
    expect(ticket.status).toBe('closed');
    expect(ticketUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ticket._id }),
      expect.objectContaining({
        $set: expect.objectContaining({
          'meeting.status': 'cancelled',
          'meeting.cancelledEventId': 'cancelled:1',
          status: 'closed',
        }),
        $unset: { 'meeting.slotKeys': 1 },
        $inc: { __v: 1 },
      }),
      { session: {} },
    );
    expect(releaseReservations).toHaveBeenCalled();
    expect(sendCancelled).toHaveBeenCalledTimes(1);
    expect(sendConfirmed).not.toHaveBeenCalled();
    expect(result.emailSent).toBe(true);
  });

  it('only confirmed meetings can be completed', async () => {
    const pending = meetingTicket();
    await expect(completeSupportMeeting({ ticket: pending, actorId: adminId }))
      .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(pending.save).not.toHaveBeenCalled();

    const scheduled = meetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: future,
        durationMinutes: 30,
        meetingLink: 'https://meet.example/room',
      },
    });
    await completeSupportMeeting({ ticket: scheduled, actorId: adminId });
    expect(scheduled.meeting.status).toBe('completed');
    expect(releaseReservations).toHaveBeenCalled();
  });
});
