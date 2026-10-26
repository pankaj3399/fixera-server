export const ANONYMIZED_USER_NAME = "[deleted user]";
export const ANONYMIZED_TEXT = "[deleted]";
export const ANONYMIZED_MESSAGE = "[deleted message]";

const ANONYMIZED_ROOTS = new Set(["invoices", "dispute-resolutions"]);

type AnyRecord = Record<string, any>;

const asObject = (value: unknown): AnyRecord | null =>
  value && typeof value === "object" ? (value as AnyRecord) : null;

export const referenceId = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof (value as AnyRecord).toHexString === "function") {
    return String((value as AnyRecord).toHexString());
  }
  if ((value as AnyRecord)._id != null) return referenceId((value as AnyRecord)._id);
  return String(value);
};

/**
 * `deletedAt` is the durable privacy boundary. A tombstoned account is no
 * longer a normal party even when the redaction transaction has not finished.
 */
export const isAnonymizedAccount = (user: unknown): boolean => {
  const record = asObject(user);
  if (!record) return false;
  return record.isAnonymized === true || Boolean(record.deletedAt);
};

/** Remove copied identity from a populated user object. */
export const maskAnonymizedUser = <T>(user: T): T => {
  if (!isAnonymizedAccount(user)) return user;
  const record = asObject(user) as AnyRecord;
  const next: AnyRecord = {
    ...(typeof record.toObject === "function" ? record.toObject() : record),
  };
  next.isAnonymized = true;
  next.name = ANONYMIZED_USER_NAME;
  next.email = null;
  next.phone = null;
  next.username = null;
  next.profileImage = null;
  next.vatNumber = null;
  next.timeZone = null;
  delete next.businessInfo;
  delete next.businessName;
  delete next.location;
  delete next.companyAddress;
  return next as T;
};

const maskLocation = (location: unknown): unknown => {
  const record = asObject(location);
  if (!record) return location;
  return {
    ...record,
    address: ANONYMIZED_TEXT,
    city: null,
    postalCode: null,
    coordinates: [0, 0],
  };
};

const isTargetOwnedUrl = (value: unknown, targetIds: string[]): boolean => {
  if (typeof value !== "string" || value.trim() === "") return false;
  let path = value.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return false;
  }
  const segments = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length === 0 || ANONYMIZED_ROOTS.has(segments[0])) return false;
  return targetIds.some((id) => segments.includes(id));
};

const filterOwnedUrls = (values: unknown, targetIds: string[]): unknown => {
  if (!Array.isArray(values)) return values;
  return values.filter((value) => !isTargetOwnedUrl(value, targetIds));
};

const isFileAnswerEntry = (entry: AnyRecord | null): boolean => {
  const fieldType = entry?.fieldType || entry?.type;
  return fieldType === 'file' || fieldType === 'attachment';
};

/** Remove target-owned uploads from any nested answer array. */
const redactOwnedFileAnswers = (
  answers: unknown,
  targetIds: string[],
): unknown => {
  if (!Array.isArray(answers)) return answers;
  let changed = false;
  const next = answers.map((value) => {
    const answer = asObject(value);
    if (!answer) return value;
    if (
      isFileAnswerEntry(answer)
      && typeof answer.answer === 'string'
      && isTargetOwnedUrl(answer.answer, targetIds)
    ) {
      changed = true;
      return { ...answer, answer: ANONYMIZED_TEXT };
    }
    return value;
  });
  return changed ? next : answers;
};

const maskQuestionAttachments = (
  questions: unknown,
  targetIds: string[],
): unknown => {
  if (Array.isArray(questions)) {
    let changed = false;
    const masked = questions.map((value: unknown) => {
      const question = asObject(value);
      if (!question) return value;
      const attachments = filterOwnedUrls(question.professionalAttachments, targetIds);
      if (attachments !== question.professionalAttachments) {
        changed = true;
        return { ...question, professionalAttachments: attachments };
      }
      return value;
    });
    return changed ? masked : questions;
  }
  const source = asObject(questions);
  if (!source) return questions;
  let changed = false;
  const next: AnyRecord = { ...source };
  for (const key of ['rfq', 'postBooking']) {
    if (!Array.isArray(source[key])) continue;
    let arrayChanged = false;
    const masked = source[key].map((value: unknown) => {
      const question = asObject(value);
      if (!question) return value;
      const attachments = filterOwnedUrls(question.professionalAttachments, targetIds);
      if (attachments !== question.professionalAttachments) {
        arrayChanged = true;
        return { ...question, professionalAttachments: attachments };
      }
      return value;
    });
    if (arrayChanged) {
      changed = true;
      next[key] = masked;
    }
  }
  return changed ? next : questions;
};

const maskAttachmentArrays = (record: AnyRecord, targetIds: string[]) => {
  for (const key of ["attachments", "images"]) {
    if (Array.isArray(record[key])) {
      record[key] = filterOwnedUrls(record[key], targetIds);
    }
  }
};

const replaceCancellationText = (_value: unknown): string => ANONYMIZED_TEXT;

const maskStatusNote = (note: unknown, cancellationByTarget: boolean): unknown => {
  if (typeof note !== "string" || note === "") return note;
  if (cancellationByTarget && note.startsWith("Cancellation approved by admin: ")) {
    return `Cancellation approved by admin: ${ANONYMIZED_TEXT}`;
  }
  if (cancellationByTarget && note.startsWith("Refund issued ")) {
    const match = note.match(/^(Refund issued \([^)]+\) [—-] )([\s\S]*)$/);
    if (match) return `${match[1]}${ANONYMIZED_TEXT}`;
  }
  return note;
};

const maskBookingSnapshot = (
  snapshot: unknown,
  customerAnonymized: boolean,
  professionalAnonymized: boolean,
  targetIds: string[],
): unknown => {
  const source = asObject(snapshot);
  if (!source) return snapshot;
  const next: AnyRecord = { ...source };
  const parties = asObject(source.parties);
  if (parties) {
    const nextParties: AnyRecord = { ...parties };
    if (customerAnonymized) {
      const customer = asObject(parties.customer);
      if (customer) {
        nextParties.customer = {
          ...customer,
          displayName: ANONYMIZED_USER_NAME,
          businessName: null,
          city: null,
          country: null,
          timezone: null,
          email: null,
          phone: null,
          username: null,
          vatNumber: null,
        };
      }
    }
    if (professionalAnonymized) {
      const professional = asObject(parties.professional);
      if (professional) {
        nextParties.professional = {
          ...professional,
          displayName: ANONYMIZED_USER_NAME,
          companyName: null,
          city: null,
          country: null,
          timezone: null,
          email: null,
          phone: null,
          username: null,
          vatNumber: null,
        };
      }
    }
    next.parties = nextParties;
  }
  if (customerAnonymized && source.location) {
    next.location = maskLocation(source.location);
  }
  if (professionalAnonymized) {
    const project = asObject(source.project);
    if (project?.media) {
      next.project = { ...project };
      delete next.project.media;
    }
  }
  if (source.questions) {
    next.questions = maskQuestionAttachments(source.questions, targetIds);
  }
  maskAttachmentArrays(next, targetIds);
  return next;
};

const maskQuoteVersions = (
  versions: unknown,
  targetIds: string[],
  customerAnonymized: boolean,
): unknown => {
  if (!Array.isArray(versions)) return versions;
  return versions.map((value) => {
    const version = asObject(value);
    if (!version) return value;
    const next: AnyRecord = { ...version };
    if (version.changeNote && targetIds.includes(referenceId(version.createdBy))) {
      next.changeNote = ANONYMIZED_TEXT;
    }
    if (
      version.rejectionReason
      && version.rejectedBy
      && targetIds.includes(referenceId(version.rejectedBy))
    ) {
      next.rejectionReason = ANONYMIZED_TEXT;
    }
    if (customerAnonymized && version.serviceLocation) {
      next.serviceLocation = maskLocation(version.serviceLocation);
    }
    return next;
  });
};

const maskStatusHistory = (
  history: unknown,
  targetIds: string[],
  cancellationByTarget: boolean,
): unknown => {
  if (!Array.isArray(history)) return history;
  return history.map((value) => {
    const entry = asObject(value);
    if (!entry) return value;
    const authoredByTarget = targetIds.includes(referenceId(entry.updatedBy));
    if (authoredByTarget && entry.note) {
      return { ...entry, note: ANONYMIZED_TEXT };
    }
    if (!authoredByTarget && entry.note) {
      const masked = maskStatusNote(entry.note, cancellationByTarget);
      if (masked !== entry.note) return { ...entry, note: masked };
    }
    return value;
  });
};

const maskMessages = (messages: unknown, targetIds: string[]): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((value) => {
    const message = asObject(value);
    if (!message || !targetIds.includes(referenceId(message.senderId))) return value;
    return {
      ...message,
      message: ANONYMIZED_MESSAGE,
      attachments: [],
    };
  });
};

const maskReschedule = (
  value: unknown,
  targetIds: string[],
): unknown => {
  const record = asObject(value);
  if (!record) return value;
  const next: AnyRecord = { ...record };
  if (next.requestedBy && typeof next.requestedBy === "object") {
    next.requestedBy = maskAnonymizedUser(next.requestedBy);
  }
  if (next.respondedBy && typeof next.respondedBy === "object") {
    next.respondedBy = maskAnonymizedUser(next.respondedBy);
  }
  if (targetIds.includes(referenceId(record.requestedBy))) {
    if (record.reason != null) next.reason = ANONYMIZED_TEXT;
    if (record.description != null) next.description = ANONYMIZED_TEXT;
    if (record.note != null) next.note = ANONYMIZED_TEXT;
  }
  if (targetIds.includes(referenceId(record.respondedBy)) && record.responseNote != null) {
    next.responseNote = ANONYMIZED_TEXT;
  }
  return next;
};

/**
 * Mask every copied party identity and target-authored free-text field that a
 * legacy or in-progress account could still have in a booking. New
 * anonymizations already store the redacted value; this keeps reads safe
 * before recovery finishes and for accounts redacted by the older flow.
 */
export const maskBookingForAnonymizedParties = <T>(
  booking: T,
  flags: {
    customer?: boolean;
    professional?: boolean;
    customerId?: string;
    professionalId?: string;
  } = {},
): T => {
  const source = asObject(booking);
  if (!source) return booking;
  const populatedCustomer = asObject(source.customer);
  const populatedProfessional = asObject(source.professional);
  const customerAnonymized = flags.customer ?? isAnonymizedAccount(populatedCustomer);
  const professionalAnonymized = flags.professional ?? isAnonymizedAccount(populatedProfessional);
  if (!customerAnonymized && !professionalAnonymized) return booking;

  const customerId = flags.customerId || referenceId(source.customer);
  const professionalId = flags.professionalId
    || referenceId(source.professional)
    || referenceId(source.project?.professionalId);
  const targetIds = [
    customerAnonymized ? customerId : "",
    professionalAnonymized ? professionalId : "",
  ].filter(Boolean);
  const cancellation = asObject(source.cancellation);
  const cancellationByTarget = Boolean(
    cancellation && targetIds.includes(referenceId(cancellation.cancelledBy)),
  );

  const next: AnyRecord = { ...source };
  if (customerAnonymized && populatedCustomer) next.customer = maskAnonymizedUser(populatedCustomer);
  if (professionalAnonymized && populatedProfessional) next.professional = maskAnonymizedUser(populatedProfessional);

  if (customerAnonymized) {
    if (next.location) next.location = maskLocation(next.location);
    next.customerRejectionReason = ANONYMIZED_TEXT;
  }
  if (next.bookingSnapshot) {
    next.bookingSnapshot = maskBookingSnapshot(
      next.bookingSnapshot,
      customerAnonymized,
      professionalAnonymized,
      targetIds,
    );
  }
  if (next.quoteVersions) {
    next.quoteVersions = maskQuoteVersions(
      next.quoteVersions,
      targetIds,
      customerAnonymized,
    );
  }
  if (next.rfqData) {
    const rfqData = asObject(next.rfqData);
    if (rfqData) {
      const attachments = filterOwnedUrls(rfqData.attachments, targetIds);
      const answers = redactOwnedFileAnswers(rfqData.answers, targetIds);
      if (attachments !== rfqData.attachments || answers !== rfqData.answers) {
        next.rfqData = { ...rfqData, attachments, answers };
      }
    }
  }
  if (next.postBookingData) {
    next.postBookingData = redactOwnedFileAnswers(next.postBookingData, targetIds);
  }
  if (next.postBookingQuestionSnapshot) {
    const postBookingSnapshot = asObject(next.postBookingQuestionSnapshot);
    if (postBookingSnapshot) {
      const questions = maskQuestionAttachments(postBookingSnapshot.questions, targetIds);
      if (questions !== postBookingSnapshot.questions) {
        next.postBookingQuestionSnapshot = { ...postBookingSnapshot, questions };
      }
    }
  }
  if (next.statusHistory) {
    next.statusHistory = maskStatusHistory(next.statusHistory, targetIds, cancellationByTarget);
  }
  if (next.messages) next.messages = maskMessages(next.messages, targetIds);

  const rfqResponse = asObject(next.rfqResponse);
  if (rfqResponse && targetIds.includes(referenceId(rfqResponse.respondedBy))) {
    next.rfqResponse = { ...rfqResponse, rejectionReason: ANONYMIZED_TEXT };
  }

  if (customerAnonymized) {
    const review = asObject(next.customerReview);
    if (review) {
      const masked: AnyRecord = { ...review, images: [] };
      delete masked.comment;
      next.customerReview = masked;
    }
  }
  if (professionalAnonymized) {
    const customerReview = asObject(next.customerReview);
    if (customerReview) {
      const reply = asObject(customerReview.reply);
      if (reply?.comment) {
        next.customerReview = {
          ...customerReview,
          reply: { ...reply, comment: ANONYMIZED_TEXT },
        };
      }
    }
    const professionalReview = asObject(next.professionalReview);
    if (professionalReview?.comment) {
      next.professionalReview = { ...professionalReview, comment: ANONYMIZED_TEXT };
    }
  }

  const dispute = asObject(next.dispute);
  if (dispute && targetIds.includes(referenceId(dispute.raisedBy))) {
    next.dispute = {
      ...dispute,
      raisedBy: dispute.raisedBy && typeof dispute.raisedBy === "object"
        ? maskAnonymizedUser(dispute.raisedBy)
        : dispute.raisedBy,
      resolvedBy: dispute.resolvedBy && typeof dispute.resolvedBy === "object"
        ? maskAnonymizedUser(dispute.resolvedBy)
        : dispute.resolvedBy,
      reason: ANONYMIZED_TEXT,
      description: ANONYMIZED_TEXT,
      attachments: filterOwnedUrls(dispute.attachments, targetIds),
      resolutionAttachments: filterOwnedUrls(dispute.resolutionAttachments, targetIds),
    };
  } else if (dispute) {
    const attachments = filterOwnedUrls(dispute.attachments, targetIds);
    const resolutionAttachments = filterOwnedUrls(dispute.resolutionAttachments, targetIds);
    if (
      attachments !== dispute.attachments
      || resolutionAttachments !== dispute.resolutionAttachments
      || (dispute.raisedBy && typeof dispute.raisedBy === "object")
      || (dispute.resolvedBy && typeof dispute.resolvedBy === "object")
    ) {
      next.dispute = {
        ...dispute,
        ...(dispute.raisedBy && typeof dispute.raisedBy === "object"
          ? { raisedBy: maskAnonymizedUser(dispute.raisedBy) }
          : {}),
        ...(dispute.resolvedBy && typeof dispute.resolvedBy === "object"
          ? { resolvedBy: maskAnonymizedUser(dispute.resolvedBy) }
          : {}),
        attachments,
        resolutionAttachments,
      };
    }
  }

  if (cancellation && targetIds.includes(referenceId(cancellation.cancelledBy))) {
    next.cancellation = {
      ...cancellation,
      reason: replaceCancellationText(cancellation.reason),
    };
  }

  if (next.rescheduleRequest) {
    next.rescheduleRequest = maskReschedule(next.rescheduleRequest, targetIds);
  }
  if (Array.isArray(next.rescheduleHistory)) {
    next.rescheduleHistory = next.rescheduleHistory.map((entry) => maskReschedule(entry, targetIds));
  }

  const attestation = asObject(next.completionAttestation);
  if (attestation && targetIds.includes(referenceId(attestation.confirmedBy))) {
    const masked: AnyRecord = {
      ...attestation,
      attachments: filterOwnedUrls(attestation.attachments, targetIds),
    };
    delete masked.notes;
    next.completionAttestation = masked;
  } else if (attestation) {
    const attachments = filterOwnedUrls(attestation.attachments, targetIds);
    if (attachments !== attestation.attachments) {
      next.completionAttestation = { ...attestation, attachments };
    }
  }

  if (next.completionDetails) {
    const details = asObject(next.completionDetails);
    if (details) {
      next.completionDetails = {
        ...details,
        images: filterOwnedUrls(details.images, targetIds),
        attachments: filterOwnedUrls(details.attachments, targetIds),
      };
    }
  }
  if (next.noShow && targetIds.includes(referenceId(next.noShow.markedBy)) && next.noShow.reason) {
    next.noShow = { ...next.noShow, reason: ANONYMIZED_TEXT };
  }
  if (Array.isArray(next.extraCosts)) {
    next.extraCosts = next.extraCosts.map((value) => {
      const cost = asObject(value);
      if (!cost) return value;
      return { ...cost, attachments: filterOwnedUrls(cost.attachments, targetIds) };
    });
  }
  const customerBlocks = asObject(next.customerBlocks);
  if (customerAnonymized && customerBlocks) {
    next.customerBlocks = {
      ...customerBlocks,
      dates: Array.isArray(customerBlocks.dates)
        ? customerBlocks.dates.map((entry: unknown) => {
            const block = asObject(entry);
            return block?.reason ? { ...block, reason: ANONYMIZED_TEXT } : entry;
          })
        : customerBlocks.dates,
      windows: Array.isArray(customerBlocks.windows)
        ? customerBlocks.windows.map((entry: unknown) => {
            const block = asObject(entry);
            return block?.reason ? { ...block, reason: ANONYMIZED_TEXT } : entry;
          })
        : customerBlocks.windows,
    };
  }

  if (Array.isArray(next.assignedTeamMembers)) {
    next.assignedTeamMembers = next.assignedTeamMembers.map((member) => (
      member && typeof member === "object" ? maskAnonymizedUser(member) : member
    ));
  }

  maskAttachmentArrays(next, targetIds);
  return next as T;
};

const targetIdsFromParties = (
  value: AnyRecord,
  flags: { customer?: boolean; professional?: boolean } = {},
): string[] => {
  const customer = asObject(value.customer);
  const professional = asObject(value.professional);
  const customerAnonymized = flags.customer ?? isAnonymizedAccount(customer);
  const professionalAnonymized = flags.professional ?? isAnonymizedAccount(professional);
  return [
    customerAnonymized ? referenceId(value.customer) : "",
    professionalAnonymized ? referenceId(value.professional) : "",
  ].filter(Boolean);
};

/**
 * Read mask for a cancellation request. The requester's narrative and owned
 * evidence disappear as soon as the requester is tombstoned; counterparty and
 * admin decisions remain. Admin resolution notes are stored separately and
 * are never inferred from text inside the requester's reason.
 */
export const maskCancellationRequestForAnonymizedParties = <T>(
  request: T,
  flags: {
    customerId?: string;
    professionalId?: string;
    customerAnonymized?: boolean;
    professionalAnonymized?: boolean;
  } = {},
): T => {
  const source = asObject(request);
  if (!source) return request;
  const booking = asObject(source.booking);
  const requestedByAnonymized = isAnonymizedAccount(source.requestedBy);
  const resolvedByAnonymized = isAnonymizedAccount(source.resolvedBy);
  const customerAnonymized = flags.customerAnonymized ?? isAnonymizedAccount(booking?.customer);
  const professionalAnonymized = flags.professionalAnonymized ?? isAnonymizedAccount(booking?.professional);
  const customerId = flags.customerId || referenceId(booking?.customer);
  const professionalId = flags.professionalId || referenceId(booking?.professional);
  const requestedById = referenceId(source.requestedBy);
  const requestedByTarget = requestedByAnonymized
    || (Boolean(requestedById)
      && ((customerAnonymized && requestedById === customerId)
        || (professionalAnonymized && requestedById === professionalId)));
  const targetIds = [
    requestedByAnonymized ? requestedById : "",
    customerAnonymized ? customerId : "",
    professionalAnonymized ? professionalId : "",
    resolvedByAnonymized ? referenceId(source.resolvedBy) : "",
    isAnonymizedAccount(source.professionalRespondedBy)
      ? referenceId(source.professionalRespondedBy)
      : "",
  ].filter(Boolean);
  if (targetIds.length === 0) return request;

  const next: AnyRecord = { ...source };
  if (requestedByTarget) {
    next.reason = ANONYMIZED_TEXT;
    next.evidence = filterOwnedUrls(source.evidence, targetIds);
  }
  if (
    source.professionalNote
    && targetIds.includes(referenceId(source.professionalRespondedBy))
  ) {
    next.professionalNote = ANONYMIZED_TEXT;
  }
  if (source.requestedBy && typeof source.requestedBy === "object") {
    next.requestedBy = maskAnonymizedUser(source.requestedBy);
  }
  if (source.resolvedBy && typeof source.resolvedBy === "object") {
    next.resolvedBy = maskAnonymizedUser(source.resolvedBy);
  }
  if (booking) {
    next.booking = {
      ...booking,
      ...(booking.customer && typeof booking.customer === "object"
        ? { customer: maskAnonymizedUser(booking.customer) }
        : {}),
      ...(booking.professional && typeof booking.professional === "object"
        ? { professional: maskAnonymizedUser(booking.professional) }
        : {}),
    };
  }
  return next as T;
};

/** Read mask for warranty claim narratives and target-owned evidence. */
export const maskWarrantyClaimForAnonymizedParties = <T>(claim: T): T => {
  const source = asObject(claim);
  if (!source) return claim;
  const customerAnonymized = isAnonymizedAccount(source.customer);
  const professionalAnonymized = isAnonymizedAccount(source.professional);
  const targetIds = [
    customerAnonymized ? referenceId(source.customer) : "",
    professionalAnonymized ? referenceId(source.professional) : "",
  ].filter(Boolean);
  if (targetIds.length === 0) return claim;

  const next: AnyRecord = {
    ...source,
    customer: customerAnonymized ? maskAnonymizedUser(source.customer) : source.customer,
    professional: professionalAnonymized ? maskAnonymizedUser(source.professional) : source.professional,
  };
  if (customerAnonymized) {
    next.description = ANONYMIZED_TEXT;
    const proposal = asObject(source.proposal);
    if (proposal?.decisionNote) {
      next.proposal = { ...proposal, decisionNote: ANONYMIZED_TEXT };
    }
  }
  if (professionalAnonymized) {
    const proposal = asObject(source.proposal);
    if (proposal?.message) {
      next.proposal = { ...proposal, message: ANONYMIZED_TEXT };
    }
    const resolution = asObject(source.resolution);
    if (resolution?.summary && isAnonymizedAccount(resolution.resolvedBy)) {
      next.resolution = { ...resolution, summary: ANONYMIZED_TEXT };
    }
  }
  const escalation = asObject(source.escalation);
  if (escalation && targetIds.includes(referenceId(escalation.escalatedBy))) {
    next.escalation = {
      ...escalation,
      ...(escalation.reason != null ? { reason: ANONYMIZED_TEXT } : {}),
      ...(escalation.note != null ? { note: ANONYMIZED_TEXT } : {}),
    };
  }
  if (Array.isArray(source.evidence)) {
    next.evidence = filterOwnedUrls(source.evidence, targetIds);
  }
  const resolution = asObject(next.resolution ?? source.resolution);
  if (resolution && Array.isArray(resolution.attachments)) {
    next.resolution = {
      ...resolution,
      attachments: filterOwnedUrls(resolution.attachments, targetIds),
    };
  }
  if (Array.isArray(source.statusHistory)) {
    next.statusHistory = source.statusHistory.map((entry: AnyRecord) => (
      entry && targetIds.includes(referenceId(entry.updatedBy)) && entry.note
        ? { ...entry, note: ANONYMIZED_TEXT }
        : entry
    ));
  }
  return next as T;
};

/** Read mask for a project meeting whose owner/creator is anonymized. */
export const maskMeetingForAnonymizedParties = <T>(meeting: T): T => {
  const source = asObject(meeting);
  if (!source) return meeting;
  const ownerAnonymized = isAnonymizedAccount(source.professionalId)
    || isAnonymizedAccount(source.createdBy);
  const ownerId = referenceId(source.professionalId) || referenceId(source.createdBy);
  if (!ownerAnonymized) return meeting;

  const next: AnyRecord = {
    ...source,
    title: "[deleted meeting]",
  };
  delete next.description;
  delete next.location;
  delete next.meetingLink;
  delete next.agenda;
  delete next.notes;
  delete next.attachments;
  if (source.cancellationReason && referenceId(source.cancelledBy) === ownerId) {
    next.cancellationReason = ANONYMIZED_TEXT;
  }
  if (source.reschedulingReason && referenceId(source.rescheduledBy) === ownerId) {
    next.reschedulingReason = ANONYMIZED_TEXT;
  }
  return next as T;
};

/** Read mask for a chat message whose sender is anonymized. */
export const maskChatMessageForAnonymizedSender = <T>(message: T): T => {
  const source = asObject(message);
  if (!source) return message;
  if (!isAnonymizedAccount(source.senderId)) return message;
  const next: AnyRecord = {
    ...source,
    senderId: maskAnonymizedUser(source.senderId),
    text: ANONYMIZED_MESSAGE,
    images: [],
    attachments: [],
  };
  delete next.reviewMeta;
  return next as T;
};
