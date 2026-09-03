import ServiceConfiguration, { IVatLogicCondition, IVatLogicRule } from "../models/serviceConfiguration";
import { validateVATNumberFormat } from "./vatValidation";

export type VatRoutingAction = "standard_rate" | "reduced_rate" | "rfq";

export interface VatDecision {
  action: VatRoutingAction;
  country: string;
  standardRate: number;
  appliedRate: number;
  reducedRate?: number;
  reverseCharge: boolean;
  vatLabel?: string;
  exemptFromBelgianReverseCharge?: boolean;
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

const COUNTRY_ALIASES: Record<string, string> = {
  AUSTRIA: "AT",
  BELGIUM: "BE",
  BULGARIA: "BG",
  CROATIA: "HR",
  CYPRUS: "CY",
  CZECHIA: "CZ",
  "CZECH REPUBLIC": "CZ",
  DENMARK: "DK",
  ESTONIA: "EE",
  FINLAND: "FI",
  FRANCE: "FR",
  MONACO: "MC",
  GERMANY: "DE",
  GREECE: "GR",
  HUNGARY: "HU",
  IRELAND: "IE",
  ITALY: "IT",
  LATVIA: "LV",
  LITHUANIA: "LT",
  LUXEMBOURG: "LU",
  MALTA: "MT",
  NETHERLANDS: "NL",
  "THE NETHERLANDS": "NL",
  NEDERLAND: "NL",
  HOLLAND: "NL",
  POLAND: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  SLOVAKIA: "SK",
  SLOVENIA: "SI",
  SPAIN: "ES",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  LIECHTENSTEIN: "LI",
  NORWAY: "NO",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  SCOTLAND: "GB",
  WALES: "GB",
  "UNITED STATES": "US",
  USA: "US",
  "UNITED STATES OF AMERICA": "US",
  CANADA: "CA",
  AUSTRALIA: "AU",
  "NEW ZEALAND": "NZ",
  INDIA: "IN",
  UKRAINE: "UA",
  MOLDOVA: "MD",
  ANDORRA: "AD",
  "SAN MARINO": "SM",
  TURKEY: "TR",
  TÜRKIYE: "TR",
  TURKIYE: "TR",
};

const STANDARD_RATES: Record<string, number> = {
  BE: 21, NL: 21, DE: 19, CH: 8.1, AT: 20, LI: 8.1, FR: 20, MC: 20, GB: 20,
  IE: 23, LT: 21, LV: 21, EE: 24, ES: 21, AD: 4.5, PT: 23, IT: 22, SM: 0,
  DK: 25, NO: 25, SE: 25, FI: 25.5, PL: 23, CZ: 21, UA: 20, RO: 21, MD: 20,
  SK: 23, HU: 27, SI: 22, HR: 25, GR: 24, CY: 19, BG: 20, TR: 20,
  US: 0, CA: 0, AU: 0, NZ: 0, IN: 0,
};

export type Article47Classification = "movable" | "immovable" | "project_dependent";
export type PropertyNature = "movable" | "immovable";

export const REVERSE_CHARGE_LABEL = "Reverse Charge";
export const ARTICLE_47_FIELD_NAME = "article47_immovable";
export const DEFAULT_ARTICLE_47_CLASSIFICATION: Article47Classification = "immovable";
export const ARTICLE_47_QUESTION =
  "Will the work be carried out on a fixed part of the property or on something that will become permanently fixed to the property? (Article 47)";

export const B2B_SAME_AS_B2C_COUNTRIES = new Set(["CH", "LI", "NO", "GR"]);
const KNOWN_COUNTRY_CODES = new Set([
  ...Object.keys(STANDARD_RATES),
  ...Object.values(COUNTRY_ALIASES),
]);

export const normalizeArticle47Classification = (
  classification?: string | null
): Article47Classification | undefined => {
  if (classification === "movable" || classification === "immovable" || classification === "project_dependent") {
    return classification;
  }
  return undefined;
};

/** Legacy VAT configs may omit Article 47; default to immovable (matches admin UI). */
export const resolveArticle47Classification = (
  classification?: string | null
): Article47Classification => normalizeArticle47Classification(classification) ?? DEFAULT_ARTICLE_47_CLASSIFICATION;

/** ISO-2 when recognized; empty string when missing or unknown. Does not default to BE. */
export const parseVatCountryCode = (country?: string | null): string => {
  if (country == null || String(country).trim() === "") return "";
  const raw = String(country).trim();
  const upper = raw.toUpperCase();
  if (upper === "EL") return "GR";
  if (/^[A-Z]{2}$/.test(upper)) return KNOWN_COUNTRY_CODES.has(upper) ? upper : "";
  if (COUNTRY_ALIASES[upper]) return COUNTRY_ALIASES[upper];
  const normalizedName = upper.replace(/[.,']/g, "").replace(/\s+/g, " ");
  if (COUNTRY_ALIASES[normalizedName]) return COUNTRY_ALIASES[normalizedName];
  return "";
};

export const normalizeVatCountry = (country?: string | null): string => parseVatCountryCode(country);

export const firstVatCountry = (...candidates: Array<string | null | undefined>): string => {
  for (const candidate of candidates) {
    const parsed = parseVatCountryCode(candidate);
    if (parsed) return parsed;
  }
  return "";
};

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

export const getStandardVatRate = (country?: string | null): number => {
  const normalized = normalizeVatCountry(country);
  if (!normalized) return 0;
  return STANDARD_RATES[normalized] ?? 0;
};

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
  if (params.customerType === "business" && params.propertyNature === "movable") {
    return firstVatCountry(params.businessCountry, params.bookingCountry);
  }
  return firstVatCountry(params.bookingCountry, params.businessCountry);
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
  if (customerType !== "business") return decision;
  if (!hasVerifiedVatNumber(vatNumber, isVatVerified)) return decision;

  const country = parseVatCountryCode(decision.country);
  if (!country) return decision;
  if (isB2BSameAsB2CCountry(country)) return decision;

  const propertyNature = context?.propertyNature || "movable";
  const beKeepsB2CRate =
    country === "BE" &&
    (propertyNature !== "immovable" || Boolean(context?.exemptFromBelgianReverseCharge));
  if (beKeepsB2CRate) return decision;

  return {
    ...decision,
    appliedRate: 0,
    reverseCharge: true,
    vatLabel: REVERSE_CHARGE_LABEL,
    explanation: REVERSE_CHARGE_LABEL,
    propertyNature,
  };
};

/** Resolve VAT on the supplier's invoice to the platform buyer. */
export const resolveSupplierB2BInvoiceDecision = (params: {
  supplierCountry?: string | null;
  buyerCountry?: string | null;
  supplierVatNumber?: string | null;
  buyerVatNumber?: string | null;
  propertyNature?: PropertyNature;
  exemptFromBelgianReverseCharge?: boolean;
}): VatDecision => {
  const supplierCountry = parseVatCountryCode(params.supplierCountry);
  const buyerCountry = parseVatCountryCode(params.buyerCountry) || supplierCountry;
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

  const supplierVatValid = Boolean(
    params.supplierVatNumber && validateVATNumberFormat(params.supplierVatNumber),
  );
  const buyerVatValid = Boolean(
    params.buyerVatNumber && validateVATNumberFormat(params.buyerVatNumber),
  );
  // The configured VAT-country exception table is authoritative for the
  // platform buyer's place of supply, including cross-border supplier cases.
  // Do this before the generic cross-border reverse-charge branch.
  if (isB2BSameAsB2CCountry(buyerCountry)) return decision;
  if (supplierCountry && buyerCountry && supplierCountry !== buyerCountry && supplierVatValid && buyerVatValid) {
    return {
      ...decision,
      appliedRate: 0,
      reverseCharge: true,
      vatLabel: REVERSE_CHARGE_LABEL,
      explanation: REVERSE_CHARGE_LABEL,
    };
  }

  return applyB2BInvoiceRule(
    decision,
    "business",
    params.buyerVatNumber,
    buyerVatValid,
    {
      propertyNature,
      exemptFromBelgianReverseCharge: params.exemptFromBelgianReverseCharge,
    },
  );
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

  const fallbackRate = getStandardVatRate(country);
  if (
    !params.propertyNature &&
    article47Classification === "project_dependent" &&
    propertyNature === undefined
  ) {
    return {
      action: "rfq",
      country,
      standardRate: fallbackRate,
      appliedRate: 0,
      reverseCharge: false,
      exemptFromBelgianReverseCharge,
      explanation: "Article 47 property classification must be answered before VAT can be determined.",
    };
  }
  if (!country) {
    return {
      action: "rfq",
      country,
      standardRate: 0,
      appliedRate: 0,
      reverseCharge: false,
      propertyNature,
      exemptFromBelgianReverseCharge,
      explanation: "Customer country could not be matched to a VAT jurisdiction. VAT review is required before checkout.",
    };
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

  const applyB2B = (decision: VatDecision) =>
    applyB2BInvoiceRule(decision, params.customerType, params.vatNumber, params.isVatVerified, b2bContext);

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
