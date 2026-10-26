import crypto from 'crypto';
import mongoose from 'mongoose';
import Notification from '../../models/notification';
import User from '../../models/user';
import { sendPushToUser } from '../fcmService';
import {
  eventNamedSubjectContextKey,
  eventRequiresCounterpartyProvenance,
  getEventDef,
  type NotifyContext,
} from './registry';
import { resolveChannels, type NotificationEntityType } from './types';
import { withAnonymizationWriteFence } from '../support/accountGuard';
import { UserFacingError } from '../appErrors';
import { runWithEmailActor } from '../emailActorContext';

export interface NotifyDeliveryOptions {
  /** When false, skip in-app inbox row. Default true. */
  persistInbox?: boolean;
  /** Override registry/pref push channel resolution. */
  sendPush?: boolean;
  /** Override registry/pref email channel resolution. */
  sendEmail?: boolean;
  /** Propagate persistence/channel failures to retryable producers (for example Stripe webhooks). */
  strict?: boolean;
}

export interface NotifyArgs {
  userId: string;
  eventKey: string;
  /** User whose action produced the event. Fenced with the recipient. */
  actorId?: string;
  /** User the notification is about when not the actor. Fenced with the recipient. */
  subjectUserId?: string;
  entityType?: NotificationEntityType;
  entityId?: string;
  meta?: Record<string, unknown>;
  context?: NotifyContext;
  delivery?: NotifyDeliveryOptions;
  /** Stable key for retryable producers such as payment webhooks. */
  idempotencyKey?: string;
}

export type EmailDeliveryOutcome = 'sent' | 'not_eligible' | 'failed' | 'in_progress';

export interface NotifyResult {
  notificationId: string | null;
  emailSent: boolean;
  pushSent: boolean;
  emailOutcome?: EmailDeliveryOutcome;
  skipped?: 'unknown_event' | 'user_not_found' | 'missing_provenance';
}

const DELIVERY_CLAIM_LEASE_MS = 5 * 60 * 1000;

const optionalObjectId = (value: string | undefined): mongoose.Types.ObjectId | undefined =>
  value && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : undefined;

/** A queued delivery must not carry a tombstoned actor's old text. */
async function notificationSubjectsActive(args: NotifyArgs): Promise<boolean> {
  const ids = [...new Set(
    [args.userId, args.actorId, args.subjectUserId]
      .filter((value): value is string => Boolean(value && mongoose.Types.ObjectId.isValid(value))),
  )];
  if (ids.length === 0) return true;
  const active = await User.countDocuments({
    _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
    deletedAt: null,
    isAnonymized: { $ne: true },
  });
  return active === ids.length;
}

type DeliveryChannel = 'email' | 'push';
type DeliveryClaim =
  | { state: 'claimed'; token: string }
  | { state: 'sent' | 'in_progress' };

function deliveryFields(channel: DeliveryChannel) {
  return channel === 'email'
    ? { attempted: 'emailAttempted', sent: 'emailSent', claimedAt: 'emailClaimedAt', token: 'emailClaimToken' }
    : { attempted: 'pushAttempted', sent: 'pushSent', claimedAt: 'pushClaimedAt', token: 'pushClaimToken' };
}

async function claimDelivery(notificationId: string, channel: DeliveryChannel): Promise<DeliveryClaim> {
  const fields = deliveryFields(channel);
  const token = crypto.randomUUID();
  const now = new Date();
  const claim = await Notification.findOneAndUpdate(
    {
      _id: notificationId,
      [fields.sent]: { $ne: true },
      $or: [
        { [fields.claimedAt]: { $exists: false } },
        { [fields.claimedAt]: null },
        { [fields.claimedAt]: { $lte: new Date(now.getTime() - DELIVERY_CLAIM_LEASE_MS) } },
      ],
    },
    { $set: { [fields.attempted]: true, [fields.claimedAt]: now, [fields.token]: token } },
    { new: true },
  );
  if (claim) return { state: 'claimed', token };

  const current = await Notification.findById(notificationId).select(fields.sent).lean();
  return { state: current?.[fields.sent as keyof typeof current] ? 'sent' : 'in_progress' };
}

async function finishDelivery(
  notificationId: string,
  channel: DeliveryChannel,
  token: string,
  sent: boolean,
): Promise<void> {
  const fields = deliveryFields(channel);
  await Notification.updateOne(
    { _id: notificationId, [fields.token]: token },
    sent
      ? { $set: { [fields.sent]: true }, $unset: { [fields.claimedAt]: 1, [fields.token]: 1 } }
      : { $unset: { [fields.claimedAt]: 1, [fields.token]: 1 } },
  );
}

/**
 * Central notification dispatcher:
 * 1. Always persist an inbox row
 * 2. Dispatch email/push according to registry tier + user prefs
 *
 * Channel failures are logged and never thrown to the caller.
 */
export async function notify(args: NotifyArgs): Promise<NotifyResult> {
  const strict = args.delivery?.strict === true;
  const def = getEventDef(args.eventKey);
  if (!def) {
    console.error(`[notify] Unknown eventKey: ${args.eventKey}`);
    if (strict) throw new Error(`Unknown notification event: ${args.eventKey}`);
    return { notificationId: null, emailSent: false, pushSent: false, skipped: 'unknown_event' };
  }

  if (
    eventRequiresCounterpartyProvenance(args.eventKey)
    && !optionalObjectId(args.actorId)
    && !optionalObjectId(args.subjectUserId)
  ) {
    console.error(
      `[notify] ${args.eventKey} embeds another user's identity but no actorId/subjectUserId was supplied`,
    );
    return {
      notificationId: null,
      emailSent: false,
      pushSent: false,
      emailOutcome: 'not_eligible',
      skipped: 'missing_provenance',
    };
  }

  const ctx: NotifyContext = args.context ?? {};
  const namedSubjectKey = eventNamedSubjectContextKey(args.eventKey);
  const namedSubjectValue = namedSubjectKey ? ctx[namedSubjectKey] : undefined;
  if (
    namedSubjectKey
    && typeof namedSubjectValue === 'string'
    && namedSubjectValue.trim() !== ''
    && !optionalObjectId(args.subjectUserId)
  ) {
    console.error(
      `[notify] ${args.eventKey} names a counterparty but no subjectUserId was supplied`,
    );
    return {
      notificationId: null,
      emailSent: false,
      pushSent: false,
      emailOutcome: 'not_eligible',
      skipped: 'missing_provenance',
    };
  }

  const user = await User.findById(args.userId).select(
    'email name notificationPreferences deletedAt isAnonymized',
  );
  if (!user || user.deletedAt || user.isAnonymized) {
    console.warn(`[notify] User not found: ${args.userId}`);
    if (!user && strict) throw new Error(`Notification user not found: ${args.userId}`);
    return {
      notificationId: null,
      emailSent: false,
      pushSent: false,
      emailOutcome: 'not_eligible',
      skipped: 'user_not_found',
    };
  }

  const persistInbox = args.delivery?.persistInbox !== false;
  const built = def.build(ctx);
  const entityType = args.entityType ?? def.defaultEntityType;
  const entityId =
    args.entityId && mongoose.Types.ObjectId.isValid(args.entityId)
      ? new mongoose.Types.ObjectId(args.entityId)
      : undefined;
  const actorId = optionalObjectId(args.actorId);
  const subjectUserId = optionalObjectId(args.subjectUserId);
  const fenceIds = [user._id, actorId, subjectUserId].filter(
    (value): value is mongoose.Types.ObjectId => Boolean(value),
  );

  let notificationId: string | null = null;
  let deliveryError: unknown;
  if (persistInbox) {
    try {
      const notificationData = {
        userId: user._id,
        ...(actorId ? { actorId } : {}),
        ...(subjectUserId ? { subjectUserId } : {}),
        eventKey: args.eventKey,
        category: def.category,
        title: built.title,
        body: built.body,
        clickUrl: built.clickUrl,
        entityType,
        entityId,
        readAt: null,
        emailAttempted: false,
        emailSent: false,
        pushAttempted: false,
        pushSent: false,
        meta: args.meta,
        ...(args.idempotencyKey ? { deliveryKey: args.idempotencyKey } : {}),
      };
      const doc = await withAnonymizationWriteFence(fenceIds, async (session) => (
        args.idempotencyKey
          ? Notification.findOneAndUpdate(
              { deliveryKey: args.idempotencyKey },
              { $setOnInsert: notificationData },
              { upsert: true, new: true, session },
            )
          : Notification.create([notificationData], { session }).then(([created]) => created)
      ));
      notificationId = doc._id.toString();
    } catch (err) {
      if (err instanceof UserFacingError) {
        return {
          notificationId: null,
          emailSent: false,
          pushSent: false,
          emailOutcome: 'not_eligible',
          skipped: 'user_not_found',
        };
      }
      console.error(`[notify] Failed to persist inbox for ${args.eventKey}:`, err);
      deliveryError = err;
      // Continue to attempt channels even if persist failed (best-effort)
    }
  }

  // External delivery is outside the database transaction. Re-check the
  // actor/subject immediately before sending so a queued email/push does not
  // carry text about an account that was tombstoned after persistence.
  if (!(await notificationSubjectsActive(args))) {
    return {
      notificationId,
      emailSent: false,
      pushSent: false,
      emailOutcome: 'not_eligible',
      skipped: 'user_not_found',
    };
  }

  const channels = resolveChannels(def.tier, def.category, user.notificationPreferences);
  const sendEmail = args.delivery?.sendEmail ?? channels.sendEmail;
  const sendPush = args.delivery?.sendPush ?? channels.sendPush;
  let emailSent = false;
  let pushSent = false;
  let emailOutcome: EmailDeliveryOutcome | undefined;

  if (sendEmail && built.sendEmail && user.email) {
    let emailClaim: DeliveryClaim | null = null;
    try {
      emailClaim = notificationId ? await claimDelivery(notificationId, 'email') : null;
      if (emailClaim?.state === 'sent') {
        emailSent = true;
        emailOutcome = 'sent';
      } else if (emailClaim?.state === 'in_progress') {
        emailOutcome = 'in_progress';
      } else {
        // claimDelivery already sets emailAttempted when the lease is acquired.
        emailSent = await runWithEmailActor(
          args.actorId,
          () => built.sendEmail!({
            email: user.email,
            name: user.name || 'User',
            userId: user._id.toString(),
          }),
        );
        emailOutcome = emailSent ? 'sent' : 'failed';
        if (!emailSent) {
          deliveryError ??= new Error(`Email provider returned false for ${args.eventKey}`);
        }
        if (notificationId && emailClaim?.state === 'claimed') {
          await finishDelivery(notificationId, 'email', emailClaim.token, emailSent);
        }
      }
    } catch (err) {
      if (notificationId && emailClaim?.state === 'claimed') {
        await finishDelivery(notificationId, 'email', emailClaim.token, false);
      }
      emailOutcome = 'failed';
      deliveryError ??= err;
      console.error(`[notify] Email failed for ${args.eventKey}:`, err);
    }
  } else if (sendEmail && built.sendEmail) {
    emailOutcome = 'not_eligible';
  }

  if (sendPush) {
    let pushClaim: DeliveryClaim | null = null;
    try {
      pushClaim = notificationId ? await claimDelivery(notificationId, 'push') : null;
      if (pushClaim?.state === 'sent' || pushClaim?.state === 'in_progress') {
        if (pushClaim.state === 'sent') pushSent = true;
        return { notificationId, emailSent, pushSent, emailOutcome };
      }
      // claimDelivery already sets pushAttempted when the lease is acquired.
      await sendPushToUser(
        user._id.toString(),
        {
          title: built.title,
          body: built.body,
          type: def.category,
          clickUrl: built.clickUrl,
          data: {
            eventKey: args.eventKey,
            ...(args.entityId ? { entityId: args.entityId } : {}),
            ...(ctx.bookingId ? { bookingId: String(ctx.bookingId) } : {}),
            ...(ctx.conversationId ? { conversationId: String(ctx.conversationId) } : {}),
          },
        },
        { skipPrefCheck: true },
      );
      pushSent = true;
      if (notificationId && pushClaim?.state === 'claimed') {
        await finishDelivery(notificationId, 'push', pushClaim.token, true);
      }
    } catch (err) {
      if (notificationId && pushClaim?.state === 'claimed') {
        await finishDelivery(notificationId, 'push', pushClaim.token, false);
      }
      console.error(`[notify] Push failed for ${args.eventKey}:`, err);
      deliveryError ??= err;
    }
  }

  if (strict && deliveryError) {
    const message = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
    throw new Error(`Notification delivery failed for ${args.eventKey}: ${message}`);
  }
  return { notificationId, emailSent, pushSent, emailOutcome };
}

/** Fire-and-forget wrapper for handlers that must not await notifications. */
export function notifyAsync(args: NotifyArgs): void {
  void notify(args).catch((err) => {
    console.error(`[notifyAsync] ${args.eventKey}:`, err);
  });
}
