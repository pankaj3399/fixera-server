import mongoose from 'mongoose';
import ChatMessage from '../../models/chatMessage';
import type { IChatMessage } from '../../models/chatMessage';
import type { IConversation } from '../../models/conversation';
import { daysAgo } from './reminderRules';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIRROR_LIMIT = 8;

export type ChatMirrorLine = {
  senderId: string;
  senderLabel: string;
  text: string;
  sentAtIso: string;
};

export type UnreadChatTarget = {
  userId: string;
  eventKey: string;
};

export type MirrorEmailDeliveryClass = 'sent' | 'terminal' | 'retryable';

/** Classify cron mirror notify() results for claim retention vs retry. */
export function classifyMirrorEmailOutcome(result: {
  emailOutcome?: 'sent' | 'not_eligible' | 'failed' | 'in_progress';
  skipped?: string;
}): MirrorEmailDeliveryClass {
  if (result.emailOutcome === 'sent') return 'sent';
  if (result.skipped || result.emailOutcome === 'not_eligible') return 'terminal';
  return 'retryable';
}

export function unreadChatMirrorThrottleOk(
  lastSentAt: Date | undefined | null,
  nowMs = Date.now(),
): boolean {
  if (!lastSentAt) return true;
  return lastSentAt.getTime() <= nowMs - DAY_MS;
}

export function unreadChatReminderTargets(conv: Pick<
  IConversation,
  | 'type'
  | 'customerId'
  | 'professionalId'
  | 'supportAdminId'
  | 'supportTargetUserId'
  | 'customerUnreadCount'
  | 'professionalUnreadCount'
  | 'lastMessageSenderId'
>): UnreadChatTarget[] {
  const senderId = conv.lastMessageSenderId?.toString();
  const targets: UnreadChatTarget[] = [];

  if (conv.type === 'direct') {
    const customerId = conv.customerId?.toString();
    const professionalId = conv.professionalId?.toString();

    if (conv.customerUnreadCount > 0 && customerId && senderId !== customerId) {
      targets.push({ userId: customerId, eventKey: 'customer.unread_chat' });
    }
    if (conv.professionalUnreadCount > 0 && professionalId && senderId !== professionalId) {
      targets.push({ userId: professionalId, eventKey: 'professional.unread_chat' });
    }
    return targets;
  }

  const adminId = conv.supportAdminId?.toString();
  const targetUserId = conv.supportTargetUserId?.toString();

  if (targetUserId && conv.customerUnreadCount > 0 && senderId !== targetUserId) {
    targets.push({ userId: targetUserId, eventKey: 'user.unread_support_chat' });
  }
  if (adminId && targetUserId && conv.professionalUnreadCount > 0 && senderId === targetUserId) {
    targets.push({ userId: adminId, eventKey: 'admin.unread_support_chat' });
  }

  return targets;
}

export function formatMessageMirrorText(message: Pick<IChatMessage, 'text' | 'images' | 'attachments'>): string {
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text.trim();
  }
  const imageCount = message.images?.length ?? 0;
  const attachmentCount = message.attachments?.length ?? 0;
  if (imageCount > 0 && attachmentCount === 0) {
    return imageCount === 1 ? '[Image attachment]' : `[${imageCount} image attachments]`;
  }
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? '[Attachment]' : `[${attachmentCount} attachments]`;
  }
  return '[Message]';
}

export function formatMirrorInboxBody(lines: ChatMirrorLine[], counterpartyName?: string): string {
  if (lines.length === 0) {
    return counterpartyName
      ? `${counterpartyName} is waiting for your reply.`
      : 'You have unread messages waiting for your reply.';
  }
  const latest = lines[lines.length - 1];
  const preview = latest.text.length > 120 ? `${latest.text.slice(0, 117)}…` : latest.text;
  const prefix = counterpartyName ? `${counterpartyName}: ` : '';
  if (lines.length === 1) {
    return `${prefix}${preview}`;
  }
  return `${prefix}${preview} (+${lines.length - 1} more unread)`;
}

export function unreadChatConversationFilter(cutoff: Date, reminderBefore = daysAgo(1)) {
  return {
    status: 'active' as const,
    lastMessageAt: { $lte: cutoff },
    $and: [
      {
        $or: [
          { unreadChatReminderLastSentAt: { $exists: false } },
          { unreadChatReminderLastSentAt: { $lte: reminderBefore } },
        ],
      },
      {
        $or: [
          {
            type: 'direct' as const,
            $or: [{ customerUnreadCount: { $gt: 0 } }, { professionalUnreadCount: { $gt: 0 } }],
          },
          {
            type: 'support' as const,
            $or: [{ customerUnreadCount: { $gt: 0 } }, { professionalUnreadCount: { $gt: 0 } }],
          },
        ],
      },
    ],
  };
}

export async function loadUnreadMirrorLines(
  conversationId: string,
  recipientUserId: string,
  limit = DEFAULT_MIRROR_LIMIT,
): Promise<ChatMirrorLine[]> {
  if (!mongoose.Types.ObjectId.isValid(conversationId) || !mongoose.Types.ObjectId.isValid(recipientUserId)) {
    return [];
  }

  const conversationOid = new mongoose.Types.ObjectId(conversationId);
  const recipientOid = new mongoose.Types.ObjectId(recipientUserId);

  const messages = await ChatMessage.find({
    conversationId: conversationOid,
    senderId: { $ne: recipientOid },
    readBy: { $not: { $elemMatch: { userId: recipientOid } } },
  })
    .sort({ _id: -1 })
    .limit(limit)
    .populate('senderId', 'name')
    .lean();

  return messages
    .reverse()
    .map((message) => {
      const sender = message.senderId as { _id?: unknown; name?: string } | null;
      return {
        senderId: String(sender?._id || ''),
        senderLabel: sender?.name?.trim() || 'Someone',
        text: formatMessageMirrorText(message),
        sentAtIso: new Date(message.createdAt).toISOString(),
      };
    });
}

export function unreadChatCutoff(nowMs = Date.now()): Date {
  return daysAgo(1, nowMs);
}
