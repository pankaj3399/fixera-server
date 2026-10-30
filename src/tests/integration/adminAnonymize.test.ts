import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import http, { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_admin_anonymize';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-admin-anonymize-secret';
  process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'fixera-uploads';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test-secret';
});

const s3 = vi.hoisted(() => ({
  deleteCalls: [] as string[],
  failKeys: new Set<string>(),
  presignCalls: [] as string[],
  uploadCalls: [] as string[],
  totalCalls: 0,
}));

vi.mock('../../utils/s3Upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/s3Upload')>();
  return {
    ...actual,
    deleteFromS3: async (key: string) => {
      s3.totalCalls += 1;
      if (s3.failKeys.has(key)) throw new Error('test S3 delete failure');
      s3.deleteCalls.push(key);
    },
    presignS3Url: async (url: string, expiresIn?: number) => {
      s3.totalCalls += 1;
      s3.presignCalls.push(url);
      return actual.presignS3Url(url, expiresIn);
    },
    uploadToS3: async (_file: any, key: string) => {
      s3.totalCalls += 1;
      s3.uploadCalls.push(key);
      return { url: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${key}`, key };
    },
  };
});

const notifyGate = vi.hoisted(() => ({
  beforeNext: null as null | (() => Promise<void>),
  lastArgs: null as any,
}));

const completionMocks = vi.hoisted(() => ({
  captureAndTransferPayment: vi.fn(async () => ({ success: true })),
  ensureBookingInvoiceArtifacts: vi.fn(async () => ({})),
  processReferralCompletion: vi.fn(async () => undefined),
  updateUserLoyalty: vi.fn(async () => undefined),
  updateProfessionalLevel: vi.fn(async () => undefined),
  awardBookingCompletionPoints: vi.fn(async () => undefined),
  ensureWarrantyCoverageSnapshot: vi.fn(async () => undefined),
  markMilestonesCompleted: vi.fn(),
}));

vi.mock('../../handlers/Stripe/payment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../handlers/Stripe/payment')>();
  return {
    ...actual,
    captureAndTransferPayment: completionMocks.captureAndTransferPayment,
  };
});

vi.mock('../../services/invoiceArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/invoiceArtifacts')>();
  return {
    ...actual,
    ensureBookingInvoiceArtifacts: completionMocks.ensureBookingInvoiceArtifacts,
  };
});

vi.mock('../../utils/referralSystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/referralSystem')>();
  return { ...actual, processReferralCompletion: completionMocks.processReferralCompletion };
});
vi.mock('../../utils/loyaltySystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/loyaltySystem')>();
  return { ...actual, updateUserLoyalty: completionMocks.updateUserLoyalty };
});
vi.mock('../../utils/professionalLevelSystem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/professionalLevelSystem')>();
  return { ...actual, updateProfessionalLevel: completionMocks.updateProfessionalLevel };
});
vi.mock('../../utils/bookingHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/bookingHelpers')>();
  return {
    ...actual,
    awardBookingCompletionPoints: completionMocks.awardBookingCompletionPoints,
    ensureWarrantyCoverageSnapshot: completionMocks.ensureWarrantyCoverageSnapshot,
    markMilestonesCompleted: completionMocks.markMilestonesCompleted,
  };
});

vi.mock('../../utils/notifications/notify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/notifications/notify')>();
  return {
    ...actual,
    notify: async (args: Parameters<typeof actual.notify>[0]) => {
      notifyGate.lastArgs = args;
      const before = notifyGate.beforeNext;
      if (before) {
        notifyGate.beforeNext = null;
        await before();
      }
      return actual.notify(args);
    },
  };
});

import adminRouter from '../../routes/Admin';
import authRouter from '../../routes/Auth';
import userRouter from '../../routes/User';
import publicRouter from '../../routes/Public';
import professionalRouter from '../../routes/Professional';
import supportRouter from '../../routes/Support';
import projectRouter from '../../routes/Project';
import bookingRouter from '../../routes/Booking';
import chatRouter from '../../routes/Chat';
import quotationRouter from '../../routes/Quotation';
import warrantyRouter from '../../routes/WarrantyClaim';
import errorHandler from '../../handlers/error';
import User from '../../models/user';
import AccountDataGuard from '../../models/accountDataGuard';
import AuditLog from '../../models/auditLog';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import Project from '../../models/project';
import SupportTicket from '../../models/supportTicket';
import SupportTicketInternalNote from '../../models/supportTicketInternalNote';
import SupportMeetingNotification from '../../models/supportMeetingNotification';
import Meeting from '../../models/meeting';
import MeetingRequest from '../../models/meetingRequest';
import CalendarReservation from '../../models/calendarReservation';
import Conversation from '../../models/conversation';
import ChatMessage from '../../models/chatMessage';
import Referral from '../../models/referral';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import MarketingLead from '../../models/marketingLead';
import Notification from '../../models/notification';
import EmailLog from '../../models/emailLog';
import CancellationRequest from '../../models/cancellationRequest';
import WarrantyClaim from '../../models/warrantyClaim';
import { assertSupportAccountWritable } from '../../utils/support/accountGuard';
import { invalidateFavoritesOverviewCache } from '../../handlers/Admin/favoritesAdmin';
import { notify } from '../../utils/notifications/notify';
import { notifyBookingCancelledAndRefunded } from '../../utils/notifications/notifyBookingCancelledAndRefunded';
import { processUnreadChatMirrorReminders } from '../../utils/notifications/processUnreadChatMirrors';
import { finalizeBookingCompletion } from '../../utils/notifications/runCompletionAutoAccept';
import { anonymizeUser } from '../../utils/anonymizeUser';
import { cancelSupportMeeting } from '../../utils/support/meetingReservation';
import { providerNetworkAttempts } from '../setup/providerIsolation';

const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

let server: Server;
let baseUrl = '';
let bookingCounter = 0;
let adminUser: any;
let superCookie = '';

const BUCKET = 'fixera-uploads';
const s3Url = (root: string, userId: string, file = 'file.pdf') =>
  `https://${BUCKET}.s3.us-east-1.amazonaws.com/${root}/${userId}/${file}`;

const jwtCookie = (user: any) =>
  `auth-token=${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;

const request = async (
  method: string,
  path: string,
  options: { body?: any; cookie?: string | null } = {},
) => {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
};

const requestMultipart = async (
  method: string,
  path: string,
  options: { cookie?: string | null; form: FormData },
) => {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.form,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
};

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl4sAAAAASUVORK5CYII=',
  'base64',
);
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

const createAdmin = async (input: Partial<any> = {}) => {
  const password = await bcrypt.hash('secret123', 4);
  return User.create({
    name: input.name || 'Anonymize Admin',
    email: input.email || `admin-${new Types.ObjectId().toHexString()}@example.com`,
    phone: input.phone || `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password,
    role: 'admin',
    adminRole: input.adminRole || 'super',
    ...(input.adminPermissionLevels ? { adminPermissionLevels: input.adminPermissionLevels } : {}),
    isEmailVerified: true,
    accountStatus: 'active',
  });
};

const createTarget = async (
  role: 'customer' | 'professional' = 'customer',
  overrides: Record<string, any> = {},
) => {
  const password = await bcrypt.hash('target-pass-123', 4);
  const customerDefaults = role === 'customer'
    ? {
        customerType: 'individual',
        location: {
          type: 'Point',
          coordinates: [4.35, 50.85],
          address: 'Old Street 1',
          city: 'Brussels',
          postalCode: '1000',
          country: 'BE',
        },
      }
    : {
        professionalStatus: 'approved',
        businessInfo: {
          companyName: 'Old Company',
          description: 'Old description',
          website: 'https://old.example',
          address: 'Old Company Street 1',
          city: 'Ghent',
          country: 'BE',
          postalCode: '9000',
          timezone: 'Europe/Brussels',
        },
        location: {
          type: 'Point',
          coordinates: [3.7, 51.05],
          address: 'Old Company Street 1',
          city: 'Ghent',
          postalCode: '9000',
          country: 'BE',
        },
      };
  return User.create({
    name: inputName(role),
    email: `target-${new Types.ObjectId().toHexString()}@example.com`,
    phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password,
    role,
    ...customerDefaults,
    ...overrides,
  });
};

const inputName = (role: 'customer' | 'professional') =>
  role === 'customer' ? 'Carla Customer' : 'Piet Professional';

const createBooking = async (input: {
  customer: Types.ObjectId;
  professional: Types.ObjectId;
  status?: string;
  snapshot?: boolean;
  targetReview?: boolean;
  targetMessage?: boolean;
  attachments?: string[];
  extra?: Record<string, any>;
}) => {
  bookingCounter += 1;
  const status = input.status || 'completed';
  const targetMessageId = new Types.ObjectId();
  return Booking.create({
    bookingNumber: `BK-ANON-${bookingCounter}-${Date.now()}`,
    bookingType: 'professional',
    customer: input.customer,
    professional: input.professional,
    status,
    rfqData: {
      serviceType: 'Bathroom renovation',
      description: 'Bathroom work',
      answers: [{ questionId: 'q1', question: 'Building type', answer: 'House', fieldType: 'text' }],
      ...(input.attachments ? { attachments: input.attachments } : {}),
    },
    quote: {
      amount: 100,
      currency: 'EUR',
      description: 'Bathroom work',
      submittedAt: new Date('2026-01-01T00:00:00.000Z'),
      submittedBy: input.professional,
    },
    location: {
      type: 'Point',
      coordinates: [4.35, 50.85],
      address: 'Old Street 1',
      city: 'Brussels',
      postalCode: '1000',
      country: 'BE',
    },
    vatDecision: {
      action: 'standard_rate',
      standardRate: 21,
      appliedRate: 21,
      country: 'BE',
    },
    payment: {
      amount: 100,
      currency: 'EUR',
      status: 'completed',
      netAmount: 100,
      vatAmount: 21,
      totalWithVat: 121,
      invoiceNumber: 'INV-OLD',
      invoiceUrl: s3Url('invoices', String(input.customer), 'INV-OLD.pdf'),
    },
    statusHistory: [{
      status,
      timestamp: new Date('2026-01-02T00:00:00.000Z'),
      updatedBy: input.customer,
      note: 'Created',
    }],
    ...(input.snapshot === false
      ? {}
      : {
          bookingSnapshot: {
            capturedAt: new Date('2026-01-02T00:00:00.000Z'),
            source: 'booking_creation',
            parties: {
              customer: {
                displayName: 'Carla Customer',
                customerType: 'individual',
                businessName: 'Carla BV',
                city: 'Brussels',
                country: 'BE',
              },
              professional: {
                displayName: 'Piet Professional',
                companyName: 'Old Company',
                city: 'Ghent',
                country: 'BE',
                timezone: 'Europe/Brussels',
              },
            },
            location: {
              address: 'Old Street 1',
              city: 'Brussels',
              postalCode: '1000',
              country: 'BE',
              coordinates: [4.35, 50.85],
            },
            project: {
              id: String(new Types.ObjectId()),
              title: 'Bathroom',
              media: { images: [s3Url('project-images', String(input.professional), 'project.jpg')] },
            },
            questions: {
              rfq: [{
                question: 'Upload plan',
                type: 'attachment',
                professionalAttachments: [s3Url('projects', String(input.professional), 'plan.pdf')],
              }],
            },
          },
        }),
    messages: [
      {
        _id: targetMessageId,
        senderId: input.customer,
        message: 'Hello, my name is Carla and this is private.',
        timestamp: new Date('2026-01-03T00:00:00.000Z'),
        attachments: [s3Url('chat', String(input.customer), 'message.pdf')],
      },
      {
        _id: new Types.ObjectId(),
        senderId: input.professional,
        message: 'I can help.',
        timestamp: new Date('2026-01-03T01:00:00.000Z'),
      },
    ],
    ...(input.targetReview
      ? {
          customerReview: {
            communicationLevel: 5,
            valueOfDelivery: 5,
            qualityOfService: 5,
            comment: 'Carla left a detailed private review.',
            images: [s3Url('review-images', String(input.customer), 'review.jpg')],
            reviewedAt: new Date('2026-01-04T00:00:00.000Z'),
          },
        }
      : {}),
    ...input.extra,
  });
};

const createPayment = async (input: {
  booking: any;
  customer: Types.ObjectId;
  professional?: Types.ObjectId;
  pending?: boolean;
}) => {
  const bookingId = input.booking._id || input.booking;
  return Payment.create({
    booking: bookingId,
    bookingNumber: input.booking.bookingNumber,
    customer: input.customer,
    ...(input.professional ? { professional: input.professional } : {}),
    status: input.pending ? 'pending' : 'completed',
    currency: 'EUR',
    amount: 100,
    netAmount: 100,
    vatAmount: 21,
    totalWithVat: 121,
    invoiceNumber: 'INV-OLD',
    invoiceUrl: s3Url('invoices', String(input.customer), 'INV-OLD.pdf'),
    capturedAt: input.pending ? undefined : new Date('2026-01-02T00:00:00.000Z'),
    refunds: input.pending
      ? []
      : [{
          amount: 10,
          reason: 'Goodwill refund',
          refundedAt: new Date('2026-01-05T00:00:00.000Z'),
          source: 'platform',
          status: 'succeeded',
        }],
    metadata: { bookingId: String(bookingId) },
  });
};

const markLegacyAnonymized = async (userId: Types.ObjectId) =>
  User.updateOne(
    { _id: userId },
    {
      $set: {
        name: '[deleted user]',
        email: `deleted-${userId}@anon.local`,
        phone: `DELETED-${userId}`,
        deletedAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    },
  );

const createSupportTicket = async (  userId: Types.ObjectId,
  ticketNumber?: string,
  options: {
    kind?: "ticket" | "meeting";
    meetingStatus?: "pending" | "scheduled" | "declined" | "cancelled" | "completed";
    replies?: Array<{ authorId: Types.ObjectId; authorRole: "customer" | "professional" | "admin"; body: string }>;
  } = {},
) => {
  const key = `support-attachments/${userId}/private.pdf`;
  const kind = options.kind || "meeting";
  return SupportTicket.create({
    userId,
    ...(ticketNumber ? { ticketNumber } : {}),
    kind,
    subject: 'Private support subject',
    description: 'Private support description',
    reason: 'technical_problem',
    userType: 'professional',
    locale: 'en',
    status: 'open',
    replies: options.replies || [{
      authorId: userId,
      authorRole: 'professional',
      body: 'Private support reply',
      createdAt: new Date(),
    }],
    attachment: {
      key,
      url: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${key}`,
      name: 'private.pdf',
      mimeType: 'application/pdf',
      size: 10,
    },
    ...(kind === "meeting"
      ? {
          meeting: {
            status: options.meetingStatus || 'completed',
            scheduledAt: new Date('2030-11-04T08:30:00.000Z'),
            durationMinutes: 30,
            timeZone: 'Europe/Brussels',
          },
        }
      : {}),
  });
};

const createChat = async (customer: Types.ObjectId, professional: Types.ObjectId) => {
  const conversation = await Conversation.create({
    type: 'direct',
    customerId: customer,
    professionalId: professional,
    initiatedBy: customer,
    status: 'active',
    customerUnreadCount: 0,
    professionalUnreadCount: 0,
  });
  const key = `chat/${conversation._id}/${customer}/chat.pdf`;
  await ChatMessage.create({
    conversationId: conversation._id,
    senderId: customer,
    senderRole: 'customer',
    text: 'Private chat text from Carla.',
    images: [s3Url('chat', String(customer), 'image.jpg')],
    attachments: [{
      url: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${key}`,
      fileName: 'chat.pdf',
      fileType: 'document',
      mimeType: 'application/pdf',
    }],
    readBy: [{ userId: customer, readAt: new Date() }],
  });
  await ChatMessage.create({
    conversationId: conversation._id,
    senderId: professional,
    senderRole: 'professional',
    text: 'Counterparty chat text stays.',
    images: [],
    attachments: [],
    readBy: [{ userId: professional, readAt: new Date() }],
  });
  return conversation;
};

const cleanDb = async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
  invalidateFavoritesOverviewCache();
  s3.deleteCalls.length = 0;
  s3.failKeys.clear();
  s3.presignCalls.length = 0;
  s3.uploadCalls.length = 0;
  notifyGate.beforeNext = null;
  notifyGate.lastArgs = null;
};

/**
 * Hold the Nth matching Mongoose query after its snapshot was read, run the
 * concurrent action, then release the stale result. This reproduces a request
 * that passed authentication and loaded its document before the tombstone.
 */
const pauseNthQuery = (
  modelName: string,
  match: (query: any) => boolean,
  occurrence = 1,
) => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let markReached: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const originalExec = mongoose.Query.prototype.exec;
  let seen = 0;
  const spy = vi.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(function (
    this: any,
    ...args: any[]
  ) {
    if (
      this?.model?.modelName === modelName
      && seen < occurrence
      && match(this)
    ) {
      seen += 1;
      if (seen === occurrence) {
        // Finish the stale read first, then delay only its delivery. Starting
        // the command without awaiting it can let the anonymization commit
        // before the driver actually takes the read snapshot.
        return (async () => {
          const staleResult = await originalExec.apply(this, args);
          markReached();
          await hold;
          return staleResult;
        })();
      }
    }
    return originalExec.apply(this, args);
  } as any);
  return {
    reached,
    release,
    restore: () => spy.mockRestore(),
  };
};

const pauseUserRead = (userId: string | Types.ObjectId) =>
  pauseNthQuery(
    'User',
    (query) => String(query.getFilter?.()?._id || '') === String(userId),
    2,
  );

const pauseFirstUserRead = (userId: string | Types.ObjectId) =>
  pauseNthQuery(
    'User',
    (query) => String(query.getFilter?.()?._id || '') === String(userId),
    1,
  );

const pauseBookingRead = (bookingId: string | Types.ObjectId) =>
  pauseNthQuery(
    'Booking',
    (query) => String(query.getFilter?.()?._id || '') === String(bookingId),
    1,
  );

beforeAll(async () => {
  if (!hasDisposableMongo) return;
  await mongoose.connect(testUri!, { dbName: 'fixera_admin_anonymize_test' });
  await Promise.all([
    User.createIndexes(),
    AccountDataGuard.createIndexes(),
    AuditLog.createIndexes(),
    Booking.createIndexes(),
    Payment.createIndexes(),
    Project.createIndexes(),
    SupportTicket.createIndexes(),
    Conversation.createIndexes(),
    ChatMessage.createIndexes(),
    Meeting.createIndexes(),
    MeetingRequest.createIndexes(),
    CalendarReservation.createIndexes(),
    Referral.createIndexes(),
    MarketingSubscriber.createIndexes(),
    MarketingSuppression.createIndexes(),
    MarketingLead.createIndexes(),
    Notification.createIndexes(),
    EmailLog.createIndexes(),
  ]);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/user', userRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/professionals', professionalRouter);
  app.use('/api/support', supportRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/bookings', bookingRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/quotations', quotationRouter);
  app.use('/api/warranty-claims', warrantyRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  if (!hasDisposableMongo) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  if (!hasDisposableMongo) return;
  await cleanDb();
  adminUser = await createAdmin();
  superCookie = jwtCookie(adminUser);
});

describeDb('admin account anonymization', () => {
  it('previews from live data without mutating the account or its records', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      attachments: [s3Url('rfq-attachments', String(target._id), 'rfq.pdf')],
    });
    await createPayment({ booking, customer: target._id, professional: professional._id });
    const ticket = await createSupportTicket(target._id);
    await createChat(target._id, professional._id);

    const beforeUser = await User.findById(target._id).lean();
    const beforeTicket = await SupportTicket.findById(ticket._id).lean();
    const beforeBooking = await Booking.findById(booking._id).lean();
    const beforeGuard = await AccountDataGuard.countDocuments({});

    const preview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );

    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('eligible');
    expect(preview.body.data.eligible).toBe(true);
    expect(preview.body.data.alreadyAnonymized).toBe(false);
    expect(preview.body.data.blockers).toEqual([]);
    expect(preview.body.data.confirmation.requiredText).toBe('ANONYMIZE');
    expect(preview.body.data.impact.bookings.total).toBe(1);
    expect(preview.body.data.impact.supportTickets).toBe(1);
    expect(preview.body.data.impact.chatMessages).toBe(1);
    expect(preview.body.data.retained.some((entry: any) => entry.category === 'invoices')).toBe(true);
    expect(preview.body.data.target.isAnonymized).toBe(false);
    expect(preview.body.data.cleanup.pendingFiles).toBe(0);

    const afterUser = await User.findById(target._id).lean();
    expect(afterUser?.name).toBe(beforeUser?.name);
    expect(afterUser?.email).toBe(beforeUser?.email);
    expect(afterUser?.deletedAt ?? null).toBe(beforeUser?.deletedAt ?? null);
    expect(await SupportTicket.findById(ticket._id).lean()).toMatchObject({
      subject: beforeTicket?.subject,
      description: beforeTicket?.description,
    });
    const afterBooking = await Booking.findById(booking._id).lean();
    expect(afterBooking?.status).toBe(beforeBooking?.status);
    expect(afterBooking?.rfqData?.attachments).toEqual(beforeBooking?.rfqData?.attachments);
    expect(await AccountDataGuard.countDocuments({})).toBe(beforeGuard);
  });

  it('requires effective users.delete and validates the target and confirmation', async () => {
    const target = await createTarget('customer');
    const adminTarget = await createAdmin({ email: 'other-admin@example.com' });

    const readOnlyAdmin = await createAdmin({
      email: 'read-only-admin@example.com',
      adminRole: 'care',
      adminPermissionLevels: { user_delete: 'read' },
    });
    const readOnlyCookie = jwtCookie(readOnlyAdmin);

    const lowPreview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: readOnlyCookie },
    );
    expect(lowPreview.status).toBe(403);
    expect(lowPreview.body.code).toBe('ADMIN_PERMISSION_DENIED');

    const lowExecute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: readOnlyCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(lowExecute.status).toBe(403);

    const nonAdminCookie = jwtCookie(target);
    const nonAdmin = await request(
      'GET',
      `/api/admin/users/${adminTarget._id}/anonymize/preview`,
      { cookie: nonAdminCookie },
    );
    expect(nonAdmin.status).toBe(403);

    const invalid = await request(
      'GET',
      '/api/admin/users/not-an-id/anonymize/preview',
      { cookie: superCookie },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION');

    const missing = await request(
      'GET',
      `/api/admin/users/${new Types.ObjectId()}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');

    const badConfirm = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'anonymize' } },
    );
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.code).toBe('INVALID_CONFIRMATION');

    const adminTargetPreview = await request(
      'GET',
      `/api/admin/users/${adminTarget._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(adminTargetPreview.status).toBe(200);
    expect(adminTargetPreview.body.data.status).toBe('blocked');
    expect(adminTargetPreview.body.data.blockers).toEqual([
      expect.objectContaining({ code: 'ADMIN_TARGET' }),
    ]);

    const adminTargetExecute = await request(
      'PUT',
      `/api/admin/users/${adminTarget._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(adminTargetExecute.status).toBe(403);
    expect(adminTargetExecute.body.code).toBe('ADMIN_TARGET');

    const selfExecute = await request(
      'PUT',
      `/api/admin/users/${adminUser._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(selfExecute.status).toBe(403);
    expect(selfExecute.body.code).toBe('SELF_TARGET');

    expect((await User.findById(target._id).lean())?.deletedAt ?? null).toBeNull();
  });

  it('rejects active bookings, disputes, warranty, cancellation, and payment obligations', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'dispute',
      extra: {
        dispute: {
          raisedBy: target._id,
          reason: 'Scope',
          description: 'Open dispute',
          raisedAt: new Date(),
        },
      },
    });
    await createPayment({ booking, customer: target._id, professional: professional._id, pending: true });
    const refundBooking = await createBooking({
      customer: target._id,
      professional: professional._id,
    });
    await Payment.create({
      booking: refundBooking._id,
      bookingNumber: refundBooking.bookingNumber,
      customer: target._id,
      professional: professional._id,
      status: 'completed',
      currency: 'EUR',
      amount: 100,
      totalWithVat: 121,
      refunds: [{
        amount: 10,
        source: 'platform',
        status: 'requires_action',
        refundedAt: new Date(),
      }],
    });
    await mongoose.connection.collection('warrantyclaims').insertOne({
      booking: booking._id,
      customer: target._id,
      professional: professional._id,
      status: 'open',
      reason: 'defect',
      description: 'Open warranty',
      evidence: [],
      openedAt: new Date(),
      statusHistory: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mongoose.connection.collection('cancellationrequests').insertOne({
      booking: booking._id,
      requestedBy: target._id,
      requestedRole: 'customer',
      reasonCategory: 'other',
      reason: 'Open cancellation',
      evidence: [],
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const preview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('blocked');
    expect(preview.body.data.impact.refunds.pending).toBe(1);
    expect(preview.body.data.blockers.map((entry: any) => entry.code)).toEqual(
      expect.arrayContaining([
        'ACTIVE_BOOKINGS',
        'ACTIVE_DISPUTES',
        'ACTIVE_WARRANTY_CLAIMS',
        'ACTIVE_CANCELLATION_REQUESTS',
        'PAYMENT_OBLIGATIONS',
      ]),
    );

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(409);
    expect(execute.body.code).toBe('ANONYMIZE_BLOCKED');
    expect(execute.body.blockers.length).toBeGreaterThan(0);

    const stored = await User.findById(target._id).lean();
    expect(stored?.name).toBe('Carla Customer');
    expect(stored?.deletedAt ?? null).toBeNull();
    expect(stored?.isAnonymized).toBe(false);
    expect(await AccountDataGuard.countDocuments({})).toBe(0);
  });

  it('anonymizes a customer while retaining financial records and counterparty content', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const otherCustomer = await createTarget('customer');
    const targetRfqKey = `rfq-attachments/${target._id}/rfq.pdf`;
    const otherRfqKey = `rfq-attachments/${otherCustomer._id}/other.pdf`;
    const targetReviewKey = `review-images/${target._id}/review.jpg`;
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      targetReview: true,
      attachments: [
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/${targetRfqKey}`,
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/${otherRfqKey}`,
        s3Url('invoices', String(target._id), 'INV-OLD.pdf'),
      ],
    });
    const payment = await createPayment({
      booking,
      customer: target._id,
      professional: professional._id,
    });
    const ticket = await createSupportTicket(target._id, undefined, {
      replies: [
        { authorId: target._id, authorRole: 'customer', body: 'Private target support reply' },
        { authorId: professional._id, authorRole: 'professional', body: 'Counterparty support reply stays' },
        { authorId: adminUser._id, authorRole: 'admin', body: 'Admin support reply stays' },
      ],
    });
    await SupportTicket.updateOne(
      { _id: ticket._id },
      {
        $set: {
          booking: {
            bookingId: booking._id,
            bookingNumber: booking.bookingNumber,
            projectTitle: 'Bathroom work',
            counterpartyName: 'Counterparty Business',
            label: `${booking.bookingNumber} - Bathroom work - Counterparty Business`,
          },
        },
      },
    );
    await SupportTicketInternalNote.create({
      ticketId: ticket._id,
      adminId: adminUser._id,
      body: 'Admin internal note stays',
    });
    const otherTicket = await createSupportTicket(otherCustomer._id);
    await createChat(target._id, professional._id);
    const targetChatMessage = await ChatMessage.findOne({ senderId: target._id }).lean();
    const targetChatAttachmentKey = new URL(
      String(targetChatMessage?.attachments?.[0]?.url),
    ).pathname.slice(1);
    expect(targetChatAttachmentKey).toContain(String(target._id));
    const targetProfileKey = `profile-images/${target._id}/profile.jpg`;
    const targetIdKey = `id-proof/${target._id}/id.pdf`;
    await User.updateOne(
      { _id: target._id },
      {
        $set: {
          profileImage: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${targetProfileKey}`,
          idProofUrl: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${targetIdKey}`,
          idProofFileName: targetIdKey,
          fcmTokens: [{ token: 'token-1', origin: 'https://app.example' }],
          marketingConsentAt: new Date(),
        },
      },
    );
    const subscriber = await MarketingSubscriber.create({
      email: 'marketing-target@example.com',
      emailNormalized: 'marketing-target@example.com',
      userId: target._id,
      role: 'customer',
      locale: 'en',
      unsubscribeToken: `unsub-${new Types.ObjectId()}`,
      source: 'user_sync',
    });
    const leadEmail = String(target.email).toLowerCase();
    const lead = await MarketingLead.create({
      email: leadEmail,
      emailNormalized: leadEmail,
      country: 'BE',
      locale: 'nl',
      serviceKeys: ['plumbing'],
      primaryServiceKey: 'plumbing',
      interestedServices: ['Plumbing'],
      identityHash: `anonymize-${new Types.ObjectId()}`,
      status: 'active',
    });
    await Notification.create({
      userId: target._id,
      eventKey: 'test.event',
      category: 'system',
      title: 'Private notification',
      body: 'Private body',
      clickUrl: '/private',
    });
    await EmailLog.create({
      to: 'old-customer-email@example.com',
      subject: 'Private subject',
      template: 'test',
      status: 'sent',
      relatedUser: target._id,
      relatedBooking: booking._id,
    });
    const oldEmail = String((await User.findById(target._id).lean())?.email);
    const targetSession = jwtCookie(target);

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize?reason=query-discarded-reason`,
      {
        cookie: superCookie,
        body: { confirm: 'ANONYMIZE', reason: 'this discarded reason must not be stored' },
      },
    );

    expect(execute.status).toBe(200);
    expect(execute.body.data.outcome).toBe('anonymized');
    expect(execute.body.data.fullyAnonymized).toBe(true);
    expect(execute.body.data.cleanup.pendingFiles).toBe(0);

    const storedUser = await User.findById(target._id).select('+password +fcmTokens').lean();
    expect(storedUser).toMatchObject({
      name: '[deleted user]',
      role: 'customer',
      isAnonymized: true,
      accountStatus: 'rejected',
    });
    expect(storedUser?.email).not.toBe(oldEmail);
    expect(String(storedUser?.email)).toMatch(/^deleted-[a-f0-9]{24}@anon\.local$/);
    expect(String(storedUser?.phone)).toMatch(/^DELETED-/);
    expect(storedUser?.password).toBeUndefined();
    expect(storedUser?.username).toBeUndefined();
    expect(storedUser?.profileImage).toBeUndefined();
    expect(storedUser?.idProofUrl).toBeUndefined();
    expect(storedUser?.fcmTokens).toEqual([]);
    expect(storedUser?.deletedAt).toBeInstanceOf(Date);

    const guard = await AccountDataGuard.findById(target._id).lean();
    expect(guard?.state).toBe('anonymized');
    expect(guard?.externalCleanup?.pendingKeys).toEqual([]);

    const storedTicket = await SupportTicket.findById(ticket._id).lean();
    expect(storedTicket?.subject).toBe('[deleted]');
    expect(storedTicket?.description).toBe('[deleted]');
    expect(storedTicket?.replies?.map((reply: any) => reply.body)).toEqual([
      '[deleted]',
      'Counterparty support reply stays',
      'Admin support reply stays',
    ]);
    expect(storedTicket?.attachment).toBeUndefined();
    expect(storedTicket?.booking?.counterpartyName).toBe('Counterparty Business');
    expect(await SupportTicketInternalNote.countDocuments({ ticketId: ticket._id })).toBe(1);
    const untouchedTicket = await SupportTicket.findById(otherTicket._id).lean();
    expect(untouchedTicket?.subject).toBe('Private support subject');
    expect(untouchedTicket?.description).toBe('Private support description');

    const conversation = await Conversation.findOne({ customerId: target._id }).lean();
    const messages = await ChatMessage.find({ conversationId: conversation?._id }).lean();
    const targetMessage = messages.find((message) => String(message.senderId) === String(target._id));
    const professionalMessage = messages.find((message) => String(message.senderId) === String(professional._id));
    expect(targetMessage?.text).toBe('[deleted message]');
    expect(targetMessage?.images).toEqual([]);
    expect(targetMessage?.attachments).toEqual([]);
    expect(professionalMessage?.text).toBe('Counterparty chat text stays.');

    const storedBooking = await Booking.findById(booking._id).lean();
    expect(storedBooking?.bookingSnapshot?.parties?.customer?.displayName).toBe('[deleted user]');
    expect(storedBooking?.bookingSnapshot?.parties?.customer?.businessName).toBeNull();
    expect(storedBooking?.bookingSnapshot?.location?.address).toBe('[deleted]');
    expect(storedBooking?.location?.address).toBe('[deleted]');
    expect(storedBooking?.rfqData?.attachments).toEqual([
      `https://${BUCKET}.s3.us-east-1.amazonaws.com/${otherRfqKey}`,
      s3Url('invoices', String(target._id), 'INV-OLD.pdf'),
    ]);
    expect(storedBooking?.customerReview?.comment).toBeUndefined();
    expect(storedBooking?.customerReview?.images).toEqual([]);
    expect(storedBooking?.messages?.find((message: any) => message.senderId.toString() === String(target._id))?.message)
      .toBe('[deleted message]');
    expect(storedBooking?.payment?.amount).toBe(100);
    expect(storedBooking?.payment?.totalWithVat).toBe(121);

    const storedPayment = await Payment.findById(payment._id).lean();
    expect(storedPayment?.amount).toBe(100);
    expect(storedPayment?.totalWithVat).toBe(121);
    expect(storedPayment?.invoiceNumber).toBe('INV-OLD');
    expect(storedPayment?.invoiceUrl).toBe(s3Url('invoices', String(target._id), 'INV-OLD.pdf'));
    expect(storedPayment?.refunds).toHaveLength(1);
    expect(storedPayment?.refunds[0]?.amount).toBe(10);

    expect(await MarketingSubscriber.findById(subscriber._id)).toBeNull();
    expect(await MarketingLead.findById(lead._id)).toBeNull();
    expect(await Notification.countDocuments({ userId: target._id })).toBe(0);
    const storedEmailLog = await EmailLog.findOne({ relatedUser: target._id }).lean();
    expect(storedEmailLog?.to).toMatch(/^deleted-/);
    expect(storedEmailLog?.subject).toBe('[deleted]');

    const deleted = new Set(s3.deleteCalls);
    expect(deleted.has(targetProfileKey)).toBe(true);
    expect(deleted.has(targetIdKey)).toBe(true);
    expect(deleted.has(targetRfqKey)).toBe(true);
    expect(deleted.has(`support-attachments/${target._id}/private.pdf`)).toBe(true);
    expect(deleted.has(`review-images/${target._id}/review.jpg`)).toBe(true);
    expect(deleted.has(targetChatAttachmentKey)).toBe(true);
    expect(deleted.has(otherRfqKey)).toBe(false);
    expect(deleted.has(s3Url('invoices', String(target._id), 'INV-OLD.pdf'))).toBe(false);

    const audit = await AuditLog.findOne({
      action: 'admin.users.anonymize',
      targetId: target._id,
      status: 'success',
    }).lean();
    expect(audit).toBeTruthy();
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain('Carla Customer');
    expect(auditText).not.toContain(oldEmail);
    expect(auditText).not.toContain('Old Street 1');
    expect(auditText).not.toContain('this discarded reason must not be stored');
    expect(auditText).not.toContain('query-discarded-reason');

    const detail = await request(
      'GET',
      `/api/admin/bookings/${booking._id}/full`,
      { cookie: superCookie },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.details.parties.customer).toMatchObject({
      name: '[deleted user]',
      email: null,
      phone: null,
      isAnonymized: true,
    });
    expect(detail.body.data.details.parties.customer.address).toBeNull();
    expect(detail.body.data.payment.invoiceUrl).toBe(
      s3Url('invoices', String(target._id), 'INV-OLD.pdf'),
    );
    expect(JSON.stringify(detail.body.data.details)).not.toContain('Carla Customer');
    expect(JSON.stringify(detail.body.data.details)).not.toContain('Old Street 1');
    expect(JSON.stringify(detail.body.data.details.activity)).toContain('[deleted user]');

    const customers = await request(
      'GET',
      '/api/admin/customers/manage',
      { cookie: superCookie },
    );
    expect(customers.status).toBe(200);
    expect(customers.body.data.customers.some(
      (entry: any) => String(entry._id) === String(target._id),
    )).toBe(false);

    const login = await request('POST', '/api/auth/login', {
      cookie: null,
      body: { email: oldEmail, password: 'target-pass-123' },
    });
    expect(login.status).toBe(401);

    const me = await request('GET', '/api/auth/me', { cookie: targetSession });
    expect(me.status).toBe(403);

    await expect(assertSupportAccountWritable(target._id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('anonymizes a professional and removes public project exposure while keeping booking facts', async () => {
    const professional = await createTarget('professional');
    const customer = await createTarget('customer');
    const projectId = new Types.ObjectId();
    const projectImageKey = `projects/${projectId}/image/${professional._id}/cover.jpg`;
    const certificationKey = `certifications/${professional._id}/cert.pdf`;
    const planKey = `projects/${projectId}/attachment/${professional._id}/plan.pdf`;
    await Project.collection.insertOne({
      _id: projectId,
      professionalId: professional._id,
      category: 'Renovation',
      service: 'Bathroom',
      description: 'Bathroom service description',
      priceModel: 'fixed',
      keywords: [],
      title: 'Bathroom service',
      media: { images: [`https://${BUCKET}.s3.us-east-1.amazonaws.com/${projectImageKey}`] },
      certifications: [{
        name: 'Certification',
        fileUrl: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${certificationKey}`,
        uploadedAt: new Date(),
        isRequired: false,
      }],
      distance: {
        address: 'Old Company Street 1',
        countryCode: 'BE',
        useCompanyAddress: true,
        maxKmRange: 30,
        noBorders: false,
        location: { type: 'Point', coordinates: [3.7, 51.05] },
      },
      resources: [],
      intakeMeeting: { enabled: false, resources: [] },
      renovationPlanning: { fixeraManaged: false, resources: [] },
      subprojects: [],
      extraOptions: [],
      termsConditions: [],
      faq: [],
      rfqQuestions: [{
        question: 'Upload plan',
        type: 'attachment',
        isRequired: false,
        professionalAttachments: [`https://${BUCKET}.s3.us-east-1.amazonaws.com/${planKey}`],
      }],
      postBookingQuestions: [],
      status: 'published',
      qualityChecks: [],
      autoSaveTimestamp: new Date(),
      currentStep: 8,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
    });
    await createPayment({ booking, customer: customer._id, professional: professional._id });

    const execute = await request(
      'PUT',
      `/api/admin/users/${professional._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );

    expect(execute.status).toBe(200);
    expect(execute.body.data.fullyAnonymized).toBe(true);

    const storedUser = await User.findById(professional._id).lean();
    expect(storedUser?.name).toBe('[deleted user]');
    expect(storedUser?.professionalStatus).toBe('rejected');
    expect(storedUser?.businessInfo).toBeUndefined();

    const storedProject = await Project.findById(projectId).lean();
    expect(storedProject?.status).toBe('suspended');
    expect(storedProject?.media?.images).toEqual([]);
    expect(storedProject?.certifications).toEqual([]);
    expect(storedProject?.rfqQuestions?.[0]?.professionalAttachments).toEqual([]);
    expect(storedProject?.distance?.address).toBe('[deleted]');
    expect(storedProject?.distance?.location).toBeUndefined();

    const storedBooking = await Booking.findById(booking._id).lean();
    expect(storedBooking?.bookingSnapshot?.parties?.professional?.displayName).toBe('[deleted user]');
    expect(storedBooking?.bookingSnapshot?.parties?.professional?.companyName).toBeNull();
    expect(storedBooking?.bookingSnapshot?.project?.media).toBeUndefined();
    expect(storedBooking?.bookingSnapshot?.questions?.rfq?.[0]?.professionalAttachments).toEqual([]);
    expect(storedBooking?.location?.address).toBe('Old Street 1');
    expect(storedBooking?.bookingSnapshot?.parties?.customer?.displayName).toBe('Carla Customer');
    expect(storedBooking?.payment?.totalWithVat).toBe(121);

    const deleted = new Set(s3.deleteCalls);
    expect(deleted.has(projectImageKey)).toBe(true);
    expect(deleted.has(certificationKey)).toBe(true);
    expect(deleted.has(planKey)).toBe(true);
  });

  it('reports a partial cleanup and retries it on a repeated confirmed request', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
    });
    const profileKey = `profile-images/${target._id}/profile.jpg`;
    await User.updateOne(
      { _id: target._id },
      { $set: { profileImage: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${profileKey}` } },
    );
    s3.failKeys.add(profileKey);

    const first = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(first.status).toBe(200);
    expect(first.body.data.outcome).toBe('partially_completed');
    expect(first.body.data.fullyAnonymized).toBe(false);
    expect(first.body.data.cleanup.pendingFiles).toBe(1);
    expect((await User.findById(target._id).lean())?.isAnonymized).toBe(true);
    expect((await AccountDataGuard.findById(target._id).lean())?.state).toBe('anonymizing');

    const preview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.alreadyAnonymized).toBe(true);
    expect(preview.body.data.fullyAnonymized).toBe(false);
    expect(preview.body.data.cleanup.pendingFiles).toBe(1);

    s3.failKeys.clear();
    const retry = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.data.outcome).toBe('already_anonymized');
    expect(retry.body.data.fullyAnonymized).toBe(true);
    expect(retry.body.data.cleanup.pendingFiles).toBe(0);
    expect(s3.deleteCalls).toContain(profileKey);
    expect((await AccountDataGuard.findById(target._id).lean())?.state).toBe('anonymized');

    const again = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(again.status).toBe(200);
    expect(again.body.data.outcome).toBe('already_anonymized');
    expect(again.body.data.fullyAnonymized).toBe(true);

    expect(await Booking.countDocuments({ _id: booking._id })).toBe(1);
    expect((await Booking.findById(booking._id).lean())?.status).toBe('completed');
  });

  it('completes legacy anonymized accounts instead of claiming they are fully redacted', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
    });
    const profileKey = `profile-images/${target._id}/legacy.jpg`;
    await User.updateOne(
      { _id: target._id },
      {
        $set: {
          name: '[deleted user]',
          email: `deleted-${target._id}@anon.local`,
          phone: `DELETED-${target._id}`,
          deletedAt: new Date('2025-01-01T00:00:00.000Z'),
          profileImage: `https://${BUCKET}.s3.us-east-1.amazonaws.com/${profileKey}`,
        },
      },
    );

    const preview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('recovery_required');
    expect(preview.body.data.alreadyAnonymized).toBe(false);
    expect(preview.body.data.target.legacyAnonymized).toBe(true);
    expect(preview.body.data.eligible).toBe(true);
    expect(preview.body.data.fullyAnonymized).toBe(false);

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    expect(execute.body.data.outcome).toBe('anonymized');
    expect(execute.body.data.fullyAnonymized).toBe(true);
    const storedUser = await User.findById(target._id).lean();
    expect(storedUser?.isAnonymized).toBe(true);
    expect(storedUser?.deletedAt?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    const storedBooking = await Booking.findById(booking._id).lean();
    expect(storedBooking?.bookingSnapshot?.parties?.customer?.displayName).toBe('[deleted user]');
    expect(storedBooking?.bookingSnapshot?.location?.address).toBe('[deleted]');
    expect(s3.deleteCalls).toContain(profileKey);
  });

  it('keeps the self-service deletion flow and redacts the self audit actor', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({
      customer: target._id,
      professional: professional._id,
    });
    const ticket = await createSupportTicket(target._id);
    const targetCookie = jwtCookie(target);
    const oldEmail = String((await User.findById(target._id).lean())?.email);

    const response = await request('DELETE', '/api/user/me/account', {
      cookie: targetCookie,
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const stored = await User.findById(target._id).select('+password').lean();
    expect(stored?.isAnonymized).toBe(true);
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(stored?.name).toBe('[deleted user]');
    expect(stored?.password).toBeUndefined();
    expect((await SupportTicket.findById(ticket._id).lean())?.subject).toBe('[deleted]');
    const audit = await AuditLog.findOne({ action: 'user.anonymize', targetId: target._id }).lean();
    expect(audit).toBeTruthy();
    expect(audit?.actorEmail).toMatch(/^deleted-/);
    expect(audit?.actorEmail).not.toBe(oldEmail);
    expect(audit?.ip).toBeUndefined();
    expect(audit?.userAgent).toBeUndefined();
  });

  it('keeps legacy recovery blocked by real active bookings and payment obligations', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await markLegacyAnonymized(target._id);
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'booked',
    });
    await createPayment({
      booking,
      customer: target._id,
      professional: professional._id,
      pending: true,
    });

    const preview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('blocked');
    expect(preview.body.data.eligible).toBe(false);
    expect(preview.body.data.target).toMatchObject({
      isAnonymized: true,
      identityRemoved: true,
      legacyAnonymized: true,
      name: null,
      email: null,
    });
    expect(preview.body.data.blockers.map((entry: any) => entry.code)).toEqual(
      expect.arrayContaining(['ACTIVE_BOOKINGS', 'PAYMENT_OBLIGATIONS']),
    );

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(409);
    expect(execute.body.code).toBe('ANONYMIZE_BLOCKED');
    expect((await Booking.findById(booking._id).lean())?.status).toBe('booked');
    expect((await User.findById(target._id).lean())?.isAnonymized ?? false).toBe(false);
  });

  it('redacts target-authored booking history and rejection text while retaining financial facts', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      extra: {
        statusHistory: [
          {
            status: 'completed',
            timestamp: new Date('2026-01-02T00:00:00.000Z'),
            updatedBy: target._id,
            note: 'Call me at +32 499 12 34 56, 12 Private Street',
          },
          {
            status: 'completed',
            timestamp: new Date('2026-01-03T00:00:00.000Z'),
            updatedBy: professional._id,
            note: 'Professional completion note stays',
          },
        ],
        customerRejectionReason: 'My private email is target@example.com',
        rfqResponse: {
          action: 'rejected',
          respondedAt: new Date('2026-01-04T00:00:00.000Z'),
          respondedBy: professional._id,
          rejectionReason: 'Professional rejection note stays',
        },
        quoteVersions: [{
          version: 1,
          quotationNumber: 'QUO-PRIVATE-1',
          scope: 'Bathroom renovation scope',
          warrantyDuration: { value: 1, unit: 'years' },
          materialsIncluded: true,
          description: 'Quotation description',
          totalAmount: 450,
          currency: 'EUR',
          preparationDuration: { value: 1, unit: 'days' },
          executionDuration: { value: 3, unit: 'days' },
          validUntil: new Date('2026-02-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-05T00:00:00.000Z'),
          createdBy: professional._id,
          changeNote: 'Professional change note stays',
          rejectedAt: new Date('2026-01-06T00:00:00.000Z'),
          rejectedBy: target._id,
          rejectionReason: 'Target phone +32 499 12 34 56',
          serviceLocation: {
            address: '12 Private Street',
            city: 'Brussels',
            postalCode: '1000',
            country: 'BE',
            coordinates: [4.35, 50.85],
          },
        }],
      },
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    expect(execute.body.data.fullyAnonymized).toBe(true);

    const stored = await Booking.findById(booking._id).lean();
    expect(stored?.statusHistory?.map((entry: any) => entry.note)).toEqual([
      '[deleted]',
      'Professional completion note stays',
    ]);
    expect(stored?.customerRejectionReason).toBe('[deleted]');
    expect(stored?.rfqResponse?.rejectionReason).toBe('Professional rejection note stays');
    expect(stored?.quoteVersions?.[0]).toMatchObject({
      quotationNumber: 'QUO-PRIVATE-1',
      totalAmount: 450,
      currency: 'EUR',
      changeNote: 'Professional change note stays',
      rejectionReason: '[deleted]',
    });
    expect(stored?.quoteVersions?.[0]?.serviceLocation?.address).toBe('[deleted]');
    expect(JSON.stringify(stored)).not.toContain('12 Private Street');
    expect(JSON.stringify(stored)).not.toContain('+32 499 12 34 56');
    expect(JSON.stringify(stored)).not.toContain('target@example.com');

    const detail = await request(
      'GET',
      `/api/admin/bookings/${booking._id}/full`,
      { cookie: superCookie },
    );
    expect(detail.status).toBe(200);
    const rawBooking = detail.body.data.booking;
    expect(JSON.stringify(rawBooking)).not.toContain('+32 499 12 34 56');
    expect(JSON.stringify(rawBooking)).not.toContain('12 Private Street');
    expect(detail.body.data.details.quotation.current?.totalAmount ?? 450).toBe(450);
    expect(JSON.stringify(detail.body.data.details)).not.toContain('+32 499 12 34 56');
  });

  it('masks legacy booking and public project identity before recovery runs', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    await markLegacyAnonymized(customer._id);
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      extra: {
        statusHistory: [{
          status: 'completed',
          timestamp: new Date('2026-01-02T00:00:00.000Z'),
          updatedBy: customer._id,
          note: 'Legacy customer note at 12 Private Street',
        }],
        customerRejectionReason: 'Legacy customer private reason',
      },
    });

    const adminDetail = await request(
      'GET',
      `/api/admin/bookings/${booking._id}/full`,
      { cookie: superCookie },
    );
    expect(adminDetail.status).toBe(200);
    expect(adminDetail.body.data.booking.bookingSnapshot?.parties?.customer?.displayName)
      .toBe('[deleted user]');
    expect(adminDetail.body.data.booking.bookingSnapshot?.parties?.customer?.businessName)
      .toBeNull();
    expect(adminDetail.body.data.booking.bookingSnapshot?.location?.address).toBe('[deleted]');
    expect(adminDetail.body.data.booking.location?.address).toBe('[deleted]');
    expect(adminDetail.body.data.booking.statusHistory?.[0]?.note).toBe('[deleted]');
    expect(adminDetail.body.data.booking.customerRejectionReason).toBe('[deleted]');
    expect(adminDetail.body.data.details.parties.customer.name).toBe('[deleted user]');
    expect(adminDetail.body.data.details.parties.customer.address).toBeNull();
    expect(JSON.stringify(adminDetail.body.data)).not.toContain('Carla Customer');
    expect(JSON.stringify(adminDetail.body.data)).not.toContain('12 Private Street');

    const professionalCookie = jwtCookie(professional);
    const participantRaw = await request(
      'GET',
      `/api/bookings/${booking._id}`,
      { cookie: professionalCookie },
    );
    expect(participantRaw.status).toBe(200);
    expect(JSON.stringify(participantRaw.body.booking)).not.toContain('Carla Customer');
    expect(JSON.stringify(participantRaw.body.booking)).not.toContain('12 Private Street');

    const participantList = await request(
      'GET',
      '/api/bookings/my-bookings',
      { cookie: professionalCookie },
    );
    expect(participantList.status).toBe(200);
    expect(JSON.stringify(participantList.body.bookings)).not.toContain('Carla Customer');
    expect(JSON.stringify(participantList.body.bookings)).not.toContain('12 Private Street');

    const legacyProfessional = await createTarget('professional');
    await markLegacyAnonymized(legacyProfessional._id);
    const projectId = new Types.ObjectId();
    await Project.collection.insertOne({
      _id: projectId,
      professionalId: legacyProfessional._id,
      category: 'Renovation',
      service: 'Bathroom',
      description: 'Published legacy project',
      priceModel: 'fixed',
      keywords: [],
      title: 'Legacy published project',
      media: { images: [] },
      certifications: [],
      distance: { address: 'Old address', countryCode: 'BE', useCompanyAddress: false, maxKmRange: 30, noBorders: false },
      resources: [],
      intakeMeeting: { enabled: false, resources: [] },
      renovationPlanning: { fixeraManaged: false, resources: [] },
      subprojects: [],
      extraOptions: [],
      termsConditions: [],
      faq: [],
      rfqQuestions: [],
      postBookingQuestions: [],
      status: 'published',
      qualityChecks: [],
      autoSaveTimestamp: new Date(),
      currentStep: 8,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });

    const professionals = await request('GET', '/api/professionals', { cookie: null });
    expect(professionals.status).toBe(200);
    expect((professionals.body as any[]).some(
      (entry: any) => String(entry._id) === String(legacyProfessional._id),
    )).toBe(false);

    const published = await request('GET', `/api/public/projects/${projectId}`, { cookie: null });
    expect(published.status).toBe(404);

    const reviews = await request(
      'GET',
      `/api/public/professionals/${legacyProfessional._id}/reviews`,
      { cookie: null },
    );
    expect(reviews.status).toBe(404);
  });

  it('blocks pending support meetings, meeting requests, and project meetings', async () => {
    const target = await createTarget('professional');
    const customer = await createTarget('customer');
    await createSupportTicket(target._id, undefined, { meetingStatus: 'pending' });
    await MeetingRequest.create({
      userId: target._id,
      topic: 'Private meeting topic',
      preferredTimes: 'Tomorrow',
      durationMinutes: 30,
      status: 'pending',
    });
    await Meeting.create({
      projectId: String(new Types.ObjectId()),
      professionalId: target._id,
      meetingType: 'planning',
      title: 'Private project meeting',
      scheduledDate: new Date('2030-12-01T10:00:00.000Z'),
      startTime: '10:00',
      endTime: '10:30',
      duration: 30,
      attendees: [{ userId: String(customer._id), name: 'Carla Customer', role: 'professional', status: 'accepted' }],
      status: 'scheduled',
      createdBy: String(target._id),
    });

    const preview = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('blocked');
    const meetingBlocker = preview.body.data.blockers.find(
      (entry: any) => entry.code === 'ACTIVE_MEETINGS',
    );
    expect(meetingBlocker?.count).toBe(3);

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(409);
    expect(execute.body.code).toBe('ANONYMIZE_BLOCKED');
    expect((await Meeting.countDocuments({ professionalId: target._id }))).toBe(1);
  });

  it('treats a recorded professional payout without a settled transfer as a blocker', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
    });
    const payment = await createPayment({
      booking,
      customer: target._id,
      professional: professional._id,
    });
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { professionalPayout: 80 } },
    );

    const blocked = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(blocked.body.data.status).toBe('blocked');
    expect(blocked.body.data.blockers.some(
      (entry: any) => entry.code === 'PAYMENT_OBLIGATIONS',
    )).toBe(true);

    await Payment.updateOne(
      { _id: payment._id },
      { $set: { transferStatus: 'succeeded', stripeTransferId: 'tr_settled_1' } },
    );
    const eligible = await request(
      'GET',
      `/api/admin/users/${target._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(eligible.body.data.status).toBe('eligible');
    expect(eligible.body.data.blockers).toEqual([]);
  });

  it('lists partial cleanup across sessions and retries a failed calendar release', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({
      customer: target._id,
      professional: professional._id,
    });
    await createSupportTicket(target._id, undefined, { meetingStatus: 'completed' });

    const calendarSpy = vi.spyOn(CalendarReservation, 'deleteMany')
      .mockRejectedValue(new Error('calendar release failed'));
    try {
      const first = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(first.status).toBe(200);
      expect(first.body.data.outcome).toBe('partially_completed');
      expect(first.body.data.fullyAnonymized).toBe(false);
      expect(first.body.data.cleanup.pendingCalendarReleases).toBe(1);
    } finally {
      calendarSpy.mockRestore();
    }

    const recovery = await request(
      'GET',
      '/api/admin/users/anonymization/recovery',
      { cookie: superCookie },
    );
    expect(recovery.status).toBe(200);
    const listed = recovery.body.data.accounts.find(
      (entry: any) => entry.targetId === String(target._id),
    );
    expect(listed).toMatchObject({
      state: 'partial_cleanup',
      pendingCalendarReleases: 1,
    });
    expect(listed.name).toBeUndefined();
    expect(listed.email).toBeUndefined();
    expect(recovery.body.data.counts.partialCleanup).toBeGreaterThanOrEqual(1);

    const readOnlyAdmin = await createAdmin({
      email: 'recovery-read-only@example.com',
      adminRole: 'care',
      adminPermissionLevels: { user_delete: 'read' },
    });
    const denied = await request(
      'GET',
      '/api/admin/users/anonymization/recovery',
      { cookie: jwtCookie(readOnlyAdmin) },
    );
    expect(denied.status).toBe(403);

    const retry = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.data.outcome).toBe('already_anonymized');
    expect(retry.body.data.fullyAnonymized).toBe(true);

    const after = await request(
      'GET',
      '/api/admin/users/anonymization/recovery',
      { cookie: superCookie },
    );
    expect(after.body.data.accounts.some(
      (entry: any) => entry.targetId === String(target._id),
    )).toBe(false);
  });

  it('rejects a stale chat write after the target is tombstoned', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const conversation = await createChat(target._id, professional._id);

    const spy = vi.spyOn(User, 'countDocuments').mockImplementationOnce(((...args: any[]) => (
      (async () => {
        const anonymize = await request(
          'PUT',
          `/api/admin/users/${target._id}/anonymize`,
          { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
        );
        expect(anonymize.status).toBe(200);
        // Stale preflight result: pretend the counterparty was still active.
        return 0;
      })()
    )) as any);

    try {
      const send = await request(
        'POST',
        `/api/chat/conversations/${conversation._id}/messages`,
        {
          cookie: jwtCookie(professional),
          body: { text: 'Private target text after tombstone' },
        },
      );
      expect(send.status).toBe(409);
      expect(send.body.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    expect(await ChatMessage.countDocuments({
      text: 'Private target text after tombstone',
    })).toBe(0);
    const storedConversation = await Conversation.findById(conversation._id).lean();
    expect(String(storedConversation?.lastMessagePreview || '')).not.toContain(
      'Private target text after tombstone',
    );
  });

  it('rejects direct quotation creation for a locked customer even when a location survives', async () => {
    const professional = await createTarget('professional');
    const customer = await createTarget('customer');
    await User.updateOne(
      { _id: customer._id },
      { $set: { deletedAt: new Date('2025-01-01T00:00:00.000Z'), isAnonymized: true } },
    );
    const before = await Booking.countDocuments({});

    const response = await request(
      'POST',
      '/api/quotations/direct',
      {
        cookie: jwtCookie(professional),
        body: { customerId: String(customer._id) },
      },
    );
    expect(response.status).toBe(409);
    expect(response.body.error?.code).toBe('ACCOUNT_UNAVAILABLE');
    expect(await Booking.countDocuments({})).toBe(before);
  });

  it('excludes anonymized professionals from approval lists, stats, details, and management updates', async () => {
    const professional = await createTarget('professional');
    const customer = await createTarget('customer');
    await User.updateOne(
      { _id: professional._id },
      { $set: { deletedAt: new Date('2025-01-01T00:00:00.000Z'), isAnonymized: true } },
    );

    const list = await request(
      'GET',
      '/api/admin/professionals?status=approved',
      { cookie: superCookie },
    );
    expect(list.status).toBe(200);
    expect(list.body.data.professionals.some(
      (entry: any) => String(entry._id) === String(professional._id),
    )).toBe(false);
    expect(list.body.data.pagination.total).toBe(0);

    const stats = await request(
      'GET',
      '/api/admin/stats/approvals',
      { cookie: superCookie },
    );
    expect(stats.status).toBe(200);
    expect(stats.body.data.approved ?? stats.body.data.stats?.approved ?? 0).toBe(0);

    const details = await request(
      'GET',
      `/api/admin/professionals/${professional._id}`,
      { cookie: superCookie },
    );
    expect(details.status).toBe(404);

    const professionalUpdate = await request(
      'PATCH',
      `/api/admin/professionals/manage/${professional._id}`,
      { cookie: superCookie, body: { professionalLevel: 'Level 2' } },
    );
    expect(professionalUpdate.status).toBe(409);
    expect(professionalUpdate.body.code).toBe('ACCOUNT_UNAVAILABLE');

    const customerUpdate = await request(
      'PATCH',
      `/api/admin/customers/manage/${customer._id}`,
      { cookie: superCookie, body: { loyaltyLevel: 'Gold' } },
    );
    expect(customerUpdate.status).toBe(200);
    await User.updateOne(
      { _id: customer._id },
      { $set: { deletedAt: new Date('2025-01-01T00:00:00.000Z'), isAnonymized: true } },
    );
    const lockedCustomerUpdate = await request(
      'PATCH',
      `/api/admin/customers/manage/${customer._id}`,
      { cookie: superCookie, body: { loyaltyLevel: 'Gold' } },
    );
    expect(lockedCustomerUpdate.status).toBe(409);
    expect(lockedCustomerUpdate.body.code).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('redacts referred-user referral IPs and target marketing suppression rows', async () => {
    const target = await createTarget('customer');
    const referrer = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({ customer: target._id, professional: professional._id });
    await Referral.create({
      referrer: referrer._id,
      referredUser: target._id,
      referralCode: referrer._id.toHexString(),
      status: 'completed',
      referrerRewardAmount: 10,
      referredUserDiscountApplied: true,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      ipAddress: '203.0.113.77',
    });
    await MarketingSuppression.create({
      emailNormalized: String((await User.findById(target._id).lean())?.email).toLowerCase(),
      reason: 'unsubscribe',
      source: 'user',
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    const referral = await Referral.findOne({ referredUser: target._id }).lean();
    expect(referral?.ipAddress).toBe('[deleted]');
    expect(await MarketingSuppression.countDocuments({})).toBe(0);
  });

  it('keeps forged or counterparty file keys while deleting only target-owned files', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const other = await createTarget('customer');
    const forgedKey = `rfq-attachments/${other._id}/forged.pdf`;
    const ownedKey = `rfq-attachments/${target._id}/owned.pdf`;
    const invoiceKey = `invoices/${target._id}/INV-KEEP.pdf`;
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      attachments: [
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/${forgedKey}`,
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/${ownedKey}`,
        `https://${BUCKET}.s3.us-east-1.amazonaws.com/${invoiceKey}`,
      ],
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    const deleted = new Set(s3.deleteCalls);
    expect(deleted.has(ownedKey)).toBe(true);
    expect(deleted.has(forgedKey)).toBe(false);
    expect(deleted.has(invoiceKey)).toBe(false);
    const stored = await Booking.findById(booking._id).lean();
    expect(stored?.rfqData?.attachments).toEqual([
      `https://${BUCKET}.s3.us-east-1.amazonaws.com/${forgedKey}`,
      `https://${BUCKET}.s3.us-east-1.amazonaws.com/${invoiceKey}`,
    ]);
  });

  it('rejects a review that passed a stale counterparty preflight after anonymization', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
    });

    const anonymize = await request(
      'PUT',
      `/api/admin/users/${professional._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(anonymize.status).toBe(200);

    const originalFindById = User.findById.bind(User);
    const spy = vi.spyOn(User, 'findById').mockImplementation(((id: any, ...rest: any[]) => {
      if (String(id) === String(professional._id)) {
        return {
          select: () => ({
            lean: async () => ({ deletedAt: null, isAnonymized: false }),
          }),
        } as any;
      }
      return originalFindById(id, ...rest);
    }) as any);

    try {
      const response = await request(
        'POST',
        `/api/bookings/${booking._id}/customer-review`,
        {
          cookie: jwtCookie(customer),
          body: {
            communicationLevel: 5,
            valueOfDelivery: 5,
            qualityOfService: 5,
            comment: 'Stale review after tombstone',
          },
        },
      );
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      spy.mockRestore();
    }
    expect((await Booking.findById(booking._id).lean())?.customerReview?.communicationLevel)
      .toBeUndefined();
  });

  it('redacts professional-authored history while keeping customer rejection and contract facts', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      extra: {
        statusHistory: [
          {
            status: 'cancelled',
            timestamp: new Date('2026-01-02T00:00:00.000Z'),
            updatedBy: professional._id,
            note: 'Reach me at +32 470 00 00 00',
          },
          {
            status: 'cancelled',
            timestamp: new Date('2026-01-03T00:00:00.000Z'),
            updatedBy: customer._id,
            note: 'Customer cancellation note stays',
          },
        ],
        customerRejectionReason: 'Customer rejection stays with the counterparty',
        rfqResponse: {
          action: 'rejected',
          respondedAt: new Date('2026-01-04T00:00:00.000Z'),
          respondedBy: professional._id,
          rejectionReason: 'Professional private phone +32 470 00 00 00',
        },
        quoteVersions: [{
          version: 1,
          quotationNumber: 'QUO-PRO-1',
          scope: 'Bathroom renovation scope',
          warrantyDuration: { value: 1, unit: 'years' },
          materialsIncluded: true,
          description: 'Quotation description',
          totalAmount: 450,
          currency: 'EUR',
          preparationDuration: { value: 1, unit: 'days' },
          executionDuration: { value: 3, unit: 'days' },
          validUntil: new Date('2026-02-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-05T00:00:00.000Z'),
          createdBy: professional._id,
          changeNote: 'Professional change note with private phone +32 470 00 00 00',
          rejectedAt: new Date('2026-01-06T00:00:00.000Z'),
          rejectedBy: customer._id,
          rejectionReason: 'Customer rejection reason stays',
        }],
      },
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${professional._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    expect(execute.body.data.fullyAnonymized).toBe(true);

    const stored = await Booking.findById(booking._id).lean();
    expect(stored?.statusHistory?.map((entry: any) => entry.note)).toEqual([
      '[deleted]',
      'Customer cancellation note stays',
    ]);
    expect(stored?.rfqResponse?.rejectionReason).toBe('[deleted]');
    expect(stored?.customerRejectionReason).toBe('Customer rejection stays with the counterparty');
    expect(stored?.quoteVersions?.[0]).toMatchObject({
      quotationNumber: 'QUO-PRO-1',
      totalAmount: 450,
      changeNote: '[deleted]',
      rejectionReason: 'Customer rejection reason stays',
      scope: 'Bathroom renovation scope',
    });
    expect(stored?.bookingSnapshot?.parties?.professional?.displayName).toBe('[deleted user]');
    expect(stored?.bookingSnapshot?.parties?.customer?.displayName).toBe('Carla Customer');
    expect(JSON.stringify(stored)).not.toContain('+32 470 00 00 00');
  });

  it('rejects employee accounts outside the customer and professional scope', async () => {
    const employee = await User.create({
      name: 'Emma Employee',
      email: `employee-${new Types.ObjectId().toHexString()}@example.com`,
      phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
      password: await bcrypt.hash('employee-pass-123', 4),
      role: 'employee',
      employee: { companyId: new Types.ObjectId(), isActive: true },
    });

    const preview = await request(
      'GET',
      `/api/admin/users/${employee._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('blocked');
    expect(preview.body.data.blockers.map((entry: any) => entry.code)).toContain(
      'UNSUPPORTED_ACCOUNT_ROLE',
    );

    const execute = await request(
      'PUT',
      `/api/admin/users/${employee._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(403);
    expect(execute.body.code).toBe('UNSUPPORTED_ACCOUNT_ROLE');
    expect((await User.findById(employee._id).lean())?.deletedAt ?? null).toBeNull();
  });

  it('allows only one anonymization owner under concurrent execute requests', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({
      customer: target._id,
      professional: professional._id,
    });

    const originalUpdateOne = Booking.updateOne.bind(Booking);
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let markReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const spy = vi.spyOn(Booking, 'updateOne').mockImplementationOnce(((filter: any, update: any, options: any) => {
      markReached();
      return hold.then(() => originalUpdateOne(filter, update, options));
    }) as any);

    try {
      const firstPromise = request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      await reached;
      await expect(assertSupportAccountWritable(target._id)).rejects.toMatchObject({ status: 403 });
      const second = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('ANONYMIZATION_IN_PROGRESS');
      release();
      const first = await firstPromise;
      expect(first.status).toBe(200);
      expect(first.body.data.fullyAnonymized).toBe(true);
    } finally {
      spy.mockRestore();
      release();
    }

    expect((await User.findById(target._id).lean())?.isAnonymized).toBe(true);
  });

  it('rejects a stale profile write after the account is anonymized without repopulating the address', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({ customer: target._id, professional: professional._id, status: 'completed' });
    const barrier = pauseUserRead(target._id);
    try {
      const pendingProfile = request(
        'PUT',
        '/api/user/customer-profile',
        {
          cookie: jwtCookie(target),
          body: {
            address: 'New Private Street 9',
            city: 'Ghent',
            postalCode: '9000',
          },
        },
      );
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      const profileResponse = await pendingProfile;
      expect(profileResponse.status).toBe(409);
      expect(profileResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');

      const stored = await User.findById(target._id).lean();
      expect(stored?.isAnonymized).toBe(true);
      expect(stored?.deletedAt).toBeInstanceOf(Date);
      expect(stored?.location).toBeUndefined();
      expect(JSON.stringify(stored)).not.toContain('New Private Street 9');
    } finally {
      barrier.restore();
      barrier.release();
    }
  });

  it('rejects support replies that read the ticket after the tombstone and stores no new private text', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({ customer: target._id, professional: professional._id, status: 'completed' });
    const ticket = await createSupportTicket(target._id, undefined, { kind: 'ticket' });
    const privateReply = 'Private support reply after tombstone +32 499 88 77 66';
    const barrier = pauseFirstUserRead(target._id);
    try {
      const pendingReply = request(
        'POST',
        `/api/support/items/ticket/${ticket._id}/replies`,
        { cookie: jwtCookie(target), body: { body: privateReply } },
      );
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      const replyResponse = await pendingReply;
      expect(replyResponse.status).toBe(409);
      expect(replyResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      barrier.restore();
      barrier.release();
    }

    const stored = await SupportTicket.findById(ticket._id).lean();
    expect(stored?.subject).toBe('[deleted]');
    expect(JSON.stringify(stored?.replies || [])).not.toContain(privateReply);
    expect(JSON.stringify(stored)).not.toContain('499 88 77 66');
  });

  it('rejects the legacy professional support reply after the tombstone', async () => {
    const target = await createTarget('professional');
    const customer = await createTarget('customer');
    await createBooking({ customer: customer._id, professional: target._id, status: 'completed' });
    const ticket = await createSupportTicket(target._id, undefined, { kind: 'ticket' });
    const privateReply = 'Legacy professional reply after tombstone +32 499 11 22 33';
    const barrier = pauseFirstUserRead(target._id);
    try {
      const pendingReply = request(
        'POST',
        `/api/professionals/support/tickets/${ticket._id}/reply`,
        { cookie: jwtCookie(target), body: { body: privateReply } },
      );
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      const replyResponse = await pendingReply;
      expect(replyResponse.status).toBe(409);
      expect(replyResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      barrier.restore();
      barrier.release();
    }

    const stored = await SupportTicket.findById(ticket._id).lean();
    expect(JSON.stringify(stored?.replies || [])).not.toContain(privateReply);
    expect(JSON.stringify(stored)).not.toContain('499 11 22 33');
  });

  it('rejects a project duplicate after the source owner is tombstoned and creates no stale copy', async () => {
    const professional = await createTarget('professional');
    const customer = await createTarget('customer');
    await createBooking({ customer: customer._id, professional: professional._id, status: 'completed' });
    const projectId = new Types.ObjectId();
    await Project.collection.insertOne({
      _id: projectId,
      professionalId: professional._id,
      category: 'Renovation',
      service: 'Bathroom',
      description: 'Private duplicate target description',
      priceModel: 'fixed',
      keywords: [],
      title: 'Private duplicate target title',
      media: { images: [] },
      certifications: [],
      distance: {
        address: 'SecretStreet77',
        countryCode: 'BE',
        useCompanyAddress: false,
        maxKmRange: 30,
        noBorders: false,
        location: { type: 'Point', coordinates: [4.35, 50.85] },
      },
      resources: [],
      intakeMeeting: { enabled: false, resources: [] },
      renovationPlanning: { fixeraManaged: false, resources: [] },
      subprojects: [],
      extraOptions: [],
      termsConditions: [],
      faq: [],
      rfqQuestions: [],
      status: 'published',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const barrier = pauseNthQuery(
      'Project',
      (query) => String(query.getFilter?.()?._id || '') === String(projectId),
      1,
    );
    try {
      const pendingDuplicate = request(
        'POST',
        `/api/projects/${projectId}/duplicate`,
        { cookie: jwtCookie(professional) },
      );
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${professional._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      const duplicateResponse = await pendingDuplicate;
      expect(duplicateResponse.status).toBe(409);
      expect(duplicateResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      barrier.restore();
      barrier.release();
    }

    const projects = await Project.find({ professionalId: professional._id }).lean();
    expect(projects).toHaveLength(1);
    expect(projects[0]?._id).toEqual(projectId);
    expect(projects[0]?.title).toBe('Private duplicate target title');
    expect(projects[0]?.distance?.address).toBe('[deleted]');
    expect(JSON.stringify(projects)).not.toContain('SecretStreet77');
    expect(JSON.stringify(projects)).not.toContain('(Copy)');
  });

  it('rejects the legacy meeting-request create after the professional is tombstoned', async () => {
    const professional = await createTarget('professional');
    const customer = await createTarget('customer');
    await createBooking({ customer: customer._id, professional: professional._id, status: 'completed' });
    const privateTopic = 'Private meeting topic for Meeting Request Target +32 499 55 44 33';
    const barrier = pauseFirstUserRead(professional._id);
    try {
      const pendingCreate = request(
        'POST',
        '/api/professionals/support/meeting-requests',
        {
          cookie: jwtCookie(professional),
          body: {
            topic: privateTopic,
            preferredTimes: 'Next Tuesday at my private address Secret Road 3',
          },
        },
      );
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${professional._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      const createResponse = await pendingCreate;
      expect(createResponse.status).toBe(409);
      expect(createResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
    } finally {
      barrier.restore();
      barrier.release();
    }

    expect(await MeetingRequest.countDocuments({ userId: professional._id })).toBe(0);
    expect(await MeetingRequest.countDocuments({ topic: privateTopic })).toBe(0);
  });

  it('does not create a booking when the request loaded the customer before the tombstone', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const barrier = pauseUserRead(target._id);
    try {
      const pendingBooking = request(
        'POST',
        '/api/bookings/create',
        {
          cookie: jwtCookie(target),
          body: {
            bookingType: 'professional',
            professionalId: String(professional._id),
            rfqData: {
              serviceType: 'Bathroom renovation',
              description: 'I need a bathroom renovation with a new shower.',
              urgency: 'medium',
            },
            serviceCountry: 'BE',
            proceedAtStandardVat: true,
          },
        },
      );
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      const bookingResponse = await pendingBooking;
      expect(bookingResponse.status).toBe(409);
      expect(bookingResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
      expect(await Booking.countDocuments({ customer: target._id })).toBe(0);
      expect(await Booking.countDocuments({})).toBe(0);
    } finally {
      barrier.restore();
      barrier.release();
    }
  });

  it('rejects stale quotation edits, post-booking answers, and cancellation requests at the fence', async () => {
    const quotationCustomer = await createTarget('customer');
    const quotationProfessional = await createTarget('professional');
    const quotationBooking = await createBooking({
      customer: quotationCustomer._id,
      professional: quotationProfessional._id,
      status: 'quote_rejected',
      extra: {
        currentQuoteVersion: 1,
        quoteVersions: [{
          version: 1,
          quotationNumber: 'QUO-STALE-1',
          scope: 'Original bathroom scope',
          warrantyDuration: { value: 1, unit: 'years' },
          materialsIncluded: true,
          description: 'Original quotation',
          totalAmount: 450,
          currency: 'EUR',
          preparationDuration: { value: 1, unit: 'days' },
          executionDuration: { value: 3, unit: 'days' },
          validUntil: new Date('2026-12-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-05T00:00:00.000Z'),
          createdBy: quotationProfessional._id,
          changeNote: 'Original note',
        }],
      },
    });
    const quoteBarrier = pauseBookingRead(quotationBooking._id);
    try {
      const pendingQuote = request(
        'PUT',
        `/api/quotations/${quotationBooking._id}/edit`,
        {
          cookie: jwtCookie(quotationProfessional),
          body: {
            scope: 'Updated bathroom scope with private text',
            warrantyDuration: { value: 1, unit: 'years' },
            materialsIncluded: true,
            materials: [],
            description: 'Updated quotation',
            totalAmount: 500,
            pricingLines: [{ description: 'Updated quotation', quantity: 1, price: 500, vatRate: 21 }],
            currency: 'EUR',
            milestones: [],
            preparationDuration: { value: 1, unit: 'days' },
            executionDuration: { value: 3, unit: 'days' },
            validUntil: '2026-12-01',
            changeNote: 'Private stale change note',
          },
        },
      );
      await quoteBarrier.reached;
      const execute = await request(
        'PUT',
        `/api/admin/users/${quotationProfessional._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      quoteBarrier.release();
      const quoteResponse = await pendingQuote;
      expect(quoteResponse.status).toBe(409);
      expect(quoteResponse.body.error.code).toBe('ACCOUNT_UNAVAILABLE');
      const storedQuoteBooking = await Booking.findById(quotationBooking._id).lean();
      expect(storedQuoteBooking?.quoteVersions).toHaveLength(1);
      expect(JSON.stringify(storedQuoteBooking)).not.toContain('Private stale change note');
    } finally {
      quoteBarrier.restore();
      quoteBarrier.release();
    }

    const postCustomer = await createTarget('customer');
    const postProfessional = await createTarget('professional');
    const postBooking = await createBooking({
      customer: postCustomer._id,
      professional: postProfessional._id,
      status: 'completed',
      extra: {
        bookingSnapshot: {
          capturedAt: new Date('2026-01-02T00:00:00.000Z'),
          source: 'booking_creation',
          questions: {
            postBooking: [{
              questionId: 'postq1',
              question: 'Access notes',
              type: 'text',
              isRequired: false,
            }],
          },
        },
      },
    });
    const postBarrier = pauseBookingRead(postBooking._id);
    try {
      const pendingPost = request(
        'POST',
        `/api/bookings/${postBooking._id}/post-booking-answers`,
        {
          cookie: jwtCookie(postCustomer),
          body: { answers: [{ questionId: 'postq1', question: 'Access notes', answer: 'Private gate code 1234' }] },
        },
      );
      await postBarrier.reached;
      const execute = await request(
        'PUT',
        `/api/admin/users/${postCustomer._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      postBarrier.release();
      const postResponse = await pendingPost;
      expect(postResponse.status).toBe(409);
      expect(postResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
      const storedPost = await Booking.findById(postBooking._id).lean();
      expect(storedPost?.postBookingData ?? []).toEqual([]);
      expect(JSON.stringify(storedPost)).not.toContain('Private gate code 1234');
    } finally {
      postBarrier.restore();
      postBarrier.release();
    }

    const cancelCustomer = await createTarget('customer');
    const cancelProfessional = await createTarget('professional');
    const cancelBookingDoc = await createBooking({
      customer: cancelCustomer._id,
      professional: cancelProfessional._id,
      status: 'quote_rejected',
    });
    const cancelBarrier = pauseBookingRead(cancelBookingDoc._id);
    try {
      const pendingCancel = request(
        'POST',
        `/api/bookings/${cancelBookingDoc._id}/cancel`,
        {
          cookie: jwtCookie(cancelProfessional),
          body: { reason: 'Private cancellation reason with +32 499 00 00 00' },
        },
      );
      await cancelBarrier.reached;
      const execute = await request(
        'PUT',
        `/api/admin/users/${cancelProfessional._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      cancelBarrier.release();
      const cancelResponse = await pendingCancel;
      expect(cancelResponse.status).toBe(409);
      expect(cancelResponse.body.code).toBe('ACCOUNT_UNAVAILABLE');
      expect(await CancellationRequest.countDocuments({ requestedBy: cancelProfessional._id })).toBe(0);
      const storedCancelBooking = await Booking.findById(cancelBookingDoc._id).lean();
      expect(JSON.stringify(storedCancelBooking)).not.toContain('+32 499 00 00 00');
    } finally {
      cancelBarrier.restore();
      cancelBarrier.release();
    }
  });

  it('strips target-owned file answers and snapshot attachments before signing any read DTO', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await User.updateOne(
      { _id: target._id },
      { $set: { deletedAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    const targetRfq = s3Url('rfq-attachments', String(target._id), 'private.pdf');
    const targetProject = `https://${BUCKET}.s3.us-east-1.amazonaws.com/projects/${new Types.ObjectId()}/attachment/${target._id}/plan.pdf`;
    const counterpartyRfq = s3Url('rfq-attachments', String(professional._id), 'shared.pdf');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'completed',
      extra: {
        rfqData: {
          serviceType: 'Bathroom renovation',
          description: 'Bathroom work',
          attachments: [counterpartyRfq],
          answers: [{
            questionId: 'q1',
            question: 'Upload plan',
            answer: targetRfq,
            fieldType: 'file',
          }],
        },
        postBookingData: [{
          questionId: 'postq1',
          question: 'Upload access plan',
          answer: targetProject,
          fieldType: 'file',
        }],
        bookingSnapshot: {
          capturedAt: new Date('2026-01-02T00:00:00.000Z'),
          source: 'booking_creation',
          parties: {
            customer: { displayName: 'Carla Customer', city: 'Brussels' },
            professional: { displayName: 'Piet Professional', city: 'Ghent' },
          },
          questions: {
            rfq: [{
              question: 'Upload plan',
              type: 'attachment',
              professionalAttachments: [targetProject],
            }],
            postBooking: [{
              question: 'Upload access plan',
              type: 'attachment',
              professionalAttachments: [targetProject],
            }],
          },
        },
        postBookingQuestionSnapshot: {
          capturedAt: new Date('2026-01-03T00:00:00.000Z'),
          source: 'post_booking_submission',
          questions: [{
            question: 'Upload access plan',
            type: 'attachment',
            professionalAttachments: [targetProject],
          }],
        },
      },
    });

    const professionalRead = await request(
      'GET',
      `/api/bookings/${booking._id}`,
      { cookie: jwtCookie(professional) },
    );
    expect(professionalRead.status).toBe(200);
    expect(JSON.stringify(professionalRead.body)).not.toContain(targetRfq);
    expect(JSON.stringify(professionalRead.body)).not.toContain(targetProject);
    expect(professionalRead.body.booking.rfqData.answers[0].answer).toBe('');
    expect(professionalRead.body.booking.postBookingData[0].answer).toBe('');
    expect(professionalRead.body.booking.bookingSnapshot.questions.rfq[0].professionalAttachments).toEqual([]);
    expect(professionalRead.body.booking.bookingSnapshot.questions.postBooking[0].professionalAttachments).toEqual([]);
    expect(professionalRead.body.booking.postBookingQuestionSnapshot.questions[0].professionalAttachments).toEqual([]);
    expect(s3.presignCalls).not.toContain(targetRfq);
    expect(s3.presignCalls).not.toContain(targetProject);
    expect(s3.presignCalls).toContain(counterpartyRfq);

    const detailsRead = await request(
      'GET',
      `/api/bookings/${booking._id}/details`,
      { cookie: jwtCookie(professional) },
    );
    expect(detailsRead.status).toBe(200);
    expect(JSON.stringify(detailsRead.body)).not.toContain(targetRfq);
    expect(JSON.stringify(detailsRead.body)).not.toContain(targetProject);
    expect(s3.presignCalls).not.toContain(targetRfq);
    expect(s3.presignCalls).not.toContain(targetProject);

    const adminRead = await request(
      'GET',
      `/api/admin/bookings/${booking._id}/full`,
      { cookie: superCookie },
    );
    expect(adminRead.status).toBe(200);
    expect(JSON.stringify(adminRead.body)).not.toContain(targetRfq);
    expect(JSON.stringify(adminRead.body)).not.toContain(targetProject);
  });

  it('redacts notification and email copies about the target and refuses to recreate them', async () => {
    const target = await createTarget('customer');
    const counterparty = await createTarget('professional');
    const actorNotification = await Notification.create({
      userId: counterparty._id,
      actorId: target._id,
      eventKey: 'user.chat_message',
      category: 'messages',
      title: 'New message from Carla Customer',
      body: 'Private target chat preview persists',
      clickUrl: '/chat?conversationId=abc',
      meta: { private: 'Carla Customer +32 499 00 00 00' },
    });
    const targetNotification = await Notification.create({
      userId: target._id,
      eventKey: 'test.private',
      category: 'system',
      title: 'Private target inbox',
      body: 'Private body',
      clickUrl: '/private',
    });
    const actorEmail = await EmailLog.create({
      to: String(counterparty.email),
      subject: 'Carla Customer sent you a message',
      template: 'chat_mirror',
      status: 'sent',
      relatedUser: counterparty._id,
      relatedBooking: undefined,
      actorId: target._id,
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);

    const storedActorNotification = await Notification.findById(actorNotification._id).lean();
    expect(storedActorNotification).toMatchObject({
      title: '[deleted]',
      body: '[deleted]',
    });
    expect(storedActorNotification?.meta).toBeUndefined();
    expect(await Notification.countDocuments({ _id: targetNotification._id })).toBe(0);

    const storedActorEmail = await EmailLog.findById(actorEmail._id).lean();
    expect(storedActorEmail?.subject).toBe('[deleted]');
    expect(storedActorEmail?.to).toBe(String(counterparty.email));

    const before = await Notification.countDocuments({ userId: counterparty._id });
    const recreated = await notify({
      userId: String(counterparty._id),
      actorId: String(target._id),
      eventKey: 'user.chat_message',
      entityType: 'conversation',
      context: {
        actorName: 'Carla Customer',
        previewText: 'Private target text after tombstone',
        conversationId: 'abc',
      },
      delivery: { persistInbox: true, sendEmail: false, sendPush: false },
    });
    expect(recreated.skipped).toBe('user_not_found');
    expect(recreated.notificationId).toBeNull();
    expect(await Notification.countDocuments({ userId: counterparty._id })).toBe(before);
  });

  it('does not recreate cancellation messages about an anonymized target and keeps the active producer working', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'completed',
    });
    const oldName = target.name;
    const oldReason = 'Private cancellation reason +32 499 76 54 32';

    notifyBookingCancelledAndRefunded({
      bookingId: String(booking._id),
      reason: 'Ordinary cancellation reason',
      cancelledBy: 'customer',
      customerUser: { _id: target._id, name: oldName },
      professionalUser: {
        _id: professional._id,
        name: professional.name,
        businessInfo: professional.businessInfo,
      },
      refundAmount: 10,
      currency: 'EUR',
    });
    await vi.waitFor(async () => {
      expect(await Notification.countDocuments({
        userId: professional._id,
        eventKey: 'professional.booking_cancelled_refunded',
      })).toBe(1);
      expect(await EmailLog.countDocuments({ status: 'skipped' })).toBeGreaterThan(0);
    });
    const activeNotification = await Notification.findOne({
      userId: professional._id,
      eventKey: 'professional.booking_cancelled_refunded',
    }).lean();
    expect(String(activeNotification?.actorId)).toBe(String(target._id));
    expect(String(activeNotification?.subjectUserId)).toBe(String(target._id));

    const execute = await request(
      'PUT',
      `/api/admin/users/${target._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    expect(execute.body.data.fullyAnonymized).toBe(true);

    const notificationCount = await Notification.countDocuments({ userId: professional._id });
    const emailCount = await EmailLog.countDocuments({});
    notifyBookingCancelledAndRefunded({
      bookingId: String(booking._id),
      reason: oldReason,
      cancelledBy: 'customer',
      customerUser: { _id: target._id, name: oldName },
      professionalUser: {
        _id: professional._id,
        name: professional.name,
        businessInfo: professional.businessInfo,
      },
      refundAmount: 10,
      currency: 'EUR',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await Notification.countDocuments({ userId: professional._id })).toBe(notificationCount);
    expect(await EmailLog.countDocuments({})).toBe(emailCount);
    const storedNotifications = await Notification.find({ userId: professional._id }).lean();
    expect(JSON.stringify(storedNotifications)).not.toContain(oldName);
    expect(JSON.stringify(storedNotifications)).not.toContain('499 76 54 32');
    const storedEmailLogs = await EmailLog.find({}).lean();
    expect(JSON.stringify(storedEmailLogs)).not.toContain(oldName);
    expect(JSON.stringify(storedEmailLogs)).not.toContain('499 76 54 32');
  });

  it('does not send an unread-chat mirror built from stale lines about an anonymized sender', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'completed',
    });
    const conversation = await Conversation.create({
      type: 'direct',
      customerId: target._id,
      professionalId: professional._id,
      initiatedBy: target._id,
      status: 'active',
      customerUnreadCount: 0,
      professionalUnreadCount: 1,
      lastMessageSenderId: target._id,
      lastMessageAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    const oldSnippet = 'Private stale unread snippet +32 499 66 55 44';
    await ChatMessage.create({
      conversationId: conversation._id,
      senderId: target._id,
      senderRole: 'customer',
      text: oldSnippet,
      images: [],
      attachments: [],
      readBy: [{ userId: target._id, readAt: new Date() }],
    });

    const barrier = pauseNthQuery(
      'ChatMessage',
      (query) => String(query.getFilter?.()?.conversationId || '') === String(conversation._id),
      1,
    );
    try {
      const reminderRun = processUnreadChatMirrorReminders();
      await barrier.reached;

      const execute = await request(
        'PUT',
        `/api/admin/users/${target._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      expect(execute.body.data.fullyAnonymized).toBe(true);

      barrier.release();
      await reminderRun;
    } finally {
      barrier.restore();
      barrier.release();
    }

    expect(await EmailLog.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
    expect(JSON.stringify(await EmailLog.find({}).lean())).not.toContain('499 66 55 44');
  });

  it('keeps the active completion producer provenance and skips a stale customer name after anonymization', async () => {
    const activeCustomer = await createTarget('customer');
    const activeProfessional = await createTarget('professional');
    const activeBooking = await createBooking({
      customer: activeCustomer._id,
      professional: activeProfessional._id,
      status: 'professional_completed',
      extra: { professionalCompletedAt: new Date() },
    });
    const activeResult = await finalizeBookingCompletion({
      bookingId: String(activeBooking._id),
      actorId: String(activeCustomer._id),
      notifyAutoAccept: false,
    });
    expect(activeResult.ok).toBe(true);
    await vi.waitFor(async () => {
      expect(await Notification.countDocuments({
        userId: activeProfessional._id,
        eventKey: 'professional.completion_confirmed_by_customer',
      })).toBe(1);
    });
    const activeNotification = await Notification.findOne({
      userId: activeProfessional._id,
      eventKey: 'professional.completion_confirmed_by_customer',
    }).lean();
    expect(String(activeNotification?.actorId)).toBe(String(activeCustomer._id));
    expect(String(activeNotification?.subjectUserId)).toBe(String(activeCustomer._id));
    expect(activeNotification?.body).toContain(activeCustomer.name);

    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'professional_completed',
      extra: { professionalCompletedAt: new Date() },
    });
    const oldName = target.name;
    await anonymizeUser(target._id, adminUser._id);
    expect((await User.findById(target._id).lean())?.isAnonymized).toBe(true);

    const originalFindById = User.findById.bind(User);
    const staleUser = {
      _id: target._id,
      name: oldName,
      email: String(target.email),
    };
    const staleRead = vi.spyOn(User, 'findById').mockImplementation(((id: any) => {
      if (String(id) === String(target._id)) {
        return {
          select: () => ({ lean: async () => staleUser }),
        } as any;
      }
      return originalFindById(id);
    }) as any);
    let staleResult: Awaited<ReturnType<typeof finalizeBookingCompletion>>;
    try {
      staleResult = await finalizeBookingCompletion({
        bookingId: String(booking._id),
        actorId: String(target._id),
        notifyAutoAccept: false,
      });
    } finally {
      staleRead.mockRestore();
    }
    expect(staleResult.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await Notification.countDocuments({
      userId: professional._id,
      eventKey: 'professional.completion_confirmed_by_customer',
    })).toBe(0);
    expect(JSON.stringify(await Notification.find({ userId: professional._id }).lean()))
      .not.toContain(oldName);
    expect(JSON.stringify(await EmailLog.find({}).lean())).not.toContain(oldName);
  });

  it('does not persist a reschedule notification built from a stale customer name after deletion', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: target._id,
      professional: professional._id,
      status: 'booked',
    });
    const oldName = target.name;
    let anonymized = false;
    notifyGate.beforeNext = async () => {
      await anonymizeUser(target._id, adminUser._id);
      anonymized = true;
    };

    const response = await request(
      'POST',
      `/api/bookings/${booking._id}/reschedule-request`,
      {
        cookie: jwtCookie(target),
        body: {
          scheduledStartDate: '2027-06-01',
          reason: 'Private reschedule reason SecretStreet77',
        },
      },
    );
    expect(anonymized).toBe(true);
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await Notification.countDocuments({
      userId: professional._id,
      eventKey: 'professional.reschedule_requested',
    })).toBe(0);
    expect(JSON.stringify(await Notification.find({ userId: professional._id }).lean()))
      .not.toContain(oldName);
    expect(JSON.stringify(await EmailLog.find({}).lean())).not.toContain(oldName);
    const stored = await Booking.findById(booking._id).lean();
    expect(JSON.stringify(stored?.rescheduleRequest || {})).not.toContain('SecretStreet77');
  });

  it('rechecks a queued notification recipient before external delivery', async () => {
    const recipient = await createTarget('customer');
    const actor = await createTarget('professional');
    const booking = await createBooking({
      customer: recipient._id,
      professional: actor._id,
      status: 'completed',
    });
    const originalCount = User.countDocuments.bind(User);
    let anonymized = false;
    const spy = vi.spyOn(User, 'countDocuments').mockImplementation(((filter: any, ...rest: any[]) => {
      if (!anonymized) {
        anonymized = true;
        return (async () => {
          await anonymizeUser(recipient._id, adminUser._id);
          return (originalCount as any)(filter, ...rest);
        })();
      }
      return (originalCount as any)(filter, ...rest);
    }) as any);

    let result: Awaited<ReturnType<typeof notify>>;
    try {
      result = await notify({
        userId: String(recipient._id),
        actorId: String(actor._id),
        subjectUserId: String(actor._id),
        eventKey: 'customer.booking_started',
        entityType: 'booking',
        entityId: String(booking._id),
        context: {
          bookingId: String(booking._id),
          professionalName: actor.name,
        },
        delivery: { persistInbox: true, sendEmail: true, sendPush: false },
      });
    } finally {
      spy.mockRestore();
    }

    expect(anonymized).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.skipped).toBe('user_not_found');
    expect(await Notification.countDocuments({ userId: recipient._id })).toBe(0);
    expect(await EmailLog.countDocuments({ to: recipient.email })).toBe(0);
  });

  it('delivers one booking-started notice with the professional subject for every allowed updater', async () => {
    const scenarios = [
      { role: 'customer' as const, updater: (customer: any, _professional: any) => customer },
      { role: 'professional' as const, updater: (_customer: any, professional: any) => professional },
      { role: 'admin' as const, updater: () => adminUser },
    ];

    for (const scenario of scenarios) {
      const customer = await createTarget('customer');
      const professional = await createTarget('professional');
      const booking = await createBooking({
        customer: customer._id,
        professional: professional._id,
        status: 'booked',
      });
      const updater = scenario.updater(customer, professional);
      const cookie = scenario.role === 'admin' ? superCookie : jwtCookie(updater);

      const response = await request(
        'PUT',
        `/api/bookings/${booking._id}/status`,
        { cookie, body: { status: 'in_progress' } },
      );

      expect(response.status, scenario.role).toBe(200);
      expect(response.body.data.booking.status, scenario.role).toBe('in_progress');
      await vi.waitFor(async () => {
        const notification = await Notification.findOne({
          userId: customer._id,
          eventKey: 'customer.booking_started',
          entityId: booking._id,
        }).lean();
        expect(notification, scenario.role).toBeTruthy();
        expect(String(notification?.actorId), scenario.role).toBe(String(updater._id));
        expect(String(notification?.subjectUserId), scenario.role).toBe(String(professional._id));
        expect(notification?.body, scenario.role).toContain(professional.name);
        const emailLog = await EmailLog.findOne({
          relatedBooking: booking._id,
          template: 'booking_started',
        }).lean();
        expect(emailLog, scenario.role).toBeTruthy();
      });
      expect(await Notification.countDocuments({
        userId: customer._id,
        eventKey: 'customer.booking_started',
        entityId: booking._id,
      })).toBe(1);
      expect(await EmailLog.countDocuments({
        relatedBooking: booking._id,
        template: 'booking_started',
      })).toBe(1);
    }
  });

  it('suppresses booking-started copy when the professional tombstones between the name read and notify', async () => {
    const scenarios = [
      { role: 'customer' as const, updater: (customer: any, _professional: any) => customer },
      { role: 'professional' as const, updater: (_customer: any, professional: any) => professional },
      { role: 'admin' as const, updater: () => adminUser },
    ];

    for (const scenario of scenarios) {
      const customer = await createTarget('customer');
      const professional = await createTarget('professional');
      const booking = await createBooking({
        customer: customer._id,
        professional: professional._id,
        status: 'booked',
      });
      const updater = scenario.updater(customer, professional);
      const cookie = scenario.role === 'admin' ? superCookie : jwtCookie(updater);
      const oldName = professional.name;
      let anonymized = false;
      notifyGate.beforeNext = async () => {
        await anonymizeUser(professional._id, professional._id);
        anonymized = true;
      };

      const response = await request(
        'PUT',
        `/api/bookings/${booking._id}/status`,
        { cookie, body: { status: 'in_progress' } },
      );

      expect(anonymized, scenario.role).toBe(true);
      expect(response.status, scenario.role).toBe(200);
      expect(response.body.data.booking.status, scenario.role).toBe('in_progress');
      expect(notifyGate.lastArgs?.eventKey, scenario.role).toBe('customer.booking_started');
      expect(notifyGate.lastArgs?.context?.professionalName, scenario.role).toBe(oldName);
      expect(notifyGate.lastArgs?.subjectUserId, scenario.role).toBe(String(professional._id));
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await Notification.countDocuments({
        userId: customer._id,
        eventKey: 'customer.booking_started',
      }), scenario.role).toBe(0);
      expect(JSON.stringify(await Notification.find({ userId: customer._id }).lean()))
        .not.toContain(oldName);
      expect(await EmailLog.countDocuments({ relatedBooking: booking._id })).toBe(0);
      expect((await User.findById(professional._id).lean())?.isAnonymized).toBe(true);
    }
  });

  it('requires a trusted subject for a named booking-started notification even with a valid actor', async () => {
    const recipient = await createTarget('customer');
    const actor = await createTarget('professional');
    const booking = await createBooking({
      customer: recipient._id,
      professional: actor._id,
      status: 'booked',
    });

    const result = await notify({
      userId: String(recipient._id),
      actorId: String(actor._id),
      eventKey: 'customer.booking_started',
      entityType: 'booking',
      entityId: String(booking._id),
      context: {
        bookingId: String(booking._id),
        professionalName: actor.name,
      },
      delivery: { persistInbox: true, sendEmail: true, sendPush: false },
    });

    expect(result.skipped).toBe('missing_provenance');
    expect(await Notification.countDocuments({
      userId: recipient._id,
      eventKey: 'customer.booking_started',
    })).toBe(0);
    expect(await EmailLog.countDocuments({ relatedBooking: booking._id })).toBe(0);
  });

  it('rejects a stale user support-meeting cancellation after the owner is tombstoned', async () => {
    const target = await createTarget('professional');
    const customer = await createTarget('customer');
    await createBooking({ customer: customer._id, professional: target._id, status: 'completed' });
    const ticket = await createSupportTicket(target._id, undefined, {
      kind: 'meeting',
      meetingStatus: 'scheduled',
    });
    const staleTicket = await SupportTicket.findById(ticket._id);
    expect(staleTicket?.meeting?.status).toBe('scheduled');
    const privateReason = 'Private post-tombstone cancellation reason +32 499 22 33 44';

    await anonymizeUser(target._id, adminUser._id);

    await expect(cancelSupportMeeting({
      ticket: staleTicket!,
      actorId: target._id,
      actorRole: 'user',
      owner: target,
      reason: privateReason,
    })).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_UNAVAILABLE' });

    const stored = await SupportTicket.findById(ticket._id).lean();
    expect(stored?.meeting?.status).toBe('cancelled');
    expect(stored?.meeting?.cancellationReason).not.toBe(privateReason);
    expect(JSON.stringify(stored)).not.toContain('499 22 33 44');
  });

  it('runs the focused suite with provider delivery intercepted and no outbound host', () => {
    expect(process.env.EMAIL_DEV_NO_SEND).toBe('true');
    expect(s3.totalCalls).toBeGreaterThan(0);
    expect(providerNetworkAttempts).toEqual([]);
  });

  it('reports bare tombstones truthfully and pages recoverable accounts deterministically', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const secondCustomer = await createTarget('customer');
    const employee = await User.create({
      name: 'Emma Employee',
      email: `employee-recovery-${new Types.ObjectId().toHexString()}@example.com`,
      phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
      password: await bcrypt.hash('employee-pass-123', 4),
      role: 'employee',
      employee: { companyId: new Types.ObjectId(), isActive: true },
    });
    await User.updateOne(
      { _id: customer._id },
      { $set: { deletedAt: new Date('2025-01-01T00:00:00.000Z') } },
    );
    await User.updateOne(
      { _id: professional._id },
      { $set: { deletedAt: new Date('2025-01-02T00:00:00.000Z') } },
    );
    await User.updateOne(
      { _id: secondCustomer._id },
      { $set: { deletedAt: new Date('2025-01-03T00:00:00.000Z') } },
    );
    await User.updateOne(
      { _id: employee._id },
      { $set: { deletedAt: new Date('2025-01-04T00:00:00.000Z') } },
    );

    const firstPage = await request(
      'GET',
      '/api/admin/users/anonymization/recovery?page=1&limit=2',
      { cookie: superCookie },
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.total).toBe(3);
    expect(firstPage.body.data.page).toBe(1);
    expect(firstPage.body.data.limit).toBe(2);
    expect(firstPage.body.data.totalPages).toBe(2);
    expect(firstPage.body.data.accounts).toHaveLength(2);
    expect(firstPage.body.data.accounts[0].targetId).toBe(String(customer._id));
    expect(firstPage.body.data.accounts[0]).toMatchObject({
      state: 'recovery_required',
      accessDisabled: true,
      identityRemoved: false,
      legacyAnonymized: false,
      needsRedaction: true,
    });
    expect(firstPage.body.data.accounts.some((entry: any) => entry.role === 'employee')).toBe(false);
    expect(JSON.stringify(firstPage.body)).not.toContain('Emma Employee');

    const secondPage = await request(
      'GET',
      '/api/admin/users/anonymization/recovery?page=2&limit=2',
      { cookie: superCookie },
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.accounts).toHaveLength(1);
    expect(secondPage.body.data.accounts[0].targetId).toBe(String(secondCustomer._id));

    const preview = await request(
      'GET',
      `/api/admin/users/${customer._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.target.identityRemoved).toBe(false);
    expect(preview.body.data.target.needsRedaction).toBe(true);
    expect(preview.body.data.target.legacyAnonymized).toBeUndefined();
  });

  it('lists legacy redacted accounts without a cleanup ledger and keeps oldest-first pages', async () => {
    const legacy = await createTarget('customer');
    await User.updateOne(
      { _id: legacy._id },
      {
        $set: {
          name: '[deleted user]',
          email: `deleted-${legacy._id}@anon.local`,
          phone: `DELETED-${legacy._id}`,
          deletedAt: new Date('2024-12-01T00:00:00.000Z'),
        },
        $unset: { isAnonymized: 1, anonymizedAt: 1 },
      },
    );
    const bareTombstone = await createTarget('professional');
    await User.updateOne(
      { _id: bareTombstone._id },
      { $set: { deletedAt: new Date('2025-02-01T00:00:00.000Z') } },
    );
    const completedCurrent = await createTarget('customer');
    await User.updateOne(
      { _id: completedCurrent._id },
      {
        $set: {
          name: '[deleted user]',
          email: `deleted-${completedCurrent._id}@anon.local`,
          deletedAt: new Date('2024-11-01T00:00:00.000Z'),
          isAnonymized: true,
          anonymizedAt: new Date('2024-11-01T00:00:00.000Z'),
        },
      },
    );
    await AccountDataGuard.create({
      _id: completedCurrent._id,
      state: 'anonymized',
      startedAt: new Date('2024-11-01T00:00:00.000Z'),
      completedAt: new Date('2024-11-01T00:00:05.000Z'),
      externalCleanup: { pendingKeys: [], pendingCalendarReleases: [] },
    });

    const firstPage = await request(
      'GET',
      '/api/admin/users/anonymization/recovery?page=1&limit=1',
      { cookie: superCookie },
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.total).toBe(2);
    expect(firstPage.body.data.totalPages).toBe(2);
    expect(firstPage.body.data.accounts).toHaveLength(1);
    expect(firstPage.body.data.accounts[0]).toMatchObject({
      targetId: String(legacy._id),
      role: 'customer',
      state: 'recovery_required',
      isAnonymized: false,
      accessDisabled: true,
      identityRemoved: true,
      legacyAnonymized: true,
      needsRedaction: false,
      pendingFiles: 0,
      pendingCalendarReleases: 0,
    });

    const secondPage = await request(
      'GET',
      '/api/admin/users/anonymization/recovery?page=2&limit=1',
      { cookie: superCookie },
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.accounts).toHaveLength(1);
    expect(secondPage.body.data.accounts[0]).toMatchObject({
      targetId: String(bareTombstone._id),
      state: 'recovery_required',
      identityRemoved: false,
      legacyAnonymized: false,
      needsRedaction: true,
    });
    expect(secondPage.body.data.accounts.some(
      (entry: any) => entry.targetId === String(completedCurrent._id),
    )).toBe(false);

    const preview = await request(
      'GET',
      `/api/admin/users/${legacy._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.data.status).toBe('recovery_required');
    expect(preview.body.data.target).toMatchObject({
      identityRemoved: true,
      legacyAnonymized: true,
      needsRedaction: false,
      accessDisabled: true,
    });
  });

  it('keeps half-placeholder tombstones redaction-required and aligns preview with the recovery list', async () => {
    const fullLegacy = await createTarget('customer');
    await User.updateOne(
      { _id: fullLegacy._id },
      {
        $set: {
          name: '[deleted user]',
          email: `deleted-${fullLegacy._id}@anon.local`,
          phone: `DELETED-${fullLegacy._id}`,
          deletedAt: new Date('2024-12-03T00:00:00.000Z'),
        },
        $unset: {
          isAnonymized: 1,
          anonymizedAt: 1,
          username: 1,
          vatNumber: 1,
          businessName: 1,
          companyAddress: 1,
          location: 1,
          businessInfo: 1,
          profileImage: 1,
          idProofUrl: 1,
        },
      },
    );

    const halfName = await createTarget('customer');
    const halfNameEmail = halfName.email;
    await User.updateOne(
      { _id: halfName._id },
      {
        $set: {
          name: '[deleted user]',
          deletedAt: new Date('2024-12-04T00:00:00.000Z'),
        },
        $unset: { isAnonymized: 1, anonymizedAt: 1 },
      },
    );

    const halfEmail = await createTarget('customer');
    const halfEmailName = halfEmail.name;
    await User.updateOne(
      { _id: halfEmail._id },
      {
        $set: {
          email: `deleted-${halfEmail._id}@anon.local`,
          phone: `DELETED-${halfEmail._id}`,
          deletedAt: new Date('2024-12-05T00:00:00.000Z'),
        },
        $unset: { isAnonymized: 1, anonymizedAt: 1 },
      },
    );

    const bareTombstone = await createTarget('professional');
    await User.updateOne(
      { _id: bareTombstone._id },
      { $set: { deletedAt: new Date('2024-12-06T00:00:00.000Z') } },
    );

    const employee = await User.create({
      name: 'Emma Employee',
      email: `employee-half-placeholder-${new Types.ObjectId().toHexString()}@example.com`,
      phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
      password: await bcrypt.hash('employee-pass-123', 4),
      role: 'employee',
      employee: { companyId: new Types.ObjectId(), isActive: true },
    });
    await User.updateOne(
      { _id: employee._id },
      {
        $set: {
          name: '[deleted user]',
          email: `deleted-${employee._id}@anon.local`,
          phone: `DELETED-${employee._id}`,
          deletedAt: new Date('2024-12-07T00:00:00.000Z'),
        },
      },
    );

    const list = await request(
      'GET',
      '/api/admin/users/anonymization/recovery?page=1&limit=100',
      { cookie: superCookie },
    );
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(4);
    expect(list.body.data.accounts.some((entry: any) => entry.targetId === String(employee._id))).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain('Emma Employee');
    expect(JSON.stringify(list.body)).not.toContain(String(halfNameEmail));
    expect(JSON.stringify(list.body)).not.toContain(String(halfEmailName));

    const byTarget = new Map<string, any>(
      list.body.data.accounts.map((entry: any) => [entry.targetId, entry]),
    );
    expect(byTarget.get(String(fullLegacy._id))).toMatchObject({
      state: 'recovery_required',
      accessDisabled: true,
      identityRemoved: true,
      legacyAnonymized: true,
      needsRedaction: false,
    });
    for (const half of [halfName, halfEmail]) {
      expect(byTarget.get(String(half._id))).toMatchObject({
        state: 'recovery_required',
        accessDisabled: true,
        identityRemoved: false,
        legacyAnonymized: false,
        needsRedaction: true,
      });
    }
    expect(byTarget.get(String(bareTombstone._id))).toMatchObject({
      state: 'recovery_required',
      accessDisabled: true,
      identityRemoved: false,
      legacyAnonymized: false,
      needsRedaction: true,
    });

    for (const target of [fullLegacy, halfName, halfEmail, bareTombstone]) {
      const preview = await request(
        'GET',
        `/api/admin/users/${target._id}/anonymize/preview`,
        { cookie: superCookie },
      );
      expect(preview.status).toBe(200);
      const listed = byTarget.get(String(target._id));
      expect(preview.body.data.target).toMatchObject({
        identityRemoved: listed.identityRemoved,
        needsRedaction: listed.needsRedaction,
        accessDisabled: listed.accessDisabled,
      });
      expect(Boolean(preview.body.data.target.legacyAnonymized)).toBe(listed.legacyAnonymized);
    }
  });

  it('blocks failed professional transfers and clears the blocker only after a settled retry state', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
    });
    const payment = await createPayment({
      booking,
      customer: customer._id,
      professional: professional._id,
    });
    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          transferStatus: 'failed',
          professionalPayout: 80,
          stripeTransferId: null,
          transferredAt: null,
        },
      },
    );

    const blocked = await request(
      'GET',
      `/api/admin/users/${professional._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(blocked.status).toBe(200);
    expect(blocked.body.data.status).toBe('blocked');
    expect(blocked.body.data.eligible).toBe(false);
    expect(blocked.body.data.blockers.map((entry: any) => entry.code)).toContain('PAYMENT_OBLIGATIONS');

    await Payment.updateOne(
      { _id: payment._id },
      {
        $set: {
          transferStatus: 'succeeded',
          stripeTransferId: 'tr_success_after_retry',
          transferredAt: new Date(),
        },
      },
    );
    const settled = await request(
      'GET',
      `/api/admin/users/${professional._id}/anonymize/preview`,
      { cookie: superCookie },
    );
    expect(settled.status).toBe(200);
    expect(settled.body.data.status).toBe('eligible');
    expect(settled.body.data.blockers).toEqual([]);
  });

  it('does not treat an in-band admin marker as authorship and keeps admin notes structured', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const forged = 'Please cancel\n\nAdmin resolution note: my private phone is +32 499 99 99 99';
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'cancelled',
      extra: {
        cancellation: {
          cancelledBy: customer._id,
          reason: forged,
          cancelledAt: new Date('2026-01-02T00:00:00.000Z'),
        },
        statusHistory: [{
          status: 'cancelled',
          timestamp: new Date('2026-01-02T00:00:00.000Z'),
          updatedBy: adminUser._id,
          note: `Cancellation approved by admin: ${forged}`,
        }],
      },
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${customer._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    expect(execute.body.data.fullyAnonymized).toBe(true);
    const stored = await Booking.findById(booking._id).lean();
    expect(stored?.cancellation?.reason).toBe('[deleted]');
    expect(stored?.statusHistory?.find((entry: any) => entry.status === 'cancelled')?.note)
      .toBe('Cancellation approved by admin: [deleted]');
    expect(JSON.stringify(stored)).not.toContain('+32 499 99 99 99');

    const approvalCustomer = await createTarget('customer');
    const approvalProfessional = await createTarget('professional');
    const approvalBooking = await createBooking({
      customer: approvalCustomer._id,
      professional: approvalProfessional._id,
      status: 'quote_rejected',
    });
    const requestDoc = await CancellationRequest.create({
      booking: approvalBooking._id,
      requestedBy: approvalCustomer._id,
      requestedRole: 'customer',
      reasonCategory: 'no_longer_needed',
      reason: 'Private requester reason with +32 488 11 11 11',
      evidence: [s3Url('dispute-attachments', String(approvalCustomer._id), 'proof.pdf')],
      status: 'pending',
    });
    const approval = await request(
      'POST',
      `/api/admin/cancellation-requests/${requestDoc._id}/approve`,
      {
        cookie: superCookie,
        body: { resolutionNote: 'Admin decision recorded separately' },
      },
    );
    expect(approval.status).toBe(200);
    const approvedRequest = await CancellationRequest.findById(requestDoc._id).lean();
    expect(approvedRequest?.reason).toBe('Private requester reason with +32 488 11 11 11');
    expect(approvedRequest?.adminResolutionNote).toBe('Admin decision recorded separately');

    const anonymizeApproval = await request(
      'PUT',
      `/api/admin/users/${approvalCustomer._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(anonymizeApproval.status).toBe(200);
    const storedRequest = await CancellationRequest.findById(requestDoc._id).lean();
    expect(storedRequest?.reason).toBe('[deleted]');
    expect(storedRequest?.adminResolutionNote).toBe('Admin decision recorded separately');
    const storedApprovalBooking = await Booking.findById(approvalBooking._id).lean();
    expect(storedApprovalBooking?.cancellation?.reason).toBe('[deleted]');
    expect(storedApprovalBooking?.cancellation?.adminResolutionNote).toBe('Admin decision recorded separately');
    expect(JSON.stringify(storedApprovalBooking)).not.toContain('+32 488 11 11 11');
  });

  it('masks nested admin actors, cancellation narratives, and warranty evidence for a tombstoned target', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    await User.updateOne(
      { _id: customer._id },
      { $set: { deletedAt: new Date('2026-01-01T00:00:00.000Z') } },
    );
    const targetEvidence = s3Url('dispute-attachments', String(customer._id), 'private-proof.pdf');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
      extra: {
        rescheduleHistory: [{
          requestedBy: customer._id,
          requestedAt: new Date('2026-01-03T00:00:00.000Z'),
          reason: 'Private reschedule phone +32 477 00 00 00',
          status: 'declined',
          respondedAt: new Date('2026-01-03T01:00:00.000Z'),
          respondedBy: professional._id,
        }],
      },
    });
    await CancellationRequest.create({
      booking: booking._id,
      requestedBy: customer._id,
      requestedRole: 'customer',
      reasonCategory: 'no_longer_needed',
      reason: 'Private cancellation phone +32 466 00 00 00',
      evidence: [targetEvidence],
      status: 'approved',
      resolvedBy: adminUser._id,
      resolvedAt: new Date(),
    });
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: customer._id,
      professional: professional._id,
      status: 'open',
      reason: 'defect',
      description: 'Private warranty phone +32 455 00 00 00',
      evidence: [targetEvidence],
      openedAt: new Date('2026-01-04T00:00:00.000Z'),
      statusHistory: [{
        status: 'open',
        timestamp: new Date('2026-01-04T00:00:00.000Z'),
        updatedBy: customer._id,
        note: 'Private warranty note +32 455 00 00 00',
      }],
    });

    const adminBooking = await request(
      'GET',
      `/api/admin/bookings/${booking._id}/full`,
      { cookie: superCookie },
    );
    expect(adminBooking.status).toBe(200);
    expect(adminBooking.body.data.booking.rescheduleHistory[0].requestedBy.name).toBe('[deleted user]');
    expect(adminBooking.body.data.booking.rescheduleHistory[0].requestedBy.email).toBeNull();
    expect(adminBooking.body.data.cancellationRequests[0].reason).toBe('[deleted]');
    expect(adminBooking.body.data.cancellationRequests[0].evidence).toEqual([]);
    expect(JSON.stringify(adminBooking.body)).not.toContain('+32 477 00 00 00');
    expect(JSON.stringify(adminBooking.body)).not.toContain('+32 466 00 00 00');

    const adminWarranty = await request(
      'GET',
      '/api/warranty-claims/admin/list',
      { cookie: superCookie },
    );
    expect(adminWarranty.status).toBe(200);
    const storedClaim = adminWarranty.body.data.claims.find((entry: any) => String(entry._id) === String(claim._id));
    expect(storedClaim?.description).toBe('[deleted]');
    expect((storedClaim?.statusHistory || []).map((entry: any) => entry.note)).not.toContain(
      'Private warranty note +32 455 00 00 00',
    );
    expect(storedClaim?.evidence).toEqual([]);
    expect(JSON.stringify(adminWarranty.body)).not.toContain('+32 455 00 00 00');
    expect(JSON.stringify(adminWarranty.body)).not.toContain(targetEvidence);
  });

  it('masks a tombstoned customer warranty decision note in details, activity, canonical, and admin full', async () => {
    const customer = await createTarget('customer', {
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
    });
    const privateDecision = 'Private customer warranty decision +32 455 10 20 30';
    const privateClose = 'Private customer close note +32 455 10 20 31';
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: customer._id,
      professional: professional._id,
      status: 'closed',
      reason: 'defect',
      description: 'Private customer warranty description +32 455 10 20 32',
      evidence: [],
      warrantyEndsAt: new Date('2027-01-01T00:00:00.000Z'),
      openedAt: new Date('2026-02-01T00:00:00.000Z'),
      proposal: {
        message: 'Professional proposal stays for the active professional',
        proposedBy: professional._id,
        proposedAt: new Date('2026-02-02T00:00:00.000Z'),
        customerDecision: 'declined',
        decidedAt: new Date('2026-02-03T00:00:00.000Z'),
        decisionNote: privateDecision,
      },
      statusHistory: [
        {
          status: 'open',
          timestamp: new Date('2026-02-01T00:00:00.000Z'),
          updatedBy: customer._id,
          note: 'Private customer open note +32 455 10 20 33',
        },
        {
          status: 'closed',
          timestamp: new Date('2026-02-04T00:00:00.000Z'),
          updatedBy: customer._id,
          note: privateClose,
        },
      ],
    });

    const participantDetails = await request(
      'GET',
      `/api/bookings/${booking._id}/details`,
      { cookie: jwtCookie(professional) },
    );
    expect(participantDetails.status).toBe(200);
    const details = participantDetails.body.data;
    expect(details.warrantyClaims).toHaveLength(1);
    expect(details.warrantyClaims[0]).toMatchObject({
      id: String(claim._id),
      claimNumber: claim.claimNumber,
      status: 'closed',
      reason: 'defect',
      linkHint: 'participant_warranty',
    });
    expect(details.parties.professional.name).toBe('Piet Professional');
    expect(
      details.activity.items.find((item: any) => item.type === 'warranty_proposal_declined')?.description,
    ).toBe('[deleted]');
    expect(JSON.stringify(details.activity)).not.toContain(privateDecision);

    const participantActivity = await request(
      'GET',
      `/api/bookings/${booking._id}/activity`,
      { cookie: jwtCookie(professional) },
    );
    expect(participantActivity.status).toBe(200);
    expect(
      participantActivity.body.data.items.find((item: any) => item.type === 'warranty_proposal_declined')?.description,
    ).toBe('[deleted]');
    expect(JSON.stringify(participantActivity.body.data)).not.toContain(privateDecision);

    const canonical = await request(
      'GET',
      `/api/bookings/${booking._id}`,
      { cookie: jwtCookie(professional) },
    );
    expect(canonical.status).toBe(200);
    expect(canonical.body.details.warrantyClaims[0].claimNumber).toBe(claim.claimNumber);
    expect(JSON.stringify(canonical.body)).not.toContain(privateDecision);

    const adminFull = await request(
      'GET',
      `/api/admin/bookings/${booking._id}/full`,
      { cookie: superCookie },
    );
    expect(adminFull.status).toBe(200);
    expect(adminFull.body.data.details.warrantyClaims[0]).toMatchObject({
      id: String(claim._id),
      claimNumber: claim.claimNumber,
      status: 'closed',
      reason: 'defect',
      linkHint: 'admin_warranty',
    });
    expect(adminFull.body.data.details.adminLinks.warrantyClaims).toBe('/admin/warranty-claims');
    expect(
      adminFull.body.data.details.activity.items.find((item: any) => item.type === 'warranty_closed')?.description,
    ).toBe('[deleted]');
    expect(JSON.stringify(adminFull.body)).not.toContain(privateDecision);
    expect(JSON.stringify(adminFull.body)).not.toContain(privateClose);
  });

  it('masks an anonymized professional warranty escalation note without stripping the active customer decision', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional', {
      isAnonymized: true,
      anonymizedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
    });
    const activeDecision = 'Active customer decision note stays visible';
    const privateEscalation = 'Private professional warranty escalation +32 455 10 20 40';
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: customer._id,
      professional: professional._id,
      status: 'escalated',
      reason: 'incomplete_work',
      description: 'Customer warranty description',
      evidence: [],
      openedAt: new Date('2026-02-01T00:00:00.000Z'),
      proposal: {
        message: 'Private professional proposal message +32 455 10 20 41',
        proposedBy: professional._id,
        proposedAt: new Date('2026-02-02T00:00:00.000Z'),
        customerDecision: 'declined',
        decidedAt: new Date('2026-02-03T00:00:00.000Z'),
        decisionNote: activeDecision,
      },
      escalation: {
        escalatedAt: new Date('2026-02-04T00:00:00.000Z'),
        escalatedBy: professional._id,
        autoEscalated: false,
        reason: privateEscalation,
      },
    });

    const participantDetails = await request(
      'GET',
      `/api/bookings/${booking._id}/details`,
      { cookie: jwtCookie(customer) },
    );
    expect(participantDetails.status).toBe(200);
    const details = participantDetails.body.data;
    expect(details.warrantyClaims[0]).toMatchObject({
      id: String(claim._id),
      status: 'escalated',
      reason: 'incomplete_work',
      linkHint: 'participant_warranty',
    });
    expect(details.parties.customer.name).toBe('Carla Customer');
    expect(details.parties.professional.isAnonymized).toBe(true);
    expect(
      details.activity.items.find((item: any) => item.type === 'warranty_proposal_declined')?.description,
    ).toBe(activeDecision);
    const escalation = details.activity.items.find((item: any) => item.type === 'warranty_escalated');
    expect(escalation?.description).toBe('[deleted]');
    expect(escalation?.actor?.isAnonymized).toBe(true);
    expect(JSON.stringify(details.activity)).not.toContain(privateEscalation);
  });

  it('masks a tombstoned customer warranty narrative on the booking warranty route', async () => {
    const customer = await createTarget('customer', {
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const professional = await createTarget('professional');
    const otherCustomer = await createTarget('customer');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
    });
    const privateDecision = 'Private customer warranty route decision +32 455 20 20 30';
    const privateDescription = 'Private customer warranty route description +32 455 20 20 31';
    const privateCustomerNote = 'Private customer warranty route status note +32 455 20 20 32';
    const privateEvidence = s3Url('warranty-claims', String(customer._id), 'customer-proof.pdf');
    const professionalNote = 'Active professional status note stays visible';
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: customer._id,
      professional: professional._id,
      status: 'escalated',
      reason: 'defect',
      description: privateDescription,
      evidence: [privateEvidence],
      openedAt: new Date('2026-02-01T00:00:00.000Z'),
      proposal: {
        message: 'Active professional proposal stays visible',
        proposedBy: professional._id,
        proposedAt: new Date('2026-02-02T00:00:00.000Z'),
        customerDecision: 'declined',
        decidedAt: new Date('2026-02-03T00:00:00.000Z'),
        decisionNote: privateDecision,
      },
      statusHistory: [
        {
          status: 'open',
          timestamp: new Date('2026-02-01T00:00:00.000Z'),
          updatedBy: customer._id,
          note: privateCustomerNote,
        },
        {
          status: 'escalated',
          timestamp: new Date('2026-02-04T00:00:00.000Z'),
          updatedBy: professional._id,
          note: professionalNote,
        },
      ],
    });

    const asProfessional = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
      { cookie: jwtCookie(professional) },
    );
    expect(asProfessional.status).toBe(200);
    const { activeClaim, latestClaim } = asProfessional.body.data;
    expect(activeClaim).toMatchObject({
      _id: String(claim._id),
      claimNumber: claim.claimNumber,
      status: 'escalated',
      reason: 'defect',
    });
    expect(latestClaim._id).toBe(String(claim._id));
    expect(String(activeClaim.customer)).toBe(String(customer._id));
    expect(String(activeClaim.professional)).toBe(String(professional._id));
    expect(activeClaim.description).toBe('[deleted]');
    expect(activeClaim.proposal).toMatchObject({
      message: 'Active professional proposal stays visible',
      decisionNote: '[deleted]',
    });
    expect(activeClaim.statusHistory.map((entry: any) => entry.note)).toEqual([
      '[deleted]',
      professionalNote,
    ]);
    expect(activeClaim.evidence).toEqual([]);
    expect(JSON.stringify(asProfessional.body)).not.toContain(privateDecision);
    expect(JSON.stringify(asProfessional.body)).not.toContain(privateDescription);
    expect(JSON.stringify(asProfessional.body)).not.toContain(privateCustomerNote);
    expect(JSON.stringify(asProfessional.body)).not.toContain(privateEvidence);

    const asAdmin = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
      { cookie: superCookie },
    );
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.latestClaim._id).toBe(String(claim._id));
    expect(JSON.stringify(asAdmin.body)).not.toContain(privateDecision);
    expect(JSON.stringify(asAdmin.body)).not.toContain(privateCustomerNote);

    const nonParticipant = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
      { cookie: jwtCookie(otherCustomer) },
    );
    expect(nonParticipant.status).toBe(403);

    const unauthenticated = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
    );
    expect(unauthenticated.status).toBe(401);
  });

  it('masks an anonymized professional warranty proposal on the booking warranty route', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional', {
      isAnonymized: true,
      anonymizedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
    });
    const privateProposal = 'Private professional warranty route proposal +32 455 20 20 40';
    const privateEscalation = 'Private professional warranty route escalation +32 455 20 20 41';
    const privateResolution = 'Private professional warranty route resolution +32 455 20 20 42';
    const activeDescription = 'Active customer warranty description stays visible';
    const activeDecision = 'Active customer warranty decision stays visible';
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: customer._id,
      professional: professional._id,
      status: 'escalated',
      reason: 'incomplete_work',
      description: activeDescription,
      evidence: [],
      openedAt: new Date('2026-02-01T00:00:00.000Z'),
      proposal: {
        message: privateProposal,
        proposedBy: professional._id,
        proposedAt: new Date('2026-02-02T00:00:00.000Z'),
        customerDecision: 'declined',
        decidedAt: new Date('2026-02-03T00:00:00.000Z'),
        decisionNote: activeDecision,
      },
      escalation: {
        escalatedAt: new Date('2026-02-04T00:00:00.000Z'),
        escalatedBy: professional._id,
        autoEscalated: false,
        reason: privateEscalation,
      },
      resolution: {
        summary: privateResolution,
        resolvedAt: new Date('2026-02-05T00:00:00.000Z'),
        resolvedBy: professional._id,
      },
    });

    const asCustomer = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
      { cookie: jwtCookie(customer) },
    );
    expect(asCustomer.status).toBe(200);
    const claimBody = asCustomer.body.data.latestClaim;
    expect(claimBody).toMatchObject({
      _id: String(claim._id),
      claimNumber: claim.claimNumber,
      status: 'escalated',
      reason: 'incomplete_work',
      description: activeDescription,
    });
    expect(String(claimBody.customer)).toBe(String(customer._id));
    expect(String(claimBody.professional)).toBe(String(professional._id));
    expect(claimBody.proposal).toMatchObject({
      message: '[deleted]',
      decisionNote: activeDecision,
    });
    expect(claimBody.escalation.reason).toBe('[deleted]');
    expect(claimBody.resolution.summary).toBe('[deleted]');
    expect(JSON.stringify(asCustomer.body)).not.toContain(privateProposal);
    expect(JSON.stringify(asCustomer.body)).not.toContain(privateEscalation);
    expect(JSON.stringify(asCustomer.body)).not.toContain(privateResolution);
  });

  it('leaves an ordinary active counterparty warranty narrative unchanged on the booking warranty route', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
    });
    const activeDecision = 'Ordinary active customer decision note';
    const activeProposal = 'Ordinary active professional proposal message';
    const claim = await WarrantyClaim.create({
      booking: booking._id,
      customer: customer._id,
      professional: professional._id,
      status: 'proposal_sent',
      reason: 'defect',
      description: 'Ordinary active customer warranty description',
      evidence: [],
      openedAt: new Date('2026-02-01T00:00:00.000Z'),
      proposal: {
        message: activeProposal,
        proposedBy: professional._id,
        proposedAt: new Date('2026-02-02T00:00:00.000Z'),
        customerDecision: 'declined',
        decidedAt: new Date('2026-02-03T00:00:00.000Z'),
        decisionNote: activeDecision,
      },
    });

    const asCustomer = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
      { cookie: jwtCookie(customer) },
    );
    expect(asCustomer.status).toBe(200);
    const claimBody = asCustomer.body.data.latestClaim;
    expect(claimBody).toMatchObject({
      _id: String(claim._id),
      status: 'proposal_sent',
      description: 'Ordinary active customer warranty description',
    });
    expect(claimBody.proposal.message).toBe(activeProposal);
    expect(claimBody.proposal.decisionNote).toBe(activeDecision);
    expect(String(claimBody.customer)).toBe(String(customer._id));
    expect(String(claimBody.professional)).toBe(String(professional._id));

    const asProfessional = await request(
      'GET',
      `/api/warranty-claims/booking/${booking._id}`,
      { cookie: jwtCookie(professional) },
    );
    expect(asProfessional.status).toBe(200);
    expect(asProfessional.body.data.latestClaim.proposal.message).toBe(activeProposal);
  });

  it('redacts post-booking question snapshot attachments in the write path and deletes the owned keys', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const targetFile = s3Url('projects', String(professional._id), 'post-plan.pdf');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
      extra: {
        bookingSnapshot: {
          capturedAt: new Date('2026-01-02T00:00:00.000Z'),
          source: 'booking_creation',
          questions: {
            rfq: [{
              question: 'Upload plan',
              type: 'attachment',
              professionalAttachments: [targetFile],
            }],
          },
        },
        postBookingQuestionSnapshot: {
          capturedAt: new Date('2026-01-03T00:00:00.000Z'),
          source: 'post_booking_submission',
          questions: [{
            question: 'Upload access plan',
            type: 'attachment',
            professionalAttachments: [targetFile],
          }],
        },
      },
    });

    const execute = await request(
      'PUT',
      `/api/admin/users/${professional._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    const stored = await Booking.findById(booking._id).lean();
    expect(stored?.bookingSnapshot?.questions?.rfq?.[0]?.professionalAttachments).toEqual([]);
    expect(stored?.postBookingQuestionSnapshot?.questions?.[0]?.professionalAttachments).toEqual([]);
    expect(s3.deleteCalls).toContain(`projects/${professional._id}/post-plan.pdf`);
  });

  it('keeps employee self-delete unsupported with an explicit error instead of a generic failure', async () => {
    const employee = await User.create({
      name: 'Emma Self Delete',
      email: `employee-self-${new Types.ObjectId().toHexString()}@example.com`,
      phone: `+32${Date.now()}${Math.floor(Math.random() * 1000)}`,
      password: await bcrypt.hash('employee-pass-123', 4),
      role: 'employee',
      employee: { companyId: new Types.ObjectId(), isActive: true },
    });
    const response = await request(
      'DELETE',
      '/api/user/me/account',
      { cookie: jwtCookie(employee) },
    );
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('UNSUPPORTED_ACCOUNT_ROLE');
    expect((await User.findById(employee._id).lean())?.deletedAt ?? null).toBeNull();
  });

  it('preserves counterparty block reasons and quote provenance when only the professional is anonymized', async () => {
    const customer = await createTarget('customer');
    const professional = await createTarget('professional');
    const booking = await createBooking({
      customer: customer._id,
      professional: professional._id,
      status: 'completed',
      extra: {
        customerBlocks: {
          dates: [{ date: new Date('2026-02-01T00:00:00.000Z'), reason: 'Customer family event' }],
          windows: [{
            date: new Date('2026-02-02T00:00:00.000Z'),
            startTime: '09:00',
            endTime: '12:00',
            reason: 'Customer appointment',
          }],
        },
        quoteVersions: [{
          version: 1,
          quotationNumber: 'QUO-PROV-1',
          scope: 'Counterparty-authored scope',
          warrantyDuration: { value: 1, unit: 'years' },
          materialsIncluded: true,
          description: 'Quotation',
          totalAmount: 100,
          currency: 'EUR',
          preparationDuration: { value: 1, unit: 'days' },
          executionDuration: { value: 1, unit: 'days' },
          validUntil: new Date('2026-12-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-05T00:00:00.000Z'),
          createdBy: customer._id,
          changeNote: 'Customer-authored note stays',
          rejectedAt: new Date('2026-01-06T00:00:00.000Z'),
          rejectedBy: customer._id,
          rejectionReason: 'Customer rejection stays',
        }],
      },
    });
    const execute = await request(
      'PUT',
      `/api/admin/users/${professional._id}/anonymize`,
      { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
    );
    expect(execute.status).toBe(200);
    const stored = await Booking.findById(booking._id).lean();
    expect(stored?.customerBlocks?.dates?.[0]?.reason).toBe('Customer family event');
    expect(stored?.customerBlocks?.windows?.[0]?.reason).toBe('Customer appointment');
    expect(stored?.quoteVersions?.[0]?.changeNote).toBe('Customer-authored note stays');
    expect(stored?.quoteVersions?.[0]?.rejectionReason).toBe('Customer rejection stays');

    const details = await request(
      'GET',
      `/api/bookings/${booking._id}/details`,
      { cookie: jwtCookie(customer) },
    );
    expect(details.status).toBe(200);
    expect(details.body.data.wizard?.customerBlocks?.dates?.[0]?.reason)
      .toBe('Customer family event');
  });

  it('fences FCM, avatar, and ID-proof saves through the shared account boundary', async () => {
    const fcmTarget = await createTarget('professional');
    const fcmBarrier = pauseUserRead(fcmTarget._id);
    try {
      const pendingFcm = request(
        'POST',
        '/api/user/fcm/token',
        {
          cookie: jwtCookie(fcmTarget),
          body: { token: 'private-device-token', origin: 'https://app.example' },
        },
      );
      await fcmBarrier.reached;
      const execute = await request(
        'PUT',
        `/api/admin/users/${fcmTarget._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      fcmBarrier.release();
      const response = await pendingFcm;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ACCOUNT_UNAVAILABLE');
      const stored = await User.findById(fcmTarget._id).select('+fcmTokens').lean();
      expect(stored?.fcmTokens ?? []).toEqual([]);
    } finally {
      fcmBarrier.restore();
      fcmBarrier.release();
    }

    const avatarTarget = await createTarget('professional');
    const avatarBarrier = pauseUserRead(avatarTarget._id);
    try {
      const form = new FormData();
      form.append('profileImage', new Blob([pngBytes], { type: 'image/png' }), 'avatar.png');
      const pendingAvatar = requestMultipart(
        'POST',
        '/api/user/profile-image',
        { cookie: jwtCookie(avatarTarget), form },
      );
      await avatarBarrier.reached;
      const execute = await request(
        'PUT',
        `/api/admin/users/${avatarTarget._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      avatarBarrier.release();
      const response = await pendingAvatar;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ACCOUNT_UNAVAILABLE');
      const uploadedKey = s3.uploadCalls[s3.uploadCalls.length - 1];
      const stored = await User.findById(avatarTarget._id).lean();
      expect(stored?.profileImage).toBeUndefined();
      expect(s3.deleteCalls).toContain(uploadedKey);
    } finally {
      avatarBarrier.restore();
      avatarBarrier.release();
    }

    const idTarget = await createTarget('professional');
    const idBarrier = pauseUserRead(idTarget._id);
    try {
      const form = new FormData();
      form.append('idProof', new Blob([pdfBytes], { type: 'application/pdf' }), 'id.pdf');
      const pendingId = requestMultipart(
        'POST',
        '/api/user/id-proof',
        { cookie: jwtCookie(idTarget), form },
      );
      await idBarrier.reached;
      const execute = await request(
        'PUT',
        `/api/admin/users/${idTarget._id}/anonymize`,
        { cookie: superCookie, body: { confirm: 'ANONYMIZE' } },
      );
      expect(execute.status).toBe(200);
      idBarrier.release();
      const response = await pendingId;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ACCOUNT_UNAVAILABLE');
      const uploadedKey = s3.uploadCalls[s3.uploadCalls.length - 1];
      const stored = await User.findById(idTarget._id).lean();
      expect(stored?.idProofUrl).toBeUndefined();
      expect(stored?.idProofFileName).toBeUndefined();
      expect(s3.deleteCalls).toContain(uploadedKey);
    } finally {
      idBarrier.restore();
      idBarrier.release();
    }
  });

  it('keeps the normal fenced profile and booking write paths working for active accounts', async () => {
    const target = await createTarget('customer');
    const professional = await createTarget('professional');
    const profile = await request(
      'PUT',
      '/api/user/customer-profile',
      {
        cookie: jwtCookie(target),
        body: { address: 'Active Street 2', city: 'Brussels', postalCode: '1000' },
      },
    );
    expect(profile.status).toBe(200);
    expect((await User.findById(target._id).lean())?.location?.address).toBe('Active Street 2');
    const guard = await AccountDataGuard.findById(target._id).lean();
    expect(guard?.state).toBe('active');

    const booking = await request(
      'POST',
      '/api/bookings/create',
      {
        cookie: jwtCookie(target),
        body: {
          bookingType: 'professional',
          professionalId: String(professional._id),
          rfqData: {
            serviceType: 'Bathroom renovation',
            description: 'Active booking creation with a valid service address.',
            urgency: 'medium',
          },
          serviceCountry: 'BE',
          proceedAtStandardVat: true,
        },
      },
    );
    expect(booking.status).toBe(201);
    expect(await Booking.countDocuments({ customer: target._id, professional: professional._id })).toBe(1);
  });
});
