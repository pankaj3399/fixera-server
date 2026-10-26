import { Schema, model, Document, Types } from "mongoose";

export const ACCOUNT_DATA_GUARD_STATES = [
  "active",
  "deleting",
  "deleted",
  "anonymizing",
  "anonymized",
] as const;

export type AccountDataGuardState = (typeof ACCOUNT_DATA_GUARD_STATES)[number];

/**
 * Tiny durable marker for destructive account maintenance. Support creation
 * checks it before and after persistence, so a request that raced a hard
 * delete/anonymization cannot leave fresh support PII or calendar reservations
 * behind. The marker is keyed by the user id (`_id`) and needs no extra index.
 */
export interface IAccountDataGuardCalendarRelease {
  sourceType: string;
  sourceId: Types.ObjectId;
}

export interface IAccountDataGuardCleanup {
  /** Target-owned S3 keys still waiting for deletion. */
  pendingKeys: string[];
  /** Calendar sources whose target-owned rows were redacted but keys remain. */
  pendingCalendarReleases: IAccountDataGuardCalendarRelease[];
  attempts: number;
  lastAttemptAt?: Date;
  completedAt?: Date;
  lastError?: string;
}

export interface IAccountDataGuard extends Document {
  _id: Types.ObjectId;
  state: AccountDataGuardState;
  /** Monotonic fence written by business transactions that must serialize with account removal. */
  writeFenceVersion: number;
  startedAt: Date;
  completedAt?: Date;
  externalCleanup?: IAccountDataGuardCleanup;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IAccountDataGuard>(
  {
    _id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    state: { type: String, enum: ACCOUNT_DATA_GUARD_STATES, required: true },
    writeFenceVersion: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date },
    externalCleanup: {
      pendingKeys: { type: [String], default: [] },
      pendingCalendarReleases: {
        type: [{
          sourceType: { type: String, required: true },
          sourceId: { type: Schema.Types.ObjectId, required: true },
        }],
        default: [],
      },
      attempts: { type: Number, default: 0, min: 0 },
      lastAttemptAt: { type: Date },
      completedAt: { type: Date },
      lastError: { type: String, maxlength: 500 },
    },
  },
  { timestamps: true, _id: false },
);

const AccountDataGuard = model<IAccountDataGuard>("AccountDataGuard", schema);
export default AccountDataGuard;
