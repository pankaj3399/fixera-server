import { getEffectiveAccessForUser } from '../adminRbac/roleAccess';
import { hasAccessLevel } from '../adminRbac/rolePermissions';
import { stripAllInvoiceFields, stripInternalPaymentDiagnostics } from '../invoiceVisibility';

export interface BookingAdminAccess {
  bookings: boolean;
  disputes: boolean;
  warranty: boolean;
  cancellations: boolean;
  payments: boolean;
}

export const isAdminUser = (user: any): boolean =>
  user?.role === 'admin' || user?.isAdmin === true;

/**
 * Resolve the same granular admin areas used by the admin router and the
 * details aliases. There is deliberately no role-only admin bypass.
 */
export const resolveBookingAdminAccess = async (user: any): Promise<BookingAdminAccess> => {
  if (!isAdminUser(user)) {
    return { bookings: false, disputes: false, warranty: false, cancellations: false, payments: false };
  }
  try {
    const levels = await getEffectiveAccessForUser(user);
    return {
      bookings: hasAccessLevel(levels, 'bookings', 'read'),
      disputes: hasAccessLevel(levels, 'disputes', 'read'),
      warranty: hasAccessLevel(levels, 'warranty', 'read'),
      cancellations: hasAccessLevel(levels, 'cancellations', 'read'),
      payments: hasAccessLevel(levels, 'payments', 'read'),
    };
  } catch (error) {
    console.error('Failed to resolve admin access for booking details:', error);
    return { bookings: false, disputes: false, warranty: false, cancellations: false, payments: false };
  }
};

/**
 * Provider identifiers/credentials and internal diagnostics are payment-area
 * data. An admin who can read bookings but not payments must still be able to
 * open the booking, without receiving these internals from the legacy raw
 * booking response.
 */
const PAYMENT_PROVIDER_FIELDS = [
  'stripePaymentIntentId',
  'stripeChargeId',
  'stripeTransferId',
  'stripeDestinationPayment',
  'transferIdempotencyKey',
  'stripeClientSecret',
  'extraCostStripePaymentIntentId',
  'extraCostClientSecret',
  'extraCostStripeChargeId',
  'extraCostTransferId',
  'disputeId',
  'disputeReason',
  'disputeAmountPending',
  'disputeStatus',
] as const;

export const filterPaymentForAdminArea = (payment: any, canReadPayments: boolean) => {
  if (!payment || typeof payment !== 'object' || canReadPayments) return payment;
  let clean: Record<string, any> = stripInternalPaymentDiagnostics({ ...payment });
  // Invoice documents/identifiers are payment-area artifacts too. An admin
  // without payments.read keeps amounts/statuses but not invoice files/numbers.
  clean = stripAllInvoiceFields(clean);
  for (const field of PAYMENT_PROVIDER_FIELDS) delete clean[field];
  delete clean.metadata;
  if (Array.isArray(clean.refunds)) {
    clean.refunds = clean.refunds.map((refund: any) => {
      if (!refund || typeof refund !== 'object') return refund;
      const copy = { ...refund };
      delete copy.refundId;
      delete copy.notes;
      delete copy.refundedBy;
      return copy;
    });
  }
  return clean;
};

const filterMilestonePaymentsForAdminArea = (milestones: unknown, canReadPayments: boolean) => {
  if (!Array.isArray(milestones) || canReadPayments) return milestones;
  return milestones.map((milestone: any) => {
    if (!milestone || typeof milestone !== 'object') return milestone;
    const copy = { ...milestone };
    delete copy.stripeClientSecret;
    delete copy.stripePaymentIntentId;
    return copy;
  });
};

/**
 * Admin-area filter for the legacy raw booking response. Participants keep
 * the existing bookingForViewer behavior; admins receive the areas they are
 * actually entitled to. A caller must already have enforced `bookings.read`.
 */
export const filterRawBookingForAdminArea = (
  booking: any,
  access: BookingAdminAccess,
) => {
  if (!booking || typeof booking !== 'object') return booking;
  const visible = typeof booking.toObject === 'function' ? booking.toObject() : { ...booking };

  if (!access.disputes && 'dispute' in visible) delete visible.dispute;
  if (!access.cancellations && 'cancellation' in visible) delete visible.cancellation;
  if (visible.payment) {
    visible.payment = filterPaymentForAdminArea(visible.payment, access.payments);
  }
  if (visible.milestonePayments) {
    visible.milestonePayments = filterMilestonePaymentsForAdminArea(
      visible.milestonePayments,
      access.payments,
    );
  }
  return visible;
};
