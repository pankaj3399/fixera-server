import { Router } from 'express';
import Project from '../models/project';
import ServiceCategory from '../models/serviceCategory';
import { protect as authMiddleware } from '../middlewares/auth';
import { seedServiceCategories } from '../handlers/Project/seedData';

const router = Router();

// Seed service categories (development only)
router.post('/seed', async (req, res) => {
    try {
        await seedServiceCategories();
        res.json({ message: 'Service categories seeded successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to seed service categories' });
    }
});

// Get all categories for a country
router.get('/categories', authMiddleware, async (req, res) => {
    try {
        const country = req.query.country as string || 'BE'; // Default to Belgium
        const categories = await ServiceCategory.find({
            isActive: true,
            countries: country
        }).select('name slug description icon services');

        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

// Get services for a category
router.get('/categories/:categorySlug/services', authMiddleware, async (req, res) => {
    try {
        const { categorySlug } = req.params;
        const country = req.query.country as string || 'BE';

        const category = await ServiceCategory.findOne({
            slug: categorySlug,
            isActive: true,
            countries: country
        });

        if (!category) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const services = category.services.filter(service =>
            service.isActive && service.countries.includes(country)
        );

        res.json(services);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch services' });
    }
});

// Create or update project draft (auto-save)
router.post('/draft', authMiddleware, async (req, res) => {
    try {
        const professionalId = req.user?.id;
        const projectData = req.body;

        let project;

        if (projectData.id) {
            // Update existing draft
            project = await Project.findOneAndUpdate(
                { _id: projectData.id, professionalId, status: 'draft' },
                { ...projectData, autoSaveTimestamp: new Date() },
                { new: true }
            );
        } else {
            // Create new draft
            project = new Project({
                ...projectData,
                professionalId,
                status: 'draft',
                autoSaveTimestamp: new Date()
            });
            await project.save();
        }

        res.json(project);
    } catch (error) {
        console.error('Auto-save error:', error);
        res.status(500).json({ error: 'Failed to save project draft' });
    }
});

// Get project drafts for professional
router.get('/drafts', authMiddleware, async (req, res) => {
    try {
        const professionalId = req.user?.id;
        const drafts = await Project.find({
            professionalId,
            status: 'draft'
        }).sort({ autoSaveTimestamp: -1 });

        res.json(drafts);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch drafts' });
    }
});

// Get specific project
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const professionalId = req.user?.id;

        const project = await Project.findOne({
            _id: id,
            professionalId
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch project' });
    }
});

// Submit project for approval
router.post('/:id/submit', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const professionalId = req.user?.id;

        const project = await Project.findOne({
            _id: id,
            professionalId,
            status: 'draft'
        });

        if (!project) {
            return res.status(404).json({ error: 'Project not found or already submitted' });
        }

        // Basic quality checks
        const qualityChecks = [];

        // Check required fields
        if (!project.title || project.title.length < 30) {
            qualityChecks.push({
                category: 'content',
                status: 'failed' as const,
                message: 'Title must be at least 30 characters long',
                checkedAt: new Date()
            });
        }

        if (!project.description || project.description.length < 100) {
            qualityChecks.push({
                category: 'content',
                status: 'failed' as const,
                message: 'Description must be at least 100 characters long',
                checkedAt: new Date()
            });
        }

        if (project.subprojects.length === 0) {
            qualityChecks.push({
                category: 'pricing',
                status: 'failed' as const,
                message: 'At least one subproject/pricing variation is required',
                checkedAt: new Date()
            });
        }

        // Check if all quality checks passed
        const failedChecks = qualityChecks.filter(check => check.status === 'failed');

        if (failedChecks.length > 0) {
            project.qualityChecks = qualityChecks;
            await project.save();
            return res.status(400).json({
                error: 'Quality checks failed',
                qualityChecks: failedChecks
            });
        }

        // Update project status
        project.status = 'pending_approval';
        project.submittedAt = new Date();
        project.qualityChecks = qualityChecks;
        await project.save();

        res.json({ message: 'Project submitted for approval', project });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit project' });
    }
});

// Admin routes
router.get('/admin/pending', authMiddleware, async (req, res) => {
    try {
        // Check if user is admin
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const pendingProjects = await Project.find({
            status: 'pending_approval'
        }).sort({ submittedAt: 1 });

        res.json(pendingProjects);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending projects' });
    }
});

// Admin approve project
router.put('/admin/:id/approve', authMiddleware, async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'pending_approval' },
            {
                status: 'published',
                approvedAt: new Date(),
                approvedBy: req.user?.id
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ message: 'Project approved', project });
    } catch (error) {
        res.status(500).json({ error: 'Failed to approve project' });
    }
});

// Admin reject project
router.put('/admin/:id/reject', authMiddleware, async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const { feedback } = req.body;

        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'pending_approval' },
            {
                status: 'draft',
                adminFeedback: feedback
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ message: 'Project rejected', project });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject project' });
    }
});

export default router;