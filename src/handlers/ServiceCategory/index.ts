import { Request, Response } from "express";
import ServiceConfiguration from "../../models/serviceConfiguration";

/**
 * Get all active service categories with nested services
 * This endpoint is used by the frontend to dynamically render the navbar and services page
 * Fetches from ServiceConfiguration model and groups by category
 */
export const getActiveServiceCategories = async (
  req: Request,
  res: Response
) => {
  try {
    const country = (req.query.country as string) || "BE";

    // Find all active service configurations for the country
    const serviceConfigs = await ServiceConfiguration.find({
      isActive: true,
      activeCountries: country,
    })
      .select("category service areaOfWork pricingModel certificationRequired icon")
      .sort({ category: 1, service: 1 });

    // Group by category
    const categoriesMap = new Map<string, any>();

    serviceConfigs.forEach((config) => {
      const category = config.category;

      if (!categoriesMap.has(category)) {
        categoriesMap.set(category, {
          name: category,
          slug: category.toLowerCase().replace(/\s+/g, "-"),
          description: `Professional ${category.toLowerCase()} services`,
          services: [],
        });
      }

      const categoryData = categoriesMap.get(category);

      // Check if this service already exists in the category
      const existingService = categoryData.services.find(
        (s: any) => s.name === config.service
      );

      if (!existingService) {
        categoryData.services.push({
          name: config.service,
          slug: config.service.toLowerCase().replace(/\s+/g, "-"),
          description: `Professional ${config.service.toLowerCase()} services`,
          isActive: true,
          countries: [country],
          pricingModel: config.pricingModel,
          certificationRequired: config.certificationRequired,
          icon: config.icon,
        });
      }
    });

    // Convert map to array
    const categories = Array.from(categoriesMap.values());

    res.json(categories);
  } catch (error) {
    console.error("Failed to fetch active service categories:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch active service categories" });
  }
};
