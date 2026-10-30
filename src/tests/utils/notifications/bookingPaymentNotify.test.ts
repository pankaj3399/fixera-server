import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lean: vi.fn(), notify: vi.fn() }));
vi.mock('../../../models/booking', () => ({ default: { findById: () => ({ select: () => ({ populate: () => ({ populate: () => ({ lean: mocks.lean }) }) }) }) } }));
vi.mock('../../../models/user', () => ({ default: {} }));
vi.mock('../../../utils/notifications/notify', () => ({ notify: mocks.notify }));
import { notifyBookingPaymentConfirmed } from '../../../utils/notifications/bookingPaymentNotify';
describe('paid booking notification retries', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.lean.mockResolvedValue({ customer: { _id: 'customer', name: 'Customer' }, professional: { _id: 'professional', name: 'Professional' } }); mocks.notify.mockResolvedValue({}); });
  it('uses stable per-booking keys and strict delivery across payment intent retries', async () => {
    await notifyBookingPaymentConfirmed({ bookingId: 'booking', paymentIntentId: 'pi_1' });
    await notifyBookingPaymentConfirmed({ bookingId: 'booking', paymentIntentId: 'pi_2' });
    expect(mocks.notify).toHaveBeenCalledTimes(4);
    expect(mocks.notify.mock.calls[1][0]).toMatchObject({eventKey:'professional.booking_created', idempotencyKey:'booking:booking:professional.booking_created', delivery:{strict:true}});
    expect(mocks.notify.mock.calls[3][0].idempotencyKey).toBe(mocks.notify.mock.calls[1][0].idempotencyKey);
  });
  it('surfaces delivery failure so webhook can retry and still attempts both recipients', async () => {
    mocks.notify.mockRejectedValueOnce(new Error('temporary database failure'));
    await expect(notifyBookingPaymentConfirmed({bookingId:'booking'})).rejects.toThrow('temporary database failure');
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });
  it('fails before dispatch if recipient lookup is incomplete', async () => {
    mocks.lean.mockResolvedValue({customer:{_id:'customer'}});
    await expect(notifyBookingPaymentConfirmed({bookingId:'booking'})).rejects.toThrow('missing notification recipient');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('prefers the recorded VAT-inclusive gross over a net amount passed by the caller', async () => {
    mocks.lean.mockResolvedValue({
      customer: { _id: 'customer', name: 'Customer' },
      professional: { _id: 'professional', name: 'Professional' },
      payment: { totalWithVat: 316.11, amount: 261.25, currency: 'EUR' },
    });
    await notifyBookingPaymentConfirmed({ bookingId: 'booking', amount: 261.25, currency: 'EUR' });
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    expect(mocks.notify.mock.calls[0][0].context).toMatchObject({ amount: 316.11, currency: 'EUR' });
    expect(mocks.notify.mock.calls[1][0].context).toMatchObject({ amount: 316.11, currency: 'EUR' });
  });
  it('falls through to the caller amount when the recorded gross is a legacy null', async () => {
    mocks.lean.mockResolvedValue({
      customer: { _id: 'customer', name: 'Customer' },
      professional: { _id: 'professional', name: 'Professional' },
      payment: { totalWithVat: null, amount: 261.25, currency: 'EUR' },
    });
    await notifyBookingPaymentConfirmed({ bookingId: 'booking', amount: 261.25, currency: 'EUR' });
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    expect(mocks.notify.mock.calls[0][0].context).toMatchObject({ amount: 261.25, currency: 'EUR' });
    expect(mocks.notify.mock.calls[1][0].context).toMatchObject({ amount: 261.25, currency: 'EUR' });
  });
});
