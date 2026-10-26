import { Request, Response } from 'express';
import { AnonymizationError, anonymizeUser } from '../../utils/anonymizeUser';
import { auditLog } from '../../utils/auditLogger';

export const deleteMyAccount = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?._id) {
    return res.status(401).json({ success: false, msg: 'Authentication required' });
  }

  if (user.role === 'admin') {
    return res.status(403).json({ success: false, msg: 'Admin accounts cannot be self-deleted' });
  }

  try {
    const result = await anonymizeUser(user._id, user._id);

    // The request user document predates redaction. Keep the audit actor email
    // on the placeholder so the audit row cannot reintroduce the old address.
    (req as any).user.email = `deleted-${user._id}@anon.local`;
    (req as any).user.isAnonymized = true;

    await auditLog({
      req,
      action: 'user.anonymize',
      targetType: 'User',
      targetId: user._id,
      details: {
        initiatedBy: 'self',
        redactedMessageCount: result.redactedMessageCount,
        fullyAnonymized: result.fullyAnonymized,
        cleanupPending: result.cleanupPendingFiles || 0,
      },
      status: 'success',
      statusCode: 200,
    });

    res.clearCookie('auth-token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });

    return res.status(200).json({
      success: true,
      msg: result.fullyAnonymized === false
        ? 'Your account has been deleted and access is blocked. Some stored files or calendar cleanup are still pending; an operator must retry them. Contact support if this is not resolved.'
        : 'Your account has been deleted. Personal information has been removed; financial records are retained as required by law.',
    });
  } catch (error: any) {
    if (error instanceof AnonymizationError) {
      await auditLog({
        req,
        action: 'user.anonymize',
        targetType: 'User',
        targetId: user._id,
        details: { initiatedBy: 'self', errorCode: error.code },
        status: 'failure',
        statusCode: error.status,
        errorMessage: error.message,
      });
      return res.status(error.status).json({
        success: false,
        msg: error.message,
        code: error.code,
      });
    }
    console.error('[USER][SELF_DELETE] Failed', error);
    await auditLog({
      req,
      action: 'user.anonymize',
      targetType: 'User',
      targetId: user._id,
      details: { initiatedBy: 'self' },
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: 'Failed to delete account' });
  }
};
