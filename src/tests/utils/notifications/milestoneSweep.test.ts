import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ find: vi.fn(), notify: vi.fn() }));
vi.mock('../../../utils/refundFinalization', () => ({ retryPendingRefundInvoices: vi.fn() }));
vi.mock('../../../models/booking', () => ({ default: { find: mocks.find } }));
vi.mock('../../../models/user', () => ({ default: {} }));
vi.mock('../../../models/cancellationRequest', () => ({ default: {} }));
vi.mock('../../../utils/notifications/notify', () => ({ notify: vi.fn() }));
vi.mock('../../../utils/notifications/milestonePaymentDue', () => ({ notifyMilestonePaymentDue: mocks.notify }));
vi.mock('../../../utils/notifications/processUnreadChatMirrors', () => ({ processUnreadChatMirrorReminders: vi.fn() }));
import { sweepMilestonePaymentDue } from '../../../utils/notifications/runNotificationReminders';

beforeEach(() => vi.clearAllMocks());
it('reaches candidates beyond page 200 in stable id order even after a per-booking error', async () => {
  const rows = Array.from({ length: 401 }, (_, index) => ({ _id: String(index).padStart(24, '0') }));
  const sorts: unknown[] = [];
  mocks.find.mockImplementation(filter => ({ select() { return this; }, sort(order) { sorts.push(order); return this; },
    limit: async count => rows.filter(row => !filter._id || row._id > filter._id.$gt).slice(0, count) }));
  mocks.notify.mockImplementation(async id => {
    if (id === rows[50]._id) throw new Error('delivery failed');
    return { notified: id === rows[400]._id };
  });
  const counts = { milestoneDue: 0, errors: [] as string[] };
  await sweepMilestonePaymentDue(counts);
  expect(mocks.notify).toHaveBeenCalledTimes(401);
  expect(mocks.notify).toHaveBeenLastCalledWith(rows[400]._id, { notifyProfessional: true });
  expect(counts.milestoneDue).toBe(1);
  expect(counts.errors).toEqual([expect.stringContaining(rows[50]._id)]);
  expect(sorts).toEqual(Array(4).fill({ _id: 1 }));
});
