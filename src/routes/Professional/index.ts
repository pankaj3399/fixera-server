import { Router } from "express";
import { getProfessionalsByCategory, getAllProfessionals } from "../../handlers/Professional";

const router = Router();

// Public route to get all approved professionals
router.route("/").get(getAllProfessionals);

// Public route to get professionals by category slug
router.route("/by-category/:categorySlug").get(getProfessionalsByCategory);

export default router;
