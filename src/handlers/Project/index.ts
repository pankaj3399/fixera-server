import { Request, Response } from 'express';
import Project from '../../models/project';
import ServiceCategory from '../../models/serviceCategory';
import { seedServiceCategories } from '../../scripts/seedProject';

export const seedData = async (req: Request, res: Response) => {
    try {
        await seedServiceCategories();
        res.json({ message: 'Service categories seeded successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to seed service categories' });
    }
};

export const getCategories = async (req: Request, res: Response) => {
    try {
        const country = req.query.country as string || 'BE';
        const categories = await ServiceCategory.find({
            isActive: true,
            countries: country
        }).select('name slug description icon services');

        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
};

export const getCategoryServices = async (req: Request, res: Response) => {
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
};

export const createOrUpdateDraft = async (req: Request, res: Response) => {
    try {
        const professionalId = req.user?.id;
        const projectData = req.body;

        let project;

        if (projectData.id) {
            project = await Project.findOneAndUpdate(
                { _id: projectData.id, professionalId, status: 'draft' },
                { ...projectData, autoSaveTimestamp: new Date() },
                { new: true }
            );
        } else {
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
};

export const getDrafts = async (req: Request, res: Response) => {
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
};

export const getProject = async (req: Request, res: Response) => {
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
};

export const submitProject = async (req: Request, res: Response) => {
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

        const qualityChecks = [];

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

        const failedChecks = qualityChecks.filter(check => check.status === 'failed');

        if (failedChecks.length > 0) {
            project.qualityChecks = qualityChecks;
            await project.save();
            return res.status(400).json({
                error: 'Quality checks failed',
                qualityChecks: failedChecks
            });
        }

        project.status = 'pending_approval';
        project.submittedAt = new Date();
        project.qualityChecks = qualityChecks;
        await project.save();

        res.json({ message: 'Project submitted for approval', project });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit project' });
    }
};