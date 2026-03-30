import type { IBooking } from "../models/booking";

export interface WarrantyDuration {
  value: number;
  unit: "months" | "years";
}

export const normalizeWarrantyDuration = (
  raw: unknown
): WarrantyDuration | null => {
  if (!raw || typeof raw !== "object") return null;
  const valueRaw = (raw as { value?: unknown }).value;
  const unitRaw = (raw as { unit?: unknown }).unit;
  const value =
    typeof valueRaw === "number"
      ? valueRaw
      : typeof valueRaw === "string"
      ? Number.parseFloat(valueRaw)
      : Number.NaN;

  if (!Number.isFinite(value) || value <= 0) return null;
  if (unitRaw !== "months" && unitRaw !== "years") return null;

  return {
    value,
    unit: unitRaw,
  };
};

export const addWarrantyDuration = (
  startDate: Date,
  duration: WarrantyDuration
): Date => {
  const end = new Date(startDate);
  const roundedValue = Math.round(duration.value);
  if (roundedValue <= 0) return end;

  if (duration.unit === "years") {
    end.setFullYear(end.getFullYear() + roundedValue);
  } else {
    end.setMonth(end.getMonth() + roundedValue);
  }
  return end;
};

export const getBookingWarrantyDuration = (
  booking: Pick<IBooking, "warrantyCoverage" | "quoteVersions" | "currentQuoteVersion">
): WarrantyDuration | null => {
  const fromCoverage = normalizeWarrantyDuration(
    booking.warrantyCoverage?.duration
  );
  if (fromCoverage) return fromCoverage;

  const versions = Array.isArray(booking.quoteVersions) ? booking.quoteVersions : [];
  if (versions.length === 0) return null;

  if (typeof booking.currentQuoteVersion === "number") {
    const current = versions.find(
      (version) => version.version === booking.currentQuoteVersion
    );
    const fromCurrent = normalizeWarrantyDuration(current?.warrantyDuration);
    if (fromCurrent) return fromCurrent;
  }

  return normalizeWarrantyDuration(versions[0]?.warrantyDuration);
};

export const getBookingWarrantyEndDate = (
  booking: Pick<IBooking, "warrantyCoverage" | "actualEndDate" | "updatedAt" | "createdAt">,
  duration: WarrantyDuration
): Date | null => {
  if (booking.warrantyCoverage?.endsAt instanceof Date) {
    return booking.warrantyCoverage.endsAt;
  }
  const start = booking.warrantyCoverage?.startsAt || booking.actualEndDate || booking.updatedAt || booking.createdAt;
  if (!(start instanceof Date)) return null;
  return addWarrantyDuration(start, duration);
};
