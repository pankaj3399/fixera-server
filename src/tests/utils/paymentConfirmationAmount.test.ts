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

it('labels the confirmation email amount as paid including VAT', async () => {
  const { buildPaymentConfirmedHtml } = await import('../../utils/emailService');
  const amount = paymentConfirmationAmount({ totalWithVat: 316.11, amount: 261.25 }, { amount: 31611, currency: 'eur' });
  const html = buildPaymentConfirmedHtml('Customer', 'Pro', amount, 'booking-1', 'EUR');
  expect(html).toContain('Amount paid (incl. VAT)');
  expect(html).not.toContain('Amount Paid');
  // The VAT-inclusive charge, not the net amount.
  expect(html).toContain('316.11');
  expect(html).not.toContain('261.25');
});
