export const addBusinessDays = (start: Date, days: number): Date => {
  const result = new Date(start.getTime());
  let added = 0;
  while (added < days) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) {
      added += 1;
    }
  }
  return result;
};

export const REFUND_RESPONSE_BUSINESS_DAYS = 5;
