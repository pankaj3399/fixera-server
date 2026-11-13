/**
 * Professional Payment Handlers
 * Provides payment stats and transaction history for professionals
 */

import { Request, Response } from 'express';
import Booking from '../../models/booking';
import Payment from '../../models/payment';
import Project from '../../models/project';
import mongoose from 'mongoose';
import { buildSettledTransferExpression, getTransferStatus } from '../../utils/paymentSafety';
import { countPaymentsByService, professionalPaymentServices, professionalServiceBookingIds } from '../../utils/paymentFacetCounts';

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

    // Project bookings may identify the owner only through the project, so the
    // review aggregate uses the same ownership condition as getMyBookings.
    const professionalProjectIds = await Project.find({ professionalId: userId }).distinct('_id');

    const pendingBookingStatuses = ['quote_accepted', 'payment_pending', 'booked', 'rescheduling_requested', 'in_progress', 'professional_completed', 'dispute'];
    const finishedBookingStatuses = ['completed', 'cancelled', 'refunded'];
    const [completedStats, pendingStats, reviewStats, bookingCounts] = await Promise.all([
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
          },
        },
      ]),
      // Canonical review aggregate: customer reviews recorded on bookings for
      // this professional. Never derived from payment rows.
      Booking.aggregate([
        { $match: {
          $or: [
            { professional: userId },
            { project: { $in: professionalProjectIds } },
          ],
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
      // Count bookings themselves, including unpaid bookings; milestone
      // Payment rows never multiply these lifecycle counts.
      Booking.aggregate([
        { $match: { $or: [{ professional: userId }, { project: { $in: professionalProjectIds } }], status: { $in: [...pendingBookingStatuses, ...finishedBookingStatuses] } } },
        { $group: {
          _id: { currency: { $ifNull: ['$payment.currency', { $ifNull: ['$quote.currency', 'EUR'] }] } },
          pendingBookings: { $sum: { $cond: [{ $in: ['$status', pendingBookingStatuses] }, 1, 0] } },
          completedBookings: { $sum: { $cond: [{ $in: ['$status', finishedBookingStatuses] }, 1, 0] } },
        } },
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
        completedBookings: 0,
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

      totalsByCurrencyMap.set(currency, current);
    });

    for (const bucket of bookingCounts) {
      const currency = bucket?._id?.currency || 'EUR';
      const current = totalsByCurrencyMap.get(currency) || { currency, totalEarnings: 0, pendingEarnings: 0, completedBookings: 0, pendingBookings: 0 };
      current.pendingBookings = bucket.pendingBookings || 0;
      current.completedBookings = bucket.completedBookings || 0;
      totalsByCurrencyMap.set(currency, current);
    }
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
/** Status options of the professional payout list (FT2 #10a/#10b). */
export const TRANSACTION_STATUS_FILTERS = [
  'pending', 'authorized', 'completed', 'transfer_pending', 'transfer_failed', 'refunded', 'failed',
] as const;

/**
 * Mongo clause for one payout-list status option. `completed` means a settled
 * transfer; captured payments awaiting or failing payout are the transfer_*
 * options, matching the stats buckets and the row labels.
 */
export const transactionStatusClause = (statusFilter: string): Record<string, unknown> | null => {
  if (!statusFilter || statusFilter === 'all') return null;
  if (statusFilter === 'transfer_pending') {
    return {
      status: 'completed',
      $or: [
        { transferStatus: 'pending' },
        // Legacy failed transfers also have null status/id; exclude them
        // from "pending" so the filter matches the stats and row labels.
        { transferStatus: null, stripeTransferId: null, 'metadata.transferFailed': { $ne: true } },
      ],
    };
  }
  if (statusFilter === 'transfer_failed') {
    return { status: 'completed', $or: [{ transferStatus: 'failed' }, { transferStatus: null, 'metadata.transferFailed': true }] };
  }
  if (statusFilter === 'completed') {
    return { status: 'completed', $expr: buildSettledTransferExpression() };
  }
  return { status: statusFilter };
};

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
    const serviceFilter = typeof req.query.service === 'string' ? req.query.service.trim().slice(0, 200) : '';
    // Aggregations (facet counts) do not cast, so match on an ObjectId.
    const professionalObjectId = new mongoose.Types.ObjectId(String(userId));

    const otherAnd: Record<string, unknown>[] = [];
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const alternatives: Record<string, unknown>[] = [{ bookingNumber: regex }];
      // Strict 24-hex check: ObjectId.isValid also accepts any 12-character
      // string, which would turn a booking-number search into an id lookup.
      if (/^[a-f\d]{24}$/i.test(search)) {
        alternatives.push({ booking: new mongoose.Types.ObjectId(search) });
      }
      // Payment.bookingNumber is optional, so the number may only be on the
      // booking. Project bookings can identify their owner only through the
      // project (Booking.professional is required for direct bookings only),
      // so ownership matches getPaymentStats/getMyBookings.
      const ownedProjectIds = await Project.find({ professionalId: userId }).distinct('_id');
      const matchingBookings = await Booking.find({
        bookingNumber: regex,
        $or: [{ professional: userId }, { project: { $in: ownedProjectIds } }],
      }).select('_id').lean();
      if (matchingBookings.length) alternatives.push({ booking: { $in: matchingBookings.map(b => b._id) } });
      otherAnd.push({ $or: alternatives });
    }

    // FT2 #10b: service filter, matched through the payment's booking.
    const serviceClause: Record<string, unknown> | null = serviceFilter && serviceFilter !== 'all'
      ? { booking: { $in: await professionalServiceBookingIds(userId, serviceFilter) } }
      : null;

    // The status clause sits at the top level (it may carry its own $or /
    // $expr); search and service are $and-ed so they never collide with it.
    const buildQuery = (
      professional: unknown,
      statusClause: Record<string, unknown> | null,
      service: Record<string, unknown> | null,
    ): Record<string, unknown> => {
      const and = [...otherAnd, ...(service ? [service] : [])];
      return { professional, ...(statusClause || {}), ...(and.length > 0 ? { $and: and } : {}) };
    };
    const query = buildQuery(userId, transactionStatusClause(statusFilter), serviceClause);

    // Facet counts are best-effort: a failure leaves them unknown (null) and
    // never blocks the payout list itself.
    const facets = Promise.all([
      // FT2 #10a: one count per status option, using the same clause as the
      // filter itself so the derived transfer_* states match their rows.
      Promise.all(TRANSACTION_STATUS_FILTERS.map((option) =>
        Payment.countDocuments(buildQuery(userId, transactionStatusClause(option), serviceClause)))),
      countPaymentsByService(buildQuery(professionalObjectId, transactionStatusClause(statusFilter), null)),
      professionalPaymentServices(professionalObjectId),
    ]).catch((facetError) => {
      console.error('Transactions: facet counts failed; counts left unknown:', facetError?.message || facetError);
      return null;
    });

    const [transactions, total, facetResult] = await Promise.all([
      Payment.find(query)
        .select('booking bookingNumber status currency professionalPayout createdAt capturedAt transferredAt transferStatus stripeTransferId metadata')
        .populate('booking', '_id bookingNumber')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(query),
      facets,
    ]);
    let statusCounts: Record<string, number> | null = null;
    let serviceCounts: Record<string, number> | null = null;
    let services: string[] = [];
    if (facetResult) {
      const [statusCountValues, serviceCountRecord, serviceList] = facetResult;
      statusCounts = {};
      TRANSACTION_STATUS_FILTERS.forEach((option, index) => { statusCounts![option] = Number(statusCountValues[index]) || 0; });
      serviceCounts = serviceCountRecord;
      services = serviceList;
    }

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
      statusCounts,
      serviceCounts,
      services,
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
