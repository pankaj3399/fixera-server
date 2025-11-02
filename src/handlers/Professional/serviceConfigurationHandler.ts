import { Request, Response } from 'express';
import ServiceConfiguration from '../../models/serviceConfiguration';

/**
 * Get service configuration for professional based on category, service, and area of work
 * @route GET /api/professional/service-configuration
 */
export const getServiceConfigurationForProfessional = async (req: Request, res: Response) => {
    try {
        const { category, service, areaOfWork, country = 'BE' } = req.query as any;

        if (!category || !service) {
            return res.status(400).json({
                success: false,
                message: 'Category and service are required'
            });
        }

        const filter: any = {
            category,
            service,
            isActive: true,
            activeCountries: country
        };

        if (areaOfWork && areaOfWork !== 'Not applicable') {
            filter.areaOfWork = areaOfWork;
        }

        const configuration = await ServiceConfiguration.findOne(filter)
            .select('category service areaOfWork pricingModel certificationRequired requiredCertifications projectTypes professionalInputFields includedItems extraOptions conditionsAndWarnings activeCountries');

        if (!configuration) {
            return res.status(404).json({
                success: false,
                message: 'Service configuration not found for the selected options'
            });
        }

        // Parse pricingModel to array - split by " or "
        const pricingModels = configuration.pricingModel ?
            configuration.pricingModel.split(' or ').map((m: string) => m.trim()) :
            [];

        res.status(200).json({
            success: true,
            data: {
                ...configuration.toObject(),
                pricingModels // Return as array of original strings from DB
            }
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
 * Get dynamic fields for a service (what the professional needs to fill)
 * @route GET /api/professional/service-configuration/dynamic-fields
 */
export const getDynamicFieldsForService = async (req: Request, res: Response) => {
    try {
        const { category, service, areaOfWork, country = 'BE' } = req.query as any;

        if (!category || !service) {
            return res.status(400).json({
                success: false,
                message: 'Category and service are required'
            });
        }

        const filter: any = {
            category,
            service,
            isActive: true,
            activeCountries: country
        };

        if (areaOfWork && areaOfWork !== 'Not applicable') {
            filter.areaOfWork = areaOfWork;
        }

        const configuration = await ServiceConfiguration.findOne(filter).select('professionalInputFields projectTypes');

        if (!configuration) {
            return res.status(404).json({
                success: false,
                message: 'Service configuration not found'
            });
        }

        res.status(200).json({
            success: true,
            data: {
                professionalInputFields: configuration.professionalInputFields,
                projectTypes: configuration.projectTypes
            }
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error fetching dynamic fields',
            error: error.message
        });
    }
};

/**
 * Get categories available for professionals
 * @route GET /api/professional/categories
 */
export const getCategoriesForProfessional = async (req: Request, res: Response) => {
    try {
        const { country = 'BE' } = req.query as any;

        const categories = await ServiceConfiguration.distinct('category', {
            isActive: true,
            activeCountries: country
        });

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
 * Get services by category for professionals
 * @route GET /api/professional/services/:category
 */
export const getServicesByCategoryForProfessional = async (req: Request, res: Response) => {
    try {
        const { category } = req.params;
        const { country = 'BE' } = req.query as any;

        const services = await ServiceConfiguration.distinct('service', {
            category,
            isActive: true,
            activeCountries: country
        });

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

/**
 * Get areas of work for a service
 * @route GET /api/professional/areas-of-work
 */
export const getAreasOfWork = async (req: Request, res: Response) => {
    try {
        const { category, service, country = 'BE' } = req.query as any;

        if (!category || !service) {
            return res.status(400).json({
                success: false,
                message: 'Category and service are required'
            });
        }

        const areasOfWork = await ServiceConfiguration.distinct('areaOfWork', {
            category,
            service,
            isActive: true,
            activeCountries: country
        });

        // Filter out null/undefined values
        const validAreas = areasOfWork.filter(area => area);

        res.status(200).json({
            success: true,
            data: validAreas.sort()
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            message: 'Error fetching areas of work',
            error: error.message
        });
    }
};
