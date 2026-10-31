import User from '../../models/user';
import { getProfessionalDisplayName } from '../displayName';
import { notify } from './notify';

/**
 * Notify both sides after a checkout booking is paid.
 * Idempotent: confirmPayment (sync frontend call) and the Stripe webhook can both
 * invoke this for the same booking — the second call dedupes via deliveryKey and
 * the email/push claim lease, so the professional is notified exactly once and
 * only after payment (never when the customer is merely forwarded to checkout).
 */
export async function notifyBookingPaymentConfirmed(args: {
  bookingId: string;
  paymentIntentId?: string;
  amount?: number;
  currency?: string;
}): Promise<void> {
  const { bookingId, paymentIntentId, amount, currency } = args;

  // Resolve display names for notification context. Best-effort: notify still
  // works with fallback names if lookups fail.
  let customerId: string | undefined;
  let customerName: string | undefined;
  let professionalId: string | undefined;
  let professionalName = 'Professional';

  try {
    const Booking = (await import('../../models/booking')).default;
    const booking = await Booking.findById(bookingId)
      .select('customer professional')
      .populate('customer', 'name')
      .populate('professional', 'name businessInfo username')
      .lean();
    const customer = booking?.customer as any;
    const professional = booking?.professional as any;
    if (customer?._id) {
      customerId = String(customer._id);
      customerName = customer.name;
    } else if ((booking?.customer as any)?.toString) {
      customerId = String(booking?.customer);
    }
    if (professional?._id) {
      professionalId = String(professional._id);
      try {
        professionalName = getProfessionalDisplayName(professional);
      } catch {
        professionalName = professional?.name || 'Professional';
      }
    } else if ((booking?.professional as any)?.toString) {
      professionalId = String(booking?.professional);
      try {
        const professionalUser = await User.findById(professionalId)
          .select('name businessInfo username')
          .lean();
        if (professionalUser) professionalName = getProfessionalDisplayName(professionalUser as any);
      } catch {
        // keep fallback
      }
    }
    if (!customerName && customerId) {
      try {
        const customerUser = await User.findById(customerId).select('name').lean();
        customerName = (customerUser as any)?.name;
      } catch {
        // keep undefined
      }
    }
  } catch (error) {
    throw new Error(`Unable to resolve paid booking notification recipients: ${error instanceof Error ? error.message : String(error)}`);
  }

  const normalizedCurrency = (currency || 'EUR').toUpperCase();
  // Stable per-booking keys so confirmPayment + webhook dedupe to a single inbox
  // row/email even when both run (and so milestone/second-PI retries don't
  // re-notify). paymentIntentId is accepted for future traceability but must NOT
  // be part of the key, otherwise each milestone PI would create a duplicate.
  void paymentIntentId;
  const customerKey = `booking:${bookingId}:customer.payment_confirmed`;
  const professionalKey = `booking:${bookingId}:professional.booking_created`;

  if (!customerId || !professionalId) {
    throw new Error(`Paid booking ${bookingId} is missing notification recipient(s)`);
  }
  const deliveries: Promise<unknown>[] = [];
  if (customerId) {
    deliveries.push(notify({
        userId: customerId,
        eventKey: 'customer.payment_confirmed',
        entityType: 'booking',
        entityId: bookingId,
        subjectUserId: professionalId,
        idempotencyKey: customerKey,
        context: {
          bookingId,
          professionalName,
          ...(typeof amount === 'number' ? { amount } : {}),
          currency: normalizedCurrency,
        },
        delivery: { strict: true },
      }));
  }

  if (professionalId) {
    deliveries.push(notify({
        userId: professionalId,
        eventKey: 'professional.booking_created',
        entityType: 'booking',
        entityId: bookingId,
        actorId: customerId,
        subjectUserId: customerId,
        idempotencyKey: professionalKey,
        context: {
          bookingId,
          customerName,
          ...(typeof amount === 'number' ? { amount } : {}),
          currency: normalizedCurrency,
        },
        delivery: { strict: true },
      }));
  }

  const results = await Promise.allSettled(deliveries);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Paid booking notification delivery failed: ${failures.map((failure) => failure.reason?.message || String(failure.reason)).join('; ')}`);
  }
}
