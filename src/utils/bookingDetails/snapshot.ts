import type { IBookingSnapshot, IBookingSnapshotQuestion } from '../../models/booking';
import { sanitizeStoredUrl, sanitizeStoredUrls } from './attachments';

const toPlain = <T = any>(value: any): T | null => {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(typeof value.toObject === 'function' ? value.toObject() : value)) as T;
  } catch {
    return null;
  }
};

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const numberOrUndefined = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : undefined;
};

export const isValidIanaTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
};

const snapshotQuestion = (question: any): IBookingSnapshotQuestion | null => {
  if (!question?.question) return null;
  const options = Array.isArray(question.options)
    ? question.options.filter((option: unknown): option is string => typeof option === 'string')
    : undefined;
  const professionalAttachments = sanitizeStoredUrls(question.professionalAttachments);
  return {
    ...(question._id ? { questionId: String(question._id) } : {}),
    question: String(question.question).slice(0, 500),
    type: stringOrUndefined(question.type),
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof question.isRequired === 'boolean' ? { isRequired: question.isRequired } : {}),
    ...(professionalAttachments.length > 0 ? { professionalAttachments } : {}),
  };
};

export const snapshotQuestionDefinitions = (questions: unknown): IBookingSnapshotQuestion[] =>
  Array.isArray(questions)
    ? questions.map(snapshotQuestion).filter((question): question is IBookingSnapshotQuestion => Boolean(question))
    : [];

export const snapshotVatQuestionDefinitions = (
  questions: unknown,
): Array<{ fieldName: string; question?: string; type?: string }> =>
  Array.isArray(questions)
    ? questions
        .filter((question: any) => question?.fieldName)
        .map((question: any) => ({
          fieldName: String(question.fieldName),
          ...(stringOrUndefined(question.question) ? { question: String(question.question).slice(0, 500) } : {}),
          ...(stringOrUndefined(question.type) ? { type: String(question.type) } : {}),
        }))
    : [];

const snapshotTerms = (terms: unknown) =>
  Array.isArray(terms)
    ? terms
        .filter((term: any) => term?.name)
        .map((term: any) => ({
          name: String(term.name).slice(0, 300),
          description: String(term.description || '').slice(0, 2000),
          ...(term.type === 'condition' || term.type === 'warning' ? { type: term.type } : {}),
          ...(numberOrUndefined(term.additionalCost) != null
            ? { additionalCost: numberOrUndefined(term.additionalCost) }
            : {}),
          ...(typeof term.isCustom === 'boolean' ? { isCustom: term.isCustom } : {}),
        }))
    : [];

const snapshotMedia = (media: any) => {
  const images = sanitizeStoredUrls(media?.images).slice(0, 30);
  const video = sanitizeStoredUrl(media?.video);
  if (images.length === 0 && !video) return undefined;
  return {
    ...(images.length > 0 ? { images } : {}),
    ...(video ? { video } : {}),
  };
};

const snapshotProject = (project: any) => {
  if (!project?._id) return undefined;
  return {
    id: String(project._id),
    title: String(project.title || '').slice(0, 300),
    ...(stringOrUndefined(project.category) ? { category: String(project.category) } : {}),
    ...(stringOrUndefined(project.service) ? { service: String(project.service) } : {}),
    ...(stringOrUndefined(project.areaOfWork) ? { areaOfWork: String(project.areaOfWork) } : {}),
    ...(stringOrUndefined(project.description)
      ? { description: String(project.description).slice(0, 5000) }
      : {}),
    ...(stringOrUndefined(project.priceModel) ? { priceModel: String(project.priceModel) } : {}),
    ...(stringOrUndefined(project.timeMode) ? { timeMode: String(project.timeMode) } : {}),
    ...(snapshotMedia(project.media) ? { media: snapshotMedia(project.media) } : {}),
    ...(snapshotTerms(project.termsConditions).length > 0
      ? { termsConditions: snapshotTerms(project.termsConditions) }
      : {}),
    ...(stringOrUndefined(project.customConfirmationMessage)
      ? { customConfirmationMessage: String(project.customConfirmationMessage).slice(0, 2000) }
      : {}),
    ...(numberOrUndefined(project.minResources) != null
      ? { minResources: numberOrUndefined(project.minResources) }
      : {}),
    ...(numberOrUndefined(project.minOverlapPercentage) != null
      ? { minOverlapPercentage: numberOrUndefined(project.minOverlapPercentage) }
      : {}),
    ...(Array.isArray(project.resources) ? { resourcesCount: project.resources.length } : {}),
  };
};

const pricingSnapshot = (pricing: any) => {
  if (!pricing || typeof pricing !== 'object') return undefined;
  return {
    ...(pricing.type ? { type: pricing.type } : {}),
    ...(numberOrUndefined(pricing.amount) != null ? { amount: numberOrUndefined(pricing.amount) } : {}),
    ...(pricing.priceRange
      ? {
          priceRange: {
            ...(numberOrUndefined(pricing.priceRange.min) != null
              ? { min: numberOrUndefined(pricing.priceRange.min) }
              : {}),
            ...(numberOrUndefined(pricing.priceRange.max) != null
              ? { max: numberOrUndefined(pricing.priceRange.max) }
              : {}),
          },
        }
      : {}),
    ...(numberOrUndefined(pricing.minOrderQuantity) != null
      ? { minOrderQuantity: numberOrUndefined(pricing.minOrderQuantity) }
      : {}),
    ...(stringOrUndefined(pricing.unit) ? { unit: String(pricing.unit) } : {}),
  };
};

const includedSnapshot = (included: any) =>
  Array.isArray(included)
    ? included
        .filter((item: any) => item?.name)
        .map((item: any) => ({
          name: String(item.name).slice(0, 300),
          ...(stringOrUndefined(item.description)
            ? { description: String(item.description).slice(0, 1000) }
            : {}),
          ...(typeof item.isCustom === 'boolean' ? { isCustom: item.isCustom } : {}),
        }))
    : [];

const materialsSnapshot = (materials: any) =>
  Array.isArray(materials)
    ? materials
        .filter((material: any) => material?.name)
        .map((material: any) => ({
          name: String(material.name).slice(0, 300),
          ...(material.quantity != null ? { quantity: String(material.quantity).slice(0, 100) } : {}),
          ...(stringOrUndefined(material.unit) ? { unit: String(material.unit) } : {}),
          ...(stringOrUndefined(material.description)
            ? { description: String(material.description).slice(0, 1000) }
            : {}),
        }))
    : [];

const durationSnapshot = (duration: any) => {
  if (!duration || numberOrUndefined(duration.value) == null || !duration.unit) return undefined;
  return {
    value: numberOrUndefined(duration.value),
    unit: duration.unit,
    ...(duration.range
      ? {
          range: {
            ...(numberOrUndefined(duration.range.min) != null
              ? { min: numberOrUndefined(duration.range.min) }
              : {}),
            ...(numberOrUndefined(duration.range.max) != null
              ? { max: numberOrUndefined(duration.range.max) }
              : {}),
          },
        }
      : {}),
  };
};

const intakeDurationSnapshot = (duration: any) => {
  if (!duration || numberOrUndefined(duration.value) == null || !duration.unit) return undefined;
  return {
    value: numberOrUndefined(duration.value),
    unit: duration.unit,
    ...(numberOrUndefined(duration.buffer) != null ? { buffer: numberOrUndefined(duration.buffer) } : {}),
  };
};

const snapshotSelectedSubproject = (subproject: any) => {
  if (!subproject?.name) return undefined;
  return {
    name: String(subproject.name).slice(0, 300),
    description: String(subproject.description || '').slice(0, 5000),
    projectType: Array.isArray(subproject.projectType) ? subproject.projectType.filter(Boolean).map(String) : [],
    ...(stringOrUndefined(subproject.customProjectType)
      ? { customProjectType: String(subproject.customProjectType) }
      : {}),
    ...(pricingSnapshot(subproject.pricing) ? { pricing: pricingSnapshot(subproject.pricing) } : {}),
    included: includedSnapshot(subproject.included),
    materialsIncluded: Boolean(subproject.materialsIncluded),
    materials: materialsSnapshot(subproject.materials),
    ...(durationSnapshot(subproject.preparationDuration)
      ? { preparationDuration: durationSnapshot(subproject.preparationDuration) }
      : {}),
    ...(durationSnapshot(subproject.executionDuration)
      ? { executionDuration: durationSnapshot(subproject.executionDuration) }
      : {}),
    ...(durationSnapshot(subproject.buffer) ? { buffer: durationSnapshot(subproject.buffer) } : {}),
    ...(intakeDurationSnapshot(subproject.intakeDuration)
      ? { intakeDuration: intakeDurationSnapshot(subproject.intakeDuration) }
      : {}),
    ...(subproject.warrantyPeriod
      ? {
          warrantyPeriod: {
            ...(numberOrUndefined(subproject.warrantyPeriod.value) != null
              ? { value: numberOrUndefined(subproject.warrantyPeriod.value) }
              : {}),
            ...(subproject.warrantyPeriod.unit ? { unit: subproject.warrantyPeriod.unit } : {}),
          },
        }
      : {}),
  };
};

const selectedExtraOptionsSnapshot = (booking: any, project: any) => {
  if (!Array.isArray(booking.selectedExtraOptions)) return [];
  const options = Array.isArray(project?.extraOptions) ? project.extraOptions : [];
  const checkoutOptions = Array.isArray(booking?.checkoutSnapshot?.selectedOptions)
    ? booking.checkoutSnapshot.selectedOptions
    : [];
  return booking.selectedExtraOptions
    .filter((selected: any) => selected && selected.extraOptionId != null)
    .map((selected: any) => {
      const option = options.find(
        (candidate: any) =>
          candidate?._id?.toString?.() === String(selected.extraOptionId)
          || String(candidate?._id) === String(selected.extraOptionId),
      );
      const checkoutOption = checkoutOptions.find(
        (candidate: any) => String(candidate?.extraOptionId) === String(selected.extraOptionId),
      );
      const bookedPrice = Number(selected.bookedPrice);
      const unitPrice = Number(option?.price);
      return {
        extraOptionId: String(selected.extraOptionId),
        ...(option?.name ? { name: String(option.name) } : {}),
        ...(option?.description ? { description: String(option.description) } : {}),
        ...(Number.isFinite(unitPrice) ? { unitPrice } : {}),
        quantity:
          numberOrUndefined(selected.quantity)
          ?? numberOrUndefined(checkoutOption?.quantity)
          ?? 1,
        ...(Number.isFinite(bookedPrice) ? { totalPrice: bookedPrice, bookedPrice } : {}),
      };
    });
};

const checkoutSnapshot = (booking: any) => {
  const snapshot = toPlain(booking.checkoutSnapshot);
  if (!snapshot) return undefined;
  return {
    ...(snapshot.pricingType ? { pricingType: snapshot.pricingType } : {}),
    ...(numberOrUndefined(snapshot.unitAmount) != null ? { unitAmount: numberOrUndefined(snapshot.unitAmount) } : {}),
    ...(numberOrUndefined(snapshot.quantity) != null ? { quantity: numberOrUndefined(snapshot.quantity) } : {}),
    ...(stringOrUndefined(snapshot.unit) ? { unit: String(snapshot.unit) } : {}),
    ...(numberOrUndefined(snapshot.baseSubtotal) != null
      ? { baseSubtotal: numberOrUndefined(snapshot.baseSubtotal) }
      : {}),
    ...(numberOrUndefined(snapshot.extraOptionsTotal) != null
      ? { extraOptionsTotal: numberOrUndefined(snapshot.extraOptionsTotal) }
      : {}),
    ...(numberOrUndefined(snapshot.totalAmount) != null
      ? { totalAmount: numberOrUndefined(snapshot.totalAmount) }
      : {}),
    ...(stringOrUndefined(snapshot.currency) ? { currency: String(snapshot.currency) } : {}),
    selectedOptions: Array.isArray(snapshot.selectedOptions)
      ? snapshot.selectedOptions.map((option: any) => ({
          extraOptionId: option.extraOptionId ? String(option.extraOptionId) : null,
          name: String(option.name || ''),
          unitPrice: numberOrUndefined(option.unitPrice) ?? 0,
          quantity: numberOrUndefined(option.quantity) ?? 1,
          totalPrice: numberOrUndefined(option.totalPrice) ?? 0,
        }))
      : [],
  };
};

const snapshotParties = (customer: any, professional: any) => ({
  customer: {
    displayName: stringOrUndefined(customer?.name) || stringOrUndefined(customer?.username) || null,
    customerType: customer?.customerType === 'business' ? 'business' : 'individual',
    businessName: stringOrUndefined(customer?.businessName) || null,
    city: stringOrUndefined(customer?.location?.city) || null,
    country: stringOrUndefined(customer?.location?.country) || null,
  },
  professional: {
    displayName:
      stringOrUndefined(professional?.name)
      || stringOrUndefined(professional?.username)
      || stringOrUndefined(professional?.businessInfo?.companyName)
      || null,
    companyName: stringOrUndefined(professional?.businessInfo?.companyName) || null,
    city: stringOrUndefined(professional?.businessInfo?.city) || null,
    country: stringOrUndefined(professional?.businessInfo?.country) || null,
    timezone: isValidIanaTimeZone(professional?.businessInfo?.timezone)
      ? professional.businessInfo.timezone
      : null,
  },
});

export const buildBookingSnapshot = (params: {
  booking: any;
  project?: any;
  customer?: any;
  professional?: any;
  source: IBookingSnapshot['source'];
  capturedAt?: Date;
  vatQuestions?: unknown;
  scheduleTimeZone?: string | null;
}): IBookingSnapshot | null => {
  const { booking, project, customer, professional, source } = params;
  if (!booking) return null;

  const selectedIndex = Number.isInteger(Number(booking.selectedSubprojectIndex))
    ? Number(booking.selectedSubprojectIndex)
    : undefined;
  const subprojects = Array.isArray(project?.subprojects) ? project.subprojects : [];
  const selectedSubproject =
    selectedIndex != null && selectedIndex >= 0 && selectedIndex < subprojects.length
      ? snapshotSelectedSubproject(subprojects[selectedIndex])
      : undefined;

  const schedule = {
    ...(booking.rfqData?.preferredStartDate
      ? { preferredStartDate: new Date(booking.rfqData.preferredStartDate).toISOString().slice(0, 10) }
      : {}),
    ...(stringOrUndefined(booking.rfqData?.preferredStartTime)
      ? { preferredStartTime: String(booking.rfqData.preferredStartTime) }
      : {}),
    ...(booking.scheduledStartDate
      ? { scheduledStartDate: new Date(booking.scheduledStartDate).toISOString().slice(0, 10) }
      : {}),
    ...(stringOrUndefined(booking.scheduledStartTime)
      ? { scheduledStartTime: String(booking.scheduledStartTime) }
      : {}),
    ...(booking.scheduledExecutionEndDate
      ? { scheduledExecutionEndDate: new Date(booking.scheduledExecutionEndDate).toISOString().slice(0, 10) }
      : {}),
    ...(booking.scheduledBufferStartDate
      ? { scheduledBufferStartDate: new Date(booking.scheduledBufferStartDate).toISOString().slice(0, 10) }
      : {}),
    ...(booking.scheduledBufferEndDate
      ? { scheduledBufferEndDate: new Date(booking.scheduledBufferEndDate).toISOString().slice(0, 10) }
      : {}),
    ...(params.scheduleTimeZone && isValidIanaTimeZone(params.scheduleTimeZone)
      ? { timeZone: params.scheduleTimeZone }
      : {}),
  };

  const projectSnapshot = snapshotProject(project);
  const partySnapshot = snapshotParties(customer, professional);
  const rfqQuestions = snapshotQuestionDefinitions(project?.rfqQuestions);
  const postBookingQuestions = snapshotQuestionDefinitions(project?.postBookingQuestions);

  return {
    capturedAt: params.capturedAt || new Date(),
    source,
    ...(projectSnapshot ? { project: projectSnapshot } : {}),
    questions: {
      ...(rfqQuestions.length > 0 ? { rfq: rfqQuestions } : {}),
      ...(postBookingQuestions.length > 0 ? { postBooking: postBookingQuestions } : {}),
      ...(snapshotVatQuestionDefinitions(params.vatQuestions).length > 0
        ? { vat: snapshotVatQuestionDefinitions(params.vatQuestions) }
        : {}),
    },
    schedule,
    location: {
      ...(stringOrUndefined(booking.location?.address) ? { address: booking.location.address } : {}),
      ...(stringOrUndefined(booking.location?.city) ? { city: booking.location.city } : {}),
      ...(stringOrUndefined(booking.location?.postalCode) ? { postalCode: booking.location.postalCode } : {}),
      ...(stringOrUndefined(booking.location?.country) ? { country: booking.location.country } : {}),
      ...(Array.isArray(booking.location?.coordinates) && booking.location.coordinates.length === 2
        ? { coordinates: booking.location.coordinates }
        : {}),
    },
    ...(selectedIndex != null ? { selectedSubprojectIndex: selectedIndex } : {}),
    ...(selectedSubproject ? { selectedSubproject } : {}),
    selectedExtraOptions: selectedExtraOptionsSnapshot(booking, project),
    ...(checkoutSnapshot(booking) ? { checkoutSnapshot: checkoutSnapshot(booking) } : {}),
    parties: partySnapshot,
    ...(stringOrUndefined(booking.serviceConfigurationId)
      ? { serviceConfigurationId: String(booking.serviceConfigurationId) }
      : {}),
  };
};

export const isBookingSnapshotComplete = (snapshot: any): boolean =>
  Boolean(
    snapshot?.capturedAt
      && snapshot?.source
      && (snapshot?.project?.id || snapshot?.parties?.professional?.displayName),
  );

export { toPlain };
