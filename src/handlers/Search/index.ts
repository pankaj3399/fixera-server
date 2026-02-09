import { Request, Response } from "express";
import { Types } from "mongoose";
import User from "../../models/user";
import Project from "../../models/project";
import { buildProjectScheduleProposalsWithData } from "../../utils/scheduleEngine";

    // For projects without subprojects
    if (!subprojects.length) {
      incrementFacetCount(facets.categories, project.category);
      incrementFacetCount(facets.services, project.service);
      incrementFacetCount(facets.areasOfWork, project.areaOfWork);
      incrementFacetCount(facets.priceModels, project.priceModel);
      return;
    }

    // Use Sets to track unique values per project (so each project is only counted once)
    const projectCategories = new Set<string>();
    const projectServices = new Set<string>();
    const projectAreasOfWork = new Set<string>();
    const projectPriceModels = new Set<string>();
    const projectProjectTypes = new Set<string>();
    const projectIncludedItems = new Set<string>();

    subprojects.forEach((sub: any) => {
      // Collect unique categories and services
      const category = normalizeFacetValue(project.category);
      if (category) projectCategories.add(category);

      const service = normalizeFacetValue(project.service);
      if (service) projectServices.add(service);

      // Collect unique areas of work
      const projectArea = normalizeFacetValue(project.areaOfWork);
      if (projectArea) {
        projectAreasOfWork.add(projectArea);
      }
      const serviceSelections = Array.isArray(project.services) ? project.services : [];
      serviceSelections.forEach((svc: any) => {
        const svcArea = normalizeFacetValue(svc?.areaOfWork);
        if (svcArea) {
          projectAreasOfWork.add(svcArea);
        }
      });

      // Collect unique price models
      const priceType = sub?.pricing?.type ? String(sub.pricing.type).toLowerCase() : undefined;
      const priceModel = normalizeFacetValue(priceType || project.priceModel);
      if (priceModel) projectPriceModels.add(priceModel);

      // Collect unique project types
      const projectTypeValues = Array.isArray(sub?.projectType) ? sub.projectType : [];
      projectTypeValues.forEach((type: string) => {
        const normalized = normalizeFacetValue(type);
        if (normalized) projectProjectTypes.add(normalized);
      });

      // Collect unique included items
      const includedItems = Array.isArray(sub?.included) ? sub.included : [];
      includedItems.forEach((item: any) => {
        const itemName = normalizeFacetValue(item?.name);
        if (itemName) projectIncludedItems.add(itemName);
      });
    });

    const projectLevelPriceModel = normalizeFacetValue(project.priceModel);
    if (projectLevelPriceModel) {
      projectPriceModels.add(projectLevelPriceModel);
    }

    // Now increment facet counts once per unique value per project
    projectCategories.forEach((value) => incrementFacetCount(facets.categories, value));
    projectServices.forEach((value) => incrementFacetCount(facets.services, value));
    projectAreasOfWork.forEach((value) => incrementFacetCount(facets.areasOfWork, value));
    projectPriceModels.forEach((value) => incrementFacetCount(facets.priceModels, value));
    projectProjectTypes.forEach((value) => incrementFacetCount(facets.projectTypes, value));
    projectIncludedItems.forEach((value) => incrementFacetCount(facets.includedItems, value));
  });
  return facets;
};
export { getPopularServices } from "./getPopularServices";
/**
 * Unified search endpoint for professionals and projects
 * Supports filtering by query, location, price range, category, and availability
 */
export const search = async (req: Request, res: Response) => {
  try {
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
      // New filters
      services,
      geographicArea,
      priceModel,
      projectTypes,
      includedItems,
      areaOfWork,
      startDateFrom,
      startDateTo,
      // Customer location for distance filtering
      customerLat,
      customerLon,
      customerCity,
      customerState,
      customerCountry,
      customerAddress,
    } = req.query;

    console.log("Search request:", { q, loc, type, priceMin, priceMax, category, availability, customerLat, customerLon, customerCountry, customerState, customerCity, customerAddress, page, limit });

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;
    // Build customer location object if coordinates or location info provided
    let customerLocation: LocationInfo | null = null;
    if (customerLat && customerLon) {
      customerLocation = {
        coordinates: {
          latitude: parseFloat(customerLat as string),
          longitude: parseFloat(customerLon as string)
        },
        city: customerCity as string,
        state: customerState as string | undefined,
        country: customerCountry as string,
        address: customerAddress as string
      };
      customerLocation = enhanceLocationInfo(customerLocation);
    } else if (customerCity && customerCountry) {
      // Try to get approximate coordinates
      const approxCoords = getApproximateCoordinates(
        customerCity as string,
        customerCountry as string,
        customerState as string | undefined
      );
      customerLocation = {
        coordinates: approxCoords || undefined,
        city: customerCity as string,
        state: customerState as string | undefined,
        country: customerCountry as string,
        countryCode: getCountryCode(customerCountry as string),
        address: customerAddress as string
      };
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
        sortBy as string,
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
        skip,
        limitNum,
        // New filters
        services as string | undefined,
        geographicArea as string | undefined,
        priceModel as string | undefined,
        projectTypes as string | undefined,
        includedItems as string | undefined,
        startDateFrom as string | undefined,
        startDateTo as string | undefined,
        areaOfWork as string | undefined,
        // Customer location for distance filtering
        customerLocation
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
  sortBy: string,
  skip: number,
  limit: number
) {
  try {
    const pageSize = Math.max(1, limit);
    // Build the filter object
    const filter: any = {
      role: "professional",
      professionalStatus: "approved",
    };
    // Search query - search in name, company name, and service categories
    if (query && query.trim()) {
      const searchRegex = new RegExp(query.trim(), "i");
      filter.$or = [
        { name: searchRegex },
        { "businessInfo.companyName": searchRegex },
        { serviceCategories: searchRegex },
      ];
    }
    // Note: Location filter is applied as prioritization after query, not as database filter
    // This ensures all professionals are shown regardless of location
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
    // Determine sort order
    let sortOption: any = { createdAt: -1 }; // default: newest
    switch (sortBy) {
      case 'price_low':
        sortOption = { hourlyRate: 1 };
        break;
      case 'price_high':
        sortOption = { hourlyRate: -1 };
        break;
      case 'newest':
        sortOption = { createdAt: -1 };
        break;
      case 'popularity':
        // TODO: Implement popularity sorting in future phase (reviews + bookings)
        sortOption = { createdAt: -1 }; // Fallback to newest for now
        break;
      case 'relevant':
      default:
        sortOption = { createdAt: -1 }; // For professionals, relevant = newest
        break;
    }
    // Execute query with pagination
    console.log('🔍 Professional search filter:', JSON.stringify(filter, null, 2));
    console.log('🔍 Professional sort option:', sortOption);
    const [professionals, total] = await Promise.all([
      User.find(filter)
        .select(
          "name email businessInfo hourlyRate currency serviceCategories profileImage companyAvailability createdAt"
        )
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    console.log('✅ Found', total, 'professionals, returning', professionals.length);

    // If location filter is present, prioritize exact matches
    const hasAnyAvailability = (availability?: Record<string, any>) =>
      !!availability &&
      Object.values(availability).some(
        (day) => day?.available || day?.startTime || day?.endTime
      );

    let results = professionals.map((professional: any) => {
      const { companyAvailability, ...rest } = professional;
      return {
        ...rest,
        availability: hasAnyAvailability(companyAvailability),
      };
    });
    if (location && location.trim()) {
      const locationLower = location.toLowerCase();
      // Prioritize professionals where location matches
      const matchingLocation = professionals.filter((p: any) => {
        if (!p.businessInfo) return false;
        const city = p.businessInfo.city?.toLowerCase() || "";
        const country = p.businessInfo.country?.toLowerCase() || "";
        return city.includes(locationLower) || country.includes(locationLower);
      });
      const otherProfessionals = professionals.filter((p: any) => {
        if (!p.businessInfo) return true; // Include if no location info
        const city = p.businessInfo.city?.toLowerCase() || "";
        const country = p.businessInfo.country?.toLowerCase() || "";
        return !city.includes(locationLower) && !country.includes(locationLower);
      });
      // Show location matches first, then all others
      results = [...matchingLocation, ...otherProfessionals];
      console.log('📍 Location prioritization:', matchingLocation.length, 'matching location,', otherProfessionals.length, 'other locations');
    }
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
  skip: number,
  limit: number,
  // New filters
  services: string | undefined,
  geographicArea: string | undefined,
  priceModel: string | undefined,
  projectTypes: string | undefined,
  includedItems: string | undefined,
  startDateFrom: string | undefined,
  startDateTo: string | undefined,
  areaOfWork: string | undefined,
  // Customer location for distance filtering
  customerLocation: LocationInfo | null
) {
  try {
    const pageSize = Math.max(1, limit);

    // Build the filter object
    const filter: any = {
      // Only show published projects to customers
      status: "published",
    };
    // Search query - search in title, description, category, service, areaOfWork, and keywords
    if (query && query.trim()) {
      const searchRegex = new RegExp(query.trim(), "i");
      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
        { service: searchRegex },
        { areaOfWork: searchRegex },
        { keywords: searchRegex },
      ];
    }
    // Category filter
    if (category && category.trim()) {
      filter.category = new RegExp(category.trim(), "i");
    }
    // Services filter - match against service or services array
    if (services && services.trim()) {
      const servicesList = services.split(',').map(s => s.trim());
      const serviceRegexes = servicesList.map(s => new RegExp(s, "i"));
      // Create separate $or for services to avoid conflicts
      const servicesCondition = {
        $or: [
          { service: { $in: serviceRegexes } },
          { 'services.service': { $in: serviceRegexes } }
        ]
      };
      filter.$and = filter.$and || [];
      filter.$and.push(servicesCondition);
    }
    // Price Model filter
    if (priceModel && priceModel.trim()) {
      const priceModelsList = priceModel.split(',').map(pm => pm.trim());
      // Check both project-level priceModel and subproject pricing.type
      const priceModelCondition = {
        $or: [
          { priceModel: { $in: priceModelsList } },
          { 'subprojects.pricing.type': { $in: priceModelsList } }
        ]
      };
      filter.$and = filter.$and || [];
      filter.$and.push(priceModelCondition);
    }
    // Project Types filter - match against subproject projectType array
    if (projectTypes && projectTypes.trim()) {
      const projectTypesList = projectTypes.split(',').map(pt => pt.trim());
      const projectTypeRegexes = projectTypesList.map(pt => new RegExp(pt, "i"));
      filter['subprojects.projectType'] = { $in: projectTypeRegexes };
    }
    // Included Items filter - match against subproject included array
    if (includedItems && includedItems.trim()) {
      const includedItemsList = includedItems.split(',').map(item => item.trim());
      // Match items in the included array (checking the 'name' field of each item)
      const includedConditions = includedItemsList.map(item => ({
        'subprojects.included': {
          $elemMatch: { name: new RegExp(item, "i") }
        }
      }));
      filter.$and = filter.$and || [];
      filter.$and.push(...includedConditions);
    }
    // Area of Work filter - match against project areaOfWork or services array
    if (areaOfWork && areaOfWork.trim()) {
      const areasList = areaOfWork.split(',').map(area => area.trim()).filter(Boolean);
      if (areasList.length > 0) {
        const areaRegexes = areasList.map(area => new RegExp(area, "i"));
        const areaCondition = {
          $or: [
            { areaOfWork: { $in: areaRegexes } },
            { "services.areaOfWork": { $in: areaRegexes } }
          ]
        };
        filter.$and = filter.$and || [];
        filter.$and.push(areaCondition);
      }
    }
    // Price range filter - handle different pricing types in subprojects
    if (priceMin !== undefined || priceMax !== undefined) {
      const priceConditions: any[] = [];
      const minPrice = priceMin ? parseFloat(priceMin) : undefined;
      const maxPrice = priceMax ? parseFloat(priceMax) : undefined;
      if (minPrice && maxPrice) {
        // Check if fixed price is in range
        priceConditions.push({
          'subprojects.pricing.type': 'fixed',
          'subprojects.pricing.amount': { $gte: minPrice, $lte: maxPrice },
        });
        // Check if price range overlaps
        priceConditions.push({
          'subprojects.pricing.type': 'unit',
          'subprojects.pricing.priceRange.min': { $lte: maxPrice },
          'subprojects.pricing.priceRange.max': { $gte: minPrice },
        });
      } else if (minPrice) {
        priceConditions.push(
          {
            'subprojects.pricing.type': 'fixed',
            'subprojects.pricing.amount': { $gte: minPrice }
          },
          {
            'subprojects.pricing.type': 'unit',
            'subprojects.pricing.priceRange.max': { $gte: minPrice }
          }
        );
      } else if (maxPrice) {
        priceConditions.push(
          {
            'subprojects.pricing.type': 'fixed',
            'subprojects.pricing.amount': { $lte: maxPrice }
          },
          {
            'subprojects.pricing.type': 'unit',
            'subprojects.pricing.priceRange.min': { $lte: maxPrice }
          }
        );
      }
      if (priceConditions.length > 0) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: priceConditions });
      }
    }

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

    const getRawProfessionalId = (project: any) =>
      project.professionalId?._id?.toString?.() ||
      project.professionalId?.toString?.() ||
      project.professionalId;

    const escapeRegExp = (value: string) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    console.log('dY"? Project search filter:', JSON.stringify(filter, null, 2));

    const baseQuery = Project.find(filter).sort({ createdAt: -1 });

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
        // Prefer matching by normalized countryCode (ISO 3166-1 alpha-2)
        // Fall back to regex on address for backwards compatibility
        const countryCodeUpper = customerCountryValue.toUpperCase();
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
                      { "distance.countryCode": countryCodeUpper },
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
            $lte: [
              "$geoDistanceMeters",
              { $multiply: ["$distance.maxKmRange", 1000] },
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
          },
        });
      } else {
        geoPipeline.push({ $sort: { createdAt: -1 } });
      }

      geoPipeline.push({
        $project: {
          geoDistanceMeters: 0,
          locationExactMatch: 0,
        },
      });

      geoPipeline.push({
        $facet: {
          results: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      });

      const [geoResult] = await Project.aggregate(geoPipeline);
      projects = geoResult?.results ?? [];
      total = geoResult?.total?.[0]?.count ?? 0;
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
    } else {
      [projects, total] = await Promise.all([
        baseQuery.skip(skip).limit(limit).lean(),
        Project.countDocuments(filter),
      ]);
    }

    console.log("Found", total, "projects, returning", projects.length);

    if (hasLocationFilter && !usedGeoSearch) {
      filteredResults = projects.filter((project: any) => {
        const distance = project.distance || {};
        const projectAddress = normalizeValue(distance.address);
        const projectCountryCode = typeof distance.countryCode === "string" ? distance.countryCode : null;
        const noBorders = Boolean(distance.noBorders);

        // noBorders=true means "don't cross borders" (stay in same country)
        // When noBorders is true, only show to customers in matching country
        if (noBorders && customerCountryValue) {
          const customerCountryUpper = customerCountryValue.toUpperCase();
          // Prefer matching by countryCode, fallback to address matching
          const countryMatches = projectCountryCode
            ? projectCountryCode === customerCountryUpper
            : projectAddress?.includes(customerCountryValue);
          if (!countryMatches) {
            return false;
          }
        }

        if (!projectAddress) {
          return false;
        }

        if (locationParts.length === 0) {
          return false;
        }

        return locationParts.some((part) => projectAddress.includes(part));
      });

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

    const baseResults = filteredResults ?? projects;
    const totalCount = filteredResults ? baseResults.length : total;
    const finalResults = filteredResults ? baseResults.slice(skip, skip + limit) : baseResults;

    // Batch-load professionals for all published projects to avoid N+1 queries
    const publishedProjects = finalResults.filter((p: any) => p?.status === "published");
    const invalidProfessionalIds = new Set<string>();
    const professionalIdSet = new Set(
      publishedProjects
        .map((p: any) => {
          const raw = getRawProfessionalId(p);
          const id = toObjectIdString(p.professionalId);
          if (!id && raw) {
            invalidProfessionalIds.add(String(raw));
          }
          return id;
        })
        .filter(Boolean)
    );
    const professionalIds = Array.from(professionalIdSet);

    // Fetch all professionals in a single query
    const professionalsData = professionalIds.length > 0
      ? await User.find({ _id: { $in: professionalIds } })
        .select(
          "name email businessInfo hourlyRate currency profileImage companyAvailability companyBlockedDates companyBlockedRanges"
        )
        .lean()
      : [];

    // Create a lookup map for quick access
    const professionalMap = new Map(
      professionalsData.map((p: any) => [p._id.toString(), p])
    );
    const shouldLogAvailability = process.env.NODE_ENV !== "production";

    const resultsWithAvailability = await Promise.all(
      finalResults.map(async (project: any) => {
        if (project?.status !== "published") {
          return project;
        }

        try {
          // Get professional from pre-loaded map
          const rawProfessionalId = getRawProfessionalId(project);
          const profId = toObjectIdString(project.professionalId);
          const professional = profId ? professionalMap.get(profId) : null;

          if (!professional) {
            if (shouldLogAvailability) {
              console.warn("[SEARCH] Missing professional for availability", {
                projectId: project?._id?.toString?.() || project?._id,
                professionalId: rawProfessionalId,
              });
            }
            return project;
          }

          const professionalSummary = {
            _id: professional._id,
            name: professional.name,
            email: professional.email,
            businessInfo: professional.businessInfo,
            hourlyRate: professional.hourlyRate,
            currency: professional.currency,
            profileImage: professional.profileImage,
          };

          // Get main project availability - use first subproject
          const hasMainDuration = project.executionDuration?.value;
          const defaultSubprojectIndex = (!hasMainDuration && project.subprojects?.length > 0) ? 0 : undefined;
          const proposals = await buildProjectScheduleProposalsWithData(
            project,
            professional,
            defaultSubprojectIndex
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
                const subprojectProposals = await buildProjectScheduleProposalsWithData(
                  project,
                  professional,
                  index
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

    if (shouldLogAvailability && invalidProfessionalIds.size > 0) {
      console.warn("[SEARCH] Invalid professionalId values detected", {
        count: invalidProfessionalIds.size,
        ids: Array.from(invalidProfessionalIds).slice(0, 5),
      });
    }
    const totalResults = results.length;
    const safeStartIndex = Math.min(skip, Math.max(totalResults - pageSize, 0));
    const paginatedResults = results.slice(safeStartIndex, safeStartIndex + pageSize);
    const currentPage = Math.floor(safeStartIndex / pageSize) + 1;
    res.json({
      results: resultsWithAvailability,
      pagination: {
        total: totalCount,
        page: Math.ceil(skip / limit) + 1,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
      facets,
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
    if (!q || (q as string).trim().length < 2) {
      return res.json({ suggestions: [] });
    }
    const searchRegex = new RegExp((q as string).trim(), "i");
    if (type === "professionals") {
      // Get professional name and company name suggestions
      const professionals = await User.find({
        role: "professional",
        professionalStatus: "approved",
        $or: [
          { name: searchRegex },
          { "businessInfo.companyName": searchRegex },
        ],
      })
        .select("name businessInfo.companyName")
        .limit(10)
        .lean();
      const suggestions = professionals.map((p: any) => ({
        type: "professional",
        value: p.businessInfo?.companyName || p.name,
        label: p.businessInfo?.companyName
          ? `${p.businessInfo.companyName} (${p.name})`
          : p.name,
      }));
      // Also get service category suggestions
      const uniqueCategories = await User.distinct("serviceCategories", {
        role: "professional",
        professionalStatus: "approved",
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
      // Get project title, service, category, and areaOfWork suggestions
      const projects = await Project.find({
        status: "published",
        $or: [
          { title: searchRegex },
          { service: searchRegex },
          { category: searchRegex },
          { areaOfWork: searchRegex },
        ],
      })
        .select("title service category areaOfWork")
        .limit(10)
        .lean();
      const suggestions = projects.map((p: any) => ({
        type: "project",
        value: p.title,
        label: `${p.title} (${p.service || p.category}${p.areaOfWork ? ` - ${p.areaOfWork}` : ''})`,
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
