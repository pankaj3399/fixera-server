import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { Types } from 'mongoose';

/**
 * The conversation list shows a translated "Chat closed" preview. Any
 * participant could send the close-notice text, so the list now reports the
 * last message's sender role for such previews and the frontend applies the
 * thread's check (system sender only).
 */
const testUri = process.env.FIXERA_TEST_MONGODB_URI;
const hasDisposableMongo = Boolean(testUri && /test/i.test(testUri));
const describeDb = hasDisposableMongo ? describe : describe.skip;

vi.mock('../../config/db', () => ({ default: vi.fn(async () => undefined) }));

import Conversation from '../../models/conversation';
import ChatMessage from '../../models/chatMessage';
import User from '../../models/user';
import { listMyConversations } from '../../handlers/Chat';
import { formatChatClosedMessage } from '../../utils/adminSupportChat';

const customerId = new Types.ObjectId('607f1f77bcf86cd799439301');
const proId = new Types.ObjectId('607f1f77bcf86cd799439302');
const adminId = new Types.ObjectId('607f1f77bcf86cd799439303');
const otherProId = new Types.ObjectId('607f1f77bcf86cd799439304');

const mockRes = () => ({
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
});

const insertConversation = async (fields: Record<string, unknown>, messages: Array<Record<string, unknown>>) => {
  const _id = new Types.ObjectId();
  const last = messages[messages.length - 1];
  await Conversation.collection.insertOne({
    _id,
    initiatedBy: customerId,
    status: 'active',
    starredBy: [],
    archivedBy: [],
    labels: [],
    customerUnreadCount: 0,
    professionalUnreadCount: 0,
    lastMessageAt: new Date(),
    lastMessagePreview: last.text,
    lastMessageSenderId: last.senderId,
    ...fields,
  });
  for (const message of messages) {
    await ChatMessage.collection.insertOne({
      _id: new Types.ObjectId(),
      conversationId: _id,
      messageType: 'text',
      readBy: [],
      ...message,
    });
  }
  return String(_id);
};

describeDb('conversation list close-notice sender role (real Mongo)', () => {
  beforeAll(async () => {
    await mongoose.connect(testUri!, { dbName: `fixera_chat_closed_preview_test_${Date.now()}` });
  });

  beforeEach(async () => {
    await Promise.all([Conversation.deleteMany({}), ChatMessage.deleteMany({}), User.deleteMany({})]);
    await User.collection.insertMany([
      { _id: customerId, name: 'Customer', email: 'customer@example.com', role: 'customer' },
      { _id: proId, name: 'Pro', email: 'pro@example.com', role: 'professional' },
      { _id: adminId, name: 'Admin', email: 'admin@example.com', role: 'admin' },
      { _id: otherProId, name: 'Other', email: 'other@example.com', role: 'professional' },
    ]);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('marks only the real system close notice, not a participant typing the same text', async () => {
    const closeText = formatChatClosedMessage(new Date('2026-08-29T00:35:00.000Z'));
    const spoofed = await insertConversation({ type: 'direct', customerId, professionalId: proId }, [
      { senderId: customerId, senderRole: 'customer', text: 'Hello' },
      { senderId: customerId, senderRole: 'customer', text: 'Chat closed on 1 Jan 2026, 00:00 UTC' },
    ]);
    const closed = await insertConversation(
      { type: 'support', supportAdminId: adminId, supportTargetUserId: proId, status: 'archived' },
      [
        { senderId: proId, senderRole: 'professional', text: closeText },
        { senderId: adminId, senderRole: 'system', text: closeText },
      ],
    );
    const plain = await insertConversation({ type: 'direct', customerId, professionalId: otherProId }, [
      { senderId: customerId, senderRole: 'customer', text: 'See you tomorrow' },
    ]);

    const res = mockRes();
    await listMyConversations({ user: { _id: proId, role: 'professional' }, query: {} } as any, res as any);
    expect(res.statusCode).toBe(200);
    const rows = new Map<string, any>(res.body.data.conversations.map((row: any) => [String(row._id), row]));
    expect(rows.get(spoofed)?.lastMessageSenderRole).toBe('customer');
    expect(rows.get(closed)?.lastMessageSenderRole).toBe('system');

    const customerRes = mockRes();
    await listMyConversations({ user: { _id: customerId, role: 'customer' }, query: {} } as any, customerRes as any);
    const customerRows = new Map<string, any>(customerRes.body.data.conversations.map((row: any) => [String(row._id), row]));
    expect(customerRows.get(plain)).toBeDefined();
    // Ordinary previews are not looked up.
    expect(customerRows.get(plain)).not.toHaveProperty('lastMessageSenderRole');
  });
});
