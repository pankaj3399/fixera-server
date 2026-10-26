import { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  AnonymizationError,
  executeAccountAnonymization,
  listRecoverableAnonymizations,
  previewAccountAnonymization,
} from '../../utils/anonymizeUser';
import { auditLog } from '../../utils/auditLogger';
import { denyUnlessPermission } from '../../utils/adminRbac/assertPermission';
import { params } from '../../utils/requestParams';

const CONFIRMATION_TEXT = 'ANONYMIZE';

const readAdmin = (req: Request) => (req as any).admin || (req as any).user;

const respondToAnonymizationError = (res: Response, error: AnonymizationError) => {
  const details = error.details || {};
  const blockers = Array.isArray((details as any).blockers)
    ? (details as any).blockers
    : undefined;
  return res.status(error.status).json({
    success: false,
    msg: error.message,
    code: error.code,
    ...(blockers ? { blockers } : {}),
    ...(Object.keys(details).length > 0 ? { data: details } : {}),
  });
};

const ensureUsersDeletePermission = (req: Request, res: Response): boolean => {
  const admin = readAdmin(req);
  if (!admin?._id) {
    res.status(401).json({
      success: false,
      msg: 'Admin authentication required',
      code: 'AUTH_REQUIRED',
    });
    return false;
  }
  const denial = denyUnlessPermission(admin, 'users.delete');
  if (denial) {
    res.status(denial.status).json(denial.body);
    return false;
  }
  return true;
};

const validUserId = (req: Request, res: Response): string | null => {
  const { userId } = params(req.params);
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    res.status(400).json({
      success: false,
      msg: 'Invalid userId',
      code: 'VALIDATION',
    });
    return null;
  }
  return userId;
};

export const adminAnonymizePreview = async (req: Request, res: Response) => {
  if (!ensureUsersDeletePermission(req, res)) return;
  const userId = validUserId(req, res);
  if (!userId) return;

  try {
    const admin = readAdmin(req);
    const data = await previewAccountAnonymization(userId, { actorId: admin?._id });
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    if (error instanceof AnonymizationError) {
      return respondToAnonymizationError(res, error);
    }
    console.error('[ADMIN][ANONYMIZE_PREVIEW] Failed', error);
    return res.status(500).json({
      success: false,
      msg: 'Failed to load anonymization preview',
      code: 'INTERNAL',
    });
  }
};

export const adminAnonymizeRecoveryList = async (req: Request, res: Response) => {
  if (!ensureUsersDeletePermission(req, res)) return;
  const rawLimit = Number(req.query.limit);
  const rawPage = Number(req.query.page);
  try {
    const data = await listRecoverableAnonymizations({
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      page: Number.isFinite(rawPage) ? rawPage : undefined,
    });
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error('[ADMIN][ANONYMIZE_RECOVERY] Failed', error);
    return res.status(500).json({
      success: false,
      msg: 'Failed to load recoverable anonymizations',
      code: 'INTERNAL',
    });
  }
};

export const adminAnonymizeUser = async (req: Request, res: Response) => {
  if (!ensureUsersDeletePermission(req, res)) return;
  const userId = validUserId(req, res);
  if (!userId) return;

  if (req.body?.confirm !== CONFIRMATION_TEXT) {
    return res.status(400).json({
      success: false,
      msg: `Type ${CONFIRMATION_TEXT} to confirm this irreversible action.`,
      code: 'INVALID_CONFIRMATION',
    });
  }

  const admin = readAdmin(req);
  try {
    const result = await executeAccountAnonymization({
      targetId: userId,
      actorId: admin?._id,
      initiatedBy: 'admin',
      enforceBlockers: true,
    });

    await auditLog({
      req,
      action: 'admin.users.anonymize',
      targetType: 'User',
      targetId: userId,
      details: {
        initiatedBy: 'admin',
        outcome: result.outcome,
        targetRole: result.target.role,
        fullyAnonymized: result.fullyAnonymized,
        cleanupPending: result.cleanup.pendingFiles,
        redacted: result.redacted,
      },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({
      success: true,
      msg: result.fullyAnonymized
        ? 'User anonymized. Personal information removed; financial records retained.'
        : 'Account redacted. Some cleanup tasks still need a retry; repeat the confirmed request.',
      data: result,
    });
  } catch (error: any) {
    if (error instanceof AnonymizationError) {
      await auditLog({
        req,
        action: 'admin.users.anonymize',
        targetType: 'User',
        targetId: userId,
        details: {
          initiatedBy: 'admin',
          outcome: 'failed',
          errorCode: error.code,
        },
        status: 'failure',
        statusCode: error.status,
        errorMessage: error.message,
      });
      return respondToAnonymizationError(res, error);
    }

    console.error('[ADMIN][ANONYMIZE_USER] Failed', error);
    await auditLog({
      req,
      action: 'admin.users.anonymize',
      targetType: 'User',
      targetId: userId,
      details: { initiatedBy: 'admin', outcome: 'failed' },
      status: 'failure',
      statusCode: 500,
      errorMessage: 'Anonymization failed unexpectedly',
    });
    return res.status(500).json({
      success: false,
      msg: 'Failed to anonymize user',
      code: 'INTERNAL',
    });
  }
};
