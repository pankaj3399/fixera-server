/**
 * Booking Payment Integration
 * Extends booking handlers with Stripe payment functionality
 */

import { Request, Response } from 'express';
import Booking from '../../models/booking';
import { createPaymentIntent } from '../Stripe/payment';
import { captureAndTransferPayment } from '../Stripe/payment';

/**
 * Enhanced respond to quote handler with payment integration
 * Call this after customer accepts a quote
 */
export const respondToQuoteWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { action } = req.body; // 'accept' or 'reject'
    const userId = (req as any).user._id;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Verify customer
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // Verify status
    if (booking.status !== 'quoted') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Quote cannot be accepted in current status' }
      });
    }

    if (action === 'reject') {
      booking.status = 'quote_rejected';
      await booking.save();

      return res.json({
        success: true,
        data: { message: 'Quote rejected', booking }
      });
    }

    if (action === 'accept') {
      // Mark quote as accepted first
      booking.status = 'quote_accepted';
      await booking.save();

      // Create Payment Intent
      const paymentResult = await createPaymentIntent(booking._id.toString(), userId);

      if (!paymentResult.success) {
        // Revert status if payment intent creation fails
        booking.status = 'quoted';
        await booking.save();

        return res.status(400).json({
          success: false,
          error: paymentResult.error
        });
      }

      return res.json({
        success: true,
        data: {
          message: 'Quote accepted. Proceed to payment.',
          booking,
          clientSecret: paymentResult.clientSecret,
          requiresPayment: true,
        }
      });
    }

    res.status(400).json({
      success: false,
      error: { code: 'INVALID_ACTION', message: 'Action must be accept or reject' }
    });

  } catch (error: any) {
    console.error('Error responding to quote:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: error.message || 'Failed to process response'
      }
    });
  }
};

/**
 * Enhanced update booking status with payment capture
 * Call this when booking status changes to 'completed'
 */
export const updateBookingStatusWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { status } = req.body;
    const userId = (req as any).user._id as { toString: () => string } | undefined;
    const userIdStr = userId?.toString();

    if (!userIdStr) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    // Authorization check (professional, customer, or admin)
    const bookingProfessionalId = booking.professional ? booking.professional.toString() : undefined;
    const bookingCustomerId = booking.customer.toString();
    const isAuthorized =
      bookingProfessionalId === userIdStr ||
      bookingCustomerId === userIdStr;

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    // If status is changing to 'completed', capture payment and transfer
    if (status === 'completed' && booking.status !== 'completed') {
      if (booking.payment?.status === 'authorized') {
        const captureResult = await captureAndTransferPayment(booking._id.toString());

        if (!captureResult.success) {
          return res.status(400).json({
            success: false,
            error: captureResult.error
          });
        }

        // Payment capture successful, update status
        booking.status = 'completed';
        booking.actualEndDate = new Date();
        await booking.save();

        return res.json({
          success: true,
          data: {
            message: 'Booking completed and payment transferred to professional',
            booking
          }
        });
      }
    }

    // For other status updates, just update normally
    booking.status = status as any;

    // Set timestamps based on status
    if (status === 'in_progress' && !booking.actualStartDate) {
      booking.actualStartDate = new Date();
    }

    await booking.save();

    res.json({
      success: true,
      data: { message: 'Booking status updated', booking }
    });

  } catch (error: any) {
    console.error('Error updating booking status:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: error.message || 'Failed to update status'
      }
    });
  }
};

/**
 * Ensure a payment intent exists for a booking (customer-triggered)
 */
export const ensurePaymentIntent = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' }
      });
    }

    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized to initialize payment for this booking' }
      });
    }

    if (!booking.quote) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_QUOTE', message: 'Quote is required before initiating payment' }
      });
    }

    // If payment is already authorized or completed, redirect to success
    if (booking.payment?.status === 'authorized' || booking.payment?.status === 'completed') {
      return res.json({
        success: true,
        data: {
          message: 'Payment already processed',
          paymentStatus: booking.payment.status,
          booking,
          shouldRedirect: true,
          redirectTo: `/bookings/${bookingId}/payment/success`
        }
      });
    }

    // Only allow payment initialization for quote_accepted, payment_pending, or booked status
    if (!['quote_accepted', 'payment_pending', 'booked'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot initiate payment while booking is ${booking.status}`
        }
      });
    }

    // If client secret exists and payment is not failed or refunded, return existing secret
    if (booking.payment?.stripeClientSecret && !['failed', 'refunded', 'expired'].includes(booking.payment.status)) {
      return res.json({
        success: true,
        data: {
          clientSecret: booking.payment.stripeClientSecret,
          booking
        }
      });
    }

    const paymentResult = await createPaymentIntent(booking._id.toString(), userId);
    if (!paymentResult.success) {
      return res.status(400).json({
        success: false,
        error: paymentResult.error
      });
    }

    const refreshedBooking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email businessInfo')
      .populate('project', 'title description pricing category service professionalId');

    return res.json({
      success: true,
      data: {
        clientSecret: paymentResult.clientSecret,
        booking: refreshedBooking || booking
      }
    });
  } catch (error: any) {
    console.error('Error ensuring payment intent:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: error.message || 'Failed to initialize payment'
      }
    });
  }
};
