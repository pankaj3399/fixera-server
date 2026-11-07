/** Recorded-dispute evidence for the Part 3 dispute-only overview. */
type AnyRecord = Record<string, any>;

const asRecord = (value: unknown): AnyRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : null;

const present = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

export const hasRecordedDispute = (booking: unknown): boolean => {
  const dispute = asRecord(asRecord(booking)?.dispute);
  if (!dispute) return false;
  return present(dispute.raisedBy);
};

export const RECORDED_DISPUTE_FILTER = Object.freeze({
  "dispute.raisedAt": { $exists: true },
  "dispute.raisedBy": { $exists: true, $ne: null },
});
