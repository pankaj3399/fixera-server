import express from 'express';
import {
  createBooking,
  getMyBookings,
  getMyPayments,
  getBookingById,
  submitPostBookingAnswers,
  submitQuote,
  updateBookingStatus,
  cancelBooking
} from '../../handlers/Booking';
import { respondToQuoteWithPayment, ensurePaymentIntent, updateBookingStatusWithPayment } from '../../handlers/Booking/payment-integration';
import { protect } from '../../middlewares/auth';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Create booking (RFQ submission) - Customer only
router.post('/create', createBooking);

// Get all bookings for current user
router.get('/my-bookings', getMyBookings);

// Get payment history for current customer
router.get('/my-payments', getMyPayments);

// Get single booking by ID
router.get('/:bookingId', getBookingById);

// Submit post-booking answers (Customer only)
router.post('/:bookingId/post-booking-answers', submitPostBookingAnswers);

// Submit quote - Professional only
router.post('/:bookingId/quote', submitQuote);

// Respond to quote (accept/reject) - Customer only - WITH PAYMENT INTEGRATION
router.post('/:bookingId/respond', respondToQuoteWithPayment);
router.post('/:bookingId/payment-intent', ensurePaymentIntent);

// Update booking status (with automatic payment transfer on completion)
router.put('/:bookingId/status', updateBookingStatusWithPayment);

// Cancel booking
router.post('/:bookingId/cancel', cancelBooking);

export default router;
