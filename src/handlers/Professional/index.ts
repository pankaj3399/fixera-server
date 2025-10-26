import { Request, Response } from "express";
import User from "../../models/user";

/**
 * Get all approved professionals by category slug
 * This endpoint is used by the category pages to show professionals
 * who offer services in a specific category
 */
export const getProfessionalsByCategory = async (
  req: Request,
  res: Response
) => {
  try {
    const { categorySlug } = req.params;

    if (!categorySlug) {
      return res.status(400).json({ error: "Category slug is required" });
    }

    // Find professionals where:
    // 1. role is 'professional'
    // 2. professionalStatus is 'approved'
    // 3. serviceCategories array contains the categorySlug
    const professionals = await User.find({
      role: "professional",
      professionalStatus: "approved",
      serviceCategories: categorySlug,
    })
      .select(
        "name email businessInfo hourlyRate currency serviceCategories profileImage"
      )
      .sort({ createdAt: -1 })
      .limit(100); // Limit to 100 professionals for performance

    res.json(professionals);
  } catch (error) {
    console.error("Failed to fetch professionals by category:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch professionals by category" });
  }
};

/**
 * Get all approved professionals
 * This endpoint returns all approved professionals across all categories
 */
export const getAllProfessionals = async (req: Request, res: Response) => {
  try {
    const professionals = await User.find({
      role: "professional",
      professionalStatus: "approved",
    })
      .select(
        "name email businessInfo hourlyRate currency serviceCategories profileImage"
      )
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(professionals);
  } catch (error) {
    console.error("Failed to fetch professionals:", error);
    res.status(500).json({ error: "Failed to fetch professionals" });
  }
};
