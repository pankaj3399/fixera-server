import { Schema, model, Document } from "mongoose";

export enum PricingModelType {
    FIXED = 'Fixed price',
    UNIT = 'Price per unit'
}

export enum PricingModelUnit {
    M2 = 'm2',
    HOUR = 'hour',
    DAY = 'day',
    METER = 'meter',
    ROOM = 'room',
    UNIT = 'unit'
}

// Dynamic field types that professionals need to fill in
export interface IDynamicField {
    fieldName: string; // e.g., "range m2 living area", "Building Type", "kW system power"
    fieldType: 'range' | 'dropdown' | 'number' | 'text'; // Type of input field
    unit?: string; // e.g., "m2", "m3", "kW", "kWh", "Wp", "m3/h"
    label: string; // Display label for the field
    placeholder?: string;
    isRequired: boolean;
    options?: string[]; // For dropdown fields
    min?: number; // For number and range fields
    max?: number; // For number and range fields
}

// Items that can be included in the service
export interface IIncludedItem {
    name: string;
    description?: string;
    isDynamic: boolean; // If true, this is a field professionals fill in (from red text)
    dynamicField?: IDynamicField; // Configuration for dynamic field
}

// Extra options/add-ons
export interface IExtraOption {
    name: string;
    description?: string;
    isCustomizable: boolean; // Can professional modify this?
}

// Terms, conditions, and warnings
export interface IConditionWarning {
    text: string;
    type: 'condition' | 'warning';
}

// Main service configuration interface
export interface IServiceConfiguration extends Document {
    // Core identifiers (NOT configurable by admin)
    category: string; // e.g., "Exterior", "Interior", "Outdoor work"
    service: string; // e.g., "Architect", "Demolition Plan", "Plumbing"

    // Admin-configurable fields
    areaOfWork?: string; // e.g., "Strip Foundations", "Raft Foundation"
    pricingModelName: string; // e.g., "Total price", "Total price or m² of material"
    pricingModel: string; // Virtual for backward compatibility (maps to pricingModelName)
    pricingModelType: 'Fixed price' | 'Price per unit';
    pricingModelUnit?: PricingModelUnit; // conditionally required if 'Price per unit'
    icon?: string; // Icon identifier (e.g., "Hammer", "Wrench")
    certificationRequired: boolean;
    requiredCertifications?: string[]; // Specific certification types required

    // Project types (multi-select options)
    projectTypes: string[]; // e.g., ["New Built", "Extension", "Refurbishment"]

    // Included items/services (with dynamic fields marked)
    includedItems: IIncludedItem[];

    // Dynamic fields that professionals must fill
    professionalInputFields: IDynamicField[];

    // Extra options/add-ons
    extraOptions: IExtraOption[];

    // Conditions and warnings
    conditionsAndWarnings: IConditionWarning[];

    // Metadata
    isActive: boolean;
    activeCountries: string[]; // Countries where this config is active
    createdAt: Date;
    updatedAt: Date;
}

// Dynamic Field Schema
const DynamicFieldSchema = new Schema<IDynamicField>({
    fieldName: { type: String, required: true },
    fieldType: {
        type: String,
        enum: ['range', 'dropdown', 'number', 'text'],
        required: true
    },
    unit: { type: String },
    label: { type: String, required: true },
    placeholder: { type: String },
    isRequired: { type: Boolean, default: true },
    options: [{ type: String }],
    min: { type: Number },
    max: { type: Number }
}, { _id: false });

// Included Item Schema
const IncludedItemSchema = new Schema<IIncludedItem>({
    name: { type: String, required: true },
    description: { type: String },
    isDynamic: { type: Boolean, default: false },
    dynamicField: { type: DynamicFieldSchema }
}, { _id: false });

// Extra Option Schema
const ExtraOptionSchema = new Schema<IExtraOption>({
    name: { type: String, required: true },
    description: { type: String },
    isCustomizable: { type: Boolean, default: false }
}, { _id: false });

// Condition/Warning Schema
const ConditionWarningSchema = new Schema<IConditionWarning>({
    text: { type: String, required: true },
    type: { type: String, enum: ['condition', 'warning'], required: true }
}, { _id: false });

// Main Service Configuration Schema
const ServiceConfigurationSchema = new Schema<IServiceConfiguration>({
    // Core identifiers
    category: { type: String, required: true, index: true },
    service: { type: String, required: true, index: true },

    // Admin-configurable fields
    areaOfWork: { type: String },
    pricingModelName: { type: String, required: false },
    pricingModelType: { 
        type: String, 
        required: true,
        enum: ['Fixed price', 'Price per unit']
    },
    pricingModelUnit: { type: String, enum: Object.values(PricingModelUnit) },
    icon: { type: String },
    certificationRequired: { type: Boolean, default: false },
    requiredCertifications: [{ type: String, default: [] }],

    projectTypes: [{ type: String }],

    includedItems: [IncludedItemSchema],
    professionalInputFields: [DynamicFieldSchema],
    extraOptions: [ExtraOptionSchema],
    conditionsAndWarnings: [ConditionWarningSchema],

    // Metadata
    isActive: { type: Boolean, default: true },
    activeCountries: { type: [String], default: ['BE'] }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Virtual for backward compatibility
ServiceConfigurationSchema.virtual('pricingModel')
    .get(function() {
        return this.pricingModelName;
    })
    .set(function(val: string) {
        this.pricingModelName = val;
    });

ServiceConfigurationSchema.pre('validate', function(next) {
    if (this.pricingModelType === PricingModelType.FIXED) {
        this.pricingModelUnit = undefined;
    } else if (this.pricingModelType === PricingModelType.UNIT) {
        if (!this.pricingModelUnit) {
            this.invalidate('pricingModelUnit', 'pricingModelUnit is required when pricingModelType is "Price per unit"');
        }
    }
    next();
});

// Validate pricing fields on update operations
const validateUpdate = function (this: any, next: any) {
    const update = this.getUpdate();
    const set = update.$set || update;

    const pricingModelType = set.pricingModelType;
    const pricingModelUnit = set.pricingModelUnit;

    if (pricingModelType === PricingModelType.FIXED) {
        set.pricingModelUnit = undefined;
    } else if (pricingModelType === PricingModelType.UNIT && !pricingModelUnit) {
        // Unit may come from the existing document; skip hard validation here
    }

    this.setUpdate(update);
    next();
};

ServiceConfigurationSchema.pre('findOneAndUpdate', validateUpdate);
ServiceConfigurationSchema.pre('updateOne', validateUpdate);
ServiceConfigurationSchema.pre('updateMany', validateUpdate);

// Indexes for efficient querying
ServiceConfigurationSchema.index({ category: 1, service: 1, areaOfWork: 1 });
ServiceConfigurationSchema.index({ isActive: 1, activeCountries: 1 });
ServiceConfigurationSchema.index({ category: 1, isActive: 1 });

const ServiceConfiguration = model<IServiceConfiguration>('ServiceConfiguration', ServiceConfigurationSchema);

export default ServiceConfiguration;
