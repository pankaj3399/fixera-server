import { getProfessionalDisplayName } from '../displayName';
import type { IUser } from '../../models/user';
import { notifyAsync } from './notify';

type CancelledBy = 'customer' | 'professional' | 'admin';

type PartyUser = Pick<IUser, '_id'> & { name?: string };
type ProfessionalPartyUser = Pick<IUser, '_id' | 'name'> & {
  username?: string;
  businessInfo?: { companyName?: string };
};

export interface NotifyBookingCancelledAndRefundedArgs {
  bookingId: string;
  reason?: string;
  cancelledBy: CancelledBy;
  customerUser?: PartyUser | null;
  professionalUser?: ProfessionalPartyUser | null;
  refundAmount?: number;
  currency?: string;
  isPartialRefund?: boolean;
}

export function notifyBookingCancelledAndRefunded(
  args: NotifyBookingCancelledAndRefundedArgs,
): void {
  const cancelContext = {
    bookingId: args.bookingId,
    reason: args.reason,
    cancelledBy: args.cancelledBy,
    customerName: args.customerUser?.name,
    professionalName: args.professionalUser
      ? getProfessionalDisplayName(args.professionalUser)
      : undefined,
  };

  const customerId = args.customerUser?._id?.toString?.();
  const professionalId = args.professionalUser?._id?.toString?.();
  const actorId =
    args.cancelledBy === 'customer'
      ? customerId
      : args.cancelledBy === 'professional'
        ? professionalId
        : undefined;

  if (customerId) {
    if (typeof args.refundAmount === 'number' && args.refundAmount > 0) {
      notifyAsync({
        userId: customerId,
        eventKey: 'customer.refund_processed',
        entityType: 'booking',
        entityId: args.bookingId,
        ...(actorId ? { actorId } : {}),
        context: {
          bookingId: args.bookingId,
          refundAmount: args.refundAmount,
          currency: args.currency || 'EUR',
          isPartialRefund: Boolean(args.isPartialRefund),
        },
      });
    }
    notifyAsync({
      userId: customerId,
      eventKey: 'customer.booking_cancelled_refunded',
      entityType: 'booking',
      entityId: args.bookingId,
      // The email names the professional and repeats the cancellation reason.
      ...(actorId ? { actorId } : {}),
      ...(professionalId ? { subjectUserId: professionalId } : {}),
      context: cancelContext,
    });
  }

  if (professionalId) {
    notifyAsync({
      userId: professionalId,
      eventKey: 'professional.booking_cancelled_refunded',
      entityType: 'booking',
      entityId: args.bookingId,
      // The email names the customer and repeats the cancellation reason.
      ...(actorId ? { actorId } : {}),
      ...(customerId ? { subjectUserId: customerId } : {}),
      context: cancelContext,
    });
  }
}
