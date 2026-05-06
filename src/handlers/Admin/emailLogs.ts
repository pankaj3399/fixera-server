import { Request, Response } from 'express';
import mongoose from 'mongoose';
import EmailLog from '../../models/emailLog';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const listEmailLogs = async (req: Request, res: Response) => {
  try {
    const {
      template,
      status,
      to,
      relatedBooking,
      from,
      until,
      page,
      limit,
    } = req.query;

    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, any> = {};

    if (typeof template === 'string' && template.trim()) {
      query.template = template.trim();
    }

    if (typeof status === 'string' && (status === 'sent' || status === 'failed' || status === 'skipped')) {
      query.status = status;
    }

    if (typeof to === 'string' && to.trim().length >= 2) {
      query.to = new RegExp(escapeRegex(to.trim().toLowerCase()), 'i');
    }

    if (typeof relatedBooking === 'string' && mongoose.Types.ObjectId.isValid(relatedBooking)) {
      query.relatedBooking = new mongoose.Types.ObjectId(relatedBooking);
    }

    const fromDate = parseDate(from);
    const untilDate = parseDate(until);
    if (untilDate && untilDate.getUTCHours() === 0 && untilDate.getUTCMinutes() === 0 && untilDate.getUTCSeconds() === 0 && untilDate.getUTCMilliseconds() === 0) {
      untilDate.setUTCHours(23, 59, 59, 999);
    }
    if (fromDate || untilDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = fromDate;
      if (untilDate) query.createdAt.$lte = untilDate;
    }

    const [logs, totalCount] = await Promise.all([
      EmailLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      EmailLog.countDocuments(query),
    ]);

    return res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.max(1, Math.ceil(totalCount / limitNumber)),
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][EMAIL_LOGS] Failed to list logs', error);
    return res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to load email logs',
    });
  }
};
