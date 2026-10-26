import type {
  ActorDto,
  AdminLinksDto,
  AttachmentDto,
  BookingActivityDto,
  BookingDetailsDto,
  BookingInternalDto,
  BookingOverviewDto,
  BookingSnapshotDto,
  BookingWizardDto,
  CancellationRequestDto,
  CheckoutSnapshotDto,
  DetailsNotice,
  DetailsViewerRole,
  ExtraCostPaymentDto,
  ExtraCostsDetailsDto,
  PartiesDto,
  PaymentRecordDto,
  PaymentsDetailsDto,
  PostBookingDetailsDto,
  PostBookingQuestionDto,
  QuotationDetailsDto,
  QuotationVersionDto,
  RFQQuestionDto,
  RefundDto,
  RescheduleHistoryDto,
  RoleInvoiceDto,
  ScheduleSnapshotDto,
  WarrantyClaimSummaryDto,
} from './types';
import { actorForId, isActorRecorded, type ActorMap } from './actors';
import {
  presignOwnedUrl,
  presignQuestionAnswerUrl,
  presignSharedProjectUrl,
  referenceId,
} from './attachments';
import { sanitizePaymentForViewer } from '../invoiceVisibility';
import { filterPaymentForAdminArea } from './adminAccess';
import { buildBookingActivity } from './timeline';
import { refundFactReference, resolvePaymentRows, resolveRefundFacts } from './paymentFacts';
import { refundCountsAsCash } from '../paymentRefunds';
import { resolveAcceptedQuoteVersion } from './quoteTotals';
import { isBookingSnapshotComplete, isValidIanaTimeZone } from './snapshot';
import { parseS3KeyFromUrl } from '../s3Upload';
import {
  isAnonymizedAccount,
  maskBookingForAnonymizedParties,
  maskCancellationRequestForAnonymizedParties,
  maskWarrantyClaimForAnonymizedParties,
} from '../accountAnonymity';

const CUSTOMER_INVOICE_KEYS = [
  'invoiceNumber',
  'invoiceUrl',
  'invoiceUblUrl',
  'invoiceGeneratedAt',
  'creditNoteNumber',
  'creditNoteUrl',
  'creditNoteUblUrl',
  'creditNoteGeneratedAt',
  'creditNoteRelatedInvoiceNumber',
  'peppolDispatchStatus',
  'peppolDispatchReference',
  'peppolDispatchedAt',
] as const;

const SUPPLIER_INVOICE_KEYS = [
  'supplierInvoiceNumber',
  'supplierInvoiceUrl',
  'supplierInvoiceUblUrl',
  'supplierInvoiceGeneratedAt',
  'supplierCreditNoteNumber',
  'supplierCreditNoteUrl',
  'supplierCreditNoteUblUrl',
  'supplierCreditNoteGeneratedAt',
  'supplierCreditNoteRelatedInvoiceNumber',
  'supplierPeppolDispatchStatus',
  'supplierPeppolDispatchReference',
  'supplierPeppolDispatchedAt',
] as const;

const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const dateOnly = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const num = (value: unknown): number | null => {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : null;
};

const numOrUndefined = (value: unknown): number | undefined => {
  const parsed = num(value);
  return parsed == null ? undefined : parsed;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const bool = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const objectId = (value: any): string => referenceId(value) || String(value ?? '');

const notice = (
  code: string,
  severity: 'info' | 'warning' = 'info',
  entity?: DetailsNotice['entity'],
): DetailsNotice => ({ code, severity, ...(entity ? { entity } : {}) });

const uniqueNotices = (notices: Array<DetailsNotice | null | undefined>): DetailsNotice[] => {
  const seen = new Set<string>();
  return notices.filter((entry): entry is DetailsNotice => {
    if (!entry || seen.has(entry.code)) return false;
    seen.add(entry.code);
    return true;
  });
};

/**
 * The recorded rejection reason is the text after the generated prefix in the
 * `quote_rejected` status note, for example
 * "Customer rejected quotation v2: Too expensive". Never derive it from the
 * single booking-level field for historical versions.
 */
const rejectionReasonFromNote = (note: string): string | null => {
  const match = note.match(
    /customer rejected (?:the )?(?:quotation|quote)(?:\s+v\d+)?\s*:\s*([\s\S]+)$/i,
  );
  const value = match?.[1]?.trim();
  return value ? value : null;
};

const mapScheduleSnapshot = (schedule: any): ScheduleSnapshotDto | null => {
  if (!schedule) return null;
  return {
    scheduledStartDate: dateOnly(schedule.scheduledStartDate),
    scheduledExecutionEndDate: dateOnly(schedule.scheduledExecutionEndDate),
    scheduledBufferStartDate: dateOnly(schedule.scheduledBufferStartDate),
    scheduledBufferEndDate: dateOnly(schedule.scheduledBufferEndDate),
    scheduledBufferUnit: schedule.scheduledBufferUnit || null,
    scheduledStartTime: str(schedule.scheduledStartTime),
    scheduledEndTime: str(schedule.scheduledEndTime),
    ...(Array.isArray(schedule.assignedTeamMembers) && schedule.assignedTeamMembers.length > 0
      ? {
          assignedTeamMembers: schedule.assignedTeamMembers.map((member: any) => ({
            id: objectId(member),
            ...(member?.name ? { name: member.name } : {}),
          })),
        }
      : {}),
  };
};

const mapCheckoutSnapshot = (snapshot: any): CheckoutSnapshotDto | null => {
  if (!snapshot) return null;
  const hasCore =
    (snapshot.pricingType === 'fixed' || snapshot.pricingType === 'unit')
    && num(snapshot.unitAmount) != null
    && num(snapshot.quantity) != null
    && num(snapshot.baseSubtotal) != null
    && num(snapshot.extraOptionsTotal) != null
    && num(snapshot.totalAmount) != null
    && str(snapshot.currency);
  if (!hasCore) return null;
  return {
    pricingType: snapshot.pricingType,
    unitAmount: Number(snapshot.unitAmount),
    quantity: Number(snapshot.quantity),
    unit: str(snapshot.unit),
    baseSubtotal: Number(snapshot.baseSubtotal),
    extraOptionsTotal: Number(snapshot.extraOptionsTotal),
    totalAmount: Number(snapshot.totalAmount),
    currency: snapshot.currency,
    selectedOptions: Array.isArray(snapshot.selectedOptions)
      ? snapshot.selectedOptions.map((option: any) => ({
          extraOptionId: option.extraOptionId ? String(option.extraOptionId) : null,
          name: String(option.name || ''),
          unitPrice: num(option.unitPrice) ?? 0,
          quantity: num(option.quantity) ?? 1,
          totalPrice: num(option.totalPrice) ?? 0,
        }))
      : [],
    complete: true,
  };
};

const mapSnapshotSubproject = (subproject: any): BookingSnapshotDto['selectedSubproject'] => {
  if (!subproject?.name) return null;
  const duration = (value: any) => {
    if (!value || num(value.value) == null) return null;
    const result: any = { value: num(value.value), unit: value.unit || 'days' };
    if (value.range) {
      result.range = {
        ...(num(value.range.min) != null ? { min: num(value.range.min) } : {}),
        ...(num(value.range.max) != null ? { max: num(value.range.max) } : {}),
      };
    }
    return result;
  };
  return {
    name: String(subproject.name),
    description: String(subproject.description || ''),
    projectType: Array.isArray(subproject.projectType) ? subproject.projectType.map(String) : [],
    customProjectType: str(subproject.customProjectType),
    pricing: {
      type: subproject.pricing?.type || null,
      amount: num(subproject.pricing?.amount),
      priceRange: subproject.pricing?.priceRange
        ? {
            min: num(subproject.pricing.priceRange.min) ?? 0,
            max: num(subproject.pricing.priceRange.max) ?? 0,
          }
        : null,
      minOrderQuantity: num(subproject.pricing?.minOrderQuantity),
      unit: str(subproject.pricing?.unit),
    },
    included: Array.isArray(subproject.included)
      ? subproject.included.map((item: any) => ({
          name: String(item.name || ''),
          description: str(item.description),
          isCustom: Boolean(item.isCustom),
        }))
      : [],
    materialsIncluded: Boolean(subproject.materialsIncluded),
    materials: Array.isArray(subproject.materials)
      ? subproject.materials.map((material: any) => ({
          name: String(material.name || ''),
          quantity: material.quantity != null ? String(material.quantity) : null,
          unit: str(material.unit),
          description: str(material.description),
        }))
      : [],
    preparationDuration: duration(subproject.preparationDuration) as any,
    executionDuration: duration(subproject.executionDuration) as any,
    buffer: duration(subproject.buffer) as any,
    intakeDuration: subproject.intakeDuration && num(subproject.intakeDuration.value) != null
      ? {
          value: num(subproject.intakeDuration.value)!,
          unit: subproject.intakeDuration.unit || 'days',
          ...(num(subproject.intakeDuration.buffer) != null
            ? { buffer: num(subproject.intakeDuration.buffer)! }
            : {}),
        }
      : null,
    warrantyPeriod: subproject.warrantyPeriod && num(subproject.warrantyPeriod.value) != null
      ? {
          value: num(subproject.warrantyPeriod.value)!,
          unit: subproject.warrantyPeriod.unit || 'months',
        }
      : null,
  };
};

const fileNameFromUrl = (url: unknown): string | null => {
  if (typeof url !== 'string' || !url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '') || null;
  } catch {
    return null;
  }
};

const attachmentUrlList = async (
  urls: unknown,
  owners: Array<string | null>,
  source: AttachmentDto['source'],
  roots?: readonly string[],
): Promise<AttachmentDto[]> => {
  if (!Array.isArray(urls)) return [];
  const result: AttachmentDto[] = [];
  for (const url of urls) {
    const presigned = await presignOwnedUrl(url, owners, roots);
    result.push({
      url: presigned.url,
      fileName: fileNameFromUrl(url),
      source,
      signed: presigned.signed,
      ...(presigned.unavailableReason ? { unavailableReason: presigned.unavailableReason } : {}),
    });
  }
  return result;
};

const sharedAttachmentList = async (
  urls: unknown,
  owners: Array<string | null>,
  source: AttachmentDto['source'],
): Promise<AttachmentDto[]> => {
  if (!Array.isArray(urls)) return [];
  const result: AttachmentDto[] = [];
  for (const url of urls) {
    const key = typeof url === 'string' ? parseS3KeyFromUrl(url) : null;
    const isProjectAsset = Boolean(
      key && (
        key.startsWith('projects/')
        || key.startsWith('project-attachments/')
        || key.startsWith('project-images/')
        || key.startsWith('project-videos/')
        || key.startsWith('cms/')
      ),
    );
    const presigned = isProjectAsset
      ? await presignSharedProjectUrl(url, 3600, [
          'projects/',
          'project-attachments/',
          'project-images/',
          'project-videos/',
          'cms/',
        ])
      : await presignOwnedUrl(url, owners, ['rfq-attachments', 'completion-attachments']);
    result.push({
      url: presigned.url,
      fileName: fileNameFromUrl(url),
      source,
      signed: presigned.signed,
      ...(presigned.unavailableReason ? { unavailableReason: presigned.unavailableReason } : {}),
    });
  }
  return result;
};

const normalizeQuestionType = (value: unknown): 'text' | 'multiple_choice' | 'attachment' => {
  if (value === 'attachment' || value === 'file') return 'attachment';
  if (value === 'multiple_choice' || value === 'dropdown' || value === 'checkbox') return 'multiple_choice';
  return 'text';
};

const isFileAnswer = (answer: any, definition?: any): boolean => {
  const answerFieldType = answer?.fieldType || answer?.type;
  const definitionType = definition?.type || definition?.fieldType;
  return (
    answerFieldType === 'file'
    || answerFieldType === 'attachment'
    || definitionType === 'file'
    || definitionType === 'attachment'
  );
};

const buildQuestionsWithAnswers = async (params: {
  definitions: any[];
  answers: any[];
  source: 'booking_snapshot' | 'live_project';
  owners: Array<string | null>;
  projectId?: string | null;
}): Promise<Array<RFQQuestionDto | PostBookingQuestionDto>> => {
  const result: Array<RFQQuestionDto | PostBookingQuestionDto> = [];
  for (const definition of params.definitions) {
    const questionId = definition.questionId || definition._id?.toString?.() || null;
    const answerEntry = params.answers.find((answer) =>
      (questionId && String(answer.questionId) === String(questionId))
      || (definition.question && String(answer.question) === String(definition.question)),
    );
    let answer = answerEntry?.answer != null ? String(answerEntry.answer) : null;
    if (answer != null && isFileAnswer(answerEntry, definition)) {
      const presigned = await presignQuestionAnswerUrl(
        answer,
        params.owners,
        params.projectId,
        ['rfq-attachments', 'dispute-attachments', 'completion-attachments'],
      );
      answer = presigned.url;
    }
    result.push({
      questionId,
      question: String(definition.question || answerEntry?.question || ''),
      type: normalizeQuestionType(definition.type || answerEntry?.fieldType),
      options: Array.isArray(definition.options) ? definition.options.map(String) : [],
      isRequired: Boolean(definition.isRequired),
      professionalAttachments: await sharedAttachmentList(
        definition.professionalAttachments,
        params.owners,
        'rfq',
      ),
      answer,
      answered: answer != null && answer !== '',
      source: params.source,
    });
  }
  return result;
};

const buildPostBookingQuestions = async (params: {
  definitions: any[];
  answers: any[];
  source: 'booking_snapshot' | 'post_booking_submission' | 'live_project';
  owners: Array<string | null>;
  projectId?: string | null;
}): Promise<PostBookingQuestionDto[]> => {
  const result: PostBookingQuestionDto[] = [];
  const matchedAnswerIndexes = new Set<number>();
  const findAnswerIndex = (definition: any) => {
    const questionId = definition.questionId || definition._id?.toString?.() || null;
    return params.answers.findIndex((answer) =>
      (questionId && String(answer.questionId) === String(questionId))
      || (definition.question && String(answer.question) === String(definition.question)),
    );
  };

  for (const definition of params.definitions) {
    const answerIndex = findAnswerIndex(definition);
    if (answerIndex >= 0) matchedAnswerIndexes.add(answerIndex);
    const answerEntry = answerIndex >= 0 ? params.answers[answerIndex] : null;
    let answer = answerEntry?.answer != null ? String(answerEntry.answer) : null;
    if (answer != null && isFileAnswer(answerEntry, definition)) {
      const presigned = await presignQuestionAnswerUrl(
        answer,
        params.owners,
        params.projectId,
        ['rfq-attachments', 'dispute-attachments', 'completion-attachments'],
      );
      answer = presigned.url;
    }
    result.push({
      questionId: definition.questionId || definition._id?.toString?.() || null,
      question: String(definition.question || answerEntry?.question || ''),
      type: normalizeQuestionType(definition.type || answerEntry?.fieldType),
      options: Array.isArray(definition.options) ? definition.options.map(String) : [],
      isRequired: Boolean(definition.isRequired),
      professionalAttachments: await sharedAttachmentList(
        definition.professionalAttachments,
        params.owners,
        'rfq',
      ),
      answer,
      answered: answer != null && answer !== '',
      source: params.source,
    });
  }

  // Preserve answers whose question definition no longer survives (legacy
  // project edits/deletions). The stored answer text/options are the only
  // recorded facts; label the provenance instead of inventing current wording.
  for (const [index, answerEntry] of params.answers.entries()) {
    if (matchedAnswerIndexes.has(index)) continue;
    const storedAnswer = answerEntry?.answer != null ? String(answerEntry.answer) : '';
    let answer: string | null = storedAnswer;
    if (storedAnswer && isFileAnswer(answerEntry, undefined)) {
      const presigned = await presignQuestionAnswerUrl(
        storedAnswer,
        params.owners,
        params.projectId,
        ['rfq-attachments', 'dispute-attachments', 'completion-attachments'],
      );
      answer = presigned.url;
    }
    result.push({
      questionId: answerEntry?.questionId ? String(answerEntry.questionId) : null,
      question: String(answerEntry?.question || '').trim() || 'Unknown question',
      type: normalizeQuestionType(answerEntry?.fieldType),
      options: Array.isArray(answerEntry?.options) ? answerEntry.options.map(String) : [],
      isRequired: false,
      professionalAttachments: [],
      answer,
      answered: answer != null && answer !== '',
      source: 'recorded_answer',
    });
  }

  return result;
};

const buildPayments = async (params: {
  booking: any;
  payments: any[];
  viewerRole: DetailsViewerRole;
  customerId: string;
  professionalId: string;
  adminAccess?: { payments: boolean };
}): Promise<PaymentsDetailsDto> => {
  const { booking, payments, viewerRole } = params;
  const canSeeAdminInternals = viewerRole === 'admin' && params.adminAccess?.payments === true;
  const notices: DetailsNotice[] = [];
  const quoteCurrency = booking.quote?.currency || booking.quoteVersions?.slice(-1)?.[0]?.currency;
  const fallbackPayment = booking.payment || null;
  const resolvedPaymentRows = resolvePaymentRows(booking, payments);
  const paymentRows = resolvedPaymentRows.map((row) => row.payment);

  const records: PaymentRecordDto[] = [];
  for (const payment of paymentRows) {
    const currency = str(payment.currency) || str(quoteCurrency) || 'EUR';
    const visiblePayment = viewerRole === 'admin'
      ? filterPaymentForAdminArea(payment, canSeeAdminInternals)
      : sanitizePaymentForViewer(payment, viewerRole);
    const invoice = await (async (): Promise<RoleInvoiceDto | null> => {
      const source = visiblePayment;
      if (!source || !(
        source.invoiceNumber || source.invoiceUrl || source.supplierInvoiceNumber
        || source.supplierInvoiceUrl || source.creditNoteNumber || source.creditNoteUrl
      )) return null;
      const presign = async (value: unknown) => {
        if (!value) return null;
        const signed = await presignSharedProjectUrl(value);
        return signed.url;
      };
      const history = Array.isArray(source.invoiceArtifactHistory)
        ? await Promise.all(source.invoiceArtifactHistory.map(async (entry: any) => ({
            ...entry,
            invoiceUrl: await presign(entry.invoiceUrl),
            invoiceUblUrl: await presign(entry.invoiceUblUrl),
          })))
        : [];
      const invoice: RoleInvoiceDto = {
        invoiceNumber: str(source.invoiceNumber),
        invoiceUrl: await presign(source.invoiceUrl),
        invoiceUblUrl: await presign(source.invoiceUblUrl),
        invoiceGeneratedAt: iso(source.invoiceGeneratedAt),
        creditNoteNumber: str(source.creditNoteNumber),
        creditNoteUrl: await presign(source.creditNoteUrl),
        creditNoteUblUrl: await presign(source.creditNoteUblUrl),
        creditNoteGeneratedAt: iso(source.creditNoteGeneratedAt),
        creditNoteRelatedInvoiceNumber: str(source.creditNoteRelatedInvoiceNumber),
        peppolDispatchStatus: str(source.peppolDispatchStatus),
        peppolDispatchReference: str(source.peppolDispatchReference),
        peppolDispatchedAt: iso(source.peppolDispatchedAt),
        supplierInvoiceNumber: str(source.supplierInvoiceNumber),
        supplierInvoiceUrl: await presign(source.supplierInvoiceUrl),
        supplierInvoiceUblUrl: await presign(source.supplierInvoiceUblUrl),
        supplierInvoiceGeneratedAt: iso(source.supplierInvoiceGeneratedAt),
        supplierCreditNoteNumber: str(source.supplierCreditNoteNumber),
        supplierCreditNoteUrl: await presign(source.supplierCreditNoteUrl),
        supplierCreditNoteUblUrl: await presign(source.supplierCreditNoteUblUrl),
        supplierCreditNoteGeneratedAt: iso(source.supplierCreditNoteGeneratedAt),
        supplierCreditNoteRelatedInvoiceNumber: str(source.supplierCreditNoteRelatedInvoiceNumber),
        supplierPeppolDispatchStatus: str(source.supplierPeppolDispatchStatus),
        supplierPeppolDispatchReference: str(source.supplierPeppolDispatchReference),
        supplierPeppolDispatchedAt: iso(source.supplierPeppolDispatchedAt),
        invoiceArtifactHistory: history,
        ...(Array.isArray(source.manualArtifactClaims)
          ? {
              manualArtifactClaims: source.manualArtifactClaims.map((claim: any) => ({
                ...claim,
                createdAt: iso(claim.createdAt),
              })),
            }
          : {}),
      };
      // The wire DTO for a participant is their own side only. Admin keeps
      // both sides. Omitting (rather than emitting null) keeps the exact
      // role-scoped payload shape and prevents the opposite party's document
      // identifiers from crossing the boundary.
      if (viewerRole === 'customer') {
        for (const key of SUPPLIER_INVOICE_KEYS) delete (invoice as any)[key];
      } else if (viewerRole === 'professional') {
        for (const key of CUSTOMER_INVOICE_KEYS) delete (invoice as any)[key];
      }
      return invoice;
    })();

    const discount = payment.discount
      ? {
          loyaltyTier: str(payment.discount.loyaltyTier),
          loyaltyPercentage: num(payment.discount.loyaltyPercentage) ?? 0,
          loyaltyAmount: num(payment.discount.loyaltyAmount) ?? 0,
          repeatBuyerPercentage: num(payment.discount.repeatBuyerPercentage) ?? 0,
          repeatBuyerAmount: num(payment.discount.repeatBuyerAmount) ?? 0,
          pointsRedeemed: num(payment.discount.pointsRedeemed) ?? 0,
          pointsDiscountAmount: num(payment.discount.pointsDiscountAmount) ?? 0,
          codeDiscountAmount: num(payment.discount.codeDiscountAmount) ?? 0,
          codeLabel: str(payment.discount.codeLabel),
          totalDiscount: num(payment.discount.totalDiscount) ?? 0,
          originalAmount: num(payment.discount.originalAmount) ?? 0,
        }
      : null;

    const timestamps = {
      authorizedAt: iso(payment.authorizedAt),
      capturedAt: iso(payment.capturedAt),
      paidAt: iso(payment.paidAt),
      transferredAt: iso(payment.transferredAt),
      refundedAt: iso(payment.refundedAt),
      failedAt: iso(payment.failedAt),
      canceledAt: iso(payment.canceledAt),
      disputeOpenedAt: iso(payment.disputeOpenedAt),
    };
    const baseTransferFallback = num(payment.milestoneIndex) == null
      && (
        payment.__fallback
        || !str(booking.payment?.stripePaymentIntentId)
        || str(payment.stripePaymentIntentId) === str(booking.payment?.stripePaymentIntentId)
      )
      ? booking.payment
      : null;
    const transferStatus = payment.transferStatus || baseTransferFallback?.transferStatus || null;
    const transferId = payment.stripeTransferId || baseTransferFallback?.stripeTransferId || null;
    const transferAmount = num(payment.transferAmount) ?? num(baseTransferFallback?.transferAmount);
    const transferCurrency = str(payment.transferCurrency)
      || str(baseTransferFallback?.transferCurrency)
      || currency;
    const transferAttemptedAt = iso(payment.transferAttemptedAt)
      || iso(baseTransferFallback?.transferAttemptedAt);
    const transfer = transferStatus || transferId || transferAmount != null
      ? {
          status: transferStatus,
          currency: transferCurrency,
          amount: transferAmount,
          attemptedAt: transferAttemptedAt,
        }
      : null;

    records.push({
      paymentId: payment._id ? String(payment._id) : null,
      kind: num(payment.milestoneIndex) != null ? 'milestone' : 'booking',
      status: str(payment.status),
      method: payment.method || null,
      currency,
      currencySource: payment.currency ? 'payment' : quoteCurrency ? 'quote' : 'not_recorded',
      amount: num(payment.netAmount) ?? num(payment.amount),
      netAmount: num(payment.netAmount),
      vatAmount: num(payment.vatAmount),
      vatRate: num(payment.vatRate),
      totalWithVat: num(payment.totalWithVat),
      reverseCharge: bool(payment.reverseCharge),
      vatBreakdown: Array.isArray(payment.vatBreakdown)
        ? payment.vatBreakdown.map((line: any) => ({
            description: String(line.description || ''),
            netAmount: num(line.netAmount) ?? 0,
            vatRate: num(line.vatRate) ?? 0,
            vatAmount: num(line.vatAmount) ?? 0,
            totalAmount: num(line.totalAmount) ?? 0,
            vatCountry: str(line.vatCountry),
            vatLabel: str(line.vatLabel),
          }))
        : [],
      platformCommission: num(payment.platformCommission),
      professionalPayout: num(payment.professionalPayout),
      stripeFeeAmount: num(payment.stripeFeeAmount),
      originalCurrency: str(payment.originalCurrency),
      fxRate: num(payment.fxRate),
      fxProvider: payment.fxProvider || null,
      discount,
      timestamps,
      transfer,
      invoice,
      ...(canSeeAdminInternals
        ? {
            providerIds: {
              paymentIntentId: str(payment.stripePaymentIntentId),
              chargeId: str(payment.stripeChargeId),
              transferId: str(payment.stripeTransferId),
            },
            diagnostics: {
              transferFailureReason: str(payment.transferFailureReason),
              extraCostTransferFailureReason: str(payment.extraCostTransferFailureReason),
              refundNotes: str(payment.refundNotes),
              peppolDispatchReason: str(payment.peppolDispatchReason),
              supplierPeppolDispatchReason: str(payment.supplierPeppolDispatchReason),
              creditNotePeppolDispatchReason: str(payment.creditNotePeppolDispatchReason),
              supplierCreditNotePeppolDispatchReason: str(payment.supplierCreditNotePeppolDispatchReason),
            },
          }
        : {}),
    });
    const record = records[records.length - 1];
    if (viewerRole === 'customer') {
      record.platformCommission = null;
      record.professionalPayout = null;
      record.stripeFeeAmount = null;
      record.transfer = null;
    }
  }

  // Prefer the real base payment row (provider intent or a recorded amount)
  // over a placeholder row that only exists to hold an extra-cost refund.
  const baseIndex = resolvedPaymentRows.findIndex((row) => {
    const payment = row.payment || {};
    return num(payment.milestoneIndex) == null
      && (
        row.isFallback
        || Boolean(str(payment.stripePaymentIntentId))
        || (num(payment.totalWithVat) ?? 0) > 0
        || (num(payment.amount) ?? 0) > 0
      );
  });
  const base = (baseIndex >= 0 ? records[baseIndex] : null)
    || records.find((record) => record.kind === 'booking')
    || records.find((record) => record.kind === 'legacy_unknown')
    || records[0]
    || null;

  const milestones = (Array.isArray(booking.milestonePayments) ? booking.milestonePayments : []).map(
    (milestone: any, index: number) => {
      const matching = paymentRows.find((payment) => num(payment.milestoneIndex) === index);
      return {
        index,
        title: String(milestone.title || ''),
        amount: num(milestone.amount) ?? 0,
        currency: str(matching?.currency) || str(booking.payment?.currency) || str(quoteCurrency),
        status: milestone.status || 'pending',
        workStatus: milestone.workStatus || 'pending',
        dueCondition: milestone.dueCondition || 'on_start',
        customDueDate: iso(milestone.customDueDate),
        startedAt: iso(milestone.startedAt),
        completedAt: iso(milestone.completedAt),
        paidAt: iso(milestone.paidAt),
        customerChargeTotalWithVat: num(matching?.totalWithVat),
        paymentRowPresent: Boolean(matching),
      };
    },
  );
  if (milestones.some((milestone: any) => !milestone.paymentRowPresent)) {
    notices.push(notice('MILESTONE_PAYMENT_ROW_MISSING', 'warning', 'payment'));
  }

  const extraCostSource = fallbackPayment?.extraCostStatus || fallbackPayment?.extraCostAmount != null
    ? fallbackPayment
    : paymentRows.find((payment) => payment.extraCostStatus || payment.extraCostAmount != null);
  const extraCostRecordedCurrency = str(extraCostSource?.currency);
  const extraCostQuoteCurrency = extraCostRecordedCurrency ? null : str(quoteCurrency);
  const extraCostCurrencySource: 'payment' | 'quote' | 'not_recorded' =
    extraCostRecordedCurrency ? 'payment' : extraCostQuoteCurrency ? 'quote' : 'not_recorded';
  const extraCost: ExtraCostPaymentDto | null = extraCostSource
    ? {
        status: extraCostSource.extraCostStatus || null,
        currency: extraCostRecordedCurrency || extraCostQuoteCurrency || null,
        currencySource: extraCostCurrencySource,
        customerNetChargeAmount: num(extraCostSource.extraCostCustomerNetAmount),
        vatAmount: num(extraCostSource.extraCostVatAmount),
        vatRate: num(extraCostSource.vatRate),
        customerChargeAmount: num(extraCostSource.extraCostAmount),
        customerDiscount: num(extraCostSource.extraCostCustomerDiscount),
        loyaltyTier: str(extraCostSource.extraCostLoyaltyTier),
        loyaltyPercentage: num(extraCostSource.extraCostLoyaltyPercentage),
        platformCommission: num(extraCostSource.extraCostPlatformCommission) ?? num(extraCostSource.extraCostPlatformFee),
        professionalPayout: num(extraCostSource.extraCostProfessionalPayout),
        professionalNetAmount: num(extraCostSource.extraCostNetAmount),
        paidAt: iso(extraCostSource.extraCostPaidAt),
        failedAt: iso(extraCostSource.extraCostFailedAt),
        stripeFeeAmount: num(extraCostSource.stripeFeeAmount),
        transferStatus: extraCostSource.extraCostTransferStatus || null,
        completeBreakdownRecorded:
          num(extraCostSource.extraCostAmount) != null
          && (num(extraCostSource.extraCostCustomerNetAmount) != null || num(extraCostSource.extraCostVatAmount) != null),
      }
    : null;
  if (extraCost && viewerRole === 'customer') {
    extraCost.platformCommission = null;
    extraCost.professionalPayout = null;
    extraCost.professionalNetAmount = null;
    extraCost.stripeFeeAmount = null;
    extraCost.transferStatus = null;
  }
  if (!extraCost && num(booking.extraCostTotal) != null && booking.extraCostTotal !== 0) {
    notices.push(notice('EXTRA_COST_PAYMENT_NOT_RECORDED', 'warning', 'payment'));
  }

  const refundFacts = resolveRefundFacts({
    booking,
    paymentRows: resolvedPaymentRows,
    quoteCurrency,
  });
  const refunds: RefundDto[] = refundFacts.map((fact) => {
    const refundRef = refundFactReference(fact);
    return {
      id: fact.cancellationRequestId
        ? `cancellation:${fact.cancellationRequestId}:refund`
        : `payment:${fact.paymentId || 'booking'}:refund:${refundRef}`,
      amount: fact.amount,
      currency: fact.currency || 'EUR',
      currencySource: fact.currencySource,
      refundedAt: fact.refundedAt,
      source: fact.source,
      status: fact.status,
      justification: fact.justification,
      justificationRecorded: fact.justificationRecorded,
      vatAmount: fact.vatAmount,
      netAmount: fact.netAmount,
      vatRate: fact.vatRate,
      vatSplitRecorded: fact.vatSplitRecorded,
      kind: fact.kind,
      ...(canSeeAdminInternals
        ? { internalNotes: fact.internalNotes, providerRefundId: fact.providerRefundId }
        : {}),
      cancellationRequestId: fact.cancellationRequestId,
      noticeCodes: fact.noticeCodes,
    };
  });
  if (refunds.some((refund) => !refund.vatSplitRecorded)) {
    notices.push(notice('REFUND_VAT_SPLIT_NOT_RECORDED', 'info', 'refund'));
  }

  const byCurrencyMap = new Map<string, { charged: number; refunded: number; complete: boolean }>();
  const seenRecords = new Set<string>();
  for (const payment of paymentRows) {
    const fingerprint = `${payment.stripePaymentIntentId || ''}:${payment.milestoneIndex ?? 'base'}:${payment._id || 'fallback'}`;
    if (seenRecords.has(fingerprint)) continue;
    seenRecords.add(fingerprint);
    const currency = str(payment.currency) || str(quoteCurrency);
    if (!currency) {
      notices.push(notice('PAYMENT_CURRENCY_NOT_RECORDED', 'warning', 'payment'));
      continue;
    }
    if (!byCurrencyMap.has(currency)) byCurrencyMap.set(currency, { charged: 0, refunded: 0, complete: true });
    const bucket = byCurrencyMap.get(currency)!;
    const chargeable = ['authorized', 'completed', 'partially_refunded', 'refunded', 'disputed'].includes(String(payment.status));
    if (chargeable) {
      const total = num(payment.totalWithVat);
      if (total == null) {
        bucket.complete = false;
      } else {
        bucket.charged += total;
      }
    }
  }
  for (const refund of refunds) {
    if (refund.kind !== 'booking') continue;
    if (!byCurrencyMap.has(refund.currency)) byCurrencyMap.set(refund.currency, { charged: 0, refunded: 0, complete: true });
    byCurrencyMap.get(refund.currency)!.refunded += refund.amount;
  }
  const byCurrency = [...byCurrencyMap.entries()].map(([currency, bucket]) => ({
    currency,
    recordedCharged: roundMoney(bucket.charged),
    recordedRefunded: roundMoney(bucket.refunded),
    recordedNet: roundMoney(bucket.charged - bucket.refunded),
    derivedFromRecords: true as const,
    complete: bucket.complete,
  }));

  const checkout = mapCheckoutSnapshot(booking.checkoutSnapshot);
  if (!checkout && booking.checkoutSnapshot) {
    notices.push(notice('CHECKOUT_SNAPSHOT_INCOMPLETE', 'warning', 'booking_snapshot'));
  }
  if (!payments.length && !fallbackPayment) {
    notices.push(notice('PAYMENT_ROW_MISSING', 'warning', 'payment'));
  }

  return {
    records,
    base,
    milestones,
    extraCost,
    refunds,
    checkout,
    byCurrency,
    notices: uniqueNotices(notices),
  };
};

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export const buildBookingDetails = async (params: {
  booking: any;
  payments: any[];
  cancellations: any[];
  warrantyClaims: any[];
  actors: ActorMap;
  viewerRole: DetailsViewerRole;
  adminAccess?: { bookings?: boolean; disputes: boolean; warranty: boolean; cancellations: boolean; payments: boolean };
  quotationAlias?: boolean;
}): Promise<BookingDetailsDto> => {
  const { payments, cancellations, warrantyClaims, actors, viewerRole } = params;
  const rawProject = params.booking?.project && typeof params.booking.project === 'object'
    ? params.booking.project
    : null;
  const projectProfessionalId = referenceId(rawProject?.professionalId);
  const projectProfessionalActor = projectProfessionalId ? actors.get(projectProfessionalId) : undefined;
  const booking = maskBookingForAnonymizedParties(params.booking, {
    professional:
      isAnonymizedAccount(params.booking?.professional)
      || Boolean(projectProfessionalActor?.isAnonymized),
    ...(projectProfessionalId ? { professionalId: projectProfessionalId } : {}),
  });
  const isAdminViewer = viewerRole === 'admin';
  const maySeeAdminArea = (area: 'bookings' | 'disputes' | 'warranty' | 'cancellations' | 'payments') =>
    !isAdminViewer || params.adminAccess?.[area] === true;
  const customer = booking.customer && typeof booking.customer === 'object' ? booking.customer : null;
  const professional = booking.professional && typeof booking.professional === 'object' ? booking.professional : null;
  const project = booking.project && typeof booking.project === 'object' ? booking.project : null;
  const customerId = objectId(booking.customer);
  const professionalId = objectId(booking.professional || project?.professionalId);
  const customerMasked = isAnonymizedAccount(customer);
  const professionalMasked = isAnonymizedAccount(professional);
  const maskedCancellations = cancellations.map((request) =>
    maskCancellationRequestForAnonymizedParties(request, {
      customerId: customerId || undefined,
      professionalId: professionalId || undefined,
      customerAnonymized: customerMasked,
      professionalAnonymized: professionalMasked,
    }),
  );
  const maskedWarrantyClaims = warrantyClaims.map((claim) =>
    maskWarrantyClaimForAnonymizedParties(claim),
  );
  const projectId = referenceId(booking.project) || str((booking.bookingSnapshot as any)?.project?.id);
  const captured = booking.bookingSnapshot || null;
  const capturedAt = iso(captured?.capturedAt);
  const quoteCurrency = booking.quote?.currency || booking.quoteVersions?.slice(-1)?.[0]?.currency || null;
  const paymentCurrency = booking.payment?.currency || quoteCurrency || null;

  const snapshotNotices: DetailsNotice[] = [];
  if (!captured) {
    snapshotNotices.push(notice('BOOKING_SNAPSHOT_NOT_RECORDED', 'warning', 'booking_snapshot'));
    if (project) snapshotNotices.push(notice('LIVE_PROJECT_MAY_HAVE_CHANGED', 'info', 'booking_snapshot'));
  }
  const checkout = mapCheckoutSnapshot(captured?.checkoutSnapshot || booking.checkoutSnapshot);
  if (!checkout && (captured?.checkoutSnapshot || booking.checkoutSnapshot)) {
    snapshotNotices.push(notice('CHECKOUT_SNAPSHOT_INCOMPLETE', 'warning', 'booking_snapshot'));
  }

  const snapshotSubproject = mapSnapshotSubproject(captured?.selectedSubproject);
  const snapshotExtraOptions = Array.isArray(captured?.selectedExtraOptions)
    ? captured.selectedExtraOptions.map((option: any) => ({
        extraOptionId: String(option.extraOptionId ?? ''),
        name: String(option.name || ''),
        description: str(option.description),
        unitPrice: num(option.unitPrice) ?? 0,
        quantity: num(option.quantity) ?? 1,
        totalPrice: num(option.totalPrice) ?? num(option.bookedPrice) ?? 0,
        bookedPrice: num(option.bookedPrice) ?? num(option.totalPrice) ?? 0,
        priceSource: 'booking_snapshot' as const,
      }))
    : [];

  const selectedExtraOptionsForWizard = Array.isArray(booking.selectedExtraOptions)
    ? booking.selectedExtraOptions.map((selected: any) => {
        const option = Array.isArray(project?.extraOptions)
          ? project.extraOptions.find((candidate: any) =>
              String(candidate?._id) === String(selected.extraOptionId),
            )
          : null;
        const snapshotOption = snapshotExtraOptions.find((entry: any) => entry.extraOptionId === String(selected.extraOptionId));
        const checkoutOption = Array.isArray(booking.checkoutSnapshot?.selectedOptions)
          ? booking.checkoutSnapshot.selectedOptions.find(
              (entry: any) => String(entry?.extraOptionId) === String(selected.extraOptionId),
            )
          : null;
        return {
          extraOptionId: String(selected.extraOptionId),
          bookedPrice: num(selected.bookedPrice) ?? 0,
          name: snapshotOption?.name || str(option?.name),
          description: snapshotOption?.description || str(option?.description),
          unitPrice: snapshotOption?.unitPrice ?? num(option?.price),
          quantity: snapshotOption?.quantity ?? num(selected.quantity) ?? num(checkoutOption?.quantity) ?? 1,
          totalPrice: num(selected.bookedPrice) ?? 0,
          priceSource: snapshotOption ? ('booking_snapshot' as const) : ('booking_selection' as const),
        };
      })
    : [];

  const selectedSubprojectIndex = num(booking.selectedSubprojectIndex) ?? num(captured?.selectedSubprojectIndex);
  const rfqAnswers = Array.isArray(booking.rfqData?.answers) ? booking.rfqData.answers : [];
  const rfqDefinitions = Array.isArray(captured?.questions?.rfq) && captured.questions.rfq.length > 0
    ? captured.questions.rfq
    : Array.isArray(project?.rfqQuestions)
      ? project.rfqQuestions
      : [];
  const rfqQuestionSource = Array.isArray(captured?.questions?.rfq) && captured.questions.rfq.length > 0
    ? 'booking_snapshot'
    : 'live_project';
  const rfqQuestions = await buildQuestionsWithAnswers({
    definitions: rfqDefinitions,
    answers: rfqAnswers,
    source: rfqQuestionSource,
    owners: [customerId, professionalId],
    projectId,
  });

  const rfqAttachments: AttachmentDto[] = [];
  for (const url of Array.isArray(booking.rfqData?.attachments) ? booking.rfqData.attachments : []) {
    const result = await presignOwnedUrl(url, [customerId, professionalId], ['rfq-attachments', 'dispute-attachments']);
    rfqAttachments.push({
      url: result.url,
      fileName: fileNameFromUrl(url),
      source: 'rfq',
      signed: result.signed,
      ...(result.unavailableReason ? { unavailableReason: result.unavailableReason } : {}),
    });
  }

  const rfqAnswersForWizard: BookingWizardDto['rfq']['answers'] = [];
  for (const answer of rfqAnswers) {
    let value = String(answer.answer ?? '');
    const definition = rfqDefinitions.find((entry: any) =>
      (entry.questionId && answer.questionId && String(entry.questionId) === String(answer.questionId))
      || (entry._id && answer.questionId && String(entry._id) === String(answer.questionId))
      || (entry.question && String(entry.question) === String(answer.question)),
    );
    const file = isFileAnswer(answer, definition);
    if (file) {
      const presigned = await presignQuestionAnswerUrl(
        value,
        [customerId, professionalId],
        projectId,
        ['rfq-attachments', 'dispute-attachments'],
      );
      value = presigned.url || '';
    }
    rfqAnswersForWizard.push({
      questionId: answer.questionId ? String(answer.questionId) : null,
      question: String(answer.question || ''),
      answer: value,
      fieldType: answer.fieldType || definition?.type || null,
      answerType: file ? 'file' : 'text',
      source: 'booking',
    });
  }

  const capturedPostBookingDefinitions =
    Array.isArray(captured?.questions?.postBooking) && captured.questions.postBooking.length > 0
      ? captured.questions.postBooking
      : [];
  const submittedPostBookingDefinitions =
    Array.isArray(booking.postBookingQuestionSnapshot?.questions)
      && booking.postBookingQuestionSnapshot.questions.length > 0
      ? booking.postBookingQuestionSnapshot.questions
      : [];
  const postBookingDefinitions = capturedPostBookingDefinitions.length > 0
    ? capturedPostBookingDefinitions
    : submittedPostBookingDefinitions.length > 0
      ? submittedPostBookingDefinitions
      : Array.isArray(project?.postBookingQuestions)
        ? project.postBookingQuestions
        : [];
  const postBookingSource: 'booking_snapshot' | 'post_booking_submission' | 'live_project' =
    capturedPostBookingDefinitions.length > 0
      ? 'booking_snapshot'
      : submittedPostBookingDefinitions.length > 0
        ? 'post_booking_submission'
        : 'live_project';
  const postBookingAnswers = Array.isArray(booking.postBookingData) ? booking.postBookingData : [];
  const postBookingQuestions = await buildPostBookingQuestions({
    definitions: postBookingDefinitions,
    answers: postBookingAnswers,
    source: postBookingSource,
    owners: [customerId, professionalId],
    projectId,
  });

  const postBookingAnswersForDto: PostBookingDetailsDto['answers'] = [];
  for (const answer of postBookingAnswers) {
    const matchedQuestion = postBookingQuestions.find((question) =>
      (answer.questionId && question.questionId === String(answer.questionId))
      || question.question === String(answer.question),
    );
    let value = String(answer.answer ?? '');
    const file = isFileAnswer(answer, matchedQuestion);
    if (file) {
      const presigned = await presignQuestionAnswerUrl(
        value,
        [customerId, professionalId],
        projectId,
        ['rfq-attachments', 'dispute-attachments'],
      );
      value = presigned.url || '';
    }
    postBookingAnswersForDto.push({
      questionId: String(answer.questionId || ''),
      question: String(answer.question || ''),
      answer: value,
      answerType: file ? 'file' : 'text',
      fieldType: answer.fieldType || (matchedQuestion?.type === 'attachment' ? 'file' : matchedQuestion?.type || null),
    });
  }

  const vatQuestions = Array.isArray(captured?.questions?.vat) ? captured.questions.vat : [];
  const vatDecision = booking.vatDecision
    ? {
        action: booking.vatDecision.action,
        country: str(booking.vatDecision.country),
        standardRate: num(booking.vatDecision.standardRate),
        appliedRate: num(booking.vatDecision.appliedRate),
        reducedRate: num(booking.vatDecision.reducedRate),
        reverseCharge: bool(booking.vatDecision.reverseCharge),
        vatLabel: str(booking.vatDecision.vatLabel),
        propertyNature: booking.vatDecision.propertyNature || null,
        explanation: str(booking.vatDecision.explanation),
        answers: (Array.isArray(booking.vatDecision.answers) ? booking.vatDecision.answers : []).map((answer: any) => {
          const definition = vatQuestions.find((question: any) => question.fieldName === answer.fieldName);
          return {
            fieldName: String(answer.fieldName || ''),
            value: answer.value,
            question: definition?.question || null,
            type: definition?.type || null,
          };
        }),
      }
    : null;

  const customerBlocks = booking.customerBlocks
    ? {
        dates: (Array.isArray(booking.customerBlocks.dates) ? booking.customerBlocks.dates : []).map((date: any) => ({
          date: dateOnly(date.date) || '',
          reason: str(date.reason),
        })),
        windows: (Array.isArray(booking.customerBlocks.windows) ? booking.customerBlocks.windows : []).map((window: any) => ({
          date: dateOnly(window.date) || '',
          startTime: String(window.startTime || ''),
          endTime: String(window.endTime || ''),
          reason: str(window.reason),
        })),
      }
    : { dates: [], windows: [] };

  const wizard: BookingWizardDto = {
    rfq: {
      serviceType: str(booking.rfqData?.serviceType),
      description: str(booking.rfqData?.description),
      answers: rfqAnswersForWizard,
      preferredStartDate: dateOnly(booking.rfqData?.preferredStartDate),
      preferredStartTime: str(booking.rfqData?.preferredStartTime),
      urgency: booking.rfqData?.urgency || null,
      budget: booking.rfqData?.budget
        ? {
            min: num(booking.rfqData.budget.min),
            max: num(booking.rfqData.budget.max),
            currency: str(booking.rfqData.budget.currency),
          }
        : null,
      attachments: rfqAttachments,
      additionalNotes: str(booking.rfqData?.additionalNotes),
    },
    rfqQuestions: rfqQuestions as RFQQuestionDto[],
    selectedSubprojectIndex,
    selectedExtraOptions: selectedExtraOptionsForWizard.map((option: any) => ({
      extraOptionId: option.extraOptionId,
      bookedPrice: option.bookedPrice,
      name: option.name,
    })),
    estimatedUsage: {
      quantity: num(booking.checkoutSnapshot?.quantity) ?? num(captured?.checkoutSnapshot?.quantity),
      unit: str(booking.checkoutSnapshot?.unit) || str(captured?.checkoutSnapshot?.unit),
      source: booking.checkoutSnapshot?.quantity != null || captured?.checkoutSnapshot?.quantity != null ? 'checkout_snapshot' : 'not_recorded',
    },
    customerBlocks,
    vatDecision,
    serviceLocation: {
      address: str(booking.location?.address),
      city: str(booking.location?.city),
      country: str(booking.location?.country),
      postalCode: str(booking.location?.postalCode),
    },
    paymentAtCheckout: Boolean(
      booking.checkoutSnapshot
      && booking.quote
      && (!Array.isArray(booking.quoteVersions) || booking.quoteVersions.length === 0),
    ),
    scheduleSelection: {
      startDate: dateOnly(booking.scheduledStartDate),
      startTime: str(booking.scheduledStartTime),
      executionEndDate: dateOnly(booking.scheduledExecutionEndDate),
      bufferEndDate: dateOnly(booking.scheduledBufferEndDate),
      timeZone: isValidIanaTimeZone(booking.scheduleTimeZone) ? booking.scheduleTimeZone : null,
    },
  };

  const acceptedVersion = resolveAcceptedQuoteVersion(booking);
  const quotationVersions: QuotationVersionDto[] = [];
  // Rejection provenance is bound to the version that was actually rejected.
  // New writers store it on that version; legacy rows are matched to the
  // `quote_rejected` status entry written at that rejection. The single
  // booking-level `customerRejectionReason` is only usable for the latest
  // rejection entry when that entry itself has no reason text; it is never
  // copied onto an earlier version.
  const rejectionProvenanceByVersion = new Map<number, { at: string; reason: string | null }>();
  const rejectionEntries: Array<{ entry: any; at: number; versionNumber: number | null; reason: string | null }> = [];
  for (const entry of Array.isArray(booking.statusHistory) ? booking.statusHistory : []) {
    if (entry?.status !== 'quote_rejected' || !entry?.timestamp) continue;
    const at = new Date(entry.timestamp).getTime();
    if (Number.isNaN(at)) continue;
    const note = String(entry.note || '');
    const named = note.match(/\bv(\d+)\b/i);
    let versionNumber: number | null = null;
    if (named) {
      const candidate = Number(named[1]);
      if ((booking.quoteVersions || []).some((version: any) => Number(version.version) === candidate)) {
        versionNumber = candidate;
      }
    }
    if (versionNumber == null) {
      const createdBefore = (booking.quoteVersions || [])
        .filter((version: any) => version?.createdAt && new Date(version.createdAt).getTime() <= at)
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      if (createdBefore.length > 0) versionNumber = Number(createdBefore[0].version);
    }
    rejectionEntries.push({ entry, at, versionNumber, reason: rejectionReasonFromNote(note) });
  }
  for (const version of Array.isArray(booking.quoteVersions) ? booking.quoteVersions : []) {
    if (!version?.rejectedAt) continue;
    const at = iso(version.rejectedAt);
    if (!at) continue;
    rejectionProvenanceByVersion.set(Number(version.version), {
      at,
      reason: str(version.rejectionReason),
    });
  }
  for (const rejection of rejectionEntries) {
    if (rejection.versionNumber == null) continue;
    const existing = rejectionProvenanceByVersion.get(rejection.versionNumber);
    if (!existing) {
      rejectionProvenanceByVersion.set(rejection.versionNumber, {
        at: new Date(rejection.at).toISOString(),
        reason: rejection.reason,
      });
    } else if (!existing.reason && rejection.reason) {
      existing.reason = rejection.reason;
    }
  }
  const latestRejection = rejectionEntries[rejectionEntries.length - 1] || null;
  if (
    latestRejection?.versionNumber != null
    && !latestRejection.reason
    && str(booking.customerRejectionReason)
  ) {
    const current = rejectionProvenanceByVersion.get(latestRejection.versionNumber);
    if (current && !current.reason) {
      current.reason = str(booking.customerRejectionReason);
    }
  }
  for (const version of Array.isArray(booking.quoteVersions) ? booking.quoteVersions : []) {
    const createdAt = iso(version.createdAt);
    let actor = actorForId(version.createdBy, actors, viewerRole, { roleHint: 'professional' });
    if (!actor) {
      const matching = [...(booking.statusHistory || [])].reverse().find(
        (entry: any) =>
          entry?.status === 'quoted'
          && entry?.updatedBy
          && entry?.timestamp
          && createdAt
          && Math.abs(new Date(entry.timestamp).getTime() - new Date(createdAt).getTime()) <= 5000,
      );
      if (matching?.updatedBy) {
        actor = actorForId(matching.updatedBy, actors, viewerRole, { roleHint: 'professional' });
      }
    }
    const accepted = acceptedVersion?.version === Number(version.version);
    const rejection = rejectionProvenanceByVersion.get(Number(version.version)) || null;
    const rejectedAt = rejection?.at || null;
    const totals = version.customerTotals
      ? {
          commissionPercent: num(version.customerTotals.commissionPercent),
          professionalNetAmount: num(version.customerTotals.professionalNetAmount),
          customerNetAmount: num(version.customerTotals.customerNetAmount),
          amountBeforeDiscounts: num(version.customerTotals.amountBeforeDiscounts) ?? num(version.customerTotals.customerNetAmount),
          vatAmount: num(version.customerTotals.vatAmount),
          vatRate: num(version.customerTotals.vatRate),
          totalWithVat: num(version.customerTotals.totalWithVat),
          totalAmount: num(version.customerTotals.totalAmount) ?? num(version.customerTotals.totalWithVat),
          currency: version.customerTotals.currency || version.currency || 'EUR',
          recordedAt: iso(version.customerTotals.recordedAt) || createdAt || new Date().toISOString(),
          ...(version.customerTotals.discount ? { discount: version.customerTotals.discount } : {}),
        }
      : null;
    quotationVersions.push({
      version: Number(version.version),
      quotationNumber: version.quotationNumber,
      scope: String(version.scope || ''),
      warrantyDuration: version.warrantyDuration
        && num(version.warrantyDuration.value) != null
        && version.warrantyDuration.unit
        ? {
            value: num(version.warrantyDuration.value)!,
            unit: version.warrantyDuration.unit === 'years' ? 'years' as const : 'months' as const,
          }
        : null,
      materialsIncluded: typeof version.materialsIncluded === 'boolean'
        ? version.materialsIncluded
        : null,
      materials: Array.isArray(version.materials)
        ? version.materials.map((material: any) => ({
            name: String(material.name || ''),
            quantity: num(material.quantity),
            unit: str(material.unit),
            description: str(material.description),
          }))
        : [],
      description: String(version.description || ''),
      pricingLines: Array.isArray(version.pricingLines)
        ? version.pricingLines.map((line: any) => ({
            description: String(line.description || ''),
            price: num(line.price) ?? 0,
            vatRate: num(line.vatRate) ?? 0,
            vatCountry: str(line.vatCountry),
            vatLabel: str(line.vatLabel),
          }))
        : [],
      totalAmount: num(version.totalAmount),
      currency: str(version.currency),
      milestones: Array.isArray(version.milestones)
        ? version.milestones.map((milestone: any) => ({
            title: String(milestone.title || ''),
            amount: num(milestone.amount),
            description: str(milestone.description),
            dueCondition: milestone.dueCondition || 'on_start',
            customDueDate: iso(milestone.customDueDate),
            order: num(milestone.order) ?? 0,
            status: milestone.status || 'pending',
          }))
        : [],
      preparationDuration: version.preparationDuration
        && num(version.preparationDuration.value) != null
        && version.preparationDuration.unit
        ? { value: num(version.preparationDuration.value)!, unit: version.preparationDuration.unit }
        : null,
      executionDuration: version.executionDuration
        && num(version.executionDuration.value) != null
        && version.executionDuration.unit
        ? { value: num(version.executionDuration.value)!, unit: version.executionDuration.unit }
        : null,
      bufferDuration: version.bufferDuration
        && num(version.bufferDuration.value) != null
        && version.bufferDuration.unit
        ? { value: num(version.bufferDuration.value)!, unit: version.bufferDuration.unit }
        : null,
      validUntil: iso(version.validUntil),
      createdAt,
      changeNote: str(version.changeNote),
      serviceLocation: version.serviceLocation
        ? {
            country: str(version.serviceLocation.country),
            address: str(version.serviceLocation.address),
            city: str(version.serviceLocation.city),
            postalCode: str(version.serviceLocation.postalCode),
          }
        : null,
      serviceLocationRecorded: Boolean(version.serviceLocation),
      termsAndConditions: null,
      termsRecorded: false,
      createdBy: actor,
      actorRecorded: Boolean(version.createdBy) || isActorRecorded(actor),
      customerTotals: totals,
      customerTotalsRecorded: Boolean(version.customerTotals),
      accepted,
      acceptedAt: accepted ? iso(acceptedVersion?.acceptedAt) : null,
      rejectedAt: rejectedAt ? iso(rejectedAt) : null,
      rejectionReason: rejectedAt ? rejection?.reason || null : null,
    });
  }

  const currentVersionNumber = num(booking.currentQuoteVersion)
    ?? (quotationVersions.length > 0 ? quotationVersions[quotationVersions.length - 1].version : null);
  const currentVersion = quotationVersions.find((version) => version.version === currentVersionNumber)
    || quotationVersions[quotationVersions.length - 1]
    || null;
  const quotationNotices: DetailsNotice[] = [];
  if (quotationVersions.some((version) => !version.customerTotalsRecorded)) {
    quotationNotices.push(notice('QUOTE_CUSTOMER_TOTALS_NOT_RECORDED', 'info', 'quotation'));
  }
  if (quotationVersions.some((version) => !version.actorRecorded)) {
    quotationNotices.push(notice('QUOTE_ACTOR_NOT_RECORDED', 'info', 'quotation'));
  }
  if (quotationVersions.some((version) => !version.serviceLocationRecorded)) {
    quotationNotices.push(notice('QUOTE_SERVICE_LOCATION_NOT_RECORDED', 'info', 'quotation'));
  }
  if (acceptedVersion?.source === 'inferred_current') {
    quotationNotices.push(notice('ACCEPTED_VERSION_INFERRED', 'warning', 'quotation'));
  }

  const hasLegacyQuote = Boolean(
    booking.quote
    && (
      num(booking.quote.amount) != null
      || str(booking.quote.description)
      || booking.quote.submittedAt
    ),
  );
  const hasQuoteData = quotationVersions.length > 0
    || hasLegacyQuote
    || Boolean(booking.quotationNumber);
  const hasRfqLifecycle = Boolean(booking.rfqResponse)
    || ['rfq', 'rfq_accepted'].includes(String(booking.status));
  const acceptedBookingStatuses = [
    'quote_accepted',
    'payment_pending',
    'booked',
    'rescheduling_requested',
    'in_progress',
    'professional_completed',
    'completed',
    'dispute',
    'refunded',
  ];
  const quotationStatus = (() => {
    // Direct quotations start in draft_quote without a number or version. That
    // is a real draft, not "no quotation".
    if (booking.status === 'draft_quote') return 'draft';
    if (booking.status === 'quote_rejected') return 'rejected';
    // A later cancellation/refund must not erase the last recorded quotation
    // decision. Only a later submission/edit can clear a rejection.
    const lastQuotationLifecycle = [...(Array.isArray(booking.statusHistory) ? booking.statusHistory : [])]
      .reverse()
      .find((entry: any) =>
        ['quoted', 'draft_quote', 'quote_accepted', 'quote_rejected'].includes(String(entry?.status)),
      );
    const latestVersionRejected = Boolean(currentVersion?.rejectedAt) && !acceptedVersion;
    if (!acceptedVersion && (lastQuotationLifecycle?.status === 'quote_rejected' || latestVersionRejected)) {
      return 'rejected';
    }
    if (hasQuoteData) {
      if (acceptedVersion || acceptedBookingStatuses.includes(String(booking.status))) return 'accepted';
      return 'quoted';
    }
    // An RFQ can be rejected or accepted before any quotation version exists.
    if (booking.rfqResponse?.action === 'rejected') return 'rejected';
    return 'none';
  })();

  const quotation: QuotationDetailsDto | null = quotationStatus === 'none' && !hasRfqLifecycle
    ? null
    : {
        quotationNumber: str(booking.quotationNumber),
        status: quotationStatus,
        currentVersion: currentVersionNumber,
        acceptedVersion: acceptedVersion
          ? {
              version: acceptedVersion.version,
              quotationNumber: acceptedVersion.quotationNumber,
              source: acceptedVersion.source,
              acceptedAt: iso(acceptedVersion.acceptedAt),
            }
          : null,
        currency: currentVersion?.currency || quoteCurrency,
        totalAmountProfessional: currentVersion?.totalAmount ?? num(booking.quote?.amount),
        versions: quotationVersions,
        history: [],
        rfqHistory: [],
        notices: uniqueNotices(quotationNotices),
      };

  const paymentsDto = await buildPayments({
    booking,
    payments,
    viewerRole,
    customerId,
    professionalId,
    adminAccess: params.adminAccess ? { payments: params.adminAccess.payments } : undefined,
  });

  const extraCostPayment = paymentsDto.extraCost;
  const extraCostItems = (Array.isArray(booking.extraCosts) ? booking.extraCosts : []).map((item: any) => ({
    type: item.type || 'other',
    name: String(item.name || ''),
    justification: String(item.justification || ''),
    professionalAmount: num(item.amount) ?? 0,
    unitPrice: num(item.unitPrice),
    estimatedUnits: num(item.estimatedUnits),
    actualUnits: num(item.actualUnits),
    referenceIndex: num(item.referenceIndex),
    customerCharge: null,
  }));
  const extraCostNotices: DetailsNotice[] = [];
  if (num(booking.extraCostTotal) != null && booking.extraCostTotal !== 0 && !extraCostPayment) {
    extraCostNotices.push(notice('EXTRA_COST_PAYMENT_NOT_RECORDED', 'warning', 'payment'));
  }
  const baseIntent = str(booking.payment?.stripePaymentIntentId);
  const refundPaymentRows = resolvePaymentRows(booking, params.payments).map((row) => row.payment);
  const extraCostRefundSettled = refundPaymentRows.some((payment: any) => {
    if (num(payment.milestoneIndex) != null) return false;
    const paymentIntent = str(payment.stripePaymentIntentId);
    if (baseIntent && paymentIntent && paymentIntent !== baseIntent) return false;
    const refunds = Array.isArray(payment.refunds) ? payment.refunds : [];
    return refunds.some((refund: any) =>
      refund?.kind === 'extra_cost'
      && refundCountsAsCash(refund)
      && (refund.status == null || refund.status === 'succeeded'));
  });
  if (
    num(booking.extraCostTotal) != null
    && booking.extraCostTotal < 0
    && !extraCostRefundSettled
  ) {
    // A pending provider refund is reserved cash, not a settled refund yet.
    // Keep the existing localizable warning until the refund succeeds.
    extraCostNotices.push(notice('REFUND_BREAKDOWN_INCOMPLETE', 'warning', 'refund'));
  }
  const extraCosts: ExtraCostsDetailsDto = {
    status: booking.extraCostStatus || null,
    totalProfessionalAmount: num(booking.extraCostTotal),
    currency: paymentCurrency,
    currencySource: booking.payment?.currency ? 'payment' : quoteCurrency ? 'quote' : 'not_recorded',
    items: extraCostItems,
    payment: extraCostPayment,
    confirmation: booking.completionAttestation
      ? {
          confirmedAt: iso(booking.completionAttestation.confirmedAt),
          confirmedBy: actorForId(booking.completionAttestation.confirmedBy, actors, viewerRole, {
            roleHint: 'professional',
          }),
          notes: str(booking.completionAttestation.notes),
          attachments: await attachmentUrlList(
            booking.completionAttestation.attachments,
            [customerId, professionalId],
            'completion',
            ['completion-attachments'],
          ),
        }
      : null,
    dispute: booking.dispute
      && booking.dispute.type === 'extra_costs'
      && maySeeAdminArea('disputes')
      ? {
          raisedAt: iso(booking.dispute.raisedAt),
          raisedBy: actorForId(booking.dispute.raisedBy, actors, viewerRole, { roleHint: 'customer' }),
          type: booking.dispute.type || null,
          status: booking.dispute.resolvedAt ? 'resolved' : 'open',
          reason: str(booking.dispute.reason),
          description: str(booking.dispute.description),
        }
      : null,
    notices: uniqueNotices(extraCostNotices),
  };

  const postBookingNotices: DetailsNotice[] = [];
  if (postBookingAnswers.length > 0 && !booking.postBookingSubmittedAt) {
    postBookingNotices.push(notice('POST_BOOKING_TIMESTAMP_NOT_RECORDED', 'info', 'post_booking'));
  }
  const postBooking: PostBookingDetailsDto = {
    questions: postBookingQuestions as PostBookingQuestionDto[],
    answers: postBookingAnswersForDto,
    submittedAt: iso(booking.postBookingSubmittedAt),
    submittedBy: actorForId(booking.postBookingSubmittedBy, actors, viewerRole, { roleHint: 'customer' }),
    timestampRecorded: Boolean(booking.postBookingSubmittedAt),
    complete:
      postBookingQuestions.length > 0
      && postBookingQuestions.every((question) => question.answered),
    notices: uniqueNotices(postBookingNotices),
  };

  const timeZone = isValidIanaTimeZone(booking.scheduleTimeZone)
    ? booking.scheduleTimeZone
    : isValidIanaTimeZone(captured?.schedule?.timeZone)
      ? captured.schedule.timeZone
      : null;
  const scheduleNotices: DetailsNotice[] = [];
  if (!timeZone) scheduleNotices.push(notice('SCHEDULE_TIMEZONE_NOT_RECORDED', 'info', 'schedule'));

  const reschedules: RescheduleHistoryDto[] = [];
  const historyEntries = Array.isArray(booking.rescheduleHistory) ? [...booking.rescheduleHistory] : [];
  if (booking.rescheduleRequest?.requestedAt) {
    const already = historyEntries.some(
      (entry: any) => String(entry.requestedAt) === String(booking.rescheduleRequest.requestedAt)
        && entry.reason === booking.rescheduleRequest.reason,
    );
    if (!already) historyEntries.push({ ...booking.rescheduleRequest, status: 'pending' });
  }
  for (const [index, entry] of historyEntries.entries()) {
    const requestedBy = actorForId(entry.requestedBy, actors, viewerRole, {
      roleHint: entry.requestedBy === customerId ? 'customer' : 'professional',
    });
    const respondedBy = actorForId(entry.respondedBy, actors, viewerRole, { roleHint: 'customer' });
    reschedules.push({
      id: `reschedule:${index}:${iso(entry.requestedAt) || ''}`,
      requestedAt: iso(entry.requestedAt) || '',
      requestedBy,
      actorRecorded: isActorRecorded(requestedBy),
      reason: String(entry.reason || ''),
      description: str(entry.description),
      note: str(entry.note),
      status: entry.status || 'pending',
      respondedAt: iso(entry.respondedAt),
      respondedBy,
      responseNote: str(entry.responseNote),
      previousSchedule: mapScheduleSnapshot(entry.previousSchedule),
      proposedSchedule: mapScheduleSnapshot(entry.proposedSchedule),
      timeZone,
      timeZoneRecorded: Boolean(timeZone),
    });
  }

  const cancellationDtos: CancellationRequestDto[] = [];
  const visibleCancellations = maySeeAdminArea('cancellations') ? maskedCancellations : [];
  for (const [index, request] of visibleCancellations.entries()) {
    const evidence = await attachmentUrlList(
      request.evidence,
      [request.requestedBy, customerId, professionalId],
      'cancellation',
      ['dispute-attachments', 'rfq-attachments', 'completion-attachments'],
    );
    cancellationDtos.push({
      id: String(request._id || `cancellation:${index}`),
      status: request.status,
      reasonCategory: str(request.reasonCategory),
      reason: String(request.reason || ''),
      adminResolutionNote: str(request.adminResolutionNote),
      evidence,
      requestedBy: actorForId(request.requestedBy, actors, viewerRole, {
        roleHint: request.requestedRole === 'professional' ? 'professional' : 'customer',
      }),
      requestedRole: request.requestedRole,
      createdAt: iso(request.createdAt) || '',
      responseDeadline: iso(request.responseDeadline),
      professionalDecision: request.professionalDecision || null,
      professionalNote: str(request.professionalNote),
      counterOfferAmount: num(request.counterOfferAmount),
      professionalRespondedAt: iso(request.professionalRespondedAt),
      customerDecision: request.customerDecision || null,
      customerRespondedAt: iso(request.customerRespondedAt),
      escalatedAt: iso(request.escalatedAt),
      escalationReason: request.escalationReason || null,
      resolvedAt: iso(request.resolvedAt),
      resolvedBy: actorForId(request.resolvedBy, actors, viewerRole, { roleHint: 'admin' }),
      denyReason: str(request.denyReason),
      refundAmount: num(request.refundAmount),
      refundedAt: iso(request.refundedAt),
      currency: paymentCurrency,
      currencyRecorded: Boolean(paymentCurrency),
    });
  }

  const visibleWarrantyClaims = maySeeAdminArea('warranty') ? maskedWarrantyClaims : [];
  const warrantyDtos: WarrantyClaimSummaryDto[] = visibleWarrantyClaims.map((claim) => ({
    id: String(claim._id),
    claimNumber: str(claim.claimNumber),
    status: claim.status,
    reason: String(claim.reason || ''),
    openedAt: iso(claim.openedAt) || '',
    proposal: claim.proposal
      ? {
          proposedAt: iso(claim.proposal.proposedAt),
          customerDecision: claim.proposal.customerDecision || null,
          decidedAt: iso(claim.proposal.decidedAt),
        }
      : null,
    escalatedAt: iso(claim.escalation?.escalatedAt),
    resolvedAt: iso(claim.resolution?.resolvedAt),
    closedAt: iso(claim.resolution?.autoClosedAt)
      || iso((claim.statusHistory || []).slice().reverse().find((entry: any) => entry.status === 'closed')?.timestamp),
    linkHint: viewerRole === 'admin' ? 'admin_warranty' : 'participant_warranty',
  }));

  const activity = await buildBookingActivity({
    booking,
    payments,
    cancellations: visibleCancellations,
    warrantyClaims: visibleWarrantyClaims,
    actors,
    viewerRole,
    customerId,
    professionalId,
    adminAccess: params.adminAccess,
  });

  if (quotation) {
    quotation.history = activity.items.filter((item) =>
      ['rfq', 'quotation'].includes(item.category),
    );
    quotation.rfqHistory = activity.items.filter((item) => ['rfq'].includes(item.category));
  }

  const snapshotProject = captured?.project || null;
  const projectTitle = snapshotProject?.title || str(project?.title);
  const overviewStatus = booking.status as string;
  const quoteDto: BookingOverviewDto['quote'] = quotation
    ? {
        quotationNumber: quotation.quotationNumber,
        currentVersion: quotation.currentVersion,
        acceptedVersion: quotation.acceptedVersion?.version ?? null,
        acceptedVersionSource: quotation.acceptedVersion?.source || 'not_recorded',
        status: quotation.status,
        totalAmount: quotation.totalAmountProfessional,
        currency: quotation.currency,
        validUntil: currentVersion?.validUntil || iso(booking.quote?.validUntil),
      }
    : null;
  const basePayment = paymentsDto.base;
  const overviewPaymentCurrency = str(booking.payment?.currency)
    || basePayment?.currency
    || paymentCurrency;
  const overviewRefundedTotal = paymentsDto.refunds
    .filter((refund) => refund.kind === 'booking')
    .filter((refund) => !overviewPaymentCurrency || refund.currency === overviewPaymentCurrency)
    .reduce((sum, refund) => sum + refund.amount, 0);
  const bookingOverview: BookingOverviewDto = {
    id: String(booking._id),
    bookingNumber: str(booking.bookingNumber),
    bookingType: booking.bookingType,
    status: overviewStatus,
    statusBeforeDispute: booking.statusBeforeDispute || null,
    title: projectTitle || str(booking.rfqData?.serviceType) || 'Booking',
    projectTitle,
    serviceType: str(booking.rfqData?.serviceType),
    category: snapshotProject?.category || str(project?.category),
    service: snapshotProject?.service || str(project?.service),
    createdAt: iso(booking.createdAt) || '',
    updatedAt: iso(booking.updatedAt) || '',
    schedule: {
      preferredStartDate: dateOnly(booking.rfqData?.preferredStartDate),
      preferredStartTime: str(booking.rfqData?.preferredStartTime),
      scheduledStartDate: dateOnly(booking.scheduledStartDate),
      scheduledExecutionEndDate: dateOnly(booking.scheduledExecutionEndDate),
      scheduledBufferStartDate: dateOnly(booking.scheduledBufferStartDate),
      scheduledBufferEndDate: dateOnly(booking.scheduledBufferEndDate),
      scheduledStartTime: str(booking.scheduledStartTime),
      scheduledEndTime: str(booking.scheduledEndTime),
      actualStartDate: dateOnly(booking.actualStartDate),
      actualEndDate: dateOnly(booking.actualEndDate),
      timeZone,
      timeZoneRecorded: Boolean(timeZone),
      reschedulePending: Boolean(booking.rescheduleRequest?.status === 'pending'),
    },
    location: {
      address: str(booking.location?.address),
      city: str(booking.location?.city),
      country: str(booking.location?.country),
      postalCode: str(booking.location?.postalCode),
      coordinates: Array.isArray(booking.location?.coordinates) && booking.location.coordinates.length === 2
        ? [Number(booking.location.coordinates[0]), Number(booking.location.coordinates[1])]
        : null,
    },
    counterpart: viewerRole === 'customer'
      ? {
          role: 'professional',
          name: str(professional?.name) || str(professional?.username),
          companyName: str(professional?.businessInfo?.companyName),
          ...(isAnonymizedAccount(professional) ? { isAnonymized: true } : {}),
        }
      : {
          role: 'customer',
          name: str(customer?.name),
          companyName: str(customer?.businessName),
          ...(isAnonymizedAccount(customer) ? { isAnonymized: true } : {}),
        },
    quote: quoteDto,
    payment: booking.payment
      ? {
          status: str(booking.payment.status),
          totalWithVat: num(booking.payment.totalWithVat),
          netAmount: num(booking.payment.netAmount),
          vatAmount: num(booking.payment.vatAmount),
          currency: str(booking.payment.currency) || paymentCurrency,
          discountTotal: num(booking.payment.discount?.totalDiscount),
          refundedTotal: roundMoney(overviewRefundedTotal),
        }
      : basePayment
        ? {
            status: basePayment.status,
            totalWithVat: basePayment.totalWithVat,
            netAmount: basePayment.netAmount,
            vatAmount: basePayment.vatAmount,
            currency: basePayment.currency,
            discountTotal: basePayment.discount?.totalDiscount ?? null,
            refundedTotal: roundMoney(overviewRefundedTotal),
          }
        : null,
    extraCosts: num(booking.extraCostTotal) != null
      ? {
          total: num(booking.extraCostTotal),
          currency: paymentCurrency,
          currencySource: booking.payment?.currency ? 'payment' : quoteCurrency ? 'quote' : 'not_recorded',
          status: booking.extraCostStatus || null,
        }
      : null,
    warranty: booking.warrantyCoverage
      ? {
          duration: booking.warrantyCoverage.duration?.value != null
            ? {
                value: Number(booking.warrantyCoverage.duration.value),
                unit: booking.warrantyCoverage.duration.unit || 'months',
              }
            : null,
          startsAt: iso(booking.warrantyCoverage.startsAt),
          endsAt: iso(booking.warrantyCoverage.endsAt),
          source: booking.warrantyCoverage.source || null,
        }
      : null,
    flags: {
      bookingSnapshotRecorded: Boolean(captured),
      legacy: false,
      quoteVersionsPresent: quotationVersions.length > 0,
    },
  };

  const partyNotices: DetailsNotice[] = [notice('PARTY_PROFILE_IS_CURRENT', 'info', 'party')];
  const customerEmailVisible = viewerRole === 'customer' || viewerRole === 'professional' || viewerRole === 'admin';
  const customerPhoneVisible = viewerRole === 'customer' || viewerRole === 'professional' || viewerRole === 'admin';
  const professionalContactVisible = viewerRole === 'admin';
  const recordedCustomer = captured?.parties?.customer || null;
  const recordedProfessional = captured?.parties?.professional || null;
  const customerAnonymized = isAnonymizedAccount(customer);
  const professionalAnonymized = isAnonymizedAccount(professional);
  const parties: PartiesDto = {
    customer: {
      id: customerId,
      name: customerAnonymized ? '[deleted user]' : str(recordedCustomer?.displayName) || str(customer?.name),
      username: customerAnonymized ? null : str(customer?.username),
      customerType: customerAnonymized
        ? null
        : recordedCustomer?.customerType === 'business' || recordedCustomer?.customerType === 'individual'
          ? recordedCustomer.customerType
          : customer?.customerType || null,
      businessName: customerAnonymized
        ? null
        : str(recordedCustomer?.businessName) || str(customer?.businessName),
      email: customerAnonymized ? null : customerEmailVisible ? str(customer?.email) : null,
      phone: customerAnonymized ? null : customerPhoneVisible ? str(customer?.phone) : null,
      vatNumber: customerAnonymized ? null : viewerRole === 'admin' ? str(customer?.vatNumber) : null,
      address: customerAnonymized
        ? customer?.location
          ? { city: null, country: str(customer.location.country), postalCode: null }
          : null
        : customer?.location
          ? {
              city: str(recordedCustomer?.city) || str(customer.location.city),
              country: str(recordedCustomer?.country) || str(customer.location.country),
              postalCode: str(customer.location.postalCode),
            }
          : null,
      timeZone: customerAnonymized
        ? null
        : isValidIanaTimeZone(customer?.timeZone) ? customer.timeZone : null,
      ...(customerAnonymized ? { isAnonymized: true } : {}),
    },
    professional: {
      id: professionalId,
      name: professionalAnonymized
        ? '[deleted user]'
        : str(recordedProfessional?.displayName) || str(professional?.name),
      username: professionalAnonymized ? null : str(professional?.username),
      companyName: professionalAnonymized
        ? null
        : str(recordedProfessional?.companyName) || str(professional?.businessInfo?.companyName),
      email: professionalAnonymized
        ? null
        : professionalContactVisible ? str(professional?.email) : null,
      phone: professionalAnonymized
        ? null
        : professionalContactVisible ? str(professional?.phone) : null,
      vatNumber: professionalAnonymized
        ? null
        : professionalContactVisible ? str(professional?.vatNumber) : null,
      website: professionalAnonymized ? null : str(professional?.businessInfo?.website),
      address: professionalAnonymized
        ? professional?.businessInfo
          ? { city: null, country: str(professional.businessInfo.country), postalCode: null }
          : null
        : professional?.businessInfo
          ? {
              city: str(recordedProfessional?.city) || str(professional.businessInfo.city),
              country: str(recordedProfessional?.country) || str(professional.businessInfo.country),
              postalCode: str(professional.businessInfo.postalCode),
            }
          : null,
      timeZone: professionalAnonymized
        ? null
        : isValidIanaTimeZone(recordedProfessional?.timezone)
          ? recordedProfessional.timezone
          : isValidIanaTimeZone(professional?.businessInfo?.timezone)
            ? professional.businessInfo.timezone
            : isValidIanaTimeZone(professional?.timeZone)
              ? professional.timeZone
              : null,
      ...(professionalAnonymized ? { isAnonymized: true } : {}),
    },
    recordedAt: capturedAt,
    source: captured?.parties ? 'booking_snapshot' : 'current_profile',
    notices: partyNotices,
  };

  const snapshotComplete = Boolean(captured) && isBookingSnapshotComplete(captured);
  const bookingSnapshot: BookingSnapshotDto = {
    authority: captured
      ? (hasQuoteData || quotationStatus === 'accepted' ? 'quotation' : 'booking_snapshot')
      : hasQuoteData
        ? 'quotation'
        : project
          ? 'current_project_reference'
          : 'none',
    capturedAt,
    capturedBySource: captured?.source || null,
    immutable: snapshotComplete,
    project: captured?.project
      ? {
          id: str(captured.project.id),
          title: str(captured.project.title),
          category: str(captured.project.category),
          service: str(captured.project.service),
          areaOfWork: str(captured.project.areaOfWork),
          description: str(captured.project.description),
          termsConditions: Array.isArray(captured.project.termsConditions)
            ? captured.project.termsConditions.map((term: any) => ({
                name: String(term.name || ''),
                description: String(term.description || ''),
                type: term.type === 'warning' ? 'warning' : 'condition',
                additionalCost: num(term.additionalCost),
                isCustom: Boolean(term.isCustom),
              }))
            : [],
          customConfirmationMessage: str(captured.project.customConfirmationMessage),
          minResources: num(captured.project.minResources),
          minOverlapPercentage: num(captured.project.minOverlapPercentage),
          resourcesCount: num(captured.project.resourcesCount),
        }
      : null,
    questions: {
      rfq: rfqQuestions as RFQQuestionDto[],
      // Only the questions actually captured at booking belong under the
      // immutable bookingSnapshot; submission-time/live definitions live in
      // the postBooking section with their own source label.
      postBooking: postBookingQuestions.filter(
        (question) => question.source === 'booking_snapshot',
      ) as PostBookingQuestionDto[],
      vat: vatQuestions.map((question: any) => {
        const recordedAnswer = (Array.isArray(booking.vatDecision?.answers) ? booking.vatDecision.answers : [])
          .find((answer: any) => String(answer?.fieldName || '') === String(question.fieldName || ''));
        return {
          fieldName: String(question.fieldName || ''),
          question: str(question.question),
          type: str(question.type),
          answer: recordedAnswer ? recordedAnswer.value : null,
        };
      }),
    },
    schedule: {
      preferredStartDate: dateOnly(captured?.schedule?.preferredStartDate),
      preferredStartTime: str(captured?.schedule?.preferredStartTime),
      scheduledStartDate: dateOnly(captured?.schedule?.scheduledStartDate),
      scheduledStartTime: str(captured?.schedule?.scheduledStartTime),
      scheduledExecutionEndDate: dateOnly(captured?.schedule?.scheduledExecutionEndDate),
      scheduledBufferStartDate: dateOnly(captured?.schedule?.scheduledBufferStartDate),
      scheduledBufferEndDate: dateOnly(captured?.schedule?.scheduledBufferEndDate),
      timeZone: isValidIanaTimeZone(captured?.schedule?.timeZone) ? captured.schedule.timeZone : null,
      timeZoneRecorded: isValidIanaTimeZone(captured?.schedule?.timeZone),
    },
    location: captured?.location
      ? {
          address: str(captured.location.address),
          city: str(captured.location.city),
          postalCode: str(captured.location.postalCode),
          country: str(captured.location.country),
          coordinates: Array.isArray(captured.location.coordinates) && captured.location.coordinates.length === 2
            ? [Number(captured.location.coordinates[0]), Number(captured.location.coordinates[1])]
            : null,
        }
      : null,
    selectedSubprojectIndex: num(captured?.selectedSubprojectIndex) ?? selectedSubprojectIndex,
    selectedSubproject: snapshotSubproject,
    selectedExtraOptions: snapshotExtraOptions,
    checkoutSnapshot: checkout,
    currentProjectReference: project && !captured
      ? {
          source: 'live_project',
          mayHaveChangedSinceBooking: true,
          project: {
            id: objectId(project._id || project.id),
            title: String(project.title || ''),
            category: str(project.category),
            service: str(project.service),
          },
        }
      : null,
    notices: uniqueNotices(snapshotNotices),
  };

  const links = {
    self: `/api/bookings/${booking._id}`,
    details: `/api/bookings/${booking._id}/details`,
    activity: `/api/bookings/${booking._id}/activity`,
    booking: `/bookings/${booking._id}`,
    quotationNumber: str(booking.quotationNumber),
    claimNumbers: warrantyDtos.map((claim) => claim.claimNumber).filter((value): value is string => Boolean(value)),
    cancellationRequestIds: cancellationDtos.map((request) => request.id),
  };

  const adminLinks: AdminLinksDto | undefined = viewerRole === 'admin'
    ? {
        booking: `/admin/bookings/${booking._id}`,
        ...(params.adminAccess?.disputes ? { disputes: `/admin/disputes` } : {}),
        ...(params.adminAccess?.warranty ? { warrantyClaims: `/admin/warranty-claims` } : {}),
        ...(params.adminAccess?.cancellations
          ? { cancellationRequests: `/admin/cancellation-requests` }
          : {}),
        ...(params.adminAccess?.payments ? { payments: `/admin/payments` } : {}),
      }
    : undefined;

  const internal: BookingInternalDto | undefined = isAdminViewer && maySeeAdminArea('bookings')
    ? {
        notes: str(booking.notes),
        diagnostics: maySeeAdminArea('payments')
          ? { payment: paymentsDto.records.find((record) => record.diagnostics)?.diagnostics }
          : {},
        auditRef: { bookingId: String(booking._id) },
      }
    : undefined;

  const allNotices = uniqueNotices([
    ...snapshotNotices,
    ...partyNotices,
    ...quotationNotices,
    ...paymentsDto.notices,
    ...extraCostNotices,
    ...postBookingNotices,
    ...scheduleNotices,
  ]);

  const legacy =
    !captured
    || (captured && !snapshotComplete)
    || (quotationVersions.length > 0
      && quotationVersions.some((version) => !version.customerTotalsRecorded || !version.actorRecorded))
    || (postBookingAnswers.length > 0 && !booking.postBookingSubmittedAt);

  bookingOverview.flags.legacy = legacy;

  const dataQuality = {
    bookingSnapshotRecorded: Boolean(captured),
    bookingSnapshotCapturedAt: capturedAt,
    quoteCustomerTotalsRecorded:
      quotationVersions.length === 0 || quotationVersions.every((version) => version.customerTotalsRecorded),
    quoteActorRecorded:
      quotationVersions.length === 0 || quotationVersions.every((version) => version.actorRecorded),
    quoteServiceLocationRecorded:
      quotationVersions.length === 0 || quotationVersions.every((version) => version.serviceLocationRecorded),
    extraCostCustomerChargeRecorded:
      (num(booking.extraCostTotal) ?? 0) === 0 || Boolean(extraCostPayment?.customerChargeAmount != null),
    refundVatRecorded: paymentsDto.refunds.every((refund) => refund.vatSplitRecorded),
    activityActorRecorded: activity.dataQuality.actorMissingEvents === 0,
    activityComplete: activity.complete,
  };

  const details: BookingDetailsDto = {
    viewerRole,
    booking: bookingOverview,
    parties,
    bookingSnapshot,
    wizard,
    quotation,
    payments: paymentsDto,
    extraCosts,
    postBooking,
    reschedules,
    cancellations: cancellationDtos,
    warrantyClaims: warrantyDtos,
    activity,
    links,
    ...(adminLinks ? { adminLinks } : {}),
    ...(internal ? { internal } : {}),
    meta: {
      generatedAt: new Date().toISOString(),
      currencyPolicy: 'record_currency_only_no_conversion',
      timeZonePolicy: 'iso_utc_read_only_no_server_localization',
      legacy,
      notices: allNotices,
      counts: {
        versions: quotationVersions.length,
        activity: activity.items.length,
        refunds: paymentsDto.refunds.length,
        warrantyClaims: warrantyDtos.length,
      },
      dataQuality,
    },
  };
  return details;
};

export { mapCheckoutSnapshot, mapScheduleSnapshot, iso, dateOnly, num, str };
