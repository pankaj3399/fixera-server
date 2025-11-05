import { Router } from "express";
import { protect as authMiddleware } from "../../middlewares/auth";
import {
  seedData,
  getCategories,
  getCategoryServices,
  createOrUpdateDraft,
  getDrafts,
  getAllProjects,
  getProject,
  submitProject,
  duplicateProject,
  deleteProject,
  updateProjectStatus,
  getProjectsMaster,
} from "../../handlers/Project";
import {
  getPendingProjects,
  getApprovedProjects,
  approveProject,
  rejectProject,
  deleteProjectByAdmin,
  deactivateProject,
  reactivateProject,
} from "../../handlers/Project/admin";

const router = Router();

// Seed service categories (development only)
router.route("/seed").post(seedData);

// Public category routes (with auth)
router.route("/categories").get(authMiddleware, getCategories);
router
  .route("/categories/:categorySlug/services")
  .get(authMiddleware, getCategoryServices);

// Project management routes
router.route("/draft").post(authMiddleware, createOrUpdateDraft);
router.route("/drafts").get(authMiddleware, getDrafts);
router.route("/all").get(authMiddleware, getAllProjects);
router.route("/master").get(authMiddleware, getProjectsMaster);
router.route("/:id").get(authMiddleware, getProject);
router.route("/:id/submit").post(authMiddleware, submitProject);
router.route("/:id/duplicate").post(authMiddleware, duplicateProject);
router.route("/:id").delete(authMiddleware, deleteProject);
router.route("/:id/status").patch(authMiddleware, updateProjectStatus);

// Admin routes
router.route("/admin/pending").get(authMiddleware, getPendingProjects);
router.route("/admin/approved").get(authMiddleware, getApprovedProjects);
router.route("/admin/:id/approve").put(authMiddleware, approveProject);
router.route("/admin/:id/reject").put(authMiddleware, rejectProject);
router.route("/admin/:id/delete").delete(authMiddleware, deleteProjectByAdmin);
router.route("/admin/:id/deactivate").put(authMiddleware, deactivateProject);
router.route("/admin/:id/reactivate").put(authMiddleware, reactivateProject);

export default router;
