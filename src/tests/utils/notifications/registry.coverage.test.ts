import { describe, expect, it } from 'vitest';
import { listRegistryEventKeys, getEventDef } from '../../../utils/notifications/registry';

/** Spec event keys that must exist in the registry (Phases 0–3 + inbox-unify). */
const REQUIRED_EVENT_KEYS = [
  'user.chat_message',
  'customer.rfq_rejected',
  'customer.unfinished_checkout',
  'customer.payment_confirmed',
  'customer.payment_failed',
  'customer.rfq_accepted',
  'customer.quotation_received',
  'customer.quotation_updated',
  'customer.cancellation_request_received',
  'customer.refund_counter_offer',
  'customer.refund_escalated',
  'customer.refund_denied',
  'customer.refund_processed',
  'customer.warranty_proposal_sent',
  'customer.rfq_deadline_expired',
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
  'customer.invoice_ready',
  'customer.review_reminder',
  'customer.review_received',
  'customer.referral_completed',
  'customer.loyalty_tier_up',
  'customer.unread_chat',
  'user.unread_support_chat',
  'admin.unread_support_chat',
  'professional.project_published',
  'professional.project_rejected',
  'professional.project_suspended',
  'professional.rfq_received',
  'professional.rfq_reminder',
  'professional.rfq_deadline_reminder',
  'professional.rfq_deadline_expired',
  'professional.quote_rejected',
  'professional.quote_accepted',
  'professional.booking_created',
  'professional.booking_scheduled',
  'professional.completion_confirmed_by_customer',
  'professional.invoice_ready',
  'professional.booking_not_started_reminder',
  'professional.reschedule_accepted',
  'professional.reschedule_declined',
  'professional.reschedule_requested',
  'professional.refund_request',
  'professional.refund_request_reminder',
  'professional.cancellation_request_received',
  'professional.refund_escalated',
  'professional.refund_denied',
  'professional.warranty_claim_opened',
  'professional.warranty_proposal_declined',
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

  it('routes every project status notice to the specific project when available', () => {
    const projectId = '507f1f77bcf86cd799439011';
    for (const key of [
      'professional.project_published',
      'professional.project_rejected',
      'professional.project_suspended',
    ]) {
      const built = getEventDef(key)!.build({ projectId });
      expect(built.clickUrl).toContain(`/professional/projects/${projectId}`);
    }
  });

  it('falls back to the projects index when a status notice lacks a project ID', () => {
    expect(getEventDef('professional.project_published')!.build({}).clickUrl).toMatch(
      /\/professional\/projects\/?$/,
    );
  });
});
