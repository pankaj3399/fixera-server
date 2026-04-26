import { Request, Response } from 'express';
import ServiceConfiguration from '../../models/serviceConfiguration';
import CmsContent from '../../models/cmsContent';
import { IUser } from '../../models/user';
import { toSlug } from '../../utils/slug';

async function ensureServiceLanding(serviceName: string, adminId?: string) {
    try {
        const slug = toSlug(serviceName);
        if (!slug) return;
        // Avoid duplicates for common renamed variants (e.g. "plumbing" vs "plumbing-services")
        const candidateSlugs = [slug, `${slug}-services`, slug.replace(/-services$/, '')].filter((s, i, a) => s && a.indexOf(s) === i);
        const existing = await CmsContent.findOne({ type: 'landing', slug: { $in: candidateSlugs }, locale: 'en' });
        if (existing) return;
        await CmsContent.create({
            type: 'landing',
            title: serviceName,
            slug,
            locale: 'en',
            body: '',
            status: 'draft',
            author: adminId,
            tags: [],
            seo: {},
        });
    } catch (err) {
        console.error('[ensureServiceLanding] failed to auto-create landing:', err);
    }
}

/**
 * Get all service configurations with optional filters
 * @route GET /api/admin/service-configurations
 */
export const getAllServiceConfigurations = async (req: Request, res: Response) => {
    try {
        const { category, service, isActive, country } = req.query;

        const filter: any = {};
        if (category) filter.category = category;
        if (service) filter.service = service;
        if (isActive !== undefined) filter.isActive = isActive === 'true';
        if (country) filter.activeCountries = country;

        const configurations = await ServiceConfiguration.find(filter).sort({ category: 1, service: 1 });

        res.status(200).json({
            success: true,
            count: configurations.length,
            data: configurations
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error fetching service configurations',
            error: error.message
        });
    }
};

/**
 * Get a single service configuration by ID
 * @route GET /api/admin/service-configurations/:id
 */
export const getServiceConfigurationById = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const configuration = await ServiceConfiguration.findById(id);

        if (!configuration) {
            return res.status(404).json({
                success: false,
                message: 'Service configuration not found'
            });
        }

        res.status(200).json({
            success: true,
            data: configuration
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error fetching service configuration',
            error: error.message
        });
    }
};

/**
 * Create a new service configuration
 * @route POST /api/admin/service-configurations
 */
export const createServiceConfiguration = async (req: Request, res: Response) => {
    try {
        const configurationData = req.body;

        // Check if configuration already exists
        const existing = await ServiceConfiguration.findOne({
            category: configurationData.category,
            service: configurationData.service,
            areaOfWork: configurationData.areaOfWork
        });

        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'Service configuration already exists for this category/service/area combination'
            });
        }

        const configuration = await ServiceConfiguration.create(configurationData);

        const admin = (req as Request & { admin?: IUser }).admin;
        await ensureServiceLanding(configuration.service, admin?._id?.toString());

        res.status(201).json({
            success: true,
            message: 'Service configuration created successfully',
            data: configuration
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error creating service configuration',
            error: error.message
        });
    }
};

/**
 * Update a service configuration
 * @route PUT /api/admin/service-configurations/:id
 */
export const updateServiceConfiguration = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        const configuration = await ServiceConfiguration.findByIdAndUpdate(
            id,
            updateData,
            { new: true, runValidators: true }
        );

        if (!configuration) {
            return res.status(404).json({
                success: false,
                message: 'Service configuration not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Service configuration updated successfully',
            data: configuration
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error updating service configuration',
            error: error.message
        });
    }
};

/**
 * Delete a service configuration
 * @route DELETE /api/admin/service-configurations/:id
 */
export const deleteServiceConfiguration = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const configuration = await ServiceConfiguration.findByIdAndDelete(id);

        if (!configuration) {
            return res.status(404).json({
                success: false,
                message: 'Service configuration not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Service configuration deleted successfully'
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error deleting service configuration',
            error: error.message
        });
    }
};

/**
 * Toggle service configuration active status
 * @route PATCH /api/admin/service-configurations/:id/toggle-active
 */
export const toggleServiceConfigurationActive = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const configuration = await ServiceConfiguration.findById(id);

        if (!configuration) {
            return res.status(404).json({
                success: false,
                message: 'Service configuration not found'
            });
        }

        configuration.isActive = !configuration.isActive;
        await configuration.save();

        res.status(200).json({
            success: true,
            message: `Service configuration ${configuration.isActive ? 'activated' : 'deactivated'} successfully`,
            data: configuration
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error toggling service configuration status',
            error: error.message
        });
    }
};

/**
 * Get unique categories
 * @route GET /api/admin/service-configurations/categories
 */
export const getCategories = async (req: Request, res: Response) => {
    try {
        const categories = await ServiceConfiguration.distinct('category');

        res.status(200).json({
            success: true,
            data: categories.sort()
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error fetching categories',
            error: error.message
        });
    }
};

/**
 * Get services by category
 * @route GET /api/admin/service-configurations/services/:category
 */
export const getServicesByCategory = async (req: Request, res: Response) => {
    try {
        const { category } = req.params;

        const services = await ServiceConfiguration.distinct('service', { category });

        res.status(200).json({
            success: true,
            data: services.sort()
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error fetching services',
            error: error.message
        });
    }
};
