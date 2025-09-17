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
        console.log('📝 SAVE PROJECT REQUEST RECEIVED');
        console.log('User ID:', req.user?.id);
        console.log('Request body keys:', Object.keys(req.body));
        console.log('Project ID from request:', req.body.id);

        const professionalId = req.user?.id;
        const projectData = req.body;

        if (!professionalId) {
            console.log('❌ No professional ID found');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        let project;

        if (projectData.id) {
            console.log(`🔄 UPDATING existing project: ${projectData.id}`);
            console.log('Professional ID:', professionalId);

            // First check if project exists
            const existingProject = await Project.findOne({ _id: projectData.id, professionalId });
            console.log('Existing project found:', !!existingProject);
            console.log('Existing project status:', existingProject?.status);
            console.log('Existing project title:', existingProject?.title);

            if (!existingProject) {
                console.log('❌ Project not found or not owned by user');
                return res.status(404).json({ error: 'Project not found' });
            }

            // Log what fields are being updated
            console.log('📝 Fields being updated:');
            console.log('- Title:', projectData.title);
            console.log('- Description length:', projectData.description?.length || 0);
            console.log('- Category:', projectData.category);
            console.log('- Service:', projectData.service);

            // Allow updates to existing projects regardless of status for editing
            const updateData = {
                ...projectData,
                autoSaveTimestamp: new Date(),
                updatedAt: new Date()
            };

            console.log('🔧 Update query:', { _id: projectData.id, professionalId });
            console.log('🔧 Update data keys:', Object.keys(updateData));

            project = await Project.findOneAndUpdate(
                { _id: projectData.id, professionalId },
                updateData,
                { new: true, runValidators: true }
            );

            console.log('✅ Project updated successfully');
            console.log('Updated project ID:', project?._id);
            console.log('Updated project title:', project?.title);
            console.log('Updated project status:', project?.status);
        } else {
            console.log('🆕 CREATING new project');
            project = new Project({
                ...projectData,
                professionalId,
                status: 'draft',
                autoSaveTimestamp: new Date()
            });
            await project.save();
            console.log('✅ New project created with ID:', project._id);
        }

        console.log('📤 SENDING RESPONSE - Project save complete');
        console.log('Response project ID:', project?._id);
        console.log('Response status code: 200');

        res.json(project);
    } catch (error) {
        console.error('❌ AUTO-SAVE ERROR:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: 'Failed to save project draft', details: error.message });
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

export const getAllProjects = async (req: Request, res: Response) => {
    try {
        const professionalId = req.user?.id;
        const projects = await Project.find({
            professionalId
        }).sort({ updatedAt: -1 });

        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch projects' });
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
        console.log('🚀 SUBMIT PROJECT REQUEST RECEIVED');
        const { id } = req.params;
        const professionalId = req.user?.id;

        console.log('Project ID:', id);
        console.log('Professional ID:', professionalId);

        if (!professionalId) {
            console.log('❌ No professional ID found');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const project = await Project.findOne({
            _id: id,
            professionalId
        });

        console.log('Project found:', !!project);
        console.log('Project status:', project?.status);

        if (!project) {
            console.log('❌ Project not found');
            return res.status(404).json({ error: 'Project not found' });
        }

        // Allow resubmission for draft, rejected, or existing projects
        if (!['draft', 'rejected', 'pending_approval', 'published'].includes(project.status)) {
            console.log('❌ Invalid status for submission:', project.status);
            return res.status(400).json({ error: 'Project cannot be submitted in current status' });
        }

        console.log('✅ Project validation passed, running quality checks...');

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

        // Update project status and submission details
        const isResubmission = project.status !== 'draft';
        project.status = 'pending_approval';
        project.submittedAt = new Date();
        project.qualityChecks = qualityChecks;

        // Clear admin feedback on resubmission
        if (isResubmission) {
            project.adminFeedback = undefined;
        }

        await project.save();

        const message = isResubmission ? 'Project resubmitted for approval' : 'Project submitted for approval';
        console.log('✅ Project submitted successfully');
        console.log('Message:', message);

        res.json({ message, project });
    } catch (error) {
        console.error('❌ SUBMIT PROJECT ERROR:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ error: 'Failed to submit project', details: error.message });
    }
};