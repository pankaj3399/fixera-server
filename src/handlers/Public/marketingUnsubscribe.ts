import { Request, Response } from 'express';
import User from '../../models/user';
import MarketingSubscriber from '../../models/marketingSubscriber';
import MarketingSuppression from '../../models/marketingSuppression';
import MarketingLead from '../../models/marketingLead';
import {
  generateUnsubscribeToken,
  verifyUnsubscribePayload,
} from '../../utils/marketing/unsubscribeToken';
import { syncPendingBrevoUnsubscribes } from '../../utils/marketing/audience';
import { normalizeEmail } from '../../utils/marketing/normalizeEmail';

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: number | string }).code === 11000 ||
        (error as { code?: number | string }).code === '11000'),
  );
}

async function resolveUnsubscribeEmail(req: Request): Promise<
  { ok: true; email: string } | { ok: false; status: number; msg: string }
> {
  const token =
    (typeof req.body?.token === 'string' && req.body.token) ||
    (typeof req.query?.token === 'string' && req.query.token) ||
    '';
  const emailRaw =
    (typeof req.body?.email === 'string' && req.body.email) ||
    (typeof req.query?.email === 'string' && req.query.email) ||
    '';
  const subscriberToken =
    (typeof req.body?.subscriberToken === 'string' && req.body.subscriberToken) ||
    (typeof req.query?.subscriberToken === 'string' && req.query.subscriberToken) ||
    '';

  if (token) {
    const verified = verifyUnsubscribePayload(token);
    if (!verified.ok) {
      return { ok: false, status: 400, msg: verified.error };
    }
    return { ok: true, email: verified.email };
  }

  if (emailRaw && subscriberToken) {
    const sub = await MarketingSubscriber.findOne({
      email: emailRaw.toLowerCase().trim(),
      unsubscribeToken: subscriberToken,
    });
    if (!sub) {
      return { ok: false, status: 400, msg: 'Invalid unsubscribe link' };
    }
    return { ok: true, email: sub.email };
  }

  return { ok: false, status: 400, msg: 'Missing unsubscribe token' };
}

async function applyUnsubscribe(email: string): Promise<{ already: boolean }> {
  const normalized = normalizeEmail(email);
  const now = new Date();
  const preexistingSuppression = await MarketingSuppression.exists({
    emailNormalized: normalized,
  });
  // Preserve a stronger provider/admin reason. A local unsubscribe must not
  // weaken the global suppression that already protects this mailbox.
  try {
    await MarketingSuppression.findOneAndUpdate(
      { emailNormalized: normalized },
      {
        $setOnInsert: {
          emailNormalized: normalized,
          reason: 'unsubscribe',
          source: 'user',
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error: unknown) {
    // A concurrent unsubscribe may win the unique-email insert race.
    if (!isDuplicateKeyError(error)) throw error;
  }
  await User.updateMany(
    { email: normalized },
    {
      $set: { 'notificationPreferences.promotions.email': false },
      $unset: { marketingConsentAt: 1 },
    },
  );

  let already = false;
  const existing = await MarketingSubscriber.findOne({
    $or: [{ email: normalized }, { emailNormalized: normalized }],
  })
    .select('+unsubscribeToken unsubscribedAt')
    .lean();
  if (existing) {
    already = Boolean(existing.unsubscribedAt);
    await MarketingSubscriber.updateOne(
      { _id: existing._id },
      {
        ...(already ? {} : { $set: { unsubscribedAt: now } }),
        $unset: { consentVerifiedAt: 1 },
      },
    );
  } else {
    try {
      await MarketingSubscriber.create({
        email: normalized,
        emailNormalized: normalized,
        unsubscribedAt: now,
        interestedServices: [],
        locale: 'en',
        unsubscribeToken: generateUnsubscribeToken(),
        source: 'manual',
        subscribedAt: now,
      });
    } catch (error: unknown) {
      if (!isDuplicateKeyError(error)) throw error;
      // A simultaneous create won the unique-email race — preserve its opt-out stamp.
      const raced = await MarketingSubscriber.findOneAndUpdate(
        {
          $or: [{ email: normalized }, { emailNormalized: normalized }],
          unsubscribedAt: null,
        },
        { $set: { unsubscribedAt: now }, $unset: { consentVerifiedAt: 1 } },
        { new: false },
      );
      already = raced ? Boolean(raced.unsubscribedAt) : true;
      if (!raced) {
        await MarketingSubscriber.updateOne(
          { $or: [{ email: normalized }, { emailNormalized: normalized }] },
          { $unset: { consentVerifiedAt: 1 } },
        );
      }
    }
  }

  await MarketingLead.updateMany(
    { emailNormalized: normalized, status: 'active', unsubscribedAt: null },
    { $set: { unsubscribedAt: now } },
  );

  return { already: already || Boolean(preexistingSuppression) };
}

/**
 * GET: verify token / preview only (no mutation). Frontend should confirm via POST.
 * POST: perform unsubscribe.
 */
export const unsubscribeMarketing = async (req: Request, res: Response) => {
  try {
    const resolved = await resolveUnsubscribeEmail(req);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ success: false, msg: resolved.msg });
    }
    const { email } = resolved;

    if (req.method === 'GET') {
      const normalized = email.toLowerCase().trim();
      const [sub, suppression] = await Promise.all([
        MarketingSubscriber.findOne({ email: normalized })
          .select('unsubscribedAt')
          .lean(),
        MarketingSuppression.exists({ emailNormalized: normalized }),
      ]);
      const alreadyUnsubscribed = Boolean(sub?.unsubscribedAt || suppression);
      return res.json({
        success: true,
        data: {
          email,
          alreadyUnsubscribed,
          requiresConfirmation: !alreadyUnsubscribed,
          message: alreadyUnsubscribed
            ? 'You were already unsubscribed from promotional emails.'
            : 'Confirm unsubscribe by submitting a POST request to this endpoint.',
        },
      });
    }

    const result = await applyUnsubscribe(email);
    // Local consent is authoritative immediately. Brevo suppression is retried
    // by the daily cron if the provider is unavailable right now.
    await syncPendingBrevoUnsubscribes(1, email);
    return res.json({
      success: true,
      data: {
        email,
        alreadyUnsubscribed: result.already,
        message: result.already
          ? 'You were already unsubscribed from promotional emails.'
          : 'You have been unsubscribed from promotional emails.',
      },
    });
  } catch (error: any) {
    console.error('unsubscribeMarketing:', error);
    return res.status(500).json({ success: false, msg: "We couldn't process your unsubscribe request. Please try again." });
  }
};
