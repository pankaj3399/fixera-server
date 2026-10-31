import {
  isAllowedS3Url,
  parseS3KeyFromUrl,
  presignS3Url,
} from '../s3Upload';

/**
 * Upload roots whose first path segment after the root is the uploader's user
 * id (see generateFileName). Only these can be proven to belong to a person.
 */
export const OWNED_UPLOAD_ROOTS = [
  'rfq-attachments',
  'completion-attachments',
  'dispute-attachments',
  'warranty-claims',
  'review-images',
  'reviews',
] as const;

export type OwnedUploadRoot = (typeof OWNED_UPLOAD_ROOTS)[number];

const userIdOf = (value: any): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  // Populated Mongoose documents and lean objects carry the identity in
  // `_id`; ObjectIds also expose `.id` as a binary buffer, so prefer `_id`.
  const raw = value._id ?? value.id ?? value;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw.toHexString === 'function') return raw.toHexString();
  if (typeof raw.toString === 'function') {
    const text = raw.toString();
    return text && text !== '[object Object]' ? text : null;
  }
  return null;
};

export const referenceId = (value: any): string | null => userIdOf(value);

export interface PresignResult {
  url: string | null;
  signed: boolean;
  unavailableReason?: 'not_found' | 'not_owned' | 'presign_failed' | 'not_allowed';
}

export interface AttachmentDto {
  url: string | null;
  fileName: string | null;
  mimeType?: string | null;
  size?: number | null;
  source: 'rfq' | 'post_booking' | 'completion' | 'cancellation' | 'dispute' | 'resolution' | 'warranty';
  signed: boolean;
  unavailableReason?: string;
}


/**
 * True only when the stored URL is on the trusted bucket AND the key starts
 * with one of the allowed upload roots and contains the uploader's user id as
 * a complete path segment. A caller cannot make an arbitrary S3 URL look owned
 * by placing another person's id in the query string.
 */
export const isUploadOwnedByUser = (
  url: unknown,
  userId: unknown,
  roots: readonly string[] = OWNED_UPLOAD_ROOTS,
): boolean => {
  if (typeof url !== 'string' || !url) return false;
  const owner = userIdOf(userId);
  if (!owner) return false;
  if (!isAllowedS3Url(url)) return false;
  const key = parseS3KeyFromUrl(url);
  if (!key) return false;
  const segments = key.split('/').filter(Boolean);
  if (segments.length < 3) return false;
  const root = segments[0];
  if (!roots.includes(root)) return false;
  // generateFileName writes `<root>/<userId>/<file>`; chat uploads write
  // `chat/<conversation>/<userId>/<file>`. Accept the user id anywhere after
  // the approved root, but only as a complete segment.
  return segments.slice(1).includes(owner);
};

export const isUploadOwnedByAnyUser = (
  url: unknown,
  userIds: Array<unknown>,
  roots: readonly string[] = OWNED_UPLOAD_ROOTS,
): boolean => userIds.some((userId) => isUploadOwnedByUser(url, userId, roots));

export interface ProjectAnswerUploadOwnership {
  projectId: string;
  uploaderId: string;
}

/**
 * The existing question-answer uploader stores
 * `projects/<projectId>/attachment/<uploaderId>/<file>` (see uploadProjectFile
 * + generateFileName). A question answer may use that path, but only when the
 * project and uploader segments are complete, validated ids. This is narrower
 * than allowing the whole `projects/` root.
 */
export const projectAnswerUploadOwnership = (
  url: unknown,
): ProjectAnswerUploadOwnership | null => {
  if (typeof url !== 'string' || !url || !isAllowedS3Url(url)) return null;
  const key = parseS3KeyFromUrl(url);
  if (!key) return null;
  const segments = key.split('/').filter(Boolean);
  if (segments.length < 5) return null;
  if (segments[0] !== 'projects' || segments[2] !== 'attachment') return null;
  const projectId = segments[1];
  const uploaderId = segments[3];
  if (!/^[a-f0-9]{24}$/i.test(projectId) || !/^[a-f0-9]{24}$/i.test(uploaderId)) return null;
  return { projectId, uploaderId };
};

export const isProjectAnswerUploadOwnedByUser = (
  url: unknown,
  userId: unknown,
  projectId: unknown,
): boolean => {
  const owner = userIdOf(userId);
  const project = userIdOf(projectId);
  if (!owner || !project) return false;
  const parsed = projectAnswerUploadOwnership(url);
  return Boolean(parsed && parsed.projectId === project && parsed.uploaderId === owner);
};

/**
 * A file answer is legitimate when it is a normal owned upload OR a question
 * attachment uploaded through the project uploader for this exact project.
 */
export const isQuestionAnswerUploadOwnedByUser = (
  url: unknown,
  userId: unknown,
  projectId: unknown,
): boolean =>
  isUploadOwnedByUser(url, userId, ['rfq-attachments'])
  || isProjectAnswerUploadOwnedByUser(url, userId, projectId);

/**
 * Store only a raw, non-expiring S3 URL in immutable snapshots. Presigned
 * URLs lose their query string; external/non-bucket URLs are dropped.
 */
export const sanitizeStoredUrl = (url: unknown): string | null => {
  if (typeof url !== 'string' || !url) return null;
  if (!isAllowedS3Url(url)) return null;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

export const sanitizeStoredUrls = (urls: unknown): string[] =>
  Array.isArray(urls)
    ? urls.map(sanitizeStoredUrl).filter((url): url is string => Boolean(url))
    : [];

/**
 * Short-lived presign for a specific attachment. `ownerIds` are the people who
 * may legitimately own the upload. If no owner matches, no URL is returned.
 */
export const presignOwnedUrl = async (
  url: unknown,
  ownerIds: Array<unknown>,
  roots: readonly string[] = OWNED_UPLOAD_ROOTS,
  expiresIn = 3600,
): Promise<PresignResult> => {
  if (typeof url !== 'string' || !url) {
    return { url: null, signed: false, unavailableReason: 'not_found' };
  }
  if (!isAllowedS3Url(url)) {
    return { url: null, signed: false, unavailableReason: 'not_allowed' };
  }
  if (!isUploadOwnedByAnyUser(url, ownerIds, roots)) {
    return { url: null, signed: false, unavailableReason: 'not_owned' };
  }
  const signed = await presignS3Url(url, expiresIn);
  if (!signed) {
    return { url: null, signed: false, unavailableReason: 'presign_failed' };
  }
  return { url: signed, signed: true };
};

/**
 * Presign a project-question-answer upload only when the stored key belongs to
 * this booking's project and the uploader is one of the legitimate owners.
 */
export const presignProjectAnswerUrl = async (
  url: unknown,
  ownerIds: Array<unknown>,
  projectId: unknown,
  expiresIn = 3600,
): Promise<PresignResult> => {
  if (typeof url !== 'string' || !url) {
    return { url: null, signed: false, unavailableReason: 'not_found' };
  }
  if (!isAllowedS3Url(url)) {
    return { url: null, signed: false, unavailableReason: 'not_allowed' };
  }
  const parsed = projectAnswerUploadOwnership(url);
  if (!parsed) {
    return { url: null, signed: false, unavailableReason: 'not_owned' };
  }
  const project = userIdOf(projectId);
  if (!project || parsed.projectId !== project) {
    return { url: null, signed: false, unavailableReason: 'not_owned' };
  }
  if (!ownerIds.some((owner) => userIdOf(owner) === parsed.uploaderId)) {
    return { url: null, signed: false, unavailableReason: 'not_owned' };
  }
  const signed = await presignS3Url(url, expiresIn);
  if (!signed) {
    return { url: null, signed: false, unavailableReason: 'presign_failed' };
  }
  return { url: signed, signed: true };
};

/**
 * Sign whichever supported upload root the answer actually uses. Project
 * question uploads are bound to the booking project; any other key must be an
 * owned upload under the supplied roots.
 */
export const presignQuestionAnswerUrl = async (
  url: unknown,
  ownerIds: Array<unknown>,
  projectId: unknown,
  roots: readonly string[] = ['rfq-attachments', 'dispute-attachments'],
  expiresIn = 3600,
): Promise<PresignResult> => {
  if (projectAnswerUploadOwnership(url)) {
    return presignProjectAnswerUrl(url, ownerIds, projectId, expiresIn);
  }
  return presignOwnedUrl(url, ownerIds, roots, expiresIn);
};

/**
 * Project-level attachments (RFQ question attachments) were uploaded by the
 * project professional and are intentionally shared with the customer. They
 * only need the trusted-bucket allowlist, not a per-caller owner check.
 */
export const presignSharedProjectUrl = async (
  url: unknown,
  expiresIn = 3600,
  allowedKeyRoots?: readonly string[],
): Promise<PresignResult> => {
  if (typeof url !== 'string' || !url) {
    return { url: null, signed: false, unavailableReason: 'not_found' };
  }
  if (!isAllowedS3Url(url)) {
    return { url: null, signed: false, unavailableReason: 'not_allowed' };
  }
  if (allowedKeyRoots && allowedKeyRoots.length > 0) {
    const key = parseS3KeyFromUrl(url);
    if (!key || !allowedKeyRoots.some((root) => key.startsWith(root))) {
      return { url: null, signed: false, unavailableReason: 'not_allowed' };
    }
  }
  const signed = await presignS3Url(url, expiresIn);
  if (!signed) {
    return { url: null, signed: false, unavailableReason: 'presign_failed' };
  }
  return { url: signed, signed: true };
};
