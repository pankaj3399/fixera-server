import "dotenv/config";
import mongoose from "mongoose";
import Project from "../models/project";
import User from "../models/user";
import { buildProjectScheduleProposals } from "../utils/scheduleEngine";

const PROJECT_ID = "695c2a7c7b0d3d00e194548d";
const DEMO_ATTACHMENT_URL =
  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

const weekdayAvailability = {
  monday: { available: true, startTime: "09:00", endTime: "17:00" },
  tuesday: { available: true, startTime: "09:00", endTime: "17:00" },
  wednesday: { available: true, startTime: "09:00", endTime: "17:00" },
  thursday: { available: true, startTime: "09:00", endTime: "17:00" },
  friday: { available: true, startTime: "09:00", endTime: "17:00" },
  saturday: { available: false, startTime: "09:00", endTime: "17:00" },
  sunday: { available: false, startTime: "09:00", endTime: "17:00" },
};

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI or MONGO_URI is required");
  }

  await mongoose.connect(mongoUri);

  const project = await Project.findById(PROJECT_ID);
  if (!project) {
    throw new Error(`Project ${PROJECT_ID} not found`);
  }

  const professionalId = String(project.professionalId);
  const professional = await User.findById(professionalId);
  if (!professional) {
    throw new Error(`Professional ${professionalId} not found`);
  }

  professional.businessInfo = {
    ...professional.businessInfo,
    companyName:
      professional.businessInfo?.companyName || "Janssen Project Services",
    city: professional.businessInfo?.city || "Brussels",
    country: professional.businessInfo?.country || "Belgium",
    postalCode: professional.businessInfo?.postalCode || "1000",
    timezone: "Europe/Brussels",
  };
  professional.companyAvailability = weekdayAvailability;
  professional.availability = weekdayAvailability;
  if (professional.employee) {
    professional.employee.availabilityPreference = "same_as_company";
  }
  await professional.save();

  project.status = "published";
  project.title = "Mortsel Interior Painting RFQ Flow Test Project";
  project.description =
    "RFQ-only test project for validating the quotation request flow, professional quotation wizard, chat quotation notifications, post-accept scheduling, post-booking questions, and split-payment handling in development.";
  project.category = project.category || "Home Improvement";
  project.service = project.service || "Interior Painting";
  project.priceModel = "RFQ";
  project.timeMode = "hours";
  project.minResources = 1;
  project.minOverlapPercentage = 70;
  project.resources = [professionalId];
  project.keywords = [
    "rfq",
    "quotation",
    "painting",
    "mortsel",
    "test flow",
  ];
  project.extraOptions = [
    {
      name: "Furniture Protection Setup",
      description:
        "Protect floors and furniture with additional covering before work starts.",
      price: 45,
      isCustom: false,
    },
    {
      name: "Premium Low-VOC Materials",
      description:
        "Upgrade to premium low-emission materials for an improved indoor finish.",
      price: 120,
      isCustom: false,
    },
    {
      name: "End-of-Day Cleanup",
      description:
        "Deep cleanup of the work area after the scheduled work window is complete.",
      price: 35,
      isCustom: true,
    },
  ];
  project.rfqQuestions = [
    {
      question: "Describe the room or area that needs work.",
      type: "text",
      isRequired: true,
    },
    {
      question: "How urgent is this quotation request?",
      type: "multiple_choice",
      options: ["This week", "Within 2 weeks", "This month", "Flexible"],
      isRequired: true,
    },
    {
      question: "Upload photos, plans, or measurements if available.",
      type: "attachment",
      isRequired: false,
      professionalAttachments: [DEMO_ATTACHMENT_URL],
    },
  ];
  project.postBookingQuestions = [
    {
      question: "What is the approximate surface area in square meters?",
      type: "text",
      isRequired: true,
    },
    {
      question: "What site-access situation best applies?",
      type: "multiple_choice",
      options: [
        "Street parking available",
        "Permit required",
        "Limited access / narrow stairs",
        "Please call on arrival",
      ],
      isRequired: true,
    },
    {
      question: "Upload any final site photos or access instructions.",
      type: "attachment",
      isRequired: false,
      professionalAttachments: [DEMO_ATTACHMENT_URL],
    },
  ];
  project.customConfirmationMessage =
    "Your quotation request has been sent. The professional has 4 working days to respond. Scheduling, extra options, and any post-booking questions will be completed after you accept the quotation.";
  project.faq = [
    {
      question: "When do I choose the actual start date?",
      answer:
        "You choose the final schedule after you accept the quotation. The RFQ request itself does not require booking a date.",
      isGenerated: false,
    },
  ];
  project.termsConditions = [
    {
      name: "Availability Window",
      description:
        "Final scheduling is confirmed after quotation acceptance and depends on resource availability.",
      type: "condition",
      isCustom: false,
    },
  ];

  const baseSubproject = project.subprojects?.[0];
  project.subprojects = [
    {
      name: "Interior Painting Consultation Package",
      description:
        "RFQ package for interior painting with a scoped quotation and milestone-ready delivery plan.",
      projectType: baseSubproject?.projectType?.length
        ? baseSubproject.projectType
        : ["Interior"],
      customProjectType: baseSubproject?.customProjectType,
      professionalInputs: baseSubproject?.professionalInputs || [
        { fieldName: "Building Type", value: "Residential apartment" },
        { fieldName: "Floor Area (m2)", value: { min: 40, max: 120 } },
        { fieldName: "Number of Rooms", value: 4 },
      ],
      pricing: {
        type: "rfq",
      },
      included: [
        {
          name: "Initial surface preparation review",
          description: "Assessment of the site and prep work before execution.",
          isCustom: false,
        },
        {
          name: "Quotation scope definition",
          description:
            "Detailed scope and exclusions provided inside the quotation.",
          isCustom: false,
        },
        {
          name: "Execution planning",
          description:
            "Preparation, execution, and buffer durations are defined in the quotation.",
          isCustom: false,
        },
      ],
      materialsIncluded: false,
      materials: [],
      preparationDuration: {
        value: 1,
        unit: "hours",
      },
      executionDuration: {
        value: 2,
        unit: "hours",
      },
      buffer: {
        value: 1,
        unit: "hours",
      },
      warrantyPeriod: {
        value: 2,
        unit: "years",
      },
    } as any,
  ];

  await project.save();

  const proposals = await buildProjectScheduleProposals(PROJECT_ID, 0);

  console.log(
    JSON.stringify(
      {
        success: true,
        projectId: PROJECT_ID,
        professional: {
          id: professionalId,
          email: professional.email,
          name: professional.name,
        },
        seeded: {
          title: project.title,
          status: project.status,
          resources: project.resources,
          rfqQuestions: project.rfqQuestions.length,
          postBookingQuestions: project.postBookingQuestions.length,
          extraOptions: project.extraOptions.length,
          subprojectPricingType: project.subprojects?.[0]?.pricing?.type,
          timeMode: project.timeMode,
        },
        scheduleProposals: proposals,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
