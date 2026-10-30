import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../models/booking', () => ({ default: {}, BookingStatus: {} }));
vi.mock('../../../models/user', () => ({ default: {} }));
vi.mock('../../../models/warrantyClaim', () => ({ default: {} }));
vi.mock('../../../models/cancellationRequest', () => ({
  default: {},
  CANCELLATION_REASON_LABELS: {},
}));
vi.mock('../../../models/conversation', () => ({ default: {} }));
vi.mock('../../../handlers/Stripe/payment', () => ({
  captureAndTransferPayment: vi.fn(),
  executeRefund: vi.fn(),
  RefundError: class RefundError extends Error {},
}));
vi.mock('../../../services/stripe', () => ({ stripe: {}, STRIPE_CONFIG: { environment: 'test' } }));
vi.mock('../../../services/invoiceArtifacts', () => ({ ensureBookingInvoiceArtifacts: vi.fn() }));
vi.mock('../../../utils/refundFinalization', () => ({}));
vi.mock('../../../utils/referralSystem', () => ({ processReferralCompletion: vi.fn() }));
vi.mock('../../../utils/professionalLevelSystem', () => ({ updateProfessionalLevel: vi.fn() }));
vi.mock('../../../utils/loyaltySystem', () => ({ updateUserLoyalty: vi.fn() }));
vi.mock('../../../utils/bookingHelpers', () => ({}));
vi.mock('../../../utils/auditLogger', () => ({ auditLog: vi.fn() }));
vi.mock('../../../utils/displayName', () => ({ getProfessionalDisplayName: vi.fn() }));
vi.mock('../../../utils/s3Upload', () => ({ presignS3Url: vi.fn(async (url: string) => url) }));
vi.mock('../../../utils/scheduleEngine', () => ({}));
vi.mock('../../../utils/scheduleConflict', () => ({}));
vi.mock('../../../utils/support/bookingCalendar', () => ({}));
vi.mock('../../../utils/support/calendarReservations', () => ({}));
vi.mock('../../../utils/appErrors', () => ({ UserFacingError: class UserFacingError extends Error {} }));
vi.mock('../../../utils/accountAnonymity', () => ({
  isAnonymizedAccount: vi.fn(() => false),
  maskAnonymizedUser: vi.fn((user: any) => user),
  maskBookingForAnonymizedParties: vi.fn((booking: any) => booking),
  maskCancellationRequestForAnonymizedParties: vi.fn((request: any) => request),
  maskWarrantyClaimForAnonymizedParties: vi.fn((claim: any) => claim),
}));
vi.mock('../../../utils/requestParams', () => ({}));
vi.mock('../../../utils/notifications/notify', () => ({ notify: vi.fn() }));

import { buildDisputeFilter } from '../../../handlers/Admin/disputeManagement';

describe('admin dispute overview filter (client bug list #7)', () => {
  it('lists only dispute-status bookings in the default overview', () => {
    expect(buildDisputeFilter(undefined)).toMatchObject({
      status: 'dispute',
      'dispute.raisedAt': { $exists: true },
    });
  });

  it('lists only dispute-status bookings in the open view', () => {
    const filter = buildDisputeFilter('open') as Record<string, unknown>;
    expect(filter.status).toBe('dispute');
    expect(filter['dispute.resolvedAt']).toBeNull();
  });

  it('keeps the resolved view as history of settled disputes', () => {
    const filter = buildDisputeFilter('resolved') as Record<string, unknown>;
    expect(filter['dispute.raisedAt']).toEqual({ $exists: true });
    expect(filter['dispute.resolvedAt']).toEqual({ $ne: null });
  });
});
