import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
const mocks = vi.hoisted(() => ({ project: null as any, booking: null as any, validate: vi.fn(), window: vi.fn() }));
const customerId = new Types.ObjectId('507f1f77bcf86cd799439011');
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');
const projectId = new Types.ObjectId('507f1f77bcf86cd799439013');
vi.mock('../../../models/project', () => ({ default: { findById: () => ({ select: async () => mocks.project, then: (resolve: any) => Promise.resolve(mocks.project).then(resolve) }) } }));
vi.mock('../../../models/user', () => ({ default: { findById: (id: any) => {
  const doc = String(id) === String(customerId)
    ? { _id: customerId, role: 'customer', location: { coordinates: [4, 50], country: 'BE' } }
    : { _id: professionalId, role: 'professional', professionalStatus: 'approved', businessInfo: { country: 'BE' } };
  return { select: async () => doc, then: (resolve: any) => Promise.resolve(doc).then(resolve) };
} } }));
vi.mock('../../../models/booking', () => ({ default: { findById: async () => mocks.booking } }));
vi.mock('../../../services/stripe', () => ({ stripe: {}, STRIPE_CONFIG: { supportedCurrencies: [], defaultCurrency: 'EUR', environment: 'test' } }));
vi.mock('../../../utils/vatManagement', async importOriginal => ({ ...await importOriginal<any>(), resolveVatDecisionFromConfig: async () => ({ rate: 21, standardRate: 21 }) }));
vi.mock('../../../utils/scheduleEngine', async importOriginal => ({ ...await importOriginal<any>(), validateProjectScheduleSelection: mocks.validate, buildProjectScheduleWindow: mocks.window }));
import { createBooking } from '../../../handlers/Booking';
import { buildScheduleUpdatePayload } from '../../../handlers/Booking/payment-integration';
import { resolveDispute } from '../../../handlers/Admin/disputeManagement';

const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
describe('booking schedule snapshot consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.project = { _id: projectId, status: 'published', professionalId, distance: { countryCode: 'BE' }, resources: [professionalId], extraOptions: [],
      subprojects: [{ pricing: { type: 'unit', amount: 10, unit: 'm2', minOrderQuantity: 1, durationBasis: 'per_unit' }, executionDuration: { value: 99, unit: 'days' } }] };
    mocks.booking = { _id: new Types.ObjectId(), project: projectId, selectedSubprojectIndex: 0, customerBlocks: {},
      scheduleSnapshot: { quantity: 6, executionDuration: { value: 12, unit: 'days' } }, status: 'disputed', dispute: { type: 'reschedule', raisedAt: new Date() } };
    mocks.validate.mockResolvedValue({ valid: true });
    mocks.window.mockResolvedValue({ scheduledStartDate: new Date('2027-01-10'), scheduledExecutionEndDate: new Date('2027-01-22') });
  });

  it('rejects missing, array and malformed unit quantities without checkout or a start date', async () => {
    for (const quantity of [undefined, ['2'], true, '', 'Infinity', -1]) {
      const res = response();
      await createBooking({ user: { _id: customerId }, body: { bookingType: 'project', projectId: String(projectId), rfqData: { serviceType: 'Painting', description: 'Walls' }, estimatedUsage: quantity } } as any, res as any, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocks.window).not.toHaveBeenCalled();
    }
  });

  it('uses identical frozen quantity and duration in normal reschedule validation and window', async () => {
    const result = await buildScheduleUpdatePayload({ booking: mocks.booking, scheduledStartDate: '2027-01-10' });
    expect(result.success).toBe(true);
    const expected = { quantity: 6, durationOverride: { execution: { value: 12, unit: 'days' }, preparation: { value: 0, unit: 'hours' }, buffer: { value: 0, unit: 'hours' } } };
    expect(mocks.validate).toHaveBeenCalledWith(expect.objectContaining(expected));
    expect(mocks.window).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it('passes the frozen snapshot through admin dispute rescheduling', async () => {
    mocks.window.mockResolvedValue(null); // Stop at the real window boundary before any writes/providers.
    const res = response();
    await resolveDispute({ params: { bookingId: String(mocks.booking._id) }, body: { action: 'accept_professional', resolution: 'Agreed move', forcedStartDate: '2027-01-10' }, user: { _id: professionalId } } as any, res as any);
    expect(mocks.window).toHaveBeenCalledWith(expect.objectContaining({ quantity: 6, durationOverride: expect.objectContaining({ execution: { value: 12, unit: 'days' } }) }));
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
