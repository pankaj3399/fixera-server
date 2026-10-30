import { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import CancellationRequest from '../../models/cancellationRequest';
import WarrantyClaim from '../../models/warrantyClaim';
import { resolveBookingViewerRole } from '../../utils/invoiceVisibility';
import { referenceId } from '../../utils/bookingDetails/attachments';
import { collectActorIds, loadActorMap } from '../../utils/bookingDetails/actors';
import { buildBookingDetails } from '../../utils/bookingDetails/projection';
import type { BookingDetailsDto, DetailsViewerRole } from '../../utils/bookingDetails/types';
import {
  isAdminUser,
  resolveBookingAdminAccess,
  type BookingAdminAccess,
} from '../../utils/bookingDetails/adminAccess';

const BOOKING_DETAIL_POPULATE = [
  {
    path: 'customer',
    select: 'name username email phone customerType location vatNumber totalSpent timeZone businessName isAnonymized deletedAt',
  },
  {
    path: 'professional',
    select: 'name username email phone businessInfo vatNumber timeZone role isAnonymized deletedAt',
  },
  {
    path: 'project',
    select:
      'title description pricing category service areaOfWork timeMode priceModel media rfqQuestions postBookingQuestions professionalId extraOptions termsConditions subprojects minResources minOverlapPercentage executionDuration services customConfirmationMessage resources',
  },
  { path: 'assignedTeamMembers', select: 'name email' },
];

export const canViewBooking = (user: any, booking: any): boolean => {
  if (isAdminUser(user)) return true;
  const userId = referenceId(user?._id ?? user?.id ?? user);
  if (!userId) return false;
  if (referenceId(booking?.customer) === userId) return true;
  if (referenceId(booking?.professional) === userId) return true;
  if (referenceId(booking?.project?.professionalId) === userId) return true;
  return false;
};

/**
 * The nullable booking routes predate the admin router. The route handlers
 * require the same effective `bookings.read` area before returning details.
 */
export const buildDetailsForBookingDocument = async (params: {
  booking: any;
  viewerRole: DetailsViewerRole;
  user: any;
  adminAccess?: BookingAdminAccess;
}): Promise<BookingDetailsDto> => {
  const { booking, viewerRole, user } = params;
  const plain = typeof booking?.toObject === 'function' ? booking.toObject() : booking;
  const bookingId = String(plain._id);
  const [payments, cancellations, warrantyClaims] = await Promise.all([
    Payment.find({ booking: bookingId }).sort({ createdAt: 1 }).lean(),
    CancellationRequest.find({ booking: bookingId }).sort({ createdAt: 1 }).lean(),
    WarrantyClaim.find({ booking: bookingId }).sort({ openedAt: 1 }).lean(),
  ]);
  const professionalIdFromProject = referenceId(plain?.project?.professionalId);
  const actorIds = collectActorIds(plain, payments, cancellations, warrantyClaims);
  if (professionalIdFromProject) actorIds.push(professionalIdFromProject);
  const actors = await loadActorMap(actorIds);
  const adminAccess = viewerRole === 'admin'
    ? (params.adminAccess || await resolveBookingAdminAccess(user))
    : undefined;

  // Cancellation-request refunds need to be visible to the refund ledger even
  // when no Payment row recorded them. They are attached non-persistently.
  const bookingForProjection = {
    ...plain,
    __cancellationRequests: adminAccess && !adminAccess.cancellations ? [] : cancellations,
  };

  return buildBookingDetails({
    booking: bookingForProjection,
    payments,
    cancellations,
    warrantyClaims,
    actors,
    viewerRole,
    adminAccess,
  });
};

const loadBookingWithDetails = async (bookingId: string) => {
  const query = Booking.findById(bookingId);
  for (const populate of BOOKING_DETAIL_POPULATE) {
    query.populate(populate as any);
  }
  return query;
};

const readBookingId = (req: Request): string => String(req.params.bookingId || req.params.id || '');

export const getBookingDetails = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const bookingId = readBookingId(req);
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking ID' });
    }
    const booking = await loadBookingWithDetails(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: 'Booking not found' });
    }
    if (!canViewBooking(req.user, booking)) {
      return res.status(403).json({
        success: false,
        msg: 'You do not have permission to view this booking',
      });
    }
    const viewerRole = resolveBookingViewerRole(req.user, booking);
    const adminAccess = viewerRole === 'admin' ? await resolveBookingAdminAccess(req.user) : undefined;
    if (viewerRole === 'admin' && !adminAccess?.bookings) {
      return res.status(403).json({
        success: false,
        msg: 'You do not have permission to view booking details',
        code: 'ADMIN_PERMISSION_DENIED',
      });
    }
    const details = await buildDetailsForBookingDocument({
      booking,
      viewerRole,
      user: req.user,
      adminAccess,
    });
    return res.status(200).json({ success: true, data: details });
  } catch (error: any) {
    console.error('Get booking details error:', error);
    next(error);
  }
};

export const getBookingActivity = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const bookingId = readBookingId(req);
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, msg: 'Invalid booking ID' });
    }
    const booking = await loadBookingWithDetails(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: 'Booking not found' });
    }
    if (!canViewBooking(req.user, booking)) {
      return res.status(403).json({
        success: false,
        msg: 'You do not have permission to view this booking',
      });
    }
    const viewerRole = resolveBookingViewerRole(req.user, booking);
    const adminAccess = viewerRole === 'admin' ? await resolveBookingAdminAccess(req.user) : undefined;
    if (viewerRole === 'admin' && !adminAccess?.bookings) {
      return res.status(403).json({
        success: false,
        msg: 'You do not have permission to view booking details',
        code: 'ADMIN_PERMISSION_DENIED',
      });
    }
    const details = await buildDetailsForBookingDocument({
      booking,
      viewerRole,
      user: req.user,
      adminAccess,
    });
    return res.status(200).json({ success: true, data: details.activity });
  } catch (error: any) {
    console.error('Get booking activity error:', error);
    next(error);
  }
};

/**
 * Additive `details` for the existing participant detail endpoint. The raw
 * booking response stays byte-compatible apart from the extra property. An
 * admin without bookings.read gets no additive payload (the legacy raw
 * response is unchanged), matching the dedicated alias's permission rule.
 */
export const attachBookingDetails = async (
  booking: any,
  viewerRole: DetailsViewerRole,
  user: any,
  resolvedAdminAccess?: BookingAdminAccess,
): Promise<BookingDetailsDto | null> => {
  if (viewerRole === 'admin') {
    const adminAccess = resolvedAdminAccess || await resolveBookingAdminAccess(user);
    if (!adminAccess.bookings) return null;
    return buildDetailsForBookingDocument({ booking, viewerRole, user, adminAccess });
  }
  return buildDetailsForBookingDocument({ booking, viewerRole, user });
};
