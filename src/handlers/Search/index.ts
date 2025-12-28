import { Request, Response } from "express";
import User from "../../models/user";
import Project from "../../models/project";
import { buildProjectScheduleProposals } from "../../utils/scheduleEngine";

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
    } = req.query;

    console.log("dY\"? Search request:", { q, loc, type, priceMin, priceMax, category, availability, customerLat, customerLon, customerCountry, customerState, customerCity, customerAddress, page, limit });

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    if (type === "professionals") {
      return await searchProfessionals(
        res,
        q as string,
        loc as string,
        priceMin as string | undefined,
        priceMax as string | undefined,
        category as string | undefined,
        availability as string | undefined,
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
  skip: number,
  limit: number
) {
  try {
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

    // Location filter - exact match first, then broader match
    if (location && location.trim()) {
      const locationRegex = new RegExp(location.trim(), "i");
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
      filter.availability = { $exists: true, $ne: null };
    }

    // Execute query with pagination
    console.log('🔍 Professional search filter:', JSON.stringify(filter, null, 2));

    const [professionals, total] = await Promise.all([
      User.find(filter)
        .select(
          "name email businessInfo hourlyRate currency serviceCategories profileImage availability createdAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    console.log('✅ Found', total, 'professionals, returning', professionals.length);

    // If location filter is present, prioritize exact matches
    let results = professionals;
    if (location && location.trim()) {
      const exactMatches = results.filter(
        (p: any) =>
          p.businessInfo?.city?.toLowerCase() === location.toLowerCase() ||
          p.businessInfo?.country?.toLowerCase() === location.toLowerCase()
      );
      const otherMatches = results.filter(
        (p: any) =>
          p.businessInfo?.city?.toLowerCase() !== location.toLowerCase() &&
          p.businessInfo?.country?.toLowerCase() !== location.toLowerCase()
      );
      results = [...exactMatches, ...otherMatches];
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
  limit: number
) {
  try {
    // Build the filter object
    const filter: any = {
      // Include published and pending projects for now
      status: { $in: ["published", "pending"] },
    };

    // Search query - search in title, description, category, and service
    if (query && query.trim()) {
      const searchRegex = new RegExp(query.trim(), "i");
      filter.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { category: searchRegex },
        { service: searchRegex },
      ];
    }

    // Category filter
    if (category && category.trim()) {
      filter.category = new RegExp(category.trim(), "i");
    }

    // Price range filter - handle different pricing types
    if (priceMin !== undefined || priceMax !== undefined) {
      const priceConditions: any[] = [];

      if (priceMin && priceMax) {
        // Check if fixed price is in range
        priceConditions.push({
          "pricing.type": "fixed",
          "pricing.amount": { $gte: parseFloat(priceMin), $lte: parseFloat(priceMax) },
        });
        // Check if price range overlaps
        priceConditions.push({
          "pricing.type": "unit",
          $or: [
            {
              "pricing.priceRange.min": { $lte: parseFloat(priceMax) },
              "pricing.priceRange.max": { $gte: parseFloat(priceMin) },
            },
          ],
        });
      } else if (priceMin) {
        priceConditions.push({
          $or: [
            { "pricing.type": "fixed", "pricing.amount": { $gte: parseFloat(priceMin) } },
            { "pricing.type": "unit", "pricing.priceRange.max": { $gte: parseFloat(priceMin) } },
          ],
        });
      } else if (priceMax) {
        priceConditions.push({
          $or: [
            { "pricing.type": "fixed", "pricing.amount": { $lte: parseFloat(priceMax) } },
            { "pricing.type": "unit", "pricing.priceRange.min": { $lte: parseFloat(priceMax) } },
          ],
        });
      }

      if (priceConditions.length > 0) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: priceConditions });
      }
    }

    // Execute query with pagination and populate professional info
    console.log('🔍 Project search filter:', JSON.stringify(filter, null, 2));

    const [projects, total] = await Promise.all([
      Project.find(filter)
        .populate("professionalId", "name email businessInfo hourlyRate currency profileImage")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Project.countDocuments(filter),
    ]);

    console.log('✅ Found', total, 'projects, returning', projects.length);

    const normalizeValue = (value?: string | null) =>
      value ? value.trim().toLowerCase() : "";

    const parseCoordinate = (value?: string) => {
      if (!value) return null;
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const calculateDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const toRad = (val: number) => (val * Math.PI) / 180;
      const r = 6371;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return r * c;
    };

    const getProjectCoordinates = (project: any) => {
      const coords = project?.distance?.coordinates;
      if (!coords) return null;
      const latitude = typeof coords.latitude === "number" ? coords.latitude : typeof coords.lat === "number" ? coords.lat : null;
      const longitude = typeof coords.longitude === "number" ? coords.longitude : typeof coords.lng === "number" ? coords.lng : null;
      if (latitude === null || longitude === null) return null;
      return { latitude, longitude };
    };

    const customerLatValue = parseCoordinate(customerLat);
    const customerLonValue = parseCoordinate(customerLon);
    const customerCountryValue = normalizeValue(customerCountry);
    const customerStateValue = normalizeValue(customerState);
    const customerCityValue = normalizeValue(customerCity);
    const customerAddressValue = normalizeValue(customerAddress);
    const locationValue = normalizeValue(location);

    const hasLocationFilter = Boolean(
      locationValue ||
        customerAddressValue ||
        customerCityValue ||
        customerStateValue ||
        customerCountryValue ||
        (customerLatValue !== null && customerLonValue !== null)
    );

    const locationParts = [
      locationValue,
      customerAddressValue,
      customerCityValue,
      customerStateValue,
      customerCountryValue,
    ].filter(Boolean);

    let results = projects;
    if (hasLocationFilter) {
      results = projects.filter((project: any) => {
        const distance = project.distance || {};
        const projectAddress = normalizeValue(distance.address);
        const maxKmRange =
          typeof distance.maxKmRange === "number" ? distance.maxKmRange : null;
        const noBorders = Boolean(distance.noBorders);

        const projectCoords = getProjectCoordinates(project);

        if (noBorders && customerCountryValue) {
          if (!projectAddress || !projectAddress.includes(customerCountryValue)) {
            return false;
          }
        }

        if (
          projectCoords &&
          customerLatValue !== null &&
          customerLonValue !== null &&
          typeof maxKmRange === "number"
        ) {
          const distanceKm = calculateDistanceKm(
            customerLatValue,
            customerLonValue,
            projectCoords.latitude,
            projectCoords.longitude
          );
          return distanceKm <= maxKmRange;
        }

        if (!projectAddress) {
          return false;
        }

        if (locationParts.length === 0) {
          return true;
        }

        return locationParts.some((part) => projectAddress.includes(part));
      });

      if (locationValue) {
        const exactMatches = results.filter((project: any) => {
          const projectAddress = normalizeValue(project.distance?.address);
          return projectAddress === locationValue;
        });
        const otherMatches = results.filter((project: any) => {
          const projectAddress = normalizeValue(project.distance?.address);
          return projectAddress !== locationValue;
        });
        results = [...exactMatches, ...otherMatches];
      }
    }
    const resultsWithAvailability = await Promise.all(
      results.map(async (project: any) => {
        if (project?.status !== "published") {
          return project;
        }

        try {
          // Get main project availability
          const proposals = await buildProjectScheduleProposals(
            project._id.toString()
          );

          // Get availability for each subproject
          const subprojectsWithAvailability = await Promise.all(
            (project.subprojects || []).map(async (subproject: any, index: number) => {
              try {
                const subprojectProposals = await buildProjectScheduleProposals(
                  project._id.toString(),
                  index
                );
                return {
                  ...subproject,
                  firstAvailableDate: subprojectProposals?.earliestBookableDate || null,
                };
              } catch {
                return subproject;
              }
            })
          );

          return {
            ...project,
            subprojects: subprojectsWithAvailability,
            firstAvailableDate: proposals?.earliestBookableDate || null,
            firstAvailableWindow: proposals?.earliestProposal
              ? {
                  start: proposals.earliestProposal.start,
                  end: proposals.earliestProposal.end,
                }
              : null,
            shortestThroughputWindow: proposals?.shortestThroughputProposal
              ? {
                  start: proposals.shortestThroughputProposal.start,
                  end: proposals.shortestThroughputProposal.end,
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
      pagination: {
        total: hasLocationFilter ? results.length : total,
        page: Math.ceil(skip / limit) + 1,
        limit,
        totalPages: Math.ceil((hasLocationFilter ? results.length : total) / limit),
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
