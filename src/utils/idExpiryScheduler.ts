import User from "../models/user";
import { sendIdExpiredEmail } from "./emailService";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import os from "os";

const LOCK_COLLECTION = "schedulerLocks";
const ID_EXPIRY_LOCK_ID = "id-expiry-check";
const LOCK_TTL_MS = 15 * 60 * 1000;
const LOCK_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_DAILY_RUN_HOUR_UTC = 0;
const DEFAULT_DAILY_RUN_MINUTE_UTC = 0;

interface IdExpiryLockDoc {
  _id: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface IdExpirySchedulerHandle {
  stop: () => void;
}

const getLocksCollection = () => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection is not ready for scheduler lock setup");
  }

  return db.collection<IdExpiryLockDoc>(LOCK_COLLECTION);
};

const getDailyRunTimeUtc = () => {
  const parsedHour = Number.parseInt(process.env.ID_EXPIRY_SCHEDULE_HOUR_UTC || "", 10);
  const parsedMinute = Number.parseInt(process.env.ID_EXPIRY_SCHEDULE_MINUTE_UTC || "", 10);

  const hour = Number.isInteger(parsedHour) && parsedHour >= 0 && parsedHour <= 23
    ? parsedHour
    : DEFAULT_DAILY_RUN_HOUR_UTC;
  const minute = Number.isInteger(parsedMinute) && parsedMinute >= 0 && parsedMinute <= 59
    ? parsedMinute
    : DEFAULT_DAILY_RUN_MINUTE_UTC;

  return { hour, minute };
};

const getNextDailyRunUtc = (from: Date = new Date()): Date => {
  const nextRun = new Date(from);
  const { hour, minute } = getDailyRunTimeUtc();

  nextRun.setUTCHours(hour, minute, 0, 0);
  if (nextRun.getTime() <= from.getTime()) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  return nextRun;
};

const ensureLockIndexes = async () => {
  const locksCollection = getLocksCollection();
  await locksCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "expiresAt_ttl" });
};

const acquireJobLock = async (ownerId: string): Promise<boolean> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const locksCollection = getLocksCollection();

  try {
    await locksCollection.insertOne({
      _id: ID_EXPIRY_LOCK_ID,
      ownerId,
      createdAt: now,
      updatedAt: now,
      expiresAt
    });
    return true;
  } catch (error: any) {
    if (error?.code !== 11000) {
      throw error;
    }
  }

  const updateResult = await locksCollection.updateOne(
    {
      _id: ID_EXPIRY_LOCK_ID,
      expiresAt: { $lte: now }
    },
    {
      $set: {
        ownerId,
        updatedAt: now,
        expiresAt
      }
    }
  );

  return updateResult.modifiedCount === 1;
};

const refreshJobLock = async (ownerId: string): Promise<boolean> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const locksCollection = getLocksCollection();
  const refreshResult = await locksCollection.updateOne(
    { _id: ID_EXPIRY_LOCK_ID, ownerId },
    { $set: { updatedAt: now, expiresAt } }
  );

  return refreshResult.modifiedCount === 1;
};

const releaseJobLock = async (ownerId: string) => {
  const locksCollection = getLocksCollection();
  await locksCollection.deleteOne({ _id: ID_EXPIRY_LOCK_ID, ownerId });
};

const runIdExpiryCheck = async () => {
  try {
    const now = new Date();
    const expiredUsers = await User.find({
      role: "professional",
      idExpirationDate: { $exists: true, $ne: null, $lte: now },
      $or: [
        { idExpiryEmailSentAt: { $exists: false } },
        { idExpiryEmailSentAt: null }
      ]
    }).select("email name idExpirationDate idExpiryEmailSentAt");

    if (expiredUsers.length === 0) return;

    for (const user of expiredUsers) {
      try {
        const emailSent = await sendIdExpiredEmail(user.email, user.name);
        if (emailSent) {
          user.idExpiryEmailSentAt = new Date();
          await user.save();
        }
      } catch (error) {
        console.error(`ID expiry email processing failed for user ${String(user._id)}:`, error);
      }
    }
  } catch (error) {
    console.error("ID expiry email job failed:", error);
  }
};

const runIdExpiryCheckWithLock = async (ownerId: string) => {
  let lockAcquired = false;
  let lockRefreshHandle: NodeJS.Timeout | null = null;

  try {
    lockAcquired = await acquireJobLock(ownerId);
    if (!lockAcquired) {
      console.log("[ID Expiry Scheduler] Lock not acquired; skipping this run.");
      return;
    }

    lockRefreshHandle = setInterval(async () => {
      try {
        const refreshed = await refreshJobLock(ownerId);
        if (!refreshed) {
          console.warn("[ID Expiry Scheduler] Failed to refresh lock; another process may acquire it.");
        }
      } catch (error) {
        console.error("[ID Expiry Scheduler] Lock refresh error:", error);
      }
    }, LOCK_REFRESH_MS);

    await runIdExpiryCheck();
  } catch (error) {
    console.error("[ID Expiry Scheduler] Job run failed:", error);
  } finally {
    if (lockRefreshHandle) {
      clearInterval(lockRefreshHandle);
    }

    if (lockAcquired) {
      try {
        await releaseJobLock(ownerId);
      } catch (releaseError) {
        console.error("[ID Expiry Scheduler] Failed to release lock:", releaseError);
      }
    }
  }
};

export const startIdExpiryScheduler = (): IdExpirySchedulerHandle => {
  const ownerId = `${os.hostname()}-${process.pid}-${randomUUID()}`;
  let nextRunHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNextRun = () => {
    if (stopped) return;

    const nextRun = getNextDailyRunUtc();
    const delayMs = Math.max(nextRun.getTime() - Date.now(), 1000);
    console.log(`[ID Expiry Scheduler] Next run scheduled at ${nextRun.toISOString()}`);

    nextRunHandle = setTimeout(async () => {
      await runIdExpiryCheckWithLock(ownerId);
      scheduleNextRun();
    }, delayMs);
  };

  ensureLockIndexes()
    .catch((error) => {
      console.error("[ID Expiry Scheduler] Failed to initialize lock indexes:", error);
    })
    .finally(() => {
      void runIdExpiryCheckWithLock(ownerId);
      scheduleNextRun();
    });

  return {
    stop: () => {
      stopped = true;
      if (nextRunHandle) {
        clearTimeout(nextRunHandle);
        nextRunHandle = null;
      }
    }
  };
};
