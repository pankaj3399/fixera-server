import type { IQuoteCustomerTotals, IQuoteVersion } from '../../models/booking';
import { calculateVatFromPricingLines } from '../vatLineCalculation';
import { commissionedQuoteAmount } from '../customerPricing';

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const finite = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Customer amounts exactly as the existing checkout calculation would see the
 * quote at submit/edit time: professional total plus the commission currently
 * stored in PlatformSettings, then VAT allocated across the recorded pricing
 * lines by the same `calculateVatFromPricingLines` helper checkout uses.
 *
 * This is a quote-time snapshot, not a settlement. Later discounts, points,
 * loyalty changes, VAT configuration changes or commission changes never alter
 * it, and it is never used to change what is charged.
 */
export const buildQuoteCustomerTotals = (params: {
  booking: any;
  totalAmount: number;
  pricingLines?: Array<{ description?: string; price: number; vatRate: number; vatCountry?: string; vatLabel?: string }>;
  commissionPercent: number;
  currency: string;
  recordedAt?: Date;
}): IQuoteCustomerTotals | null => {
  const professionalNetAmount = finite(params.totalAmount);
  if (professionalNetAmount == null || professionalNetAmount < 0) return null;

  const customerNetAmount = roundMoney(
    commissionedQuoteAmount(professionalNetAmount, params.booking?.checkoutSnapshot, params.commissionPercent),
  );

  const pricingLines = Array.isArray(params.pricingLines)
    ? params.pricingLines.filter((line) => finite(line?.price) != null && finite(line?.vatRate) != null)
    : [];
  const originalLineNet = roundMoney(
    pricingLines.reduce((sum, line) => sum + Number(line.price), 0),
  );
  // `createPaymentIntent` only discounts line VAT when the customer amount is
  // not larger than the recorded line net; otherwise VAT is calculated on the
  // recorded lines and commission is added on top of net. Mirror that exact
  // existing calculation rather than inventing a commission-inclusive VAT base.
  const vatCalculation = pricingLines.length > 0
    ? calculateVatFromPricingLines(
        pricingLines.map((line) => ({
          description: line.description,
          price: Number(line.price),
          vatRate: Number(line.vatRate),
          vatCountry: line.vatCountry,
          vatLabel: line.vatLabel,
        })),
        customerNetAmount <= originalLineNet ? customerNetAmount : undefined,
      )
    : null;

  const totals: IQuoteCustomerTotals = {
    commissionPercent: Math.max(0, finite(params.commissionPercent) ?? 0),
    professionalNetAmount,
    customerNetAmount,
    amountBeforeDiscounts: customerNetAmount,
    currency: params.currency || 'EUR',
    recordedAt: params.recordedAt || new Date(),
  };
  if (vatCalculation) {
    totals.vatAmount = vatCalculation.vatAmount;
    totals.vatRate = vatCalculation.vatRate;
    totals.totalWithVat = roundMoney(customerNetAmount + vatCalculation.vatAmount);
    totals.totalAmount = totals.totalWithVat;
  }
  return totals;
};

export const quoteServiceLocationSnapshot = (booking: any): IQuoteVersion['serviceLocation'] | undefined => {
  const location = booking?.location;
  if (!location) return undefined;
  const snapshot: NonNullable<IQuoteVersion['serviceLocation']> = {};
  if (typeof location.country === 'string' && location.country) snapshot.country = location.country;
  if (typeof location.address === 'string' && location.address) snapshot.address = location.address;
  if (typeof location.city === 'string' && location.city) snapshot.city = location.city;
  if (typeof location.postalCode === 'string' && location.postalCode) snapshot.postalCode = location.postalCode;
  if (Array.isArray(location.coordinates) && location.coordinates.length === 2) {
    snapshot.coordinates = location.coordinates;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
};

/** Only versions with a real recorded version number can be accepted. */
export const resolveAcceptedQuoteVersion = (booking: any): {
  version: number;
  quotationNumber: string;
  source: 'recorded' | 'inferred_current' | 'not_recorded';
  acceptedAt: Date | null;
} | null => {
  const versions = Array.isArray(booking?.quoteVersions) ? booking.quoteVersions : [];
  if (versions.length === 0) return null;

  const recordedVersion = finite(booking?.acceptedQuoteVersion);
  if (recordedVersion != null) {
    const version = versions.find((entry: any) => Number(entry.version) === recordedVersion);
    if (version) {
      return {
        version: Number(version.version),
        quotationNumber: booking?.acceptedQuotationNumber || version.quotationNumber,
        source: 'recorded',
        acceptedAt: findStatusTime(booking, 'quote_accepted'),
      };
    }
  }

  const acceptedStatuses = [
    'quote_accepted',
    'payment_pending',
    'booked',
    'rescheduling_requested',
    'in_progress',
    'professional_completed',
    'completed',
    'dispute',
    'refunded',
  ];
  if (!acceptedStatuses.includes(String(booking?.status))) return null;

  // A cancelled/refunded booking must not turn an unaccepted, rejected quote
  // into an accepted one through the status fallback.
  const lastQuotationLifecycle = [...(Array.isArray(booking?.statusHistory) ? booking.statusHistory : [])]
    .reverse()
    .find((entry: any) =>
      ['quoted', 'draft_quote', 'quote_accepted', 'quote_rejected'].includes(String(entry?.status)),
    );
  if (lastQuotationLifecycle?.status === 'quote_rejected') return null;

  const currentVersion = finite(booking?.currentQuoteVersion);
  const current = versions.find((entry: any) => Number(entry.version) === currentVersion)
    || versions[versions.length - 1];
  if (!current) return null;
  if (current.rejectedAt) return null;
  return {
    version: Number(current.version),
    quotationNumber: current.quotationNumber,
    source: 'inferred_current',
    acceptedAt: findStatusTime(booking, 'quote_accepted'),
  };
};

export const findStatusTime = (booking: any, status: string): Date | null => {
  const entry = [...(Array.isArray(booking?.statusHistory) ? booking.statusHistory : [])]
    .reverse()
    .find((item: any) => item?.status === status && item?.timestamp);
  return entry?.timestamp ? new Date(entry.timestamp) : null;
};
