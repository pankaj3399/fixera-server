import { withCommission } from "../customerPricing";

export type ProjectSearchDimensions = {
  services?: string[];
  geographicArea?: string;
  priceModels?: string[];
  projectTypes?: string[];
  includedItems?: string[];
  areasOfWork?: string[];
  priceMin?: number;
  priceMax?: number;
  commissionPercent?: number;
  loyaltyDiscountPercent?: number;
  loyaltyDiscountMax?: number;
  category?: string;
};

export const normalizeSearchValue = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase() : "";

const intersects = (values: unknown[], selected: string[]) => {
  const wanted = new Set(selected.map(normalizeSearchValue));
  return values.some((value) => wanted.has(normalizeSearchValue(value)));
};

const customerDisplayAmount = (amount: number, commission: number, loyaltyPercent = 0, loyaltyMax?: number) => {
  const commissionInclusive = withCommission(amount, commission);
  if (loyaltyPercent <= 0 || commissionInclusive <= 0) return commissionInclusive;
  let discount = Math.round(commissionInclusive * loyaltyPercent) / 100;
  if (loyaltyMax != null && loyaltyMax > 0) discount = Math.min(discount, loyaltyMax);
  return Math.max(0, Math.round((commissionInclusive - discount) * 100) / 100);
};

const priceInBounds = (amount: unknown, min?: number, max?: number, commission = 0, loyaltyPercent = 0, loyaltyMax?: number) => {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return false;
  const customerAmount = customerDisplayAmount(amount, commission, loyaltyPercent, loyaltyMax);
  return (min === undefined || customerAmount >= min) && (max === undefined || customerAmount <= max);
};

export const projectMatchesPrice = (
  project: any,
  { priceMin, priceMax, commissionPercent = 0, loyaltyDiscountPercent = 0, loyaltyDiscountMax, priceModels }: ProjectSearchDimensions,
) => {
  if (priceMin === undefined && priceMax === undefined) return true;
  const packages = Array.isArray(project?.subprojects) ? project.subprojects : [];
  const legacyPricing = project?.pricing;
  const candidates = packages.length > 0 ? packages : legacyPricing ? [{ pricing: legacyPricing }] : [];
  return candidates.some(({ pricing }: any) => {
    const type = normalizeSearchValue(pricing?.type);
    if (priceModels?.length && !priceModels.some((value) => normalizeSearchValue(value) === type)) return false;
    if (type === "fixed") return priceInBounds(pricing.amount, priceMin, priceMax, commissionPercent, loyaltyDiscountPercent, loyaltyDiscountMax);
    if (type === "unit") {
      const range = pricing.priceRange;
      if (typeof range?.min === "number" && Number.isFinite(range.min) && range.min >= 0 && typeof range?.max === "number" && Number.isFinite(range.max) && range.max >= range.min) {
        const low = customerDisplayAmount(range.min, commissionPercent, loyaltyDiscountPercent, loyaltyDiscountMax);
        const high = customerDisplayAmount(range.max, commissionPercent, loyaltyDiscountPercent, loyaltyDiscountMax);
        return (priceMax === undefined || low <= priceMax) && (priceMin === undefined || high >= priceMin);
      }
      return priceInBounds(pricing?.amount, priceMin, priceMax, commissionPercent, loyaltyDiscountPercent, loyaltyDiscountMax);
    }
    if (type === "rfq" && typeof pricing?.priceRange?.min === "number" && Number.isFinite(pricing.priceRange.min) && pricing.priceRange.min >= 0 && typeof pricing?.priceRange?.max === "number" && Number.isFinite(pricing.priceRange.max) && pricing.priceRange.max >= pricing.priceRange.min) {
      const low = customerDisplayAmount(pricing.priceRange.min, commissionPercent, loyaltyDiscountPercent, loyaltyDiscountMax);
      const high = customerDisplayAmount(pricing.priceRange.max, commissionPercent, loyaltyDiscountPercent, loyaltyDiscountMax);
      return (priceMax === undefined || low <= priceMax) && (priceMin === undefined || high >= priceMin);
    }
    return false;
  });
};

/** Different package dimensions intersect at project level; values within a dimension are ORed. */
export const projectMatchesDimensions = (
  project: any,
  dimensions: ProjectSearchDimensions,
  excluded?: keyof ProjectSearchDimensions,
) => {
  const packages = Array.isArray(project?.subprojects) ? project.subprojects : [];
  const filter = (key: keyof ProjectSearchDimensions) => key !== excluded;
  const matchProjectValues = (selected: string[] | undefined, values: unknown[]) =>
    !selected?.length || intersects(values, selected);

  const priceBoundsActive = filter("priceMin") && (dimensions.priceMin !== undefined || dimensions.priceMax !== undefined);
  if (priceBoundsActive && filter("priceModels") && dimensions.priceModels?.length) {
    const legacyModel = project?.pricing?.type ? project.pricing : project?.priceModel ? { type: project.priceModel } : undefined;
    const pricingProject = { subprojects: packages.length ? packages : [], pricing: legacyModel };
    if (!projectMatchesPrice(pricingProject, dimensions)) return false;
  } else {
    const legacyModel = project?.pricing?.type || project?.priceModel;
    if (filter("priceModels") && !matchProjectValues(dimensions.priceModels, packages.length ? packages.map((item: any) => item?.pricing?.type) : [legacyModel])) return false;
    if (priceBoundsActive && !projectMatchesPrice(project, dimensions)) return false;
  }
  if (filter("projectTypes") && !matchProjectValues(dimensions.projectTypes, packages.flatMap((item: any) => item?.projectType || []))) return false;
  if (filter("includedItems") && !matchProjectValues(dimensions.includedItems, packages.flatMap((item: any) => (item?.included || []).map((included: any) => included?.name)))) return false;

  const services = [project?.service, ...(Array.isArray(project?.services) ? project.services.flatMap((item: any) => [item?.name, item?.service, item?.serviceName]) : [])];
  if (filter("services") && !matchProjectValues(dimensions.services, services)) return false;
  if (filter("areasOfWork") && !matchProjectValues(dimensions.areasOfWork, [project?.areaOfWork, ...(project?.services || []).map((item: any) => item?.areaOfWork)])) return false;
  if (filter("geographicArea") && dimensions.geographicArea && !normalizeSearchValue(project?.distance?.address).includes(normalizeSearchValue(dimensions.geographicArea))) return false;
  if (filter("category") && dimensions.category && !normalizeSearchValue(project?.category).includes(normalizeSearchValue(dimensions.category))) return false;
  return true;
};

export const parsePriceBound = (raw: unknown): { value?: number; invalid: boolean } => {
  if (raw === undefined || raw === "") return { invalid: false };
  if (typeof raw !== "string" || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return { invalid: true };
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? { value, invalid: false } : { invalid: true };
};

export const parseDateOnly = (raw: unknown): Date | undefined => {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? date : undefined;
};
