import express from 'express';
import {
  createBooking,
  getMyBookings,
  getBookingById,
  submitQuote,
  respondToQuote,
  updateBookingStatus,
  cancelBooking
} from '../../handlers/Booking';
import { protect } from '../../middlewares/auth';

const router = express.Router();

// All routes require authentication
router.use(protect);

// Create booking (RFQ submission) - Customer only
router.post('/create', createBooking);

// Get all bookings for current user
router.get('/my-bookings', getMyBookings);

// Get single booking by ID
router.get('/:bookingId', getBookingById);

// Submit quote - Professional only
router.post('/:bookingId/quote', submitQuote);

// Respond to quote (accept/reject) - Customer only
router.post('/:bookingId/respond', respondToQuote);

// Update booking status
router.put('/:bookingId/status', updateBookingStatus);

// Cancel booking
router.post('/:bookingId/cancel', cancelBooking);

export default router;
