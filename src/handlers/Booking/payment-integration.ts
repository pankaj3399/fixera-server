/**
 * Booking Payment Integration
 * Extends booking handlers with Stripe payment functionality
 */

import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Booking, { BookingStatus } from '../../models/booking';
import Project from '../../models/project';
import PlatformSettings from '../../models/platformSettings';
import { createPaymentIntent, captureAndTransferPayment, executeRefund, RefundError } from '../Stripe/payment';
import { computeGrossBookingAmount } from '../../utils/payment';
import { processReferralCompletion } from '../../utils/referralSystem';
import { updateProfessionalLevel } from '../../utils/professionalLevelSystem';
import { updateUserLoyalty } from '../../utils/loyaltySystem';
import { addPoints } from '../../utils/pointsSystem';
import PointsConfig from '../../models/pointsConfig';
import PointTransaction from '../../models/pointTransaction';
import {
  buildProjectScheduleWindow,
  buildPerResourceBlockedDays,
  getBookingScheduleOptions,
  getResourcePolicy,
  resolveEffectiveScheduleTimeZone,
  validateProjectScheduleSelection,
} from '../../utils/scheduleEngine';
import {
  computeMinExecutionResourceDays,
  planKeyToDate,
  rebuildResourcePlanForNewStart,
  resolveDayModeExecutionDays,
  toPlanDayKeyInTimeZone,
} from '../../utils/reschedulePlanning';
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from '../../utils/warranty';
import {
  resolveSubprojectIndex,
  normalizeExtraOptions,
} from '../../utils/bookingHelpers';
import { notify } from '../../utils/notifications/notify';
import { getProfessionalDisplayName } from '../../utils/displayName';
import { MAX_RESCHEDULES_PER_BOOKING } from '../../constants/booking';
import { DISPUTE_SLA_HOURS } from '../../constants/dispute';
import { findTeamConflicts } from '../../utils/scheduleConflict';
import { releaseScheduleSlots } from '../../utils/scheduleRelease';
import { withAnonymizationWriteFence } from '../../utils/support/accountGuard';
import {
  resolveScheduleTimeZone,
} from '../../utils/bookingDetails/capture';
import {
  findBookingCalendarConflictsForSchedule,
  replaceBookingCalendar,
  releaseBookingCalendar,
} from '../../utils/support/bookingCalendar';
import User from '../../models/user';
import WarrantyClaim from '../../models/warrantyClaim';
import { bookingForRequest } from '../../utils/invoiceVisibility';

const REFUNDABLE_PAYMENT_STATUSES = new Set(['authorized', 'completed', 'partially_refunded']);

const BOOKING_STATUS_VALUES: BookingStatus[] = [
  'rfq',
  'rfq_accepted',
  'draft_quote',
  'quoted',
  'quote_accepted',
  'quote_rejected',
  'payment_pending',
  'booked',
  'rescheduling_requested',
  'in_progress',
  'professional_completed',
  'completed',
  'cancelled',
  'dispute',
  'refunded',
];

const ALLOWED_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  rfq: ['rfq_accepted', 'quoted', 'cancelled'],
  rfq_accepted: ['quoted', 'cancelled'],
  draft_quote: ['quoted', 'cancelled'],
  quoted: ['quote_accepted', 'quote_rejected', 'cancelled'],
  quote_accepted: ['payment_pending', 'booked', 'cancelled'],
  quote_rejected: ['quoted'],
  payment_pending: ['booked', 'cancelled'],
  booked: ['in_progress', 'completed', 'cancelled', 'dispute'],
  rescheduling_requested: [],
  in_progress: ['professional_completed', 'cancelled', 'dispute'],
  professional_completed: ['completed', 'dispute', 'cancelled'],
  completed: [],
  cancelled: [],
  dispute: ['completed', 'cancelled', 'refunded'],
  refunded: [],
};

const resolveBookingSubprojectIndex = (projectDoc: any, requestedIndex: unknown) =>
  resolveSubprojectIndex(projectDoc?.subprojects, requestedIndex);

const normalizeSelectedExtraOptions = (
  extraOptions: unknown,
  projectDoc: any
): { extraOptionId: string; bookedPrice: number }[] =>
  normalizeExtraOptions(extraOptions, projectDoc?.extraOptions);

const isValidBookingStatus = (value: string): value is BookingStatus =>
  BOOKING_STATUS_VALUES.includes(value as BookingStatus);

const isTransitionAllowed = (current: BookingStatus, requested: BookingStatus): boolean =>
  current === requested || ALLOWED_TRANSITIONS[current]?.includes(requested) === true;

const markMilestonesCompleted = (booking: any, completedAt: Date) => {
  if (!Array.isArray(booking.milestonePayments) || booking.milestonePayments.length === 0) {
    return;
  }

  booking.milestonePayments.forEach((milestone: any) => {
    milestone.workStatus = 'completed';
    milestone.startedAt = milestone.startedAt || booking.actualStartDate || completedAt;
    milestone.completedAt = milestone.completedAt || completedAt;
  });
};

const ensureWarrantyCoverageSnapshot = async (booking: any) => {
  let source: 'quote' | 'project_subproject' = 'quote';
  let duration = normalizeWarrantyDuration(booking.warrantyCoverage?.duration)
    || getBookingWarrantyDuration(booking);

  if (!duration && booking.project) {
    const project = await Project.findById(booking.project).select('subprojects');
    const subprojects = Array.isArray((project as any)?.subprojects) ? (project as any).subprojects : [];
    if (
      typeof booking.selectedSubprojectIndex === 'number' &&
      booking.selectedSubprojectIndex >= 0 &&
      booking.selectedSubprojectIndex < subprojects.length
    ) {
      const selectedSubproject = subprojects[booking.selectedSubprojectIndex];
      duration = normalizeWarrantyDuration(selectedSubproject?.warrantyPeriod);
      if (duration) {
        source = 'project_subproject';
      }
    }
  }

  if (!duration) return;

  const startsAt =
    booking.warrantyCoverage?.startsAt instanceof Date
      ? booking.warrantyCoverage.startsAt
      : booking.actualEndDate || new Date();
  const endsAt =
    booking.warrantyCoverage?.endsAt instanceof Date
      ? booking.warrantyCoverage.endsAt
      : addWarrantyDuration(startsAt, duration);

  booking.warrantyCoverage = {
    duration,
    startsAt,
    endsAt,
    source: booking.warrantyCoverage?.source || source,
  };
};

const isDuplicateKeyError = (error: any): boolean => error?.code === 11000;
const COMPLETABLE_BOOKING_STATUSES: BookingStatus[] = ['booked', 'in_progress', 'professional_completed', 'dispute'];

const getProfessionalId = async (booking: any) => {
  if (booking.professional) {
    return booking.professional?._id?.toString?.() || booking.professional?.toString?.();
  }
  if (!booking.project) return undefined;

  const project = await Project.findById(booking.project).select('professionalId');
  return project?.professionalId?.toString?.() || project?.professionalId;
};

const createStatusHistoryEntry = (
  status: BookingStatus,
  updatedBy: any,
  note: string
) => ({
  status,
  timestamp: new Date(),
  updatedBy,
  note,
});

const MAX_STATUS_HISTORY_NOTE_LENGTH = 500;
const MAX_RESCHEDULE_REASON_LENGTH = 500;

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const truncateStatusHistoryNote = (note: string) => {
  const normalized = note.trim();
  if (normalized.length <= MAX_STATUS_HISTORY_NOTE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_STATUS_HISTORY_NOTE_LENGTH - 1).trimEnd()}…`;
};

const snapshotCurrentSchedule = (booking: any) => ({
  scheduledStartDate: booking.scheduledStartDate,
  scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
  scheduledBufferStartDate: booking.scheduledBufferStartDate,
  scheduledBufferEndDate: booking.scheduledBufferEndDate,
  scheduledBufferUnit: booking.scheduledBufferUnit,
  scheduledStartTime: booking.scheduledStartTime,
  scheduledEndTime: booking.scheduledEndTime,
  assignedTeamMembers: Array.isArray(booking.assignedTeamMembers) ? booking.assignedTeamMembers : undefined,
});

const applyScheduleFields = (booking: any, schedule: Record<string, any>) => {
  booking.scheduledStartDate = schedule.scheduledStartDate;
  booking.scheduledExecutionEndDate = schedule.scheduledExecutionEndDate;
  booking.scheduledBufferStartDate = schedule.scheduledBufferStartDate;
  booking.scheduledBufferEndDate = schedule.scheduledBufferEndDate;
  booking.scheduledBufferUnit = schedule.scheduledBufferUnit;
  booking.scheduledStartTime = schedule.scheduledStartTime;
  booking.scheduledEndTime = schedule.scheduledEndTime;
  if (Array.isArray(schedule.assignedTeamMembers) && schedule.assignedTeamMembers.length > 0) {
    booking.assignedTeamMembers = schedule.assignedTeamMembers as any;
  }
};

/**
 * Client bug list #9b (day-mode only): a rescheduled start date overrules
 * earlier manual planning. All planned dates before the new start date become
 * unplanned for every resource, planning on/after the new start is kept, and
 * when the kept plan is shorter than the minimum execution duration
 * (executionTime + executionTime * (resourceCount - 1) * overlapFraction),
 * days are added across the assigned resources so the booking duration stays
 * as short as possible. The professional can still adjust planning afterwards.
 * Hour-mode bookings are left untouched (owned by another workstream).
 */
const applyReschedulePlanReset = async (booking: any, updatedBy: unknown) => {
  const newStart = booking.scheduledStartDate ? new Date(booking.scheduledStartDate) : null;
  if (!newStart || Number.isNaN(newStart.getTime())) return;

  // Resolve the professional (and timezone) before deriving the plan day key:
  // scheduledStartDate is stored as a real local-midnight instant, so the key
  // must be derived in the professional's timezone — a plain UTC key points at
  // the previous calendar day for UTC+ timezones.
  const professionalId = await getProfessionalId(booking);
  const professional = professionalId
    ? await User.findById(professionalId).select(
      'companyAvailability availability companyBlockedDates companyBlockedRanges businessInfo'
    )
    : null;
  const timeZone = resolveEffectiveScheduleTimeZone((professional as any) || undefined);
  const newStartKey = toPlanDayKeyInTimeZone(newStart, timeZone);
  if (!newStartKey) return;

  const projectId = (booking.project as any)?._id?.toString?.() || String(booking.project || '');
  const projectDoc = projectId && mongoose.isValidObjectId(projectId)
    ? await Project.findById(projectId).select('executionDuration subprojects minResources minOverlapPercentage resources')
    : null;

  const executionDays = resolveDayModeExecutionDays({
    scheduleSnapshot: booking.scheduleSnapshot,
    project: projectDoc,
    selectedSubprojectIndex: booking.selectedSubprojectIndex,
  });
  if (executionDays == null) return;

  const assignedIds = (Array.isArray(booking.assignedTeamMembers) ? booking.assignedTeamMembers : [])
    .map((member: any) => (member?._id || member)?.toString?.())
    .filter((id: unknown): id is string => typeof id === 'string' && mongoose.isValidObjectId(id));

  const policy = projectDoc
    ? getResourcePolicy(projectDoc)
    : { minResources: 1, minOverlapPercentage: 90, totalResources: assignedIds.length };
  const minResourceDays = computeMinExecutionResourceDays({
    executionDays,
    resourceCount: Math.max(1, assignedIds.length),
    overlapFraction: policy.minOverlapPercentage / 100,
  });

  let blockedByResource: Map<string, Set<string>> | undefined;
  try {
    if (professional && assignedIds.length > 0) {
      const windowFromReal = new Date(newStart);
      const windowToReal = new Date(newStart.getTime() + (minResourceDays + 60) * 24 * 60 * 60 * 1000);
      blockedByResource = await buildPerResourceBlockedDays(
        (projectDoc || { _id: projectId }) as any,
        professional,
        assignedIds,
        windowFromReal,
        windowToReal,
        timeZone,
        String(booking._id),
        booking.customerBlocks
      );
    }
  } catch (blockedError: any) {
    console.error('Failed to load blocked days for reschedule plan reset:', blockedError?.message || blockedError);
  }

  const currentPlan = (Array.isArray(booking.resourcePlan) ? booking.resourcePlan : []).map((entry: any) => ({
    resourceId: ((entry?.resourceId?._id || entry?.resourceId)?.toString?.()) || '',
    days: Array.isArray(entry?.days) ? entry.days : [],
  }));

  const rebuilt = rebuildResourcePlanForNewStart({
    resourcePlan: currentPlan,
    newStartKey,
    assignedResourceIds: assignedIds,
    blockedByResource,
    minResourceDays,
    executionDays,
    minResourcesPerDay: policy.minResources,
  });

  if (rebuilt.removedDays === 0 && rebuilt.addedDays.length === 0) return;

  booking.resourcePlan = rebuilt.resourcePlan
    .filter((entry) => mongoose.isValidObjectId(entry.resourceId))
    .map((entry) => ({
      resourceId: new mongoose.Types.ObjectId(entry.resourceId),
      days: entry.days
        .map((key) => planKeyToDate(key))
        .filter((date): date is Date => date instanceof Date),
    }));

  if (rebuilt.maxDayKey) {
    const maxPlanned = planKeyToDate(rebuilt.maxDayKey);
    const currentEnd = booking.scheduledExecutionEndDate ? new Date(booking.scheduledExecutionEndDate) : null;
    if (maxPlanned && (!currentEnd || Number.isNaN(currentEnd.getTime()) || maxPlanned > currentEnd)) {
      booking.scheduledExecutionEndDate = maxPlanned;
      const bufferStart = booking.scheduledBufferStartDate ? new Date(booking.scheduledBufferStartDate) : null;
      if (bufferStart && !Number.isNaN(bufferStart.getTime()) && maxPlanned >= bufferStart) {
        // Keep the execution <= buffer invariant (mirrors manual planning,
        // which clears the buffer when the plan changes).
        booking.scheduledBufferStartDate = undefined;
        booking.scheduledBufferEndDate = undefined;
        booking.scheduledBufferUnit = undefined;
      }
    }
  }

  booking.statusHistory = booking.statusHistory || [];
  booking.statusHistory.push(
    createStatusHistoryEntry(
      'booked',
      updatedBy,
      `Planning updated: rescheduled start ${newStartKey} overrules earlier planning (${rebuilt.keptDays} day(s) kept, ${rebuilt.addedDays.length} added)`
    )
  );
};

export const buildScheduleUpdatePayload = async ({
  booking,
  scheduledStartDate,
  scheduledStartTime,
  hasExplicitExtraOptions = false,
  selectedExtraOptions,
  requestTimeZone,
}: {
  booking: any;
  scheduledStartDate: string;
  scheduledStartTime?: string;
  hasExplicitExtraOptions?: boolean;
  selectedExtraOptions?: unknown;
  requestTimeZone?: unknown;
}): Promise<
  | { success: true; data: Record<string, any> }
  | { success: false; status: number; error: { code: string; message: string } }
> => {
  if (booking.project) {
    const projectId = (booking.project as any)?._id?.toString?.() || String(booking.project);
    const projectDoc = await Project.findById(projectId).select('subprojects extraOptions');
    if (!projectDoc) {
      return {
        success: false,
        status: 404,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Linked project not found' },
      };
    }

    const resolvedSubprojectIndex = resolveBookingSubprojectIndex(
      projectDoc,
      booking.selectedSubprojectIndex
    );

    if (typeof resolvedSubprojectIndex !== 'number') {
      return {
        success: false,
        status: 400,
        error: { code: 'MUST_SELECT_SUBPROJECT', message: 'Please select a subproject/package before scheduling' },
      };
    }

    const isRfqSubproject = Array.isArray(projectDoc.subprojects)
      && projectDoc.subprojects[resolvedSubprojectIndex]?.pricing?.type === 'rfq';

    const scheduleData: Record<string, any> = {
      selectedSubprojectIndex: resolvedSubprojectIndex,
    };

    if (isRfqSubproject) {
      const startDate = new Date(scheduledStartDate);
      if (isNaN(startDate.getTime()) || startDate < new Date()) {
        return {
          success: false,
          status: 400,
          error: { code: 'INVALID_DATE', message: 'Start date must be a valid future date' },
        };
      }

      scheduleData.scheduledStartDate = startDate;
      scheduleData.scheduledExecutionEndDate = undefined;
      scheduleData.scheduledBufferStartDate = undefined;
      scheduleData.scheduledBufferEndDate = undefined;
      scheduleData.scheduledBufferUnit = undefined;
      scheduleData.scheduledStartTime = typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined;
      scheduleData.scheduledEndTime = undefined;
      // Should-fix 4: record the resolved zone even for date-only RFQ
      // schedules so details/timeline carry it.
      scheduleData.scheduleTimeZone = resolveScheduleTimeZone(requestTimeZone) || undefined;
      if (Array.isArray(booking.assignedTeamMembers) && booking.assignedTeamMembers.length > 0) {
        scheduleData.assignedTeamMembers = booking.assignedTeamMembers;
      }
    } else {
      const excludeBookingId = booking?._id ? String(booking._id) : undefined;

      const scheduleOptions = getBookingScheduleOptions(booking);
      const validation = await validateProjectScheduleSelection({
        ...scheduleOptions,
        projectId,
        subprojectIndex: resolvedSubprojectIndex,
        startDate: scheduledStartDate,
        startTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
        customerBlocks: booking.customerBlocks,
        excludeBookingId,
        requestTimeZone,
      });

      if (!validation.valid) {
        return {
          success: false,
          status: 400,
          error: {
            code: 'INVALID_DATE',
            message: validation.reason || 'Selected schedule is not available',
          },
        };
      }

      const window = await buildProjectScheduleWindow({
        projectId,
        subprojectIndex: resolvedSubprojectIndex,
        startDate: scheduledStartDate,
        startTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
        customerBlocks: booking.customerBlocks,
        ...scheduleOptions,
        excludeBookingId,
        requestTimeZone,
      });

      if (!window) {
        return {
          success: false,
          status: 400,
          error: { code: 'INVALID_DATE', message: 'Unable to schedule the selected window' },
        };
      }

      scheduleData.scheduledStartDate = window.scheduledStartDate;
      scheduleData.scheduledExecutionEndDate = window.scheduledExecutionEndDate;
      scheduleData.scheduledBufferStartDate = window.scheduledBufferStartDate;
      scheduleData.scheduledBufferEndDate = window.scheduledBufferEndDate;
      scheduleData.scheduledBufferUnit = window.scheduledBufferUnit;
      scheduleData.scheduledStartTime = window.scheduledStartTime;
      scheduleData.scheduledEndTime = window.scheduledEndTime;
      // Should-fix 4: persist the engine-resolved conversion zone so the
      // details/timeline carry it even when the client sends no timeZone.
      scheduleData.scheduleTimeZone = window.timeZone || undefined;
      if (window.assignedTeamMembers?.length) {
        scheduleData.assignedTeamMembers = window.assignedTeamMembers;
      } else if (Array.isArray(booking.assignedTeamMembers) && booking.assignedTeamMembers.length > 0) {
        scheduleData.assignedTeamMembers = booking.assignedTeamMembers;
      }
    }

    if (hasExplicitExtraOptions) {
      scheduleData.selectedExtraOptions = normalizeSelectedExtraOptions(selectedExtraOptions, projectDoc);
    }

    return { success: true, data: scheduleData };
  }

  const startDate = new Date(scheduledStartDate);
  if (isNaN(startDate.getTime()) || startDate < new Date()) {
    return {
      success: false,
      status: 400,
      error: { code: 'INVALID_DATE', message: 'Start date must be a valid future date' },
    };
  }

  return {
    success: true,
    data: {
      scheduledStartDate: startDate,
      scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
      scheduledBufferStartDate: booking.scheduledBufferStartDate,
      scheduledBufferEndDate: booking.scheduledBufferEndDate,
      scheduledBufferUnit: booking.scheduledBufferUnit,
      scheduledStartTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      scheduledEndTime: booking.scheduledEndTime,
      assignedTeamMembers: Array.isArray(booking.assignedTeamMembers) ? booking.assignedTeamMembers : undefined,
      scheduleTimeZone: resolveScheduleTimeZone(requestTimeZone) || undefined,
    },
  };
};

const refundCapturedBookingOnConflict = async (
  bookingId: string,
  reason: string
): Promise<{ success: boolean; error?: { code: string; message: string } }> => {
  const booking = await Booking.findById(bookingId);
  if (!booking) {
    return { success: false, error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found for compensating refund' } };
  }
  if (
    !booking.payment?.stripePaymentIntentId ||
    !['captured', 'completed', 'partially_refunded'].includes(String(booking.payment.status))
  ) {
    return { success: false, error: { code: 'INVALID_STATUS', message: 'Captured booking payment is not refundable in current state' } };
  }

  // Reuse the one booking-refund operation so the compensating refund obeys
  // the same all-refund capacity, ledger row, transfer reversal and status
  // rules as admin/customer refunds. The old copy refunded the full booking
  // total even after an extra-cost refund had already reduced the charge.
  try {
    await executeRefund(bookingId, { reason });
    return { success: true };
  } catch (error: any) {
    if (error instanceof RefundError) {
      return { success: false, error: { code: error.code, message: error.message } };
    }
    return {
      success: false,
      error: {
        code: 'REFUND_FAILED',
        message: error?.message || 'Compensating refund failed',
      },
    };
  }
};

const awardBookingCompletionPointsToUser = async (
  userId: any,
  amount: number,
  bookingId: any,
  description: string
) => {
  if (!userId || amount <= 0) return;

  const existing = await PointTransaction.findOne({ userId, relatedBooking: bookingId, source: 'booking_completion' });
  if (existing) return;

  try {
    await addPoints(userId, amount, 'booking_completion', description, { relatedBooking: bookingId });
  } catch (error: any) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }
};

const awardBookingCompletionPoints = async (
  professionalId: any,
  customerId: any,
  bookingId: any
) => {
  const pointsConfig = await PointsConfig.getCurrentConfig();
  if (!pointsConfig.isEnabled) return;
  await awardBookingCompletionPointsToUser(
    professionalId,
    pointsConfig.professionalEarningPerBooking,
    bookingId,
    'Earned for completing booking'
  );
  await awardBookingCompletionPointsToUser(
    customerId,
    pointsConfig.customerEarningPerBooking,
    bookingId,
    'Earned for completed booking'
  );
};

/**
 * Enhanced respond to quote handler with payment integration
 * Call this after customer accepts a quote
 */
export const respondToQuoteWithPayment = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const { action, pointsToRedeem } = req.body; // 'accept' or 'reject', optional pointsToRedeem
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

    const now = new Date();
    const customerObjectId = new mongoose.Types.ObjectId(userId);
    const rejectionReason = typeof (req.body as any)?.rejectionReason === 'string'
      ? String((req.body as any).rejectionReason).trim().slice(0, 1000)
      : '';

    const currentVersion = Array.isArray(booking.quoteVersions)
      ? booking.quoteVersions.find((version) => version.version === booking.currentQuoteVersion)
      : undefined;
    const versionGuard = booking.currentQuoteVersion != null
      ? { currentQuoteVersion: booking.currentQuoteVersion }
      : {};
    const versionArrayFilter = currentVersion
      ? [{ 'rejectedVersion.version': Number(currentVersion.version) }]
      : undefined;

    if (action === 'reject') {
      const rejectFields: Record<string, any> = {
        status: 'quote_rejected',
        ...(rejectionReason ? { customerRejectionReason: rejectionReason } : {}),
        ...(currentVersion
          ? {
              'quoteVersions.$[rejectedVersion].rejectedAt': now,
              'quoteVersions.$[rejectedVersion].rejectionReason': rejectionReason || undefined,
              'quoteVersions.$[rejectedVersion].rejectedBy': customerObjectId,
            }
          : {}),
      };
      const updatedBooking = await withAnonymizationWriteFence([userId], async (session) => Booking.findOneAndUpdate(
        { _id: booking._id, status: 'quoted', ...versionGuard },
        {
          $set: rejectFields,
          $push: {
            statusHistory: {
              status: 'quote_rejected',
              timestamp: now,
              updatedBy: customerObjectId,
              note: rejectionReason
                ? `Customer rejected the quote: ${rejectionReason}`
                : 'Customer rejected the quote',
            },
          },
        },
        {
          new: true,
          ...(versionArrayFilter ? { arrayFilters: versionArrayFilter } : {}),
          ...(session ? { session } : {}),
        },
      ));
      if (!updatedBooking) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_STATUS', message: 'Quote cannot be rejected in current status' }
        });
      }

      return res.json({
        success: true,
        data: { message: 'Quote rejected', booking: bookingForRequest(updatedBooking, (req as any).user) }
      });
    }

    if (action === 'accept') {
      const acceptedFields: Record<string, any> = {};
      if (currentVersion) {
        acceptedFields.acceptedQuoteVersion = Number(currentVersion.version);
        acceptedFields.acceptedQuotationNumber = currentVersion.quotationNumber;
      }
      const updatedBooking = await withAnonymizationWriteFence([userId], async (session) => Booking.findOneAndUpdate(
        { _id: booking._id, status: 'quoted', ...versionGuard },
        {
          $set: { status: 'quote_accepted', ...acceptedFields },
          $push: {
            statusHistory: {
              status: 'quote_accepted',
              timestamp: now,
              updatedBy: customerObjectId,
              note: 'Customer accepted the quote',
            },
          },
        },
        { new: true, ...(session ? { session } : {}) },
      ));
      if (!updatedBooking) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_STATUS', message: 'Quote cannot be accepted in current status' }
        });
      }

      return res.json({
        success: true,
        data: {
          message: 'Quote accepted. Please complete the booking wizard to proceed to payment.',
          booking: bookingForRequest(updatedBooking, (req as any).user),
          requiresBookingWizard: true,
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
        message: "We couldn't complete this request. Please try again."
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
    const authUser = (req as any).user;
    const userIdStr = authUser?._id?.toString();
    const requestedStatusRaw =
      typeof status === 'string' ? status.trim() : '';

    if (!userIdStr) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
      });
    }

    if (!requestedStatusRaw) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: 'Status is required' }
      });
    }

    if (!isValidBookingStatus(requestedStatusRaw)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_STATUS', message: `Unsupported booking status: ${requestedStatusRaw}` }
      });
    }

    const requestedStatus: BookingStatus = requestedStatusRaw;

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
    const isAdmin = authUser?.role === 'admin' || authUser?.isAdmin === true;
    const isAuthorized =
      isAdmin ||
      bookingProfessionalId === userIdStr ||
      bookingCustomerId === userIdStr;

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Not authorized' }
      });
    }

    if (requestedStatus === 'rescheduling_requested') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'Use the dedicated reschedule flow to request rescheduling'
        }
      });
    }

    if (!isTransitionAllowed(booking.status as BookingStatus, requestedStatus)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `Transition from ${booking.status} to ${requestedStatus} is not allowed`
        }
      });
    }

    if (requestedStatus === 'completed') {
      const paymentStatus = booking.payment?.status;
      const paymentStatusValue = paymentStatus ? String(paymentStatus) : '';
      const isAlreadyCaptured =
        paymentStatusValue === 'captured' || paymentStatusValue === 'completed';
      const completionDate = booking.actualEndDate || new Date();

      const finalizeCompletedBooking = async () => {
        const atomicUpdate = await Booking.findOneAndUpdate(
          { _id: booking._id, status: { $in: COMPLETABLE_BOOKING_STATUSES } },
          { $set: { status: 'completed', actualStartDate: booking.actualStartDate || completionDate, actualEndDate: completionDate } },
          { new: true }
        );

        if (!atomicUpdate) {
          const currentBooking = await Booking.findById(booking._id).select('status actualEndDate');
          if (currentBooking?.status === 'completed') {
            booking.status = currentBooking.status;
            booking.actualEndDate = currentBooking.actualEndDate || booking.actualEndDate;
            return { alreadyCompleted: true as const };
          }

          return {
            conflictStatus: currentBooking?.status || booking.status,
            alreadyCompleted: false as const
          };
        }

        const refreshed = await Booking.findById(booking._id);
        if (refreshed) {
          booking.status = refreshed.status;
          booking.actualEndDate = refreshed.actualEndDate;
          booking.milestonePayments = refreshed.milestonePayments;
          booking.__v = refreshed.__v;
        }
        try {
          await releaseBookingCalendar(booking._id);
        } catch (calendarError) {
          // The booking is already completed and payment captured; a failed
          // calendar release must not turn this into an error response. The
          // post-save hook records `calendarReleasePending` for the retry cron.
          console.error(
            "Calendar release failed after completion; retry queued",
            calendarError instanceof Error ? calendarError.name : typeof calendarError,
          );
        }
        return { alreadyCompleted: false as const };
      };

      if (isAlreadyCaptured) {
        const finalizeResult = await finalizeCompletedBooking();
        if (finalizeResult.conflictStatus) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'BOOKING_STATUS_CONFLICT',
              message: `Cannot mark booking completed while booking status is "${finalizeResult.conflictStatus}"`
            }
          });
        }

        markMilestonesCompleted(booking, completionDate);
        await ensureWarrantyCoverageSnapshot(booking);
        await withAnonymizationWriteFence([userIdStr], async (session) => {
          await booking.save(session ? { session } : undefined);
        });

        if (!finalizeResult.alreadyCompleted) {
          // Process referral completion for the customer
          try {
            const bookingAmount = booking.payment?.amount || 0;
            await processReferralCompletion(booking.customer, booking._id, bookingAmount);
          } catch (e) {
            console.error('Error processing referral completion:', e);
          }

          try {
            await updateUserLoyalty(String(booking.customer), booking.payment?.amount || 0);
          } catch (e) {
            console.error('Error updating customer loyalty:', e);
          }

          // Update professional's level after booking completion
          const proId = await getProfessionalId(booking);
          try {
            if (proId) await updateProfessionalLevel(proId);
          } catch (e) {
            console.error('Error updating professional level:', e);
          }

          try {
            await awardBookingCompletionPoints(proId, booking.customer, booking._id);
          } catch (e) {
            console.error('Error awarding booking completion points:', e);
          }

          try {
            const customerId = booking.customer?.toString?.() || String(booking.customer);
            if (customerId) {
              await notify({
                userId: customerId,
                eventKey: 'customer.review_request',
                entityType: 'booking',
                entityId: String(booking._id),
                context: { bookingId: String(booking._id) },
              });
            }
            if (proId) {
              await notify({
                userId: proId,
                eventKey: 'professional.review_request',
                entityType: 'booking',
                entityId: String(booking._id),
                context: { bookingId: String(booking._id) },
              });
            }
          } catch (e) {
            console.error('Error sending review request notifications:', e);
          }
        }

        return res.json({
          success: true,
          data: {
            message: finalizeResult.alreadyCompleted ? 'Booking is already completed' : 'Booking completed',
            booking: bookingForRequest(booking, (req as any).user)
          }
        });
      }

      if (paymentStatus === 'authorized') {
        const captureResult = await captureAndTransferPayment(booking._id.toString());

        if (!captureResult.success) {
          return res.status(400).json({
            success: false,
            error: captureResult.error
          });
        }

        const finalizeResult = await finalizeCompletedBooking();
        if (finalizeResult.conflictStatus) {
          const refundReason = `Booking completion conflict after capture: status=${finalizeResult.conflictStatus}`;
          const refundResult = await refundCapturedBookingOnConflict(booking._id.toString(), refundReason);
          if (!refundResult.success) {
            return res.status(500).json({
              success: false,
              error: {
                code: 'BOOKING_STATUS_CONFLICT_REFUND_FAILED',
                message: 'Payment was captured, but the booking could not be completed and the automatic refund failed. Please contact support before retrying.'
              }
            });
          }

          return res.status(409).json({
            success: false,
            error: {
              code: 'BOOKING_STATUS_CONFLICT',
              message: `Booking status changed to "${finalizeResult.conflictStatus}" before completion could be finalized. Payment was refunded.`
            }
          });
        }

        markMilestonesCompleted(booking, completionDate);
        await ensureWarrantyCoverageSnapshot(booking);
        await withAnonymizationWriteFence([userIdStr], async (session) => {
          await booking.save(session ? { session } : undefined);
        });

        // Process referral completion for the customer
        try {
          const bookingAmount = booking.payment?.amount || 0;
          await processReferralCompletion(booking.customer, booking._id, bookingAmount);
        } catch (e) {
          console.error('Error processing referral completion:', e);
        }

        try {
          await updateUserLoyalty(String(booking.customer), booking.payment?.amount || 0);
        } catch (e) {
          console.error('Error updating customer loyalty:', e);
        }

        // Update professional's level after booking completion
        const proId2 = await getProfessionalId(booking);
        try {
          if (proId2) await updateProfessionalLevel(proId2);
        } catch (e) {
          console.error('Error updating professional level:', e);
        }

        try {
          await awardBookingCompletionPoints(proId2, booking.customer, booking._id);
        } catch (e) {
          console.error('Error awarding booking completion points:', e);
        }

        try {
          const customerId = booking.customer?.toString?.() || String(booking.customer);
          if (customerId) {
            await notify({
              userId: customerId,
              eventKey: 'customer.review_request',
              entityType: 'booking',
              entityId: String(booking._id),
              context: { bookingId: String(booking._id) },
            });
          }
          if (proId2) {
            await notify({
              userId: proId2,
              eventKey: 'professional.review_request',
              entityType: 'booking',
              entityId: String(booking._id),
              context: { bookingId: String(booking._id) },
            });
          }
        } catch (e) {
          console.error('Error sending review request notifications:', e);
        }

        return res.json({
          success: true,
          data: {
            message: finalizeResult.alreadyCompleted
              ? 'Booking is already completed'
              : 'Booking completed and payment transferred to professional',
            booking: bookingForRequest(booking, (req as any).user)
          }
        });
      }

      return res.status(400).json({
        success: false,
        error: {
          code: 'PAYMENT_NOT_CAPTURABLE',
          message: `Cannot mark booking completed while payment status is "${paymentStatus || 'missing'}"`
        }
      });
    }

    // For other status updates, update normally after validation.
    const previousStatus = booking.status as BookingStatus;
    booking.status = requestedStatus;

    // Set timestamps based on status
    if (requestedStatus === 'in_progress' && !booking.actualStartDate) {
      booking.actualStartDate = new Date();
    }
    if (requestedStatus !== previousStatus) {
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push(
        createStatusHistoryEntry(requestedStatus, authUser?._id, `Status changed from ${previousStatus} to ${requestedStatus}`)
      );
    }

    // Fence the updater: a tombstoned requester cannot write. The target
    // professional/customer is intentionally not fenced because booking
    // lifecycle and settlement must remain possible after a counterparty
    // tombstone; the personalized notification below fences the named subject
    // separately. The status/history fields written here contain no target PII.
    await withAnonymizationWriteFence([userIdStr], async (session) => {
      await booking.save(session ? { session } : undefined);
    });

    if (['cancelled', 'refunded', 'completed'].includes(requestedStatus)) {
      try {
        await releaseBookingCalendar(booking._id);
      } catch (calendarError) {
        // The status change is already persisted; a calendar failure must not
        // turn it into a 500 or block the remaining side effects.
        console.error(
          "Calendar release failed after status update; retry queued",
          calendarError instanceof Error ? calendarError.name : typeof calendarError,
        );
      }
    }

    if (
      requestedStatus === 'in_progress' &&
      previousStatus !== 'in_progress'
    ) {
      const customerId =
        booking.customer?._id?.toString?.() || booking.customer?.toString?.();
      if (customerId) {
        // The body/email names the professional, not necessarily the user who
        // changed the status (customer or admin). Keep the trusted subject id
        // that produced the name, and never infer it from the caller input.
        let professionalName: string | undefined;
        let professionalSubjectId: string | undefined;
        try {
          const professionalId = await getProfessionalId(booking);
          if (professionalId) {
            professionalSubjectId = String(professionalId);
            const professionalUser = await User.findById(professionalId)
              .select('name username businessInfo')
              .lean();
            if (professionalUser) {
              professionalName = getProfessionalDisplayName(professionalUser);
            }
          }
        } catch {
          // non-critical
        }
        await notify({
          userId: customerId,
          eventKey: 'customer.booking_started',
          entityType: 'booking',
          entityId: String(booking._id),
          actorId: userIdStr,
          ...(professionalSubjectId ? { subjectUserId: professionalSubjectId } : {}),
          context: {
            bookingId: String(booking._id),
            ...(professionalName ? { professionalName } : {}),
          },
        });
      }
    }

    res.json({
      success: true,
      data: { message: 'Booking status updated', booking: bookingForRequest(booking, (req as any).user) }
    });

  } catch (error: any) {
    console.error('Error updating booking status:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: "We couldn't complete this request. Please try again."
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

    const hasUnpaidMilestones = Array.isArray(booking.milestonePayments)
      && booking.milestonePayments.some((milestone: any) => milestone.status !== 'paid');

    // Only treat the booking as fully paid when all milestones are settled.
    if ((booking.payment?.status === 'authorized' || booking.payment?.status === 'completed') && !hasUnpaidMilestones) {
      return res.json({
        success: true,
        data: {
          message: 'Payment already processed',
          paymentStatus: booking.payment.status,
          booking: bookingForRequest(booking, (req as any).user),
          shouldRedirect: true,
          redirectTo: `/bookings/${bookingId}/payment/success`
        }
      });
    }

    const allowedStatuses = hasUnpaidMilestones
      ? ['quote_accepted', 'payment_pending', 'booked', 'in_progress', 'professional_completed']
      : ['quote_accepted', 'payment_pending', 'booked'];

    if (!allowedStatuses.includes(booking.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Cannot initiate payment while booking is ${booking.status}`
        }
      });
    }

    const { pointsToRedeem: pts, discountCode } = req.body || {};

    const requestedCodeLabel = typeof discountCode === 'string' && discountCode.trim()
      ? discountCode.trim().toUpperCase()
      : undefined;
    const storedCodeLabel = (booking.payment as any)?.discount?.codeLabel || undefined;
    const codeMatchesStored = storedCodeLabel === requestedCodeLabel;

    const requestedPoints = parseInt(pts) || 0;
    const storedPoints = Number((booking.payment as any)?.discount?.pointsRedeemed) || 0;
    const pointsMatchStored = storedPoints === requestedPoints;

    let commissionPercent = 0;
    try {
      const platformConfig = await PlatformSettings.getCurrentConfig();
      commissionPercent = platformConfig.commissionPercent;
    } catch {
      const parsed = Number.parseFloat(process.env.STRIPE_PLATFORM_COMMISSION_PERCENT || '0');
      commissionPercent = Number.isFinite(parsed) ? parsed : 0;
    }
    const hasMilestones = Array.isArray(booking.milestonePayments) && booking.milestonePayments.length > 0;
    const expectedGrossAmount = computeGrossBookingAmount(booking, commissionPercent);
    const existingOriginalAmount = booking.payment?.discount?.originalAmount ?? booking.payment?.netAmount ?? 0;
    const amountMatches = hasMilestones || Math.abs(expectedGrossAmount - existingOriginalAmount) < 0.01;

    if (
      booking.payment?.stripeClientSecret &&
      booking.payment.status === 'pending' &&
      codeMatchesStored &&
      pointsMatchStored &&
      amountMatches
    ) {
      return res.json({
        success: true,
        data: {
          clientSecret: booking.payment.stripeClientSecret,
          booking: bookingForRequest(booking, (req as any).user)
        }
      });
    }
    const paymentResult = await createPaymentIntent(
      booking._id.toString(),
      userId,
      requestedPoints,
      undefined,
      requestedCodeLabel
    );
    if (!paymentResult.success) {
      return res.status(400).json({
        success: false,
        error: paymentResult.error
      });
    }

    const refreshedBooking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location isAnonymized deletedAt')
      .populate('professional', 'name email username businessInfo isAnonymized deletedAt')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    return res.json({
      success: true,
      data: {
        clientSecret: paymentResult.clientSecret,
        booking: bookingForRequest(refreshedBooking || booking, (req as any).user)
      }
    });
  } catch (error: any) {
    console.error('Error ensuring payment intent:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: "We couldn't complete this request. Please try again."
      }
    });
  }
};

export const setBookingSchedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { scheduledStartDate, scheduledStartTime, additionalNotes } = req.body;
    const hasExplicitExtraOptions = 'selectedExtraOptions' in req.body;
    const selectedExtraOptions = hasExplicitExtraOptions ? req.body.selectedExtraOptions : undefined;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!scheduledStartDate) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'Start date is required' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location isAnonymized deletedAt')
      .populate('professional', 'name email username businessInfo isAnonymized deletedAt')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can set the schedule' } });
    }

    if (!['quote_accepted'].includes(booking.status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Schedule can only be set for accepted quotes' } });
    }

    const scheduleUpdate = await buildScheduleUpdatePayload({
      booking,
      scheduledStartDate,
      scheduledStartTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      hasExplicitExtraOptions,
      selectedExtraOptions,
      // Client bug list #23b: convert the wall-clock time in the
      // professional's effective zone, not silently in UTC.
      requestTimeZone: (req.body as any)?.timeZone || (req.body as any)?.scheduleTimeZone,
    });

    if (!scheduleUpdate.success) {
      return res.status(scheduleUpdate.status).json({ success: false, error: scheduleUpdate.error });
    }

    applyScheduleFields(booking, scheduleUpdate.data);
    if (typeof scheduleUpdate.data.selectedSubprojectIndex === 'number') {
      booking.selectedSubprojectIndex = scheduleUpdate.data.selectedSubprojectIndex;
    }
    if (hasExplicitExtraOptions) {
      booking.selectedExtraOptions = scheduleUpdate.data.selectedExtraOptions;
    }

    if (additionalNotes) {
      booking.rfqData = booking.rfqData || {} as any;
      booking.rfqData.additionalNotes = additionalNotes;
    }

    // Should-fix 4: persist the engine-resolved conversion zone (the window
    // already falls back to the request zone), not only a client-sent zone.
    const scheduleTimeZone = scheduleUpdate.data.scheduleTimeZone || resolveScheduleTimeZone(
      (req.body as any)?.timeZone || (req.body as any)?.scheduleTimeZone,
    );
    if (scheduleTimeZone) {
      booking.scheduleTimeZone = scheduleTimeZone;
    }
    // A legacy booking without a booking-time snapshot must stay legacy. The
    // live project at schedule-selection time is not evidence of what was
    // agreed when the booking was created, so it is never captured late.
    // Prepared before the transaction: the callback may replay, and the
    // pre-attempt array is restored, so the entry is not appended twice.
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push(createStatusHistoryEntry(
      booking.status,
      (req as any).user._id,
      'Schedule selected',
    ));

    const candidate = {
      _id: booking._id,
      professional: (booking.professional as any)?._id || booking.professional,
      assignedTeamMembers:
        scheduleUpdate.data.assignedTeamMembers || booking.assignedTeamMembers || [],
      resourcePlan: booking.resourcePlan || [],
      scheduledStartDate: scheduleUpdate.data.scheduledStartDate,
      scheduledExecutionEndDate: scheduleUpdate.data.scheduledExecutionEndDate,
      scheduledBufferEndDate: scheduleUpdate.data.scheduledBufferEndDate,
    };
    const proposedConflicts = await findBookingCalendarConflictsForSchedule({
      bookingId: booking._id,
      booking: candidate as any,
    });
    if (
      scheduleUpdate.data.scheduledStartDate &&
      (scheduleUpdate.data.scheduledBufferEndDate || scheduleUpdate.data.scheduledExecutionEndDate) &&
      proposedConflicts.length > 0
    ) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'TEAM_CONFLICT',
          message: 'The proposed schedule now conflicts with another booking, meeting, or support reservation',
          conflicts: proposedConflicts,
        },
      });
    }

    const updatedBooking = await withAnonymizationWriteFence([userId], async (session) => {
      await replaceBookingCalendar(candidate as any, session);
      await booking.save(session ? { session } : undefined);
      return booking;
    });

    try {
      const professional = booking.professional as any;
      const customer = booking.customer as any;
      const professionalId = professional?._id?.toString?.() || professional?.id;
      if (professionalId) {
        await notify({
          userId: professionalId,
          eventKey: 'professional.booking_scheduled',
          entityType: 'booking',
          entityId: String(booking._id),
          actorId: userId,
          context: {
            bookingId: String(booking._id),
            customerName: customer?.name,
            scheduledStart: (updatedBooking as any).scheduledStartDate,
          },
        });
      }
    } catch (emailError: any) {
      console.error('Failed to notify booking-scheduled:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: { message: 'Schedule set successfully', booking: bookingForRequest(updatedBooking, (req as any).user) }
    });
  } catch (error: any) {
    if (error?.status === 409 || error?.code === 'SCHEDULE_CONFLICT') {
      return res.status(409).json({
        success: false,
        error: { code: error.code || 'SCHEDULE_CONFLICT', message: error.message || 'The schedule changed. Refresh and try again.' },
      });
    }
    console.error('Error setting booking schedule:', error);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: "We couldn't set the schedule. Please try again." } });
  }
};

export const requestBookingReschedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { scheduledStartDate, scheduledStartTime, reason, note, description } = req.body;
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    const normalizedNote = normalizeOptionalText(note);
    const normalizedDescription = normalizeOptionalText(description);

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!scheduledStartDate || typeof scheduledStartDate !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'A proposed start date is required' } });
    }

    if (!normalizedReason || normalizedReason.length < 3 || normalizedReason.length > MAX_RESCHEDULE_REASON_LENGTH) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_REASON',
          message: `A rescheduling reason between 3 and ${MAX_RESCHEDULE_REASON_LENGTH} characters is required`
        }
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location isAnonymized deletedAt')
      .populate('professional', 'name email username businessInfo isAnonymized deletedAt')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    const professionalId = await getProfessionalId(booking);
    const customerId = booking.customer?._id?.toString?.() || booking.customer?.toString?.();
    const isProfessional = professionalId === userId;
    const isCustomer = customerId === userId;
    if (!isProfessional && !isCustomer) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer or assigned professional can request rescheduling' } });
    }

    if (booking.status !== 'booked' && booking.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Rescheduling can only be requested for booked or in-progress work' } });
    }

    const completedRescheduleCount = (booking.rescheduleHistory || []).length;
    if (completedRescheduleCount >= MAX_RESCHEDULES_PER_BOOKING) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'MAX_RESCHEDULES_REACHED',
          message: `This booking has reached the maximum of ${MAX_RESCHEDULES_PER_BOOKING} reschedules`,
        },
      });
    }

    const proposedSchedule = await buildScheduleUpdatePayload({
      booking,
      scheduledStartDate,
      scheduledStartTime: typeof scheduledStartTime === 'string' ? scheduledStartTime : undefined,
      // Client bug list #23c: same effective-zone conversion as creation, so
      // a reschedule to 12:00 lands on the same instant the calendar shows.
      requestTimeZone: (req.body as any)?.timeZone || (req.body as any)?.scheduleTimeZone,
    });

    if (!proposedSchedule.success) {
      return res.status(proposedSchedule.status).json({ success: false, error: proposedSchedule.error });
    }

    const proposedTeamMembers =
      Array.isArray(proposedSchedule.data.assignedTeamMembers) && proposedSchedule.data.assignedTeamMembers.length > 0
        ? proposedSchedule.data.assignedTeamMembers
        : booking.assignedTeamMembers || [];
    const proposedStart = proposedSchedule.data.scheduledStartDate;
    const proposedEnd =
      proposedSchedule.data.scheduledBufferEndDate || proposedSchedule.data.scheduledExecutionEndDate;

    if (proposedStart && proposedEnd && proposedTeamMembers.length > 0) {
      const conflicts = await findTeamConflicts(
        String(booking._id),
        proposedTeamMembers as any,
        proposedStart,
        proposedEnd
      );
      if (conflicts.length > 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'TEAM_CONFLICT',
            message: 'The proposed schedule conflicts with another booking on the same team member(s)',
            conflicts,
          },
        });
      }
    }

    booking.status = 'rescheduling_requested';
    booking.rescheduleRequest = {
      status: 'pending',
      requestedBy: (req as any).user._id,
      requestedAt: new Date(),
      reason: normalizedReason,
      description: normalizedDescription,
      note: normalizedNote,
      previousSchedule: snapshotCurrentSchedule(booking),
      proposedSchedule: {
        scheduledStartDate: proposedSchedule.data.scheduledStartDate,
        scheduledExecutionEndDate: proposedSchedule.data.scheduledExecutionEndDate,
        scheduledBufferStartDate: proposedSchedule.data.scheduledBufferStartDate,
        scheduledBufferEndDate: proposedSchedule.data.scheduledBufferEndDate,
        scheduledBufferUnit: proposedSchedule.data.scheduledBufferUnit,
        scheduledStartTime: proposedSchedule.data.scheduledStartTime,
        scheduledEndTime: proposedSchedule.data.scheduledEndTime,
        assignedTeamMembers: proposedSchedule.data.assignedTeamMembers,
      },
    } as any;
    booking.statusHistory = booking.statusHistory || [];
    const requesterLabel = isCustomer ? 'Customer' : 'Professional';
    booking.statusHistory.push(
      createStatusHistoryEntry(
        'rescheduling_requested',
        (req as any).user._id,
        truncateStatusHistoryNote(`${requesterLabel} requested rescheduling: ${normalizedReason}`)
      )
    );

    await withAnonymizationWriteFence([userId], async (session) => {
      await booking.save(session ? { session } : undefined);
    });

    try {
      const customer = booking.customer as any;
      const professional = booking.professional as any;
      const oldDate = booking.rescheduleRequest?.previousSchedule?.scheduledStartDate;
      const newDate = booking.rescheduleRequest?.proposedSchedule?.scheduledStartDate;
      // Notify the party who must respond (not the requester)
      if (isProfessional && customerId) {
        await notify({
          userId: customerId,
          eventKey: 'customer.reschedule_requested',
          entityType: 'booking',
          entityId: String(booking._id),
          actorId: userId,
          context: {
            bookingId: String(booking._id),
            professionalName: getProfessionalDisplayName(professional),
            oldDate,
            newDate,
            reason: normalizedReason,
          },
        });
      } else if (isCustomer && professionalId) {
        await notify({
          userId: professionalId,
          eventKey: 'professional.reschedule_requested',
          entityType: 'booking',
          entityId: String(booking._id),
          actorId: userId,
          context: {
            bookingId: String(booking._id),
            customerName: customer?.name,
            oldDate,
            newDate,
            reason: normalizedReason,
          },
        });
      }
    } catch (emailError: any) {
      console.error('Failed to notify reschedule-requested:', emailError?.message || emailError);
    }

    return res.json({
      success: true,
      data: { message: 'Rescheduling request submitted', booking: bookingForRequest(booking, (req as any).user) },
    });
  } catch (error: any) {
    console.error('Error requesting booking reschedule:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: "We couldn't submit the rescheduling request. Please try again." } });
  }
};

export const respondToBookingReschedule = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { action, note, reason, description } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    const normalizedAction = action === 'decline' ? 'refund' : action;
    if (!['accept', 'refund', 'dispute'].includes(normalizedAction)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_ACTION', message: 'Action must be accept, refund, or dispute' } });
    }

    const loadedBooking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location isAnonymized deletedAt')
      .populate('professional', 'name email username businessInfo isAnonymized deletedAt')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!loadedBooking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }
    let booking = loadedBooking;

    if (booking.customer?._id?.toString?.() !== userId && booking.customer?.toString?.() !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the customer can respond to a rescheduling request' } });
    }

    // Client bug list #9c (+ review nit): once the request is disputed,
    // accept/decline stay rejected with the explicit 409 — checked first so
    // post-dispute responses never report the generic 400.
    const openRescheduleDispute = Boolean(
      booking.dispute && !booking.dispute.resolvedAt && booking.dispute.type === 'reschedule',
    );
    if (openRescheduleDispute && normalizedAction !== 'dispute') {
      return res.status(409).json({
        success: false,
        error: { code: 'RESCHEDULE_DISPUTED', message: 'This rescheduling request was disputed and can no longer be accepted or declined' },
      });
    }

    if (booking.status !== 'rescheduling_requested' || booking.rescheduleRequest?.status !== 'pending') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'There is no pending rescheduling request for this booking' } });
    }

    const responseNote = typeof note === 'string' ? note.trim() : undefined;

    if (normalizedAction === 'accept') {
      const proposedTeamMembers =
        Array.isArray(booking.rescheduleRequest.proposedSchedule?.assignedTeamMembers) &&
        booking.rescheduleRequest.proposedSchedule!.assignedTeamMembers!.length > 0
          ? booking.rescheduleRequest.proposedSchedule!.assignedTeamMembers
          : booking.assignedTeamMembers || [];
      const proposedStart = booking.rescheduleRequest.proposedSchedule?.scheduledStartDate;
      const proposedEnd =
        booking.rescheduleRequest.proposedSchedule?.scheduledBufferEndDate ||
        booking.rescheduleRequest.proposedSchedule?.scheduledExecutionEndDate;

      if (proposedStart && proposedEnd && proposedTeamMembers.length > 0) {
        const conflicts = await findTeamConflicts(
          String(booking._id),
          proposedTeamMembers as any,
          proposedStart as Date,
          proposedEnd as Date
        );
        if (conflicts.length > 0) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'TEAM_CONFLICT',
              message: 'The proposed schedule now conflicts with another booking on the same team member(s)',
              conflicts,
            },
          });
        }
        const sharedConflicts = await findBookingCalendarConflictsForSchedule({
          bookingId: booking._id,
          booking: {
            _id: booking._id,
            professional: (booking.professional as any)?._id || booking.professional,
            assignedTeamMembers: proposedTeamMembers as any[],
            resourcePlan: booking.resourcePlan || [],
            scheduledStartDate: proposedStart as Date,
            scheduledExecutionEndDate: booking.rescheduleRequest.proposedSchedule?.scheduledExecutionEndDate,
            scheduledBufferEndDate: booking.rescheduleRequest.proposedSchedule?.scheduledBufferEndDate,
          },
        });
        if (sharedConflicts.length > 0) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'TEAM_CONFLICT',
              message: 'The proposed schedule now conflicts with another meeting or support reservation',
              conflicts: sharedConflicts,
            },
          });
        }
      }

      const proposedSchedule = booking.rescheduleRequest.proposedSchedule || {};
      // Prepare the document before the transaction. The driver may replay the
      // callback after a transient conflict; only the save may re-run, so the
      // additive status-history entry is created exactly once.
      booking.rescheduleRequest!.respondedAt = new Date();
      booking.rescheduleRequest!.respondedBy = (req as any).user._id;
      if (responseNote !== undefined) booking.rescheduleRequest!.responseNote = responseNote;
      booking.rescheduleRequest!.status = 'accepted';
      applyScheduleFields(booking, proposedSchedule || {});
      // Client bug list #9b: the new start date overrules earlier manual
      // planning (day-mode only; hour-mode planning stays untouched).
      await applyReschedulePlanReset(booking, (req as any).user._id);
      const calendarCandidate = {
        _id: booking._id,
        professional: (booking.professional as any)?._id || booking.professional,
        assignedTeamMembers: proposedTeamMembers,
        resourcePlan: booking.resourcePlan || [],
        scheduledStartDate: proposedSchedule.scheduledStartDate,
        scheduledExecutionEndDate: booking.scheduledExecutionEndDate,
        scheduledBufferEndDate: booking.scheduledBufferEndDate,
      };
      booking.status = 'booked';
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push(
        createStatusHistoryEntry('booked', (req as any).user._id, 'Customer accepted the rescheduling request')
      );
      booking = await withAnonymizationWriteFence([userId], async (session) => {
        await replaceBookingCalendar(calendarCandidate as any, session);
        await booking.save(session ? { session } : undefined);
        return booking;
      });
    } else {
      booking.rescheduleRequest!.respondedAt = new Date();
      booking.rescheduleRequest!.respondedBy = (req as any).user._id;
      booking.rescheduleRequest!.responseNote = responseNote;
      booking.statusHistory = booking.statusHistory || [];
    }

    if (normalizedAction === 'refund') {
      booking.rescheduleRequest!.status = 'declined';
      const refundReasonText = typeof note === 'string' && note.trim()
        ? `Customer declined rescheduling request: ${note.trim()}`
        : 'Customer declined rescheduling request';
      booking.cancellation = {
        cancelledBy: (req as any).user._id,
        reason: refundReasonText,
        cancelledAt: new Date(),
      } as any;

      const hasPayment = !!booking.payment?.stripePaymentIntentId;
      let refundAmount = 0;
      if (hasPayment && booking.payment && REFUNDABLE_PAYMENT_STATUSES.has(booking.payment.status)) {
        try {
          const result = await executeRefund(String(booking._id), {
            reason: refundReasonText,
            actorId: (req as any).user._id,
          });
          refundAmount = result.amount;
          if (booking.cancellation) {
            (booking.cancellation as any).refundAmount = refundAmount || undefined;
          }
        } catch (refundError: any) {
          if (refundError instanceof RefundError) {
            return res.status(refundError.httpStatus).json({
              success: false,
              error: { code: refundError.code || 'REFUND_FAILED', message: `Refund failed: ${refundError.message}` },
            });
          }
          throw refundError;
        }
      }

      booking.status = 'cancelled';
      const refundIssued = refundAmount > 0;
      booking.statusHistory.push(
        createStatusHistoryEntry(
          'cancelled',
          (req as any).user._id,
          refundIssued
            ? 'Customer declined rescheduling and refund issued'
            : 'Customer declined rescheduling (no refund issued)'
        )
      );
      releaseScheduleSlots(booking, (req as any).user._id);
    } else if (normalizedAction === 'dispute') {
      // Review follow-up: the live subdoc must agree with the history entry
      // and response DTO on the terminal 'disputed' state (never 'declined').
      booking.rescheduleRequest!.status = 'disputed';
      const disputeReason = typeof reason === 'string' && reason.trim()
        ? reason.trim()
        : 'Reschedule dispute';
      const disputeDescription = typeof description === 'string' && description.trim()
        ? description.trim()
        : (typeof note === 'string' && note.trim() ? note.trim() : '');
      const disputedAt = new Date();
      const slaDeadline = new Date(disputedAt.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);
      booking.dispute = {
        raisedBy: (req as any).user._id,
        reason: disputeReason,
        description: disputeDescription,
        raisedAt: disputedAt,
        slaDeadline,
        type: 'reschedule',
        attachments: [],
      } as any;
      booking.status = 'dispute';
      booking.statusHistory.push(
        createStatusHistoryEntry('dispute', (req as any).user._id, `Customer disputed rescheduling: ${disputeReason}`)
      );
    }

    booking.rescheduleHistory = booking.rescheduleHistory || [];
    booking.rescheduleHistory.push({
      requestedBy: booking.rescheduleRequest!.requestedBy,
      requestedAt: booking.rescheduleRequest!.requestedAt,
      reason: booking.rescheduleRequest!.reason,
      description: booking.rescheduleRequest!.description,
      note: booking.rescheduleRequest!.note,
      previousSchedule: booking.rescheduleRequest!.previousSchedule,
      proposedSchedule: booking.rescheduleRequest!.proposedSchedule,
      status: normalizedAction === 'accept' ? 'accepted' : normalizedAction === 'dispute' ? 'disputed' : 'declined',
      respondedAt: booking.rescheduleRequest!.respondedAt,
      respondedBy: booking.rescheduleRequest!.respondedBy,
      responseNote: booking.rescheduleRequest!.responseNote,
    } as any);
    booking.rescheduleRequest = undefined;

    await withAnonymizationWriteFence([userId], async (session) => {
      await booking.save(session ? { session } : undefined);
    });

    if (normalizedAction !== 'accept' && ['cancelled', 'refunded'].includes(booking.status)) {
      try {
        await releaseBookingCalendar(booking._id);
      } catch (calendarError) {
        console.error(
          "Calendar release failed after reschedule response; retry queued",
          calendarError instanceof Error ? calendarError.name : typeof calendarError,
        );
      }
    }

    if (normalizedAction === 'accept') {
      try {
        await WarrantyClaim.updateMany(
          {
            booking: booking._id,
            'resolution.resolvedAt': { $exists: false },
          },
          {
            $unset: {
              'sla.professionalResponseDueAt': '',
              'sla.customerConfirmationDueAt': '',
              'proposal.resolveByDate': '',
            },
          }
        );
      } catch (slaErr: any) {
        console.error('Failed to reset warranty SLA on reschedule:', slaErr?.message || slaErr);
      }
    }

    if (normalizedAction !== 'dispute') {
      try {
        const professional = booking.professional as any;
        const professionalId = professional?._id?.toString?.() || professional?.id;
        if (professionalId) {
          await notify({
            userId: professionalId,
            eventKey:
              normalizedAction === 'accept'
                ? 'professional.reschedule_accepted'
                : 'professional.reschedule_declined',
            entityType: 'booking',
            entityId: String(booking._id),
            actorId: userId,
            context: {
              bookingId: String(booking._id),
              responseNote: typeof note === 'string' ? note.trim() : undefined,
            },
          });
        }
      } catch (emailError: any) {
        console.error('Failed to notify reschedule-resolved:', emailError?.message || emailError);
      }
    }

    const messageByAction: Record<string, string> = {
      accept: 'Rescheduling request accepted',
      refund: 'Rescheduling request declined and refund issued',
      dispute: 'Rescheduling dispute raised',
    };

    return res.json({
      success: true,
      data: {
        message: messageByAction[normalizedAction] || 'Rescheduling request processed',
        booking: bookingForRequest(booking, (req as any).user),
      },
    });
  } catch (error: any) {
    if (error?.status === 409) {
      return res.status(409).json({
        success: false,
        error: { code: error.code || 'RESCHEDULE_CONFLICT', message: error.message || 'The rescheduling request changed. Refresh and try again.' },
      });
    }
    console.error('Error responding to booking reschedule:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: "We couldn't update the rescheduling request. Please try again." } });
  }
};

export const extendBookingExecution = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.params;
    const userId = (req as any).user?._id?.toString();
    const { newExecutionEndDate, note } = req.body;
    const normalizedNote = normalizeOptionalText(note);

    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }

    if (!newExecutionEndDate || typeof newExecutionEndDate !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'MISSING_DATE', message: 'A new execution end date is required' } });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location isAnonymized deletedAt')
      .populate('professional', 'name email username businessInfo isAnonymized deletedAt')
      .populate('project', 'title description pricing category service professionalId extraOptions postBookingQuestions');

    if (!booking) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Booking not found' } });
    }

    const professionalId = await getProfessionalId(booking);
    if (professionalId !== userId) {
      return res.status(403).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Only the assigned professional can extend execution' } });
    }

    if (booking.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'Execution can only be extended while work is in progress' } });
    }

    const nextExecutionEndDate = new Date(newExecutionEndDate);
    if (isNaN(nextExecutionEndDate.getTime())) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'Provide a valid execution end date' } });
    }

    const currentExecutionEndDate = booking.scheduledExecutionEndDate || booking.scheduledStartDate;
    if (!currentExecutionEndDate || nextExecutionEndDate <= currentExecutionEndDate) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_DATE', message: 'The new execution end date must be later than the current schedule' } });
    }

    const extensionMs = nextExecutionEndDate.getTime() - currentExecutionEndDate.getTime();
    const nextBufferStart = booking.scheduledBufferStartDate
      ? new Date(booking.scheduledBufferStartDate.getTime() + extensionMs)
      : booking.scheduledBufferEndDate
        ? nextExecutionEndDate
        : undefined;
    const nextBufferEnd = booking.scheduledBufferEndDate
      ? new Date(booking.scheduledBufferEndDate.getTime() + extensionMs)
      : undefined;

    const statusEntry = createStatusHistoryEntry(
      'in_progress',
      (req as any).user._id,
      normalizedNote
        ? truncateStatusHistoryNote(`Execution extended: ${normalizedNote}`)
        : truncateStatusHistoryNote(`Execution end date moved to ${nextExecutionEndDate.toISOString()}`)
    );

    const candidate = {
      _id: booking._id,
      professional: (booking.professional as any)?._id || booking.professional,
      assignedTeamMembers: booking.assignedTeamMembers || [],
      resourcePlan: booking.resourcePlan || [],
      scheduledStartDate: booking.scheduledStartDate,
      scheduledExecutionEndDate: nextExecutionEndDate,
      scheduledBufferEndDate: nextBufferEnd,
    };
    const intervalEnd = nextBufferEnd || nextExecutionEndDate;
    const calendarConflicts = booking.scheduledStartDate
      ? await findBookingCalendarConflictsForSchedule({
          bookingId: booking._id,
          booking: candidate as any,
        })
      : [];
    const bookingConflicts = booking.scheduledStartDate
      ? await findTeamConflicts(
          String(booking._id),
          [
            ...((booking.professional as any)?._id ? [(booking.professional as any)._id] : []),
            ...(candidate.assignedTeamMembers as any[]),
          ] as any[],
          booking.scheduledStartDate,
          intervalEnd,
        )
      : [];
    const conflicts = [...calendarConflicts, ...bookingConflicts];
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'TEAM_CONFLICT',
          message: 'The extended schedule conflicts with another booking, meeting, or support reservation',
          conflicts,
        },
      });
    }

    // Prepare the document before the transaction (see respondToBookingReschedule):
    // a replayed callback must not append the history entry twice.
    booking.scheduledExecutionEndDate = nextExecutionEndDate;
    booking.scheduledBufferStartDate = nextBufferStart;
    booking.scheduledBufferEndDate = nextBufferEnd;
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push(statusEntry);

    const updatedBooking = await withAnonymizationWriteFence([userId], async (session) => {
      await replaceBookingCalendar(candidate as any, session);
      await booking.save(session ? { session } : undefined);
      return booking;
    });

    return res.json({
      success: true,
      data: { message: 'Execution extended successfully', booking: bookingForRequest(updatedBooking, (req as any).user) },
    });
  } catch (error: any) {
    if (error?.status === 409) {
      return res.status(409).json({
        success: false,
        error: { code: error.code || 'SCHEDULE_CONFLICT', message: error.message || 'The schedule changed. Refresh and try again.' },
      });
    }
    console.error('Error extending booking execution:', error);
    return res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: "We couldn't extend the execution date. Please try again." } });
  }
};
