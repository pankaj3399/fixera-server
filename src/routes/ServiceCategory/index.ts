import { Router } from "express";
import { getActiveServiceCategories } from "../../handlers/ServiceCategory";

const router = Router();

// Public route to get all active service categories with nested services
router.route("/active").get(getActiveServiceCategories);

export default router;
