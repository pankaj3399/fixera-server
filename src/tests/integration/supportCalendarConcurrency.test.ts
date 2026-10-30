import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;
const commitRetryAppName = `fixera-commit-retry-${process.pid}-${Date.now()}`;
let commitFailpointsAvailable = false;

const setCommitFailure = async (
  times: number,
  errorLabels: string[],
  errorCode = 112,
) => {
  await mongoose.connection.db!.admin().command({
    configureFailPoint: 'failCommand',
    mode: { times },
    data: {
      failCommands: ['commitTransaction'],
      errorCode,
      errorLabels,
      appName: commitRetryAppName,
    },
  });
};

const clearCommitFailure = async () => {
  if (!commitFailpointsAvailable) return;
  await mongoose.connection.db!.admin().command({
    configureFailPoint: 'failCommand',
    mode: 'off',
  });
};

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_support_integration';
});

const { sendConfirmed, sendLinkUpdated, sendRescheduled, sendCancelled, sendAck, sendReply, deleteS3 } = vi.hoisted(() => ({
  sendConfirmed: vi.fn(async () => true),
  sendLinkUpdated: vi.fn(async () => true),
  sendRescheduled: vi.fn(async () => true),
  sendCancelled: vi.fn(async () => true),
  sendAck: vi.fn(async () => true),
  sendReply: vi.fn(async () => true),
  deleteS3: vi.fn(async () => undefined),
}));

const raceGates = vi.hoisted(() => ({
  dispatch: null as null | { eventPrefix: string; reached: () => void; wait: Promise<void> },
  supersede: null as null | { ticketId: string; reached: () => void; wait: Promise<void> },
  release: null as null | {
    sourceType: string;
    sourceId: string;
    reached: () => void;
    wait: Promise<void>;
  },
  busy: null as null | { reached: () => void; wait: Promise<void> },
  postSaveConflict: null as null | {
    ticketId: string;
    notificationRowId: Types.ObjectId;
    fired: boolean;
    calls: number;
  },
}));

vi.mock('../../utils/support/emails', () => ({
  sendSupportMeetingConfirmedEmail: sendConfirmed,
  sendSupportMeetingLinkUpdatedEmail: sendLinkUpdated,
  sendSupportMeetingRescheduledEmail: sendRescheduled,
  sendSupportMeetingCancelledEmail: sendCancelled,
  sendSupportTicketAcknowledgementEmail: sendAck,
  sendSupportReplyEmail: sendReply,
  supportEmailWouldSend: (user: any) => Boolean(user?.email && !user?.deletedAt),
}));

vi.mock('../../utils/support/meetingNotifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/support/meetingNotifications')>();
  return {
    ...actual,
    startSupportMeetingNotificationDispatch: async (
      notificationId: any,
      attempts: number,
      now?: Date,
    ) => {
      const gate = raceGates.dispatch;
      if (gate) {
        const mongooseModule = await import('mongoose');
        const row = await mongooseModule.default.connection
          .collection('supportmeetingnotifications')
          .findOne({ _id: notificationId });
        if (row && String(row.eventId).startsWith(gate.eventPrefix)) {
          raceGates.dispatch = null;
          gate.reached();
          await gate.wait;
        }
      }
      return actual.startSupportMeetingNotificationDispatch(notificationId, attempts, now);
    },
    supersedeSupportMeetingNotifications: async (ticketId: any, options: any) => {
      const gate = raceGates.supersede;
      const session = options && typeof options === 'object' && 'session' in options
        ? options.session
        : options;
      // The gate models the pre-fix non-transactional supersede; a transactional
      // caller (session present) must not be paused.
      if (gate && !session && String(ticketId) === gate.ticketId) {
        raceGates.supersede = null;
        gate.reached();
        await gate.wait;
      }
      const conflict = raceGates.postSaveConflict;
      if (conflict && session && String(ticketId) === conflict.ticketId) {
        conflict.calls += 1;
        if (!conflict.fired) {
          conflict.fired = true;
          // The transition document was already saved by this attempt. Commit a
          // write to a ledger row this transactional command is about to touch,
          // so the server answers that next command with WriteConflict +
          // TransientTransactionError. The driver must abort and replay the
          // callback; the replayed save has to persist the transition instead
          // of becoming an empty-update no-op.
          const mongooseModule = await import('mongoose');
          await mongooseModule.default.connection.collection('supportmeetingnotifications').updateOne(
            { _id: conflict.notificationRowId },
            { $set: { lastError: 'concurrent writer outside the transaction' } },
          );
        }
      }
      return actual.supersedeSupportMeetingNotifications(ticketId, options);
    },
  };
});

vi.mock('../../utils/support/calendarReservations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/support/calendarReservations')>();
  return {
    ...actual,
    releaseCalendarReservations: async (
      sourceType: any,
      sourceId: any,
      session?: any,
    ) => {
      const gate = raceGates.release;
      if (
        gate
        && !session
        && gate.sourceType === String(sourceType)
        && gate.sourceId === String(sourceId)
      ) {
        raceGates.release = null;
        gate.reached();
        await gate.wait;
      }
      return actual.releaseCalendarReservations(sourceType, sourceId, session);
    },
  };
});

vi.mock('../../config/db', () => ({ default: vi.fn(async () => undefined) }));

vi.mock('../../utils/support/availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/support/availability')>();
  return {
    ...actual,
    getSupportAvailabilityForProfessional: vi.fn(async (input: any) => {
      const adminId = '507f1f77bcf86cd799439014';
      return {
        timeZone: input.timeZone,
        durationMinutes: 30,
        admins: [{ _id: adminId, name: 'Admin', timeZone: 'UTC' }],
        slots: [{
          start: input.from.toISOString(),
          end: input.to.toISOString(),
          localStart: input.from.toISOString(),
          localEnd: input.to.toISOString(),
          adminIds: [adminId],
        }],
      };
    }),
    professionalHasBusyConflict: async (...args: any[]) => {
      const gate = raceGates.busy;
      if (gate) {
        raceGates.busy = null;
        gate.reached();
        await gate.wait;
      }
      return (actual.professionalHasBusyConflict as any)(...args);
    },
  };
});

vi.mock('../../utils/s3Upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/s3Upload')>();
  return { ...actual, deleteFromS3: deleteS3 };
});

import Booking from '../../models/booking';
import AccountDataGuard from '../../models/accountDataGuard';
import CalendarReservation from '../../models/calendarReservation';
import Meeting from '../../models/meeting';
import MeetingRequest from '../../models/meetingRequest';
import Project from '../../models/project';
import SupportMeetingNotification from '../../models/supportMeetingNotification';
import SupportTicket from '../../models/supportTicket';
import SupportTicketInternalNote from '../../models/supportTicketInternalNote';
import User from '../../models/user';
import {
  buildCalendarReservationKeysForInterval,
  reserveCalendarKeys,
  withCalendarTransaction,
} from '../../utils/support/calendarReservations';
import {
  findBookingCalendarConflicts,
  findBookingCalendarConflictsForSchedule,
  releaseBookingCalendar,
  replaceBookingCalendar,
} from '../../utils/support/bookingCalendar';
import { buildBookingBlockedRanges } from '../../utils/bookingBlocks';
import { deleteUserData } from '../../utils/deleteUserData';
import { anonymizeUser } from '../../utils/anonymizeUser';
import { createSupportItemForUser } from '../../handlers/Support/service';
import { getSupportItem, listSupportItems } from '../../handlers/Support/tickets';
import { validateProjectScheduleSelection } from '../../utils/scheduleEngine';
import { findTeamConflicts } from '../../utils/scheduleConflict';
import {
  buildProfessionalBusyIntervals,
  meetingIntervalInTimeZone,
} from '../../utils/support/availability';
import {
  cancelSupportMeeting,
  completeSupportMeeting,
  deliverMeetingNotification,
  rescheduleSupportMeeting,
  setSupportMeetingLink,
} from '../../utils/support/meetingReservation';
import {
  SUPPORT_MEETING_NOTIFICATION_LEASE_MS,
  supersedeSupportMeetingNotifications,
} from '../../utils/support/meetingNotifications';
import { adminUpdateMeetingRequest } from '../../handlers/Admin/support';
import { cancelMeeting } from '../../handlers/Meeting';
import { extendBookingExecution } from '../../handlers/Booking/payment-integration';

const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');

const ensureFenceUser = async () => {
  try {
    await User.collection.insertOne({
      _id: professionalId,
      name: 'Piet Professional',
      email: 'piet-calendar@example.com',
      phone: '+32470000000',
      password: 'calendar-test-password-hash',
      role: 'professional',
      professionalStatus: 'approved',
      accountStatus: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 11000) throw error;
  }
};
const otherUserId = new Types.ObjectId('507f1f77bcf86cd799439013');
const adminId = new Types.ObjectId('507f1f77bcf86cd799439014');

const owner = {
  _id: professionalId.toString(),
  name: 'Piet',
  email: 'piet@example.com',
  isEmailVerified: true,
};

const meetingStart = new Date('2030-11-04T08:30:00.000Z');
const laterStart = new Date('2030-11-05T09:00:00.000Z');

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const waitFor = async (check: () => Promise<boolean>, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const mockRes = () => {
  const res = {
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
  };
  return res;
};

const buildSupportSlotKeysForTest = (userId: Types.ObjectId, start = meetingStart): string[] => [
  `admin:${adminId}:${start.toISOString()}`,
  `professional:${userId}:${start.toISOString()}`,
];

const reserveSupportKeysForTest = async (
  ticketId: Types.ObjectId,
  userId: Types.ObjectId,
  start = meetingStart,
): Promise<void> => {
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  await reserveCalendarKeys({
    sourceType: 'support',
    sourceId: ticketId,
    keys: [
      ...buildCalendarReservationKeysForInterval({
        role: 'admin',
        userId: adminId,
        startAt: start,
        endAt: end,
      }),
      ...buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId,
        startAt: start,
        endAt: end,
      }),
    ],
  });
};

const sourceModelFor = (sourceType: string): any => {
  if (sourceType === 'meeting') return Meeting;
  if (sourceType === 'meeting_request') return MeetingRequest;
  return Booking;
};

const createMeetingTicket = async (overrides: Record<string, any> = {}) => {
  return SupportTicket.create({
    userId: professionalId,
    kind: 'meeting',
    subject: 'Support meeting',
    description: 'Need help',
    reason: 'technical_problem',
    userType: 'professional',
    locale: 'en',
    status: 'open',
    meeting: {
      status: 'pending',
      scheduledAt: meetingStart,
      durationMinutes: 30,
      timeZone: 'Europe/Brussels',
      adminId,
      slotKeys: [`admin:${adminId}:${meetingStart.toISOString()}`, `professional:${professionalId}:${meetingStart.toISOString()}`],
      ...overrides.meeting,
    },
    ...overrides,
  });
};

/**
 * A pending notification row from an older revision. The requested transition
 * supersedes it inside its transaction, which is the last command of the
 * callback: a write from outside after the transition document was saved makes
 * exactly that command conflict.
 */
const seedOlderPendingNotification = async (
  ticketId: Types.ObjectId,
  eventId = 'rescheduled:0',
) => {
  return SupportMeetingNotification.create({
    ticketId,
    eventId,
    revision: 0,
    type: eventId.startsWith('rescheduled')
      ? 'rescheduled'
      : eventId.startsWith('cancelled')
        ? 'cancelled'
        : 'confirmed',
    status: 'pending',
    attempts: 1,
    claimedAt: new Date(Date.now() - 60_000),
  });
};

const postSaveConflictGate = (
  ticketId: Types.ObjectId,
  notificationRowId: Types.ObjectId,
) => ({
  ticketId: String(ticketId),
  notificationRowId,
  fired: false,
  calls: 0,
});

/**
 * Models the concurrent committed writer (the notification dispatch fence)
 * that advanced the ticket `__v` while the aborted attempt was retried. A
 * document-save replay without Mongoose change tracking then matched that
 * bumped row and reported success while writing nothing. The revision-scoped
 * transition update used today is not affected: this hook only runs if the
 * implementation calls `save()` on the captured document.
 */
const simulateConcurrentVersionBumpOnReplaySave = (ticket: any) => {
  const originalSave = ticket.save.bind(ticket);
  let saves = 0;
  ticket.save = async (options?: any) => {
    saves += 1;
    if (saves === 2) {
      await mongoose.connection.collection('supporttickets').updateOne(
        { _id: ticket._id },
        { $inc: { __v: 1 } },
      );
    }
    return originalSave(options);
  };
};

const clearCollections = async () => {
  await Promise.all([
    SupportTicket.deleteMany({}),
    SupportTicketInternalNote.deleteMany({}),
    SupportMeetingNotification.deleteMany({}),
    AccountDataGuard.deleteMany({}),
    CalendarReservation.deleteMany({}),
    Meeting.deleteMany({}),
    MeetingRequest.deleteMany({}),
    Project.deleteMany({}),
    User.deleteMany({}),
    Booking.deleteMany({}),
    mongoose.connection.collection('replayconflictlocks').deleteMany({}),
  ]);
};

describeDb('real Mongo calendar and meeting concurrency', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, {
      dbName: `fixera_support_it_${Date.now()}`,
      appName: commitRetryAppName,
    });
    try {
      // The regression below needs a disposable server started with
      // enableTestCommands=1 so commitTransaction can fail deterministically.
      await mongoose.connection.db!.admin().command({
        configureFailPoint: 'failCommand',
        mode: 'off',
      });
      commitFailpointsAvailable = true;
    } catch {
      commitFailpointsAvailable = false;
    }
    await Promise.all([
      SupportTicket.createIndexes(),
      SupportTicketInternalNote.createIndexes(),
      SupportMeetingNotification.createIndexes(),
      AccountDataGuard.createIndexes(),
      CalendarReservation.createIndexes(),
      Meeting.createIndexes(),
      MeetingRequest.createIndexes(),
      User.createIndexes(),
      Booking.createIndexes(),
    ]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    raceGates.dispatch = null;
    raceGates.supersede = null;
    raceGates.release = null;
    raceGates.busy = null;
    raceGates.postSaveConflict = null;
    sendConfirmed.mockResolvedValue(true);
    sendLinkUpdated.mockResolvedValue(true);
    sendRescheduled.mockResolvedValue(true);
    sendCancelled.mockResolvedValue(true);
    await clearCollections();
    await ensureFenceUser();
  });

  afterEach(async () => {
    await clearCommitFailure().catch(() => undefined);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('serializes support and booking reservations in both request orders', async () => {
    const supportId = new Types.ObjectId();
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: supportId,
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-04T09:00:00.000Z'),
        endAt: new Date('2030-11-04T09:30:00.000Z'),
      }),
    });
    await expect(reserveCalendarKeys({
      sourceType: 'booking',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-04T09:15:00.000Z'),
        endAt: new Date('2030-11-04T09:45:00.000Z'),
      }),
    })).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });

    await CalendarReservation.deleteMany({});
    await reserveCalendarKeys({
      sourceType: 'booking',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-04T10:00:00.000Z'),
        endAt: new Date('2030-11-04T10:30:00.000Z'),
      }),
    });
    await expect(reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-04T10:15:00.000Z'),
        endAt: new Date('2030-11-04T10:45:00.000Z'),
      }),
    })).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
  });

  it('allows only one of two concurrent support/booking writers to take the same buckets', async () => {
    const results = await Promise.allSettled([
      reserveCalendarKeys({
        sourceType: 'support',
        sourceId: new Types.ObjectId(),
        keys: buildCalendarReservationKeysForInterval({
          role: 'professional',
          userId: professionalId,
          startAt: new Date('2030-11-04T11:00:00.000Z'),
          endAt: new Date('2030-11-04T11:30:00.000Z'),
        }),
      }),
      reserveCalendarKeys({
        sourceType: 'booking',
        sourceId: new Types.ObjectId(),
        keys: buildCalendarReservationKeysForInterval({
          role: 'professional',
          userId: professionalId,
          startAt: new Date('2030-11-04T11:15:00.000Z'),
          endAt: new Date('2030-11-04T11:45:00.000Z'),
        }),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
  });

  it('finds support, Meeting and legacy-request conflicts only for the assigned member and uses the source timezone', async () => {
    await User.collection.updateOne(
      { _id: professionalId },
      {
        $set: {
          name: 'Piet',
          email: 'piet@example.com',
          role: 'professional',
          timeZone: 'Europe/Brussels',
          businessInfo: { timezone: 'Europe/Brussels' },
        },
      },
      { upsert: true },
    );
    await User.collection.insertOne({
      _id: otherUserId,
      name: 'Other',
      email: 'other@example.com',
      role: 'employee',
      timeZone: 'Europe/Brussels',
    });
    await Meeting.create({
      projectId: '507f1f77bcf86cd799439099',
      professionalId,
      meetingType: 'team',
      title: 'Project meeting',
      scheduledDate: new Date('2030-11-04T00:00:00.000Z'),
      startTime: '10:00',
      endTime: '11:00',
      duration: 60,
      attendees: [{ userId: professionalId.toString(), name: 'Piet', role: 'professional', status: 'accepted' }],
      status: 'scheduled',
      createdBy: professionalId.toString(),
    });
    await createMeetingTicket({
      meeting: {
        status: 'pending',
        scheduledAt: new Date('2030-11-04T13:00:00.000Z'),
        slotKeys: undefined,
      },
    });
    await MeetingRequest.create({
      userId: professionalId,
      topic: 'Legacy',
      preferredTimes: 'afternoon',
      durationMinutes: 30,
      status: 'scheduled',
      scheduledAt: new Date('2030-11-04T15:00:00.000Z'),
    });

    const meetingConflict = await findBookingCalendarConflicts({
      members: [professionalId],
      startAt: new Date('2030-11-04T09:30:00.000Z'),
      endAt: new Date('2030-11-04T10:30:00.000Z'),
    });
    expect(meetingConflict.some((conflict) => conflict.source === 'meeting')).toBe(true);

    const unrelated = await findBookingCalendarConflicts({
      members: [otherUserId],
      startAt: new Date('2030-11-04T09:30:00.000Z'),
      endAt: new Date('2030-11-04T10:30:00.000Z'),
    });
    expect(unrelated).toEqual([]);

    const supportConflict = await findBookingCalendarConflicts({
      members: [professionalId],
      startAt: new Date('2030-11-04T12:30:00.000Z'),
      endAt: new Date('2030-11-04T13:30:00.000Z'),
    });
    expect(supportConflict.some((conflict) => conflict.source === 'support')).toBe(true);

    const legacyConflict = await findBookingCalendarConflicts({
      members: [professionalId],
      startAt: new Date('2030-11-04T14:30:00.000Z'),
      endAt: new Date('2030-11-04T15:30:00.000Z'),
    });
    expect(legacyConflict.some((conflict) => conflict.source === 'meeting_request')).toBe(true);

    const busy = await buildProfessionalBusyIntervals(
      professionalId,
      'America/New_York',
      undefined,
      undefined,
      'Europe/Brussels',
    );
    expect(busy).toContainEqual({
      start: new Date('2030-11-04T09:00:00.000Z').getTime(),
      end: new Date('2030-11-04T10:00:00.000Z').getTime(),
    });
    expect(meetingIntervalInTimeZone(
      new Date('2030-11-04T00:00:00.000Z'),
      '10:00',
      '11:00',
      'Europe/Brussels',
    )).toEqual({
      start: new Date('2030-11-04T09:00:00.000Z').getTime(),
      end: new Date('2030-11-04T10:00:00.000Z').getTime(),
    });
  });

  it('makes the project schedule engine reject a window occupied by a support meeting', async () => {
    await User.collection.updateOne(
      { _id: professionalId },
      {
        $set: {
          name: 'Piet',
          email: 'piet@example.com',
          role: 'professional',
          timeZone: 'Europe/Brussels',
          businessInfo: { timezone: 'Europe/Brussels' },
        },
      },
      { upsert: true },
    );
    const projectId = new Types.ObjectId('507f1f77bcf86cd799439041');
    await Project.collection.insertOne({
      _id: projectId,
      professionalId,
      status: 'published',
      title: 'Bathroom',
      category: 'Renovation',
      resources: [professionalId.toString()],
      executionDuration: { value: 2, unit: 'hours' },
    });
    await createMeetingTicket({
      meeting: {
        status: 'pending',
        scheduledAt: new Date('2030-11-04T09:00:00.000Z'),
        slotKeys: undefined,
      },
    });

    const blocked = await validateProjectScheduleSelection({
      projectId: String(projectId),
      startDate: '2030-11-04',
      startTime: '09:00',
    });
    expect(blocked.valid).toBe(false);

    await SupportTicket.deleteMany({ userId: professionalId });
    const free = await validateProjectScheduleSelection({
      projectId: String(projectId),
      startDate: '2030-11-04',
      startTime: '09:00',
    });
    expect(free.valid).toBe(true);
  });

  it('moves a booking reservation set atomically and releases the old window', async () => {
    const bookingId = new Types.ObjectId();
    const booking = {
      _id: bookingId,
      professional: professionalId,
      assignedTeamMembers: [],
      scheduledStartDate: new Date('2030-11-04T16:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2030-11-04T16:30:00.000Z'),
    };
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-04T16:15:00.000Z'),
        endAt: new Date('2030-11-04T16:45:00.000Z'),
      }),
    });
    await expect(withCalendarTransaction(async (session) => {
      await replaceBookingCalendar(booking, session);
      return true;
    })).rejects.toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
    });
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(0);

    await CalendarReservation.deleteMany({});
    await withCalendarTransaction(async (session) => {
      await replaceBookingCalendar(booking, session);
      return true;
    });
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(2);

    const moved = {
      ...booking,
      scheduledStartDate: new Date('2030-11-04T17:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2030-11-04T17:30:00.000Z'),
    };
    await withCalendarTransaction(async (session) => {
      await replaceBookingCalendar(moved, session);
      return true;
    });
    const keys = await CalendarReservation.find({ sourceId: bookingId }).select('key').lean();
    expect(keys).toHaveLength(2);
    expect(keys.map((entry: any) => entry.key)).toEqual([`professional:${professionalId}:2030-11-04T17:00:00.000Z`, `professional:${professionalId}:2030-11-04T17:15:00.000Z`]);

    await releaseBookingCalendar(bookingId);
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(0);
  });

  it('sends only one confirmation for two concurrent same-link requests', async () => {
    const record = await createMeetingTicket();
    const first = await SupportTicket.findById(record._id);
    const second = await SupportTicket.findById(record._id);

    const results = await Promise.allSettled([
      setSupportMeetingLink({
        ticket: first!,
        adminId,
        owner,
        meetingLink: 'https://meet.example/room?p=123',
      }),
      setSupportMeetingLink({
        ticket: second!,
        adminId,
        owner,
        meetingLink: 'https://meet.example/room?p=123',
      }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    const stored = await SupportTicket.findById(record._id);
    expect(stored?.meeting?.status).toBe('scheduled');
    expect(stored?.meeting?.meetingLink).toBe('https://meet.example/room?p=123');
    expect(stored?.meeting?.linkEmailSentAt).toBeInstanceOf(Date);
    expect(await SupportMeetingNotification.countDocuments({
      ticketId: record._id,
      status: 'sent',
    })).toBe(1);
  });

  it('serializes set_link and cancel into one coherent notification order', async () => {
    const record = await createMeetingTicket();
    const linkDoc = await SupportTicket.findById(record._id);
    const cancelDoc = await SupportTicket.findById(record._id);

    const results = await Promise.allSettled([
      setSupportMeetingLink({
        ticket: linkDoc!,
        adminId,
        owner,
        meetingLink: 'https://meet.example/room',
      }),
      cancelSupportMeeting({
        ticket: cancelDoc!,
        actorId: adminId,
        actorRole: 'admin',
        owner,
        allowPast: true,
      }),
    ]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const stored = await SupportTicket.findById(record._id);
    expect(stored?.meeting?.status).toBe('cancelled');
    expect(sendCancelled).toHaveBeenCalledTimes(1);
    expect(sendConfirmed.mock.calls.length).toBeLessThanOrEqual(1);
    // The two valid linearizations are:
    // 1) cancellation commits first -> only the cancellation mail is sent;
    // 2) the confirmation hand-off starts first -> confirmation then the
    //    still-required cancellation. A cancellation is never followed by a
    //    newly initiated confirmation.
    if (sendConfirmed.mock.calls.length === 1) {
      expect(sendConfirmed.mock.invocationCallOrder[0])
        .toBeLessThan(sendCancelled.mock.invocationCallOrder[0]);
    }
  });

  it('commits a set_link transition the driver replays after a post-save conflict', async () => {
    const record = await createMeetingTicket();
    const older = await seedOlderPendingNotification(record._id, 'confirmed:0');
    const gate = postSaveConflictGate(record._id, older._id);
    raceGates.postSaveConflict = gate;
    const stale = await SupportTicket.findById(record._id);
    simulateConcurrentVersionBumpOnReplaySave(stale);

    const result = await setSupportMeetingLink({
      ticket: stale!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/replayed',
    });

    // The transition write happened, the next command conflicted, and the
    // driver replayed the callback. The concurrent version bump made the old
    // empty-update document save match without writing the link; the
    // revision-scoped conditional update still matches the rolled-back
    // revision, so the link transition is committed.
    expect(gate).toMatchObject({ fired: true, calls: 2 });
    expect(result.unchanged).toBe(false);
    expect(result.emailSent).toBe(true);
    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.status).toBe('scheduled');
    expect(stored?.meeting?.meetingLink).toBe('https://meet.example/replayed');
    expect(stored?.meeting?.revision).toBe(1);
    expect(stored?.meeting?.confirmationEventId).toBe('confirmed:1');
    expect(stored?.meeting?.slotKeys).toEqual(buildSupportSlotKeysForTest(professionalId));
    expect(stored?.status).toBe('open');
    expect((await SupportMeetingNotification.findById(older._id).lean())?.status).toBe('superseded');
    expect((await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'confirmed:1',
    }).lean())?.status).toBe('sent');
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    expect(sendLinkUpdated).not.toHaveBeenCalled();
  });

  it('commits a cancellation the driver replays after a post-save conflict', async () => {
    const record = await createMeetingTicket({
      meeting: {
        status: 'scheduled',
        meetingLink: 'https://meet.example/room',
        revision: 1,
        confirmationEventId: 'confirmed:1',
        linkEmailSentAt: new Date('2030-11-01T08:00:00.000Z'),
      },
    });
    await reserveSupportKeysForTest(record._id, professionalId);
    const older = await seedOlderPendingNotification(record._id, 'rescheduled:0');
    const gate = postSaveConflictGate(record._id, older._id);
    raceGates.postSaveConflict = gate;
    const stale = await SupportTicket.findById(record._id);
    const versionBefore = Number((stale as any).__v || 0);
    simulateConcurrentVersionBumpOnReplaySave(stale);

    const result = await cancelSupportMeeting({
      ticket: stale!,
      actorId: adminId,
      actorRole: 'admin',
      owner,
      allowPast: true,
    });

    expect(gate).toMatchObject({ fired: true, calls: 2 });
    expect(result.emailSent).toBe(true);
    expect(result.ticket.meeting?.status).toBe('cancelled');
    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.status).toBe('cancelled');
    expect(stored?.meeting?.revision).toBe(2);
    expect(stored?.meeting?.cancelledEventId).toBe('cancelled:2');
    expect(stored?.meeting?.slotKeys).toBeUndefined();
    expect(stored?.status).toBe('closed');
    // The replayed conditional write and the notification dispatch fence only;
    // the rolled-back attempt must not add another version.
    expect(Number((stored as any).__v)).toBe(versionBefore + 2);
    expect(await CalendarReservation.countDocuments({ sourceId: record._id })).toBe(0);
    expect((await SupportMeetingNotification.findById(older._id).lean())?.status).toBe('superseded');
    expect((await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'cancelled:2',
    }).lean())?.status).toBe('sent');
    expect(sendCancelled).toHaveBeenCalledTimes(1);
    expect(sendConfirmed).not.toHaveBeenCalled();
  });

  it('commits a reschedule the driver replays after a post-save conflict', async () => {
    const record = await createMeetingTicket();
    await reserveSupportKeysForTest(record._id, professionalId);
    const older = await seedOlderPendingNotification(record._id, 'confirmed:0');
    const gate = postSaveConflictGate(record._id, older._id);
    raceGates.postSaveConflict = gate;
    const stale = await SupportTicket.findById(record._id);

    const result = await rescheduleSupportMeeting({
      ticket: stale!,
      professional: { _id: professionalId, timeZone: 'Europe/Brussels' },
      start: laterStart,
      timeZone: 'Europe/Brussels',
      owner,
    });

    expect(gate).toMatchObject({ fired: true, calls: 2 });
    expect(result.emailSent).toBe(true);
    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.scheduledAt?.toISOString()).toBe(laterStart.toISOString());
    expect(stored?.meeting?.timeZone).toBe('Europe/Brussels');
    expect(stored?.meeting?.status).toBe('pending');
    expect(stored?.meeting?.revision).toBe(1);
    expect(stored?.meeting?.rescheduledEventId).toBe('rescheduled:1');
    expect(stored?.meeting?.slotKeys).toEqual([
      `admin:${adminId}:${laterStart.toISOString()}`,
      `professional:${professionalId}:${laterStart.toISOString()}`,
    ]);
    const reservations = await CalendarReservation.find({ sourceId: record._id })
      .select('key startAt')
      .lean();
    expect(reservations).toHaveLength(4);
    expect(new Set(reservations.map((row: any) => row.startAt.toISOString()))).toEqual(new Set([
      laterStart.toISOString(),
      new Date(laterStart.getTime() + 15 * 60 * 1000).toISOString(),
    ]));
    expect((await SupportMeetingNotification.findById(older._id).lean())?.status).toBe('superseded');
    expect((await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'rescheduled:1',
    }).lean())?.status).toBe('sent');
    expect(sendRescheduled).toHaveBeenCalledTimes(1);
  });

  it('commits a completion the driver replays after a post-save conflict', async () => {
    const record = await createMeetingTicket({
      meeting: {
        status: 'scheduled',
        meetingLink: 'https://meet.example/room',
        revision: 1,
        confirmationEventId: 'confirmed:1',
      },
    });
    await reserveSupportKeysForTest(record._id, professionalId);
    const older = await seedOlderPendingNotification(record._id, 'confirmed:0');
    const gate = postSaveConflictGate(record._id, older._id);
    raceGates.postSaveConflict = gate;
    const stale = await SupportTicket.findById(record._id);
    const versionBefore = Number((stale as any).__v || 0);
    simulateConcurrentVersionBumpOnReplaySave(stale);

    await completeSupportMeeting({ ticket: stale!, actorId: adminId });

    expect(gate).toMatchObject({ fired: true, calls: 2 });
    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.status).toBe('completed');
    expect(stored?.meeting?.revision).toBe(2);
    expect(stored?.meeting?.completedAt).toBeInstanceOf(Date);
    expect(stored?.meeting?.slotKeys).toBeUndefined();
    expect(stored?.status).toBe('resolved');
    // The replayed conditional write only; the rolled-back attempt must not
    // add another version.
    expect(Number((stored as any).__v)).toBe(versionBefore + 1);
    expect(await CalendarReservation.countDocuments({ sourceId: record._id })).toBe(0);
    expect((await SupportMeetingNotification.findById(older._id).lean())?.status).toBe('superseded');
    expect(sendCancelled).not.toHaveBeenCalled();
    expect(sendConfirmed).not.toHaveBeenCalled();
  });

  it('persists a captured booking document through a post-save replay in the shared transaction', async () => {
    const bookingId = new Types.ObjectId();
    const windowStart = new Date('2030-11-04T17:00:00.000Z');
    const windowEnd = new Date('2030-11-04T17:30:00.000Z');
    await Booking.collection.insertOne({
      _id: bookingId,
      bookingNumber: 'BK-2030-REPLAY',
      bookingType: 'project',
      customer: otherUserId,
      professional: professionalId,
      status: 'booked',
      scheduledStartDate: new Date('2030-11-04T16:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2030-11-04T16:30:00.000Z'),
      scheduledBufferEndDate: new Date('2030-11-04T16:30:00.000Z'),
      assignedTeamMembers: [],
      statusHistory: [],
      location: { type: 'Point', coordinates: [0, 0] },
      __v: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const booking = await Booking.findById(bookingId);
    const versionBefore = Number((booking as any).__v || 0);
    const lockId = new Types.ObjectId();
    const locks = mongoose.connection.collection('replayconflictlocks');
    await locks.insertOne({ _id: lockId, seq: 0 });
    const candidate = {
      _id: bookingId,
      professional: professionalId,
      assignedTeamMembers: [],
      resourcePlan: [],
      scheduledStartDate: windowStart,
      scheduledExecutionEndDate: windowEnd,
      scheduledBufferEndDate: windowEnd,
    };

    // Booking writers prepare the document before the transaction; the
    // additive history entry must exist once even when the save is replayed.
    booking!.status = 'in_progress';
    booking!.scheduledStartDate = windowStart;
    booking!.scheduledExecutionEndDate = windowEnd;
    booking!.scheduledBufferEndDate = windowEnd;
    booking!.statusHistory = booking!.statusHistory || [];
    booking!.statusHistory.push({
      status: 'in_progress',
      timestamp: new Date('2030-11-04T12:00:00.000Z'),
      updatedBy: otherUserId,
      note: 'Execution extended',
    } as any);

    let attempts = 0;
    await withCalendarTransaction(async (session) => {
      attempts += 1;
      await replaceBookingCalendar(candidate as any, session);
      await booking!.save({ session, validateModifiedOnly: true });
      if (attempts === 1) {
        await locks.updateOne({ _id: lockId }, { $set: { seq: 1 } });
      }
      await locks.updateOne({ _id: lockId }, { $set: { seq: 2 } }, { session });
      return true;
    });

    expect(attempts).toBe(2);
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('in_progress');
    expect(stored?.scheduledStartDate?.toISOString()).toBe(windowStart.toISOString());
    expect(stored?.scheduledExecutionEndDate?.toISOString()).toBe(windowEnd.toISOString());
    expect(Number((stored as any).__v)).toBe(versionBefore + 1);
    expect(stored?.statusHistory).toHaveLength(1);
    expect(stored?.statusHistory?.[0]?.note).toBe('Execution extended');
    const keys = await CalendarReservation.find({ sourceId: bookingId }).select('key startAt').lean();
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((row: any) => row.startAt.toISOString()))).toEqual(new Set([
      windowStart.toISOString(),
      new Date(windowStart.getTime() + 15 * 60 * 1000).toISOString(),
    ]));
  });

  it('persists a normal Meeting cancellation when commitTransaction fails transiently after the callback', async (context) => {
    if (!commitFailpointsAvailable) {
      context.skip('MongoDB test commands (enableTestCommands=1) are not enabled');
    }
    const meeting = await Meeting.create({
      projectId: new Types.ObjectId().toString(),
      professionalId,
      meetingType: 'team',
      title: 'Commit replay meeting',
      scheduledDate: new Date('2030-12-02T00:00:00.000Z'),
      startTime: '09:00',
      endTime: '10:00',
      duration: 60,
      attendees: [],
      status: 'scheduled',
      createdBy: professionalId.toString(),
    });
    await reserveCalendarKeys({
      sourceType: 'meeting',
      sourceId: meeting._id,
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-12-02T09:00:00.000Z'),
        endAt: new Date('2030-12-02T10:00:00.000Z'),
      }),
    });
    expect(await CalendarReservation.countDocuments({ sourceType: 'meeting', sourceId: meeting._id })).toBe(4);

    const saveSpy = vi.spyOn(Meeting.prototype, 'save');
    let saveCalls = 0;
    try {
      await ensureFenceUser();
      await setCommitFailure(1, ['TransientTransactionError']);
      const res = mockRes();
      await cancelMeeting({
        params: { meetingId: String(meeting._id) },
        body: { cancellationReason: 'No longer needed' },
        user: { professionalId },
      } as any, res as any);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      saveCalls = saveSpy.mock.calls.length;
    } finally {
      saveSpy.mockRestore();
      await clearCommitFailure();
    }

    // One save from the first attempt and one from the replayed callback.
    expect(saveCalls).toBe(2);
    const stored = await Meeting.findById(meeting._id).lean();
    expect(stored?.status).toBe('cancelled');
    expect(stored?.cancellationReason).toBe('No longer needed');
    expect(stored?.cancelledBy).toBe(professionalId.toString());
    expect(stored?.cancelledAt).toBeInstanceOf(Date);
    expect(await CalendarReservation.countDocuments({ sourceType: 'meeting', sourceId: meeting._id })).toBe(0);
  });

  it('persists a normal booking extension and one history entry when commitTransaction fails transiently', async (context) => {
    if (!commitFailpointsAvailable) {
      context.skip('MongoDB test commands (enableTestCommands=1) are not enabled');
    }
    await User.collection.updateOne(
      { _id: professionalId },
      {
        $set: {
          name: 'Piet',
          email: 'piet@example.com',
          role: 'professional',
        },
      },
      { upsert: true },
    );
    const bookingId = new Types.ObjectId();
    const originalStart = new Date('2030-12-03T09:00:00.000Z');
    const originalEnd = new Date('2030-12-03T10:00:00.000Z');
    const extendedEnd = new Date('2030-12-03T12:00:00.000Z');
    await Booking.collection.insertOne({
      _id: bookingId,
      bookingNumber: 'BK-COMMIT-REPLAY',
      bookingType: 'professional',
      customer: otherUserId,
      professional: professionalId,
      status: 'in_progress',
      quote: { amount: 100, currency: 'EUR' },
      rfqData: { serviceType: 'Renovation', description: 'Bathroom work' },
      vatDecision: { action: 'standard_rate', standardRate: 21, appliedRate: 21 },
      location: { type: 'Point', coordinates: [0, 0] },
      scheduledStartDate: originalStart,
      scheduledExecutionEndDate: originalEnd,
      assignedTeamMembers: [],
      resourcePlan: [],
      statusHistory: [],
      __v: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await reserveCalendarKeys({
      sourceType: 'booking',
      sourceId: bookingId,
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: originalStart,
        endAt: originalEnd,
      }),
    });

    const saveSpy = vi.spyOn(Booking.prototype, 'save');
    let saveCalls = 0;
    try {
      await setCommitFailure(1, ['TransientTransactionError']);
      const res = mockRes();
      await extendBookingExecution({
        params: { bookingId: String(bookingId) },
        body: {
          newExecutionEndDate: extendedEnd.toISOString(),
          note: 'Extra work',
        },
        user: { _id: professionalId, role: 'professional' },
      } as any, res as any);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      saveCalls = saveSpy.mock.calls.length;
    } finally {
      saveSpy.mockRestore();
      await clearCommitFailure();
    }

    expect(saveCalls).toBe(2);
    const stored = await Booking.findById(bookingId).lean();
    expect(stored?.status).toBe('in_progress');
    expect(stored?.scheduledExecutionEndDate?.toISOString()).toBe(extendedEnd.toISOString());
    expect(stored?.statusHistory).toHaveLength(1);
    expect(stored?.statusHistory?.[0]?.note).toBe('Execution extended: Extra work');
    const keys = await CalendarReservation.find({ sourceType: 'booking', sourceId: bookingId })
      .select('key startAt')
      .lean();
    expect(keys).toHaveLength(12);
    expect(keys.every((row: any) => {
      const start = row.startAt.getTime();
      return start >= originalStart.getTime() && start < extendedEnd.getTime();
    })).toBe(true);
  });

  it('retries only the commit for UnknownTransactionCommitResult without re-running the callback', async (context) => {
    if (!commitFailpointsAvailable) {
      context.skip('MongoDB test commands (enableTestCommands=1) are not enabled');
    }
    const meeting = await Meeting.create({
      projectId: new Types.ObjectId().toString(),
      professionalId,
      meetingType: 'team',
      title: 'Unknown commit result meeting',
      scheduledDate: new Date('2030-12-04T00:00:00.000Z'),
      startTime: '09:00',
      endTime: '10:00',
      duration: 60,
      attendees: [],
      status: 'scheduled',
      createdBy: professionalId.toString(),
    });
    await reserveCalendarKeys({
      sourceType: 'meeting',
      sourceId: meeting._id,
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-12-04T09:00:00.000Z'),
        endAt: new Date('2030-12-04T10:00:00.000Z'),
      }),
    });

    const saveSpy = vi.spyOn(Meeting.prototype, 'save');
    let saveCalls = 0;
    try {
      await ensureFenceUser();
      await setCommitFailure(1, ['UnknownTransactionCommitResult']);
      const res = mockRes();
      await cancelMeeting({
        params: { meetingId: String(meeting._id) },
        body: { cancellationReason: 'Commit retry' },
        user: { professionalId },
      } as any, res as any);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      saveCalls = saveSpy.mock.calls.length;
    } finally {
      saveSpy.mockRestore();
      await clearCommitFailure();
    }

    expect(saveCalls).toBe(1);
    const stored = await Meeting.findById(meeting._id).lean();
    expect(stored?.status).toBe('cancelled');
    expect(stored?.cancellationReason).toBe('Commit retry');
    expect(await CalendarReservation.countDocuments({ sourceType: 'meeting', sourceId: meeting._id })).toBe(0);
  });

  it('persists a saved document and a new document when the driver replays after a post-save conflict', async () => {
    const record = await createMeetingTicket();
    const ticket = await SupportTicket.findById(record._id);
    const versionBefore = Number((ticket as any).__v || 0);
    const newTicketId = new Types.ObjectId();
    const lockId = new Types.ObjectId();
    const locks = mongoose.connection.collection('replayconflictlocks');
    await locks.insertOne({ _id: lockId, seq: 0 });

    let attempts = 0;
    const result = await withCalendarTransaction(async (session) => {
      attempts += 1;
      ticket!.meeting!.status = 'scheduled';
      ticket!.meeting!.meetingLink = 'https://meet.example/replayed';
      ticket!.meeting!.revision = 1;
      ticket!.meeting!.slotKeys = buildSupportSlotKeysForTest(professionalId);
      await ticket!.save({ session });
      await SupportTicket.create([{
        _id: newTicketId,
        userId: professionalId,
        kind: 'meeting',
        subject: 'Replayed create',
        description: 'Created once',
        reason: 'technical_problem',
        userType: 'professional',
        locale: 'en',
        status: 'open',
        meeting: {
          status: 'pending',
          scheduledAt: laterStart,
          durationMinutes: 30,
          timeZone: 'Europe/Brussels',
          adminId,
        },
      }], { session });
      if (attempts === 1) {
        // A committed write from another client after this attempt saved the
        // ticket. The next transactional command conflicts and the driver
        // replays the whole callback.
        await locks.updateOne({ _id: lockId }, { $set: { seq: 1 } });
      }
      await locks.updateOne({ _id: lockId }, { $set: { seq: 2 } }, { session });
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(attempts).toBe(2);

    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.status).toBe('scheduled');
    expect(stored?.meeting?.meetingLink).toBe('https://meet.example/replayed');
    expect(stored?.meeting?.revision).toBe(1);
    expect(stored?.meeting?.slotKeys).toEqual(buildSupportSlotKeysForTest(professionalId));
    expect(Number((stored as any).__v)).toBe(versionBefore + 1);
    // The create that was rolled back with the aborted attempt exists once.
    expect(await SupportTicket.countDocuments({ _id: newTicketId })).toBe(1);
    const lock = await locks.findOne({ _id: lockId });
    expect(lock?.seq).toBe(2);
  });

  it('sends only one cancellation for two concurrent cancels and can retry a failed cancellation later', async () => {
    const record = await createMeetingTicket();
    sendCancelled.mockResolvedValueOnce(false);
    const first = await SupportTicket.findById(record._id);
    const second = await SupportTicket.findById(record._id);

    await Promise.allSettled([
      cancelSupportMeeting({ ticket: first!, actorId: adminId, actorRole: 'admin', owner, allowPast: true }),
      cancelSupportMeeting({ ticket: second!, actorId: adminId, actorRole: 'admin', owner, allowPast: true }),
    ]);
    expect(sendCancelled.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(await SupportTicket.countDocuments({ _id: record._id, status: 'closed' })).toBe(1);

    sendCancelled.mockClear();
    sendCancelled.mockResolvedValue(true);
    const retryDoc = await SupportTicket.findById(record._id);
    const retry = await cancelSupportMeeting({
      ticket: retryDoc!,
      actorId: adminId,
      actorRole: 'admin',
      owner,
      allowPast: true,
    });
    expect(retry.alreadyCancelled).toBe(true);
    expect(retry.emailAttempted).toBe(true);
    expect(retry.emailSent).toBe(true);
    expect(sendCancelled).toHaveBeenCalledTimes(1);
  });

  it('retries the pending link-updated notification, never the confirmation template', async () => {
    const record = await createMeetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        meetingLink: 'https://meet.example/old',
        linkEmailSentAt: new Date('2030-11-01T08:00:01Z'),
      },
    });
    sendLinkUpdated.mockResolvedValueOnce(false);
    const first = await SupportTicket.findById(record._id);
    const firstResult = await setSupportMeetingLink({
      ticket: first!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/new',
    });
    expect(firstResult.emailSent).toBe(false);
    const afterFailure = await SupportTicket.findById(record._id);
    expect(afterFailure?.meeting?.meetingLink).toBe('https://meet.example/new');
    expect(afterFailure?.meeting?.linkEmailSentAt).toBeInstanceOf(Date);

    sendLinkUpdated.mockResolvedValue(true);
    const retryDoc = await SupportTicket.findById(record._id);
    const retry = await setSupportMeetingLink({
      ticket: retryDoc!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/new',
    });
    expect(retry.emailSent).toBe(true);
    expect(sendLinkUpdated).toHaveBeenCalledTimes(2);
    expect(sendConfirmed).not.toHaveBeenCalled();
    const stored = await SupportTicket.findById(record._id);
    expect(stored?.meeting?.linkEmailSentAt?.toISOString()).toBe('2030-11-01T08:00:01.000Z');
  });

  it('reschedules through replacement reservations and retries only the reschedule event', async () => {
    const record = await createMeetingTicket();
    const first = await SupportTicket.findById(record._id);
    sendRescheduled.mockResolvedValueOnce(false);
    const firstResult = await rescheduleSupportMeeting({
      ticket: first!,
      professional: { _id: professionalId, timeZone: 'Europe/Brussels' },
      start: laterStart,
      timeZone: 'Europe/Brussels',
      owner,
    });
    expect(firstResult.emailSent).toBe(false);
    expect(await CalendarReservation.countDocuments({
      sourceType: 'support',
      sourceId: record._id,
    })).toBe(4);

    sendRescheduled.mockResolvedValue(true);
    const retryDoc = await SupportTicket.findById(record._id);
    const retry = await rescheduleSupportMeeting({
      ticket: retryDoc!,
      professional: { _id: professionalId, timeZone: 'Europe/Brussels' },
      start: laterStart,
      timeZone: 'Europe/Brussels',
      owner,
    });
    expect(retry.emailSent).toBe(true);
    expect(sendRescheduled).toHaveBeenCalledTimes(2);
    expect(sendConfirmed).not.toHaveBeenCalled();
    expect(await SupportMeetingNotification.countDocuments({
      ticketId: record._id,
      type: 'rescheduled',
      status: 'sent',
    })).toBe(1);
  });

  it('completes only a confirmed meeting and releases reservations exactly once', async () => {
    const record = await createMeetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        meetingLink: 'https://meet.example/room',
      },
    });
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: record._id,
      keys: buildCalendarReservationKeysForInterval({
        role: 'admin',
        userId: adminId,
        startAt: meetingStart,
        endAt: new Date(meetingStart.getTime() + 30 * 60 * 1000),
      }),
    });
    const first = await SupportTicket.findById(record._id);
    const second = await SupportTicket.findById(record._id);
    const results = await Promise.allSettled([
      completeSupportMeeting({ ticket: first!, actorId: adminId }),
      completeSupportMeeting({ ticket: second!, actorId: adminId }),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    const stored = await SupportTicket.findById(record._id);
    expect(stored?.meeting?.status).toBe('completed');
    expect(stored?.meeting?.slotKeys).toBeUndefined();
    expect(await CalendarReservation.countDocuments({ sourceId: record._id })).toBe(0);
  });

  it('finds a pre-feature booking on the professional even when it has no reservation keys', async () => {
    const existingId = new Types.ObjectId();
    await Booking.collection.insertOne({
      _id: existingId,
      bookingNumber: 'BK-2030-800001',
      bookingType: 'project',
      customer: otherUserId,
      professional: professionalId,
      status: 'in_progress',
      scheduledStartDate: new Date('2030-11-04T09:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2030-11-04T12:00:00.000Z'),
      scheduledBufferEndDate: new Date('2030-11-04T12:00:00.000Z'),
      assignedTeamMembers: [],
      location: { type: 'Point', coordinates: [0, 0] },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const conflicts = await findTeamConflicts(
      String(new Types.ObjectId()),
      [professionalId],
      new Date('2030-11-04T11:00:00.000Z'),
      new Date('2030-11-04T13:00:00.000Z'),
    );
    expect(conflicts).toEqual([
      expect.objectContaining({
        bookingId: String(existingId),
        source: 'booking',
        teamMemberIds: [String(professionalId)],
      }),
    ]);
  });

  it('reserves only planned days and stays consistent with booked-day availability', async () => {
    const bookingId = new Types.ObjectId();
    const employeeId = new Types.ObjectId('507f1f77bcf86cd799439013');
    const booking = {
      _id: bookingId,
      professional: professionalId,
      assignedTeamMembers: [employeeId],
      resourcePlan: [
        { resourceId: professionalId, days: [new Date('2030-11-04T00:00:00.000Z')] },
        { resourceId: employeeId, days: [new Date('2030-11-04T00:00:00.000Z')] },
      ],
      scheduledStartDate: new Date('2030-11-04T08:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2030-11-07T17:00:00.000Z'),
      scheduledBufferEndDate: new Date('2030-11-07T17:00:00.000Z'),
    };
    await Booking.collection.insertOne({
      _id: bookingId,
      bookingNumber: 'BK-2030-900001',
      bookingType: 'project',
      customer: otherUserId,
      professional: professionalId,
      status: 'booked',
      scheduledStartDate: booking.scheduledStartDate,
      scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
      scheduledBufferEndDate: booking.scheduledBufferEndDate,
      resourcePlan: booking.resourcePlan,
      assignedTeamMembers: [employeeId],
      location: { type: 'Point', coordinates: [0, 0] },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await withCalendarTransaction(async (session) => {
      await replaceBookingCalendar(booking, session);
      return true;
    });
    const keys = await CalendarReservation.find({ sourceId: bookingId }).lean();
    expect(keys).toHaveLength(192);
    expect(new Set(keys.map((entry: any) => entry.startAt.toISOString().slice(0, 10)))).toEqual(
      new Set(['2030-11-04']),
    );

    // A plan day is genuinely occupied by the professional.
    await expect(reserveCalendarKeys({
      sourceType: 'support',
      sourceId: new Types.ObjectId(),
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-04T10:00:00.000Z'),
        endAt: new Date('2030-11-04T10:30:00.000Z'),
      }),
    })).rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });

    // An unplanned project day is free in both the availability reader and the
    // reservation writer; support can actually book it.
    const bookingRanges = await buildBookingBlockedRanges(professionalId);
    expect(bookingRanges).toHaveLength(1);
    expect(new Date(bookingRanges[0].startDate).toISOString()).toBe('2030-11-04T00:00:00.000Z');
    expect(new Date(bookingRanges[0].endDate).toISOString()).toBe('2030-11-05T00:00:00.000Z');

    const supportId = new Types.ObjectId();
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: supportId,
      keys: buildCalendarReservationKeysForInterval({
        role: 'professional',
        userId: professionalId,
        startAt: new Date('2030-11-05T10:00:00.000Z'),
        endAt: new Date('2030-11-05T10:30:00.000Z'),
      }),
    });
    const scheduleConflicts = await findBookingCalendarConflictsForSchedule({
      bookingId,
      booking,
    });
    expect(scheduleConflicts).toEqual([]);

    // Extending the execution window does not invent occupancy on unplanned days.
    const extended = {
      ...booking,
      scheduledExecutionEndDate: new Date('2030-11-09T17:00:00.000Z'),
      scheduledBufferEndDate: new Date('2030-11-09T17:00:00.000Z'),
    };
    await withCalendarTransaction(async (session) => {
      await replaceBookingCalendar(extended, session);
      return true;
    });
    expect(await CalendarReservation.countDocuments({ sourceId: bookingId })).toBe(192);

    // A reschedule that no longer overlaps any planned day uses the safe
    // whole-window fallback so the new window is not left unprotected.
    const moved = {
      ...booking,
      scheduledStartDate: new Date('2030-12-02T09:00:00.000Z'),
      scheduledExecutionEndDate: new Date('2030-12-02T10:00:00.000Z'),
      scheduledBufferEndDate: new Date('2030-12-02T10:00:00.000Z'),
    };
    await withCalendarTransaction(async (session) => {
      await replaceBookingCalendar(moved, session);
      return true;
    });
    const movedKeys = await CalendarReservation.find({ sourceId: bookingId }).lean();
    expect(movedKeys).toHaveLength(8);
    expect(new Set(movedKeys.map((entry: any) => entry.startAt.toISOString().slice(0, 10)))).toEqual(
      new Set(['2030-12-02']),
    );
  });

  it('suppresses a stale confirmation that tries to dispatch after a committed cancellation', async () => {
    const record = await createMeetingTicket();
    await SupportTicket.updateOne(
      { _id: record._id },
      {
        $set: {
          'meeting.status': 'scheduled',
          'meeting.meetingLink': 'https://meet.example/room',
          'meeting.revision': 1,
          'meeting.confirmationEventId': 'confirmed:1',
        },
        $inc: { __v: 1 },
      },
    );
    // This is the snapshot an older request would still hold: scheduled, with
    // the confirmation event that has not been handed to a provider yet.
    const staleTicket = await SupportTicket.findById(record._id);
    // Simulate an older request that claimed the event before the cancellation.
    await SupportMeetingNotification.create({
      ticketId: record._id,
      eventId: 'confirmed:1',
      type: 'confirmed',
      status: 'pending',
      attempts: 1,
      claimedAt: new Date(Date.now() - SUPPORT_MEETING_NOTIFICATION_LEASE_MS - 1000),
    });
    const scheduled = await SupportTicket.findById(record._id);
    expect(scheduled?.meeting?.status).toBe('scheduled');

    const cancel = await cancelSupportMeeting({
      ticket: scheduled!,
      actorId: adminId,
      actorRole: 'admin',
      owner,
      allowPast: true,
    });
    expect(cancel.ticket.meeting?.status).toBe('cancelled');
    sendConfirmed.mockClear();
    sendRescheduled.mockClear();

    const delivery = await deliverMeetingNotification({
      ticket: staleTicket!,
      owner,
      eventId: 'confirmed:1',
      type: 'confirmed',
      send: sendConfirmed,
    });
    expect(delivery).toEqual({ emailSent: false, emailAttempted: false });
    expect(sendConfirmed).not.toHaveBeenCalled();
    const ledger = await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'confirmed:1',
    }).lean();
    expect(ledger?.status).toBe('superseded');

    const rescheduleDelivery = await deliverMeetingNotification({
      ticket: staleTicket!,
      owner,
      eventId: 'rescheduled:1',
      type: 'rescheduled',
      send: sendRescheduled,
    });
    expect(rescheduleDelivery.emailAttempted).toBe(false);
    expect(sendRescheduled).not.toHaveBeenCalled();
  });

  it('keeps a handed-off confirmation and a later cancellation in causal order', async () => {
    const record = await createMeetingTicket();
    let releaseConfirmation: (value: boolean) => void = () => undefined;
    const confirmationGate = new Promise<boolean>((resolve) => {
      releaseConfirmation = resolve;
    });
    sendConfirmed.mockImplementationOnce(async () => confirmationGate);

    const linkDoc = await SupportTicket.findById(record._id);
    const setLink = setSupportMeetingLink({
      ticket: linkDoc!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });
    for (let i = 0; i < 100; i += 1) {
      if (sendConfirmed.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sendConfirmed).toHaveBeenCalledTimes(1);

    const cancelDoc = await SupportTicket.findById(record._id);
    const cancel = await cancelSupportMeeting({
      ticket: cancelDoc!,
      actorId: adminId,
      actorRole: 'admin',
      owner,
      allowPast: true,
    });
    expect(cancel.ticket.meeting?.status).toBe('cancelled');
    expect(sendCancelled).toHaveBeenCalledTimes(1);

    releaseConfirmation(true);
    await setLink;
    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.status).toBe('cancelled');
    // The mail was already handed to the provider before the cancellation.
    // A provider cannot be asked to un-send it; the app-level order is still
    // confirmation first, cancellation after, never the reverse.
    expect(sendConfirmed).toHaveBeenCalledTimes(1);
    expect(sendCancelled).toHaveBeenCalledTimes(1);
    expect(sendConfirmed.mock.invocationCallOrder[0])
      .toBeLessThan(sendCancelled.mock.invocationCallOrder[0]);
  });

  it('reconciles a crashed confirmation timestamp from the sent ledger', async () => {
    const sentAt = new Date('2030-11-01T08:00:00.000Z');
    const record = await createMeetingTicket({
      meeting: {
        status: 'scheduled',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        meetingLink: 'https://meet.example/room',
        revision: 1,
        confirmationEventId: 'confirmed:1',
      },
    });
    await SupportMeetingNotification.create({
      ticketId: record._id,
      eventId: 'confirmed:1',
      type: 'confirmed',
      status: 'sent',
      attempts: 1,
      claimedAt: new Date('2030-11-01T07:59:59.000Z'),
      sentAt,
    });
    sendConfirmed.mockClear();
    const doc = await SupportTicket.findById(record._id);
    const result = await setSupportMeetingLink({
      ticket: doc!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });
    expect(result.unchanged).toBe(true);
    expect(sendConfirmed).not.toHaveBeenCalled();
    const stored = await SupportTicket.findById(record._id).lean();
    expect(stored?.meeting?.linkEmailSentAt?.toISOString()).toBe(sentAt.toISOString());
  });

  it('bounds a hung mail provider and leaves the event retryable', async () => {
    process.env.SUPPORT_MEETING_EMAIL_TIMEOUT_MS = '40';
    try {
      const record = await createMeetingTicket({
        meeting: {
          status: 'scheduled',
          scheduledAt: meetingStart,
          durationMinutes: 30,
          timeZone: 'Europe/Brussels',
          adminId,
          meetingLink: 'https://meet.example/room',
          revision: 1,
          confirmationEventId: 'confirmed:1',
        },
      });
      const ticket = await SupportTicket.findById(record._id);
      const delivery = await deliverMeetingNotification({
        ticket: ticket!,
        owner,
        eventId: 'confirmed:1',
        type: 'confirmed',
        send: () => new Promise<boolean>(() => undefined),
      });
      expect(delivery.emailAttempted).toBe(true);
      expect(delivery.emailSent).toBe(false);
      const ledger = await SupportMeetingNotification.findOne({
        ticketId: record._id,
        eventId: 'confirmed:1',
      }).lean();
      expect(ledger?.status).toBe('failed');
    } finally {
      delete process.env.SUPPORT_MEETING_EMAIL_TIMEOUT_MS;
    }
  });

  it('rejects a support create that lands after the owner was hard-deleted', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439051');
    await User.collection.insertOne({
      _id: userId,
      name: 'Race Delete',
      email: 'race-delete@example.com',
      role: 'professional',
      isEmailVerified: true,
      deletedAt: null,
    });

    let releaseCreate: () => void = () => undefined;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markCreateStarted: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    const originalCreate = SupportTicket.create.bind(SupportTicket);
    const createSpy = vi.spyOn(SupportTicket, 'create').mockImplementationOnce(((args: any, options: any) => {
      markCreateStarted();
      return createGate.then(() => (originalCreate as any)(args, options));
    }) as any);

    try {
      const pendingCreate = createSupportItemForUser({
        user: {
          _id: userId,
          name: 'Race Delete',
          email: 'race-delete@example.com',
          role: 'professional',
          isEmailVerified: true,
        } as any,
        body: {
          kind: 'ticket',
          subject: 'Racing delete',
          description: 'Should not survive',
          reason: 'technical_problem',
          locale: 'en',
        },
      });
      await createStarted;
      await deleteUserData(userId);
      releaseCreate();

      await expect(pendingCreate).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(await SupportTicket.countDocuments({ userId })).toBe(0);
      expect(await User.countDocuments({ _id: userId })).toBe(0);
      expect(await AccountDataGuard.findById(userId).lean()).toMatchObject({ state: 'deleted' });
    } finally {
      createSpy.mockRestore();
    }
  });

  it('rejects a support create that lands after the owner was anonymized', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439052');
    await User.collection.insertOne({
      _id: userId,
      name: 'Race Anonymize',
      email: 'race-anon@example.com',
      role: 'professional',
      isEmailVerified: true,
      deletedAt: null,
    });

    let releaseCreate: () => void = () => undefined;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markCreateStarted: () => void = () => undefined;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    const originalCreate = SupportTicket.create.bind(SupportTicket);
    const createSpy = vi.spyOn(SupportTicket, 'create').mockImplementationOnce(((args: any, options: any) => {
      markCreateStarted();
      return createGate.then(() => (originalCreate as any)(args, options));
    }) as any);

    try {
      const pendingCreate = createSupportItemForUser({
        user: {
          _id: userId,
          name: 'Race Anonymize',
          email: 'race-anon@example.com',
          role: 'professional',
          isEmailVerified: true,
        } as any,
        body: {
          kind: 'ticket',
          subject: 'Racing anonymize',
          description: 'Should not survive',
          reason: 'technical_problem',
          locale: 'en',
        },
      });
      await createStarted;
      await anonymizeUser(userId, adminId);
      releaseCreate();

      await expect(pendingCreate).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(await SupportTicket.countDocuments({ userId })).toBe(0);
      expect(await AccountDataGuard.findById(userId).lean()).toMatchObject({ state: 'anonymized' });
    } finally {
      createSpy.mockRestore();
    }
  });

  it('keeps owned legacy meeting history readable after a professional becomes a customer', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439061');
    await User.collection.insertOne({
      _id: userId,
      name: 'Former Pro',
      email: 'former-pro@example.com',
      role: 'customer',
      isEmailVerified: true,
      deletedAt: null,
    });
    const legacy = await MeetingRequest.create({
      userId,
      topic: 'Historical meeting request',
      preferredTimes: 'Tuesday morning',
      durationMinutes: 30,
      status: 'scheduled',
      scheduledAt: new Date('2030-11-06T09:00:00.000Z'),
    });
    const user = {
      _id: userId,
      name: 'Former Pro',
      email: 'former-pro@example.com',
      role: 'customer',
      isEmailVerified: true,
    } as any;
    const mockRes = () => {
      const res = {
        statusCode: 200,
        body: undefined as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: any) { this.body = payload; return this; },
      };
      return res;
    };

    const listRes = mockRes();
    await listSupportItems(
      { user, query: { kind: 'meeting' } } as any,
      listRes as any,
    );
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.body.data.items;
    expect(listed.some((item: any) => item._id === String(legacy._id))).toBe(true);
    expect(listed.find((item: any) => item._id === String(legacy._id)).meeting.legacy).toBe(true);

    const detailRes = mockRes();
    await getSupportItem(
      { user, params: { kind: 'meeting', id: String(legacy._id) } } as any,
      detailRes as any,
    );
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.body.data._id).toBe(String(legacy._id));

    // Ownership grants history read only; a customer still cannot create a new
    // support meeting.
    await expect(createSupportItemForUser({
      user,
      body: {
        kind: 'meeting',
        subject: 'New meeting',
        description: 'Not allowed',
        reason: 'technical_problem',
        timeZone: 'UTC',
        scheduledAt: '2030-11-07T09:00:00.000Z',
      },
    })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('anonymizes support content and reservations while retaining admin notes', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439031');
    await User.collection.insertOne({
      _id: userId,
      name: 'Anon Me',
      email: 'anon@example.com',
      role: 'professional',
      deletedAt: null,
    });
    const attachmentKey = `support-attachments/${userId}/private.pdf`;
    const ticket = await SupportTicket.create({
      userId,
      kind: 'meeting',
      subject: 'Private subject',
      description: 'Private description',
      reason: 'technical_problem',
      userType: 'professional',
      locale: 'en',
      status: 'open',
      replies: [{ authorId: userId, authorRole: 'professional', body: 'Private reply', createdAt: new Date() }],
      attachment: {
        key: attachmentKey,
        url: `https://fixera-uploads.s3.eu-west-1.amazonaws.com/${attachmentKey}`,
        name: 'private.pdf',
        mimeType: 'application/pdf',
        size: 10,
      },
      meeting: {
        status: 'pending',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        slotKeys: [`admin:${adminId}:${meetingStart.toISOString()}`],
      },
    });
    await SupportTicketInternalNote.create({ ticketId: ticket._id, adminId, body: 'PRIVATE NOTE' });
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: ticket._id,
      keys: [{
        key: `admin:${adminId}:${meetingStart.toISOString()}`,
        role: 'admin',
        userId: adminId,
        startAt: meetingStart,
        endAt: new Date(meetingStart.getTime() + 15 * 60 * 1000),
      }],
    });

    await anonymizeUser(userId, adminId);

    const stored = await SupportTicket.findById(ticket._id).lean();
    expect(stored?.subject).toBe('[deleted]');
    expect(stored?.description).toBe('[deleted]');
    expect(stored?.replies[0].body).toBe('[deleted]');
    expect(stored?.attachment).toBeUndefined();
    expect(stored?.meeting?.status).toBe('cancelled');
    expect(stored?.meeting?.slotKeys).toBeUndefined();
    const retainedNote = await SupportTicketInternalNote.findOne({ ticketId: ticket._id }).lean();
    expect(retainedNote?.body).toBe('PRIVATE NOTE');
    expect(await CalendarReservation.countDocuments({ sourceId: ticket._id })).toBe(0);
    expect(deleteS3).toHaveBeenCalledWith(attachmentKey);
    const user = await User.findById(userId).lean();
    expect(user?.deletedAt).toBeInstanceOf(Date);
    expect(user?.name).toBe('[deleted user]');
  });

  it('hard-deletes support PII, notes, attachments and all owned calendar reservations', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439021');
    await User.collection.insertOne({
      _id: userId,
      name: 'Delete Me',
      email: 'delete@example.com',
      role: 'professional',
    });
    const attachmentKey = `support-attachments/${userId}/note.pdf`;
    const attachmentUrl = `https://fixera-uploads.s3.eu-west-1.amazonaws.com/${attachmentKey}`;
    const ticket = await SupportTicket.create({
      userId,
      kind: 'meeting',
      subject: 'Private subject',
      description: 'Private description',
      reason: 'technical_problem',
      userType: 'professional',
      locale: 'en',
      status: 'open',
      attachment: { key: attachmentKey, url: attachmentUrl, name: 'note.pdf', mimeType: 'application/pdf', size: 10 },
      meeting: {
        status: 'pending',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        slotKeys: [`admin:${adminId}:${meetingStart.toISOString()}`],
      },
    });
    await SupportTicketInternalNote.create({
      ticketId: ticket._id,
      adminId,
      body: 'PRIVATE NOTE',
    });
    const otherStart = new Date('2030-11-06T09:00:00.000Z');
    const otherTicket = await createMeetingTicket({
      meeting: {
        status: 'pending',
        scheduledAt: otherStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        slotKeys: [
          `admin:${adminId}:${otherStart.toISOString()}`,
          `professional:${professionalId}:${otherStart.toISOString()}`,
        ],
      },
    });
    await Meeting.create({
      projectId: '507f1f77bcf86cd799439099',
      professionalId: userId,
      meetingType: 'team',
      title: 'Owned meeting',
      scheduledDate: new Date('2030-11-04T00:00:00.000Z'),
      startTime: '10:00',
      endTime: '11:00',
      duration: 60,
      attendees: [],
      status: 'scheduled',
      createdBy: userId.toString(),
    });
    await MeetingRequest.create({
      userId,
      topic: 'Owned legacy request',
      preferredTimes: 'morning',
      durationMinutes: 30,
      status: 'scheduled',
      scheduledAt: meetingStart,
    });
    await reserveCalendarKeys({
      sourceType: 'support',
      sourceId: ticket._id,
      keys: [{
        key: `admin:${adminId}:${meetingStart.toISOString()}`,
        role: 'admin',
        userId: adminId,
        startAt: meetingStart,
        endAt: new Date(meetingStart.getTime() + 15 * 60 * 1000),
      }],
    });

    await deleteUserData(userId);

    expect(await User.countDocuments({ _id: userId })).toBe(0);
    expect(await SupportTicket.countDocuments({ userId })).toBe(0);
    expect(await SupportTicketInternalNote.countDocuments({ ticketId: ticket._id })).toBe(0);
    expect(await Meeting.countDocuments({ professionalId: userId })).toBe(0);
    expect(await MeetingRequest.countDocuments({ userId })).toBe(0);
    expect(await CalendarReservation.countDocuments({ sourceId: ticket._id })).toBe(0);
    expect(deleteS3).toHaveBeenCalledWith(attachmentKey);
    // Another user's support data is untouched.
    expect(await SupportTicket.countDocuments({ _id: otherTicket._id })).toBe(1);
  });

  it('never lets an older meeting revision supersede a newer claimed notification', async () => {
    const record = await createMeetingTicket();
    await SupportTicket.updateOne(
      { _id: record._id },
      {
        $set: {
          'meeting.status': 'cancelled',
          'meeting.revision': 3,
          'meeting.cancelledEventId': 'cancelled:3',
        },
        $inc: { __v: 1 },
      },
    );
    const staleClaim = new Date(Date.now() - SUPPORT_MEETING_NOTIFICATION_LEASE_MS - 1000);
    await SupportMeetingNotification.create([
      {
        ticketId: record._id,
        eventId: 'cancelled:3',
        revision: 3,
        type: 'cancelled',
        status: 'pending',
        attempts: 1,
        claimedAt: staleClaim,
      },
      {
        ticketId: record._id,
        eventId: 'rescheduled:2',
        revision: 2,
        type: 'rescheduled',
        status: 'pending',
        attempts: 1,
        claimedAt: staleClaim,
      },
      {
        // Written before the revision field existed: necessarily older.
        ticketId: record._id,
        eventId: 'confirmed:1',
        type: 'confirmed',
        status: 'failed',
        attempts: 1,
        claimedAt: staleClaim,
      },
    ]);

    // An older (revision 2) link transition runs its cleanup after the newer
    // cancellation claimed its event.
    await supersedeSupportMeetingNotifications(record._id, { revision: 2 });

    const afterSupersede = await SupportMeetingNotification.find({ ticketId: record._id })
      .select('eventId status')
      .lean();
    const statusByEvent = new Map(afterSupersede.map((row: any) => [row.eventId, row.status]));
    expect(statusByEvent.get('cancelled:3')).toBe('pending');
    expect(statusByEvent.get('rescheduled:2')).toBe('pending');
    expect(statusByEvent.get('confirmed:1')).toBe('superseded');

    const stored = await SupportTicket.findById(record._id);
    const delivery = await deliverMeetingNotification({
      ticket: stored!,
      owner,
      eventId: 'cancelled:3',
      type: 'cancelled',
      send: sendCancelled,
    });
    expect(delivery.emailSent).toBe(true);
    expect(sendCancelled).toHaveBeenCalledTimes(1);
    expect((await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'cancelled:3',
    }).lean())?.status).toBe('sent');
  });

  it('does not let an older link transition suppress a newer cancellation claimed before dispatch', async () => {
    const record = await createMeetingTicket();
    const linkDoc = await SupportTicket.findById(record._id);
    const supersedeReached = deferred();
    const supersedeRelease = deferred();
    const dispatchReached = deferred();
    const dispatchRelease = deferred();
    raceGates.supersede = {
      ticketId: String(record._id),
      reached: supersedeReached.resolve,
      wait: supersedeRelease.promise,
    };
    raceGates.dispatch = {
      eventPrefix: 'cancelled:',
      reached: dispatchReached.resolve,
      wait: dispatchRelease.promise,
    };

    const linkPromise = setSupportMeetingLink({
      ticket: linkDoc!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });
    await waitFor(async () => {
      const stored = await SupportTicket.findById(record._id).lean();
      return stored?.meeting?.status === 'scheduled'
        && stored?.meeting?.meetingLink === 'https://meet.example/room';
    }, 'the link transition to persist');
    // A fixed link transition has committed (including its supersede) and may
    // still be delivering; the pre-fix one is instead paused in its
    // non-transactional supersede, which is exactly the window under test.
    await Promise.race([
      linkPromise.then(() => 'done', () => 'done'),
      supersedeReached.promise.then(() => 'gated'),
    ]);

    const cancelDoc = await SupportTicket.findById(record._id);
    const cancelPromise = cancelSupportMeeting({
      ticket: cancelDoc!,
      actorId: adminId,
      actorRole: 'admin',
      owner,
      allowPast: true,
    });
    // The newer cancellation event is claimed but not yet handed to a provider.
    await dispatchReached.promise;
    supersedeRelease.resolve();
    await linkPromise;
    dispatchRelease.resolve();

    const cancel = await cancelPromise;
    expect(cancel.ticket.meeting?.status).toBe('cancelled');
    expect(cancel.emailSent).toBe(true);
    expect(sendCancelled).toHaveBeenCalledTimes(1);
    expect((await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'cancelled:2',
    }).lean())?.status).toBe('sent');
    expect(sendConfirmed.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('does not let an older link transition suppress a newer reschedule claimed before dispatch', async () => {
    const record = await createMeetingTicket();
    const linkDoc = await SupportTicket.findById(record._id);
    const supersedeReached = deferred();
    const supersedeRelease = deferred();
    const dispatchReached = deferred();
    const dispatchRelease = deferred();
    raceGates.supersede = {
      ticketId: String(record._id),
      reached: supersedeReached.resolve,
      wait: supersedeRelease.promise,
    };
    raceGates.dispatch = {
      eventPrefix: 'rescheduled:',
      reached: dispatchReached.resolve,
      wait: dispatchRelease.promise,
    };

    const linkPromise = setSupportMeetingLink({
      ticket: linkDoc!,
      adminId,
      owner,
      meetingLink: 'https://meet.example/room',
    });
    await waitFor(async () => {
      const stored = await SupportTicket.findById(record._id).lean();
      return stored?.meeting?.status === 'scheduled'
        && stored?.meeting?.meetingLink === 'https://meet.example/room';
    }, 'the link transition to persist');
    await Promise.race([
      linkPromise.then(() => 'done', () => 'done'),
      supersedeReached.promise.then(() => 'gated'),
    ]);

    const rescheduleDoc = await SupportTicket.findById(record._id);
    const reschedulePromise = rescheduleSupportMeeting({
      ticket: rescheduleDoc!,
      professional: { _id: professionalId, timeZone: 'Europe/Brussels' },
      start: laterStart,
      timeZone: 'Europe/Brussels',
      owner,
    });
    await dispatchReached.promise;
    supersedeRelease.resolve();
    await linkPromise;
    dispatchRelease.resolve();

    const rescheduled = await reschedulePromise;
    expect(rescheduled.ticket.meeting?.scheduledAt?.toISOString()).toBe(laterStart.toISOString());
    expect(rescheduled.emailSent).toBe(true);
    expect(sendRescheduled).toHaveBeenCalledTimes(1);
    expect((await SupportMeetingNotification.findOne({
      ticketId: record._id,
      eventId: 'rescheduled:2',
    }).lean())?.status).toBe('sent');
  });

  it('releases support keys after the ticket delete and cannot orphan a racing reschedule', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439081');
    const otherId = new Types.ObjectId('507f1f77bcf86cd799439082');
    await User.collection.insertOne({
      _id: userId,
      name: 'Delete Race',
      email: 'delete-race@example.com',
      role: 'professional',
      isEmailVerified: true,
      deletedAt: null,
    });
    const ticket = await SupportTicket.create({
      userId,
      kind: 'meeting',
      subject: 'Support meeting',
      description: 'Need help',
      reason: 'technical_problem',
      userType: 'professional',
      locale: 'en',
      status: 'open',
      meeting: {
        status: 'pending',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        slotKeys: buildSupportSlotKeysForTest(userId),
      },
    });
    const otherTicket = await createMeetingTicket({
      userId: otherId,
      meeting: {
        status: 'pending',
        scheduledAt: new Date('2030-11-09T09:00:00.000Z'),
        slotKeys: undefined,
      },
    } as any);
    await reserveSupportKeysForTest(ticket._id, userId);
    await reserveSupportKeysForTest(otherTicket._id, otherId, new Date('2030-11-09T09:00:00.000Z'));
    const staleTicket = await SupportTicket.findById(ticket._id);
    expect(staleTicket).not.toBeNull();

    const reached = deferred();
    const release = deferred();
    raceGates.release = {
      sourceType: 'support',
      sourceId: String(ticket._id),
      reached: reached.resolve,
      wait: release.promise,
    };
    const deletion = deleteUserData(userId);
    await reached.promise;
    const ticketRowsAtRelease = await SupportTicket.countDocuments({ _id: ticket._id });

    let rescheduleError: any = null;
    try {
      await rescheduleSupportMeeting({
        ticket: staleTicket!,
        professional: { _id: userId, timeZone: 'Europe/Brussels' },
        start: laterStart,
        timeZone: 'Europe/Brussels',
        owner: { ...owner, _id: userId.toString(), email: 'delete-race@example.com' },
      });
    } catch (error) {
      rescheduleError = error;
    }
    release.resolve();
    await deletion;

    expect(ticketRowsAtRelease).toBe(0);
    expect(rescheduleError).not.toBeNull();
    expect(await CalendarReservation.countDocuments({ sourceId: ticket._id })).toBe(0);
    expect(await CalendarReservation.countDocuments({ sourceId: otherTicket._id })).toBe(4);
  });

  it('releases support keys after anonymization redaction and cannot orphan a racing reschedule', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439083');
    await User.collection.insertOne({
      _id: userId,
      name: 'Anonymize Race',
      email: 'anonymize-race@example.com',
      role: 'professional',
      isEmailVerified: true,
      deletedAt: null,
    });
    const ticket = await SupportTicket.create({
      userId,
      kind: 'meeting',
      subject: 'Support meeting',
      description: 'Need help',
      reason: 'technical_problem',
      userType: 'professional',
      locale: 'en',
      status: 'open',
      meeting: {
        status: 'pending',
        scheduledAt: meetingStart,
        durationMinutes: 30,
        timeZone: 'Europe/Brussels',
        adminId,
        slotKeys: buildSupportSlotKeysForTest(userId),
      },
    });
    await reserveSupportKeysForTest(ticket._id, userId);
    const staleTicket = await SupportTicket.findById(ticket._id);

    const reached = deferred();
    const release = deferred();
    raceGates.release = {
      sourceType: 'support',
      sourceId: String(ticket._id),
      reached: reached.resolve,
      wait: release.promise,
    };
    const anonymizing = anonymizeUser(userId, adminId);
    await reached.promise;
    const storedAtRelease = await SupportTicket.findById(ticket._id).lean();

    let rescheduleError: any = null;
    try {
      await rescheduleSupportMeeting({
        ticket: staleTicket!,
        professional: { _id: userId, timeZone: 'Europe/Brussels' },
        start: laterStart,
        timeZone: 'Europe/Brussels',
        owner: { ...owner, _id: userId.toString(), email: 'anonymize-race@example.com' },
      });
    } catch (error) {
      rescheduleError = error;
    }
    release.resolve();
    await anonymizing;

    expect(storedAtRelease?.meeting?.status).toBe('cancelled');
    expect(rescheduleError).toMatchObject({ status: 409 });
    expect(await CalendarReservation.countDocuments({ sourceId: ticket._id })).toBe(0);
  });

  it('cannot recreate meeting-request keys after the request row was deleted', async () => {
    const userId = new Types.ObjectId('507f1f77bcf86cd799439084');
    await User.collection.insertOne({
      _id: userId,
      name: 'Legacy Owner',
      email: 'legacy-owner@example.com',
      role: 'professional',
      timeZone: 'Europe/Brussels',
      businessInfo: { timezone: 'Europe/Brussels' },
      isEmailVerified: true,
      deletedAt: null,
    });
    const request = await MeetingRequest.create({
      userId,
      topic: 'Legacy request',
      preferredTimes: 'Morning',
      durationMinutes: 30,
      status: 'pending',
    });
    const oldWindowStart = new Date('2030-11-06T09:00:00.000Z');
    await reserveCalendarKeys({
      sourceType: 'meeting_request',
      sourceId: request._id,
      keys: [
        ...buildCalendarReservationKeysForInterval({
          role: 'admin',
          userId: adminId,
          startAt: oldWindowStart,
          endAt: new Date(oldWindowStart.getTime() + 30 * 60 * 1000),
        }),
        ...buildCalendarReservationKeysForInterval({
          role: 'professional',
          userId,
          startAt: oldWindowStart,
          endAt: new Date(oldWindowStart.getTime() + 30 * 60 * 1000),
        }),
      ],
    });

    const busyReached = deferred();
    const busyRelease = deferred();
    raceGates.busy = { reached: busyReached.resolve, wait: busyRelease.promise };
    const res = mockRes();
    const update = adminUpdateMeetingRequest(
      {
        admin: { _id: adminId, timeZone: 'UTC' },
        params: { id: String(request._id) },
        body: { status: 'scheduled', scheduledAt: '2030-11-07T09:00:00.000Z' },
      } as any,
      res as any,
    );
    await busyReached.promise;

    const reached = deferred();
    const release = deferred();
    raceGates.release = {
      sourceType: 'meeting_request',
      sourceId: String(request._id),
      reached: reached.resolve,
      wait: release.promise,
    };
    const deletion = deleteUserData(userId);
    await reached.promise;
    const requestRowsAtRelease = await MeetingRequest.countDocuments({ _id: request._id });
    busyRelease.resolve();
    await update;
    release.resolve();
    await deletion;

    expect(requestRowsAtRelease).toBe(0);
    expect(res.statusCode).toBe(409);
    expect(await CalendarReservation.countDocuments({ sourceId: request._id })).toBe(0);
  });

  it('deletes meeting, meeting-request and booking rows before releasing their keys', async () => {
    const scenarios: Array<{
      sourceType: 'meeting' | 'meeting_request' | 'booking';
      seed: (userId: Types.ObjectId) => Promise<Types.ObjectId>;
    }> = [
      {
        sourceType: 'meeting',
        seed: async (userId) => {
          const meeting = await Meeting.create({
            projectId: '507f1f77bcf86cd799439099',
            professionalId: userId,
            meetingType: 'team',
            title: 'Owned meeting',
            scheduledDate: new Date('2030-11-08T00:00:00.000Z'),
            startTime: '10:00',
            endTime: '11:00',
            duration: 60,
            attendees: [],
            status: 'scheduled',
            createdBy: userId.toString(),
          });
          return meeting._id;
        },
      },
      {
        sourceType: 'meeting_request',
        seed: async (userId) => {
          const request = await MeetingRequest.create({
            userId,
            topic: 'Owned request',
            preferredTimes: 'Morning',
            durationMinutes: 30,
            status: 'scheduled',
            scheduledAt: new Date('2030-11-08T09:00:00.000Z'),
          });
          return request._id;
        },
      },
      {
        sourceType: 'booking',
        seed: async (userId) => {
          const bookingId = new Types.ObjectId();
          await Booking.collection.insertOne({
            _id: bookingId,
            bookingNumber: `BK-2030-${String(bookingId).slice(-6)}`,
            bookingType: 'project',
            customer: userId,
            professional: userId,
            status: 'booked',
            scheduledStartDate: new Date('2030-11-08T09:00:00.000Z'),
            scheduledExecutionEndDate: new Date('2030-11-08T10:00:00.000Z'),
            scheduledBufferEndDate: new Date('2030-11-08T10:00:00.000Z'),
            assignedTeamMembers: [],
            location: { type: 'Point', coordinates: [0, 0] },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          return bookingId;
        },
      },
    ];
    const countsAtRelease: Array<{ sourceType: string; count: number }> = [];
    for (const [index, scenario] of scenarios.entries()) {
      const userId = new Types.ObjectId(`507f1f77bcf86cd79943909${index + 1}`);
      await User.collection.insertOne({
        _id: userId,
        name: `Cleanup ${scenario.sourceType}`,
        email: `cleanup-${scenario.sourceType}@example.com`,
        role: 'professional',
        isEmailVerified: true,
        deletedAt: null,
      });
      const sourceId = await scenario.seed(userId);
      await reserveCalendarKeys({
        sourceType: scenario.sourceType,
        sourceId,
        keys: buildCalendarReservationKeysForInterval({
          role: 'professional',
          userId,
          startAt: new Date('2030-11-08T09:00:00.000Z'),
          endAt: new Date('2030-11-08T09:30:00.000Z'),
        }),
      });
      const reached = deferred();
      const release = deferred();
      raceGates.release = {
        sourceType: scenario.sourceType,
        sourceId: String(sourceId),
        reached: reached.resolve,
        wait: release.promise,
      };
      const deletion = deleteUserData(userId);
      await reached.promise;
      const count = await sourceModelFor(scenario.sourceType).countDocuments({ _id: sourceId });
      countsAtRelease.push({ sourceType: scenario.sourceType, count });
      release.resolve();
      await deletion;
      expect(await CalendarReservation.countDocuments({ sourceId })).toBe(0);
    }
    expect(countsAtRelease).toEqual([
      { sourceType: 'meeting', count: 0 },
      { sourceType: 'meeting_request', count: 0 },
      { sourceType: 'booking', count: 0 },
    ]);
  });
});
