import { Request, Response } from 'express';
import User from '../../models/user';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import { syncPendingBrevoResubscribes } from '../../utils/marketing/audience';
import { generateUnsubscribeToken } from '../../utils/marketing/unsubscribeToken';
import {
  getOriginFromRequest,
  isAllowedOrigin,
} from '../../utils/fcmTokenUtils';
import { MARKETING_LOCALES, isMarketingLocale } from '../../utils/marketing/marketingCatalog';
import { isPromotionalEmailEnabled } from '../../utils/marketing/promotionalConsent';

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

    const user = await User.findById(userId).select(
      'notificationPreferences marketingConsentAt marketingLocale marketingLocaleSource',
    );
    if (!user) {
      res.status(404).json({ success: false, msg: 'User not found' });
      return;
    }

    const preferences = { ...(user.notificationPreferences || {}) };
    preferences.promotions = {
      ...(preferences.promotions || {}),
      email: isPromotionalEmailEnabled(preferences),
    };

    res.status(200).json({
      success: true,
      data: { ...preferences, marketingLocale: user.marketingLocale, marketingLocaleSource: user.marketingLocaleSource },
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

    const { type, channel, enabled, marketingLocale } = req.body as {
      type?: string;
      channel?: 'push' | 'email';
      enabled?: boolean;
      marketingLocale?: string;
    };

    const normalizedMarketingLocale =
      marketingLocale === undefined ? undefined : marketingLocale.trim().toLowerCase();
    if (normalizedMarketingLocale !== undefined && !isMarketingLocale(normalizedMarketingLocale)) {
      res.status(400).json({ success: false, msg: `marketingLocale must be one of: ${MARKETING_LOCALES.join(', ')}` });
      return;
    }

    // Language-only updates are intentionally supported by the same preference
    // endpoint used for channel toggles.
    if (marketingLocale !== undefined && type === undefined && channel === undefined && enabled === undefined) {
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: { marketingLocale: normalizedMarketingLocale, marketingLocaleSource: 'explicit' } },
        { new: true },
      ).select('_id');
      if (!updatedUser) {
        res.status(404).json({ success: false, msg: 'User not found' });
        return;
      }
      res.status(200).json({ success: true, msg: 'Marketing language updated' });
      return;
    }

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
    const userUpdate: Record<string, Record<string, unknown>> = {
      $set: { [updatePath]: enabled },
    };
    if (marketingLocale !== undefined) {
      userUpdate.$set.marketingLocale = marketingLocale.trim().toLowerCase();
      userUpdate.$set.marketingLocaleSource = 'explicit';
    }
    if (type === 'promotions' && channel === 'email') {
      if (enabled) {
        userUpdate.$set.marketingConsentAt = new Date();
      } else {
        userUpdate.$unset = { marketingConsentAt: 1 };
      }
    }
    const updatedUser = await User.findByIdAndUpdate(userId, userUpdate, {
      new: true,
    }).select('email');
    if (!updatedUser) {
      res.status(404).json({ success: false, msg: 'User not found' });
      return;
    }

    if (type === 'promotions' && channel === 'email') {
      const normalizedEmail = updatedUser.email.toLowerCase().trim();
      const consentUpdatedAt = new Date();
      if (enabled) {
        await MarketingSuppression.deleteOne({ emailNormalized: normalizedEmail, reason: 'unsubscribe' });
        const existingSubscriber = await MarketingSubscriber.findOne({
          $or: [
            { userId: updatedUser._id },
            { email: normalizedEmail },
            { emailNormalized: normalizedEmail },
          ],
        }).select('_id');
        if (existingSubscriber) {
          await MarketingSubscriber.updateOne(
            { _id: existingSubscriber._id },
            {
              $set: {
                userId: updatedUser._id,
                email: normalizedEmail,
                emailNormalized: normalizedEmail,
                unsubscribedAt: null,
                subscribedAt: consentUpdatedAt,
                consentVerifiedAt: consentUpdatedAt,
              },
            },
          );
        } else {
          try {
            await MarketingSubscriber.create({
              userId: updatedUser._id,
              email: normalizedEmail,
              emailNormalized: normalizedEmail,
              unsubscribedAt: null,
              subscribedAt: consentUpdatedAt,
              consentVerifiedAt: consentUpdatedAt,
              interestedServices: [],
              serviceKeys: [],
              locale: 'en',
              unsubscribeToken: generateUnsubscribeToken(),
              source: 'user_sync',
            });
          } catch (error) {
            if ((error as { code?: unknown })?.code !== 11000) throw error;
            await MarketingSubscriber.updateOne(
              {
                $or: [
                  { userId: updatedUser._id },
                  { email: normalizedEmail },
                  { emailNormalized: normalizedEmail },
                ],
              },
              {
                $set: {
                  userId: updatedUser._id,
                  email: normalizedEmail,
                  emailNormalized: normalizedEmail,
                  unsubscribedAt: null,
                  subscribedAt: consentUpdatedAt,
                  consentVerifiedAt: consentUpdatedAt,
                },
              },
            );
          }
        }
        // Local consent is authoritative immediately, while a previously
        // blacklisted Brevo contact remains outside campaign audiences until
        // this provider reconciliation succeeds (or the daily retry does).
        await syncPendingBrevoResubscribes(1, normalizedEmail);
      } else {
        await MarketingSubscriber.updateMany(
          {
            $or: [
              { userId: updatedUser._id },
              { email: normalizedEmail },
              { emailNormalized: normalizedEmail },
            ],
          },
          {
            $set: { unsubscribedAt: consentUpdatedAt },
            $unset: { consentVerifiedAt: 1 },
          },
        );
      }
    }

    res.status(200).json({ success: true, msg: 'Preference updated' });
  } catch (err) {
    console.error('updateNotificationPreferences error:', err);
    res.status(500).json({ success: false, msg: 'Internal server error' });
  }
};
