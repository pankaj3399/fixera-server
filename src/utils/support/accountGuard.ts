import mongoose, { Types, type ClientSession } from "mongoose";
import AccountDataGuard, {
  type AccountDataGuardState,
} from "../../models/accountDataGuard";
import SupportTicket from "../../models/supportTicket";
import SupportTicketInternalNote from "../../models/supportTicketInternalNote";
import SupportMeetingNotification from "../../models/supportMeetingNotification";
import User from "../../models/user";
import { UserFacingError } from "../appErrors";
import {
  releaseCalendarReservations,
  withCalendarTransactionIfConnected,
} from "./calendarReservations";

export const ACCOUNT_WRITE_FENCE_CODE = "ACCOUNT_UNAVAILABLE";

const REMOVAL_GUARD_STATES = new Set<string>([
  "deleting",
  "deleted",
  "anonymizing",
  "anonymized",
]);

const fenceError = () => new UserFacingError(
  409,
  "This account is being deleted or anonymized and cannot accept new records.",
  ACCOUNT_WRITE_FENCE_CODE,
);

/** A concurrent fence insert is a retryable transaction conflict, not a removal. */
const concurrentFenceInsert = () => new mongoose.mongo.MongoServerError({
  message: "Another active write fence was created concurrently",
  code: 112,
  errorLabels: ["TransientTransactionError"],
});

export async function beginAccountDataRemoval(
  userId: Types.ObjectId | string,
  state: Extract<AccountDataGuardState, "deleting" | "anonymizing">,
): Promise<void> {
  const id = new Types.ObjectId(String(userId));
  await AccountDataGuard.updateOne(
    { _id: id },
    { $set: { state, startedAt: new Date() } },
    { upsert: true },
  );
}

export async function completeAccountDataRemoval(
  userId: Types.ObjectId | string,
  state: Extract<AccountDataGuardState, "deleted" | "anonymized">,
): Promise<void> {
  const id = new Types.ObjectId(String(userId));
  await AccountDataGuard.updateOne(
    { _id: id },
    {
      $setOnInsert: { startedAt: new Date() },
      $set: { state, completedAt: new Date() },
    },
    { upsert: true },
  );
}

/**
 * A support write belongs to an active account. An `active` guard row is just
 * the write-fence marker created by ordinary business writes; removal states
 * close the account.
 */
export async function assertSupportAccountWritable(
  userId: Types.ObjectId | string,
): Promise<void> {
  const id = new Types.ObjectId(String(userId));
  const [guard, user] = await Promise.all([
    AccountDataGuard.findById(id).select("state").lean(),
    User.findById(id).select("deletedAt isAnonymized").lean(),
  ]);
  const removalState = guard && REMOVAL_GUARD_STATES.has(String(guard.state));
  if (!removalState && user && !user.deletedAt && !user.isAnonymized) return;
  throw new UserFacingError(
    403,
    "This account is being deleted or anonymized and cannot create support requests.",
    "FORBIDDEN",
  );
}

const fenceIds = (
  userIds: Array<Types.ObjectId | string | null | undefined>,
): string[] => [...new Set(
  userIds
    .filter((value): value is Types.ObjectId | string => value != null && value !== "")
    .map((value) => String(value))
    .filter((value) => Types.ObjectId.isValid(value)),
)];

/**
 * Apply the account write fence inside a transaction the caller already owns
 * (for example the support calendar transaction). This is the same guard/user
 * touch as `withAnonymizationWriteFence`, without opening a nested session.
 */
export async function fenceAccountWritesInSession(
  userIds: Array<Types.ObjectId | string | null | undefined>,
  session: ClientSession,
): Promise<void> {
  for (const id of fenceIds(userIds)) {
    const objectId = new Types.ObjectId(id);
    const guard = await AccountDataGuard.findById(objectId)
      .select("state")
      .session(session)
      .lean();
    if (guard && REMOVAL_GUARD_STATES.has(String(guard.state))) {
      throw fenceError();
    }
    if (guard) {
      const touched = await AccountDataGuard.updateOne(
        { _id: objectId, state: "active" },
        { $inc: { writeFenceVersion: 1 } },
        { session },
      );
      if (touched.matchedCount !== 1) throw fenceError();
    } else {
      try {
        await AccountDataGuard.create(
          [{ _id: objectId, state: "active", startedAt: new Date(), writeFenceVersion: 1 }],
          { session },
        );
      } catch (error) {
        if ((error as { code?: unknown })?.code === 11000) {
          throw concurrentFenceInsert();
        }
        throw error;
      }
    }
    const userWrite = await User.updateOne(
      { _id: objectId, deletedAt: null, isAnonymized: { $ne: true } },
      { $inc: { writeFenceVersion: 1 } },
      { session, timestamps: false },
    );
    if (userWrite.matchedCount !== 1) throw fenceError();
  }
}

/**
 * Serialize an ordinary business write with account removal in one MongoDB
 * transaction. Both sides write the same AccountDataGuard row, and the write
 * also touches the User row that the claim and finalize steps update, so a
 * concurrent anonymization cannot commit between a preflight check and the
 * business write. The callback must use the supplied session for every write
 * and must not make external calls.
 */
export async function withAnonymizationWriteFence<T>(
  userIds: Array<Types.ObjectId | string | null | undefined>,
  write: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  const ids = fenceIds(userIds);
  if (ids.length === 0) return write(undefined);

  return withCalendarTransactionIfConnected(async (session) => {
    if (!session) return { value: await write(undefined) };
    await fenceAccountWritesInSession(ids, session);
    return { value: await write(session) };
  }).then((boxed) => boxed.value);
}

/** Remove a support record that was inserted while its owner was being removed. */
export async function discardSupportCreation(
  ticketId: Types.ObjectId | string,
): Promise<void> {
  const id = new Types.ObjectId(String(ticketId));
  const results = await Promise.allSettled([
    releaseCalendarReservations("support", id),
    SupportTicketInternalNote.deleteMany({ ticketId: id }),
    SupportMeetingNotification.deleteMany({ ticketId: id }),
  ]);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    // Keep the ticket: it is the only handle that can still release its slot
    // keys, so deleting it after a failed cleanup would strand reservations.
    console.error("Support creation cleanup incomplete:", String(id), failed.length);
    throw new Error("Support creation cleanup incomplete.");
  }
  await SupportTicket.deleteOne({ _id: id });
}
