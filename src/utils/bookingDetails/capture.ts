import mongoose from 'mongoose';
import ServiceConfiguration from '../../models/serviceConfiguration';
import { buildBookingSnapshot, isValidIanaTimeZone } from './snapshot';

/**
 * VAT question definitions are configured on the service configuration. They
 * are snapshotted so a later config edit cannot rewrite the questions the
 * customer actually answered at booking time.
 */
export const loadVatQuestionDefinitions = async (
  serviceConfigurationId?: string | null,
): Promise<unknown[]> => {
  if (!serviceConfigurationId || !mongoose.Types.ObjectId.isValid(serviceConfigurationId)) return [];
  const config = await ServiceConfiguration.findById(serviceConfigurationId)
    .select('vatManagement.reducedVatQuestions')
    .lean();
  return (config as any)?.vatManagement?.reducedVatQuestions || [];
};

/**
 * Only an explicitly requested, valid IANA zone is a recorded schedule fact.
 * The professional's current profile zone is not evidence of the customer's
 * chosen wall-clock zone and must never be written as if it were recorded.
 */
export const resolveScheduleTimeZone = (requested: unknown): string | null =>
  isValidIanaTimeZone(requested) ? requested.trim() : null;

/**
 * Capture only when no snapshot exists. A captured snapshot is immutable even
 * if the live project later changes.
 */
export const captureBookingSnapshotIfMissing = (params: {
  booking: any;
  project?: any;
  customer?: any;
  professional?: any;
  source: 'booking_creation' | 'schedule_selection' | 'direct_quotation_creation';
  vatQuestions?: unknown;
  scheduleTimeZone?: string | null;
}) => {
  if (!params.booking || params.booking.bookingSnapshot) return false;
  const snapshot = buildBookingSnapshot({
    booking: params.booking,
    project: params.project,
    customer: params.customer,
    professional: params.professional,
    source: params.source,
    vatQuestions: params.vatQuestions,
    scheduleTimeZone: params.scheduleTimeZone,
  });
  if (!snapshot) return false;
  params.booking.bookingSnapshot = snapshot;
  if (typeof params.booking.markModified === 'function') {
    params.booking.markModified('bookingSnapshot');
  }
  return true;
};
