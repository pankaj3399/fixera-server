import { Request, Response } from "express";
import connectDB from "../../config/db";
import User, { type IUser } from "../../models/user";
import { UserFacingError } from "../../utils/appErrors";
import { sendHandlerError } from "../../utils/handlerErrors";
import { getEffectiveAccessForUser } from "../../utils/adminRbac/roleAccess";
import { isEligibleSupportAdmin } from "../../utils/support/availability";
import {
  normalizeDefaultSupportMeetingLink,
  safeSupportMeetingLink,
} from "../../utils/support/meetingLink";

function adminUser(req: Request): IUser {
  const admin = (req as Request & { admin?: IUser }).admin;
  if (!admin) throw new UserFacingError(401, "Admin authentication required.", "AUTH_REQUIRED");
  return admin;
}

async function serializeSettings(admin: IUser) {
  const url = safeSupportMeetingLink(admin.supportMeetingLink?.url);
  let receivesMeetings = false;
  try {
    receivesMeetings = isEligibleSupportAdmin(admin, await getEffectiveAccessForUser(admin));
  } catch {
    receivesMeetings = false;
  }
  return {
    meetingLink: url,
    provider: url ? admin.supportMeetingLink?.provider || "other" : null,
    updatedAt: url && admin.supportMeetingLink?.updatedAt
      ? new Date(admin.supportMeetingLink.updatedAt).toISOString()
      : null,
    /** True when this admin's availability is offered to professionals. */
    receivesMeetings,
  };
}

/** GET /api/admin/support/meeting-link-settings — the signed-in admin's default link. */
export const getSupportMeetingLinkSettings = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    return res.status(200).json({ success: true, data: await serializeSettings(admin) });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't load your meeting link settings. Please try again.");
  }
};

/**
 * PUT /api/admin/support/meeting-link-settings — save or clear the signed-in
 * admin's default meeting link. Requires support write access (route RBAC).
 * Existing tickets are never rewritten: the default only applies on submit.
 */
export const updateSupportMeetingLinkSettings = async (req: Request, res: Response) => {
  try {
    const admin = adminUser(req);
    await connectDB();
    const body = (req.body || {}) as Record<string, unknown>;
    if (!("meetingLink" in body)) {
      throw new UserFacingError(400, "A valid meeting link is required.", "VALIDATION", "meetingLink");
    }
    const normalized = normalizeDefaultSupportMeetingLink(body.meetingLink);
    const update = normalized
      ? {
          $set: {
            supportMeetingLink: {
              url: normalized.url,
              provider: normalized.provider,
              updatedAt: new Date(),
            },
          },
        }
      : { $unset: { supportMeetingLink: 1 } };
    const saved = await User.findOneAndUpdate(
      { _id: admin._id, role: "admin" },
      update,
      { new: true },
    );
    if (!saved) throw new UserFacingError(404, "Admin account not found.", "NOT_FOUND");
    return res.status(200).json({ success: true, data: await serializeSettings(saved) });
  } catch (error) {
    return sendHandlerError(res, error, "We couldn't save your meeting link. Please try again.");
  }
};
