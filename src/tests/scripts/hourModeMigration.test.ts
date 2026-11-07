import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
const mocks = vi.hoisted(() => ({ users: vi.fn(), bookings: vi.fn(), update: vi.fn(), collisions: vi.fn(),
  replace: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), session: vi.fn() }));
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));
vi.mock('mongoose', async importOriginal => {
  const actual = await importOriginal<typeof import('mongoose')>();
  return { ...actual, default: { ...actual.default, connect: mocks.connect, disconnect: mocks.disconnect, startSession: mocks.session } };
});
vi.mock('../../models/user', () => ({ default: { find: mocks.users, findById: () => ({ select: () => ({ lean: async () => ({ businessInfo: { timezone: 'Europe/Brussels', country: 'BE' } }) }) }) } }));
vi.mock('../../models/booking', () => ({ default: { find: mocks.bookings, updateOne: mocks.update } }));
vi.mock('../../models/calendarReservation', () => ({ default: { find: mocks.collisions } }));
vi.mock('../../utils/support/bookingCalendar', () => ({ replaceBookingCalendar: mocks.replace }));
import { main } from '../../scripts/migrate/migrateHourModeScheduleTimeZones';

// All persistence and connection calls are fakes. Never run this migration against a database.
describe('hour-mode migration safety', () => {
  let oldArgs: string[], oldUri: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks(); oldArgs = process.argv; oldUri = process.env.MONGO_URI;
    process.env.MONGO_URI = 'mongodb://unused.invalid/test';
    mocks.users.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    mocks.collisions.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    mocks.update.mockResolvedValue({ modifiedCount: 1 });
    mocks.replace.mockResolvedValue(undefined);
  });
  afterEach(() => { process.argv = oldArgs; if (oldUri === undefined) delete process.env.MONGO_URI; else process.env.MONGO_URI = oldUri; });
  it('disconnects once when a post-connect read fails', async () => {
    mocks.users.mockImplementation(() => { throw new Error('read failed'); });
    await expect(main()).rejects.toThrow('read failed');
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
  const candidate = (status: string) => ({ _id: new Types.ObjectId(), professional: new Types.ObjectId(), status,
    scheduledStartDate: new Date('2026-11-05T14:00:00Z'), scheduledExecutionEndDate: new Date('2026-11-05T16:00:00Z'),
    scheduledStartTime: '14:00', scheduledEndTime: '16:00', scheduleTimeZone: 'UTC' });
  const rows = (status: string) => mocks.bookings.mockReturnValue({ select: () => ({ lean: async () => [candidate(status)] }) });

  it.each(['completed', 'cancelled', 'refunded'])('repairs terminal %s dates without collision checks or calendar reservations', async status => {
    rows(status);
    await main(true);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status, scheduleTimeZone: 'UTC' }),
      expect.objectContaining({ $set: expect.objectContaining({ scheduleTimeZone: 'Europe/Brussels' }) }), undefined);
    expect(mocks.collisions).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it.each([false, true])('uses one transaction for live schedule and calendar writes (replacement fails: %s)', async fail => {
    rows('booked');
    const session = { withTransaction: vi.fn(async callback => callback()), endSession: vi.fn() };
    mocks.session.mockResolvedValue(session);
    if (fail) mocks.replace.mockRejectedValueOnce(new Error('reservation failed'));
    if (fail) await expect(main(true)).rejects.toThrow('reservation failed');
    else await main(true);
    expect(session.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.update.mock.calls[0][2]).toEqual({ session });
    expect(mocks.replace.mock.calls[0][1]).toBe(session);
    expect(session.endSession).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('does not rebuild the calendar after a concurrent repair or reschedule', async () => {
    rows('booked'); mocks.update.mockResolvedValueOnce({ modifiedCount: 0 });
    mocks.session.mockResolvedValue({ withTransaction: async callback => callback(), endSession: vi.fn() });
    await main(true);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

});
