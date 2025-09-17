import { Router } from 'express';
import { protect as authMiddleware } from '../../middlewares/auth';
import {
    seedData,
    getCategories,
    getCategoryServices,
    createOrUpdateDraft,
    getDrafts,
    getAllProjects,
    getProject,
    submitProject
} from '../../handlers/Project';
import {
    getPendingProjects,
    approveProject,
    rejectProject
} from '../../handlers/Project/admin';

const router = Router();

// Seed service categories (development only)
router.route('/seed').post(seedData);

// Public category routes (with auth)
router.route('/categories').get(authMiddleware, getCategories);
router.route('/categories/:categorySlug/services').get(authMiddleware, getCategoryServices);

// Project management routes
router.route('/draft').post(authMiddleware, createOrUpdateDraft);
router.route('/drafts').get(authMiddleware, getDrafts);
router.route('/all').get(authMiddleware, getAllProjects);
router.route('/:id').get(authMiddleware, getProject);
router.route('/:id/submit').post(authMiddleware, submitProject);

// Admin routes
router.route('/admin/pending').get(authMiddleware, getPendingProjects);
router.route('/admin/:id/approve').put(authMiddleware, approveProject);
router.route('/admin/:id/reject').put(authMiddleware, rejectProject);

export default router;