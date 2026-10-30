import { Request, Response, NextFunction } from "express";
import Booking, { IBooking, BookingStatus } from "../../models/booking";
import Payment from "../../models/payment";
import User from "../../models/user";
import Project from "../../models/project";
import mongoose from "mongoose";
import {
  buildProjectScheduleWindow,
  resolveProjectScheduleQuantity,
  getProjectDurations,
  validateProjectScheduleSelection,
} from "../../utils/scheduleEngine";
import { presignS3Url, uploadToS3, generateFileName } from "../../utils/s3Upload";
import { resolveSubprojectIndex } from "../../utils/bookingHelpers";
import { sendCancellationRequestAdminEmail } from "../../utils/emailService";
import { getProfessionalDisplayName } from "../../utils/displayName";
import CancellationRequest, { ACTIVE_CANCELLATION_STATUSES, CANCELLATION_REASON_CATEGORIES, CANCELLATION_REASON_LABELS, CancellationReasonCategory } from "../../models/cancellationRequest";
import { addBusinessDays, REFUND_RESPONSE_BUSINESS_DAYS } from "../../utils/businessDays";
import { notify } from "../../utils/notifications/notify";
import {
  bookingForRequest,
  bookingForViewer,
  sanitizePaymentForViewer,
  stripProPayoutSummaryForCustomer,
} from "../../utils/invoiceVisibility";
import { IUser } from "../../models/user";
import { maskAnonymizedUser, maskBookingForAnonymizedParties } from "../../utils/accountAnonymity";
import { applyB2BInvoiceRule, firstVatCountry, parseVatCountryCode, requiresVatRfqReview, resolveVatDecisionFromConfig } from "../../utils/vatManagement";
import ServiceConfiguration from "../../models/serviceConfiguration";
import { sendHandlerError } from '../../utils/handlerErrors';
import { runWithEmailActor } from '../../utils/emailActorContext';
import { UserFacingError } from '../../utils/appErrors';
import { assertValidInvoiceUnit } from '../../utils/invoiceUnits';
import {
  attachBookingDetails,
  buildDetailsForBookingDocument,
} from './details';
import {
  filterRawBookingForAdminArea,
  isAdminUser,
  resolveBookingAdminAccess,
  type BookingAdminAccess,
} from '../../utils/bookingDetails/adminAccess';
import { buildBookingCalendarKeys, reserveBookingCalendar } from '../../utils/support/bookingCalendar';
import { withAnonymizationWriteFence } from '../../utils/support/accountGuard';
import {
  captureBookingSnapshotIfMissing,
  loadVatQuestionDefinitions,
  resolveScheduleTimeZone,
} from '../../utils/bookingDetails/capture';
import { isQuestionAnswerUploadOwnedByUser, isUploadOwnedByUser } from '../../utils/bookingDetails/attachments';
import { presignOwnedUrl, presignQuestionAnswerUrl, referenceId } from '../../utils/bookingDetails/attachments';
import { selectedPriceModel } from "../../utils/bookingDetails/overviewRows";
import { snapshotQuestionDefinitions } from '../../utils/bookingDetails/snapshot';

/** When VAT logic returns RFQ, customer may opt in to book at the standard rate instead. */
const applyProceedAtStandardVatIfRequested = (
  vatDecision: any,
  requested: boolean,
  customer: { customerType?: string; vatNumber?: string | null; isVatVerified?: boolean } | null | undefined
) => {
  if (!requested || !vatDecision || vatDecision.action !== "rfq" || vatDecision.reverseCharge) {
    return vatDecision;
  }
  const standardRate = Number.isFinite(vatDecision.standardRate)
    ? vatDecision.standardRate
    : vatDecision.appliedRate ?? 21;
  return applyB2BInvoiceRule({
    ...vatDecision,
    action: "standard_rate",
    appliedRate: standardRate,
    reverseCharge: false,
    explanation: `Customer chose to proceed at the standard VAT rate (${standardRate}%).`,
    matchedRuleText: undefined,
  }, customer?.customerType, customer?.vatNumber, customer?.isVatVerified, {
    propertyNature: vatDecision.propertyNature,
    exemptFromBelgianReverseCharge: vatDecision.exemptFromBelgianReverseCharge,
  });
};

const professionalAnswersFromProject = (project: { vatProfessionalAnswers?: Array<{ fieldName?: string; value?: unknown }> } | null | undefined) =>
  (project?.vatProfessionalAnswers || []).reduce((acc: Record<string, unknown>, answer) => {
    if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
    return acc;
  }, {});

const presignMaybeS3Url = async (url?: string | null) => {
  if (!url) return url;
  const signed = await presignS3Url(url);
  return signed ?? url;
};

const normalizeRfqAnswers = (answers: any[] | undefined) => {
  if (!Array.isArray(answers)) {
    return [];
  }

  return answers.filter((answer) => {
    if (answer == null) return false;
    const q = answer.question || "";
    const a = typeof answer.answer === "string" ? answer.answer.trim() : String(answer.answer ?? "").trim();
    return q && a;
  }).map((answer) => {
    const normalizedAnswer: Record<string, any> = {
      questionId: answer?.questionId,
      question: answer?.question || "",
      answer: typeof answer?.answer === "string" ? answer.answer : String(answer?.answer ?? ""),
    };

    if (answer?.fieldName) {
      normalizedAnswer.fieldName = String(answer.fieldName);
    }

    const rawFieldType = typeof answer?.fieldType === "string" ? answer.fieldType : undefined;
    const rawType = typeof answer?.type === "string" ? answer.type : undefined;
    const resolvedType = rawFieldType || rawType;

    if (resolvedType === "attachment" || resolvedType === "file") {
      normalizedAnswer.fieldType = "file";
    } else if (resolvedType === "text") {
      normalizedAnswer.fieldType = "text";
    } else if (resolvedType === "number") {
      normalizedAnswer.fieldType = "number";
    } else if (resolvedType === "date") {
      normalizedAnswer.fieldType = "date";
    } else if (resolvedType === "dropdown" || resolvedType === "checkbox") {
      normalizedAnswer.fieldType = resolvedType;
    }

    return normalizedAnswer;
  });
};

const resolveNormalizedVatAnswers = async (
  vatAnswers: unknown,
  rfqAnswers: unknown,
  serviceConfigurationId?: string
): Promise<Record<string, unknown>> => {
  if (Array.isArray(vatAnswers)) {
    return vatAnswers.reduce((acc: Record<string, unknown>, answer: any) => {
      if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
      return acc;
    }, {});
  }

  const normalizedRfqAnswers = normalizeRfqAnswers(rfqAnswers as any[] | undefined);
  let vatQuestions: Array<{ fieldName: string; question: string }> = [];
  if (serviceConfigurationId && mongoose.Types.ObjectId.isValid(serviceConfigurationId)) {
    const config = await ServiceConfiguration.findById(serviceConfigurationId)
      .select("vatManagement.reducedVatQuestions");
    vatQuestions = config?.vatManagement?.reducedVatQuestions || [];
  }

  const questionToFieldName = new Map(
    vatQuestions.map((question) => [question.question.trim().toLowerCase(), question.fieldName])
  );

  return normalizedRfqAnswers.reduce((acc: Record<string, unknown>, answer: any) => {
    const fieldName = answer.fieldName
      || questionToFieldName.get(String(answer.question || "").trim().toLowerCase());
    if (fieldName) acc[String(fieldName)] = answer.answer;
    return acc;
  }, {});
};

const validateServiceCountryCoverage = async (params: {
  country?: string | null;
  serviceConfigurationId?: string | null;
  projectCountry?: string | null;
}): Promise<string | null> => {
  const country = parseVatCountryCode(params.country);
  if (!country) return "A valid service country is required for VAT determination";

  const projectCountry = parseVatCountryCode(params.projectCountry);
  if (projectCountry && projectCountry !== country) {
    return "The service country does not match the project's configured service area";
  }

  if (params.serviceConfigurationId && mongoose.Types.ObjectId.isValid(params.serviceConfigurationId)) {
    const configuration = await ServiceConfiguration.findById(params.serviceConfigurationId)
      .select("activeCountries")
      .lean();
    const activeCountries = (configuration?.activeCountries || [])
      .map((candidate: string) => parseVatCountryCode(candidate))
      .filter(Boolean);
    if (activeCountries.length > 0 && !activeCountries.includes(country)) {
      return "The service is not available in the selected service country";
    }
  }

  return null;
};

const roundMoney = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const normalizeSelectedExtraOptionIndexes = (project: any, selectedExtraOptions: unknown): number[] => {
  if (!Array.isArray(selectedExtraOptions)) return [];
  return Array.from(
    new Set(
      selectedExtraOptions
        .map((value: unknown) =>
          typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseInt(value, 10)
              : Number.NaN
        )
        .filter(
          (index: number) =>
            Number.isInteger(index) &&
            index >= 0 &&
            Array.isArray(project.extraOptions) &&
            index < project.extraOptions.length
        )
    )
  );
};

export const buildCheckoutSnapshot = (params: {
  project: any;
  selectedSubproject: any;
  selectedExtraOptions: unknown;
  estimatedUsage: unknown;
}) => {
  const pricingType = params.selectedSubproject?.pricing?.type;
  const unitAmount = Number(params.selectedSubproject?.pricing?.amount);
  if ((pricingType !== "fixed" && pricingType !== "unit") || !Number.isFinite(unitAmount) || unitAmount < 0) {
    return null;
  }

  const usageQuantityRaw =
    typeof params.estimatedUsage === "number"
      ? params.estimatedUsage
      : typeof params.estimatedUsage === "string"
        ? Number(params.estimatedUsage)
        : Number.NaN;
  const quantity = pricingType === "unit" ? usageQuantityRaw : 1;

  if (pricingType === "unit" && (!Number.isFinite(quantity) || quantity <= 0)) {
    return null;
  }
  if (pricingType === "unit" && quantity < (Number(params.selectedSubproject?.pricing?.minOrderQuantity) > 0 ? Number(params.selectedSubproject.pricing.minOrderQuantity) : 1)) return null;

  const selectedOptionIndexes = normalizeSelectedExtraOptionIndexes(params.project, params.selectedExtraOptions);
  const selectedOptions = selectedOptionIndexes.flatMap((optionIndex) => {
    const option = params.project.extraOptions?.[optionIndex];
    if (!option || typeof option.price !== "number") return [];
    return [{
      extraOptionId: option._id?.toString?.() || String(optionIndex),
      name: option.name || `Option ${optionIndex}`,
      unitPrice: option.price,
      quantity: 1,
      totalPrice: option.price,
    }];
  });

  const baseSubtotal = roundMoney(unitAmount * quantity);
  const extraOptionsTotal = roundMoney(selectedOptions.reduce((sum, option) => sum + option.totalPrice, 0));
  const totalAmount = roundMoney(baseSubtotal + extraOptionsTotal);

  if (!(totalAmount > 0)) return null;

  let unit: string | undefined;
  try {
    const validated = assertValidInvoiceUnit(params.selectedSubproject?.pricing?.unit, "booking unit");
    unit = validated ? validated.slice(0, 50) : undefined;
  } catch (error: any) {
    // The unit comes from user-editable project pricing, so this is a
    // correctable validation failure, not an unexpected server error.
    throw new UserFacingError(
      400,
      error?.message || 'Unknown booking unit. Use a validated UNECE unit.',
      'VALIDATION',
      'unit',
    );
  }

  return {
    pricingType,
    unitAmount,
    quantity,
    ...(unit ? { unit } : {}),
    baseSubtotal,
    extraOptionsTotal,
    totalAmount,
    currency: "EUR",
    selectedOptions,
  };
};

const snapshotToQuoteBreakdown = (snapshot: NonNullable<ReturnType<typeof buildCheckoutSnapshot>>, subprojectIndex?: number) => [
  ...(typeof subprojectIndex === "number"
    ? [{
        item: `checkout_snapshot:selected_package_index:${subprojectIndex}`,
        quantity: 1,
        unitPrice: 0,
        totalPrice: 0,
      }]
    : []),
  {
    item: `checkout_snapshot:selected_package_type:${snapshot.pricingType}`,
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
  },
  {
    item: "Package Base",
    quantity: snapshot.quantity,
    unitPrice: snapshot.unitAmount,
    totalPrice: snapshot.baseSubtotal,
  },
  ...snapshot.selectedOptions.map((option) => ({
    item: `Extra Option: ${option.name}`,
    quantity: option.quantity,
    unitPrice: option.unitPrice,
    totalPrice: option.totalPrice,
  })),
  {
    item: "checkout_snapshot:selected_options_total",
    quantity: snapshot.selectedOptions.length,
    unitPrice: snapshot.selectedOptions.length > 0 ? snapshot.extraOptionsTotal : 0,
    totalPrice: snapshot.extraOptionsTotal,
  },
  {
    item: "checkout_snapshot:computed_total",
    quantity: 1,
    unitPrice: snapshot.totalAmount,
    totalPrice: snapshot.totalAmount,
  },
];

const presignBookingFiles = async (bookingDoc: any) => {
  const booking = bookingDoc?.toObject ? bookingDoc.toObject() : { ...bookingDoc };
  const customerId = referenceId(booking?.customer);
  const professionalId = referenceId(booking?.professional);
  const projectId = referenceId(booking?.project)
    || (booking?.bookingSnapshot?.project?.id ? String(booking.bookingSnapshot.project.id) : null);
  const project = booking?.project && typeof booking.project === 'object' ? booking.project : null;
  const snapshotRfqQuestions = Array.isArray(booking?.bookingSnapshot?.questions?.rfq)
    ? booking.bookingSnapshot.questions.rfq
    : [];
  const snapshotPostBookingQuestions = Array.isArray(booking?.bookingSnapshot?.questions?.postBooking)
    ? booking.bookingSnapshot.questions.postBooking
    : [];
  const rfqDefinitions = snapshotRfqQuestions.length > 0
    ? snapshotRfqQuestions
    : Array.isArray(project?.rfqQuestions) ? project.rfqQuestions : [];
  const postBookingDefinitions = snapshotPostBookingQuestions.length > 0
    ? snapshotPostBookingQuestions
    : Array.isArray(project?.postBookingQuestions) ? project.postBookingQuestions : [];
  const isDeclaredFile = (answer: any, definition?: any) =>
    answer?.fieldType === 'file'
    || answer?.type === 'file'
    || answer?.type === 'attachment'
    || definition?.type === 'file'
    || definition?.type === 'attachment';
  const findDefinition = (definitions: any[], answer: any) =>
    definitions.find((definition: any) =>
      (definition.questionId && answer?.questionId
        && String(definition.questionId) === String(answer.questionId))
      || (definition._id && answer?.questionId && String(definition._id) === String(answer.questionId))
      || (definition.question && String(definition.question) === String(answer?.question)),
    );

  if (Array.isArray(booking?.rfqData?.attachments) && booking.rfqData.attachments.length > 0) {
    const signed = await Promise.all(
      booking.rfqData.attachments.map(async (url: string) => {
        const result = await presignOwnedUrl(url, [customerId, professionalId], ['rfq-attachments']);
        return result.url;
      })
    );
    // Never echo an unowned or unsignable private key. The details DTO reports
    // the unavailable reason separately.
    booking.rfqData.attachments = signed.filter((url: string | null): url is string => Boolean(url));
  }

  if (Array.isArray(booking?.rfqData?.answers) && booking.rfqData.answers.length > 0) {
    booking.rfqData.answers = await Promise.all(
      booking.rfqData.answers.map(async (answer: any) => {
        const val = typeof answer?.answer === 'string' ? answer.answer : '';
        const definition = findDefinition(rfqDefinitions, answer);
        if (isDeclaredFile(answer, definition)) {
          const result = await presignQuestionAnswerUrl(
            val,
            [customerId, professionalId],
            projectId,
            ['rfq-attachments', 'dispute-attachments'],
          );
          return { ...answer, answer: result.url || '' };
        }
        return answer;
      })
    );
  }

  if (Array.isArray(booking?.postBookingData) && booking.postBookingData.length > 0) {
    booking.postBookingData = await Promise.all(
      booking.postBookingData.map(async (answer: any) => {
        const definition = findDefinition(postBookingDefinitions, answer);
        if (!isDeclaredFile(answer, definition)) return answer;
        const result = await presignQuestionAnswerUrl(
          answer?.answer,
          [customerId, professionalId],
          projectId,
          ['rfq-attachments', 'dispute-attachments'],
        );
        return { ...answer, answer: result.url || '' };
      })
    );
  }

  if (Array.isArray(booking?.customerReview?.images) && booking.customerReview.images.length > 0) {
    booking.customerReview.images = await Promise.all(
      booking.customerReview.images.map((url: string) => presignMaybeS3Url(url))
    );
  }

  if (Array.isArray(booking?.completionAttestation?.attachments) && booking.completionAttestation.attachments.length > 0) {
    const signed = await Promise.all(
      booking.completionAttestation.attachments.map(async (url: string) => {
        const result = await presignOwnedUrl(url, [professionalId, customerId], ['completion-attachments']);
        return result.url;
      })
    );
    booking.completionAttestation.attachments = signed.filter((url: string | null): url is string => Boolean(url));
  }

  // Dispute evidence is party-owned upload data too. Sign only the actual
  // owner's keys; never echo another uploader's raw key in the legacy booking.
  if (booking?.dispute && typeof booking.dispute === 'object') {
    for (const field of ['attachments', 'resolutionAttachments'] as const) {
      if (!Array.isArray(booking.dispute[field]) || booking.dispute[field].length === 0) continue;
      const signed = await Promise.all(
        booking.dispute[field].map(async (url: string) => {
          const result = await presignOwnedUrl(url, [customerId, professionalId], ['dispute-attachments']);
          return result.url;
        }),
      );
      booking.dispute[field] = signed.filter((url: string | null): url is string => Boolean(url));
    }
  }

  if (booking?.payment) {
    booking.payment = {
      ...booking.payment,
      invoiceUrl: await presignMaybeS3Url(booking.payment.invoiceUrl),
      invoiceUblUrl: await presignMaybeS3Url(booking.payment.invoiceUblUrl),
      supplierInvoiceUrl: await presignMaybeS3Url(booking.payment.supplierInvoiceUrl),
      supplierInvoiceUblUrl: await presignMaybeS3Url(booking.payment.supplierInvoiceUblUrl),
      creditNoteUrl: await presignMaybeS3Url(booking.payment.creditNoteUrl),
      creditNoteUblUrl: await presignMaybeS3Url(booking.payment.creditNoteUblUrl),
      supplierCreditNoteUrl: await presignMaybeS3Url(booking.payment.supplierCreditNoteUrl),
      supplierCreditNoteUblUrl: await presignMaybeS3Url(booking.payment.supplierCreditNoteUblUrl),
      invoiceArtifactHistory: Array.isArray(booking.payment.invoiceArtifactHistory)
        ? await Promise.all(booking.payment.invoiceArtifactHistory.map(async (entry: any) => ({
            ...entry,
            invoiceUrl: await presignMaybeS3Url(entry.invoiceUrl),
            invoiceUblUrl: await presignMaybeS3Url(entry.invoiceUblUrl),
          })))
        : booking.payment.invoiceArtifactHistory,
    };
  }

  return booking;
};

/**
 * Invoice visibility: customers see only the customer invoice (FIX),
 * professionals see only the supplier self-bill (SUP). Admins see both.
 * Call after presignBookingFiles.
 */

// Create a new booking (RFQ submission)
export const createBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id; // From auth middleware
    const {
      bookingType, // 'professional' or 'project'
      professionalId,
      projectId,
      rfqData, // Service type, description, answers, budget, etc.
      preferredStartDate,
      preferredStartTime,
      selectedSubprojectIndex,
      urgency,
      customerBlocks,
      estimatedUsage,
      selectedExtraOptions,
      paymentAtCheckout,
      serviceConfigurationId,
      vatAnswers,
      proceedAtStandardVat,
      serviceCountry,
      serviceLocation,
    } = req.body;
    const paymentAtCheckoutRequested =
      paymentAtCheckout === true ||
      paymentAtCheckout === 1 ||
      paymentAtCheckout === "1" ||
      paymentAtCheckout === "true";
    const proceedAtStandardVatRequested =
      proceedAtStandardVat === true ||
      proceedAtStandardVat === 1 ||
      proceedAtStandardVat === "1" ||
      proceedAtStandardVat === "true";
    let projectDocForSnapshot: any = null;
    let professionalDocForSnapshot: any = null;

    // Validate required fields
    if (!bookingType || (bookingType !== 'professional' && bookingType !== 'project')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking type. Must be 'professional' or 'project'"
      });
    }

    if (bookingType === 'professional' && !professionalId) {
      return res.status(400).json({
        success: false,
        msg: "Professional ID is required for professional bookings"
      });
    }

    if (bookingType === 'project' && !projectId) {
      return res.status(400).json({
        success: false,
        msg: "Project ID is required for project bookings"
      });
    }

    if (bookingType === "professional" && paymentAtCheckoutRequested) {
      return res.status(400).json({
        success: false,
        msg: "paymentAtCheckout is not allowed for professional bookings",
      });
    }

    if (!rfqData || !rfqData.serviceType || !rfqData.description) {
      return res.status(400).json({
        success: false,
        msg: "RFQ data with service type and description is required"
      });
    }

    // Get customer details with location
    const customer = await User.findById(userId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        msg: "Customer not found"
      });
    }

    if (customer.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Only customers can create bookings"
      });
    }

    // RFQ attachments use the dedicated rfq-attachments upload. File answers may
    // also use the existing project question uploader
    // (projects/<projectId>/attachment/<userId>/...), but only for this exact
    // project and uploader. A caller cannot attach an arbitrary private S3
    // object or another project's key.
    const rawRfqAttachments = Array.isArray(rfqData?.attachments) ? rfqData.attachments : [];
    const invalidRfqAttachments = rawRfqAttachments.filter(
      (url: unknown) => !isUploadOwnedByUser(url, userId, ['rfq-attachments']),
    );
    if (invalidRfqAttachments.length > 0) {
      return res.status(400).json({
        success: false,
        msg: "One or more RFQ attachments are not valid uploads for this account",
      });
    }
    const invalidFileAnswers = (Array.isArray(rfqData?.answers) ? rfqData.answers : []).filter((answer: any) => {
      const fieldType = answer?.fieldType || answer?.type;
      const value = typeof answer?.answer === 'string' ? answer.answer : '';
      if (fieldType !== 'file' && fieldType !== 'attachment') return false;
      return Boolean(value) && !isQuestionAnswerUploadOwnedByUser(value, userId, projectId);
    });
    if (invalidFileAnswers.length > 0) {
      return res.status(400).json({
        success: false,
        msg: "One or more RFQ file answers are not valid uploads for this account",
      });
    }

    // Validate customer has location set
    if (!customer.location || !customer.location.coordinates || customer.location.coordinates.length !== 2) {
      return res.status(400).json({
        success: false,
        msg: "Customer location is required. Please update your profile with your address."
      });
    }

    let configIdForVat: string | undefined;
    if (bookingType === "project" && projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      const projectForVat = await Project.findById(projectId).select("serviceConfigurationId");
      configIdForVat = projectForVat?.serviceConfigurationId?.toString();
    } else if (
      bookingType === "professional" &&
      serviceConfigurationId &&
      mongoose.Types.ObjectId.isValid(serviceConfigurationId)
    ) {
      configIdForVat = String(serviceConfigurationId);
    }

    const normalizedVatAnswers = await resolveNormalizedVatAnswers(
      vatAnswers,
      rfqData?.answers,
      configIdForVat
    );

    const suppliedServiceCountries = [serviceCountry, serviceLocation?.country]
      .filter((value) => value != null && String(value).trim() !== '')
      .map((value) => parseVatCountryCode(String(value)));
    if (suppliedServiceCountries.some((country) => !country)) {
      return res.status(400).json({ success: false, msg: "A valid ISO service country is required" });
    }
    if (new Set(suppliedServiceCountries).size > 1) {
      return res.status(400).json({ success: false, msg: "The service country fields must agree" });
    }
    const requestedServiceCountry = suppliedServiceCountries[0];
    const serviceCoords = Array.isArray(serviceLocation?.coordinates)
      ? serviceLocation.coordinates.map(Number)
      : [];
    const hasServiceCoords =
      serviceCoords.length === 2 &&
      Number.isFinite(serviceCoords[0]) &&
      Number.isFinite(serviceCoords[1]) &&
      serviceCoords[0] >= -180 &&
      serviceCoords[0] <= 180 &&
      serviceCoords[1] >= -90 &&
      serviceCoords[1] <= 90;

    const applyBookingLocation = (fallbackCountry?: string, authoritativeCountry?: string) => {
      const country = firstVatCountry(
        authoritativeCountry,
        requestedServiceCountry,
        customer.location?.country,
        fallbackCountry
      );
      return {
        type: "Point" as const,
        coordinates: hasServiceCoords ? serviceCoords : (customer.location?.coordinates || [0, 0]),
        address: serviceLocation?.address || customer.location?.address,
        city: serviceLocation?.city || customer.location?.city,
        country,
        postalCode: serviceLocation?.postalCode || customer.location?.postalCode,
      };
    };

    const hasServiceAddressFields = Boolean(
      serviceLocation &&
      ['address', 'city', 'postalCode'].some((field) => {
        const value = (serviceLocation as any)[field];
        return value != null && String(value).trim() !== '';
      }),
    );
    if (hasServiceAddressFields && !hasServiceCoords) {
      return res.status(400).json({
        success: false,
        msg: "A service address must include valid coordinates; please select the address from the map suggestions",
      });
    }
    const customerCountry = parseVatCountryCode(customer.location?.country);
    if (requestedServiceCountry && !hasServiceCoords && requestedServiceCountry !== customerCountry) {
      return res.status(400).json({
        success: false,
        msg: "A service country different from the customer's address requires valid service-location coordinates",
      });
    }

    // Create booking payload (base fields)
    const bookingData: any = {
      customer: userId,
      bookingType,
      status: 'rfq',
      location: applyBookingLocation(),
      rfqData: {
        serviceType: rfqData.serviceType,
        description: rfqData.description,
        answers: normalizeRfqAnswers(rfqData.answers),
        preferredStartDate: preferredStartDate || rfqData.preferredStartDate,
        ...(preferredStartTime || rfqData.preferredStartTime
          ? { preferredStartTime: preferredStartTime || rfqData.preferredStartTime }
          : {}),
        urgency: urgency || rfqData.urgency || 'medium',
        budget: rfqData.budget,
        attachments: rfqData.attachments || []
      }
    };

    if (customerBlocks) {
      bookingData.customerBlocks = customerBlocks;
    }

    // Persist the resolved config so the invoice layer can re-evaluate the
    // configured VAT rules at billing time (professional bookings have no
    // project to read it from).
    if (configIdForVat) {
      bookingData.serviceConfigurationId = configIdForVat;
    }

    // Validate professional or project exists
    // Should-fix 4: the engine-resolved conversion zone for scheduleTimeZone
    // (assigned in the project branch when a window is computed).
    let engineScheduleZone: string | null = null;
    if (bookingType === 'professional') {
      const professional = await User.findById(professionalId);
      if (!professional || professional.role !== 'professional') {
        return res.status(404).json({
          success: false,
          msg: "Professional not found"
        });
      }

      if (professional.professionalStatus !== 'approved') {
        return res.status(400).json({
          success: false,
          msg: "Professional is not approved to accept bookings"
        });
      }

      bookingData.professional = professionalId;
      professionalDocForSnapshot = professional;

      const coverageError = await validateServiceCountryCoverage({
        country: bookingData.location.country,
        serviceConfigurationId,
      });
      if (coverageError) return res.status(400).json({ success: false, msg: coverageError });

      // Professional bookings have no project-level service configuration, but
      // country-based standard rates and B2B reverse-charge rules still apply.
      const vatDecision = await resolveVatDecisionFromConfig({
        serviceConfigurationId,
        country: bookingData.location.country,
        bookingCountry: bookingData.location.country,
        businessCountry: firstVatCountry(customer.companyAddress?.country, customer.location?.country),
        answers: normalizedVatAnswers,
        customerType: customer.customerType || "individual",
        vatNumber: customer.vatNumber,
        isVatVerified: customer.isVatVerified,
      });
      bookingData.vatDecision = {
        ...applyProceedAtStandardVatIfRequested(vatDecision, proceedAtStandardVatRequested, customer),
        answers: Object.entries(normalizedVatAnswers).map(([fieldName, value]) => ({ fieldName, value })),
      };
    } else {
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({
          success: false,
          msg: "Project not found"
        });
      }
      projectDocForSnapshot = project;

      if (project.status !== 'published') {
        return res.status(400).json({
          success: false,
          msg: "Project is not available for booking"
        });
      }

      if (!project.professionalId) {
        return res.status(400).json({
          success: false,
          msg: "Project has no assigned professional",
        });
      }

      const projectProfessional = await User.findById(project.professionalId).select(
        '_id role professionalStatus name username email businessInfo timeZone',
      );
      if (
        !projectProfessional ||
        projectProfessional.role !== 'professional' ||
        projectProfessional.professionalStatus !== 'approved'
      ) {
        return res.status(400).json({
          success: false,
          msg: "Project professional is invalid or no longer available",
        });
      }
      professionalDocForSnapshot = projectProfessional;

      bookingData.project = projectId;
      bookingData.professional = project.professionalId;

      const projectService = Array.isArray(project.services) && project.services.length > 0
        ? project.services[0]
        : null;
      const selectedServiceConfigId = project.serviceConfigurationId?.toString();
      if (
        serviceConfigurationId &&
        selectedServiceConfigId &&
        serviceConfigurationId !== selectedServiceConfigId
      ) {
        return res.status(400).json({
          success: false,
          msg: "serviceConfigurationId does not match the selected project",
        });
      }
      const projectCountry = firstVatCountry(project.distance?.countryCode);
      if (projectCountry && requestedServiceCountry && projectCountry !== requestedServiceCountry) {
        return res.status(400).json({
          success: false,
          msg: "The service country does not match the project's configured service area",
        });
      }
      bookingData.location = applyBookingLocation(projectCountry, projectCountry);
      const coverageError = await validateServiceCountryCoverage({
        country: bookingData.location.country,
        serviceConfigurationId: selectedServiceConfigId,
        projectCountry,
      });
      if (coverageError) return res.status(400).json({ success: false, msg: coverageError });
      const vatDecision = await resolveVatDecisionFromConfig({
        serviceConfigurationId: selectedServiceConfigId,
        category: projectService?.category || project.category,
        service: projectService?.service || project.service,
        areaOfWork: projectService?.areaOfWork || project.areaOfWork,
        country: bookingData.location.country,
        bookingCountry: bookingData.location.country,
        businessCountry: firstVatCountry(customer.companyAddress?.country, customer.location?.country),
        answers: normalizedVatAnswers,
        professionalAnswers: professionalAnswersFromProject(project),
        customerType: customer.customerType || "individual",
        vatNumber: customer.vatNumber,
        isVatVerified: customer.isVatVerified,
      });
      bookingData.vatDecision = {
        ...applyProceedAtStandardVatIfRequested(vatDecision, proceedAtStandardVatRequested, customer),
        answers: Object.entries(normalizedVatAnswers).map(([fieldName, value]) => ({ fieldName, value })),
      };

      let fallbackTeamMembers: mongoose.Types.ObjectId[] | null = null;
      let normalizedProjectResourceIds: string[] = [];
      // Validate and normalize resource IDs, filtering out invalid entries and duplicates
      if (project.resources && Array.isArray(project.resources) && project.resources.length > 0) {
        const seenIds = new Set<string>();
        const validTeamMembers: mongoose.Types.ObjectId[] = [];

        for (const id of project.resources) {
          // Skip null/undefined values
          if (id == null) continue;

          // Convert to string for validation and deduplication
          const idStr = typeof id === 'string' ? id : String(id);

          // Validate the ID format
          if (!mongoose.isValidObjectId(idStr)) continue;

          // Skip duplicates
          if (seenIds.has(idStr)) continue;

          seenIds.add(idStr);
          normalizedProjectResourceIds.push(idStr);
          validTeamMembers.push(new mongoose.Types.ObjectId(idStr));
        }

        if (validTeamMembers.length > 0) {
          fallbackTeamMembers = validTeamMembers;
        }
      }

      if (
        !Array.isArray(project.resources) ||
        project.resources.length === 0 ||
        normalizedProjectResourceIds.length === 0
      ) {
        return res.status(400).json({
          success: false,
          msg: "Project has no valid team resources configured",
        });
      }

      const rawStartDate =
        preferredStartDate || rfqData?.preferredStartDate || undefined;
      const rawStartTime =
        preferredStartTime || rfqData?.preferredStartTime || undefined;
      const normalizedStartDate =
        typeof rawStartDate === "string"
          ? /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)
            ? rawStartDate
            : (() => {
                const parsed = new Date(rawStartDate);
                if (Number.isNaN(parsed.getTime())) return rawStartDate;
                return parsed.toISOString().slice(0, 10);
              })()
          : undefined;

      const subprojectIndex = resolveSubprojectIndex(
        project.subprojects,
        selectedSubprojectIndex
      );

      if (
        typeof subprojectIndex !== 'number' &&
        Array.isArray(project.subprojects) &&
        project.subprojects.length > 1
      ) {
        return res.status(400).json({
          success: false,
          msg: 'Please select a subproject/package before booking',
        });
      }

      const selectedSubprojectForCheckout =
        typeof subprojectIndex === "number" &&
        Array.isArray(project.subprojects) &&
        subprojectIndex >= 0 &&
        subprojectIndex < project.subprojects.length
          ? project.subprojects[subprojectIndex]
          : undefined;
      const checkoutSnapshot = selectedSubprojectForCheckout
        ? buildCheckoutSnapshot({
            project,
            selectedSubproject: selectedSubprojectForCheckout,
            selectedExtraOptions,
            estimatedUsage,
          })
        : null;
      const scheduleQuantity = resolveProjectScheduleQuantity(project, subprojectIndex, estimatedUsage);
      if (!scheduleQuantity.valid) return res.status(400).json({ success: false, msg: scheduleQuantity.error });
      if (selectedSubprojectForCheckout?.pricing?.type === 'unit' && !checkoutSnapshot) {
        return res.status(400).json({ success: false, msg: 'A valid quantity and price are required for unit bookings' });
      }

      const isRfqSubproject =
        typeof subprojectIndex === "number" &&
        Array.isArray(project.subprojects) &&
        subprojectIndex >= 0 &&
        subprojectIndex < project.subprojects.length &&
        (project.subprojects[subprojectIndex] as any)?.pricing?.type === "rfq";

      // Should-fix 4: remember the engine-resolved zone for scheduleTimeZone
      // (declared on the outer project branch so it survives below).
      if (!isRfqSubproject) {
        // Client bug list #23b: the wall-clock time is converted to a UTC
        // instant in the professional's effective zone. Pass the request zone
        // so the engine does not silently fall back to UTC when the
        // professional's business info has no usable zone.
        const requestTimeZone = resolveScheduleTimeZone(
          req.body?.timeZone || req.body?.scheduleTimeZone,
        ) || undefined;
        const validation = await validateProjectScheduleSelection({
          projectId,
          subprojectIndex,
          startDate: normalizedStartDate,
          startTime: typeof rawStartTime === "string" ? rawStartTime : undefined,
          customerBlocks,
          quantity: scheduleQuantity.quantity,
          requestTimeZone,
        });

        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            msg: validation.reason || "Selected schedule is not available",
          });
        }
      }

      if (normalizedStartDate && !isRfqSubproject) {
        const window = await buildProjectScheduleWindow({
          projectId,
          subprojectIndex,
          startDate: normalizedStartDate,
          startTime: typeof rawStartTime === "string" ? rawStartTime : undefined,
          customerBlocks,
          quantity: scheduleQuantity.quantity,
          requestTimeZone: resolveScheduleTimeZone(
            req.body?.timeZone || req.body?.scheduleTimeZone,
          ) || undefined,
        });

        if (!window) {
          return res.status(400).json({
            success: false,
            msg: "Unable to schedule the selected window",
          });
        }

        engineScheduleZone = typeof window.timeZone === 'string' ? window.timeZone : null;
        bookingData.scheduledStartDate = window.scheduledStartDate;
        if (window.scheduledExecutionEndDate) {
          bookingData.scheduledExecutionEndDate = window.scheduledExecutionEndDate;
        }
        if (window.scheduledBufferStartDate) {
          bookingData.scheduledBufferStartDate = window.scheduledBufferStartDate;
        }
        if (window.scheduledBufferEndDate) {
          bookingData.scheduledBufferEndDate = window.scheduledBufferEndDate;
        }
        if (window.scheduledBufferUnit) {
          bookingData.scheduledBufferUnit = window.scheduledBufferUnit;
        }
        if (window.scheduledStartTime) {
          bookingData.scheduledStartTime = window.scheduledStartTime;
        }
        if (window.scheduledEndTime) {
          bookingData.scheduledEndTime = window.scheduledEndTime;
        }
        if (window.assignedTeamMembers && window.assignedTeamMembers.length > 0) {
          bookingData.assignedTeamMembers = window.assignedTeamMembers;
        }
      }

      if (!bookingData.assignedTeamMembers && fallbackTeamMembers) {
        bookingData.assignedTeamMembers = fallbackTeamMembers;
      }

      if (
        !isRfqSubproject &&
        (!Array.isArray(bookingData.assignedTeamMembers) ||
        bookingData.assignedTeamMembers.length === 0)
      ) {
        return res.status(400).json({
          success: false,
          msg: "Unable to create booking because no team resources are available",
        });
      }

      if (typeof subprojectIndex === "number") {
        bookingData.selectedSubprojectIndex = subprojectIndex;
      }

      if (
        typeof subprojectIndex === "number" &&
        Array.isArray(project.subprojects) &&
        subprojectIndex >= 0 &&
        subprojectIndex < project.subprojects.length
      ) {
        const selectedSubproject = project.subprojects[subprojectIndex] as any;
        const warrantyValue = Number(selectedSubproject?.warrantyPeriod?.value || 0);
        const warrantyUnit = selectedSubproject?.warrantyPeriod?.unit;
        if (
          Number.isFinite(warrantyValue) &&
          warrantyValue >= 0 &&
          (warrantyUnit === "months" || warrantyUnit === "years")
        ) {
          bookingData.warrantyCoverage = {
            duration: {
              value: warrantyValue,
              unit: warrantyUnit,
            },
            source: "project_subproject",
          };
        }
      }

      if (selectedSubprojectForCheckout && checkoutSnapshot) {
        const durations = getProjectDurations(project, subprojectIndex, undefined, checkoutSnapshot.quantity);
        if (!durations && selectedSubprojectForCheckout.pricing?.type === 'unit') {
          return res.status(400).json({ success: false, msg: 'The selected unit package has no valid execution duration' });
        }
        if (durations) bookingData.scheduleSnapshot = {
          quantity: checkoutSnapshot.quantity,
          executionDuration: durations.execution,
          preparationDuration: durations.preparation || { value: 0, unit: 'hours' },
          bufferDuration: durations.buffer || { value: 0, unit: 'hours' },
          version: 1,
        };
      }
      if (checkoutSnapshot) {
        bookingData.checkoutSnapshot = checkoutSnapshot;
        if (checkoutSnapshot.selectedOptions.length > 0) {
          bookingData.selectedExtraOptions = checkoutSnapshot.selectedOptions.map((option) => ({
            extraOptionId: option.extraOptionId,
            bookedPrice: option.totalPrice,
          }));
        }
      }

      const wantsPaymentAtCheckout =
        paymentAtCheckoutRequested && !requiresVatRfqReview(bookingData.vatDecision);
      if (wantsPaymentAtCheckout) {
        if (
          typeof subprojectIndex !== "number" ||
          !Array.isArray(project.subprojects) ||
          subprojectIndex < 0 ||
          subprojectIndex >= project.subprojects.length
        ) {
          return res.status(400).json({
            success: false,
            msg: "A valid package selection is required for checkout payment",
          });
        }

        const pricingType = selectedSubprojectForCheckout?.pricing?.type;
        if (pricingType === "rfq") {
          return res.status(400).json({
            success: false,
            msg: "RFQ packages cannot be paid at checkout",
          });
        }

        if (!checkoutSnapshot) {
          return res.status(400).json({
            success: false,
            msg: "Selected package does not have a valid checkout price",
          });
        }

        const discountsTotal = 0;
        const taxesTotal = 0;
        if (!(checkoutSnapshot.totalAmount > 0)) {
          return res.status(400).json({
            success: false,
            msg: "Checkout payment requires a positive total amount",
          });
        }

        bookingData.quote = {
          amount: checkoutSnapshot.baseSubtotal,
          currency: checkoutSnapshot.currency,
          description: `Auto-generated checkout quote for ${project.title}`,
          breakdown: [
            ...snapshotToQuoteBreakdown(checkoutSnapshot, subprojectIndex),
            {
              item: "checkout_snapshot:discounts_total",
              quantity: 1,
              unitPrice: discountsTotal,
              totalPrice: discountsTotal,
            },
            {
              item: "checkout_snapshot:taxes_total",
              quantity: 1,
              unitPrice: taxesTotal,
              totalPrice: taxesTotal,
            },
          ],
          submittedAt: new Date(),
        };
        bookingData.status = "quote_accepted";
      }
    }

    if (!parseVatCountryCode(bookingData.location?.country)) {
      return res.status(400).json({
        success: false,
        msg: "A valid service country is required for VAT determination",
      });
    }

    // Freeze the booked package/terms/questions before the first save. This is
    // an absolute whitelist copy; later project edits never touch it.
    const vatQuestionsForSnapshot = await loadVatQuestionDefinitions(configIdForVat);
    // Should-fix 4: persist the engine-resolved conversion zone (the window
    // already falls back to the request zone) so details/timeline carry the
    // resolved zone even when the client sends no timeZone.
    const scheduleTimeZone = engineScheduleZone || resolveScheduleTimeZone(
      req.body?.timeZone || req.body?.scheduleTimeZone,
    );
    if (scheduleTimeZone) {
      bookingData.scheduleTimeZone = scheduleTimeZone;
    }
    if (!Array.isArray(bookingData.statusHistory) || bookingData.statusHistory.length === 0) {
      // Preserve the actor on the first append-only lifecycle fact; the model's
      // legacy default has no updatedBy and must not be used for new bookings.
      bookingData.statusHistory = [{
        status: bookingData.status,
        timestamp: new Date(),
        updatedBy: new mongoose.Types.ObjectId(userId),
        note: 'Booking created',
      }];
    }
    captureBookingSnapshotIfMissing({
      booking: bookingData,
      project: projectDocForSnapshot,
      customer,
      professional: professionalDocForSnapshot,
      source: 'booking_creation',
      vatQuestions: vatQuestionsForSnapshot,
      scheduleTimeZone,
    });

    let booking: IBooking | null = null;
    bookingData._id = new mongoose.Types.ObjectId();
    const calendarBooking = {
      _id: bookingData._id,
      professional: bookingData.professional as any,
      assignedTeamMembers: bookingData.assignedTeamMembers as any,
      resourcePlan: (bookingData as any).resourcePlan,
      scheduledStartDate: bookingData.scheduledStartDate as any,
      scheduledExecutionEndDate: bookingData.scheduledExecutionEndDate as any,
      scheduledBufferEndDate: bookingData.scheduledBufferEndDate as any,
    };
    const needsCalendarLock = buildBookingCalendarKeys(calendarBooking).length > 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        booking = await withAnonymizationWriteFence(
          [userId, bookingData.professional],
          async (session) => {
            if (needsCalendarLock) {
              // Reserve the same shared calendar keys as support/Meeting writers
              // in the same transaction as the booking row.
              await reserveBookingCalendar(calendarBooking, session);
            }
            const [created] = await Booking.create(
              [bookingData],
              session ? { session } : undefined,
            );
            return created;
          },
        );
        break;
      } catch (err: any) {
        if (err?.code === 11000 && (err.keyPattern?.bookingNumber || err.keyPattern?.quotationNumber) && attempt < 2) {
          continue;
        }
        throw err;
      }
    }
    // Invariant: the loop above always throws on failure, so booking is set here.
    if (!booking) throw new Error('Booking creation failed unexpectedly');

    // populate<T>() returns MergeType<this, T> — TypeScript merges the specified
    // field types into the document shape, giving us full type-safety with no casts.
    const populated = await booking.populate<{
      customer: Pick<IUser, '_id' | 'name' | 'email' | 'phone'>;
      professional: Pick<IUser, '_id' | 'name' | 'email'>;
    }>([
      { path: 'customer', select: 'name email phone isAnonymized deletedAt' },
      { path: 'professional', select: 'name email businessInfo isAnonymized deletedAt' },
      { path: 'project', select: 'title description subprojects.pricing' }
    ]);

    // Notify the professional for RFQ requests only — checkout bookings notify after payment.
    const notifyProfessionalId = populated.professional?._id?.toString();
    if (notifyProfessionalId && populated.status === "rfq") {
      await notify({
        userId: notifyProfessionalId,
        actorId: String(userId),
        eventKey: 'professional.rfq_received',
        entityType: 'booking',
        entityId: populated._id.toString(),
        context: {
          bookingId: populated._id.toString(),
          customerName: populated.customer?.name,
          projectTitle: (populated as any).project?.title,
        },
      });
    }

    return res.status(201).json({
      success: true,
      msg:
        populated.status === "quote_accepted"
          ? "Booking created. Proceed to payment."
          : populated.status === "rfq"
            ? "Quotation request created successfully"
            : "Booking request created successfully",
      booking: bookingForRequest(populated, req.user)
    });

  } catch (error: any) {
    console.error('Create booking error:', error);
    return sendHandlerError(res, error, "We couldn't create your booking. Please try again.");
  }
};

// Upload RFQ attachment (max 10MB, images/PDFs/docs)
export const uploadRFQAttachment = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, msg: 'Authentication required' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, msg: 'No file uploaded' });
    }

    if (file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, msg: 'File must be less than 10MB' });
    }

    const fileName = generateFileName(file.originalname, userId.toString(), 'rfq-attachments');
    const result = await uploadToS3(file, fileName);

    return res.json({
      success: true,
      data: {
        url: result.url,
        key: result.key,
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
      },
    });
  } catch (error) {
    console.error('RFQ attachment upload error:', error);
    return sendHandlerError(res, error, 'Failed to upload attachment');
  }
};

// Get bookings for current user (customer or professional)
export const getMyBookings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { status, page, limit, service, search, q, addressFilter, customerNameFilter } = req.query;
    const parsedPage = Math.max(1, Math.floor(Number(page) || 1));
    const parsedLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    const baseQuery: any = {};
    let professionalProjectIds: any[] | null = null;

    // Build query based on user role
    if (user.role === 'customer') {
      baseQuery.customer = userId;
    } else if (user.role === 'professional') {
      const projectIds = await Project.find({
        professionalId: userId,
      }).select("_id");
      professionalProjectIds = projectIds.map((project) => project._id);
      baseQuery.$or = [
        { professional: userId },
        { project: { $in: professionalProjectIds } },
      ];
    } else {
      return res.status(403).json({
        success: false,
        msg: "Only customers and professionals can view bookings"
      });
    }

    // Track per-facet clauses separately so counts can be disjunctive on
    // their own facet while respecting every other active filter.
    let statusClause: Record<string, unknown> | null = null;
    let serviceClause: Record<string, unknown> | null = null;
    const otherAnd: Record<string, unknown>[] = [];

    // Canonical booking-mode status sets. `awaiting_payment` is an alias for
    // the quote_accepted + payment_pending pair used by both dashboards.
    const expandStatusAlias = (raw: string): string[] =>
      raw.split(',').map(s => s.trim()).filter(Boolean).flatMap((s) =>
        s === 'awaiting_payment' ? ['quote_accepted', 'payment_pending'] : [s],
      );

    // Filter by status if provided (supports comma-separated for multiple statuses)
    if (status && typeof status === 'string') {
      const statuses = expandStatusAlias(status);
      if (statuses.length === 1) {
        statusClause = { status: statuses[0] };
      } else if (statuses.length > 1) {
        statusClause = { status: { $in: statuses } };
      }
    }

    if (service && typeof service === 'string') {
      const matchingProjectIds = await Project.find({ service }).select("_id");
      const serviceOr: any[] = [{ 'rfqData.serviceType': service }];
      if (matchingProjectIds.length > 0) {
        serviceOr.push({ project: { $in: matchingProjectIds.map(p => p._id) } });
      }
      serviceClause = { $or: serviceOr };
    }

    // `q` is a preserved alias of `search`.
    const searchRaw = typeof search === 'string' && search ? search
      : typeof q === 'string' && q ? q : '';
    if (searchRaw) {
      const escaped = searchRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const matchingCustomerIds = await User.find({ name: regex }).select("_id");
      const searchOr: any[] = [
        { 'rfqData.serviceType': regex },
        { 'rfqData.description': regex },
        { bookingNumber: regex },
      ];
      if (matchingCustomerIds.length > 0) {
        searchOr.push({ customer: { $in: matchingCustomerIds.map(c => c._id) } });
      }
      otherAnd.push({ $or: searchOr });
    }

    if (addressFilter && typeof addressFilter === 'string' && user.role === 'customer') {
      const trimmedAddress = addressFilter.trim();
      if (trimmedAddress.length >= 2) {
        const escaped = trimmedAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        otherAnd.push({
          $or: [
            { 'location.address': regex },
            { 'location.city': regex },
            { 'location.country': regex },
          ],
        });
      }
    }

    if (customerNameFilter && typeof customerNameFilter === 'string' && user.role === 'professional') {
      const trimmed = customerNameFilter.trim();
      if (trimmed.length >= 2) {
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        const matchingCustomerIds = await User.find({ role: 'customer', name: regex }).select('_id');
        if (matchingCustomerIds.length > 0) {
          otherAnd.push({
            customer: { $in: matchingCustomerIds.map(c => c._id) },
          });
        } else {
          otherAnd.push({ customer: { $in: [] } });
        }
      }
    }

    const withClauses = (extra: Record<string, unknown>[]): Record<string, unknown> => {
      const composed = { ...baseQuery };
      const and = [...otherAnd, ...extra];
      if (and.length > 0) composed.$and = and;
      return composed;
    };
    // Full filter set drives the page. Counts are computed BEFORE paging on
    // the same filtered set: total respects every filter; each facet count
    // is disjunctive on its own facet but respects all other filters
    // (role, search, location, counterpart, and the sibling facet).
    const query = withClauses([
      ...(statusClause ? [statusClause] : []),
      ...(serviceClause ? [serviceClause] : []),
    ]);
    const statusCountMatch = withClauses([...(serviceClause ? [serviceClause] : [])]);
    const serviceCountMatch = withClauses([...(statusClause ? [statusClause] : [])]);

    const skip = (parsedPage - 1) * parsedLimit;

    // Compute roleProjectIds for the unfiltered service-dropdown query.
    const roleProjectIds: any[] = user.role === 'customer'
      ? (await Booking.distinct('project', { customer: userId })).filter(Boolean)
      : (professionalProjectIds ?? []);

    const distinctServicesPromise = roleProjectIds.length > 0
      ? Project.distinct('service', { _id: { $in: roleProjectIds } })
      : Promise.resolve([] as string[]);

    const [bookings, total, distinctServices, statusCountRows, serviceCountRows] = await Promise.all([
      Booking.find(query)
        .populate('customer', 'name email phone customerType isAnonymized deletedAt')
        .populate('professional', 'name email username businessInfo professionalLevel adminTags isAnonymized deletedAt')
        .populate('project', 'title description priceModel pricing category service timeMode subprojects executionDuration professionalId')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(parsedLimit),
      Booking.countDocuments(query),
      distinctServicesPromise,
      Booking.aggregate([
        { $match: statusCountMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: serviceCountMatch },
        {
          $lookup: {
            from: 'projects',
            localField: 'project',
            foreignField: '_id',
            as: '_countProject',
          },
        },
        { $unwind: { path: '$_countProject', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { $ifNull: ['$rfqData.serviceType', '$_countProject.service'] },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const viewerRole = user.role === 'professional' ? 'professional' : 'customer';
    const projectOwnerIds = [...new Set(bookings
      .filter((booking) => booking.bookingType === 'project' && !booking.professional)
      .map((booking) => referenceId((booking.project as any)?.professionalId))
      .filter((value): value is string => Boolean(value)))];
    const projectOwnerRows = projectOwnerIds.length > 0
      ? await User.find({ _id: { $in: projectOwnerIds } })
          .select('_id isAnonymized deletedAt')
          .lean()
      : [];
    const anonymizedProjectOwners = new Set(
      projectOwnerRows
        .filter((owner: any) => owner.isAnonymized || owner.deletedAt)
        .map((owner: any) => String(owner._id)),
    );
    const visibleBookings = bookings.map((booking) => {
      const visible: any = bookingForViewer(booking, viewerRole);
      if (visible && typeof visible === "object") visible.priceModel = selectedPriceModel(visible);
      // The shared bookings table exposes pro-only payout date/amount
      // columns. Strip the pro payout summary server-side for customers;
      // UI hiding alone is not a fix. Customer-own totals and refund
      // records stay intact.
      if (viewerRole === 'customer' && visible && typeof visible === 'object' && visible.payment) {
        visible.payment = stripProPayoutSummaryForCustomer(visible.payment);
      }
      const projectOwnerId = referenceId((booking.project as any)?.professionalId);
      if (projectOwnerId && anonymizedProjectOwners.has(projectOwnerId)) {
        return maskBookingForAnonymizedParties(visible, {
          professional: true,
          professionalId: projectOwnerId,
        });
      }
      return visible;
    });

    const statusCounts: Record<string, number> = {};
    for (const row of statusCountRows || []) {
      if (row && typeof row._id === 'string' && row._id) statusCounts[row._id] = Number(row.count) || 0;
    }
    const serviceCounts: Record<string, number> = {};
    for (const row of serviceCountRows || []) {
      if (row && typeof row._id === 'string' && row._id) serviceCounts[row._id] = Number(row.count) || 0;
    }

    return res.status(200).json({
      success: true,
      bookings: visibleBookings,
      distinctServices: distinctServices.filter(Boolean).sort(),
      statusCounts,
      serviceCounts,
      pagination: {
        total,
        page: parsedPage,
        limit: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit)
      }
    });

  } catch (error: any) {
    console.error('Get bookings error:', error);
    next(error);
  }
};

// Get single booking by ID
export const getBookingById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId ? userId.toString() : '';
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId as string)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID"
      });
    }

    const isAdmin = isAdminUser(req.user);
    let adminAccess: BookingAdminAccess | undefined;
    if (isAdmin) {
      adminAccess = await resolveBookingAdminAccess(req.user);
      if (!adminAccess.bookings) {
        return res.status(403).json({
          success: false,
          msg: "You do not have permission to view this booking",
          code: "ADMIN_PERMISSION_DENIED",
        });
      }
    }
    const isViewerCustomer = !isAdmin && req.user?.role === 'customer';

    const professionalFields = isAdmin
      ? 'name email phone username businessInfo hourlyRate stripe role createdAt vatNumber timeZone isAnonymized deletedAt'
      : isViewerCustomer
        ? '_id name username businessInfo.companyName businessInfo.description businessInfo.website businessInfo.city businessInfo.country businessInfo.timezone businessInfo.postalCode timeZone isAnonymized deletedAt'
        : 'name email username businessInfo timeZone isAnonymized deletedAt';

    const bookingQuery = Booking.findById(bookingId)
      .populate('customer', isAdmin
        ? 'name username email phone customerType location vatNumber totalSpent businessName timeZone isAnonymized deletedAt'
        : 'name username email phone customerType location businessName timeZone isAnonymized deletedAt')
      .populate('professional', professionalFields)
      .populate(
        'project',
        `title description pricing category service team timeMode rfqQuestions postBookingQuestions professionalId extraOptions termsConditions subprojects minResources minOverlapPercentage executionDuration${isAdmin ? ' resources' : ''}`
      )
      .populate('assignedTeamMembers', 'name email');

    const booking = await bookingQuery;

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization - customer, professional, project owner, or admin can view
    const isCustomer = booking.customer._id.toString() === userIdString;
    const isProfessional = booking.professional?._id.toString() === userIdString;
    // For project bookings, also check if user owns the project
    const isProjectOwner = booking.bookingType === 'project' && booking.project
      && (booking.project as any).professionalId?.toString() === userIdString;

    if (!isAdmin && !isCustomer && !isProfessional && !isProjectOwner) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to view this booking"
      });
    }

    const viewerRole = isAdmin ? 'admin' : isCustomer ? 'customer' : 'professional';
    const projectProfessionalId = referenceId((booking as any).project?.professionalId);
    let projectProfessionalAnonymized = false;
    if (projectProfessionalId && !booking.professional) {
      const projectProfessional = await User.findById(projectProfessionalId)
        .select('isAnonymized deletedAt')
        .lean();
      projectProfessionalAnonymized = Boolean(
        projectProfessional?.isAnonymized || projectProfessional?.deletedAt,
      );
    }
    const maskingFlags = projectProfessionalAnonymized
      ? { professional: true, professionalId: projectProfessionalId || undefined }
      : {};
    const filteredBooking = isAdmin
      ? filterRawBookingForAdminArea(
          typeof (booking as any).toObject === 'function'
            ? (booking as any).toObject()
            : booking,
          adminAccess!,
        )
      : bookingForViewer(booking, viewerRole);
    const maskedBooking = maskBookingForAnonymizedParties(filteredBooking, maskingFlags);
    // Masking must remove target-owned file keys before any presigner sees
    // them. The old order signed first and could return a working URL.
    const visibleBooking = await presignBookingFiles(maskedBooking);
    const details = await attachBookingDetails(booking, viewerRole, req.user, adminAccess);

    return res.status(200).json({
      success: true,
      booking: visibleBooking,
      viewerRole,
      ...(details ? { details } : {}),
    });

  } catch (error: any) {
    console.error('Get booking error:', error);
    next(error);
  }
};

export const submitPostBookingAnswers = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId ? userId.toString() : '';
    const { bookingId } = req.params;
    const { answers } = req.body as {
      answers?: Array<{ questionId?: string; question?: string; answer?: string }>;
    };

    if (!mongoose.Types.ObjectId.isValid(bookingId as string)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID",
      });
    }

    if (!Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        msg: "Answers are required",
      });
    }

    const booking = await Booking.findById(bookingId).populate(
      "project",
      "postBookingQuestions"
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found",
      });
    }

    if (booking.customer.toString() !== userIdString) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to submit answers for this booking",
      });
    }

    if ((booking.postBookingData?.length || 0) > 0) {
      return res.status(400).json({
        success: false,
        msg: "Post-booking answers already submitted",
      });
    }

    const project = booking.project as any;
    const livePostBookingQuestions = project?.postBookingQuestions || [];
    const snapshotPostBookingQuestions = Array.isArray(booking.bookingSnapshot?.questions?.postBooking)
      ? booking.bookingSnapshot!.questions!.postBooking!
      : [];
    // If the snapshot recorded the questions, those are the questions the
    // customer was promised at booking time. Later project edits must not
    // change the wording/options of the post-booking form.
    const postBookingQuestions = snapshotPostBookingQuestions.length > 0
      ? snapshotPostBookingQuestions.map((question: any) => ({
          _id: question.questionId,
          question: question.question,
          type: question.type,
          options: question.options,
          isRequired: question.isRequired,
        }))
      : livePostBookingQuestions;
    if (postBookingQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "No post-booking questions available for this booking",
      });
    }

    const normalizedAnswers = answers.map((answer) => {
      const rawAnswer = answer.answer;
      const trimmedAnswer = (typeof rawAnswer === "string" ? rawAnswer : String(rawAnswer ?? "")).trim();
      const rawQuestionId = answer.questionId;
      const clientQuestionId = typeof rawQuestionId === "string" ? rawQuestionId : String(rawQuestionId ?? "");
      const rawQuestion = answer.question;
      const clientQuestion = typeof rawQuestion === "string" ? rawQuestion : String(rawQuestion ?? "");
      const matchedQuestion = postBookingQuestions.find((q: any) => {
        const qId = q._id?.toString() || q.id;
        if (qId && clientQuestionId === qId) return true;
        if (q?.question && clientQuestion === q.question) return true;
        return false;
      });
      const resolvedQuestionId = matchedQuestion?._id?.toString() || matchedQuestion?.id || clientQuestionId;
      return {
        matched: Boolean(matchedQuestion),
        questionId: resolvedQuestionId,
        question: matchedQuestion?.question || clientQuestion,
        answer: trimmedAnswer,
        ...(matchedQuestion?.type ? { fieldType: matchedQuestion.type === 'attachment' ? 'file' : matchedQuestion.type } : {}),
        ...(Array.isArray(matchedQuestion?.options) ? { options: matchedQuestion.options.map(String) } : {}),
      };
    });

    const projectIdForAnswers = referenceId(booking.project);
    const invalidFileAnswers = normalizedAnswers.filter((answer) => {
      if (answer.fieldType !== 'file' && answer.fieldType !== 'attachment') return false;
      return Boolean(answer.answer)
        && !isQuestionAnswerUploadOwnedByUser(answer.answer, userIdString, projectIdForAnswers);
    });
    if (invalidFileAnswers.length > 0) {
      return res.status(400).json({
        success: false,
        msg: "One or more file answers are not valid uploads for this account",
      });
    }

    // Answers are accepted only for the authoritative question set: the
    // captured booking snapshot when it recorded post-booking questions,
    // otherwise the definitions used at submission. A made-up question id or
    // wording cannot be injected into the stored answer set.
    const unresolvedAnswers = normalizedAnswers.filter(
      (a) => a.answer && (!a.matched || !a.questionId || !a.question)
    );
    if (unresolvedAnswers.length > 0) {
      return res.status(400).json({
        success: false,
        msg: `Could not resolve ${unresolvedAnswers.length} answer(s) to a valid question`,
      });
    }

    const hasMissingRequired = postBookingQuestions.some((question: any) => {
      if (!question?.isRequired) {
        return false;
      }

      const questionId = question._id?.toString() || question.id;
      const matched = normalizedAnswers.find((a) => {
        if (questionId && a.questionId === questionId) {
          return true;
        }
        if (question?.question && a.question === question.question) {
          return true;
        }
        return false;
      });

      return !matched || !matched.answer;
    });

    if (hasMissingRequired) {
      return res.status(400).json({
        success: false,
        msg: "Please answer all required questions",
      });
    }

    const submittedAt = new Date();
    booking.postBookingData = normalizedAnswers
      .filter((a) => a.matched && a.answer && a.questionId && a.question)
      .map(({ matched, ...answer }) => answer) as any;
    booking.postBookingSubmittedAt = submittedAt;
    booking.postBookingSubmittedBy = new mongoose.Types.ObjectId(userIdString);
    // When the original snapshot had no post-booking section, capture the
    // definitions the customer actually answered in a separate later-
    // provenance field. Never mutate `bookingSnapshot` with questions that
    // were created after booking.
    if (snapshotPostBookingQuestions.length === 0) {
      booking.postBookingQuestionSnapshot = {
        capturedAt: submittedAt,
        source: 'post_booking_submission',
        questions: snapshotQuestionDefinitions(postBookingQuestions),
      };
    }

    await withAnonymizationWriteFence([userId], async (session) => {
      await booking.save(session ? { session } : undefined);
    });

    return res.status(200).json({
      success: true,
      msg: "Post-booking answers submitted successfully",
      postBookingData: booking.postBookingData,
    });
  } catch (error: any) {
    console.error("Submit post-booking answers error:", error);
    next(error);
  }
};

// Submit quote (Professional only)
export const submitQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const {
      amount,
      currency,
      description,
      breakdown,
      validUntil,
      termsAndConditions,
      estimatedDuration
    } = req.body;

    // Validate
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        msg: "Valid quote amount is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check if user is the professional for this booking
    if (booking.professional?.toString() !== userId) {
      return res.status(403).json({
        success: false,
        msg: "Only the assigned professional can submit a quote"
      });
    }

    // Check booking status
    if (booking.status !== 'rfq') {
      return res.status(400).json({
        success: false,
        msg: "Quote can only be submitted for RFQ bookings"
      });
    }

    // Update booking with quote
    booking.quote = {
      amount,
      currency: currency || 'EUR',
      description,
      breakdown,
      validUntil: validUntil ? new Date(validUntil) : undefined,
      termsAndConditions,
      estimatedDuration,
      submittedAt: new Date(),
      submittedBy: new mongoose.Types.ObjectId(userId)
    };

    await (booking as any).updateStatus('quoted', userId, 'Quote submitted by professional');

    await booking.populate([
      { path: 'customer', select: 'name email phone isAnonymized deletedAt' },
      { path: 'professional', select: 'name email businessInfo isAnonymized deletedAt' }
    ]);

    return res.status(200).json({
      success: true,
      msg: "Quote submitted successfully",
      booking: bookingForRequest(booking, req.user)
    });

  } catch (error: any) {
    console.error('Submit quote error:', error);
    next(error);
  }
};

// Accept/Reject quote (Customer only)
export const respondToQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const { action } = req.body; // 'accept' or 'reject'

    if (!action || (action !== 'accept' && action !== 'reject')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid action. Must be 'accept' or 'reject'"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check if user is the customer
    if (booking.customer.toString() !== userId) {
      return res.status(403).json({
        success: false,
        msg: "Only the customer can respond to quotes"
      });
    }

    // Check booking status
    if (booking.status !== 'quoted') {
      return res.status(400).json({
        success: false,
        msg: "Can only respond to bookings with submitted quotes"
      });
    }

    const newStatus: BookingStatus = action === 'accept' ? 'quote_accepted' : 'quote_rejected';
    const note = action === 'accept' ? 'Quote accepted by customer' : 'Quote rejected by customer';

    await (booking as any).updateStatus(newStatus, userId, note);

    await booking.populate([
      { path: 'customer', select: 'name email phone isAnonymized deletedAt' },
      { path: 'professional', select: 'name email businessInfo isAnonymized deletedAt' }
    ]);

    return res.status(200).json({
      success: true,
      msg: `Quote ${action}ed successfully`,
      booking: bookingForRequest(booking, req.user)
    });

  } catch (error: any) {
    console.error('Respond to quote error:', error);
    next(error);
  }
};

// Update booking status
export const updateBookingStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const { status, note } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        msg: "Status is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization
    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to update this booking"
      });
    }

    await (booking as any).updateStatus(status, userId, note);

    await booking.populate([
      { path: 'customer', select: 'name email phone isAnonymized deletedAt' },
      { path: 'professional', select: 'name email businessInfo isAnonymized deletedAt' }
    ]);

    return res.status(200).json({
      success: true,
      msg: "Booking status updated successfully",
      booking: bookingForRequest(booking, req.user)
    });

  } catch (error: any) {
    console.error('Update booking status error:', error);
    next(error);
  }
};

// Cancel booking — creates a pending CancellationRequest. Admin must approve to actually cancel + refund.
export const cancelBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { bookingId } = req.params;
    const { reason, evidence, reasonCategory } = req.body;

    if (!userId) {
      return res.status(401).json({ success: false, msg: "Authentication required" });
    }

    const normalizedCategory =
      typeof reasonCategory === 'string' && (CANCELLATION_REASON_CATEGORIES as readonly string[]).includes(reasonCategory)
        ? (reasonCategory as CancellationReasonCategory)
        : undefined;

    const explanation = typeof reason === 'string' ? reason.trim() : '';
    if (explanation.length > 1000) {
      return res.status(400).json({
        success: false,
        msg: "Cancellation explanation must be 1000 characters or fewer"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to request cancellation for this booking"
      });
    }

    // Customers must select a reason from the predefined list; professionals may
    // still submit a free-text reason (their UI has no category dropdown).
    if (isCustomer && !normalizedCategory) {
      return res.status(400).json({
        success: false,
        msg: "Please select a cancellation reason"
      });
    }
    if (!normalizedCategory && !explanation) {
      return res.status(400).json({
        success: false,
        msg: "A cancellation reason is required"
      });
    }
    const trimmedReason = explanation || (normalizedCategory ? CANCELLATION_REASON_LABELS[normalizedCategory] : '');

    if (['completed', 'cancelled', 'refunded'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        msg: `Cannot request cancellation for booking with status '${booking.status}'`
      });
    }

    const existingPending = await CancellationRequest.findOne({
      booking: booking._id,
      status: { $in: ACTIVE_CANCELLATION_STATUSES },
    });
    if (existingPending) {
      return res.status(409).json({
        success: false,
        msg: "A cancellation request is already pending admin review for this booking"
      });
    }

    const requestedRole: 'customer' | 'professional' = isCustomer ? 'customer' : 'professional';
    const sanitizedEvidence = Array.isArray(evidence)
      ? evidence.filter((value: unknown): value is string => typeof value === 'string').slice(0, 10)
      : [];
    const invalidEvidence = sanitizedEvidence.filter(
      (url) => !isUploadOwnedByUser(url, userId, ['dispute-attachments', 'rfq-attachments']),
    );
    if (invalidEvidence.length > 0) {
      return res.status(400).json({
        success: false,
        msg: "One or more evidence files are not valid uploads for this account"
      });
    }
    const shouldMarkNoShow = isCustomer && normalizedCategory === 'no_show' && !booking.noShow?.markedAt;

    let cancellationRequest!: InstanceType<typeof CancellationRequest>;
    cancellationRequest = await withAnonymizationWriteFence([userId], async (session) => {
      const [created] = await CancellationRequest.create(
        [{
          booking: booking._id,
          requestedBy: new mongoose.Types.ObjectId(userId),
          requestedRole,
          ...(normalizedCategory ? { reasonCategory: normalizedCategory } : {}),
          reason: trimmedReason,
          evidence: sanitizedEvidence,
          status: 'pending',
          ...(isCustomer ? { responseDeadline: addBusinessDays(new Date(), REFUND_RESPONSE_BUSINESS_DAYS) } : {}),
        }],
        session ? { session } : undefined,
      );

      if (shouldMarkNoShow) {
        booking.noShow = {
          markedAt: new Date(),
          markedBy: new mongoose.Types.ObjectId(userId),
          reason: trimmedReason,
          source: 'customer_cancellation',
        };
        await booking.save(session ? { session } : undefined);
      }
      return created;
    });

    try {
      const [customerUser, professionalUser] = await Promise.all([
        booking.customer ? User.findById(booking.customer).select('email name').lean() : null,
        booking.professional ? User.findById(booking.professional).select('email name businessInfo username').lean() : null,
      ]);
      const requesterName = isCustomer
        ? customerUser?.name || 'Customer'
        : getProfessionalDisplayName(professionalUser);
      await runWithEmailActor(String(userId), () => sendCancellationRequestAdminEmail({
        bookingId: String(booking._id),
        requesterName,
        requesterRole: requestedRole,
        reason: trimmedReason,
      }));

      const otherPartyUserId = isCustomer ? professionalUser?._id : customerUser?._id;
      if (otherPartyUserId) {
        await notify({
          userId: otherPartyUserId.toString(),
          actorId: String(userId),
          eventKey: isCustomer
            ? 'professional.cancellation_request_received'
            : 'customer.cancellation_request_received',
          entityType: 'booking',
          entityId: String(booking._id),
          context: {
            bookingId: String(booking._id),
            requesterName,
            reason: trimmedReason,
          },
        });
      }

      // Inbox + push for both parties in the negotiation flow
      if (isCustomer && professionalUser?._id) {
        await notify({
          userId: professionalUser._id.toString(),
          actorId: String(userId),
          eventKey: 'professional.refund_request',
          entityType: 'booking',
          entityId: String(booking._id),
          context: { bookingId: String(booking._id) },
        });
        if (customerUser?._id) {
          await notify({
            userId: customerUser._id.toString(),
            actorId: String(userId),
            eventKey: 'customer.refund_negotiation',
            entityType: 'booking',
            entityId: String(booking._id),
            context: { bookingId: String(booking._id) },
          });
        }
      } else if (!isCustomer && customerUser?._id) {
        await notify({
          userId: customerUser._id.toString(),
          actorId: String(userId),
          eventKey: 'customer.refund_negotiation',
          entityType: 'booking',
          entityId: String(booking._id),
          context: { bookingId: String(booking._id) },
        });
      }
    } catch (emailError: any) {
      console.error('Failed to send cancellation-request-raised email:', emailError?.message || emailError);
    }

    return res.status(201).json({
      success: true,
      msg: isCustomer
        ? "Refund request sent to the professional. They have 5 business days to respond before it escalates to Fixtract."
        : "Cancellation request submitted for admin review",
      cancellationRequest,
    });
  } catch (error: any) {
    console.error('Cancel booking error:', error);
    next(error);
  }
};

// List disputes raised by or against the current user
export const getMyDisputes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    if (!userId) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const objectUserId = new mongoose.Types.ObjectId(userId);
    const bookings = await Booking.find({
      status: { $in: ['dispute', 'completed', 'cancelled', 'refunded'] },
      'dispute.raisedAt': { $exists: true },
      $or: [{ customer: objectUserId }, { professional: objectUserId }],
    })
      .select('bookingNumber status dispute customer professional project payment scheduledStartDate')
      .populate('customer', 'name isAnonymized deletedAt')
      .populate('professional', 'name isAnonymized deletedAt')
      .populate('project', 'title')
      .sort({ 'dispute.raisedAt': -1 })
      .limit(100)
      .lean();

    const visibleBookings = bookings.map((booking: any) =>
      bookingForRequest(booking, req.user)
    );

    return res.json({ success: true, data: { items: visibleBookings } });
  } catch (error: any) {
    console.error('Get my disputes error:', error);
    next(error);
  }
};

// Get payment history for current customer
export const getMyPayments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id ? req.user._id.toString() : undefined;
    const { status, page = '1', limit = '20', q, search, bookingId, service } = req.query;

    if (!userId) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role !== 'customer') {
      return res.status(403).json({ success: false, msg: "Only customers can view payment history" });
    }

    const query: Record<string, any> = { customer: userId };
    if (status && typeof status === 'string' && status !== 'all') {
      query.status = status;
    }

    // Literal search: booking number substring (escaped, never raw regex),
    // exact booking identity, or counterparty (professional) name.
    const searchRaw = typeof q === 'string' && q ? q
      : typeof search === 'string' && search ? search : '';
    const trimmedSearch = searchRaw.trim().slice(0, 80);
    if (trimmedSearch) {
      const escaped = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      const searchOr: Record<string, any>[] = [{ bookingNumber: regex }];
      if (mongoose.Types.ObjectId.isValid(trimmedSearch)) {
        searchOr.push({ booking: new mongoose.Types.ObjectId(trimmedSearch) });
      }
      const matchingProfessionals = await User.find({ role: 'professional', name: regex }).select('_id');
      if (matchingProfessionals.length > 0) {
        searchOr.push({ professional: { $in: matchingProfessionals.map(p => p._id) } });
      }
      query.$and = (query.$and || []).concat([{ $or: searchOr }]);
    }

    if (bookingId && typeof bookingId === 'string' && mongoose.Types.ObjectId.isValid(bookingId)) {
      query.booking = new mongoose.Types.ObjectId(bookingId);
    }

    // Service filter resolves through the customer's own bookings, so the
    // payment collection itself is never scanned by service name.
    if (service && typeof service === 'string' && service !== 'all') {
      const serviceProjectIds = await Project.find({ service }).select('_id');
      const serviceBookingFilter: Record<string, any> = {
        customer: userId,
        $or: [{ 'rfqData.serviceType': service }],
      };
      if (serviceProjectIds.length > 0) {
        (serviceBookingFilter.$or as any[]).push({ project: { $in: serviceProjectIds.map(p => p._id) } });
      }
      const serviceBookingIds = await Booking.find(serviceBookingFilter).select('_id').lean();
      const serviceIdSet = new Set(serviceBookingIds.map((b: any) => String(b._id)));
      if (query.booking) {
        // An explicit booking was also requested: keep it only when it
        // belongs to the requested service set.
        query.booking = serviceIdSet.has(String(query.booking)) ? query.booking : { $in: [] };
      } else {
        query.booking = { $in: Array.from(serviceIdSet) };
      }
    }

    const pageNumber = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNumber = Math.min(Math.max(parseInt(limit as string, 10) || 20, 5), 100);
    const skip = (pageNumber - 1) * limitNumber;

    const [payments, totalCount, summaryStats] = await Promise.all([
      Payment.find(query)
        .populate('booking', 'status bookingType bookingNumber')
        .populate('professional', 'name email username businessInfo isAnonymized deletedAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      Payment.countDocuments(query),
      Payment.aggregate([
        { $match: { customer: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            total: { $sum: '$totalWithVat' }
          }
        }
      ])
    ]);

    const summary = {
      totalPaid: 0,
      inEscrow: 0,
      refunded: 0,
    };
    summaryStats.forEach((s: any) => {
      if (s._id === 'completed') summary.totalPaid += s.total || 0;
      if (s._id === 'authorized') summary.inEscrow += s.total || 0;
      if (s._id === 'refunded') summary.refunded += s.total || 0;
      if (s._id === 'partially_refunded') summary.refunded += s.total || 0;
    });

    const visiblePayments = payments.map((payment: any) => ({
      ...sanitizePaymentForViewer(payment, 'customer'),
      professional: maskAnonymizedUser(payment.professional),
    }));

    return res.status(200).json({
      success: true,
      data: {
        payments: visiblePayments,
        summary,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNumber)
        }
      }
    });
  } catch (error: any) {
    console.error('Get my payments error:', error);
    next(error);
  }
};

/**
 * Preview the VAT decision for the current customer before a booking is
 * created, so the booking wizard can show the anticipated rate and outcome.
 */
export const previewVatDecision = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id;
    const { projectId, serviceConfigurationId, vatAnswers, serviceCountry } = req.body;

    const customer = await User.findById(userId).select(
      "role customerType vatNumber isVatVerified location companyAddress"
    );
    if (!customer || customer.role !== "customer") {
      return res.status(403).json({ success: false, msg: "Only customers can preview VAT" });
    }

    const normalizedVatAnswers = Array.isArray(vatAnswers)
      ? vatAnswers.reduce((acc: Record<string, unknown>, answer: any) => {
          if (answer?.fieldName) acc[String(answer.fieldName)] = answer.value;
          return acc;
        }, {})
      : {};

    let project: any = null;
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      project = await Project.findById(projectId).select(
        "services category service areaOfWork serviceConfigurationId distance vatProfessionalAnswers"
      );
    }
    const projectService = Array.isArray(project?.services) && project.services.length > 0
      ? project.services[0]
      : null;
    const parsedRequestedCountry = serviceCountry ? parseVatCountryCode(serviceCountry) : "";
    if (serviceCountry && !parsedRequestedCountry) {
      return res.status(400).json({ success: false, msg: "A valid ISO service country is required" });
    }
    const previewCountry = firstVatCountry(
      project?.distance?.countryCode,
      parsedRequestedCountry,
      customer.location?.country,
    );
    const coverageError = await validateServiceCountryCoverage({
      country: previewCountry,
      serviceConfigurationId: serviceConfigurationId || project?.serviceConfigurationId,
      projectCountry: project?.distance?.countryCode,
    });
    if (coverageError) return res.status(400).json({ success: false, msg: coverageError });

    const decision = await resolveVatDecisionFromConfig({
      serviceConfigurationId: serviceConfigurationId || project?.serviceConfigurationId,
      category: projectService?.category || project?.category,
      service: projectService?.service || project?.service,
      areaOfWork: projectService?.areaOfWork || project?.areaOfWork,
      country: previewCountry,
      bookingCountry: previewCountry,
      businessCountry: firstVatCountry(customer.companyAddress?.country, customer.location?.country),
      answers: normalizedVatAnswers,
      professionalAnswers: professionalAnswersFromProject(project),
      customerType: customer.customerType || "individual",
      vatNumber: customer.vatNumber,
      isVatVerified: customer.isVatVerified,
    });

    return res.json({ success: true, data: decision });
  } catch (error) {
    console.error("Error previewing VAT decision:", error);
    return res.status(500).json({ success: false, msg: "Failed to preview VAT" });
  }
};

export const proceedAtStandardVatRate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id?.toString();
    const { bookingId } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    if (!mongoose.Types.ObjectId.isValid(bookingId as string)) {
      return res.status(400).json({ success: false, msg: "Invalid booking ID" });
    }

    const booking = await Booking.findById(bookingId)
      .populate("customer", "customerType vatNumber isVatVerified")
      .populate("project", "title subprojects extraOptions");
    if (!booking) {
      return res.status(404).json({ success: false, msg: "Booking not found" });
    }

    if (booking.customer._id.toString() !== userId) {
      return res.status(403).json({ success: false, msg: "Only the customer can update VAT preference" });
    }

    if (booking.vatDecision?.action !== "rfq") {
      return res.status(400).json({
        success: false,
        msg: "Standard-rate override is only available when VAT review is required",
      });
    }

    if (booking.vatDecision.reverseCharge) {
      return res.status(400).json({
        success: false,
        msg: "Standard-rate override is not available because this booking already qualifies for reverse-charge VAT.",
      });
    }

    if (!booking.vatDecision.country) {
      return res.status(409).json({
        success: false,
        msg: "VAT country is missing; refresh the booking VAT decision before continuing.",
      });
    }

    const standardRate = Number.isFinite(booking.vatDecision.standardRate)
      ? booking.vatDecision.standardRate!
      : booking.vatDecision.appliedRate ?? 21;

    const customer = booking.customer as any;
    booking.vatDecision = applyB2BInvoiceRule({
      ...booking.vatDecision,
      country: booking.vatDecision.country,
      action: "standard_rate",
      appliedRate: standardRate,
      reverseCharge: false,
      explanation: `Customer chose to proceed at the standard VAT rate (${standardRate}%).`,
      matchedRuleText: undefined,
    }, customer?.customerType, customer?.vatNumber, customer?.isVatVerified, {
      propertyNature: booking.vatDecision.propertyNature,
      exemptFromBelgianReverseCharge: booking.vatDecision.exemptFromBelgianReverseCharge,
    });

    const project = booking.project as any;
    const subprojectIndex = booking.selectedSubprojectIndex;
    const selectedSubproject =
      typeof subprojectIndex === "number" &&
      Array.isArray(project?.subprojects) &&
      subprojectIndex >= 0 &&
      subprojectIndex < project.subprojects.length
        ? project.subprojects[subprojectIndex]
        : undefined;

    if (
      selectedSubproject &&
      selectedSubproject.pricing?.type !== "rfq" &&
      Number.isFinite(Number(selectedSubproject.pricing?.amount))
    ) {
      const snapshot = booking.checkoutSnapshot || (
        selectedSubproject.pricing?.type === "unit"
          ? null
          : buildCheckoutSnapshot({
              project,
              selectedSubproject,
              selectedExtraOptions: [],
              estimatedUsage: 1,
            })
      );
      if (!snapshot) {
        return res.status(400).json({
          success: false,
          msg: selectedSubproject.pricing?.type === "unit"
            ? "Unable to restore checkout because the original usage quantity is unavailable"
            : "Unable to restore checkout because the original package price is unavailable",
        });
      }
      const selectedOptions = Array.isArray(booking.selectedExtraOptions) ? booking.selectedExtraOptions : [];
      const selectedOptionsById = new Map(snapshot.selectedOptions.map((option: any) => [String(option.extraOptionId), option]));
      const fallbackOptionLines = selectedOptions
        .filter((selected: any) => !selectedOptionsById.has(String(selected.extraOptionId)))
        .map((selected: any) => {
          const configuredOption = (project.extraOptions || []).find((option: any) =>
            option?._id?.toString?.() === selected.extraOptionId?.toString?.()
          );
          const price = Number(selected.bookedPrice ?? configuredOption?.price ?? 0);
          return {
            item: `Extra Option: ${configuredOption?.name || selected.extraOptionId || "Extra option"}`,
            quantity: 1,
            unitPrice: Number.isFinite(price) ? price : 0,
            totalPrice: Number.isFinite(price) ? price : 0,
          };
        })
        .filter((line: any) => line.totalPrice > 0);
      const amount = roundMoney(
        snapshot.totalAmount + fallbackOptionLines.reduce((sum: number, line: any) => sum + line.totalPrice, 0)
      );

      if (amount > 0) {
        const breakdown = [
          ...snapshotToQuoteBreakdown(snapshot, subprojectIndex),
          ...fallbackOptionLines,
        ];
        const computedTotalIndex = breakdown.findIndex((line) => line.item === "checkout_snapshot:computed_total");
        if (computedTotalIndex >= 0) {
          breakdown[computedTotalIndex] = {
            ...breakdown[computedTotalIndex],
            unitPrice: amount,
            totalPrice: amount,
          };
        }

        booking.quote = {
          amount,
          currency: booking.quote?.currency || snapshot.currency || "EUR",
          description: `Auto-generated checkout quote for ${project.title || "service"}`,
          breakdown,
          submittedAt: new Date(),
          submittedBy: booking.professional,
        } as any;
        booking.status = "quote_accepted";
        booking.statusHistory.push({
          status: "quote_accepted",
          timestamp: new Date(),
          updatedBy: booking.customer,
          note: "Customer chose standard VAT rate and restored fixed-price checkout",
        });
      }
    }
    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Booking updated to standard VAT rate",
      booking: bookingForRequest(booking, req.user),
    });
  } catch (error: any) {
    console.error("Proceed at standard VAT rate error:", error);
    next(error);
  }
};
