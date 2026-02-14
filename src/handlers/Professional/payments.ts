/**
 * Professional Payment Handlers
 * Provides payment stats and transaction history for professionals
 */

import { Request, Response } from 'express';
import Payment from '../../models/payment';

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

    const [completedStats, pendingStats] = await Promise.all([
      Payment.aggregate([
        { $match: { professional: userId, status: 'completed' } },
        {
          $group: {
            _id: { currency: { $ifNull: ['$currency', 'EUR'] } },
            totalEarnings: { $sum: '$professionalPayout' },
            count: { $sum: 1 },
          },
        },
      ]),
      Payment.aggregate([
        { $match: { professional: userId, status: 'authorized' } },
        {
          $group: {
            _id: { currency: { $ifNull: ['$currency', 'EUR'] } },
            pendingEarnings: { $sum: '$professionalPayout' },
          },
        },
      ]),
    ]);

    const totalsByCurrencyMap = new Map<
      string,
      { currency: string; totalEarnings: number; pendingEarnings: number; completedBookings: number }
    >();

    completedStats.forEach((bucket: any) => {
      const currency = bucket?._id?.currency || 'EUR';
      totalsByCurrencyMap.set(currency, {
        currency,
        totalEarnings: bucket.totalEarnings || 0,
        pendingEarnings: 0,
        completedBookings: bucket.count || 0,
      });
    });

    pendingStats.forEach((bucket: any) => {
      const currency = bucket?._id?.currency || 'EUR';
      const current = totalsByCurrencyMap.get(currency) || {
        currency,
        totalEarnings: 0,
        pendingEarnings: 0,
        completedBookings: 0,
      };
      current.pendingEarnings = bucket.pendingEarnings || 0;
      totalsByCurrencyMap.set(currency, current);
    });

    const totalsByCurrency = Array.from(totalsByCurrencyMap.values());
    const totalEarnings = totalsByCurrency.reduce((sum, item) => sum + (item.totalEarnings || 0), 0);
    const pendingEarnings = totalsByCurrency.reduce((sum, item) => sum + (item.pendingEarnings || 0), 0);
    const completedBookings = totalsByCurrency.reduce((sum, item) => sum + (item.completedBookings || 0), 0);
    const currency = totalsByCurrency.length === 1 ? totalsByCurrency[0].currency : 'MULTI';

    res.json({
      success: true,
      data: {
        totalEarnings,
        pendingEarnings,
        completedBookings,
        currency,
        totalsByCurrency,
      },
    });
  } catch (error: any) {
    console.error('Error fetching payment stats:', error);
    res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: error.message || 'Failed to fetch payment stats' },
    });
  }
};

/**
 * Get transaction history for the authenticated professional
 * GET /api/professional/transactions?limit=10
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

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 50);

    const transactions = await Payment.find({ professional: userId })
      .select('bookingNumber status currency professionalPayout createdAt capturedAt transferredAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const data = transactions.map((t: any) => ({
      _id: t._id,
      date: t.transferredAt || t.capturedAt || t.createdAt,
      bookingNumber: t.bookingNumber || 'N/A',
      status: t.status,
      currency: t.currency || 'EUR',
      amount: t.professionalPayout || 0,
    }));

    res.json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: error.message || 'Failed to fetch transactions' },
    });
  }
};
