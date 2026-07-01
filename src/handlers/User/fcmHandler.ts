import { Request, Response } from 'express';
import User from '../../models/user';
import {
  getOriginFromRequest,
  isAllowedOrigin,
} from '../../utils/fcmTokenUtils';

// ------------------------------------------------------------------
// Register / Unregister FCM tokens
// ------------------------------------------------------------------

const MAX_TOKENS_PER_USER = 10;

/**
 * POST /api/user/fcm/token
 * Body: { token: string, origin?: string }
 * Registers an FCM device token for the authenticated user, scoped to the
 * site origin (e.g. production vs localhost) so pushes don't cross environments.
 */
export const registerFcmToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const { token } = req.body as { token?: string };
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      res.status(400).json({ success: false, msg: 'token is required' });
      return;
    }

    const origin = getOriginFromRequest(req);
    if (!isAllowedOrigin(origin)) {
      res.status(400).json({ success: false, msg: 'origin is not allowed' });
      return;
    }

    const cleanToken = token.trim();
    const now = new Date();

    const userExists = await User.findById(userId).select('_id');
    if (!userExists) {
      res.status(404).json({ success: false, msg: 'User not found' });
      return;
    }

    // Each device token belongs to one user at a time.
    await User.updateMany(
      { _id: { $ne: userId } },
      { $pull: { fcmTokens: { token: cleanToken } } },
    );

    // Atomic update: preserve other-origin tokens, dedupe within origin, cap total.
    await User.findByIdAndUpdate(userId, [
      {
        $set: {
          fcmTokens: {
            $let: {
              vars: {
                otherOrigin: {
                  $filter: {
                    input: { $ifNull: ['$fcmTokens', []] },
                    as: 'entry',
                    cond: { $ne: ['$$entry.origin', origin] },
                  },
                },
                sameOrigin: {
                  $filter: {
                    input: { $ifNull: ['$fcmTokens', []] },
                    as: 'entry',
                    cond: {
                      $and: [
                        { $eq: ['$$entry.origin', origin] },
                        { $ne: ['$$entry.token', cleanToken] },
                      ],
                    },
                  },
                },
              },
              in: {
                $slice: [
                  {
                    $concatArrays: [
                      '$$otherOrigin',
                      '$$sameOrigin',
                      [{ token: cleanToken, origin, updatedAt: now }],
                    ],
                  },
                  -MAX_TOKENS_PER_USER,
                ],
              },
            },
          },
        },
      },
    ]);

    res.status(200).json({ success: true, msg: 'FCM token registered' });
  } catch (err) {
    console.error('registerFcmToken error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};

/**
 * DELETE /api/user/fcm/token
 * Body: { token: string }
 * Removes a specific FCM token (e.g. on logout or permission revocation).
 */
export const unregisterFcmToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const { token } = req.body as { token?: string };
    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, msg: 'token is required' });
      return;
    }

    await User.findByIdAndUpdate(userId, {
      $pull: { fcmTokens: { token: token.trim() } },
    });

    res.status(200).json({ success: true, msg: 'FCM token removed' });
  } catch (err) {
    console.error('unregisterFcmToken error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};

// ------------------------------------------------------------------
// Notification preferences
// ------------------------------------------------------------------

const VALID_TYPES = ['booking_updates', 'messages', 'promotions', 'system'] as const;

/**
 * GET /api/user/notification-preferences
 * Returns the authenticated user's notification channel preferences.
 */
export const getNotificationPreferences = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const user = await User.findById(userId).select('notificationPreferences');
    if (!user) {
      res.status(404).json({ success: false, msg: 'User not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: user.notificationPreferences ?? {},
    });
  } catch (err) {
    console.error('getNotificationPreferences error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};

/**
 * PATCH /api/user/notification-preferences
 * Body: { type: string, channel: 'push'|'email', enabled: boolean }
 * Updates a single notification channel preference.
 */
export const updateNotificationPreferences = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id?.toString();
    if (!userId) {
      res.status(401).json({ success: false, msg: 'Authentication required' });
      return;
    }

    const { type, channel, enabled } = req.body as {
      type?: string;
      channel?: 'push' | 'email';
      enabled?: boolean;
    };

    if (!type || !(VALID_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ success: false, msg: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }

    if (channel !== 'push' && channel !== 'email') {
      res.status(400).json({ success: false, msg: "channel must be 'push' or 'email'" });
      return;
    }

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, msg: 'enabled must be a boolean' });
      return;
    }

    const updatePath = `notificationPreferences.${type}.${channel}`;
    await User.findByIdAndUpdate(userId, { $set: { [updatePath]: enabled } });

    res.status(200).json({ success: true, msg: 'Preference updated' });
  } catch (err) {
    console.error('updateNotificationPreferences error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};
