import Project from '../models/project';
import PointsConfig from '../models/pointsConfig';
import PointTransaction from '../models/pointTransaction';
import { addPoints } from './pointsSystem';
import {
  addWarrantyDuration,
  getBookingWarrantyDuration,
  normalizeWarrantyDuration,
} from './warranty';

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
