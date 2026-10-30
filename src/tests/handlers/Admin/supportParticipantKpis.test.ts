import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  conversationFindById: vi.fn(),
  bookingAggregate: vi.fn(),
  userFindById: vi.fn(),
  projectCountDocuments: vi.fn(),
  adminAccess: { bookings: true, disputes: false, warranty: false, cancellations: false, payments: false },
}));

vi.mock('../../../models/conversation', () => ({
  default: { findById: mocks.conversationFindById },
}));

vi.mock('../../../models/booking', () => ({
  default: { aggregate: mocks.bookingAggregate },
}));

vi.mock('../../../models/user', () => ({
  default: { findById: mocks.userFindById },
}));

vi.mock('../../../models/project', () => ({
  default: { countDocuments: mocks.projectCountDocuments },
}));

vi.mock('../../../models/chatMessage', () => ({ default: {} }));
vi.mock('../../../models/chatReport', () => ({ default: {} }));

vi.mock('../../../utils/bookingDetails/adminAccess', () => ({
  resolveBookingAdminAccess: vi.fn(async () => mocks.adminAccess),
}));

vi.mock('../../../utils/support/settings', () => ({
  assertSupportChatEnabled: vi.fn(),
  assertSupportChatWriteAllowed: vi.fn(),
}));

import { adminGetConversationParticipant } from '../../../handlers/Admin/chatModeration';

const mockRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

describe('support participant financial gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn(async () => ({ _id: 'c1', type: 'support', supportTargetUserId: 'pro1' })) }),
    });
    mocks.userFindById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn(async () => ({ _id: 'pro1', name: 'Piet', role: 'professional', professionalLevel: 'Level 2' })),
      }),
    });
    mocks.bookingAggregate.mockResolvedValue([{
      bookingCount: 4,
      completedCount: 2,
      quotedCount: 1,
      disputeCount: 0,
      refundCount: 1,
      reviewCount: 2,
      avgRating: 4.5,
      grossEur: 3000,
      grossByCurrency: [
        { currency: 'EUR', gross: 1000 },
        { currency: 'USD', gross: 2000 },
      ],
    }]);
    mocks.projectCountDocuments.mockResolvedValue(3);
  });

  it('withholds gross and refund percent when the admin lacks payments access', async () => {
    mocks.adminAccess.payments = false;
    const res = mockRes();
    await adminGetConversationParticipant(
      { params: { id: '507f1f77bcf86cd799439011' }, admin: { _id: 'a1' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.kpis.financialAccess).toBe(false);
    expect(res.body.data.kpis.grossEur).toBeNull();
    expect(res.body.data.kpis.refundPercent).toBeNull();
    // Non-financial KPIs stay visible.
    expect(res.body.data.kpis.bookingCount).toBe(4);
    expect(res.body.data.kpis.completedCount).toBe(2);
  });

  it('reports multi-currency gross per currency, never as a EUR sum', async () => {
    mocks.adminAccess.payments = true;
    const res = mockRes();
    await adminGetConversationParticipant(
      { params: { id: '507f1f77bcf86cd799439011' }, admin: { _id: 'a1' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data.kpis.financialAccess).toBe(true);
    expect(res.body.data.kpis.grossEur).toBeNull();
    expect(res.body.data.kpis.grossByCurrency).toEqual([
      { currency: 'EUR', gross: 1000 },
      { currency: 'USD', gross: 2000 },
    ]);
    expect(res.body.data.kpis.refundPercent).toBe(25);
  });
});
