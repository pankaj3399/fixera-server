import { Request, Response } from "express";
import { Types } from "mongoose";
import { DateTime } from "luxon";
import User from "../../models/user";
import Project from "../../models/project";
import ProfessionalLevelConfig from "../../models/professionalLevelConfig";
import type { IProfessionalLevelConfig } from "../../models/professionalLevelConfig";

const LEVEL_CONFIG_TTL_MS = 5 * 60 * 1000;
let cachedLevelConfig: IProfessionalLevelConfig | null = null;
let cachedLevelConfigAt = 0;
let cachedLevelConfigPromise: Promise<IProfessionalLevelConfig> | null = null;

const getCachedLevelConfig = async (): Promise<IProfessionalLevelConfig> => {
  if (cachedLevelConfig && Date.now() - cachedLevelConfigAt < LEVEL_CONFIG_TTL_MS) {
    return cachedLevelConfig;
  }
  if (cachedLevelConfigPromise) {
    return cachedLevelConfigPromise;
  }
  cachedLevelConfigPromise = ProfessionalLevelConfig.getCurrentConfig()
    .then((config) => {
      cachedLevelConfig = config;
      cachedLevelConfigAt = Date.now();
      cachedLevelConfigPromise = null;
      return config;
    })
    .catch((err) => {
      cachedLevelConfigPromise = null;
      if (cachedLevelConfig) {
        console.warn("Failed to refresh professional level config, serving stale cache:", err);
        return cachedLevelConfig;
      }
      throw err;
    });
  return cachedLevelConfigPromise;
};
import { buildProjectScheduleProposalsWithData, resolveEffectiveScheduleTimeZone } from "../../utils/scheduleEngine";

export { getPopularServices } from "./getPopularServices";
export { getPopularProjects } from "./getPopularProjects";
export { aggregateRatings, aggregateProfessionalRatings, aggregateProjectRatings } from "./aggregateRatings";

import { aggregateProfessionalRatings, aggregateProjectRatings } from "./aggregateRatings";
import {
  normalizeSearchValue,
  parseDateOnly,
  parsePriceBound,
  projectMatchesDimensions,
  projectMatchesPrice,
  type ProjectSearchDimensions,
} from "../../utils/search/projectFilters";
import { isRelevanceSort, sortProjectsByRelevance } from "../../utils/search/projectRelevance";
import PlatformSettings from "../../models/platformSettings";
import LoyaltyConfig from "../../models/loyaltyConfig";
import { getCurrentTier } from "../../utils/loyaltySystem";
import { getCountryCode } from "../../utils/geocoding";

const escapeSearchRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SEARCH_BATCH_SIZE = 500;
const aggregateProjectRatingsInBatches = async (ids: any[]) => {
  const ratings = new Map<string, { avgRating: number; totalReviews: number }>();
  for (let index = 0; index < ids.length; index += SEARCH_BATCH_SIZE) {
    const batch = await aggregateProjectRatings(ids.slice(index, index + SEARCH_BATCH_SIZE));
    for (const [id, rating] of batch) ratings.set(id, rating);
  }
  return ratings;
};

/**
 * Unified search endpoint for professionals and projects
 * Supports filtering by query, location, price range, category, and availability
 */
const parseCsv = (value: unknown): string[] => {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
};

export const search = async (req: Request, res: Response) => {
  try {
    const scalarFields = ["q", "loc", "type", "priceMin", "priceMax", "category", "availability", "customerLat", "customerLon", "customerCountry", "customerState", "customerCity", "customerAddress", "page", "limit", "sortBy", "professionalLevels", "adminTags", "minRating", "services", "geographicArea", "priceModel", "projectTypes", "includedItems", "areaOfWork", "startDateFrom", "startDateTo"];
    for (const field of scalarFields) {
      const value = req.query[field];
      if (value !== undefined && (typeof value !== "string" || value.length > (field === "q" ? 300 : 3000))) {
        return res.status(400).json({ error: `Invalid search parameter: ${field}` });
      }
    }
    const {
      q = "", // search query
      loc = "", // location
      type = "professionals", // 'professionals' or 'projects'
      priceMin,
      priceMax,
      category,
      availability,
      customerLat,
      customerLon,
      customerCountry,
      customerState,
      customerCity,
      customerAddress,
      page = "1",
      limit = "20",
      sortBy,
      professionalLevels,
      adminTags,
      minRating,
      services,
      geographicArea,
      priceModel,
      projectTypes,
      includedItems,
      areaOfWork,
      startDateFrom,
      startDateTo,
    } = req.query;

    const levelsList = parseCsv(professionalLevels);
    const tagsList = parseCsv(adminTags);
    const minRatingNum = typeof minRating === "string" ? parseFloat(minRating) : NaN;
    const minRatingValue = Number.isFinite(minRatingNum) && minRatingNum > 0 ? minRatingNum : 0;
    if (type === "projects" && minRating !== undefined && (!Number.isInteger(minRatingNum) || minRatingNum < 0 || minRatingNum > 5)) {
      return res.status(400).json({ error: "Minimum project rating must be between 1 and 5, or 0 for Any" });
    }
    const priceMinBound = parsePriceBound(priceMin);
    const priceMaxBound = parsePriceBound(priceMax);
    if (priceMinBound.invalid || priceMaxBound.invalid || (priceMinBound.value !== undefined && priceMaxBound.value !== undefined && priceMinBound.value > priceMaxBound.value)) {
      return res.status(400).json({ error: "Price bounds must be finite, non-negative numbers with minimum no greater than maximum" });
    }
    const startDateFromValue = startDateFrom === undefined ? undefined : parseDateOnly(startDateFrom);
    const startDateToValue = startDateTo === undefined ? undefined : parseDateOnly(startDateTo);
    if ((startDateFrom !== undefined && !startDateFromValue) || (startDateTo !== undefined && !startDateToValue)) {
      return res.status(400).json({ error: "Dates must use YYYY-MM-DD format" });
    }
    if (startDateFromValue && startDateToValue && startDateFromValue > startDateToValue) {
      return res.status(400).json({ error: "Start date must be before or equal to end date" });
    }
    // Optional authentication supplies the principal; public query discounts are ignored.
    let loyaltyPercentValue = 0;
    let loyaltyMaxValue: number | undefined;
    if (type === "projects" && (priceMinBound.value !== undefined || priceMaxBound.value !== undefined) && req.user?.role === "customer") {
      const config = await LoyaltyConfig.getCurrentConfig();
      const tiers = config.tiers.filter(tier => tier.isActive !== false);
      if (tiers.length > 0) {
        const preferred = req.user.manualCustomerLevelOverride || req.user.loyaltyLevel;
        const tier = tiers.find(tier => tier.name === preferred) || getCurrentTier(tiers, req.user.totalSpent || 0);
        loyaltyPercentValue = tier.discountPercentage || 0;
        loyaltyMaxValue = tier.maxDiscountAmount;
      }
    }
    const sortByValue = typeof sortBy === "string" ? sortBy : undefined;

    const parsedPage = parseInt(page as string, 10);
    const parsedLimit = parseInt(limit as string, 10);
    const pageNum = Number.isSafeInteger(parsedPage) && parsedPage > 0
      ? Math.min(parsedPage, 10_000)
      : 1;
    const limitNum = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 50)
      : 20;
    const skip = (pageNum - 1) * limitNum;
    if (!Number.isSafeInteger(skip)) {
      return res.status(400).json({ error: "Pagination offset is too large" });
    }

    if (type === "professionals") {
      return await searchProfessionals(
        res,
        q as string,
        loc as string,
        priceMin as string | undefined,
        priceMax as string | undefined,
        category as string | undefined,
        availability as string | undefined,
        levelsList,
        tagsList,
        sortByValue,
        skip,
        limitNum
      );
    } else if (type === "projects") {
      return await searchProjects(
        res,
        q as string,
        loc as string,
        priceMin as string | undefined,
        priceMax as string | undefined,
        category as string | undefined,
        customerLat as string | undefined,
        customerLon as string | undefined,
        customerCountry as string | undefined,
        customerState as string | undefined,
        customerCity as string | undefined,
        customerAddress as string | undefined,
        levelsList,
        tagsList,
        parseCsv(services),
        typeof geographicArea === "string" ? geographicArea : undefined,
        parseCsv(priceModel),
        parseCsv(projectTypes),
        parseCsv(includedItems),
        parseCsv(areaOfWork),
        startDateFromValue,
        startDateToValue,
        loyaltyPercentValue,
        loyaltyMaxValue,
        minRatingValue,
        sortByValue,
        skip,
        limitNum
      );
    } else {
      return res.status(400).json({ error: "Invalid search type. Use 'professionals' or 'projects'" });
    }
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Failed to perform search" });
  }
};

/**
 * Search for professionals
 */
async function searchProfessionals(
  res: Response,
  query: string,
  location: string,
  priceMin: string | undefined,
  priceMax: string | undefined,
  category: string | undefined,
  availability: string | undefined,
  professionalLevels: string[],
  adminTags: string[],
  sortBy: string | undefined,
  skip: number,
  limit: number
) {
  try {
    // Build the filter object
    const filter: any = {
      role: "professional",
      professionalStatus: "approved",
      deletedAt: null,
      isAnonymized: { $ne: true },
    };

    if (professionalLevels.length > 0) {
      filter.professionalLevel = { $in: professionalLevels };
    }

    if (adminTags.length > 0) {
      filter.adminTags = { $in: adminTags };
    }

    // Search query - search in name, company name, and service categories
    if (query && query.trim()) {
      const searchRegex = new RegExp(escapeSearchRegex(query.trim()), "i");
      filter.$or = [
        { name: searchRegex },
        { username: searchRegex },
        { "businessInfo.companyName": searchRegex },
        { serviceCategories: searchRegex },
      ];
    }

    // Location filter - exact match first, then broader match
    if (location && location.trim()) {
      const locationRegex = new RegExp(escapeSearchRegex(location.trim()), "i");
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { "businessInfo.city": locationRegex },
          { "businessInfo.country": locationRegex },
        ],
      });
    }

    // Price range filter
    if (priceMin !== undefined || priceMax !== undefined) {
      filter.hourlyRate = {};
      if (priceMin) filter.hourlyRate.$gte = parseFloat(priceMin);
      if (priceMax) filter.hourlyRate.$lte = parseFloat(priceMax);
    }

    // Category filter
    if (category && category.trim()) {
      filter.serviceCategories = category.trim();
    }

    // Availability filter - check if professional has availability set
    if (availability === "true") {
      filter.companyAvailability = { $exists: true, $ne: null };
    }

    // Execute query with pagination
    console.log('[SEARCH] Professional filter:', JSON.stringify(filter, null, 2));

    const levelConfig = await getCachedLevelConfig();
    const boostByLevel = new Map<string, number>();
    for (const lvl of levelConfig.levels) {
      boostByLevel.set(lvl.name, lvl.perks?.searchRankingBoost || 1);
    }
    const defaultBoost = boostByLevel.get("New") || 1;

    // Build $switch branches so ranking boost is applied at the DB layer
    const boostBranches = Array.from(boostByLevel.entries()).map(([name, boost]) => ({
      case: { $eq: ["$professionalLevel", name] },
      then: boost,
    }));

    const locationLower = location && location.trim() ? location.trim().toLowerCase() : null;

    const rankingAddFields = {
      $addFields: {
        rankingBoost: {
          $switch: { branches: boostBranches, default: defaultBoost },
        },
        locationExactMatch: locationLower
          ? {
              $cond: [
                {
                  $or: [
                    { $eq: [{ $toLower: { $ifNull: ["$businessInfo.city", ""] } }, locationLower] },
                    { $eq: [{ $toLower: { $ifNull: ["$businessInfo.country", ""] } }, locationLower] },
                  ],
                },
                1,
                0,
              ],
            }
          : 0,
      },
    };

    const rankingSort = {
      $sort: locationLower
        ? { locationExactMatch: -1, rankingBoost: -1, createdAt: -1 }
        : { rankingBoost: -1, createdAt: -1 },
    };

    const projectStage = {
      $project: {
        name: 1,
        username: 1,
        email: 1,
        "businessInfo.description": 1,
        "businessInfo.city": 1,
        "businessInfo.country": 1,
        "businessInfo.website": 1,
        hourlyRate: 1,
        currency: 1,
        serviceCategories: 1,
        profileImage: 1,
        companyAvailability: 1,
        professionalLevel: 1,
        adminTags: 1,
        createdAt: 1,
      },
    };

    const isPopularitySort = sortBy === "popularity";
    let professionals: any[] = [];
    let total = 0;

    if (isPopularitySort) {
      const POPULARITY_CAP = 500;
      const pipeline: any[] = [
        { $match: filter },
        rankingAddFields,
        rankingSort,
        { $limit: POPULARITY_CAP },
        projectStage,
      ];
      const [all, fullCount] = await Promise.all([
        User.aggregate(pipeline),
        User.countDocuments(filter),
      ]);
      if (all.length >= POPULARITY_CAP) {
        console.warn(
          `[Search Performance] Popularity sort hit the ${POPULARITY_CAP}-row cap. ` +
          `Consider denormalizing totalReviews on the user document.`
        );
      }
      const allIds = all.map((p: any) => p._id);
      const allRatings = await aggregateProfessionalRatings(allIds);
      all.sort((a: any, b: any) => {
        const aKey = a._id.toString();
        const bKey = b._id.toString();
        const aRev = allRatings.get(aKey)?.totalReviews || 0;
        const bRev = allRatings.get(bKey)?.totalReviews || 0;
        if (bRev !== aRev) return bRev - aRev;
        const aAvg = allRatings.get(aKey)?.avgRating || 0;
        const bAvg = allRatings.get(bKey)?.avgRating || 0;
        if (bAvg !== aAvg) return bAvg - aAvg;
        return aKey.localeCompare(bKey);
      });
      total = fullCount;
      professionals = all.slice(skip, skip + limit);
    } else {
      const pipeline: any[] = [
        { $match: filter },
        {
          $facet: {
            results: [
              rankingAddFields,
              rankingSort,
              { $skip: skip },
              { $limit: limit },
              projectStage,
            ],
            total: [{ $count: "count" }],
          },
        },
      ];
      const [aggResult] = await User.aggregate(pipeline);
      professionals = aggResult?.results ?? [];
      total = aggResult?.total?.[0]?.count ?? 0;
    }

    console.log('[SEARCH] Found', total, 'professionals, returning', professionals.length);

    // Aggregate ratings for returned professionals
    const professionalIds = professionals.map((p: any) => p._id);
    const ratingMap = await aggregateProfessionalRatings(professionalIds);

    const hasAnyAvailability = (availability?: Record<string, any>) =>
      !!availability &&
      Object.values(availability).some(
        (day) => day?.available || day?.startTime || day?.endTime
      );

    const results = professionals.map((professional: any) => {
      const { companyAvailability, ...rest } = professional;
      const ratings = ratingMap.get(professional._id.toString());
      return {
        ...rest,
        availability: hasAnyAvailability(companyAvailability),
        avgRating: ratings?.avgRating || 0,
        totalReviews: ratings?.totalReviews || 0,
      };
    });

    res.json({
      results,
      pagination: {
        total,
        page: Math.ceil(skip / limit) + 1,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Professional search error:", error);
    res.status(500).json({ error: "Failed to search professionals" });
  }
}

/**
 * Search for projects
 */
async function searchProjects(
  res: Response,
  query: string,
  location: string,
  priceMin: string | undefined,
  priceMax: string | undefined,
  category: string | undefined,
  customerLat: string | undefined,
  customerLon: string | undefined,
  customerCountry: string | undefined,
  customerState: string | undefined,
  customerCity: string | undefined,
  customerAddress: string | undefined,
  professionalLevels: string[],
  adminTags: string[],
  services: string[],
  geographicArea: string | undefined,
  priceModels: string[],
  projectTypes: string[],
  includedItems: string[],
  areasOfWork: string[],
  startDateFrom: Date | undefined,
  startDateTo: Date | undefined,
  loyaltyDiscountPercent: number,
  loyaltyDiscountMax: number | undefined,
  minRating: number,
  sortBy: string | undefined,
  skip: number,
  limit: number
) {
  try {
    // Build the filter object
    const activeProfessionalIds = await User.distinct("_id", {
      role: "professional",
      professionalStatus: "approved",
      deletedAt: null,
      isAnonymized: { $ne: true },
    });
    const filter: any = {
      status: "published",
      professionalId: { $in: activeProfessionalIds },
    };

    const isPopularitySort = sortBy === "popularity";
    // Rating, availability and exact facets all operate on the complete candidate set.
    const needsFullSet = true;

    // Search query - search in title, description, category, and service
    if (query && query.trim()) {
      const searchRegex = new RegExp(escapeSearchRegex(query.trim()), "i");
      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
        { service: searchRegex },
      ];
    }


    const priceMinValue = priceMin === undefined || priceMin === "" ? undefined : Number(priceMin);
    const priceMaxValue = priceMax === undefined || priceMax === "" ? undefined : Number(priceMax);
    const platformSettings = priceMinValue !== undefined || priceMaxValue !== undefined
      ? await PlatformSettings.getCurrentConfig()
      : null;
    const dimensions: ProjectSearchDimensions = {
      services,
      geographicArea,
      priceModels,
      projectTypes,
      includedItems,
      areasOfWork,
      priceMin: priceMinValue,
      priceMax: priceMaxValue,
      commissionPercent: platformSettings?.commissionPercent || 0,
      loyaltyDiscountPercent,
      loyaltyDiscountMax,
      category,
    };

    const normalizeValue = (value?: string | null) =>
      value ? value.trim().toLowerCase() : "";

    const parseCoordinate = (value?: string) => {
      if (!value) return null;
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const toObjectIdString = (value?: unknown) => {
      if (!value) return null;
      const raw =
        typeof value === "object" && (value as any)?._id != null
          ? (value as any)._id
          : value;
      const id =
        typeof raw === "string"
          ? raw
          : typeof raw?.toString === "function"
            ? raw.toString()
            : null;
      return id && Types.ObjectId.isValid(id) ? id : null;
    };

    const escapeRegExp = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Country gate shared by the geo and address-fallback branches: a
    // noBorders project serves only its own country. The customer value may be
    // a name ("belgium") or a code ("be"); both are accepted against the
    // project's ISO countryCode, falling back to address matching when the
    // project has no code recorded.
    const projectPassesCountryGate = (distance: any, customerCountryParam: string): boolean => {
      if (!Boolean(distance?.noBorders) || !customerCountryParam) return true;
      const projectCountryCode = typeof distance?.countryCode === "string" ? distance.countryCode : null;
      const customerUpper = customerCountryParam.toUpperCase();
      if (projectCountryCode) {
        if (projectCountryCode === customerUpper) return true;
        const mapped = getCountryCode(customerCountryParam);
        return mapped != null && projectCountryCode === mapped;
      }
      const projectAddress = normalizeValue(distance?.address);
      return Boolean(projectAddress) && projectAddress.includes(customerCountryParam);
    };

    // Address predicate shared by the non-geo branch and the geo fallback for
    // projects without geocoded coordinates (client bug list #20).
    const projectMatchesCustomerAddress = (project: any, parts: string[], customerCountryParam: string): boolean => {
      const distance = project.distance || {};
      if (!projectPassesCountryGate(distance, customerCountryParam)) return false;
      const projectAddress = normalizeValue(distance.address);
      if (!projectAddress) return false;
      if (parts.length === 0) return false;
      return parts.some((part) => projectAddress.includes(part));
    };

    const customerLatValue = parseCoordinate(customerLat);
    const customerLonValue = parseCoordinate(customerLon);
    const customerCountryValue = normalizeValue(customerCountry);
    const customerStateValue = normalizeValue(customerState);
    const customerCityValue = normalizeValue(customerCity);
    const customerAddressValue = normalizeValue(customerAddress);
    const locationValue = normalizeValue(location);
    const hasGeoCoordinates = customerLatValue !== null && customerLonValue !== null;

    const hasLocationFilter = Boolean(
      locationValue ||
      customerAddressValue ||
      customerCityValue ||
      customerStateValue ||
      customerCountryValue ||
      hasGeoCoordinates
    );

    const locationParts = [
      locationValue,
      customerAddressValue,
      customerCityValue,
      customerStateValue,
      customerCountryValue,
    ].filter(Boolean);
    // Execute query with pagination and populate professional info
    console.log('[SEARCH] Project filter:', JSON.stringify(filter, null, 2));

    const baseQuery = Project.find(filter).sort({ createdAt: -1, _id: 1 });

    let projects: any[] = [];
    let total = 0;
    let usedGeoSearch = false;
    let filteredResults: any[] | null = null;

    if (customerLatValue !== null && customerLonValue !== null) {
      usedGeoSearch = true;
      const nearLatitude = customerLatValue;
      const nearLongitude = customerLonValue;
      const maxDistanceMeters = 200 * 1000;
      const geoPipeline: any[] = [
        {
          $geoNear: {
            near: {
              type: "Point",
              coordinates: [nearLongitude, nearLatitude],
            },
            distanceField: "geoDistanceMeters",
            spherical: true,
            maxDistance: maxDistanceMeters,
            query: filter,
            key: "distance.location",
          },
        },
      ];

      if (customerCountryValue) {
        // Prefer matching by normalized countryCode (ISO 3166-1 alpha-2).
        // The customer value may be a name ("belgium") or a code ("be"), so
        // both spellings are accepted. Fall back to regex on address for
        // backwards compatibility.
        const countryCodeUpper = customerCountryValue.toUpperCase();
        const mappedCountryCode = getCountryCode(customerCountryValue);
        const acceptedCountryCodes =
          mappedCountryCode && mappedCountryCode !== countryCodeUpper
            ? [countryCodeUpper, mappedCountryCode]
            : [countryCodeUpper];
        const countryRegex = new RegExp(escapeRegExp(customerCountryValue), "i");
        // noBorders=true means "don't cross borders" (stay in same country)
        // noBorders=false means project can serve customers across borders
        geoPipeline.push({
          $match: {
            $or: [
              // Projects that CAN cross borders (noBorders is false or not set)
              { "distance.noBorders": { $ne: true } },
              // Projects that CANNOT cross borders must match customer's country
              {
                $and: [
                  { "distance.noBorders": true },
                  {
                    $or: [
                      { "distance.countryCode": { $in: acceptedCountryCodes } },
                      // Fallback: match address if countryCode not set
                      {
                        $and: [
                          { "distance.countryCode": { $exists: false } },
                          { "distance.address": countryRegex },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
      }

      geoPipeline.push({
        $match: {
          $expr: {
            // Coerce the radius defensively: a non-numeric maxKmRange on any
            // single project must not fail the whole geo search ($multiply
            // throws on strings), and numeric strings still match.
            $lte: [
              "$geoDistanceMeters",
              { $multiply: [{ $convert: { input: "$distance.maxKmRange", to: "double", onError: null, onNull: null } }, 1000] },
            ],
          },
        },
      });

      if (locationValue) {
        geoPipeline.push({
          $addFields: {
            locationExactMatch: {
              $eq: [
                { $toLower: { $ifNull: ["$distance.address", ""] } },
                locationValue,
              ],
            },
          },
        });
        geoPipeline.push({
          $sort: {
            locationExactMatch: -1,
            createdAt: -1,
            _id: 1,
          },
        });
      } else {
        geoPipeline.push({ $sort: { createdAt: -1, _id: 1 } });
      }

      geoPipeline.push({
        $project: {
          geoDistanceMeters: 0,
          locationExactMatch: 0,
        },
      });

      if (needsFullSet) {
        projects = await Project.aggregate(geoPipeline);
        // $geoNear only sees projects with geocoded coordinates. Projects
        // without a usable distance.location never match, whatever their
        // radius is — fall back to the same address matching as the non-geo
        // path so a small-radius project on the same street is still found
        // (client bug list #20).
        try {
          const unlocated = await Project.find({
            $and: [
              filter,
              {
                $or: [
                  { "distance.location": { $exists: false } },
                  { "distance.location.coordinates.1": { $exists: false } },
                ],
              },
            ],
          }).lean();
          const seen = new Set(projects.map((project: any) => String(project._id)));
          // The radius of an unlocated project cannot be verified, so only a
          // street-level address match qualifies (city alone is not enough).
          // Without a street-level part the project stays excluded.
          const streetPart = locationParts.length > 0 ? locationParts[0] : '';
          const fallbackMatches = streetPart
            ? unlocated.filter(
              (project: any) =>
                !seen.has(String(project._id)) &&
                normalizeValue(project.distance?.address).includes(streetPart) &&
                projectMatchesCustomerAddress(project, locationParts, customerCountryValue)
            )
            : [];
          fallbackMatches.sort(
            (a: any, b: any) =>
              new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime() ||
              String(a._id).localeCompare(String(b._id))
          );
          projects = [...projects, ...fallbackMatches];
        } catch (fallbackError) {
          console.error("Project geo address-fallback failed:", fallbackError);
        }
        total = projects.length;
      } else {
        geoPipeline.push({
          $facet: {
            results: [{ $skip: skip }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        });

        const [geoResult] = await Project.aggregate(geoPipeline);
        projects = geoResult?.results ?? [];
        total = geoResult?.total?.[0]?.count ?? 0;
      }
    } else if (hasLocationFilter) {
      projects = await baseQuery.lean();
      total = projects.length;
      // Performance warning: location filtering loads all projects into memory
      if (total > 500) {
        console.warn(
          `[Search Performance] Location filter returned ${total} projects for in-memory filtering. ` +
          `Consider implementing geospatial indexes for better scalability.`
        );
      }
    } else if (needsFullSet) {
      projects = await Project.find(filter).sort({ createdAt: -1, _id: 1 }).lean();
      total = projects.length;
    } else {
      [projects, total] = await Promise.all([
        baseQuery.skip(skip).limit(limit).lean(),
        Project.countDocuments(filter),
      ]);
    }

    console.log("[SEARCH] Found", total, "projects, returning", projects.length);

    if (hasLocationFilter && !usedGeoSearch) {
      filteredResults = projects.filter((project: any) =>
        projectMatchesCustomerAddress(project, locationParts, customerCountryValue)
      );

      if (locationValue) {
        const exactMatches = filteredResults.filter((project: any) => {
          const projectAddress = normalizeValue(project.distance?.address);
          return projectAddress === locationValue;
        });
        const otherMatches = filteredResults.filter((project: any) => {
          const projectAddress = normalizeValue(project.distance?.address);
          return projectAddress !== locationValue;
        });
        filteredResults = [...exactMatches, ...otherMatches];
      }
    }

    let locationCandidates: any[] = filteredResults ?? projects;
    const locationProfessionalIds = Array.from(new Set(locationCandidates.map((project: any) => toObjectIdString(project.professionalId)).filter(Boolean)));
    const professionalsData: any[] = [];
    for (let index = 0; index < locationProfessionalIds.length; index += SEARCH_BATCH_SIZE) {
      const professionals = await User.find({ _id: { $in: locationProfessionalIds.slice(index, index + SEARCH_BATCH_SIZE) } })
        .select("name username email businessInfo.description businessInfo.city businessInfo.country businessInfo.website businessInfo.timezone hourlyRate currency profileImage professionalLevel adminTags createdAt companyAvailability companyBlockedDates companyBlockedRanges")
        .lean();
      professionalsData.push(...professionals);
    }
    const professionalMap = new Map(professionalsData.map((person: any) => [person._id.toString(), person]));
    const scheduleResults = new Map<string, { main: any; subprojects: any[]; matchesWindow: boolean }>();

    if (startDateFrom || startDateTo) {
      const hasDateWindow = true;
      const chunks: any[][] = [];
      for (let index = 0; index < locationCandidates.length; index += 8) chunks.push(locationCandidates.slice(index, index + 8));
      for (const chunk of chunks) {
        await Promise.all(chunk.map(async (project: any) => {
          const professionalId = toObjectIdString(project.professionalId);
          const professional = professionalId ? professionalMap.get(professionalId) : null;
          if (!professional) return;
          const timezone = resolveEffectiveScheduleTimeZone(professional);
          const lowerDate = startDateFrom ? DateTime.fromISO(startDateFrom.toISOString().slice(0, 10), { zone: timezone }).startOf("day") : null;
          const boundedProfessional = lowerDate && lowerDate.toMillis() > DateTime.now().setZone(timezone).startOf("day").toMillis()
            ? { ...professional, companyBlockedRanges: [...(professional.companyBlockedRanges || []), { startDate: new Date(), endDate: lowerDate.minus({ milliseconds: 1 }).toUTC().toJSDate(), reason: "search-date-lower-bound" }] }
            : professional;
          const packages = Array.isArray(project.subprojects) ? project.subprojects : [];
          const proposalsFor = async (subprojectIndex?: number) => {
            const subproject = typeof subprojectIndex === "number" ? packages[subprojectIndex] : null;
            const minQuantity = Math.max(1, Number(subproject?.pricing?.minOrderQuantity) || 1);
            const quantity = subproject?.pricing?.type === "unit" && subproject?.pricing?.durationBasis === "per_unit" ? minQuantity : 1;
            return buildProjectScheduleProposalsWithData(project, boundedProfessional, subprojectIndex, undefined, undefined, quantity);
          };
          const mainIndex = !project.executionDuration?.value && packages.length > 0 ? 0 : undefined;
          const main = await proposalsFor(mainIndex);
          const subprojectProposals = await Promise.all(packages.map((_subproject: any, index: number) => proposalsFor(index)));
          const availableDates = packages.length ? subprojectProposals : [main];
          const matchesDate = availableDates.some((proposal: any) => {
            if (!proposal?.earliestBookableDate) return false;
            const localDay = DateTime.fromJSDate(new Date(proposal.earliestBookableDate), { zone: timezone }).toISODate();
            if (!localDay) return false;
            const lower = startDateFrom?.toISOString().slice(0, 10);
            const upper = startDateTo?.toISOString().slice(0, 10);
            return (!lower || localDay >= lower) && (!upper || localDay <= upper);
          });
          if (hasDateWindow && matchesDate) {
            scheduleResults.set(project._id.toString(), { main, subprojects: subprojectProposals, matchesWindow: true });
          } else if (hasDateWindow) {
            scheduleResults.set(project._id.toString(), { main, subprojects: subprojectProposals, matchesWindow: false });
          }
        }));
      }
      locationCandidates = locationCandidates.filter((project: any) => scheduleResults.get(project._id.toString())?.matchesWindow);
    }

    const candidateResults = locationCandidates.filter((project: any) => projectMatchesDimensions(project, dimensions));
    let baseResults: any[] = candidateResults;
    let projectRatingMap: Map<string, { avgRating: number; totalReviews: number }> | null = null;

    if (needsFullSet) {
      const workingIds = locationCandidates.map((p: any) => p._id).filter(Boolean);
      projectRatingMap = await aggregateProjectRatingsInBatches(workingIds);
      if (minRating > 0) {
        baseResults = baseResults.filter((p: any) => {
          const r = projectRatingMap!.get(p._id?.toString());
          return (r?.avgRating || 0) >= minRating;
        });
      }
      if (isPopularitySort) {
        baseResults.sort((a: any, b: any) => {
          const aKey = a._id?.toString() || "";
          const bKey = b._id?.toString() || "";
          const aR = projectRatingMap!.get(aKey)?.totalReviews || 0;
          const bR = projectRatingMap!.get(bKey)?.totalReviews || 0;
          if (bR !== aR) return bR - aR;
          const aAvg = projectRatingMap!.get(aKey)?.avgRating || 0;
          const bAvg = projectRatingMap!.get(bKey)?.avgRating || 0;
          if (bAvg !== aAvg) return bAvg - aAvg;
          return aKey.localeCompare(bKey);
        });
      }
    }

    const facetDimensions: Array<[keyof ProjectSearchDimensions, string]> = [
      ["services", "services"], ["geographicArea", "geographicArea"],
      ["priceModels", "priceModels"], ["projectTypes", "projectTypes"],
      ["includedItems", "includedItems"], ["areasOfWork", "areasOfWork"],
      ["priceMin", "price"], ["priceMax", "price"], ["category", "categories"],
    ];
    const facetOwnerMatches = (project: any, omit: "levels" | "tags" | null = null, includeRating = true) => {
      const professional = professionalMap.get(toObjectIdString(project.professionalId));
      if (!professional) return false;
      if (includeRating && minRating > 0 && (projectRatingMap?.get(project._id.toString())?.avgRating || 0) < minRating) return false;
      if (omit !== "levels" && professionalLevels.length && !professionalLevels.some((value) => normalizeSearchValue(value) === normalizeSearchValue(professional.professionalLevel))) return false;
      if (omit !== "tags" && adminTags.length && !adminTags.some((value) => (professional.adminTags || []).some((tag: string) => normalizeSearchValue(value) === normalizeSearchValue(tag)))) return false;
      return true;
    };
    const facetProjects = new Map<string, any[]>();
    for (const [dimension, facetName] of facetDimensions) {
      if (!dimensions[dimension] || (Array.isArray(dimensions[dimension]) && (dimensions[dimension] as string[]).length === 0)) {
        facetProjects.set(facetName, candidateResults.filter((project: any) => facetOwnerMatches(project)));
        continue;
      }
      const withoutFacet = dimension === "priceMin" || dimension === "priceMax"
        ? { ...dimensions, priceMin: undefined, priceMax: undefined }
        : { ...dimensions, [dimension]: undefined };
      facetProjects.set(facetName, locationCandidates.filter((project: any) => projectMatchesDimensions(project, withoutFacet) && facetOwnerMatches(project)));
    }
    const filteredByOwner = candidateResults.filter((project: any) => facetOwnerMatches(project, null, false));
    baseResults = filteredByOwner.filter((project: any) => minRating === 0 || (projectRatingMap?.get(project._id.toString())?.avgRating || 0) >= minRating);
    if (isPopularitySort) {
      baseResults.sort((a: any, b: any) => {
        const aRating = projectRatingMap?.get(a._id.toString()) || { avgRating: 0, totalReviews: 0 };
        const bRating = projectRatingMap?.get(b._id.toString()) || { avgRating: 0, totalReviews: 0 };
        return bRating.totalReviews - aRating.totalReviews || bRating.avgRating - aRating.avgRating || a._id.toString().localeCompare(b._id.toString());
      });
    }

    const countDistinctProjectValues = (rows: any[], extract: (project: any) => unknown[]) => {
      const counts: Record<string, number> = {};
      const labels = new Map<string, string>();
      for (const project of rows) {
        const seen = new Set<string>();
        for (const value of extract(project)) {
          const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
          const key = normalizeSearchValue(label);
          if (!key) continue;
          labels.set(key, labels.get(key) || label);
          seen.add(key);
        }
        for (const key of seen) {
          const label = labels.get(key)!;
          counts[label] = (counts[label] || 0) + 1;
        }
      }
      return counts;
    };
    const facetResults: any = {
      categories: countDistinctProjectValues(facetProjects.get("categories") || candidateResults, (p) => [p.category]),
      services: countDistinctProjectValues(facetProjects.get("services") || candidateResults, (p) => [p.service, ...(p.services || []).map((s: any) => s?.name || s?.service || s?.serviceName)]),
      areasOfWork: countDistinctProjectValues(facetProjects.get("areasOfWork") || candidateResults, (p) => [p.areaOfWork, ...(p.services || []).map((s: any) => s?.areaOfWork)]),
      priceModels: countDistinctProjectValues(facetProjects.get("priceModels") || candidateResults, (p) => {
        const packages = p.subprojects?.length ? p.subprojects : [{ pricing: p.pricing || { type: p.priceModel } }];
        return packages.filter((subproject: any) => projectMatchesPrice({ subprojects: [subproject] }, { ...dimensions, priceModels: undefined })).map((subproject: any) => subproject.pricing?.type);
      }),
      projectTypes: countDistinctProjectValues(facetProjects.get("projectTypes") || candidateResults, (p) => (p.subprojects || []).flatMap((s: any) => s?.projectType || [])),
      includedItems: countDistinctProjectValues(facetProjects.get("includedItems") || candidateResults, (p) => (p.subprojects || []).flatMap((s: any) => (s?.included || []).map((i: any) => i?.name))),
      professionalLevels: {},
      adminTags: {},
      minRating: { any: filteredByOwner.length, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    };
    const levelRows = candidateResults.filter((project: any) => facetOwnerMatches(project, "levels"));
    const tagRows = candidateResults.filter((project: any) => facetOwnerMatches(project, "tags"));
    facetResults.professionalLevels = countDistinctProjectValues(levelRows, (p) => {
      const professional = professionalMap.get(toObjectIdString(p.professionalId));
      return [professional?.professionalLevel];
    });
    facetResults.adminTags = countDistinctProjectValues(tagRows, (p) => {
      const professional = professionalMap.get(toObjectIdString(p.professionalId));
      return professional?.adminTags || [];
    });
    for (const threshold of [1, 2, 3, 4, 5]) {
      facetResults.minRating[String(threshold)] = filteredByOwner.filter((project: any) => (projectRatingMap?.get(project._id.toString())?.avgRating || 0) >= threshold).length;
    }
    const selectedFacetValues: Array<[Record<string, number>, string[]]> = [
      [facetResults.professionalLevels, professionalLevels], [facetResults.adminTags, adminTags],
      [facetResults.services, services], [facetResults.areasOfWork, areasOfWork],
      [facetResults.priceModels, priceModels], [facetResults.projectTypes, projectTypes],
      [facetResults.includedItems, includedItems], [facetResults.categories, category ? [category] : []],
    ];
    for (const [counts, values] of selectedFacetValues) for (const value of values) {
      if (!Object.keys(counts).some((candidate) => normalizeSearchValue(candidate) === normalizeSearchValue(value))) counts[value] = 0;
    }
    if (!isPopularitySort && !usedGeoSearch) {
      if (isRelevanceSort(sortBy)) {
        // Client bug list #4a: the default / "Most relevant" sort ranks by a
        // real relevance score (level, admin tags, keyword/service/category
        // match, rating, reviews). Any other explicit sort keeps the legacy
        // newest-first behaviour. Sorting happens before the pagination slice
        // below, so totals stay consistent.
        const levelConfig = await getCachedLevelConfig().catch(() => null);
        const rankByLevelName = new Map(
          ((levelConfig as any)?.levels || []).map((level: any) => [level.name, Number(level.order) || 0]),
        );
        const queryText = typeof query === 'string' ? query : '';
        const ranked = sortProjectsByRelevance(
          baseResults.map((project: any) => ({
            project,
            professional: professionalMap.get(toObjectIdString(project.professionalId)),
            rating: projectRatingMap?.get(project._id.toString()),
          })),
          {
            query: queryText,
            category,
            services,
            levelRankOf: (levelName) => (rankByLevelName.get(levelName || '') as number) || 0,
          },
        );
        baseResults = ranked.map(({ project }) => project);
      } else {
        baseResults.sort((a: any, b: any) => (new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()) || a._id.toString().localeCompare(b._id.toString()));
      }
    }
    const totalCount = baseResults.length;
    const finalResults = baseResults.slice(skip, skip + limit);

    // Aggregate ratings per project (not per professional)
    if (!projectRatingMap) {
      const projectIds = finalResults.map((p: any) => p._id).filter(Boolean);
      projectRatingMap = await aggregateProjectRatingsInBatches(projectIds);
    }

    const shouldLogAvailability = process.env.NODE_ENV !== "production";
    const getSearchQuantity = (project: any, subprojectIndex?: number) => {
      const subproject = typeof subprojectIndex === "number" ? project.subprojects?.[subprojectIndex] : null;
      const minQuantity = Math.max(1, Number(subproject?.pricing?.minOrderQuantity) || 1);
      return subproject?.pricing?.type === "unit" && subproject?.pricing?.durationBasis === "per_unit" ? minQuantity : 1;
    };

    const resultsWithAvailability = await Promise.all(
      finalResults.map(async (project: any) => {
        try {
          // Get professional from pre-loaded map
          const profId = toObjectIdString(project.professionalId);
          const professional = profId ? professionalMap.get(profId) : null;

          if (!professional) {
            if (shouldLogAvailability) {
              console.warn("[SEARCH] Missing professional for availability", {
                projectId: project?._id?.toString?.() || project?._id,
                professionalId: project.professionalId,
              });
            }
            return project;
          }

          const projectIdStr = project._id?.toString?.() || project._id;
          const cachedSchedule = scheduleResults.get(projectIdStr);
          const projectRatings = projectRatingMap.get(projectIdStr) || { avgRating: 0, totalReviews: 0 };
          const professionalSummary = {
            _id: professional._id,
            name: professional.name,
            username: professional.username,
            email: professional.email,
            businessInfo: professional.businessInfo,
            hourlyRate: professional.hourlyRate,
            currency: professional.currency,
            profileImage: professional.profileImage,
            professionalLevel: professional.professionalLevel,
            adminTags: professional.adminTags || [],
            createdAt: professional.createdAt,
          };

          // Get main project availability - use first subproject
          const hasMainDuration = project.executionDuration?.value;
          const defaultSubprojectIndex = (!hasMainDuration && project.subprojects?.length > 0) ? 0 : undefined;
          const proposals = cachedSchedule?.main ?? await buildProjectScheduleProposalsWithData(
            project,
            professional,
            defaultSubprojectIndex,
            undefined,
            undefined,
            getSearchQuantity(project, defaultSubprojectIndex)
          );
          if (!proposals && shouldLogAvailability) {
            console.warn("[SEARCH] Missing main proposals", {
              projectId: project?._id?.toString?.() || project?._id,
              executionDuration: project?.executionDuration,
              timeMode: project?.timeMode,
              subprojectIndex: defaultSubprojectIndex ?? null,
            });
          }

          // Get availability for each subproject (reuse pre-loaded professional)
          const subprojectsWithAvailability = await Promise.all(
            (project.subprojects || []).map(async (subproject: any, index: number) => {
              try {
                const subprojectProposals = cachedSchedule?.subprojects[index] ?? await buildProjectScheduleProposalsWithData(
                  project,
                  professional,
                  index,
                  undefined,
                  undefined,
                  getSearchQuantity(project, index)
                );
                if (!subprojectProposals && shouldLogAvailability) {
                  console.warn("[SEARCH] Missing subproject proposals", {
                    projectId: project?._id?.toString?.() || project?._id,
                    subprojectIndex: index,
                    subprojectName: subproject?.name,
                    executionDuration: subproject?.executionDuration,
                  });
                }
                return {
                  ...subproject,
                  firstAvailableDate: subprojectProposals?.earliestBookableDate || null,
                  firstAvailableWindow: subprojectProposals?.earliestProposal
                    ? {
                      start: subprojectProposals.earliestProposal.start,
                      end: subprojectProposals.earliestProposal.executionEnd || subprojectProposals.earliestProposal.end,
                    }
                    : null,
                  shortestThroughputWindow: subprojectProposals?.shortestThroughputProposal
                    ? {
                      start: subprojectProposals.shortestThroughputProposal.start,
                      end: subprojectProposals.shortestThroughputProposal.executionEnd || subprojectProposals.shortestThroughputProposal.end,
                    }
                    : null,
                };
              } catch {
                return subproject;
              }
            })
          );

          return {
            ...project,
            professionalId: professionalSummary,
            projectAvgRating: projectRatings.avgRating,
            projectTotalReviews: projectRatings.totalReviews,
            subprojects: subprojectsWithAvailability,
            firstAvailableDate: proposals?.earliestBookableDate || null,
            firstAvailableWindow: proposals?.earliestProposal
              ? {
                start: proposals.earliestProposal.start,
                end: proposals.earliestProposal.executionEnd || proposals.earliestProposal.end,
              }
              : null,
            shortestThroughputWindow: proposals?.shortestThroughputProposal
              ? {
                start: proposals.shortestThroughputProposal.start,
                end: proposals.shortestThroughputProposal.executionEnd || proposals.shortestThroughputProposal.end,
              }
              : null,
          };
        } catch (error) {
          console.error("Failed to build schedule proposals:", error);
          return project;
        }
      })
    );

    res.json({
      results: resultsWithAvailability,
      facets: facetResults,
      pagination: {
        total: totalCount,
        page: Math.ceil(skip / limit) + 1,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (error) {
    console.error("Project search error:", error);
    res.status(500).json({ error: "Failed to search projects" });
  }
}

/**
 * Autocomplete endpoint for search suggestions
 */
export const autocomplete = async (req: Request, res: Response) => {
  try {
    const { q = "", type = "professionals" } = req.query;
    if (typeof q !== "string" || q.length > 300 || typeof type !== "string") {
      return res.status(400).json({ error: "Invalid autocomplete query" });
    }

    if (!q || (q as string).trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    const searchRegex = new RegExp(escapeSearchRegex(q.trim()), "i");

    if (type === "professionals") {
      const professionals = await User.find({
        role: "professional",
        professionalStatus: "approved",
        deletedAt: null,
        isAnonymized: { $ne: true },
        $or: [
          { name: searchRegex },
          { username: searchRegex },
        ],
      })
        .select("name username")
        .limit(10)
        .lean();

      const suggestions = professionals.map((p: any) => ({
        type: "professional",
        value: p.username || p.name,
        label: p.username || p.name,
      }));

      // Also get service category suggestions
      const uniqueCategories = await User.distinct("serviceCategories", {
        role: "professional",
        professionalStatus: "approved",
        deletedAt: null,
        isAnonymized: { $ne: true },
        serviceCategories: searchRegex,
      });

      const categorysuggestions = uniqueCategories
        .slice(0, 5)
        .map((cat: string) => ({
          type: "category",
          value: cat,
          label: cat,
        }));

      return res.json({
        suggestions: [...suggestions, ...categorysuggestions].slice(0, 10),
      });
    } else if (type === "projects") {
      // Get project title and service suggestions
      const projects = await Project.find({
        status: "published",
        $or: [{ title: searchRegex }, { service: searchRegex }],
      })
        .select("title service category")
        .limit(10)
        .lean();

      const suggestions = projects.map((p: any) => ({
        type: "project",
        value: p.title,
        label: `${p.title} (${p.service || p.category})`,
      }));

      return res.json({ suggestions });
    } else {
      return res.status(400).json({ error: "Invalid type" });
    }
  } catch (error) {
    console.error("Autocomplete error:", error);
    res.status(500).json({ error: "Failed to get suggestions" });
  }
};
