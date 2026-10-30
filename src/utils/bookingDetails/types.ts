export type DetailsViewerRole = 'customer' | 'professional' | 'admin';

export type DetailsNotice = {
  code: string;
  severity: 'info' | 'warning';
  entity?: 'booking_snapshot' | 'quotation' | 'payment' | 'refund' | 'schedule' | 'post_booking' | 'party' | 'activity' | 'attachment';
};

export type ActorDto = {
  id?: string | null;
  role: 'customer' | 'professional' | 'admin' | 'system' | 'unknown';
  name: string | null;
  email?: string | null;
  isAnonymized?: boolean;
  source: 'recorded' | 'inferred_route' | 'system_job' | 'provider_webhook' | 'not_recorded';
};

export type AttachmentDto = {
  url: string | null;
  fileName: string | null;
  mimeType?: string | null;
  size?: number | null;
  source: 'rfq' | 'post_booking' | 'completion' | 'cancellation' | 'dispute' | 'resolution' | 'warranty';
  signed: boolean;
  unavailableReason?: string;
};

export type ScheduleSnapshotDto = {
  scheduledStartDate: string | null;
  scheduledExecutionEndDate: string | null;
  scheduledBufferStartDate: string | null;
  scheduledBufferEndDate: string | null;
  scheduledBufferUnit: 'hours' | 'days' | null;
  scheduledStartTime: string | null;
  scheduledEndTime: string | null;
  assignedTeamMembers?: Array<{ id: string; name?: string }>;
  timeZone?: string | null;
};

export type InvitationRange = { min: number; max: number };

export type RFQQuestionDto = {
  questionId: string | null;
  question: string;
  type: 'text' | 'multiple_choice' | 'attachment';
  options: string[];
  isRequired: boolean;
  professionalAttachments: AttachmentDto[];
  answer: string | null;
  answered: boolean;
  source: 'booking_snapshot' | 'live_project';
};

export type PostBookingQuestionDto = {
  questionId: string | null;
  question: string;
  type: 'text' | 'multiple_choice' | 'attachment';
  options: string[];
  isRequired: boolean;
  professionalAttachments: AttachmentDto[];
  answer: string | null;
  answered: boolean;
  /**
   * booking_snapshot: captured at booking creation;
   * post_booking_submission: definitions captured when answers were submitted
   * (the booking snapshot had no post-booking section);
   * live_project: current project definitions with no recorded snapshot;
   * recorded_answer: an answer whose question definition no longer survives.
   */
  source: 'booking_snapshot' | 'post_booking_submission' | 'live_project' | 'recorded_answer';
};

export type BookingOverviewDto = {
  id: string;
  bookingNumber: string | null;
  bookingType: 'professional' | 'project';
  status: string;
  statusBeforeDispute: string | null;
  title: string;
  projectTitle: string | null;
  serviceType: string | null;
  category: string | null;
  service: string | null;
  createdAt: string;
  updatedAt: string;
  schedule: {
    preferredStartDate: string | null;
    preferredStartTime: string | null;
    scheduledStartDate: string | null;
    scheduledExecutionEndDate: string | null;
    scheduledBufferStartDate: string | null;
    scheduledBufferEndDate: string | null;
    scheduledStartTime: string | null;
    scheduledEndTime: string | null;
    actualStartDate: string | null;
    actualEndDate: string | null;
    timeZone: string | null;
    timeZoneRecorded: boolean;
    reschedulePending: boolean;
  };
  location: {
    address: string | null;
    city: string | null;
    country: string | null;
    postalCode: string | null;
    coordinates: [number, number] | null;
  };
  counterpart: {
    role: 'customer' | 'professional';
    name: string | null;
    companyName: string | null;
    isAnonymized?: boolean;
  };
  quote: {
    quotationNumber: string | null;
    currentVersion: number | null;
    acceptedVersion: number | null;
    acceptedVersionSource: 'recorded' | 'inferred_current' | 'not_recorded';
    status: 'none' | 'draft' | 'quoted' | 'rejected' | 'accepted';
    totalAmount: number | null;
    currency: string | null;
    validUntil: string | null;
  } | null;
  payment: {
    status: string | null;
    totalWithVat: number | null;
    netAmount: number | null;
    vatAmount: number | null;
    currency: string | null;
    discountTotal: number | null;
    refundedTotal: number | null;
  } | null;
  extraCosts: {
    total: number | null;
    currency: string | null;
    currencySource: 'payment' | 'quote' | 'not_recorded';
    status: 'pending' | 'confirmed' | 'disputed' | null;
  } | null;
  warranty: {
    duration: { value: number; unit: 'months' | 'years' } | null;
    startsAt: string | null;
    endsAt: string | null;
    source: 'quote' | 'project_subproject' | null;
  } | null;
  flags: {
    bookingSnapshotRecorded: boolean;
    legacy: boolean;
    quoteVersionsPresent: boolean;
  };
};

export type PartiesDto = {
  customer: {
    id: string;
    name: string | null;
    username: string | null;
    customerType: 'individual' | 'business' | null;
    businessName: string | null;
    email: string | null;
    phone: string | null;
    vatNumber: string | null;
    address: { city: string | null; country: string | null; postalCode: string | null } | null;
    timeZone: string | null;
    isAnonymized?: boolean;
  };
  professional: {
    id: string;
    name: string | null;
    username: string | null;
    companyName: string | null;
    email: string | null;
    phone: string | null;
    vatNumber: string | null;
    website: string | null;
    address: { city: string | null; country: string | null; postalCode: string | null } | null;
    timeZone: string | null;
    isAnonymized?: boolean;
  };
  recordedAt: string | null;
  source: 'booking_snapshot' | 'current_profile';
  notices: DetailsNotice[];
};

export type BookingSnapshotDto = {
  authority: 'booking_snapshot' | 'quotation' | 'current_project_reference' | 'none';
  capturedAt: string | null;
  capturedBySource: 'booking_creation' | 'schedule_selection' | 'direct_quotation_creation' | null;
  immutable: boolean;
  project: {
    id: string | null;
    title: string | null;
    category: string | null;
    service: string | null;
    areaOfWork: string | null;
    description: string | null;
    termsConditions: Array<{
      name: string;
      description: string;
      type: 'condition' | 'warning';
      additionalCost: number | null;
      isCustom: boolean;
    }>;
    customConfirmationMessage: string | null;
    minResources: number | null;
    minOverlapPercentage: number | null;
    resourcesCount: number | null;
  } | null;
  questions: {
    rfq: RFQQuestionDto[];
    postBooking: PostBookingQuestionDto[];
    vat: Array<{ fieldName: string; question: string | null; type: string | null; answer: unknown }>;
  };
  schedule: {
    preferredStartDate: string | null;
    preferredStartTime: string | null;
    scheduledStartDate: string | null;
    scheduledStartTime: string | null;
    scheduledEndTime: string | null;
    scheduledExecutionEndDate: string | null;
    scheduledBufferStartDate: string | null;
    scheduledBufferEndDate: string | null;
    timeZone: string | null;
    timeZoneRecorded: boolean;
  };
  location: {
    address: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    coordinates: [number, number] | null;
  } | null;
  selectedSubprojectIndex: number | null;
  selectedSubproject: {
    name: string;
    description: string;
    projectType: string[];
    customProjectType: string | null;
    pricing: {
      type: 'fixed' | 'unit' | 'rfq' | null;
      amount: number | null;
      priceRange: InvitationRange | null;
      minOrderQuantity: number | null;
      unit: string | null;
    };
    included: Array<{ name: string; description: string | null; isCustom: boolean }>;
    materialsIncluded: boolean;
    materials: Array<{ name: string; quantity: string | null; unit: string | null; description: string | null }>;
    preparationDuration: { value: number; unit: 'hours' | 'days' } | null;
    executionDuration: { value: number; unit: 'hours' | 'days'; range?: InvitationRange } | null;
    buffer: { value: number; unit: 'hours' | 'days' } | null;
    intakeDuration: { value: number; unit: 'hours' | 'days'; buffer?: number } | null;
    warrantyPeriod: { value: number; unit: 'months' | 'years' } | null;
  } | null;
  selectedExtraOptions: Array<{
    extraOptionId: string;
    name: string;
    description: string | null;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
    bookedPrice: number;
    priceSource: 'booking_snapshot' | 'booking_selection';
  }>;
  checkoutSnapshot: CheckoutSnapshotDto | null;
  currentProjectReference?: {
    source: 'live_project';
    mayHaveChangedSinceBooking: true;
    project: { id: string; title: string; category: string | null; service: string | null };
  } | null;
  notices: DetailsNotice[];
};

export type CheckoutSnapshotDto = {
  pricingType: 'fixed' | 'unit';
  unitAmount: number;
  quantity: number;
  unit: string | null;
  baseSubtotal: number;
  extraOptionsTotal: number;
  totalAmount: number;
  currency: string;
  selectedOptions: Array<{
    extraOptionId: string | null;
    name: string;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
  }>;
  complete: boolean;
};

export type BookingWizardDto = {
  rfq: {
    serviceType: string | null;
    description: string | null;
    answers: Array<{
      questionId: string | null;
      question: string;
      answer: string;
      fieldType: 'text' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file' | null;
      answerType: 'text' | 'file' | 'unknown';
      source: 'booking' | 'live_project_question';
    }>;
    preferredStartDate: string | null;
    preferredStartTime: string | null;
    urgency: 'low' | 'medium' | 'high' | 'urgent' | null;
    budget: { min: number | null; max: number | null; currency: string | null } | null;
    attachments: AttachmentDto[];
    additionalNotes: string | null;
  };
  rfqQuestions: RFQQuestionDto[];
  selectedSubprojectIndex: number | null;
  selectedExtraOptions: Array<{ extraOptionId: string; bookedPrice: number; name: string | null }>;
  estimatedUsage: { quantity: number | null; unit: string | null; source: 'checkout_snapshot' | 'not_recorded' };
  customerBlocks: {
    dates: Array<{ date: string; reason: string | null }>;
    windows: Array<{ date: string; startTime: string; endTime: string; reason: string | null }>;
  };
  vatDecision: {
    action: 'standard_rate' | 'reduced_rate' | 'rfq';
    country: string | null;
    standardRate: number | null;
    appliedRate: number | null;
    reducedRate: number | null;
    reverseCharge: boolean | null;
    vatLabel: string | null;
    propertyNature: 'movable' | 'immovable' | null;
    explanation: string | null;
    answers: Array<{ fieldName: string; value: unknown; question?: string | null; type?: string | null }>;
  } | null;
  serviceLocation: {
    address: string | null;
    city: string | null;
    country: string | null;
    postalCode: string | null;
  };
  paymentAtCheckout: boolean;
  scheduleSelection: {
    startDate: string | null;
    startTime: string | null;
    endTime: string | null;
    executionEndDate: string | null;
    bufferEndDate: string | null;
    timeZone: string | null;
  };
};

export type QuotationVersionDto = {
  version: number;
  quotationNumber: string;
  scope: string;
  warrantyDuration: { value: number; unit: 'months' | 'years' } | null;
  materialsIncluded: boolean | null;
  materials: Array<{ name: string; quantity: number | null; unit: string | null; description: string | null }>;
  description: string;
  pricingLines: Array<{
    description: string;
    price: number;
    vatRate: number;
    vatCountry: string | null;
    vatLabel: string | null;
  }>;
  totalAmount: number | null;
  currency: string | null;
  milestones: Array<{
    title: string;
    amount: number | null;
    description: string | null;
    dueCondition: 'on_start' | 'on_milestone_start' | 'on_milestone_completion' | 'custom_date';
    customDueDate: string | null;
    order: number;
    status: 'pending' | 'invoiced' | 'paid' | 'overdue';
  }>;
  preparationDuration: { value: number; unit: 'hours' | 'days' } | null;
  executionDuration: { value: number; unit: 'hours' | 'days' } | null;
  bufferDuration: { value: number; unit: 'hours' | 'days' } | null;
  validUntil: string | null;
  createdAt: string | null;
  changeNote: string | null;
  serviceLocation: {
    country: string | null;
    address: string | null;
    city: string | null;
    postalCode: string | null;
  } | null;
  serviceLocationRecorded: boolean;
  termsAndConditions: string | null;
  termsRecorded: boolean;
  createdBy: ActorDto | null;
  actorRecorded: boolean;
  customerTotals: {
    commissionPercent: number | null;
    professionalNetAmount: number | null;
    customerNetAmount: number | null;
    amountBeforeDiscounts: number | null;
    vatAmount: number | null;
    vatRate: number | null;
    totalWithVat: number | null;
    totalAmount: number | null;
    currency: string;
    recordedAt: string;
    discount?: Record<string, unknown>;
  } | null;
  customerTotalsRecorded: boolean;
  accepted: boolean;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
};

export type QuotationDetailsDto = {
  quotationNumber: string | null;
  status: 'none' | 'draft' | 'quoted' | 'rejected' | 'accepted';
  currentVersion: number | null;
  acceptedVersion: {
    version: number;
    quotationNumber: string;
    source: 'recorded' | 'inferred_current' | 'not_recorded';
    acceptedAt: string | null;
  } | null;
  currency: string | null;
  totalAmountProfessional: number | null;
  versions: QuotationVersionDto[];
  history: ActivityItem[];
  rfqHistory: ActivityItem[];
  notices: DetailsNotice[];
};

export type VatBreakdownLineDto = {
  description: string;
  netAmount: number;
  vatRate: number;
  vatAmount: number;
  totalAmount: number;
  vatCountry?: string | null;
  vatLabel?: string | null;
};

export type RoleInvoiceDto = {
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  invoiceUblUrl: string | null;
  invoiceGeneratedAt: string | null;
  creditNoteNumber: string | null;
  creditNoteUrl: string | null;
  creditNoteUblUrl: string | null;
  creditNoteGeneratedAt: string | null;
  creditNoteRelatedInvoiceNumber: string | null;
  peppolDispatchStatus: string | null;
  peppolDispatchReference: string | null;
  peppolDispatchedAt: string | null;
  supplierInvoiceNumber: string | null;
  supplierInvoiceUrl: string | null;
  supplierInvoiceUblUrl: string | null;
  supplierInvoiceGeneratedAt: string | null;
  supplierCreditNoteNumber: string | null;
  supplierCreditNoteUrl: string | null;
  supplierCreditNoteUblUrl: string | null;
  supplierCreditNoteGeneratedAt: string | null;
  supplierCreditNoteRelatedInvoiceNumber: string | null;
  supplierPeppolDispatchStatus: string | null;
  supplierPeppolDispatchReference: string | null;
  supplierPeppolDispatchedAt: string | null;
  invoiceArtifactHistory: Array<Record<string, unknown>>;
  manualArtifactClaims?: Array<Record<string, unknown>>;
};

export type PaymentRecordDto = {
  paymentId: string | null;
  kind: 'booking' | 'milestone' | 'legacy_unknown';
  status: string | null;
  method: 'card' | 'bank_transfer' | 'cash' | null;
  currency: string;
  currencySource: 'payment' | 'quote' | 'not_recorded';
  amount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  vatRate: number | null;
  totalWithVat: number | null;
  reverseCharge: boolean | null;
  vatBreakdown: VatBreakdownLineDto[];
  platformCommission: number | null;
  professionalPayout: number | null;
  stripeFeeAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
  fxProvider: 'stripe' | 'fixera' | null;
  discount: {
    loyaltyTier: string | null;
    loyaltyPercentage: number;
    loyaltyAmount: number;
    repeatBuyerPercentage: number;
    repeatBuyerAmount: number;
    pointsRedeemed: number;
    pointsDiscountAmount: number;
    codeDiscountAmount: number;
    codeLabel: string | null;
    totalDiscount: number;
    originalAmount: number;
  } | null;
  timestamps: {
    authorizedAt: string | null;
    capturedAt: string | null;
    paidAt: string | null;
    transferredAt: string | null;
    refundedAt: string | null;
    failedAt: string | null;
    canceledAt: string | null;
    disputeOpenedAt: string | null;
  };
  transfer: {
    status: 'pending' | 'succeeded' | 'failed' | null;
    currency: string | null;
    amount: number | null;
    attemptedAt: string | null;
  } | null;
  invoice: RoleInvoiceDto | null;
  providerIds?: {
    paymentIntentId: string | null;
    chargeId: string | null;
    transferId: string | null;
  };
  diagnostics?: {
    transferFailureReason: string | null;
    extraCostTransferFailureReason: string | null;
    refundNotes: string | null;
    peppolDispatchReason: string | null;
    supplierPeppolDispatchReason: string | null;
    creditNotePeppolDispatchReason: string | null;
    supplierCreditNotePeppolDispatchReason: string | null;
  };
};

export type MilestonePaymentDto = {
  index: number;
  title: string;
  amount: number;
  currency: string | null;
  status: 'pending' | 'invoiced' | 'paid' | 'overdue';
  workStatus: 'pending' | 'in_progress' | 'completed';
  dueCondition: string;
  customDueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  paidAt: string | null;
  customerChargeTotalWithVat: number | null;
  paymentRowPresent: boolean;
  /**
   * Client bug list #19b: expected customer charge for this milestone from the
   * shared charge plan (recorded commission, selected options in full on the
   * first milestone). Null when no commission was recorded for the booking.
   * The frontend's milestone/option UI must render this instead of splitting
   * options proportionally across milestones.
   */
  expectedCustomerCharge: number | null;
  includesSelectedOptions: boolean;
};

export type RefundDto = {
  id: string;
  amount: number;
  currency: string;
  currencySource: 'payment' | 'quote' | 'cancellation_request' | 'not_recorded';
  refundedAt: string | null;
  source: 'professional' | 'platform' | 'mixed' | null;
  status: 'recorded' | 'requested' | 'approved' | 'denied' | 'aggregate_only' | 'unknown';
  justification: string | null;
  justificationRecorded: boolean;
  vatAmount: number | null;
  netAmount: number | null;
  vatRate: number | null;
  vatSplitRecorded: boolean;
  kind: 'booking' | 'extra_cost';
  internalNotes?: string | null;
  providerRefundId?: string | null;
  cancellationRequestId: string | null;
  noticeCodes: string[];
};

export type ExtraCostPaymentDto = {
  status: 'pending' | 'succeeded' | 'failed' | 'refunded' | null;
  currency: string | null;
  currencySource: 'payment' | 'quote' | 'not_recorded';
  customerNetChargeAmount: number | null;
  vatAmount: number | null;
  vatRate: number | null;
  customerChargeAmount: number | null;
  customerDiscount: number | null;
  loyaltyTier: string | null;
  loyaltyPercentage: number | null;
  platformCommission: number | null;
  professionalPayout: number | null;
  professionalNetAmount: number | null;
  paidAt: string | null;
  failedAt: string | null;
  stripeFeeAmount: number | null;
  transferStatus: 'pending' | 'succeeded' | 'failed' | null;
  completeBreakdownRecorded: boolean;
};

export type PaymentsDetailsDto = {
  records: PaymentRecordDto[];
  base: PaymentRecordDto | null;
  milestones: MilestonePaymentDto[];
  extraCost: ExtraCostPaymentDto | null;
  refunds: RefundDto[];
  checkout: CheckoutSnapshotDto | null;
  byCurrency: Array<{
    currency: string;
    recordedCharged: number;
    recordedRefunded: number;
    recordedNet: number;
    derivedFromRecords: true;
    complete: boolean;
  }>;
  notices: DetailsNotice[];
};

export type ExtraCostsDetailsDto = {
  status: 'pending' | 'confirmed' | 'disputed' | null;
  totalProfessionalAmount: number | null;
  currency: string | null;
  currencySource: 'payment' | 'quote' | 'not_recorded';
  items: Array<{
    type: 'unit_adjustment' | 'condition' | 'option' | 'other';
    name: string;
    justification: string;
    professionalAmount: number;
    unitPrice: number | null;
    estimatedUnits: number | null;
    actualUnits: number | null;
    referenceIndex: number | null;
    customerCharge: {
      amount: number;
      vatAmount: number | null;
      discount: number | null;
      totalAmount: number;
      currency: string;
      recorded: true;
    } | null;
  }>;
  payment: ExtraCostPaymentDto | null;
  confirmation: {
    confirmedAt: string | null;
    confirmedBy: ActorDto | null;
    notes: string | null;
    attachments: AttachmentDto[];
  } | null;
  dispute: {
    raisedAt: string | null;
    raisedBy: ActorDto | null;
    type: string | null;
    status: 'open' | 'resolved' | null;
    reason: string | null;
    description: string | null;
  } | null;
  notices: DetailsNotice[];
};

export type PostBookingDetailsDto = {
  questions: PostBookingQuestionDto[];
  answers: Array<{
    questionId: string;
    question: string;
    answer: string;
    answerType: 'text' | 'file' | 'unknown';
    fieldType: string | null;
  }>;
  submittedAt: string | null;
  submittedBy: ActorDto | null;
  timestampRecorded: boolean;
  complete: boolean;
  notices: DetailsNotice[];
};

export type RescheduleHistoryDto = {
  id: string;
  requestedAt: string;
  requestedBy: ActorDto | null;
  actorRecorded: boolean;
  reason: string;
  description: string | null;
  note: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'disputed' | 'auto_cancelled';
  /** False once the request is disputed/terminal — the UI must disable accept/decline. */
  canRespond: boolean;
  respondedAt: string | null;
  respondedBy: ActorDto | null;
  responseNote: string | null;
  previousSchedule: ScheduleSnapshotDto | null;
  proposedSchedule: ScheduleSnapshotDto | null;
  timeZone: string | null;
  timeZoneRecorded: boolean;
};

export type CancellationRequestDto = {
  id: string;
  status: 'pending' | 'processing' | 'negotiating' | 'escalated' | 'approved' | 'denied';
  reasonCategory: string | null;
  reason: string;
  adminResolutionNote?: string | null;
  evidence: AttachmentDto[];
  requestedBy: ActorDto | null;
  requestedRole: 'customer' | 'professional';
  createdAt: string;
  responseDeadline: string | null;
  professionalDecision: 'approved' | 'counter' | 'rejected' | null;
  professionalNote: string | null;
  counterOfferAmount: number | null;
  professionalRespondedAt: string | null;
  customerDecision: 'accepted' | 'refused' | null;
  customerRespondedAt: string | null;
  escalatedAt: string | null;
  escalationReason: 'rejected' | 'refused' | 'no_response' | null;
  resolvedAt: string | null;
  resolvedBy: ActorDto | null;
  denyReason: string | null;
  refundAmount: number | null;
  refundedAt: string | null;
  currency: string | null;
  currencyRecorded: boolean;
};

export type WarrantyClaimSummaryDto = {
  id: string;
  claimNumber: string | null;
  status: 'open' | 'proposal_sent' | 'proposal_accepted' | 'resolved' | 'escalated' | 'closed';
  reason: string;
  openedAt: string;
  proposal?: { proposedAt: string | null; customerDecision: string | null; decidedAt: string | null } | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  linkHint: 'participant_warranty' | 'admin_warranty';
};

export type ActivityItem = {
  id: string;
  type: string;
  category: 'lifecycle' | 'rfq' | 'quotation' | 'payment' | 'refund' | 'schedule' | 'completion' | 'extra_cost' | 'cancellation' | 'warranty' | 'dispute' | 'review' | 'system';
  occurredAt: string;
  actor: ActorDto | null;
  actorRecorded: boolean;
  titleKey: string;
  titleParams?: Record<string, string | number | boolean>;
  titleEn?: string;
  description: string | null;
  descriptionSource: 'user' | 'system' | 'admin' | 'not_recorded';
  descriptionLocale: 'en' | 'unknown' | null;
  statusFrom: string | null;
  statusTo: string | null;
  amounts?: {
    amount?: number;
    currency?: string;
    netAmount?: number;
    vatAmount?: number;
    totalAmount?: number;
  };
  amountLines?: Array<{
    kind: 'professional' | 'customer_net' | 'vat' | 'total' | 'refund' | 'payout' | 'commission';
    amount: number;
    currency: string;
    recorded: true;
  }>;
  attachments: AttachmentDto[];
  metadata?: Record<string, any>;
  source: 'status_history' | 'reschedule' | 'cancellation' | 'quotation' | 'payment' | 'refund' | 'warranty' | 'dispute' | 'review' | 'admin' | 'post_booking';
  visibility: 'participants' | 'admin';
  legacyDerived?: boolean;
  noteCodes?: string[];
};

export type BookingActivityDto = {
  generatedAt: string;
  complete: boolean;
  order: 'asc';
  items: ActivityItem[];
  dataQuality: {
    undatedEvents: number;
    actorMissingEvents: number;
    legacyDerivedEvents: number;
    notes: string[];
  };
};

export type ParticipantLinksDto = {
  self: string;
  details: string;
  activity: string;
  booking: string;
  quotationNumber: string | null;
  claimNumbers: string[];
  cancellationRequestIds: string[];
};

export type AdminLinksDto = {
  booking: string;
  disputes?: string;
  warrantyClaims?: string;
  cancellationRequests?: string;
  payments?: string;
};

export type BookingInternalDto = {
  notes: string | null;
  diagnostics: { payment?: PaymentRecordDto['diagnostics'] };
  auditRef: { bookingId: string };
};

export type DetailsMetaDto = {
  generatedAt: string;
  currencyPolicy: 'record_currency_only_no_conversion';
  timeZonePolicy: 'iso_utc_read_only_no_server_localization';
  legacy: boolean;
  notices: DetailsNotice[];
  counts: { versions: number; activity: number; refunds: number; warrantyClaims: number };
  dataQuality: {
    bookingSnapshotRecorded: boolean;
    bookingSnapshotCapturedAt: string | null;
    quoteCustomerTotalsRecorded: boolean;
    quoteActorRecorded: boolean;
    quoteServiceLocationRecorded: boolean;
    extraCostCustomerChargeRecorded: boolean;
    refundVatRecorded: boolean;
    activityActorRecorded: boolean;
    activityComplete: boolean;
  };
};

export type BookingDetailsDto = {
  viewerRole: DetailsViewerRole;
  booking: BookingOverviewDto;
  parties: PartiesDto;
  bookingSnapshot: BookingSnapshotDto;
  wizard: BookingWizardDto;
  quotation: QuotationDetailsDto | null;
  payments: PaymentsDetailsDto;
  extraCosts: ExtraCostsDetailsDto;
  postBooking: PostBookingDetailsDto;
  reschedules: RescheduleHistoryDto[];
  cancellations: CancellationRequestDto[];
  warrantyClaims: WarrantyClaimSummaryDto[];
  activity: BookingActivityDto;
  links: ParticipantLinksDto;
  adminLinks?: AdminLinksDto;
  internal?: BookingInternalDto;
  meta: DetailsMetaDto;
};
