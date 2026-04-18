import Project from '../models/project';
import PointsConfig from '../models/pointsConfig';
import PointTransaction from '../models/pointTransaction';
import { addPoints } from './pointsSystem';
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from './warranty';

export const resolveSubprojectIndex = (
  subprojects: any[] | undefined | null,
  requestedIndex: unknown
): number | undefined => {
  const list = Array.isArray(subprojects) ? subprojects : [];

  const parsed =
    typeof requestedIndex === 'number'
      ? requestedIndex
      : typeof requestedIndex === 'string'
      ? Number.parseInt(requestedIndex, 10)
      : Number.NaN;

  if (Number.isInteger(parsed) && parsed >= 0 && parsed < list.length) {
    return parsed;
  }

  if (list.length === 1) {
    return 0;
  }

  const rfqIndexes = list.reduce((acc: number[], sp: any, i: number) => {
    if (sp?.pricing?.type === 'rfq') acc.push(i);
    return acc;
  }, []);

  if (rfqIndexes.length === 1) {
    return rfqIndexes[0];
  }

  return undefined;
};

export const normalizeExtraOptions = (
  extraOptions: unknown,
  projectExtraOptions: any[] | undefined | null
): { extraOptionId: string; bookedPrice: number }[] => {
  if (!Array.isArray(extraOptions) || !Array.isArray(projectExtraOptions)) {
    return [];
  }

  const seen = new Set<string>();
  const result: { extraOptionId: string; bookedPrice: number }[] = [];

  for (const item of extraOptions) {
    if (typeof item === 'object' && item !== null && typeof item.extraOptionId === 'string') {
      const match = projectExtraOptions.find(
        (opt: any) => opt._id?.toString() === item.extraOptionId
      );
      if (match && !seen.has(item.extraOptionId)) {
        seen.add(item.extraOptionId);
        result.push({
          extraOptionId: item.extraOptionId,
          bookedPrice: typeof item.bookedPrice === 'number' ? item.bookedPrice : match.price,
        });
      }
      continue;
    }

    const idx =
      typeof item === 'number'
        ? item
        : typeof item === 'string'
        ? Number.parseInt(item, 10)
        : Number.NaN;

    if (Number.isInteger(idx) && idx >= 0 && idx < projectExtraOptions.length) {
      const opt = projectExtraOptions[idx];
      const id = opt._id?.toString();
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push({ extraOptionId: id, bookedPrice: opt.price });
      }
    }
  }

  return result;
};

export const isDuplicateKeyError = (error: any): boolean => error?.code === 11000;

export const getProfessionalId = async (booking: any) => {
  if (booking.professional) return booking.professional;
  if (!booking.project) return undefined;
  const project = await Project.findById(booking.project).select('professionalId');
  return project?.professionalId;
};

export const markMilestonesCompleted = (booking: any, completedAt: Date) => {
  if (!Array.isArray(booking.milestonePayments) || booking.milestonePayments.length === 0) return;
  booking.milestonePayments.forEach((milestone: any) => {
    milestone.workStatus = 'completed';
    milestone.startedAt = milestone.startedAt || booking.actualStartDate || completedAt;
    milestone.completedAt = milestone.completedAt || completedAt;
  });
};

export const ensureWarrantyCoverageSnapshot = async (booking: any) => {
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
      if (duration) source = 'project_subproject';
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
    if (!isDuplicateKeyError(error)) throw error;
  }
};

export const awardBookingCompletionPoints = async (
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

export const getUnpaidMilestoneCount = (
  milestonePayments?: Array<{ status?: string; amount?: number }>
): number => {
  if (!Array.isArray(milestonePayments) || milestonePayments.length === 0) return 0;
  return milestonePayments.filter((m) => m.status !== 'paid' && (Number(m.amount) || 0) > 0).length;
};

export const countUnpaidMilestones = (booking: { milestonePayments?: Array<{ status?: string; amount?: number }> }): number =>
  getUnpaidMilestoneCount(booking.milestonePayments);
