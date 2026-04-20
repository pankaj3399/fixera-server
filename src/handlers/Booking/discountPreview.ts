/**
 * Discount Preview Handler
 * Returns discount breakdown for a booking before the customer accepts the quote
 */

import { Request, Response } from 'express';
import Booking from '../../models/booking';
import { calculateAutoDiscount, validateDiscountCode } from '../../utils/discountEngine';

/**
 * GET /api/bookings/:bookingId/discount-preview?pointsToRedeem=50
 * Returns the discount breakdown for a quoted booking
 */
export const getDiscountPreview = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const pointsToRedeem = parseInt(req.query.pointsToRedeem as string) || 0;
    const discountCodeInput = typeof req.query.code === 'string' ? req.query.code : '';

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'totalSpent points pointsExpiry location')
      .populate('project', 'repeatBuyerDiscount professionalId');

    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Only the customer can see discount preview
    if (booking.customer._id?.toString() !== userId && booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // Must have a quote
    if (!booking.quote || !booking.quote.amount) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_QUOTE', message: 'No quote available for discount calculation' }
      });
    }

    // Determine professional ID
    let professionalId = booking.professional?.toString();
    if (!professionalId && booking.project) {
      const project = booking.project as any;
      professionalId = project.professionalId?.toString();
    }

    if (!professionalId) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_PROFESSIONAL', message: 'No professional assigned' }
      });
    }

    const projectId = booking.project
      ? (booking.project as any)._id?.toString() || String(booking.project)
      : null;

    const customer = booking.customer as any;

    let codeInfo = null as any;
    let codeError: string | undefined;
    if (discountCodeInput) {
      const customerCountry = (booking.customer as any)?.location?.country || booking.location?.country;
      const serviceType = (booking as any).serviceType;
      const validation = await validateDiscountCode(
        discountCodeInput,
        userId,
        booking.quote.amount,
        customerCountry,
        serviceType
      );
      if (validation.ok && validation.info) {
        codeInfo = validation.info;
      } else {
        codeError = validation.error;
      }
    }

    const discount = await calculateAutoDiscount(
      userId,
      professionalId,
      projectId,
      booking.quote.amount,
      customer.totalSpent || 0,
      pointsToRedeem,
      codeInfo
    );

    return res.json({
      success: true,
      data: {
        discount,
        availablePoints: customer.points || 0,
        pointsExpiry: customer.pointsExpiry || null,
        codeError,
      }
    });

  } catch (error: any) {
    console.error('Error calculating discount preview:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Failed to calculate discount' }
    });
  }
};
