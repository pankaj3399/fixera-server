import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking from '../../models/booking';
import User from '../../models/user';
import CancellationRequest from '../../models/cancellationRequest';
import { executeRefund, RefundError } from '../Stripe/payment';
import { isPreCompletionStatus } from '../../utils/refundFinalization';
import { getProfessionalDisplayName } from '../../utils/displayName';
import { params } from '../../utils/requestParams';
import { notifyBookingCancelledAndRefunded } from '../../utils/notifications/notifyBookingCancelledAndRefunded';
import { notify } from '../../utils/notifications/notify';
import { bookingForViewer } from '../../utils/invoiceVisibility';
import { withAnonymizationWriteFence } from '../../utils/support/accountGuard';
import {
  ensureRefundInvoices,
  isBookingStarted,
  leavesBillableRemainder,
  pruneFutureResourcePlanDays,
  retainPastBookingCalendar,
} from '../../utils/refundFinalization';

const REFUND_FINALIZED_BOOKING_STATUS = 'cancelled';

const getUserId = (req: Request): string | undefined =>
  (req as any).user?._id ? String((req as any).user._id) : undefined;

const loadActiveCustomerRequest = async (bookingId: string) =>
  CancellationRequest.findOne({
    booking: bookingId,
    requestedRole: 'customer',
    status: { $in: ['pending', 'negotiating', 'escalated'] },
  });

const finalizeRefund = async (
  booking: any,
  request: any,
  amount: number | undefined,
  reason: string,
  actorId?: string
): Promise<{ ok: true; refundAmount: number } | { ok: false; status: number; message: string; code?: string }> => {
  if (request.status === 'approved' || request.refundedAt) {
    return { ok: true, refundAmount: request.refundAmount || 0 };
  }

  const claimed = await CancellationRequest.findOneAndUpdate(
    { _id: request._id, status: { $in: ['pending', 'negotiating'] } },
    { $set: { status: 'processing' } }
  );
  if (!claimed) {
    return { ok: false, status: 409, message: 'This refund request is already being processed' };
  }

  let result;
  try {
    result = await executeRefund(String(booking._id), { amount, reason, actorId });
  } catch (error: any) {
    await CancellationRequest.updateOne(
      { _id: request._id, status: 'processing' },
      { $set: { status: claimed.status } }
    ).catch(() => null);
    if (error instanceof RefundError) {
      return { ok: false, status: error.httpStatus, message: error.message, code: error.code };
    }
    throw error;
  }

  const resolvedBy = actorId && mongoose.Types.ObjectId.isValid(String(actorId))
    ? new mongoose.Types.ObjectId(String(actorId))
    : undefined;
  request.status = 'approved';
  request.resolvedAt = new Date();
  if (resolvedBy) request.resolvedBy = resolvedBy;
  request.refundAmount = result.amount;
  request.refundedAt = new Date();
  await withAnonymizationWriteFence([request.requestedBy, actorId], async (session) => {
    await request.save(session ? { session } : undefined);
  });

  booking.status = isPreCompletionStatus(booking.status)
    ? REFUND_FINALIZED_BOOKING_STATUS
    : booking.status;
  booking.cancellation = {
    cancelledBy: request.requestedBy,
    reason,
    cancelledAt: new Date(),
    refundAmount: result.amount,
  } as any;
  booking.statusHistory = booking.statusHistory || [];
  booking.statusHistory.push({
    status: REFUND_FINALIZED_BOOKING_STATUS,
    timestamp: new Date(),
    updatedBy: resolvedBy || request.requestedBy,
    note: `Refund issued (${result.amount}) — ${reason}`,
  });
  await withAnonymizationWriteFence([request.requestedBy, actorId], async (session) => {
    await booking.save(session ? { session } : undefined);
  });

  // A partial refund keeps the remainder billable. When no invoice exists
  // yet it is generated net of the refund; when the booking was already
  // invoiced a partial credit note is issued instead (never a second one).
  // On a started booking only future days are unplanned while past days stay
  // blocked. Best-effort: the refund above already succeeded, so these steps
  // must not fail the response.
  try {
    if (leavesBillableRemainder(booking.payment?.totalWithVat, result.amount)) {
      if (isBookingStarted(booking)) {
        pruneFutureResourcePlanDays(booking);
        await withAnonymizationWriteFence([request.requestedBy, actorId], async (session) => {
          await booking.save(session ? { session } : undefined);
        });
        await retainPastBookingCalendar(booking);
      }
      void ensureRefundInvoices(String(booking._id));
    }
  } catch (sideEffectError) {
    console.error('Partial-refund side effects failed:', sideEffectError);
  }

  return { ok: true, refundAmount: result.amount };
};

const escalateRequest = async (
  request: any,
  reason: 'rejected' | 'refused' | 'no_response'
) => {
  request.status = 'escalated';
  request.escalatedAt = new Date();
  request.escalationReason = reason;
  await withAnonymizationWriteFence([request.requestedBy], async (session) => {
    await request.save(session ? { session } : undefined);
  });

  try {
    const booking = await Booking.findById(request.booking);
    if (booking && (booking.status === 'booked' || booking.status === 'in_progress')) {
      booking.statusBeforeDispute = booking.status;
      booking.status = 'dispute';
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        status: 'dispute',
        timestamp: new Date(),
        updatedBy: request.requestedBy,
        note: `Refund dispute escalated (${reason})`,
      } as any);
      await withAnonymizationWriteFence([request.requestedBy], async (session) => {
        await booking.save(session ? { session } : undefined);
      });
    }
  } catch (err) {
    console.error('Failed to set booking status to dispute on refund escalation:', err);
  }
};

export const listProfessionalRefundRequests = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const bookingIds = await Booking.find({ professional: userId }).distinct('_id');
    if (bookingIds.length === 0) {
      return res.json({ success: true, data: { requests: [] } });
    }

    const requests = await CancellationRequest.find({
      booking: { $in: bookingIds },
      requestedRole: 'customer',
      status: { $in: ['pending', 'negotiating'] },
    })
      .populate({ path: 'booking', select: 'bookingNumber status payment project', populate: { path: 'project', select: 'title' } })
      .populate('requestedBy', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    const visibleRequests = requests.map((request: any) =>
      request?.booking && typeof request.booking === 'object'
        ? { ...request, booking: bookingForViewer(request.booking, 'professional') }
        : request
    );

    return res.json({ success: true, data: { requests: visibleRequests } });
  } catch (error: any) {
    console.error('listProfessionalRefundRequests error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load refund requests' });
  }
};

export const getBookingCancellationRequest = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { bookingId } = params(req.params);
    if (!userId) return res.status(401).json({ success: false, msg: 'Authentication required' });
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId).select('customer professional');
    if (!booking) return res.status(404).json({ success: false, msg: 'Booking not found' });
    const isParty =
      booking.customer?.toString() === userId || booking.professional?.toString() === userId;
    if (!isParty) return res.status(403).json({ success: false, msg: 'Not authorized' });

    const request = await CancellationRequest.findOne({ booking: bookingId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: { request: request || null } });
  } catch (error: any) {
    console.error('getBookingCancellationRequest error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to load cancellation request' });
  }
};

export const professionalRespondToCancellation = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { bookingId } = params(req.params);
    const { decision, amount, note } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, msg: 'Authentication required' });
    if (!['approve', 'counter', 'reject'].includes(decision)) {
      return res.status(400).json({ success: false, msg: 'decision must be approve, counter, or reject' });
    }
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, msg: 'Booking not found' });
    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: 'Only the assigned professional can respond' });
    }

    const request = await loadActiveCustomerRequest(bookingId);
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ success: false, msg: 'No pending refund request awaiting your response' });
    }

    const bookingPrice = Number(booking.payment?.amount || 0);
    request.professionalRespondedAt = new Date();
    request.professionalRespondedBy = new mongoose.Types.ObjectId(userId);
    request.professionalNote = typeof note === 'string' ? note.trim().slice(0, 1000) : undefined;

    const [customerUser, professionalUser] = await Promise.all([
      User.findById(booking.customer).select('_id name').lean(),
      User.findById(booking.professional).select('_id name businessInfo username').lean(),
    ]);

    if (decision === 'approve') {
      request.professionalDecision = 'approved';
      const result = await finalizeRefund(booking, request, undefined, `Professional approved full refund: ${request.reason}`, getUserId(req));
      if (!result.ok) {
        return res.status(result.status).json({ success: false, msg: result.message, code: result.code });
      }
      try {
        notifyBookingCancelledAndRefunded({
          bookingId: String(booking._id),
          reason: request.reason,
          cancelledBy: 'professional',
          customerUser,
          professionalUser,
          refundAmount: result.refundAmount,
          currency: booking.payment?.currency || 'EUR',
          isPartialRefund: false,
        });
      } catch (e) { console.error('refund notify failed', e); }
      return res.json({ success: true, data: { status: 'approved', refundAmount: result.refundAmount } });
    }

    if (decision === 'counter') {
      const counter = Number(amount);
      if (!Number.isFinite(counter) || counter < 1 || counter > bookingPrice) {
        return res.status(400).json({ success: false, msg: `Counter-offer must be between 1 and the booking price (${bookingPrice.toFixed(2)})` });
      }
      request.professionalDecision = 'counter';
      request.counterOfferAmount = Math.round(counter * 100) / 100;
      request.status = 'negotiating';
      await withAnonymizationWriteFence([request.requestedBy, userId], async (session) => {
        await request.save(session ? { session } : undefined);
      });
      try {
        if (customerUser?._id) {
          await notify({
            userId: customerUser._id.toString(),
            actorId: userId,
            eventKey: 'customer.refund_counter_offer',
            entityType: 'booking',
            entityId: String(booking._id),
            context: {
              bookingId: String(booking._id),
              professionalName: getProfessionalDisplayName(professionalUser),
              refundAmount: request.counterOfferAmount,
              responseNote: request.professionalNote,
              currency: booking.payment?.currency || 'EUR',
            },
          });
        }
      } catch (e) { console.error('counter-offer notify failed', e); }
      return res.json({ success: true, data: { status: 'negotiating', counterOfferAmount: request.counterOfferAmount } });
    }

    // reject
    request.professionalDecision = 'rejected';
    await escalateRequest(request, 'rejected');
    try {
      if (customerUser?._id) {
        await notify({
          userId: customerUser._id.toString(),
          actorId: userId,
          eventKey: 'customer.refund_escalated',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            escalationReason: 'rejected',
          },
        });
      }
      if (professionalUser?._id) {
        await notify({
          userId: professionalUser._id.toString(),
          actorId: userId,
          eventKey: 'professional.refund_escalated',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            escalationReason: 'rejected',
          },
        });
      }
    } catch (e) { console.error('escalation notify failed', e); }
    return res.json({ success: true, data: { status: 'escalated', escalationReason: 'rejected' } });
  } catch (error: any) {
    console.error('professionalRespondToCancellation error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to respond to refund request' });
  }
};

export const customerRespondToCounterOffer = async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const { bookingId } = params(req.params);
    const { decision } = req.body || {};
    if (!userId) return res.status(401).json({ success: false, msg: 'Authentication required' });
    if (!['accept', 'refuse'].includes(decision)) {
      return res.status(400).json({ success: false, msg: 'decision must be accept or refuse' });
    }
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, msg: 'Booking not found' });
    if (booking.customer?.toString() !== userId) {
      return res.status(403).json({ success: false, msg: 'Only the customer can respond to the counter-offer' });
    }

    const request = await loadActiveCustomerRequest(bookingId);
    if (!request || request.status !== 'negotiating' || request.counterOfferAmount == null) {
      return res.status(400).json({ success: false, msg: 'No counter-offer awaiting your response' });
    }

    request.customerRespondedAt = new Date();
    request.customerRespondedBy = new mongoose.Types.ObjectId(userId);

    if (decision === 'accept') {
      request.customerDecision = 'accepted';
      const result = await finalizeRefund(booking, request, request.counterOfferAmount, `Customer accepted negotiated refund: ${request.reason}`, getUserId(req));
      if (!result.ok) {
        return res.status(result.status).json({ success: false, msg: result.message, code: result.code });
      }
      try {
        const customerUser = await User.findById(booking.customer).select('_id name').lean();
        const professionalUser = await User.findById(booking.professional).select('_id name businessInfo username').lean();
        // Prefer totalWithVat when present; never default a missing amount to 0
        // (that would mark positive refunds as full refunds in customer copy).
        const rawBookingTotal = booking.payment?.totalWithVat ?? booking.payment?.amount;
        const bookingPrice =
          typeof rawBookingTotal === 'number' && Number.isFinite(rawBookingTotal) && rawBookingTotal > 0
            ? rawBookingTotal
            : null;
        const isPartialRefund =
          bookingPrice == null
            ? true
            : result.refundAmount < bookingPrice;
        notifyBookingCancelledAndRefunded({
          bookingId: String(booking._id),
          reason: request.reason,
          cancelledBy: 'customer',
          customerUser,
          professionalUser,
          refundAmount: result.refundAmount,
          currency: booking.payment?.currency || 'EUR',
          isPartialRefund,
        });
      } catch (e) { console.error('refund notify failed', e); }
      return res.json({ success: true, data: { status: 'approved', refundAmount: result.refundAmount } });
    }

    // refuse → escalate to admin
    request.customerDecision = 'refused';
    await escalateRequest(request, 'refused');
    try {
      const customerUser = await User.findById(booking.customer).select('_id').lean();
      const professionalUser = await User.findById(booking.professional).select('_id').lean();
      if (customerUser?._id) {
        await notify({
          userId: customerUser._id.toString(),
          actorId: userId,
          eventKey: 'customer.refund_escalated',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            escalationReason: 'refused',
          },
        });
      }
      if (professionalUser?._id) {
        await notify({
          userId: professionalUser._id.toString(),
          actorId: userId,
          eventKey: 'professional.refund_escalated',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            escalationReason: 'refused',
          },
        });
      }
    } catch (e) { console.error('escalation notify failed', e); }
    return res.json({ success: true, data: { status: 'escalated', escalationReason: 'refused' } });
  } catch (error: any) {
    console.error('customerRespondToCounterOffer error:', error);
    return res.status(500).json({ success: false, msg: 'Failed to respond to counter-offer' });
  }
};
