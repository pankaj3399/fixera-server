/** Historical settlement facts. Never extrapolate another milestone or use current pricing. */
const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;
const settledStatuses = new Set(['completed', 'partially_refunded', 'refunded']);
export const invoiceSettledPayments = (booking: any): any[] => {
  const rows = Array.isArray(booking.__settledPayments) ? booking.__settledPayments : [];
  const unique = new Map<string, any>();
  for (const row of rows) {
    if (!settledStatuses.has(row.status)) continue;
    unique.set(String(row.stripePaymentIntentId || row._id || `milestone:${row.milestoneIndex}`), row);
  }
  {
    for (const entry of booking.paymentDiscountLedger || []) {
      if (!entry.paymentIntentId || unique.has(String(entry.paymentIntentId))) continue;
      if (entry.totalWithVat == null || entry.netAmount == null || entry.vatAmount == null) continue;
      const snapshot = typeof entry.toObject === 'function' ? entry.toObject() : entry;
      unique.set(String(entry.paymentIntentId), { ...snapshot, stripePaymentIntentId: entry.paymentIntentId, status: 'completed' });
    }
  }
  // The booking snapshot is a fallback only; Payment rows are authoritative.
  const payment = booking.payment;
  if (!unique.size && payment && (settledStatuses.has(payment.status) || !payment.status)) {
    unique.set(String(payment.stripePaymentIntentId || 'legacy'), payment);
  }
  return [...unique.values()];
};

export const invoiceSettlementDiscount = (booking: any, rows: any[]): any => {
  const ledger = Array.isArray(booking.paymentDiscountLedger) ? booking.paymentDiscountLedger : [];
  const components = ['originalAmount', 'loyaltyAmount', 'repeatBuyerAmount', 'referralDiscountAmount',
    'pointsDiscountAmount', 'codeDiscountAmount', 'totalDiscount'];
  const result: Record<string, any> = Object.fromEntries(components.map(key => [key, 0]));
  for (const row of rows) {
    const snapshot = ledger.find((entry: any) => row.stripePaymentIntentId
      ? entry.paymentIntentId === row.stripePaymentIntentId
      : row.milestoneIndex != null && entry.milestoneIndex === row.milestoneIndex)
      || row.discount
      || (row.stripePaymentIntentId && row.stripePaymentIntentId === booking.payment?.stripePaymentIntentId ? booking.payment?.discount : undefined);
    for (const key of components) result[key] = money(result[key] + Number(snapshot?.[key] || 0));
    if (snapshot?.codeLabel) result.codeLabel = snapshot.codeLabel;
  }
  return result;
};

export const invoiceRefundFacts = (booking: any): Array<{ key: string; amount: number; netAmount?: number; vatAmount?: number; refundedAt?: Date }> => {
  const facts = new Map<string, any>();
  for (const payment of booking.__settledPayments || []) {
    (payment.refunds || []).forEach((refundDoc: any, index: number) => {
      const refund = typeof refundDoc.toObject === 'function' ? refundDoc.toObject() : refundDoc;
      if (refund.kind === 'extra_cost' || ['failed', 'canceled'].includes(refund.status)) return;
      const key = refund.refundId || `${payment.stripePaymentIntentId || payment._id}:${index}`;
      const amount = money(refund.amount);
      const paidNet = Number(payment.netAmount);
      const paidVat = Number(payment.vatAmount);
      const netAmount = refund.netAmount != null ? money(refund.netAmount)
        : Number.isFinite(paidNet + paidVat) && paidNet + paidVat > 0 ? money(amount * paidNet / (paidNet + paidVat)) : undefined;
      const vatAmount = refund.vatAmount != null ? money(refund.vatAmount)
        : netAmount != null ? money(amount - netAmount) : undefined;
      facts.set(key, { ...refund, key, amount, netAmount, vatAmount });
    });
  }
  if (!facts.size && Number(booking.payment?.refundAmount) > 0) {
    const amount = money(booking.payment.refundAmount);
    const key = `legacy:${booking.payment.stripePaymentIntentId || booking._id}:${amount.toFixed(2)}`;
    facts.set(key, { key, amount, refundedAt: booking.payment.refundedAt });
  }
  return [...facts.values()];
};

/** Preserve each settled VAT slice, including different historical rates. */
export const invoiceSettledServiceLines = (booking: any): Array<{ description: string; amount: number; vatRate: number; vatAmount: number; unitPrice?: number; quantity?: number; unit?: string }> =>
  invoiceSettledPayments(booking).flatMap((payment: any) => {
    const breakdown = payment.vatBreakdown?.length ? payment.vatBreakdown : [{
      description: `${payment.milestoneTitle || booking.quote?.description || 'Service'}${payment.milestoneIndex === 0 && booking.selectedExtraOptions?.length ? ' (Options included)' : ''}`,
      netAmount: payment.netAmount,
      vatAmount: payment.vatAmount,
      vatRate: payment.reverseCharge ? 0 : payment.vatRate ?? booking.payment?.vatRate ?? 0,
    }];
    return breakdown.map((line: any) => ({ description: line.description || 'Service',
      amount: Number(line.netAmount) || 0, vatRate: Number(line.vatRate) || 0, vatAmount: Number(line.vatAmount) || 0 }));
  });
