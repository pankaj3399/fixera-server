import ServiceConfiguration, { IVatLogicCondition, IVatLogicRule } from "../models/serviceConfiguration";
import { validateVATNumberFormat } from "./vatValidation";
import {
  flowchartPlaceOfSupplyCountry,
  flowchartPropertyNature,
  flowchartReverseCharge,
  flowchartTierRateForCountry,
} from "./vatFlowchart";
import {
  ARTICLE_47_FIELD_NAME,
  B2B_SAME_AS_B2C_COUNTRIES,
  firstVatCountry,
  getStandardVatRate,
  normalizeArticle47Classification,
  parseVatCountryCode,
  REVERSE_CHARGE_LABEL,
  type Article47Classification,
} from "./vatCountries";
export {
  ARTICLE_47_FIELD_NAME,
  B2B_SAME_AS_B2C_COUNTRIES,
  firstVatCountry,
  getStandardVatRate,
  normalizeArticle47Classification,
  parseVatCountryCode,
  REVERSE_CHARGE_LABEL,
  STANDARD_RATES,
} from "./vatCountries";
export type { Article47Classification } from "./vatCountries";

export type VatRoutingAction = "standard_rate" | "reduced_rate" | "rfq";

export interface VatDecisionTraceStep {
  step: string;
  detail: string;
}

export interface VatDecision {
  action: VatRoutingAction;
  country: string;
  standardRate: number;
  appliedRate: number;
  reducedRate?: number;
  reverseCharge: boolean;
  vatLabel?: string;
  exemptFromBelgianReverseCharge?: boolean;
  /** Branch-for-branch flowchart trace (SSOT audit trail). */
  trace?: VatDecisionTraceStep[];
  explanation: string;
  matchedRuleText?: string;
  ruleGroup?: string;
  propertyNature?: PropertyNature;
}

export interface VatRateOption {
  rate: number;
  country: string;
  label: string;
  reverseCharge: boolean;
  source: "standard" | "reduced" | "b2b_exempt";
}

export type PropertyNature = "movable" | "immovable";

export const DEFAULT_ARTICLE_47_CLASSIFICATION = "immovable" as const;
export const ARTICLE_47_QUESTION =
  "Will the work be carried out on a fixed part of the property or on something that will become permanently fixed to the property? (Article 47)";

/** Legacy VAT configs may omit Article 47; default to immovable (matches admin UI). */
export const resolveArticle47Classification = (
  classification?: string | null
): import("./vatCountries").Article47Classification =>
  normalizeArticle47Classification(classification) ?? DEFAULT_ARTICLE_47_CLASSIFICATION;

export const normalizeVatCountry = (country?: string | null): string => parseVatCountryCode(country);

export const countryFromAddressComponents = (
  components?: Array<{ types?: string[]; short_name?: string; long_name?: string }> | null
): string => {
  if (!Array.isArray(components)) return "";
  const country = components.find((component) => component.types?.includes("country"));
  return parseVatCountryCode(country?.short_name || country?.long_name);
};

export const countryFromAddressText = (address?: string | null): string => {
  if (!address) return "";
  const parts = String(address)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const parsed = parseVatCountryCode(parts[i]);
    if (parsed) return parsed;
  }
  return "";
};

export const requiresVatRfqReview = (
  decision?: Pick<VatDecision, "action" | "reverseCharge"> | null
): boolean => decision?.action === "rfq" && !decision?.reverseCharge;

/** Parse rates entered with either a decimal point or a decimal comma. */
export const parseFlexibleNumber = (value: unknown): number => {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const raw = String(value ?? "").trim().replace(/\s/g, "");
  if (!raw) return Number.NaN;
  if (raw.includes(",") && !raw.includes(".") && /^\d+,\d{3}$/.test(raw)) {
    return Number.NaN;
  }
  const normalized = raw.includes(",")
    ? raw.includes(".") && raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, ".")
    : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export const isB2BSameAsB2CCountry = (country?: string | null): boolean =>
  B2B_SAME_AS_B2C_COUNTRIES.has(normalizeVatCountry(country));

const isTruthyAnswer = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "yes" || normalized === "true" || normalized === "1";
};

export const resolvePropertyNature = (params: {
  classification?: Article47Classification | string | null;
  professionalAnswers?: Record<string, unknown>;
}): PropertyNature | undefined => {
  const classification = normalizeArticle47Classification(params.classification);
  if (classification === "immovable") return "immovable";
  if (classification === "movable") return "movable";
  if (classification === "project_dependent") {
    const answer = params.professionalAnswers?.[ARTICLE_47_FIELD_NAME];
    if (answer === undefined || answer === null || String(answer).trim() === "") {
      return undefined;
    }
    return isTruthyAnswer(answer) ? "immovable" : "movable";
  }
  return undefined;
};

export const resolvePlaceOfSupplyCountry = (params: {
  customerType?: string;
  propertyNature?: PropertyNature | null;
  bookingCountry?: string | null;
  businessCountry?: string | null;
}): string => {
  // Customer-leg SSOT is owned by vatFlowchart; this wrapper preserves the
  // legacy signature for callers/tests.
  return flowchartPlaceOfSupplyCountry({
    leg: "customer",
    customerType: params.customerType,
    propertyNature: params.propertyNature,
    bookingCountry: params.bookingCountry,
    customerBusinessCountry: params.businessCountry,
  }).country;
};

/** Supplier-leg place of supply (professional -> platform). Movable uses the
 * professional business address per flowchart; immovable uses booking. */
export const resolveSupplierPlaceOfSupplyCountry = (params: {
  propertyNature?: PropertyNature | null;
  bookingCountry?: string | null;
  supplierBusinessCountry?: string | null;
}): string => {
  return flowchartPlaceOfSupplyCountry({
    leg: "supplier",
    propertyNature: params.propertyNature,
    bookingCountry: params.bookingCountry,
    supplierBusinessCountry: params.supplierBusinessCountry,
  }).country;
};

export type B2BInvoiceContext = {
  propertyNature?: PropertyNature | null;
  exemptFromBelgianReverseCharge?: boolean;
};

const coerceComparable = (value: unknown): string | number | boolean => {
  if (typeof value === "boolean" || typeof value === "number") return value;
  const raw = String(value ?? "").trim();
  if (/^(true|yes|y)$/i.test(raw)) return true;
  if (/^(false|no|n)$/i.test(raw)) return false;
  const parsed = parseFlexibleNumber(raw);
  return Number.isFinite(parsed) && raw !== "" ? parsed : raw.toLowerCase();
};

const compare = (condition: IVatLogicCondition, answers: Record<string, unknown>): boolean => {
  const actual = coerceComparable(answers[condition.fieldName]);
  const expected = coerceComparable(condition.value);

  switch (condition.operator) {
    case "equals":
      return actual === expected;
    case "not_equals":
      return actual !== expected;
    case "greater_than":
      return Number(actual) > Number(expected);
    case "greater_than_or_equal":
      return Number(actual) >= Number(expected);
    case "less_than":
      return Number(actual) < Number(expected);
    case "less_than_or_equal":
      return Number(actual) <= Number(expected);
    case "includes":
      return Array.isArray(answers[condition.fieldName])
        ? (answers[condition.fieldName] as unknown[]).map(coerceComparable).includes(expected)
        : String(actual).includes(String(expected));
    default:
      return false;
  }
};

export const evaluateVatRule = (rule: IVatLogicRule, answers: Record<string, unknown>): boolean => {
  if (!rule.conditions?.length) return true;
  return rule.conditions.reduce((result, condition, index) => {
    const conditionResult = compare(condition, answers);
    if (index === 0) return conditionResult;
    return condition.connector === "OR" ? result || conditionResult : result && conditionResult;
  }, true);
};

const hasVerifiedVatNumber = (vatNumber?: string | null, isVatVerified?: boolean): boolean =>
  Boolean(isVatVerified && vatNumber && validateVATNumberFormat(vatNumber));

export const applyB2BInvoiceRule = (
  decision: VatDecision,
  customerType?: string,
  vatNumber?: string | null,
  isVatVerified?: boolean,
  context?: B2BInvoiceContext
): VatDecision => {
  // Customer-leg reverse charge via flowchart SSOT (explicit branches, no
  // movable+B2B shortcut). Supplier country unknown on this path, so
  // cross-border branch falls through to verified-EU-B2B.
  const country = parseVatCountryCode(decision.country);
  if (!country) return decision;
  const propertyNature = context?.propertyNature || "movable";
  const { reverseCharge } = flowchartReverseCharge({
    buyerType: customerType,
    buyerVatNumber: vatNumber,
    buyerVatVerified: isVatVerified,
    buyerCountry: country,
    propertyNature,
    exemptFromBelgianReverseCharge: context?.exemptFromBelgianReverseCharge,
  });
  if (!reverseCharge) return decision;
  return {
    ...decision,
    appliedRate: 0,
    reverseCharge: true,
    vatLabel: REVERSE_CHARGE_LABEL,
    explanation: REVERSE_CHARGE_LABEL,
    propertyNature,
  };
};

/** Resolve VAT on the supplier's invoice to the platform buyer.
 * Supplier leg uses the flowchart SSOT independently from the customer leg:
 * movable -> professional business country, immovable -> booking country
 * (pass bookingCountry via buyerCountry fallback upstream when known).
 * Reverse charge follows the same explicit branches, with supplier/buyer
 * countries supplied (no movable+B2B shortcut). */
export const resolveSupplierB2BInvoiceDecision = (params: {
  supplierCountry?: string | null;
  buyerCountry?: string | null;
  supplierVatNumber?: string | null;
  buyerVatNumber?: string | null;
  buyerVatVerified?: boolean;
  bookingCountry?: string | null;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
}): VatDecision => {
  const supplierCountry = parseVatCountryCode(params.supplierCountry);
  // Flowchart supplier place-of-supply: movable -> supplier country,
  // immovable -> booking country. Callers that already resolved the country
  // pass it as buyerCountry (platform) for backward compat; prefer the
  // flowchart result when booking/supplier context is available.
  const flowCountry = flowchartPlaceOfSupplyCountry({
    leg: "supplier",
    propertyNature: params.propertyNature || "movable",
    bookingCountry: params.bookingCountry ?? params.buyerCountry,
    supplierBusinessCountry: params.supplierCountry,
  }).country;
  const buyerCountry = flowCountry || parseVatCountryCode(params.buyerCountry) || supplierCountry;
  const propertyNature = params.propertyNature || "movable";
  const standardRate = buyerCountry ? getStandardVatRate(buyerCountry) : 0;
  const decision: VatDecision = {
    action: "standard_rate",
    country: buyerCountry,
    standardRate,
    appliedRate: standardRate,
    reverseCharge: false,
    propertyNature,
    exemptFromBelgianReverseCharge: params.exemptFromBelgianReverseCharge,
    explanation: `Standard VAT rate ${standardRate}% applied to the supplier invoice.`,
  };

  const buyerVatValid = params.buyerVatVerified ?? Boolean(
    params.buyerVatNumber && validateVATNumberFormat(params.buyerVatNumber),
  );
  const rc = flowchartReverseCharge({
    buyerType: "business",
    buyerVatNumber: params.buyerVatNumber,
    buyerVatVerified: buyerVatValid,
    supplierCountry,
    supplierVatNumber: params.supplierVatNumber,
    buyerCountry,
    propertyNature,
    exemptFromBelgianReverseCharge: params.exemptFromBelgianReverseCharge,
  });
  const placeTrace = flowchartPlaceOfSupplyCountry({
    leg: "supplier",
    propertyNature,
    bookingCountry: params.bookingCountry ?? params.buyerCountry,
    supplierBusinessCountry: params.supplierCountry,
  }).trace;
  if (!rc.reverseCharge) return { ...decision, trace: [...placeTrace, ...rc.trace, { step: "rate", detail: `supplier standard ${standardRate}%` }] };
  return {
    ...decision,
    appliedRate: 0,
    reverseCharge: true,
    vatLabel: REVERSE_CHARGE_LABEL,
    explanation: REVERSE_CHARGE_LABEL,
    trace: [...placeTrace, ...rc.trace, { step: "rate", detail: "supplier reverse-charge 0%" }],
  };
};

/**
 * Supplier self-bill VAT decision that also honours the service configuration.
 *
 * `resolveSupplierB2BInvoiceDecision` deliberately only resolves the place of
 * supply and the country's *standard* rate. That is wrong for reduced-VAT
 * services: a BE renovation configured as 6% (building age + private housing)
 * was self-billed at 21%. This wrapper keeps the supplier-leg place of supply
 * (movable -> professional country, immovable -> booking country) and the
 * reverse-charge branches, but evaluates the config's logic rules with the
 * professional's answers to pick the configured rate.
 */
export const resolveSupplierInvoiceVatDecision = async (params: {
  serviceConfigurationId?: string;
  category?: string;
  service?: string;
  areaOfWork?: string;
  supplierCountry?: string | null;
  buyerCountry?: string | null;
  supplierVatNumber?: string | null;
  buyerVatNumber?: string | null;
  buyerVatVerified?: boolean;
  bookingCountry?: string | null;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
  answers?: Record<string, unknown>;
  professionalAnswers?: Record<string, unknown>;
}): Promise<VatDecision> => {
  const hasValidConfigId = Boolean(
    params.serviceConfigurationId && /^[a-f\d]{24}$/i.test(params.serviceConfigurationId),
  );
  // Only key by the natural identity when the full minimum key is present;
  // a partial key (e.g. category alone) could match an unrelated config and
  // apply the wrong VAT rate.
  const hasNaturalKey = Boolean(params.category && params.service);
  const query: Record<string, unknown> = hasValidConfigId
    ? { _id: params.serviceConfigurationId }
    : hasNaturalKey
      ? {
          category: params.category,
          service: params.service,
          ...(params.areaOfWork ? { areaOfWork: params.areaOfWork } : {}),
        }
      : {};
  const config = Object.keys(query).length > 0
    ? await ServiceConfiguration.findOne(query).select("category service vatManagement")
    : null;
  const vat = config?.vatManagement;

  const article47Classification = vat?.enabled
    ? resolveArticle47Classification(vat.article47Classification)
    : normalizeArticle47Classification(vat?.article47Classification);
  const propertyNature =
    params.propertyNature ??
    resolvePropertyNature({
      classification: article47Classification,
      professionalAnswers: params.professionalAnswers,
    }) ?? "movable";
  const exemptFromBelgianReverseCharge =
    params.exemptFromBelgianReverseCharge ?? Boolean(vat?.exemptFromBelgianReverseCharge);

  const place = flowchartPlaceOfSupplyCountry({
    leg: "supplier",
    propertyNature,
    bookingCountry: params.bookingCountry ?? params.buyerCountry,
    supplierBusinessCountry: params.supplierCountry,
  });
  const supplierCountry = parseVatCountryCode(params.supplierCountry);
  const country =
    place.country ||
    parseVatCountryCode(params.buyerCountry) ||
    supplierCountry;

  let standardRate = getStandardVatRate(country);
  let reducedRate: number | undefined;
  let appliedRate = standardRate;
  let action: VatRoutingAction = "standard_rate";
  let matchedRuleText: string | undefined;
  let ruleGroup: string | undefined;

  if (vat?.enabled && country) {
    const combinedAnswers = {
      ...(params.answers || {}),
      ...(params.professionalAnswers || {}),
    };
    const rules = [...(vat.logicRules || [])]
      .filter((rule) => rule.isActive !== false && normalizeVatCountry(rule.country) === country)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    // The configuration's standard rate overrides the static country rate even
    // when no reduced-rate rule matches.
    if (Number.isFinite(rules[0]?.standardRate)) {
      standardRate = Number(rules[0].standardRate);
      appliedRate = standardRate;
    }
    for (const rule of rules) {
      if (!evaluateVatRule(rule, combinedAnswers)) continue;
      if (Number.isFinite(rule.standardRate)) standardRate = Number(rule.standardRate);
      ruleGroup = vat.rateRuleGroup;
      matchedRuleText = rule.customText;
      if (rule.action === "rfq") {
        // A self-bill cannot be raised before the rule is resolved; keep the
        // standard rate rather than silently granting the reduced rate.
        action = "standard_rate";
        appliedRate = standardRate;
        break;
      }
      reducedRate = Number.isFinite(rule.reducedRate) ? Number(rule.reducedRate) : standardRate;
      action = "reduced_rate";
      appliedRate = reducedRate;
      break;
    }
  }

  const decision: VatDecision = {
    action,
    country,
    standardRate,
    reducedRate,
    appliedRate,
    reverseCharge: false,
    propertyNature,
    exemptFromBelgianReverseCharge,
    matchedRuleText,
    ruleGroup,
    explanation: action === "reduced_rate"
      ? matchedRuleText || `Reduced VAT rate ${appliedRate}% applied to the supplier invoice.`
      : `Standard VAT rate ${appliedRate}% applied to the supplier invoice.`,
  };

  const buyerVatValid = params.buyerVatVerified ?? Boolean(
    params.buyerVatNumber && validateVATNumberFormat(params.buyerVatNumber),
  );
  const rc = flowchartReverseCharge({
    buyerType: "business",
    buyerVatNumber: params.buyerVatNumber,
    buyerVatVerified: buyerVatValid,
    supplierCountry,
    supplierVatNumber: params.supplierVatNumber,
    buyerCountry: country,
    propertyNature,
    exemptFromBelgianReverseCharge,
  });
  if (!rc.reverseCharge) {
    return { ...decision, trace: [...place.trace, ...rc.trace, { step: "rate", detail: `supplier ${action} ${appliedRate}%` }] };
  }
  return {
    ...decision,
    appliedRate: 0,
    reverseCharge: true,
    vatLabel: REVERSE_CHARGE_LABEL,
    explanation: REVERSE_CHARGE_LABEL,
    trace: [...place.trace, ...rc.trace, { step: "rate", detail: "supplier reverse-charge 0%" }],
  };
};

const pushUniqueRate = (options: VatRateOption[], option: VatRateOption) => {
  if (!options.some((existing) => existing.rate === option.rate && existing.reverseCharge === option.reverseCharge)) {
    options.push(option);
  }
};

export const getVatRateOptionsFromConfig = async (params: {
  serviceConfigurationId?: string;
  category?: string;
  service?: string;
  areaOfWork?: string;
  country?: string;
  bookingCountry?: string;
  businessCountry?: string;
  customerType?: string;
  vatNumber?: string | null;
  isVatVerified?: boolean;
  answers?: Record<string, unknown>;
  professionalAnswers?: Record<string, unknown>;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
}): Promise<VatRateOption[]> => {
  const decision = await resolveVatDecisionFromConfig(params);
  const country = decision.country || parseVatCountryCode(params.country);

  if (decision.reverseCharge && decision.appliedRate === 0) {
    return [{
      rate: 0,
      country,
      label: REVERSE_CHARGE_LABEL,
      reverseCharge: true,
      source: "b2b_exempt",
    }];
  }

  const options: VatRateOption[] = [];
  pushUniqueRate(options, {
    rate: decision.standardRate,
    country,
    label: `${decision.standardRate}% standard VAT`,
    reverseCharge: false,
    source: "standard",
  });

  if (decision.action === "reduced_rate" && Number.isFinite(decision.reducedRate)) {
    pushUniqueRate(options, {
      rate: decision.reducedRate!,
      country,
      label: decision.matchedRuleText
        ? `${decision.reducedRate}% reduced VAT - ${decision.matchedRuleText}`
        : `${decision.reducedRate}% reduced VAT`,
      reverseCharge: false,
      source: "reduced",
    });
  }

  return options.sort((a, b) => a.rate - b.rate);
};

/**
 * Quotation tier-only options (Standard/Reduced).
 * The professional already determines the tier; service-rule eligibility is
 * IGNORED. VAT country is resolved through the flowchart SSOT, then the
 * corresponding country rate is returned. No custom % when country is known.
 */
export const getQuotationTierRateOptionsFromConfig = async (params: {
  serviceConfigurationId?: string;
  category?: string;
  service?: string;
  areaOfWork?: string;
  country?: string;
  bookingCountry?: string;
  businessCountry?: string;
  supplierBusinessCountry?: string | null;
  customerType?: string;
  vatNumber?: string | null;
  isVatVerified?: boolean;
  professionalAnswers?: Record<string, unknown>;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
}): Promise<VatRateOption[]> => {
  const query = params.serviceConfigurationId && /^[a-f\d]{24}$/i.test(params.serviceConfigurationId)
    ? { _id: params.serviceConfigurationId }
    : {
        ...(params.category ? { category: params.category } : {}),
        ...(params.service ? { service: params.service } : {}),
        ...(params.areaOfWork ? { areaOfWork: params.areaOfWork } : {}),
      };
  const config = Object.keys(query).length > 0
    ? await ServiceConfiguration.findOne(query).select("category service vatManagement")
    : null;
  const vat = config?.vatManagement;
  const propertyNature =
    params.propertyNature ??
    resolvePropertyNature({
      classification: vat?.enabled
        ? resolveArticle47Classification(vat.article47Classification)
        : normalizeArticle47Classification(vat?.article47Classification),
      professionalAnswers: params.professionalAnswers,
    });
  const { country } = flowchartPlaceOfSupplyCountry({
    leg: "customer",
    customerType: params.customerType,
    propertyNature,
    bookingCountry: params.bookingCountry || params.country,
    customerBusinessCountry: params.businessCountry,
    supplierBusinessCountry: params.supplierBusinessCountry,
  });
  const resolvedCountry = country || parseVatCountryCode(params.country);
  if (!resolvedCountry) return [];

  // A quotation's customer-facing VAT tier is selected by the professional.
  // The customer B2B reverse-charge check belongs to the separate
  // professional/platform self-billing leg, which is resolved when the
  // supplier invoice is generated.
  const rules = [...(vat?.logicRules || [])]
    .filter((r) => r.isActive !== false && parseVatCountryCode(r.country) === resolvedCountry)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  const firstRule = rules[0];
  const standardRate = Number.isFinite(firstRule?.standardRate)
    ? Number(firstRule.standardRate)
    : getStandardVatRate(resolvedCountry);
  const reducedRate = Number.isFinite(firstRule?.reducedRate)
    ? Number(firstRule.reducedRate)
    : undefined;

  const options: VatRateOption[] = [];
  const std = flowchartTierRateForCountry({
    country: resolvedCountry,
    tier: "standard",
    standardRate,
    fallbackStandardRate: getStandardVatRate(resolvedCountry),
  });
  pushUniqueRate(options, {
    rate: std.rate,
    country: resolvedCountry,
    label: `${std.rate}% standard VAT`,
    reverseCharge: false,
    source: "standard",
  });
  if (Number.isFinite(reducedRate)) {
    const red = flowchartTierRateForCountry({
      country: resolvedCountry,
      tier: "reduced",
      standardRate,
      reducedRate,
      fallbackStandardRate: getStandardVatRate(resolvedCountry),
    });
    pushUniqueRate(options, {
      rate: red.rate,
      country: resolvedCountry,
      label: `${red.rate}% reduced VAT`,
      reverseCharge: false,
      source: "reduced",
    });
  }
  return options.sort((a, b) => a.rate - b.rate);
};

export const resolveVatDecisionFromConfig = async (params: {
  serviceConfigurationId?: string;
  category?: string;
  service?: string;
  areaOfWork?: string;
  country?: string;
  bookingCountry?: string;
  businessCountry?: string;
  answers?: Record<string, unknown>;
  professionalAnswers?: Record<string, unknown>;
  customerType?: string;
  vatNumber?: string | null;
  isVatVerified?: boolean;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
}): Promise<VatDecision> => {
  const query = params.serviceConfigurationId && /^[a-f\d]{24}$/i.test(params.serviceConfigurationId)
    ? { _id: params.serviceConfigurationId }
    : {
        ...(params.category ? { category: params.category } : {}),
        ...(params.service ? { service: params.service } : {}),
        ...(params.areaOfWork ? { areaOfWork: params.areaOfWork } : {}),
      };

  const config = Object.keys(query).length > 0
    ? await ServiceConfiguration.findOne(query).select("category service vatManagement")
    : null;

  const vat = config?.vatManagement;
  const article47Classification = vat?.enabled
    ? resolveArticle47Classification(vat.article47Classification)
    : normalizeArticle47Classification(vat?.article47Classification);
  const propertyNature =
    params.propertyNature ??
    resolvePropertyNature({
      classification: article47Classification,
      professionalAnswers: params.professionalAnswers,
    });
  const exemptFromBelgianReverseCharge =
    params.exemptFromBelgianReverseCharge ?? Boolean(vat?.exemptFromBelgianReverseCharge);
  const b2bContext: B2BInvoiceContext = { propertyNature, exemptFromBelgianReverseCharge };

  // Branch-for-branch SSOT trace (art47 -> place-of-supply -> RC -> rate).
  const trace: VatDecisionTraceStep[] = [];
  try {
    trace.push(
      ...flowchartPropertyNature({
        classification: article47Classification,
        professionalAnswers: params.professionalAnswers,
      }).trace,
    );
  } catch { /* trace best-effort */ }

  const hasPlaceOfSupplyContext = [params.bookingCountry, params.businessCountry]
    .some((value) => value != null && String(value).trim() !== "");
  const country = hasPlaceOfSupplyContext
    ? resolvePlaceOfSupplyCountry({
        customerType: params.customerType,
        propertyNature,
        bookingCountry: params.bookingCountry || params.country,
        businessCountry: params.businessCountry,
      })
    : parseVatCountryCode(params.country);
  try {
    trace.push(
      ...flowchartPlaceOfSupplyCountry({
        leg: "customer",
        customerType: params.customerType,
        propertyNature,
        bookingCountry: params.bookingCountry || params.country,
        customerBusinessCountry: params.businessCountry,
      }).trace,
    );
  } catch { /* trace best-effort */ }

  const fallbackRate = getStandardVatRate(country);
  const withTrace = (decision: VatDecision, detail: string): VatDecision => ({
    ...decision,
    trace: [...trace, { step: "rate", detail }],
  });
  if (
    !params.propertyNature &&
    article47Classification === "project_dependent" &&
    propertyNature === undefined
  ) {
    return withTrace({
      action: "rfq",
      country,
      standardRate: fallbackRate,
      appliedRate: 0,
      reverseCharge: false,
      exemptFromBelgianReverseCharge,
      explanation: "Article 47 property classification must be answered before VAT can be determined.",
    }, "rfq: art47 unanswered");
  }
  if (!country) {
    return withTrace({
      action: "rfq",
      country,
      standardRate: 0,
      appliedRate: 0,
      reverseCharge: false,
      propertyNature,
      exemptFromBelgianReverseCharge,
      explanation: "Customer country could not be matched to a VAT jurisdiction. VAT review is required before checkout.",
    }, "rfq: unknown country");
  }
  const fallback: VatDecision = {
    action: "standard_rate",
    country,
    standardRate: fallbackRate,
    appliedRate: fallbackRate,
    reverseCharge: false,
    propertyNature,
    exemptFromBelgianReverseCharge,
    explanation: `Standard VAT rate ${fallbackRate}% applied.`,
  };

  const applyB2B = (decision: VatDecision): VatDecision => {
    const out = applyB2BInvoiceRule(decision, params.customerType, params.vatNumber, params.isVatVerified, b2bContext);
    let rcTrace: VatDecisionTraceStep[] = [];
    try {
      rcTrace = flowchartReverseCharge({
        buyerType: params.customerType,
        buyerVatNumber: params.vatNumber,
        buyerVatVerified: params.isVatVerified,
        buyerCountry: out.country,
        propertyNature,
        exemptFromBelgianReverseCharge,
      }).trace;
    } catch { /* best-effort */ }
    const base = out.trace?.length ? out.trace : trace;
    return {
      ...out,
      trace: [...base, ...rcTrace, { step: "rate", detail: out.reverseCharge ? "reverse-charge 0%" : `applied=${out.appliedRate}% action=${out.action}` }],
    };
  };

  if (config?.category === "Renovation" || params.category === "Renovation") {
    return applyB2B({
      ...fallback,
      action: "rfq",
      explanation: "Renovation services require quotation-level VAT review.",
    });
  }

  if (!vat?.enabled) {
    return applyB2B(fallback);
  }

  const combinedAnswers = {
    ...(params.answers || {}),
    ...(params.professionalAnswers || {}),
  };

  const rules = [...(vat.logicRules || [])]
    .filter(rule => rule.isActive !== false && normalizeVatCountry(rule.country) === country)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));

  for (const rule of rules) {
    if (!evaluateVatRule(rule, combinedAnswers)) continue;
    const standardRate = Number.isFinite(rule.standardRate) ? rule.standardRate : fallbackRate;
    const reducedRate = Number.isFinite(rule.reducedRate) ? rule.reducedRate : standardRate;
    const next: VatDecision = {
      action: rule.action === "rfq" ? "rfq" : "reduced_rate",
      country,
      standardRate,
      reducedRate,
      appliedRate: rule.action === "rfq" ? standardRate : reducedRate,
      reverseCharge: false,
      propertyNature,
      exemptFromBelgianReverseCharge,
      explanation: rule.customText || (rule.action === "rfq"
        ? "Reduced VAT claim requires RFQ review."
        : `Reduced VAT rate ${reducedRate}% applied.`),
      matchedRuleText: rule.customText,
      ruleGroup: vat.rateRuleGroup,
    };
    return applyB2B(next);
  }

  return applyB2B({
    ...fallback,
    ruleGroup: vat.rateRuleGroup,
  });
};

export const withArticle47ProfessionalQuestion = <T extends {
  article47Classification?: string;
  professionalVatQuestions?: Array<{
    question: string;
    fieldName: string;
    answerType: "number" | "yes_no" | "checkboxes";
    unit?: string;
    options?: string[];
    isRequired: boolean;
  }>;
}>(vat: T): NonNullable<T["professionalVatQuestions"]> => {
  const existing = vat.professionalVatQuestions || [];
  const classification = resolveArticle47Classification(vat.article47Classification);
  if (classification !== "project_dependent") return existing;
  if (existing.some((question) => question.fieldName === ARTICLE_47_FIELD_NAME)) return existing;
  return [
    {
      question: ARTICLE_47_QUESTION,
      fieldName: ARTICLE_47_FIELD_NAME,
      answerType: "yes_no",
      isRequired: true,
    },
    ...existing,
  ];
};
