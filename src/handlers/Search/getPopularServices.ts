import { Request, Response } from "express";
import Project from "../../models/project";

/**
 * Get popular services from published projects
 * Returns unique categories and services that actually have published projects
 */
export const getPopularServices = async (req: Request, res: Response) => {
  try {
    const { limit = "10" } = req.query;
    const limitNum = parseInt(limit as string, 10);

    // Get all published projects
    const projects = await Project.find({ status: "published" })
      .select("category service")
      .lean();

    if (projects.length === 0) {
      // If no published projects, return empty array
      return res.json({ services: [] });
    }

    // Extract unique services with their categories
    const serviceMap = new Map<string, { service: string; category: string; count: number }>();

    projects.forEach((project) => {
      const key = `${project.category}-${project.service}`;
      if (serviceMap.has(key)) {
        const existing = serviceMap.get(key)!;
        existing.count += 1;
      } else {
        serviceMap.set(key, {
          service: project.service,
          category: project.category,
          count: 1,
        });
      }
    });

    // Convert to array and sort by count (most popular first)
    const popularServices = Array.from(serviceMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limitNum)
      .map((item) => ({
        name: item.service,
        category: item.category,
        count: item.count,
      }));

    res.json({ services: popularServices });
  } catch (error) {
    console.error("Failed to fetch popular services:", error);
    res.status(500).json({ error: "Failed to fetch popular services" });
  }
};
