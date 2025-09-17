import { Schema, model, Document } from "mongoose";

export interface IService {
    name: string;
    slug: string;
    description?: string;
    pricingModels: string[]; // Available pricing models for this service
    areasOfWork?: string[]; // Sub-categories/areas of work
    projectTypes?: string[]; // Predefined project types
    requiredCertifications?: string[];
    isActive: boolean;
    countries: string[]; // Countries where this service is available
}

export interface IServiceCategory extends Document {
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    isActive: boolean;
    countries: string[]; // Countries where this category is available
    services: IService[];
    createdAt: Date;
    updatedAt: Date;
}

// Service Schema
const ServiceSchema = new Schema<IService>({
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String },
    pricingModels: [{
        type: String,
        enum: ['fixed', 'meter', 'm2', 'hour', 'day', 'room']
    }],
    areasOfWork: [{ type: String }],
    projectTypes: [{ type: String }],
    requiredCertifications: [{ type: String }],
    isActive: { type: Boolean, default: true },
    countries: [{ type: String }]
});

// Main Service Category Schema
const ServiceCategorySchema = new Schema<IServiceCategory>({
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String },
    icon: { type: String },
    isActive: { type: Boolean, default: true },
    countries: [{ type: String }],
    services: [ServiceSchema]
}, {
    timestamps: true
});

// Indexes
ServiceCategorySchema.index({ slug: 1 });
ServiceCategorySchema.index({ isActive: 1, countries: 1 });
ServiceCategorySchema.index({ 'services.slug': 1 });

const ServiceCategory = model<IServiceCategory>('ServiceCategory', ServiceCategorySchema);

export default ServiceCategory;