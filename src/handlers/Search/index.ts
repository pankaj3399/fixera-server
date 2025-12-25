import { Request, Response } from "express";
import User from "../../models/user";
import Project from "../../models/project";

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
      page = "1",
      limit = "20",
    } = req.query;

    console.log('🔍 Search request:', { q, loc, type, priceMin, priceMax, category, availability, page, limit });

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
  skip: number,
  limit: number
) {
  try {
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
    console.log('🔍 Search query:', query);
    console.log('🔍 Location:', location);

    const [projects, total] = await Promise.all([
      Project.find(filter)
        .populate("professionalId", "name email businessInfo hourlyRate currency profileImage")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Project.countDocuments(filter),
    ]);

    console.log('✅ Found', total, 'projects before location filter, returning', projects.length);
    if (projects.length > 0) {
      console.log('📋 Sample project titles:', projects.slice(0, 3).map((p: any) => p.title));
    }

    // If location filter is present, prioritize by professional's location but show all results
    let results = projects;
    if (location && location.trim()) {
      const locationLower = location.toLowerCase();

      // Prioritize projects where professional's location matches
      const matchingLocation = projects.filter((p: any) => {
        const prof = p.professionalId;
        if (!prof || !prof.businessInfo) return false;
        const city = prof.businessInfo.city?.toLowerCase() || "";
        const country = prof.businessInfo.country?.toLowerCase() || "";
        return city.includes(locationLower) || country.includes(locationLower);
      });

      const otherProjects = projects.filter((p: any) => {
        const prof = p.professionalId;
        if (!prof || !prof.businessInfo) return true; // Include if no location info
        const city = prof.businessInfo.city?.toLowerCase() || "";
        const country = prof.businessInfo.country?.toLowerCase() || "";
        return !city.includes(locationLower) && !country.includes(locationLower);
      });

      // Show location matches first, then all others
      results = [...matchingLocation, ...otherProjects];
      console.log('📍 Location prioritization:', matchingLocation.length, 'matching location,', otherProjects.length, 'other locations');
    }

    res.json({
      results,
      pagination: {
        total: total,
        page: Math.ceil(skip / limit) + 1,
        limit,
        totalPages: Math.ceil(total / limit),
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
