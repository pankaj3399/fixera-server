import Payment from '../models/payment';
import {
  basePaymentRowDefaults,
  basePaymentRowFilter,
} from './paymentRefunds';

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * Load every Payment row that represents the booking-level charge. A legacy
 * row may omit `milestoneIndex`; a milestone row has a numeric index. Rows for
 * another PaymentIntent (milestones/extra-cost) are excluded.
 */
export const loadBasePaymentRows = async (
  booking: any,
  paymentIntentId?: string | null,
): Promise<any[]> => {
  if (!booking?._id) return [];
  const rows = await Payment.find({ booking: booking._id })
    .select('_id booking milestoneIndex stripePaymentIntentId currency refunds status')
    .lean();
  const intent = str(paymentIntentId) || str(booking?.payment?.stripePaymentIntentId);
  return (rows as any[]).filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (row.milestoneIndex !== null && row.milestoneIndex !== undefined
      && Number.isFinite(Number(row.milestoneIndex))) return false;
    return true;
  }).filter((row) => {
    if (!intent) return true;
    const rowIntent = str(row.stripePaymentIntentId);
    // Legacy base rows can predate the intent id. A missing id is still the
    // base row only when it is not a milestone row (already filtered above).
    return !rowIntent || rowIntent === intent;
  });
};

/**
 * Push one actual refund fact onto the booking-level Payment row, creating the
 * row from the recorded booking payment facts when it does not exist.
 *
 * Idempotent by provider refund id. The unique base-payment index can race a
 * concurrent webhook/completion writer; a duplicate-key retry then re-checks
 * the same refund id instead of failing the refund that Stripe already made.
 */
/**
 * Refresh one recorded provider refund's status (for a pending refund that the
 * provider later settled or failed). Idempotent; only the status field changes.
 */
export const updateBasePaymentRefundStatus = async (
  booking: any,
  refundId: string,
  status: string,
): Promise<boolean> => {
  const id = str(refundId);
  if (!id || !str(status)) return false;
  const result = await Payment.updateOne(
    { ...basePaymentRowFilter(booking), 'refunds.refundId': id },
    { $set: { 'refunds.$.status': status } },
  );
  return result.matchedCount > 0;
};

export const recordBasePaymentRefund = async (params: {
  booking: any;
  refund: Record<string, any>;
  set?: Record<string, any>;
}): Promise<boolean> => {
  const { booking, refund } = params;
  const refundId = str(refund?.refundId);
  const baseFilter: Record<string, any> = basePaymentRowFilter(booking);
  const setFields: Record<string, any> = { ...(params.set || {}) };

  const makeFilter = () => {
    const filter: Record<string, any> = { ...baseFilter };
    if (refundId) filter['refunds.refundId'] = { $ne: refundId };
    return filter;
  };
  const makeUpdate = () => {
    const setOnInsert = basePaymentRowDefaults(booking);
    for (const key of Object.keys(setFields)) delete setOnInsert[key];
    const update: Record<string, any> = {
      $setOnInsert: setOnInsert,
      $push: { refunds: refund },
    };
    if (Object.keys(setFields).length > 0) update.$set = setFields;
    return update;
  };

  try {
    const updated = await Payment.findOneAndUpdate(makeFilter(), makeUpdate(), { upsert: true });
    return Boolean(updated);
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    // The base row was created concurrently (or already contains this refund).
    // Retry against the existing row without upserting a duplicate base row.
    const retry = await Payment.findOneAndUpdate(
      makeFilter(),
      {
        $push: { refunds: refund },
        ...(Object.keys(setFields).length > 0 ? { $set: setFields } : {}),
      },
      { upsert: false },
    );
    return Boolean(retry);
  }
};
