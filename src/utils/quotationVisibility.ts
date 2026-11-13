import type { InvoiceViewerRole } from './invoiceVisibility';

/** Depth bound for the customer-view walk. Real payloads are shallow; deeper subtrees are withheld. */
export const CUSTOMER_VIEW_MAX_DEPTH = 40;

export type ViewerPricingMode = 'customer' | 'commission-only';

/**
 * Professional-side amounts, withheld from customer and anonymous viewers. A
 * rule with `within` matches only when the object path ends with those keys
 * (array indices are not part of the path). Customer-side amounts such as
 * `customerTotals.customerNetAmount`, `payment.amount` and VAT stay visible.
 */
const PROFESSIONAL_AMOUNT_RULES: ReadonlyArray<{ key: string; within?: readonly string[] }> = [
  { key: 'professionalNetAmount' },
  { key: 'totalAmountProfessional' },
  { key: 'totalProfessionalAmount' },
  { key: 'professionalAmount' },
  { key: 'professionalPayout' },
  { key: 'extraCostProfessionalPayout' },
  { key: 'extraCostNetAmount' },
  { key: 'bookedPrice' },
  { key: 'extraCostTotal' },
  // Booking overview: extraCosts.total is the professional amount (customerTotal stays).
  { key: 'total', within: ['extraCosts'] },
  // Base (pre-commission) prices carried by quote, versions, checkout, extra costs and milestones.
  { key: 'amount', within: ['quote'] },
  { key: 'totalAmount', within: ['quoteVersions'] },
  { key: 'totalAmount', within: ['versions'] },
  { key: 'price', within: ['pricingLines'] },
  { key: 'unitPrice', within: ['breakdown'] },
  { key: 'totalPrice', within: ['breakdown'] },
  { key: 'unitPrice', within: ['selectedOptions'] },
  { key: 'totalPrice', within: ['selectedOptions'] },
  { key: 'unitAmount', within: ['checkoutSnapshot'] },
  { key: 'baseSubtotal', within: ['checkoutSnapshot'] },
  { key: 'extraOptionsTotal', within: ['checkoutSnapshot'] },
  { key: 'totalAmount', within: ['checkoutSnapshot'] },
  { key: 'unitAmount', within: ['checkout'] },
  { key: 'baseSubtotal', within: ['checkout'] },
  { key: 'extraOptionsTotal', within: ['checkout'] },
  { key: 'totalAmount', within: ['checkout'] },
  // Terms carry a professional add-on cost; customers get customerAdditionalCost instead.
  { key: 'additionalCost' },
  { key: 'unitPrice', within: ['extraCosts'] },
  { key: 'amount', within: ['extraCosts'] },
  { key: 'unitPrice', within: ['items'] },
  { key: 'totalPrice', within: ['items'] },
  // Activity events carry the recorded quote amounts under `amounts`.
  { key: 'amount', within: ['amounts'] },
  { key: 'totalAmount', within: ['amounts'] },
  { key: 'amount', within: ['milestonePayments'] },
  { key: 'amount', within: ['milestones'] },
  // Public project pricing (subprojects[].pricing, extraOptions[]).
  { key: 'amount', within: ['pricing'] },
  { key: 'priceRange', within: ['pricing'] },
  { key: 'price', within: ['extraOptions'] },
];

/**
 * Commission amounts and commission reductions: withheld from everyone except
 * professionals and payments-authorized admins. Keys are matched exactly, so
 * every commission-derived amount the code emits needs its own entry here.
 * `commissionReduction` and `referredProfessionalCommissionReduction` are
 * percentage points off the rate, so they count as rate disclosure.
 */
const COMMISSION_AMOUNT_RULES: ReadonlyArray<{ key: string; within?: readonly string[] }> = [
  { key: 'platformCommission' },
  { key: 'platformCommissionAmount' },
  { key: 'platformCommissionOnBase' },
  { key: 'extraCostPlatformCommission' },
  { key: 'extraCostPlatformFee' },
  { key: 'platformFeeAmount' },
  { key: 'commissionReduction' },
  { key: 'referredProfessionalCommissionReduction' },
];

const pathEndsWith = (path: readonly string[], suffix: readonly string[]): boolean => path.length >= suffix.length
  && suffix.every((segment, index) => path[path.length - suffix.length + index] === segment);

const matchesRule = (rules: ReadonlyArray<{ key: string; within?: readonly string[] }>, key: string, path: readonly string[]) =>
  rules.some((rule) => rule.key === key && (!rule.within || pathEndsWith(path, rule.within)));

const isCommissionPercentKey = (key: string): boolean => {
  const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
  return normalized.includes('commission') && /percent|pct|rate/.test(normalized);
};

/** `path` holds the object keys above `key`. */
const isWithheld = (key: string, path: readonly string[], mode: ViewerPricingMode): boolean => {
  if (isCommissionPercentKey(key)) return true;
  if (matchesRule(COMMISSION_AMOUNT_RULES, key, path)) return true;
  return mode === 'customer' && matchesRule(PROFESSIONAL_AMOUNT_RULES, key, path);
};

/** Activity event types whose `amounts` are customer-side money (refunds paid to the customer). */
const CUSTOMER_SIDE_EVENT_TYPES: ReadonlySet<string> = new Set(['refund_issued', 'refund_pending']);
const CUSTOMER_SIDE_AMOUNTS = '__customerSideAmounts';

const isCustomerSideEvent = (value: object): boolean => CUSTOMER_SIDE_EVENT_TYPES.has(String((value as { type?: unknown }).type));

const isLeaf = (value: object): boolean => value instanceof Date
  || Buffer.isBuffer(value)
  || typeof (value as { _bsontype?: unknown })._bsontype === 'string';

/**
 * Customer-view walk over the JSON form that `res.json` serializes. Objects
 * with `toJSON` (Mongoose documents) are read through it, as JSON.stringify
 * would. Plain objects, arrays and class instances without `toJSON` keep only
 * their own enumerable keys, which is what JSON serialization keeps too. The
 * source is never mutated, and an unchanged subtree is returned by reference.
 * A back-edge (cycle) or a subtree deeper than CUSTOMER_VIEW_MAX_DEPTH is
 * withheld rather than traversed.
 */
const customerView = (value: unknown, path: readonly string[], ancestors: readonly object[], mode: ViewerPricingMode): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (isLeaf(value as object)) return value;
  if (ancestors.length >= CUSTOMER_VIEW_MAX_DEPTH || ancestors.includes(value as object)) return undefined;
  const source: any = typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (source === null || typeof source !== 'object' || isLeaf(source)) return source;
  const nextAncestors = [...ancestors, value as object];
  if (Array.isArray(source)) {
    let changed = source !== value;
    const out = source.map((item) => {
      const next = customerView(item, path, nextAncestors, mode);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : source;
  }
  let changed = source !== value;
  const out: Record<string, unknown> = {};
  // A refund event's `amounts` is customer-side money. Its subtree is walked under a path segment that the
  // professional amount rules (`within: ['amounts']`) cannot match. Commission rules still apply to it.
  const customerSideAmounts = mode === 'customer' && isCustomerSideEvent(source);
  for (const key of Object.keys(source)) {
    const child = source[key];
    if (isWithheld(key, path, mode)) {
      changed = true;
      continue;
    }
    const childPath = customerSideAmounts && key === 'amounts' ? [...path, CUSTOMER_SIDE_AMOUNTS] : [...path, key];
    const next = customerView(child, childPath, nextAncestors, mode);
    if (next !== child) changed = true;
    out[key] = next;
  }
  return changed ? out : source;
};

/**
 * Withholds professional-side and commission amounts for a viewer.
 * - professional (own data) and payments-authorized admins: unchanged.
 * - `commission-only`: an admin without payments read; commission amounts go, professional amounts stay.
 * - customer or anonymous (`role: 'customer'`): professional-side amounts and commission amounts go.
 * Amounts remain as recorded; use `customerTotals` and the explicit customer* fields for customer-side money.
 */
export const quotationForViewer = <T>(
  value: T,
  role: InvoiceViewerRole,
  canReadPayments = true,
): T => {
  if (role === 'professional' || (role === 'admin' && canReadPayments)) return value;
  const mode: ViewerPricingMode = role === 'admin' ? 'commission-only' : 'customer';
  return customerView(value, [], [], mode) as T;
};

/** Explicit viewer-mode withholding, for public handlers whose viewer may be a non-owner professional. */
export const withholdPricingForMode = <T>(value: T, mode: ViewerPricingMode): T =>
  customerView(value, [], [], mode) as T;

/** Only the existing public badge presets belong in the participant DTO. */
export const publicProfessionalTags = (tags: unknown): string[] => Array.isArray(tags)
  ? tags.filter((tag): tag is string => typeof tag === 'string' && ['verified', 'our choice'].includes(tag.toLowerCase()))
  : [];
