import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { contextSnapshot, pushedStatusEntries, stampEntryActors } from '../../../utils/bookingEvents/archive';
import { currentRequestActor, runWithRequestActor } from '../../../utils/requestActor';

describe('booking event archive helpers', () => {
  it('snapshots only the context relevant to the new status', () => {
    const booking = {
      dispute: { reason: 'Late', description: 'x'.repeat(5000), raisedBy: new Types.ObjectId(), attachments: ['https://a/1.jpg', 7] },
      cancellation: { reason: 'Moved', refundAmount: 50 },
      customerRejectionReason: 'Too expensive',
    };
    const dispute = contextSnapshot(booking, 'dispute');
    expect((dispute.context as any).dispute.reason).toBe('Late');
    expect((dispute.context as any).dispute.description).toHaveLength(1000);
    expect(dispute.attachments).toEqual(['https://a/1.jpg']);
    expect(contextSnapshot(booking, 'cancelled').context).toEqual({ cancellation: { reason: 'Moved', refundAmount: 50 } });
    expect(contextSnapshot(booking, 'quote_rejected').context).toEqual({ quoteRejection: { reason: 'Too expensive' } });
    expect(contextSnapshot(booking, 'booked')).toEqual({ attachments: [] });
  });

  it('reads pushed statusHistory entries from single and $each pushes', () => {
    expect(pushedStatusEntries({ $push: { statusHistory: { status: 'booked' } } })).toEqual([{ status: 'booked' }]);
    expect(pushedStatusEntries({ $push: { statusHistory: { $each: [{ status: 'a' }, { status: 'b' }] } } })).toHaveLength(2);
    expect(pushedStatusEntries({ $set: { status: 'x' } })).toEqual([]);
  });

  it('stamps missing updatedBy only inside an authenticated request', () => {
    const user = { _id: new Types.ObjectId(), role: 'admin' };
    const outside = [{ status: 'booked' } as any];
    stampEntryActors(outside);
    expect(outside[0].updatedBy).toBeUndefined();
    runWithRequestActor(user, () => {
      expect(currentRequestActor()).toEqual({ userId: String(user._id), role: 'admin' });
      const named = new Types.ObjectId();
      const entries = [{ status: 'booked' } as any, { status: 'x', updatedBy: named } as any];
      stampEntryActors(entries);
      expect(String(entries[0].updatedBy)).toBe(String(user._id));
      expect(entries[1].updatedBy).toBe(named);
    });
    expect(currentRequestActor()).toBeUndefined();
  });
});
