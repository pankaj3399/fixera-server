/**
 * RFQ Deadline Scheduler
 * Runs every 12 hours to check for:
 * 1. Expired RFQ deadlines (auto-cancel)
 * 2. RFQ deadline reminders (send after 2+ working days)
 * 3. Expired quotation validity
 *
 * Follows idExpiryScheduler.ts pattern with MongoDB distributed lock.
 */

import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import os from 'os';
import Booking from '../models/booking';
import { SYSTEM_USER_ID } from '../constants/system';
import User from '../models/user';
import { getWorkingDaysBetween } from './workingDays';
import {
  sendRfqDeadlineReminderEmail,
  sendRfqDeadlineExpiredEmail,
} from './emailService';

const LOCK_COLLECTION = 'schedulerLocks';
const RFQ_DEADLINE_LOCK_ID = 'rfq-deadline-check';
const LOCK_TTL_MS = 15 * 60 * 1000;
const LOCK_REFRESH_MS = 5 * 60 * 1000;
const RUN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface LockDoc {
  _id: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface RfqDeadlineSchedulerHandle {
  stop: () => void;
}

const getLocksCollection = () => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not ready for scheduler lock setup');
  }
  return db.collection<LockDoc>(LOCK_COLLECTION);
};

const ensureLockIndexes = async () => {
  const locksCollection = getLocksCollection();
  await locksCollection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'rfq_expiresAt_ttl' }
  ).catch(() => {
    // Index may already exist from idExpiryScheduler
  });
};

const acquireJobLock = async (ownerId: string): Promise<boolean> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const locksCollection = getLocksCollection();

  try {
    await locksCollection.insertOne({
      _id: RFQ_DEADLINE_LOCK_ID,
      ownerId,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    return true;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }

  const updateResult = await locksCollection.updateOne(
    { _id: RFQ_DEADLINE_LOCK_ID, expiresAt: { $lte: now } },
    { $set: { ownerId, updatedAt: now, expiresAt } }
  );

  return updateResult.modifiedCount === 1;
};

const refreshJobLock = async (ownerId: string): Promise<boolean> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const locksCollection = getLocksCollection();
  const result = await locksCollection.updateOne(
    { _id: RFQ_DEADLINE_LOCK_ID, ownerId },
    { $set: { updatedAt: now, expiresAt } }
  );
  return result.modifiedCount === 1;
};

const releaseJobLock = async (ownerId: string) => {
  const locksCollection = getLocksCollection();
  await locksCollection.deleteOne({ _id: RFQ_DEADLINE_LOCK_ID, ownerId });
};

const runRfqDeadlineCheck = async () => {
  try {
    const now = new Date();

    // 1. Find bookings with expired RFQ deadlines → auto-cancel
    const expiredBookings = await Booking.find({
      status: 'rfq_accepted',
      rfqDeadline: { $exists: true, $lte: now },
    }).populate('customer', 'name email').populate('professional', 'name email');

    for (const booking of expiredBookings) {
      try {
        booking.status = 'cancelled';
        booking.statusHistory.push({
          status: 'cancelled',
          timestamp: now,
          updatedBy: SYSTEM_USER_ID,
          note: 'Auto-cancelled: RFQ deadline expired without quotation submission',
        });
        await booking.save();

        const customer = booking.customer as any;
        const professional = booking.professional as any;

        if (professional?.email && customer?.email) {
          await sendRfqDeadlineExpiredEmail(
            professional.email,
            professional.name,
            customer.email,
            customer.name,
            booking._id.toString()
          );
        }
      } catch (e) {
        console.error(`[RFQ Scheduler] Failed to process expired booking ${String(booking._id)}:`, e);
      }
    }

    // 2. Find bookings needing reminder (rfq_accepted, 2+ working days since last reminder or acceptance)
    const reminderBookings = await Booking.find({
      status: 'rfq_accepted',
      rfqDeadline: { $exists: true, $gt: now },
    }).populate('professional', 'name email');

    for (const booking of reminderBookings) {
      try {
        const lastReminderOrAcceptance = booking.lastReminderSentAt || booking.rfqResponse?.respondedAt;
        if (!lastReminderOrAcceptance) continue;

        const workingDaysSince = getWorkingDaysBetween(lastReminderOrAcceptance, now);

        if (workingDaysSince >= 2) {
          const professional = booking.professional as any;
          const daysRemaining = getWorkingDaysBetween(now, booking.rfqDeadline!);

          if (professional?.email) {
            const sent = await sendRfqDeadlineReminderEmail(
              professional.email,
              professional.name,
              daysRemaining,
              booking._id.toString()
            );

            if (sent) {
              booking.rfqRemindersSent = (booking.rfqRemindersSent || 0) + 1;
              booking.lastReminderSentAt = now;
              await booking.save();
            }
          }
        }
      } catch (e) {
        console.error(`[RFQ Scheduler] Failed to process reminder for booking ${String(booking._id)}:`, e);
      }
    }

    // 3. Notify about expired quotation validity
    const expiredQuotations = await Booking.find({
      status: 'quoted',
      'quoteVersions.0': { $exists: true },
    });

    for (const booking of expiredQuotations) {
      try {
        if (!booking.quoteVersions || booking.quoteVersions.length === 0) continue;
        const currentVersion = booking.quoteVersions.find(v => v.version === booking.currentQuoteVersion);
        if (!currentVersion) continue;

        if (currentVersion.validUntil && new Date(currentVersion.validUntil) < now) {
          // TODO: Send quotation expiry notification to customer and professional
          // e.g., NotificationService.sendQuotationExpiryNotification(booking)
          console.warn(`[RFQ Scheduler] Quotation ${booking.quotationNumber} has expired validity — notification not yet implemented`);
        }
      } catch (e) {
        console.error(`[RFQ Scheduler] Failed to check quotation validity for ${String(booking._id)}:`, e);
      }
    }
  } catch (error) {
    console.error('[RFQ Deadline Scheduler] Job failed:', error);
  }
};

const runWithLock = async (ownerId: string) => {
  let lockAcquired = false;
  let lockRefreshHandle: NodeJS.Timeout | null = null;

  try {
    lockAcquired = await acquireJobLock(ownerId);
    if (!lockAcquired) {
      console.log('[RFQ Deadline Scheduler] Lock not acquired; skipping this run.');
      return;
    }

    lockRefreshHandle = setInterval(async () => {
      try {
        const refreshed = await refreshJobLock(ownerId);
        if (!refreshed) {
          console.warn(`[RFQ Deadline Scheduler] Lock refresh failed for owner ${ownerId} — another process may acquire it`);
        }
      } catch (error) {
        console.warn(`[RFQ Deadline Scheduler] Lock refresh error for owner ${ownerId} — lock may have been lost:`, error);
      }
    }, LOCK_REFRESH_MS);

    await runRfqDeadlineCheck();
  } catch (error) {
    console.error('[RFQ Deadline Scheduler] Job run failed:', error);
  } finally {
    if (lockRefreshHandle) clearInterval(lockRefreshHandle);
    if (lockAcquired) {
      try {
        await releaseJobLock(ownerId);
      } catch (e) {
        console.error('[RFQ Deadline Scheduler] Failed to release lock:', e);
      }
    }
  }
};

export const startRfqDeadlineScheduler = (): RfqDeadlineSchedulerHandle => {
  const ownerId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  let intervalHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  ensureLockIndexes().catch((error) => {
    console.error('[RFQ Deadline Scheduler] Failed to initialize lock indexes:', error);
  }).finally(() => {
    // Run immediately on startup
    void runWithLock(ownerId);

    // Then schedule every 12 hours
    if (!stopped) {
      intervalHandle = setInterval(() => {
        void runWithLock(ownerId);
      }, RUN_INTERVAL_MS);

      console.log(`[RFQ Deadline Scheduler] Started, running every 12 hours`);
    }
  });

  return {
    stop: () => {
      stopped = true;
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  };
};
