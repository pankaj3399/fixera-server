import Conversation, { type IConversation } from '../../models/conversation';
import { notify } from './notify';
import {
  classifyMirrorEmailOutcome,
  loadUnreadMirrorLines,
  unreadChatConversationFilter,
  unreadChatCutoff,
  unreadChatMirrorThrottleOk,
  unreadChatReminderTargets,
} from './chatEmailMirror';

const CONVERSATION_BATCH_SIZE = 25;

async function claimReminderSlot(
  conversationId: unknown,
  lastMessageAt: Date | undefined,
  previousReminderLastSentAt: Date | undefined | null,
  now: Date,
): Promise<boolean> {
  if (!lastMessageAt) return false;
  const result = await Conversation.updateOne(
    {
      _id: conversationId,
      lastMessageAt,
      unreadChatReminderLastSentAt: previousReminderLastSentAt ?? null,
    },
    { $set: { unreadChatReminderLastSentAt: now } },
  );
  return result.modifiedCount > 0;
}

async function releaseReminderClaim(
  conversationId: unknown,
  claimedAt: Date,
  claimedLastMessageAt: Date,
  previousReminderLastSentAt: Date | undefined | null,
): Promise<void> {
  const claimFilter = {
    _id: conversationId,
    lastMessageAt: claimedLastMessageAt,
    unreadChatReminderLastSentAt: claimedAt,
  };
  if (previousReminderLastSentAt) {
    await Conversation.updateOne(claimFilter, {
      $set: { unreadChatReminderLastSentAt: previousReminderLastSentAt },
    });
    return;
  }
  await Conversation.updateOne(claimFilter, { $unset: { unreadChatReminderLastSentAt: '' } });
}

async function processConversationMirror(
  conv: Pick<
    IConversation,
    | '_id'
    | 'type'
    | 'customerId'
    | 'professionalId'
    | 'supportAdminId'
    | 'supportTargetUserId'
    | 'customerUnreadCount'
    | 'professionalUnreadCount'
    | 'lastMessageSenderId'
    | 'unreadChatReminderLastSentAt'
    | 'lastMessageAt'
  >,
  now: Date,
  nowMs: number,
): Promise<{ sent: number; errors: string[] }> {
  if (!unreadChatMirrorThrottleOk(conv.unreadChatReminderLastSentAt, nowMs)) {
    return { sent: 0, errors: [] };
  }

  const targets = unreadChatReminderTargets(conv);
  if (targets.length === 0) return { sent: 0, errors: [] };

  const lastMessageAt = conv.lastMessageAt;
  if (!lastMessageAt) return { sent: 0, errors: [] };

  const previousStamp = conv.unreadChatReminderLastSentAt ?? null;
  const claimed = await claimReminderSlot(conv._id, lastMessageAt, previousStamp, now);
  if (!claimed) {
    return { sent: 0, errors: [] };
  }

  const errors: string[] = [];
  let sent = 0;
  let handledTargets = 0;

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const lines = await loadUnreadMirrorLines(String(conv._id), target.userId);
      if (lines.length === 0) return { delivery: 'empty' as const };
      const counterpartyName = lines[lines.length - 1]?.senderLabel;
      const senderUserId = lines[lines.length - 1]?.senderId;

      const notifyResult = await notify({
        userId: target.userId,
        eventKey: target.eventKey,
        entityType: 'conversation',
        entityId: String(conv._id),
        ...(senderUserId ? { actorId: senderUserId, subjectUserId: senderUserId } : {}),
        delivery: { persistInbox: false, sendPush: false },
        context: {
          conversationId: String(conv._id),
          conversationType: conv.type,
          counterpartyName,
          chatMirrorLines: lines,
        },
      });
      return { delivery: classifyMirrorEmailOutcome(notifyResult) };
    }),
  );

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      const { delivery } = result.value;
      if (delivery === 'sent') {
        sent++;
        handledTargets++;
      } else if (delivery === 'terminal') {
        handledTargets++;
      }
    } else {
      const target = targets[index];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`unreadChat ${conv._id} → ${target.userId}: ${message}`);
    }
  }

  if (handledTargets === 0) {
    await releaseReminderClaim(conv._id, now, lastMessageAt, previousStamp);
  }

  return { sent, errors };
}

export async function processUnreadChatMirrorReminders(): Promise<{
  sent: number;
  errors: string[];
}> {
  const cutoff = unreadChatCutoff();
  const errors: string[] = [];
  let sent = 0;

  const conversations = await Conversation.find(unreadChatConversationFilter(cutoff))
    .select(
      '_id type customerId professionalId supportAdminId supportTargetUserId customerUnreadCount professionalUnreadCount lastMessageSenderId unreadChatReminderLastSentAt lastMessageAt',
    )
    .sort({ unreadChatReminderLastSentAt: 1, lastMessageAt: 1, _id: 1 })
    .limit(300);

  const now = new Date();
  const nowMs = now.getTime();

  for (let offset = 0; offset < conversations.length; offset += CONVERSATION_BATCH_SIZE) {
    const batch = conversations.slice(offset, offset + CONVERSATION_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((conv) => processConversationMirror(conv, now, nowMs)),
    );

    for (const [index, result] of batchResults.entries()) {
      if (result.status === 'fulfilled') {
        sent += result.value.sent;
        errors.push(...result.value.errors);
      } else {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`unreadChat ${batch[index]._id}: ${message}`);
      }
    }
  }

  return { sent, errors };
}
