"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = require("mongoose");
// Certification Schema
const CertificationSchema = new mongoose_1.Schema({
    name: { type: String, required: true },
    fileUrl: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
    isRequired: { type: Boolean, default: false },
});
// Distance Schema
const DistanceSchema = new mongoose_1.Schema({
    address: { type: String, required: true },
    useCompanyAddress: { type: Boolean, default: false },
    maxKmRange: { type: Number, required: true, min: 1, max: 200 },
    noBorders: { type: Boolean, default: false },
    borderLevel: {
        type: String,
        enum: ['none', 'country', 'province'],
        default: 'country' // Default to country-level for backward compatibility
    },
});
// Intake Meeting Schema
const IntakeMeetingSchema = new mongoose_1.Schema({
    enabled: { type: Boolean, default: false },
    resources: [{ type: String }],
});
// Renovation Planning Schema
const RenovationPlanningSchema = new mongoose_1.Schema({
    fixeraManaged: { type: Boolean, default: false },
    resources: [{ type: String }],
});
// Media Schema
const MediaSchema = new mongoose_1.Schema({
    images: [{ type: String }],
    video: { type: String },
});
// Pricing Schema
const PricingSchema = new mongoose_1.Schema({
    type: { type: String, enum: ["fixed", "unit", "rfq"], required: true },
    amount: { type: Number, min: 0 },
    priceRange: {
        min: { type: Number, min: 0 },
        max: { type: Number, min: 0 },
    },
    minProjectValue: { type: Number, min: 0 },
});
// Included Item Schema
const IncludedItemSchema = new mongoose_1.Schema({
    name: { type: String, required: true },
    description: { type: String },
    isCustom: { type: Boolean, default: false },
});
// Material Schema
const MaterialSchema = new mongoose_1.Schema({
    name: { type: String, required: true, maxlength: 200 },
    quantity: { type: String, maxlength: 50 },
    unit: { type: String, maxlength: 50 },
    description: { type: String, maxlength: 500 },
});
// Execution Duration Schema
const ExecutionDurationSchema = new mongoose_1.Schema({
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ["hours", "days"], required: true },
    range: {
        min: { type: Number, min: 0 },
        max: { type: Number, min: 0 },
    },
});
// Buffer Schema
const BufferSchema = new mongoose_1.Schema({
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ["hours", "days"], required: true },
});
// Intake Duration Schema
const IntakeDurationSchema = new mongoose_1.Schema({
    value: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ["hours", "days"], required: true },
    buffer: { type: Number, min: 0 },
});
// Professional Input Value Schema
const ProfessionalInputValueSchema = new mongoose_1.Schema({
    fieldName: { type: String, required: true },
    value: { type: mongoose_1.Schema.Types.Mixed, required: true },
});
// Subproject Schema
const SubprojectSchema = new mongoose_1.Schema({
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 300 },
    projectType: [{ type: String }],
    customProjectType: { type: String, maxlength: 100 },
    professionalInputs: [ProfessionalInputValueSchema],
    pricing: { type: PricingSchema, required: true },
    included: [IncludedItemSchema],
    materialsIncluded: { type: Boolean, default: false },
    materials: [MaterialSchema],
    deliveryPreparation: { type: Number, required: true, min: 0 },
    executionDuration: { type: ExecutionDurationSchema, required: true },
    buffer: BufferSchema,
    intakeDuration: IntakeDurationSchema,
    warrantyPeriod: {
        value: { type: Number, min: 0, max: 10, default: 0 },
        unit: { type: String, enum: ["months", "years"], default: "years" },
    },
});
// Extra Option Schema
const ExtraOptionSchema = new mongoose_1.Schema({
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 300 },
    price: { type: Number, required: true, min: 0 },
    isCustom: { type: Boolean, default: false },
});
// Term Condition Schema
const TermConditionSchema = new mongoose_1.Schema({
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 500 },
    additionalCost: { type: Number, min: 0 },
    isCustom: { type: Boolean, default: false },
});
// FAQ Schema
const FAQSchema = new mongoose_1.Schema({
    question: { type: String, required: true, maxlength: 200 },
    answer: { type: String, required: true, maxlength: 1000 },
    isGenerated: { type: Boolean, default: false },
});
// RFQ Question Schema
const RFQQuestionSchema = new mongoose_1.Schema({
    question: { type: String, required: true, maxlength: 200 },
    type: {
        type: String,
        enum: ["text", "multiple_choice", "attachment"],
        required: true,
    },
    options: [{ type: String }],
    isRequired: { type: Boolean, default: false },
    professionalAttachments: [{ type: String }],
});
// Post Booking Question Schema
const PostBookingQuestionSchema = new mongoose_1.Schema({
    question: { type: String, required: true, maxlength: 200 },
    type: {
        type: String,
        enum: ["text", "multiple_choice", "attachment"],
        required: true,
    },
    options: [{ type: String }],
    isRequired: { type: Boolean, default: false },
    professionalAttachments: [{ type: String }],
});
// Quality Check Schema
const QualityCheckSchema = new mongoose_1.Schema({
    category: { type: String, required: true },
    status: {
        type: String,
        enum: ["passed", "failed", "warning"],
        required: true,
    },
    message: { type: String, required: true },
    checkedAt: { type: Date, default: Date.now },
});
// Service Selection Schema
const ServiceSelectionSchema = new mongoose_1.Schema({
    category: { type: String, required: true },
    service: { type: String, required: true },
    areaOfWork: { type: String },
});
// Main Project Schema
const ProjectSchema = new mongoose_1.Schema({
    // Scheduling configuration
    timeMode: {
        type: String,
        enum: ["hours", "days"],
    },
    preparationDuration: {
        value: { type: Number, min: 0 },
        unit: { type: String, enum: ["hours", "days"] },
    },
    executionDuration: {
        type: ExecutionDurationSchema,
    },
    bufferDuration: {
        type: BufferSchema,
    },
    minResources: {
        type: Number,
        min: 1,
    },
    minOverlapPercentage: {
        type: Number,
        min: 0,
        max: 100,
        default: 70,
    },
    // Step 1: Basic Info
    professionalId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, required: true },
    service: { type: String, required: true },
    areaOfWork: { type: String },
    serviceConfigurationId: { type: String },
    categories: [{ type: String }],
    services: {
        type: [ServiceSelectionSchema],
        validate: {
            validator: function (v) {
                // Services array is optional - single service stored in category/service fields
                if (!v || v.length === 0)
                    return true;
                return v.length >= 1 && v.length <= 1; // Now only allows 1 service
            },
            message: "Services must contain exactly 1 item",
        },
    },
    certifications: [CertificationSchema],
    distance: { type: DistanceSchema, required: true },
    intakeMeeting: IntakeMeetingSchema,
    renovationPlanning: RenovationPlanningSchema,
    resources: [{ type: String }],
    description: { type: String, required: true, maxlength: 1300 },
    priceModel: {
        type: String,
        required: true,
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
    // Project lifecycle status
    status: {
        type: String,
        enum: ["draft", "pending", "rejected", "published", "on_hold", "suspended"],
        default: "draft",
    },
    // Booking lifecycle status
    bookingStatus: {
        type: String,
        enum: [
            "rfq",
            "quoted",
            "booked",
            "execution",
            "completed",
            "cancelled",
            "dispute",
            "warranty",
        ],
        required: false,
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
    timestamps: true,
});
ProjectSchema.index({ status: 1, submittedAt: 1 });
ProjectSchema.index({ professionalId: 1, status: 1 });
ProjectSchema.index({ professionalId: 1, updatedAt: -1 });
ProjectSchema.index({ professionalId: 1, autoSaveTimestamp: -1 });
// Text indexes for search functionality
ProjectSchema.index({ title: 'text', description: 'text' });
ProjectSchema.index({ category: 1, service: 1 });
ProjectSchema.index({ status: 1 });
// Pre-save middleware for auto-save timestamp
ProjectSchema.pre("save", function (next) {
    this.autoSaveTimestamp = new Date();
    next();
});
const Project = (0, mongoose_1.model)("Project", ProjectSchema);
exports.default = Project;
