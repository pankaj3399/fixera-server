import { describe, expect, it } from 'vitest';
import { listRegistryEventKeys, getEventDef } from '../registry';

/** Spec event keys that must exist in the registry (Phases 0–3). */
const REQUIRED_EVENT_KEYS = [
  'user.chat_message',
  'customer.rfq_rejected',
  'customer.unfinished_checkout',
  'customer.reschedule_requested',
  'customer.reschedule_reminder',
  'customer.refund_negotiation',
  'customer.refund_negotiation_reminder',
  'customer.booking_cancelled_refunded',
  'customer.dispute_started',
  'customer.dispute_resolved',
  'customer.booking_started',
  'customer.completion_requested',
  'customer.completion_reminder',
  'customer.completion_extra_payment_due',
  'customer.completion_auto_accepted',
  'customer.review_request',
  'customer.review_reminder',
  'customer.review_received',
  'customer.referral_completed',
  'customer.loyalty_tier_up',
  'customer.unread_chat',
  'professional.project_published',
  'professional.project_rejected',
  'professional.project_suspended',
  'professional.rfq_received',
  'professional.rfq_reminder',
  'professional.quote_rejected',
  'professional.quote_accepted',
  'professional.booking_created',
  'professional.booking_not_started_reminder',
  'professional.reschedule_accepted',
  'professional.reschedule_requested',
  'professional.refund_request',
  'professional.refund_request_reminder',
  'professional.booking_cancelled_refunded',
  'professional.dispute_started',
  'professional.dispute_resolved',
  'professional.review_request',
  'professional.review_reminder',
  'professional.review_received',
  'professional.referral_rewarded',
  'professional.leveling_up',
  'professional.id_expiring',
  'professional.id_expiry_reminder',
  'professional.unread_chat',
  'professional.completion_auto_accepted',
] as const;

describe('notification registry coverage', () => {
  it('registers every required event key with category, tier, and build()', () => {
    const keys = new Set(listRegistryEventKeys());
    for (const key of REQUIRED_EVENT_KEYS) {
      expect(keys.has(key), `missing registry key: ${key}`).toBe(true);
      const def = getEventDef(key);
      expect(def).toBeDefined();
      expect(def!.category).toBeTruthy();
      expect(['configurable', 'email_always', 'always_on']).toContain(def!.tier);
      const built = def!.build({ bookingId: 'abc', conversationId: 'c1', actorName: 'Test' });
      expect(built.title.length).toBeGreaterThan(0);
      expect(built.body.length).toBeGreaterThan(0);
      expect(built.clickUrl.length).toBeGreaterThan(0);
    }
  });
});
