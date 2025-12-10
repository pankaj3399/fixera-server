import { Request, Response } from "express";
import User from "../../models/user";
import Project from "../../models/project";
import { calculateFirstAvailableDate } from "../Project/scheduling";
import {
  LocationInfo,
  getDistanceBetweenLocations,
  checkBorderCrossing,
  hasValidCoordinates
} from "../../utils/geolocation";
import {
  extractLocationFromUserLocation,
  extractLocationFromBusinessInfo,
  getProjectServiceLocation,
  enhanceLocationInfo,
  resolveCoordinates,
  getApproximateCoordinates,
  getCountryCode
} from "../../utils/geocoding";
type ProjectFacetCounts = {
  categories: Record<string, number>;
  services: Record<string, number>;
  areasOfWork: Record<string, number>;
  priceModels: Record<string, number>;
  projectTypes: Record<string, number>;
  includedItems: Record<string, number>;
};
const normalizeFacetValue = (value?: string | null) => {
  if (!value) return "";
  return value.trim();
};
const incrementFacetCount = (target: Record<string, number>, rawValue?: string | null) => {
  const normalized = normalizeFacetValue(rawValue);
  if (!normalized) return;
  target[normalized] = (target[normalized] || 0) + 1;
};
const buildProjectFacets = (projects: any[]): ProjectFacetCounts => {
  const facets: ProjectFacetCounts = {
    categories: {},
    services: {},
    areasOfWork: {},
    priceModels: {},
    projectTypes: {},
    includedItems: {},
  };
  projects.forEach((project: any) => {
    const subprojects = Array.isArray(project.subprojects) ? project.subprojects : [];

    // For projects without subprojects
    if (!subprojects.length) {
      incrementFacetCount(facets.categories, project.category);
      incrementFacetCount(facets.services, project.service);
      incrementFacetCount(facets.areasOfWork, project.areaOfWork);
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
      sortBy = "relevant", // sort option
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
      customerCountry,
      customerAddress,
    } = req.query;
    console.log('🔍 Search request:', {
      q, loc, type, priceMin, priceMax, category, availability, sortBy, page, limit,
      services, geographicArea, priceModel, projectTypes, includedItems, startDateFrom, startDateTo,
      customerLat, customerLon, customerCity, customerCountry, customerAddress
    });
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
        country: customerCountry as string,
        address: customerAddress as string
      };
      customerLocation = enhanceLocationInfo(customerLocation);
    } else if (customerCity && customerCountry) {
      // Try to get approximate coordinates
      const approxCoords = getApproximateCoordinates(
        customerCity as string,
        customerCountry as string
      );
      customerLocation = {
        coordinates: approxCoords || undefined,
        city: customerCity as string,
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
        sortBy as string,
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
      filter.availability = { $exists: true, $ne: null };
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
          "name email businessInfo hourlyRate currency serviceCategories profileImage availability createdAt"
        )
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    console.log('✅ Found', total, 'professionals, returning', professionals.length);
    if (professionals.length > 0) {
      console.log('📋 Sample professional names:', professionals.slice(0, 3).map((p: any) => p.name || p.businessInfo?.companyName));
    }
    // If location filter is present, prioritize by location but show all results
    let results = professionals;
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
  sortBy: string,
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
    // Determine sort order (only for database-level sorts, not availability or price)
    let sortOption: any = { createdAt: -1 }; // default: newest
    let useCustomSort = false;
    switch (sortBy) {
      case 'price_low':
      case 'price_high':
        // Will handle this after fetching projects (need to calculate min price from subprojects)
        useCustomSort = true;
        sortOption = { createdAt: -1 }; // Default sort for DB query
        break;
      case 'newest':
        sortOption = { createdAt: -1 };
        break;
      case 'availability':
        // Will handle this after calculating firstAvailableDate
        useCustomSort = true;
        sortOption = { createdAt: -1 }; // Default sort for DB query
        break;
      case 'popularity':
        // TODO: Implement popularity sorting in future phase (reviews + bookings)
        sortOption = { createdAt: -1 }; // Fallback to newest for now
        break;
      case 'relevant':
      default:
        sortOption = { createdAt: -1 }; // For projects, relevant = newest
        break;
    }
    // Execute query with pagination and populate professional info
    console.log('🔍 Project search filter:', JSON.stringify(filter, null, 2));
    console.log('🔍 Search query:', query);
    console.log('🔍 Location/Geographic Area:', geographicArea || location);
    console.log('🔍 Sort option:', sortOption);
    console.log('🔍 Use custom sort:', useCustomSort);
    console.log('🔍 New filters:', { services, priceModel, projectTypes, includedItems, startDateFrom, startDateTo });
    const projects = await Project.find(filter)
      .populate("professionalId", "name email businessInfo hourlyRate currency profileImage")
      .sort(sortOption)
      .lean();
    console.log('✅ Found', projects.length, 'projects before location filter');
    if (projects.length > 0) {
      console.log('📋 Sample project titles:', projects.slice(0, 3).map((p: any) => p.title));
      // Debug: Check for specific project with certifications
      const targetProject = projects.find((p: any) => p._id.toString() === '690f11684845e1a9c87b4313');
      if (targetProject) {
        console.log('🎯 Found target project 690f11684845e1a9c87b4313');
        console.log('🎯 Certifications:', (targetProject as any).certifications);
        console.log('🎯 Full project data:', targetProject);
      } else {
        console.log('❌ Target project 690f11684845e1a9c87b4313 NOT found in results');
      }
    }
    // Apply distance and border filtering if customer location is provided
    let filteredProjects = projects;
    if (customerLocation) {
      console.log('📍 Applying distance and border filtering with customer location');
      const projectsWithFiltering = await Promise.all(
        filteredProjects.map(async (project: any) => {
          try {
            // Get professional's service location
            const professionalLocation = await getProjectServiceLocation(
              project,
              project.professionalId
            );
            // Enhance location with country codes
            const enhancedProfLocation = enhanceLocationInfo(professionalLocation);
            const enhancedCustomerLocation = enhanceLocationInfo(customerLocation);
            // Try to resolve coordinates if not available
            if (!hasValidCoordinates(enhancedProfLocation)) {
              const coords = await resolveCoordinates(enhancedProfLocation);
              if (coords) {
                enhancedProfLocation.coordinates = coords;
              }
            }
            // Check distance filtering (only if both have coordinates)
            let distanceOk = true;
            let calculatedDistance: number | null = null;
            if (hasValidCoordinates(enhancedProfLocation) && hasValidCoordinates(enhancedCustomerLocation)) {
              calculatedDistance = getDistanceBetweenLocations(
                enhancedProfLocation,
                enhancedCustomerLocation
              );
              if (calculatedDistance !== null && project.distance?.maxKmRange) {
                distanceOk = calculatedDistance <= project.distance.maxKmRange;
                console.log(`📏 Project ${project.title}: ${calculatedDistance}km (max: ${project.distance.maxKmRange}km) - ${distanceOk ? 'OK' : 'FILTERED'}`);
              }
            }
            // Check border filtering
            let borderOk = true;
            if (project.distance) {
              borderOk = checkBorderCrossing(
                enhancedProfLocation,
                enhancedCustomerLocation,
                project.distance.noBorders || false,
                project.distance.borderLevel || 'country'
              );
              if (!borderOk) {
                console.log(`🚫 Project ${project.title}: Border crossing not allowed`);
              }
            }
            // Return project with filtering metadata
            return {
              project,
              distanceOk,
              borderOk,
              calculatedDistance,
              shouldInclude: distanceOk && borderOk
            };
          } catch (error) {
            console.error('Error filtering project:', project._id, error);
            // On error, include the project to avoid false negatives
            return {
              project,
              distanceOk: true,
              borderOk: true,
              calculatedDistance: null,
              shouldInclude: true
            };
          }
        })
      );
      // Filter out projects that don't meet criteria
      const beforeFilterCount = projectsWithFiltering.length;
      filteredProjects = projectsWithFiltering
        .filter((item: any) => item.shouldInclude)
        .map((item: any) => ({
          ...item.project,
          _calculatedDistance: item.calculatedDistance // Add for potential sorting
        }));
      const afterFilterCount = filteredProjects.length;
      console.log(`✅ Distance/border filtering: ${beforeFilterCount} projects -> ${afterFilterCount} projects (filtered ${beforeFilterCount - afterFilterCount})`);
    }
    // Calculate first available date for each project in parallel
    console.log('🗓️ Calculating first available dates for', filteredProjects.length, 'projects');
    let projectsWithAvailability = await Promise.all(
      filteredProjects.map(async (project: any) => {
        try {
          const firstAvailableDate = await calculateFirstAvailableDate(project);
          return {
            ...project,
            firstAvailableDate,
          };
        } catch (error) {
          console.error('Error calculating first available date for project:', project._id, error);
          return {
            ...project,
            firstAvailableDate: null,
          };
        }
      })
    );
    // Apply start date range filter
    if (startDateFrom || startDateTo) {
      console.log('🗓️ Applying start date range filter:', { startDateFrom, startDateTo });
      projectsWithAvailability = projectsWithAvailability.filter((project: any) => {
        if (!project.firstAvailableDate) return false;
        const projectDate = new Date(project.firstAvailableDate);
        if (startDateFrom && startDateTo) {
          const fromDate = new Date(startDateFrom);
          const toDate = new Date(startDateTo);
          // Include projects where firstAvailableDate falls within range or is before the desired start date
          return projectDate <= toDate;
        } else if (startDateFrom) {
          const fromDate = new Date(startDateFrom);
          // Include projects where firstAvailableDate is on or before the desired start date
          return projectDate <= fromDate;
        } else if (startDateTo) {
          const toDate = new Date(startDateTo);
          // Include projects where firstAvailableDate is on or before the end date
          return projectDate <= toDate;
        }
        return true;
      });
      console.log('✅ After date filter:', projectsWithAvailability.length, 'projects remaining');
    }
    const facets = buildProjectFacets(projectsWithAvailability);
    // Apply custom sorting if needed
    let sortedProjects = projectsWithAvailability;
    if (useCustomSort) {
      sortedProjects = [...projectsWithAvailability];
      if (sortBy === 'availability') {
        console.log('dY", Applying availability sort...');
        sortedProjects.sort((a: any, b: any) => {
          const dateA = a.firstAvailableDate ? new Date(a.firstAvailableDate).getTime() : Infinity;
          const dateB = b.firstAvailableDate ? new Date(b.firstAvailableDate).getTime() : Infinity;
          return dateA - dateB;
        });
      } else if (sortBy === 'price_low' || sortBy === 'price_high') {
        console.log('dY", Applying price sort...');
        sortedProjects.sort((a: any, b: any) => {
          const getPriceForSort = (project: any) => {
            if (!project.subprojects || project.subprojects.length === 0) return Infinity;
            const prices = project.subprojects
              .map((sub: any) => {
                if (sub.pricing?.type === 'fixed') return sub.pricing.amount || null;
                if (sub.pricing?.type === 'unit' && sub.pricing.priceRange) return sub.pricing.priceRange.min || null;
                return null;
              })
              .filter((price: number) => price !== null);
            if (prices.length === 0) return Infinity;
            return Math.min(...prices);
          };
          const priceA = getPriceForSort(a);
          const priceB = getPriceForSort(b);
          // Projects without prices go to the end
          if (priceA === Infinity && priceB === Infinity) return 0;
          if (priceA === Infinity) return 1;
          if (priceB === Infinity) return -1;
          // Sort ascending or descending based on sortBy
          if (sortBy === 'price_low') {
            return priceA - priceB;
          } else {
            return priceB - priceA;
          }
        });
      }
    }
    // If location or geographicArea filter is present, prioritize by professional's location but show all results
    let results = sortedProjects;
    const locationFilter = geographicArea || location;
    if (locationFilter && locationFilter.trim()) {
      const locationLower = locationFilter.toLowerCase();
      // Prioritize projects where professional's location matches
      const matchingLocation = sortedProjects.filter((p: any) => {
        const prof = p.professionalId;
        if (!prof || !prof.businessInfo) return false;
        const city = prof.businessInfo.city?.toLowerCase() || "";
        const country = prof.businessInfo.country?.toLowerCase() || "";
        const postalCode = prof.businessInfo.postalCode?.toLowerCase() || "";
        const region = prof.businessInfo.region?.toLowerCase() || "";
        return city.includes(locationLower) ||
               country.includes(locationLower) ||
               postalCode.includes(locationLower) ||
               region.includes(locationLower);
      });
      const otherProjects = sortedProjects.filter((p: any) => {
        const prof = p.professionalId;
        if (!prof || !prof.businessInfo) return true; // Include if no location info
        const city = prof.businessInfo.city?.toLowerCase() || "";
        const country = prof.businessInfo.country?.toLowerCase() || "";
        const postalCode = prof.businessInfo.postalCode?.toLowerCase() || "";
        const region = prof.businessInfo.region?.toLowerCase() || "";
        return !city.includes(locationLower) &&
               !country.includes(locationLower) &&
               !postalCode.includes(locationLower) &&
               !region.includes(locationLower);
      });
      // Show location matches first, then all others
      results = [...matchingLocation, ...otherProjects];
      console.log('📍 Location prioritization:', matchingLocation.length, 'matching location,', otherProjects.length, 'other locations');
    }
    const totalResults = results.length;
    const safeStartIndex = Math.min(skip, Math.max(totalResults - pageSize, 0));
    const paginatedResults = results.slice(safeStartIndex, safeStartIndex + pageSize);
    const currentPage = Math.floor(safeStartIndex / pageSize) + 1;
    res.json({
      results: paginatedResults,
      pagination: {
        total: totalResults,
        page: currentPage,
        limit: pageSize,
        totalPages: Math.ceil(totalResults / pageSize),
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
