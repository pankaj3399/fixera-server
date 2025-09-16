import { Schema, model, Document } from "mongoose";

// Interfaces for nested schemas
export interface ICertification {
    name: string;
    fileUrl: string;
    uploadedAt: Date;
    isRequired: boolean;
}

export interface IDistance {
    address: string;
    useCompanyAddress: boolean;
    maxKmRange: number;
    noBorders: boolean;
}

export interface IIntakeMeeting {
    enabled: boolean;
    resources: string[]; // Team member IDs
}

export interface IRenovationPlanning {
    fixeraManaged: boolean;
    resources: string[];
}

export interface IMedia {
    images: string[];
    video?: string;
}

export interface IPricing {
    type: 'fixed' | 'unit' | 'rfq';
    amount?: number;
    priceRange?: { min: number; max: number };
    minProjectValue?: number;
}

export interface IIncludedItem {
    name: string;
    description?: string;
    isCustom: boolean;
}

export interface IExecutionDuration {
    value: number;
    unit: 'hours' | 'days';
    range?: { min: number; max: number };
}

export interface IBuffer {
    value: number;
    unit: 'hours' | 'days';
}

export interface IIntakeDuration {
    value: number;
    unit: 'hours' | 'days';
    buffer?: number;
}

export interface ISubproject {
    name: string;
    description: string;
    pricing: IPricing;
    included: IIncludedItem[];
    materialsIncluded: boolean;
    deliveryPreparation: number;
    executionDuration: IExecutionDuration;
    buffer?: IBuffer;
    intakeDuration?: IIntakeDuration;
    warrantyPeriod: number;
}

export interface IExtraOption {
    name: string;
    description?: string;
    price: number;
    isCustom: boolean;
}

export interface ITermCondition {
    name: string;
    description: string;
    additionalCost?: number;
    isCustom: boolean;
}

export interface IFAQ {
    question: string;
    answer: string;
    isGenerated: boolean;
}

export interface IRFQQuestion {
    question: string;
    type: 'text' | 'multiple_choice' | 'attachment';
    options?: string[];
    isRequired: boolean;
}

export interface IPostBookingQuestion {
    question: string;
    type: 'text' | 'multiple_choice' | 'attachment';
    options?: string[];
    isRequired: boolean;
}

export interface IQualityCheck {
    category: string;
    status: 'passed' | 'failed' | 'warning';
    message: string;
    checkedAt: Date;
}

export interface IProject extends Document {
    // Step 1: Basic Info
    professionalId: string;
    category: string;
    service: string;
    areaOfWork?: string;
    certifications: ICertification[];
    distance: IDistance;
    intakeMeeting?: IIntakeMeeting;
    renovationPlanning?: IRenovationPlanning;
    resources: string[];
    projectType: string[];
    description: string;
    priceModel: 'fixed' | 'meter' | 'm2' | 'hour' | 'day' | 'room';
    keywords: string[];
    title: string;
    media: IMedia;

    // Step 2: Subprojects (max 5)
    subprojects: ISubproject[];

    // Step 3: Extra Options
    extraOptions: IExtraOption[];
    termsConditions: ITermCondition[];

    // Step 4: FAQ
    faq: IFAQ[];

    // Step 5: RFQ Questions
    rfqQuestions: IRFQQuestion[];

    // Step 6: Post-Booking Questions
    postBookingQuestions: IPostBookingQuestion[];

    // Step 7: Custom Confirmation
    customConfirmationMessage?: string;

    // Step 8: Review & Status
    status: 'draft' | 'pending_approval' | 'published' | 'quoted' | 'booked' | 'in_progress' | 'completed' | 'awaiting_confirmation' | 'closed' | 'disputed';
    qualityChecks: IQualityCheck[];
    adminFeedback?: string;
    submittedAt?: Date;
    approvedAt?: Date;
    approvedBy?: string;

    // Auto-save tracking
    autoSaveTimestamp: Date;
    currentStep: number;

    // Metadata
    createdAt: Date;
    updatedAt: Date;
}

// Certification Schema
const CertificationSchema = new Schema<ICertification>({
    name: { type: String, required: true },
    fileUrl: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
    isRequired: { type: Boolean, default: false }
});

// Distance Schema
const DistanceSchema = new Schema<IDistance>({
    address: { type: String, required: true },
    useCompanyAddress: { type: Boolean, default: false },
    maxKmRange: { type: Number, required: true, min: 1, max: 200 },
    noBorders: { type: Boolean, default: false }
});

// Intake Meeting Schema
const IntakeMeetingSchema = new Schema<IIntakeMeeting>({
    enabled: { type: Boolean, default: false },
    resources: [{ type: String }]
});

// Renovation Planning Schema
const RenovationPlanningSchema = new Schema<IRenovationPlanning>({
    fixeraManaged: { type: Boolean, default: false },
    resources: [{ type: String }]
});

// Media Schema
const MediaSchema = new Schema<IMedia>({
    images: [{ type: String }],
    video: { type: String }
});

// Pricing Schema
const PricingSchema = new Schema<IPricing>({
    type: { type: String, enum: ['fixed', 'unit', 'rfq'], required: true },
    amount: { type: Number, min: 0 },
    priceRange: {
        min: { type: Number, min: 0 },
        max: { type: Number, min: 0 }
    },
    minProjectValue: { type: Number, min: 0 }
});

// Included Item Schema
const IncludedItemSchema = new Schema<IIncludedItem>({
    name: { type: String, required: true },
    description: { type: String },
    isCustom: { type: Boolean, default: false }
});

// Execution Duration Schema
const ExecutionDurationSchema = new Schema<IExecutionDuration>({
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['hours', 'days'], required: true },
    range: {
        min: { type: Number, min: 0 },
        max: { type: Number, min: 0 }
    }
});

// Buffer Schema
const BufferSchema = new Schema<IBuffer>({
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['hours', 'days'], required: true }
});

// Intake Duration Schema
const IntakeDurationSchema = new Schema<IIntakeDuration>({
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ['hours', 'days'], required: true },
    buffer: { type: Number, min: 0 }
});

// Subproject Schema
const SubprojectSchema = new Schema<ISubproject>({
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 500 },
    pricing: { type: PricingSchema, required: true },
    included: [IncludedItemSchema],
    materialsIncluded: { type: Boolean, default: false },
    deliveryPreparation: { type: Number, required: true, min: 0 },
    executionDuration: { type: ExecutionDurationSchema, required: true },
    buffer: BufferSchema,
    intakeDuration: IntakeDurationSchema,
    warrantyPeriod: { type: Number, min: 0, max: 10, default: 0 }
});

// Extra Option Schema
const ExtraOptionSchema = new Schema<IExtraOption>({
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 300 },
    price: { type: Number, required: true, min: 0 },
    isCustom: { type: Boolean, default: false }
});

// Term Condition Schema
const TermConditionSchema = new Schema<ITermCondition>({
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 500 },
    additionalCost: { type: Number, min: 0 },
    isCustom: { type: Boolean, default: false }
});

// FAQ Schema
const FAQSchema = new Schema<IFAQ>({
    question: { type: String, required: true, maxlength: 200 },
    answer: { type: String, required: true, maxlength: 1000 },
    isGenerated: { type: Boolean, default: false }
});

// RFQ Question Schema
const RFQQuestionSchema = new Schema<IRFQQuestion>({
    question: { type: String, required: true, maxlength: 200 },
    type: { type: String, enum: ['text', 'multiple_choice', 'attachment'], required: true },
    options: [{ type: String }],
    isRequired: { type: Boolean, default: false }
});

// Post Booking Question Schema
const PostBookingQuestionSchema = new Schema<IPostBookingQuestion>({
    question: { type: String, required: true, maxlength: 200 },
    type: { type: String, enum: ['text', 'multiple_choice', 'attachment'], required: true },
    options: [{ type: String }],
    isRequired: { type: Boolean, default: false }
});

// Quality Check Schema
const QualityCheckSchema = new Schema<IQualityCheck>({
    category: { type: String, required: true },
    status: { type: String, enum: ['passed', 'failed', 'warning'], required: true },
    message: { type: String, required: true },
    checkedAt: { type: Date, default: Date.now }
});

// Main Project Schema
const ProjectSchema = new Schema<IProject>({
    // Step 1: Basic Info
    professionalId: { type: String, required: true },
    category: { type: String, required: true },
    service: { type: String, required: true },
    areaOfWork: { type: String },
    certifications: [CertificationSchema],
    distance: { type: DistanceSchema, required: true },
    intakeMeeting: IntakeMeetingSchema,
    renovationPlanning: RenovationPlanningSchema,
    resources: [{ type: String }],
    projectType: [{ type: String }],
    description: { type: String, required: true, maxlength: 1300 },
    priceModel: {
        type: String,
        enum: ['fixed', 'meter', 'm2', 'hour', 'day', 'room'],
        required: true
    },
    keywords: [{ type: String }],
    title: { type: String, required: true, minlength: 30, maxlength: 90 },
    media: { type: MediaSchema, required: true },

    // Step 2: Subprojects
    subprojects: [SubprojectSchema],

    // Step 3: Extra Options
    extraOptions: [ExtraOptionSchema],
    termsConditions: [TermConditionSchema],

    // Step 4: FAQ
    faq: [FAQSchema],

    // Step 5: RFQ Questions
    rfqQuestions: [RFQQuestionSchema],

    // Step 6: Post-Booking Questions
    postBookingQuestions: [PostBookingQuestionSchema],

    // Step 7: Custom Confirmation
    customConfirmationMessage: { type: String, maxlength: 1000 },

    // Step 8: Review & Status
    status: {
        type: String,
        enum: [
            'draft',
            'pending_approval',
            'published',
            'quoted',
            'booked',
            'in_progress',
            'completed',
            'awaiting_confirmation',
            'closed',
            'disputed'
        ],
        default: 'draft'
    },
    qualityChecks: [QualityCheckSchema],
    adminFeedback: { type: String },
    submittedAt: { type: Date },
    approvedAt: { type: Date },
    approvedBy: { type: String },

    // Auto-save tracking
    autoSaveTimestamp: { type: Date, default: Date.now },
    currentStep: { type: Number, default: 1, min: 1, max: 8 },
}, {
    timestamps: true
});

// Indexes for performance
ProjectSchema.index({ professionalId: 1, status: 1 });
ProjectSchema.index({ status: 1, submittedAt: 1 });
ProjectSchema.index({ category: 1, service: 1 });

// Pre-save middleware for auto-save timestamp
ProjectSchema.pre('save', function(next) {
    this.autoSaveTimestamp = new Date();
    next();
});

const Project = model<IProject>('Project', ProjectSchema);

export default Project;