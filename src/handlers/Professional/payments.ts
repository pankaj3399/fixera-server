/**
 * Professional Payment Handlers
 * Provides payment stats and transaction history for professionals
 */

import { Request, Response } from 'express';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import mongoose from 'mongoose';
import { buildSettledTransferExpression, getTransferStatus } from '../../utils/paymentSafety';

/**
 * Get payment stats for the authenticated professional
 * GET /api/professional/payment-stats
 */
export const getPaymentStats = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const [completedStats, pendingStats, reviewStats] = await Promise.all([
      Payment.aggregate([
        { $match: {
          professional: userId,
          status: 'completed',
          $expr: buildSettledTransferExpression(),
        } },
        {
          $group: {
            _id: { currency: { $ifNull: ['$currency', 'EUR'] } },
            totalEarnings: { $sum: '$professionalPayout' },
            count: { $sum: 1 },
          },
        },
      ]),
      Payment.aggregate([
        { $match: {
          professional: userId,
          $or: [
            { status: 'authorized' },
            { status: 'completed', $or: [
              { transferStatus: { $in: ['pending', 'failed'] } },
              // MongoDB equality to null matches an explicit null as well as a
              // missing field, so legacy documents without any transfer state
              // still land in the pending bucket.
              { transferStatus: null, 'metadata.transferFailed': true },
              {
                transferStatus: null,
                stripeTransferId: null,
                'metadata.transferFailed': { $ne: true },
              },
            ] },
          ],
        } },
        {
          $group: {
            _id: { currency: { $ifNull: ['$currency', 'EUR'] } },
            pendingEarnings: { $sum: '$professionalPayout' },
            pendingBookings: { $sum: 1 },
          },
        },
      ]),
      // Canonical review aggregate: customer reviews recorded on bookings for
      // this professional. Never derived from payment rows.
      Booking.aggregate([
        { $match: {
          professional: userId,
          'customerReview.communicationLevel': { $exists: true, $ne: null },
        } },
        {
          $group: {
            _id: null,
            reviewCount: { $sum: 1 },
            avgRating: {
              $avg: {
                $avg: [
                  '$customerReview.communicationLevel',
                  '$customerReview.valueOfDelivery',
                  '$customerReview.qualityOfService',
                ],
              },
            },
          },
        },
      ]),
    ]);

    const totalsByCurrencyMap = new Map<
      string,
      { currency: string; totalEarnings: number; pendingEarnings: number; completedBookings: number; pendingBookings: number }
    >();

    completedStats.forEach((bucket: any) => {
      const currency = bucket?._id?.currency || 'EUR';
      totalsByCurrencyMap.set(currency, {
        currency,
        totalEarnings: bucket.totalEarnings || 0,
        pendingEarnings: 0,
        completedBookings: bucket.count || 0,
        pendingBookings: 0,
      });
    });

    pendingStats.forEach((bucket: any) => {
      const currency = bucket?._id?.currency || 'EUR';
      const current = totalsByCurrencyMap.get(currency) || {
        currency,
        totalEarnings: 0,
        pendingEarnings: 0,
        completedBookings: 0,
        pendingBookings: 0,
      };
      current.pendingEarnings = bucket.pendingEarnings || 0;
      current.pendingBookings = bucket.pendingBookings || 0;
      totalsByCurrencyMap.set(currency, current);
    });

    const totalsByCurrency = Array.from(totalsByCurrencyMap.values());
    // Cross-currency sums are not single-currency figures. Only expose the
    // blended totals when a single currency is present; otherwise report
    // per-currency buckets and leave blended fields null.
    const singleCurrency = totalsByCurrency.length === 1 ? totalsByCurrency[0].currency : null;
    const totalEarnings = singleCurrency
      ? totalsByCurrency.reduce((sum, item) => sum + (item.totalEarnings || 0), 0)
      : null;
    const pendingEarnings = singleCurrency
      ? totalsByCurrency.reduce((sum, item) => sum + (item.pendingEarnings || 0), 0)
      : null;
    const completedBookings = totalsByCurrency.reduce((sum, item) => sum + (item.completedBookings || 0), 0);
    const pendingBookings = totalsByCurrency.reduce((sum, item) => sum + (item.pendingBookings || 0), 0);
    const currency = singleCurrency || 'MULTI';
    const reviewRow = reviewStats[0] || {};
    const reviewCount = Number(reviewRow.reviewCount) || 0;
    const avgRating = typeof reviewRow.avgRating === 'number'
      ? Math.round(reviewRow.avgRating * 10) / 10
      : null;

    res.json({
      success: true,
      data: {
        totalEarnings,
        pendingEarnings,
        completedBookings,
        pendingBookings,
        reviewCount,
        avgRating,
        currency,
        totalsByCurrency,
      },
    });
  } catch (error: any) {
    console.error('Error fetching payment stats:', error);
    res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: "We couldn't load your payment statistics. Please try again." },
    });
  }
};

/**
 * Get transaction history for the authenticated professional
 * GET /api/professional/transactions?page=&limit=&status=
 * Status accepts payment statuses (pending/authorized/completed/failed/
 * refunded/partially_refunded) and transfer qualifiers
 * (transfer_pending/transfer_failed) for completed-but-unsettled rows.
 */
export const getTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 50);
    const skip = (page - 1) * limit;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';

    const query: Record<string, unknown> = { professional: userId };
    if (statusFilter && statusFilter !== 'all') {
      if (statusFilter === 'transfer_pending' || statusFilter === 'transfer_failed') {
        query.status = 'completed';
        query.$or = statusFilter === 'transfer_pending'
          ? [{ transferStatus: 'pending' }, { transferStatus: null, stripeTransferId: null }]
          : [{ transferStatus: 'failed' }, { transferStatus: null, 'metadata.transferFailed': true }];
      } else {
        query.status = statusFilter;
      }
    }

    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const alternatives: Record<string, unknown>[] = [{ bookingNumber: regex }];
      if (mongoose.Types.ObjectId.isValid(search)) {
        alternatives.push({ booking: new mongoose.Types.ObjectId(search) });
      }
      const matchingBookings = await Booking.find({ professional: userId, bookingNumber: regex }).select('_id').lean();
      if (matchingBookings.length) alternatives.push({ booking: { $in: matchingBookings.map(b => b._id) } });
      query.$and = [{ $or: alternatives }];
    }

    const [transactions, total] = await Promise.all([
      Payment.find(query)
        .select('booking bookingNumber status currency professionalPayout createdAt capturedAt transferredAt transferStatus stripeTransferId metadata')
        .populate('booking', '_id bookingNumber')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(query),
    ]);

    const data = transactions.map((t: any) => {
      const bookingRef = t.booking && typeof t.booking === 'object' ? t.booking : null;
      return {
        _id: t._id,
        // Actual payout date only: the transfer record. No capturedAt
        // fallback — a capture is not a pay-out fact.
        date: t.transferredAt || null,
        bookingId: bookingRef?._id || null,
        bookingNumber: t.bookingNumber || bookingRef?.bookingNumber || 'N/A',
        status: t.status === 'completed' ? getTransferStatus(t) === 'succeeded' ? 'completed' : `transfer_${getTransferStatus(t)}` : t.status,
        currency: t.currency || 'EUR',
        amount: t.professionalPayout ?? 0,
      };
    });

    res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: "We couldn't load your transactions. Please try again." },
    });
  }
};
