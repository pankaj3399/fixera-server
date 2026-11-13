import { describe, expect, it, vi } from 'vitest';

// FT3 #12: professionals spend points on level progress. A non-numeric or
// fractional amount must be rejected before any ledger work (NaN used to
// pass `!x || x <= 0` and reach applyPointsBoost).
const applyPointsBoost = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/professionalLevelSystem', () => ({ applyPointsBoost, calculateProfessionalLevel: vi.fn() }));
vi.mock('../../../models/user', () => ({ default: { findById } }));

import { boostProfessionalLevel } from '../../../handlers/User/loyaltyManagement';

const res = () => {
  const r: any = { statusCode: 200 };
  r.status = vi.fn((code: number) => { r.statusCode = code; return r; });
  r.json = vi.fn((body: unknown) => { r.body = body; return r; });
  return r;
};

describe('professional points boost validation', () => {
  it.each(['abc', 0, -100, 12.5, null, '1e400'])('rejects %p without touching the ledger', async (value) => {
    const r = res();
    await boostProfessionalLevel({ user: { _id: 'pro' }, body: { pointsToSpend: value } } as any, r, vi.fn());
    expect(r.statusCode).toBe(400);
    expect(applyPointsBoost).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it('accepts a whole positive amount, also sent as a numeric string', async () => {
    findById.mockReturnValue({ select: async () => ({ role: 'professional' }) });
    applyPointsBoost.mockResolvedValue({ boostedBookings: 2, newLevel: 'Expert', levelChanged: false, leveledUp: false });
    const r = res();
    await boostProfessionalLevel({ user: { _id: 'pro' }, body: { pointsToSpend: '200' } } as any, r, vi.fn());
    expect(r.statusCode).toBe(200);
    expect(applyPointsBoost).toHaveBeenCalledWith('pro', 200);
  });

  it('never calls a downward recalculation an upgrade', async () => {
    findById.mockReturnValue({ select: async () => ({ role: 'professional' }) });
    applyPointsBoost.mockResolvedValue({ boostedBookings: 1, newLevel: 'New', levelChanged: true, leveledUp: false });
    const r = res();
    await boostProfessionalLevel({ user: { _id: 'pro' }, body: { pointsToSpend: 100 } } as any, r, vi.fn());
    expect(r.body.msg).not.toMatch(/upgraded/i);
  });
});
