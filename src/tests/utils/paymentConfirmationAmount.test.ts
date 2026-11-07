import { expect, it } from 'vitest';
import { paymentConfirmationAmount } from '../../utils/paymentConfirmationAmount';
it.each([
  [{ totalWithVat: 51, amount: 42 }, 51],
  [{ amount: 42 }, 42],
  [{ amount: 100, milestoneIndex: 0 }, 72],
  [{ totalWithVat: 61, amount: 100, milestoneIndex: 0 }, 61],
  [{ totalWithVat: NaN, amount: Infinity }, 72],
])('resolves confirmation amount with recorded/legacy/milestone precedence %s', (payment, expected) => {
  expect(paymentConfirmationAmount(payment, { amount: 7200, currency: 'eur' })).toBe(expected);
});
