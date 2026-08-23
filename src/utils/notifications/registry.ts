import type {
  ChannelTier,
  NotificationAudience,
  NotificationEntityType,
  PrefCategory,
} from './types';
import { getFrontendUrl } from '../frontendUrl';
import {
  sendRfqReceivedEmail,
  sendBookingStartedEmail,
  sendProfessionalCompletedEmail,
  sendProfessionalNewBookingEmail,
  sendRfqRejectedEmail,
  sendQuotationAcceptedEmail,
  sendQuotationRejectedEmail,
  sendNotificationEmail,
  sendPaymentConfirmedEmail,
  sendBookingScheduledProfessionalEmail,
  sendRescheduleRequestedEmail,
  sendRescheduleRequestedByCustomerEmail,
  sendRescheduleResolvedEmail,
  sendBookingCancelledPartyEmail,
  sendRefundProcessedEmail,
  sendCustomerConfirmedCompletionEmail,
  sendDisputeRaisedProfessionalPartyEmail,
  sendDisputeResolvedPartyEmail,
  sendRfqAcceptedEmail,
  sendQuotationReceivedEmail,
  sendDirectQuotationEmail,
  sendQuotationUpdatedEmail,
  sendWarrantyClaimOpenedProfessionalPartyEmail,
  sendWarrantyClaimOpenedAdminEmail,
  sendWarrantyProposalSentEmail,
  sendRfqDeadlineReminderEmail,
  sendRfqDeadlineExpiredProfessionalEmail,
  sendRfqDeadlineExpiredCustomerEmail,
  sendCancellationRequestOtherPartyEmail,
  sendRefundCounterOfferEmail,
  sendRefundEscalatedEmail,
  sendRefundDeniedEmail,
  sendChatMirrorEmail,
  sendUnfinishedCheckoutEmail,
  sendPaymentFailedEmail,
} from '../emailService';
import { formatMirrorInboxBody, type ChatMirrorLine } from './chatEmailMirror';

export interface NotifyBuildResult {
  title: string;
  body: string;
  clickUrl: string;
  /** Optional transactional email; return true if sent/skipped successfully */
  sendEmail?: (args: {
    email: string;
    name: string;
    userId: string;
  }) => Promise<boolean>;
}

export interface NotifyContext {
  actorName?: string;
  previewText?: string;
  conversationId?: string;
  bookingId?: string;
  projectTitle?: string;
  customerName?: string;
  professionalName?: string;
  preferredDate?: string;
  amountLabel?: string;
  amount?: number;
  currency?: string;
  levelName?: string;
  extraCostTotal?: number;
  reason?: string;
  quotationNumber?: string;
  quoteVersion?: number;
  scheduledStart?: Date | string | null;
  oldDate?: Date | string | null;
  newDate?: Date | string | null;
  cancelledBy?: 'customer' | 'professional' | 'admin';
  refundAmount?: number;
  isPartialRefund?: boolean;
  resolution?: string;
  adjustedAmount?: number;
  claimNumber?: string;
  warrantyMessage?: string;
  daysRemaining?: number;
  requesterName?: string;
  requesterRole?: 'customer' | 'professional';
  escalationReason?: string;
  rescheduleAction?: 'accept' | 'decline';
  responseNote?: string;
  isDirectQuotation?: boolean;
  adminEmail?: string;
  conversationType?: 'direct' | 'support';
  counterpartyName?: string;
  chatMirrorLines?: ChatMirrorLine[];
  discountCode?: string;
  [key: string]: unknown;
}

export interface EventDef {
  eventKey: string;
  category: PrefCategory;
  tier: ChannelTier;
  audience: NotificationAudience;
  defaultEntityType?: NotificationEntityType;
  build: (ctx: NotifyContext) => NotifyBuildResult;
}

const frontend = (path: string) => `${getFrontendUrl()}${path.startsWith('/') ? path : `/${path}`}`;

function buildUnreadChatMirrorResult(
  ctx: NotifyContext,
  inboxTitle: string,
  emailIntro: string,
  template: string,
  clickPath?: string,
): NotifyBuildResult {
  const lines = ctx.chatMirrorLines || [];
  const counterpartyName = typeof ctx.counterpartyName === 'string' ? ctx.counterpartyName : undefined;
  const clickUrl = frontend(
    clickPath || `/chat?conversationId=${ctx.conversationId || ''}`,
  );

  return {
    title: inboxTitle,
    body: formatMirrorInboxBody(lines, counterpartyName),
    clickUrl,
    sendEmail: async ({ email, name }) =>
      sendChatMirrorEmail({
        to: email,
        userName: name || 'User',
        subject: inboxTitle,
        intro: emailIntro,
        lines,
        ctaUrl: clickUrl,
        template,
      }),
  };
}

const def = (
  eventKey: string,
  category: PrefCategory,
  tier: ChannelTier,
  audience: NotificationAudience,
  build: EventDef['build'],
  defaultEntityType?: NotificationEntityType,
): EventDef => {
  const wrappedBuild: EventDef['build'] = (ctx) => {
    const result = build(ctx);
    if (result.sendEmail) return result;
    // Every event gets a real email path so email_always / always_on (and
    // configurable-when-enabled) actually deliver mail, not only inbox/push.
    return {
      ...result,
      sendEmail: async ({ email, name }) =>
        sendNotificationEmail({
          to: email,
          userName: name || 'User',
          title: result.title,
          body: result.body,
          ctaUrl: result.clickUrl,
          template: eventKey.replace(/\./g, '_'),
          relatedBooking:
            typeof ctx.bookingId === 'string' && ctx.bookingId
              ? ctx.bookingId
              : undefined,
          attachmentUrl: typeof ctx.invoiceUrl === 'string' ? ctx.invoiceUrl : undefined,
          attachmentName: ctx.invoiceNumber ? `${String(ctx.invoiceNumber)}.pdf` : 'invoice.pdf',
        }),
    };
  };

  return {
    eventKey,
    category,
    tier,
    audience,
    build: wrappedBuild,
    defaultEntityType,
  };
};

/** Registry of product notification events. Handlers must use keys from this map. */
export const NOTIFICATION_REGISTRY: Record<string, EventDef> = {
  // --- Phase 0 / chat ---
  'user.chat_message': def(
    'user.chat_message',
    'messages',
    'configurable',
    'either',
    (ctx) => ({
      title: `New message from ${ctx.actorName || 'Someone'}`,
      body: String(ctx.previewText || 'You have a new message'),
      clickUrl: frontend(`/chat?conversationId=${ctx.conversationId || ''}`),
    }),
    'conversation',
  ),

  // --- Customer ---
  'customer.rfq_rejected': def(
    'customer.rfq_rejected',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Request declined',
      body: ctx.professionalName
        ? `${ctx.professionalName} declined your request${ctx.reason ? `: ${ctx.reason}` : '.'}`
        : 'Your booking request was declined.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqRejectedEmail(
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          String(ctx.reason || ''),
        ),
    }),
    'booking',
  ),
  'customer.unfinished_checkout': def(
    'customer.unfinished_checkout',
    'booking_updates',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'Finish your booking',
      body: ctx.projectTitle
        ? `You still need to complete payment for "${ctx.projectTitle}".`
        : 'You still have an unfinished checkout. Complete payment to confirm your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}/payment`),
      sendEmail: async ({ email, name }) =>
        sendUnfinishedCheckoutEmail(
          email,
          name,
          String(ctx.bookingId || ''),
          ctx.projectTitle ? String(ctx.projectTitle) : undefined,
          ctx.discountCode ? String(ctx.discountCode) : undefined,
        ),
    }),
    'booking',
  ),
  'customer.payment_failed': def(
    'customer.payment_failed',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Payment failed',
      body: ctx.projectTitle
        ? `We couldn't process payment for "${ctx.projectTitle}". Please retry from your booking page.`
        : "We couldn't process your payment. Please retry from your booking page.",
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}/payment`),
      sendEmail: async ({ email, name }) =>
        sendPaymentFailedEmail(
          email,
          name,
          String(ctx.bookingId || ''),
          ctx.projectTitle ? String(ctx.projectTitle) : undefined,
        ),
    }),
    'booking',
  ),
  'customer.payment_confirmed': def(
    'customer.payment_confirmed',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Payment confirmed',
      body: ctx.professionalName
        ? `Your payment for the booking with ${ctx.professionalName} has been confirmed.`
        : 'Your booking payment has been confirmed.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendPaymentConfirmedEmail(
          email,
          name,
          String(ctx.professionalName || 'your professional'),
          typeof ctx.amount === 'number' ? ctx.amount : 0,
          String(ctx.bookingId || ''),
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'customer.rfq_accepted': def(
    'customer.rfq_accepted',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Request accepted',
      body: ctx.professionalName
        ? `${ctx.professionalName} accepted your booking request.`
        : 'Your booking request was accepted.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqAcceptedEmail(
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.quotation_received': def(
    'customer.quotation_received',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'New quotation received',
      body: ctx.professionalName
        ? `${ctx.professionalName} sent you a quotation.`
        : 'You received a new quotation.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) => {
        const profName = String(ctx.professionalName || 'the professional');
        const bookingId = String(ctx.bookingId || '');
        const quotationNumber = String(ctx.quotationNumber || '');
        const amount = typeof ctx.amount === 'number' ? ctx.amount : 0;
        if (ctx.isDirectQuotation) {
          return sendDirectQuotationEmail(email, name, profName, quotationNumber, amount, bookingId);
        }
        return sendQuotationReceivedEmail(email, name, profName, quotationNumber, amount, bookingId);
      },
    }),
    'booking',
  ),
  'customer.quotation_updated': def(
    'customer.quotation_updated',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Quotation updated',
      body: ctx.professionalName
        ? `${ctx.professionalName} updated your quotation.`
        : 'Your quotation was updated.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendQuotationUpdatedEmail(
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          String(ctx.quotationNumber || ''),
          typeof ctx.quoteVersion === 'number' ? ctx.quoteVersion : 1,
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.cancellation_request_received': def(
    'customer.cancellation_request_received',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Cancellation request submitted',
      body: ctx.requesterName
        ? `${ctx.requesterName} requested cancellation of your shared booking.`
        : 'A cancellation request was submitted for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendCancellationRequestOtherPartyEmail({
          otherPartyEmail: email,
          otherPartyName: name,
          requesterName: String(ctx.requesterName || 'The other party'),
          reason: String(ctx.reason || ''),
          bookingId: String(ctx.bookingId || ''),
        }),
    }),
    'booking',
  ),
  'customer.refund_counter_offer': def(
    'customer.refund_counter_offer',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Refund counter-offer',
      body: 'The professional proposed a different refund amount. Please review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRefundCounterOfferEmail({
          customerEmail: email,
          customerName: name,
          professionalName: String(ctx.professionalName || 'the professional'),
          amount: typeof ctx.refundAmount === 'number' ? ctx.refundAmount : 0,
          note: ctx.responseNote ? String(ctx.responseNote) : undefined,
          bookingId: String(ctx.bookingId || ''),
          currency: String(ctx.currency || 'EUR'),
        }),
    }),
    'booking',
  ),
  'customer.refund_escalated': def(
    'customer.refund_escalated',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Refund request escalated',
      body: 'Your refund request was escalated to Fixtract for review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRefundEscalatedEmail({
          bookingId: String(ctx.bookingId || ''),
          reason: (['rejected', 'refused', 'no_response'] as const).includes(ctx.escalationReason as any)
            ? (ctx.escalationReason as 'rejected' | 'refused' | 'no_response')
            : 'no_response',
          customerEmail: email,
          customerName: name,
        }),
    }),
    'booking',
  ),
  'customer.refund_denied': def(
    'customer.refund_denied',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Refund request denied',
      body: 'Your cancellation/refund request was denied after admin review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRefundDeniedEmail({
          requesterEmail: email,
          requesterName: name,
          bookingId: String(ctx.bookingId || ''),
          denyReason: String(ctx.reason || ''),
        }),
    }),
    'booking',
  ),
  'customer.refund_processed': def(
    'customer.refund_processed',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: ctx.isPartialRefund ? 'Partial refund processed' : 'Refund processed',
      body: 'A refund has been processed for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRefundProcessedEmail(
          email,
          name,
          typeof ctx.refundAmount === 'number' ? ctx.refundAmount : 0,
          String(ctx.currency || 'EUR'),
          Boolean(ctx.isPartialRefund),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.warranty_proposal_sent': def(
    'customer.warranty_proposal_sent',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Warranty proposal received',
      body: ctx.professionalName
        ? `${ctx.professionalName} submitted a warranty resolution proposal.`
        : 'A warranty resolution proposal was submitted.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendWarrantyProposalSentEmail(
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          String(ctx.warrantyMessage || ''),
          String(ctx.bookingId || ''),
          String(ctx.claimNumber || ''),
        ),
    }),
    'booking',
  ),
  'customer.rfq_deadline_expired': def(
    'customer.rfq_deadline_expired',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Quotation deadline expired',
      body: 'The professional did not submit a quotation before the deadline. The booking was cancelled.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqDeadlineExpiredCustomerEmail(email, name, String(ctx.bookingId || '')),
    }),
    'booking',
  ),
  'customer.reschedule_requested': def(
    'customer.reschedule_requested',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reschedule requested',
      body: 'A reschedule has been requested for your booking. Please review and respond.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRescheduleRequestedEmail(
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          ctx.oldDate,
          ctx.newDate,
          String(ctx.reason || ''),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.reschedule_reminder': def(
    'customer.reschedule_reminder',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reminder: reschedule pending',
      body: 'A reschedule request is still waiting for a response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.refund_negotiation': def(
    'customer.refund_negotiation',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Refund negotiation started',
      body: 'A refund negotiation is in progress for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.refund_negotiation_reminder': def(
    'customer.refund_negotiation_reminder',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Reminder: refund negotiation',
      body: 'A refund negotiation is still awaiting a response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.booking_cancelled_refunded': def(
    'customer.booking_cancelled_refunded',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Booking cancelled & refunded',
      body: 'Your booking was cancelled and a refund has been processed.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendBookingCancelledPartyEmail(
          'customer',
          email,
          name,
          String(ctx.professionalName || 'the professional'),
          String(ctx.reason || 'No reason provided'),
          (ctx.cancelledBy as 'customer' | 'professional' | 'admin') || 'admin',
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.dispute_started': def(
    'customer.dispute_started',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Dispute started',
      body: 'A dispute has been opened on your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.dispute_resolved': def(
    'customer.dispute_resolved',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Dispute resolved',
      body: 'The dispute on your booking has been resolved.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendDisputeResolvedPartyEmail(
          email,
          name,
          String(ctx.resolution || 'Closed by admin'),
          typeof ctx.adjustedAmount === 'number' ? ctx.adjustedAmount : undefined,
          String(ctx.bookingId || ''),
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'customer.booking_started': def(
    'customer.booking_started',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Work has started',
      body: ctx.professionalName
        ? `${ctx.professionalName} has started work on your booking.`
        : 'Your professional has started work on your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendBookingStartedEmail(
          email,
          name,
          String(ctx.professionalName || 'Your professional'),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'customer.completion_requested': def(
    'customer.completion_requested',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Completion request',
      body:
        typeof ctx.extraCostTotal === 'number' && ctx.extraCostTotal > 0
          ? `Your professional marked the work complete and requested extra payment of ${ctx.amountLabel || ctx.extraCostTotal}. Please review.`
          : 'Your professional marked the work complete. Please confirm.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendProfessionalCompletedEmail(
          email,
          name,
          String(ctx.professionalName || 'Your professional'),
          typeof ctx.extraCostTotal === 'number' ? ctx.extraCostTotal : 0,
          String(ctx.bookingId || ''),
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'customer.completion_reminder': def(
    'customer.completion_reminder',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reminder: confirm completion',
      body: 'Please confirm that the work on your booking is complete.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.completion_extra_payment_due': def(
    'customer.completion_extra_payment_due',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Extra payment due',
      body: 'Extra costs on your completion request still need payment.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.completion_auto_accepted': def(
    'customer.completion_auto_accepted',
    'booking_updates',
    'always_on',
    'customer',
    (ctx) => ({
      title: 'Completion auto-accepted',
      body: 'Your booking was automatically marked complete after no response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.review_request': def(
    'customer.review_request',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'How was your experience?',
      body: 'Your booking is complete. Leave a review to help others.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.invoice_ready': def(
    'customer.invoice_ready',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: ctx.invoiceNumber ? `Invoice ${String(ctx.invoiceNumber)} is ready` : 'Your invoice is ready',
      body: ctx.invoiceUrl
        ? `Your invoice is ready. Download it here: ${ctx.invoiceUrl}`
        : 'Your invoice is ready on the booking page.',
      clickUrl: String(ctx.invoiceUrl || frontend(`/bookings/${ctx.bookingId || ''}`)),
    }),
    'booking',
  ),
  'customer.review_reminder': def(
    'customer.review_reminder',
    'booking_updates',
    'email_always',
    'customer',
    (ctx) => ({
      title: 'Reminder: leave a review',
      body: 'You still have not reviewed your completed booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'customer.review_received': def(
    'customer.review_received',
    'promotions',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'You received a new review',
      body: ctx.actorName
        ? `${ctx.actorName} left you a review.`
        : 'You received a new review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'review',
  ),
  'customer.referral_completed': def(
    'customer.referral_completed',
    'promotions',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'Referral reward unlocked',
      body: 'A referral was completed and your reward has been applied.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'referral',
  ),
  'customer.loyalty_tier_up': def(
    'customer.loyalty_tier_up',
    'promotions',
    'configurable',
    'customer',
    (ctx) => ({
      title: 'Loyalty level up!',
      body: ctx.levelName
        ? `Congratulations — you reached ${ctx.levelName}.`
        : 'Congratulations — you reached a new loyalty tier.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'user',
  ),
  'customer.unread_chat': def(
    'customer.unread_chat',
    'messages',
    'email_always',
    'customer',
    (ctx) =>
      buildUnreadChatMirrorResult(
        ctx,
        'Unread messages waiting for you',
        'These messages have been waiting for your reply for over 24 hours:',
        'customer_unread_chat_mirror',
      ),
    'conversation',
  ),
  'user.unread_support_chat': def(
    'user.unread_support_chat',
    'messages',
    'email_always',
    'either',
    (ctx) =>
      buildUnreadChatMirrorResult(
        ctx,
        'Support reply waiting for you',
        'Fixtract support sent these messages over 24 hours ago and is still waiting for your reply:',
        'user_unread_support_chat_mirror',
      ),
    'conversation',
  ),
  'admin.unread_support_chat': def(
    'admin.unread_support_chat',
    'messages',
    'email_always',
    'either',
    (ctx) =>
      buildUnreadChatMirrorResult(
        ctx,
        'Support chat awaiting your reply',
        'A user is waiting for your support reply. These messages are still unanswered after 24 hours:',
        'admin_unread_support_chat_mirror',
        `/admin/chat?conversationId=${ctx.conversationId || ''}`,
      ),
    'conversation',
  ),

  // --- Professional ---
  'professional.project_published': def(
    'professional.project_published',
    'system',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Project published',
      body: ctx.projectTitle
        ? `"${ctx.projectTitle}" is now live.`
        : 'Your project has been published.',
      clickUrl: frontend(`/professional/projects/${ctx.projectId || ''}`),
    }),
    'project',
  ),
  'professional.project_rejected': def(
    'professional.project_rejected',
    'system',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Project rejected',
      body: ctx.projectTitle
        ? `"${ctx.projectTitle}" was rejected${ctx.reason ? `: ${ctx.reason}` : '.'}`
        : 'Your project was rejected.',
      clickUrl: frontend(`/professional/projects/${ctx.projectId || ''}`),
    }),
    'project',
  ),
  'professional.project_suspended': def(
    'professional.project_suspended',
    'system',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Project suspended',
      body: ctx.projectTitle
        ? `"${ctx.projectTitle}" has been suspended.`
        : 'One of your projects was suspended.',
      clickUrl: frontend(`/professional/projects/${ctx.projectId || ''}`),
    }),
    'project',
  ),
  'professional.rfq_received': def(
    'professional.rfq_received',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'New booking request',
      body: ctx.customerName
        ? `${ctx.customerName} sent you a new booking request.`
        : 'You received a new booking request.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqReceivedEmail(
          email,
          name,
          String(ctx.customerName || 'a customer'),
          String(ctx.projectTitle || ctx.serviceType || 'your service'),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.rfq_reminder': def(
    'professional.rfq_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reminder: respond to request',
      body: 'A booking request is still waiting for your accept or reject.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.quote_rejected': def(
    'professional.quote_rejected',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Quote rejected',
      body: 'Your quotation was rejected by the customer.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendQuotationRejectedEmail(
          email,
          name,
          String(ctx.customerName || 'the customer'),
          String(ctx.quotationNumber || ''),
          String(ctx.reason || ''),
        ),
    }),
    'booking',
  ),
  'professional.quote_accepted': def(
    'professional.quote_accepted',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Quote accepted',
      body: 'Your quotation was accepted. The customer can proceed to payment.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendQuotationAcceptedEmail(
          email,
          name,
          String(ctx.customerName || 'the customer'),
          String(ctx.quotationNumber || ''),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.booking_created': def(
    'professional.booking_created',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'New booking',
      body: ctx.customerName
        ? `${ctx.customerName} confirmed a booking with you.`
        : 'You have a new confirmed booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendProfessionalNewBookingEmail(
          email,
          name,
          String(ctx.customerName || 'A customer'),
          String(ctx.bookingId || ''),
          typeof ctx.amount === 'number' ? ctx.amount : undefined,
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'professional.booking_scheduled': def(
    'professional.booking_scheduled',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Booking scheduled',
      body: ctx.customerName
        ? `A start date was set for your booking with ${ctx.customerName}.`
        : 'A start date was set for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendBookingScheduledProfessionalEmail(
          email,
          name,
          String(ctx.customerName || 'the customer'),
          ctx.scheduledStart,
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.completion_confirmed_by_customer': def(
    'professional.completion_confirmed_by_customer',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Customer confirmed completion',
      body: ctx.customerName
        ? `${ctx.customerName} confirmed that the work is complete.`
        : 'The customer confirmed that the work is complete.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendCustomerConfirmedCompletionEmail(
          email,
          name,
          String(ctx.customerName || 'Customer'),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.invoice_ready': def(
    'professional.invoice_ready',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: ctx.invoiceNumber ? `Self-bill ${String(ctx.invoiceNumber)} is ready` : 'Your self-bill invoice is ready',
      body: ctx.invoiceUrl
        ? `The supplier self-bill is ready. Download it here: ${ctx.invoiceUrl}`
        : 'The supplier self-bill is ready on the booking page.',
      clickUrl: String(ctx.invoiceUrl || frontend(`/bookings/${ctx.bookingId || ''}`)),
    }),
    'booking',
  ),
  'professional.booking_not_started_reminder': def(
    'professional.booking_not_started_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Start or reschedule booking',
      body: 'A booking start date has arrived but work has not started yet.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.reschedule_accepted': def(
    'professional.reschedule_accepted',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reschedule accepted',
      body: 'A reschedule request was accepted for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRescheduleResolvedEmail(
          email,
          name,
          'accept',
          ctx.responseNote ? String(ctx.responseNote) : undefined,
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.reschedule_declined': def(
    'professional.reschedule_declined',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reschedule declined',
      body: 'The customer declined your rescheduling request.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRescheduleResolvedEmail(
          email,
          name,
          'decline',
          ctx.responseNote ? String(ctx.responseNote) : undefined,
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.reschedule_requested': def(
    'professional.reschedule_requested',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reschedule requested',
      body: 'A customer requested to reschedule a booking. Please review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRescheduleRequestedByCustomerEmail(
          email,
          name,
          String(ctx.customerName || 'the customer'),
          ctx.oldDate,
          ctx.newDate,
          String(ctx.reason || ''),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.refund_request': def(
    'professional.refund_request',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Refund request received',
      body: 'A customer requested a refund / cancellation. Please respond.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.refund_request_reminder': def(
    'professional.refund_request_reminder',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Reminder: refund request',
      body: 'A refund request is still awaiting your response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.booking_cancelled_refunded': def(
    'professional.booking_cancelled_refunded',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Booking cancelled & refunded',
      body: 'A booking was cancelled and refunded.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendBookingCancelledPartyEmail(
          'professional',
          email,
          name,
          String(ctx.customerName || 'the customer'),
          String(ctx.reason || 'No reason provided'),
          (ctx.cancelledBy as 'customer' | 'professional' | 'admin') || 'admin',
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.cancellation_request_received': def(
    'professional.cancellation_request_received',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Cancellation request submitted',
      body: ctx.requesterName
        ? `${ctx.requesterName} requested cancellation of your shared booking.`
        : 'A cancellation request was submitted for your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendCancellationRequestOtherPartyEmail({
          otherPartyEmail: email,
          otherPartyName: name,
          requesterName: String(ctx.requesterName || 'The other party'),
          reason: String(ctx.reason || ''),
          bookingId: String(ctx.bookingId || ''),
        }),
    }),
    'booking',
  ),
  'professional.refund_escalated': def(
    'professional.refund_escalated',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Refund request escalated',
      body: 'A refund request on your booking was escalated to Fixtract.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.refund_denied': def(
    'professional.refund_denied',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Refund request denied',
      body: 'A cancellation/refund request was denied after admin review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRefundDeniedEmail({
          requesterEmail: email,
          requesterName: name,
          bookingId: String(ctx.bookingId || ''),
          denyReason: String(ctx.reason || ''),
        }),
    }),
    'booking',
  ),
  'professional.warranty_claim_opened': def(
    'professional.warranty_claim_opened',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Warranty claim opened',
      body: ctx.customerName
        ? `${ctx.customerName} opened a warranty claim on your booking.`
        : 'A warranty claim was opened on your booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) => {
        const adminEmail = String(
          ctx.adminEmail || process.env.ADMIN_NOTIFICATIONS_EMAIL || process.env.FROM_EMAIL || '',
        ).trim();
        if (adminEmail) {
          await sendWarrantyClaimOpenedAdminEmail(
            adminEmail,
            name,
            String(ctx.customerName || 'Customer'),
            String(ctx.bookingId || ''),
            String(ctx.claimNumber || ''),
          );
        } else {
          console.error(
            '[warranty_claim_opened] ADMIN_NOTIFICATIONS_EMAIL/FROM_EMAIL not configured — admin will not be notified',
          );
        }
        return sendWarrantyClaimOpenedProfessionalPartyEmail(
          email,
          name,
          String(ctx.customerName || 'Customer'),
          String(ctx.bookingId || ''),
          String(ctx.claimNumber || ''),
        );
      },
    }),
    'booking',
  ),
  'professional.rfq_deadline_reminder': def(
    'professional.rfq_deadline_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Quotation deadline approaching',
      body:
        typeof ctx.daysRemaining === 'number'
          ? `You have ${ctx.daysRemaining} working day(s) left to submit a quotation.`
          : 'Your quotation deadline is approaching.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqDeadlineReminderEmail(
          email,
          name,
          typeof ctx.daysRemaining === 'number' ? ctx.daysRemaining : 0,
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.rfq_deadline_expired': def(
    'professional.rfq_deadline_expired',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Quotation deadline expired',
      body: 'The RFQ deadline passed without a quotation. The booking was cancelled.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendRfqDeadlineExpiredProfessionalEmail(email, name, String(ctx.bookingId || '')),
    }),
    'booking',
  ),
  'professional.dispute_started': def(
    'professional.dispute_started',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Dispute started',
      body: 'A dispute has been opened on one of your bookings.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendDisputeRaisedProfessionalPartyEmail(
          email,
          name,
          String(ctx.customerName || 'Customer'),
          String(ctx.reason || ''),
          String(ctx.bookingId || ''),
        ),
    }),
    'booking',
  ),
  'professional.dispute_resolved': def(
    'professional.dispute_resolved',
    'booking_updates',
    'always_on',
    'professional',
    (ctx) => ({
      title: 'Dispute resolved',
      body: 'A dispute on your booking has been resolved.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
      sendEmail: async ({ email, name }) =>
        sendDisputeResolvedPartyEmail(
          email,
          name,
          String(ctx.resolution || 'Closed by admin'),
          typeof ctx.adjustedAmount === 'number' ? ctx.adjustedAmount : undefined,
          String(ctx.bookingId || ''),
          String(ctx.currency || 'EUR'),
        ),
    }),
    'booking',
  ),
  'professional.review_request': def(
    'professional.review_request',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Leave a review',
      body: 'A booking is complete. Leave a review for the customer.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.review_reminder': def(
    'professional.review_reminder',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Reminder: leave a review',
      body: 'You still have not reviewed a completed booking.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
  'professional.review_received': def(
    'professional.review_received',
    'promotions',
    'configurable',
    'professional',
    (ctx) => ({
      title: 'You received a new review',
      body: ctx.actorName
        ? `${ctx.actorName} left you a review.`
        : 'You received a new review.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'review',
  ),
  'professional.referral_rewarded': def(
    'professional.referral_rewarded',
    'promotions',
    'configurable',
    'professional',
    (ctx) => ({
      title: 'Referral reward unlocked',
      body: 'A referral was completed and your reward has been applied.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'referral',
  ),
  'professional.leveling_up': def(
    'professional.leveling_up',
    'promotions',
    'configurable',
    'professional',
    (ctx) => ({
      title: 'Level up!',
      body: ctx.levelName
        ? `Congratulations — you reached ${ctx.levelName}.`
        : 'Congratulations — you reached a new professional level.',
      clickUrl: frontend('/dashboard/benefits'),
    }),
    'user',
  ),
  'professional.id_expiring': def(
    'professional.id_expiring',
    'system',
    'always_on',
    'professional',
    () => ({
      title: 'ID document expiring soon',
      body: 'Your ID document expires within 30 days. Please renew it.',
      clickUrl: frontend('/profile'),
    }),
    'user',
  ),
  'professional.id_expiry_reminder': def(
    'professional.id_expiry_reminder',
    'system',
    'always_on',
    'professional',
    () => ({
      title: 'Reminder: renew your ID',
      body: 'Your ID document is still expired or expiring. Please renew it.',
      clickUrl: frontend('/profile'),
    }),
    'user',
  ),
  'professional.unread_chat': def(
    'professional.unread_chat',
    'messages',
    'email_always',
    'professional',
    (ctx) =>
      buildUnreadChatMirrorResult(
        ctx,
        'Unread messages waiting for you',
        'These messages have been waiting for your reply for over 24 hours:',
        'professional_unread_chat_mirror',
      ),
    'conversation',
  ),
  'professional.completion_auto_accepted': def(
    'professional.completion_auto_accepted',
    'booking_updates',
    'email_always',
    'professional',
    (ctx) => ({
      title: 'Completion auto-accepted',
      body: 'A customer completion request was automatically accepted after no response.',
      clickUrl: frontend(`/bookings/${ctx.bookingId || ''}`),
    }),
    'booking',
  ),
};

export function getEventDef(eventKey: string): EventDef | undefined {
  return NOTIFICATION_REGISTRY[eventKey];
}

export function listRegistryEventKeys(): string[] {
  return Object.keys(NOTIFICATION_REGISTRY);
}
