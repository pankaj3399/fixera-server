import { Router } from "express";
import { search, autocomplete, getPopularServices, getPopularProjects } from "../../handlers/Search";

const router = Router();

// Public route for unified search (professionals and projects)
router.route("/").get(search);

// Public route for autocomplete suggestions
router.route("/autocomplete").get(autocomplete);

// Public route for popular services from published projects
router.route("/popular").get(getPopularServices);

// Public route for popular projects (homepage carousel)
router.route("/popular-projects").get(getPopularProjects);

export default router;
