import PlatformSettings from "../../models/platformSettings";
import User from "../../models/user";
import { UserFacingError } from "../appErrors";

/**
 * Support chat is opt-in. Missing/corrupt settings are treated as disabled so a
 * database hiccup can never enable a restricted channel.
 */
export async function isSupportChatEnabled(): Promise<boolean> {
  try {
    const settings = await PlatformSettings.findOne({ _id: "platform-settings" })
      .select("supportChatEnabled")
      .lean();
    return (settings as { supportChatEnabled?: boolean } | null)?.supportChatEnabled === true;
  } catch (error) {
    console.error("Failed to read supportChatEnabled setting:", error);
    return false;
  }
}

export async function assertSupportChatEnabled(): Promise<void> {
  if (!(await isSupportChatEnabled())) {
    throw new UserFacingError(
      403,
      "Support chat is currently disabled. Please open a support ticket instead.",
      "FORBIDDEN",
    );
  }
}

/**
 * Support chat is professional-only. Historical support conversations with
 * customers remain readable but cannot be written to anymore.
 */
export async function assertSupportChatTargetEligible(targetUserId: unknown): Promise<void> {
  if (typeof targetUserId !== "string" || !/^[a-f\d]{24}$/i.test(targetUserId)) {
    throw new UserFacingError(403, "Support chat is only available for professionals.", "FORBIDDEN");
  }
  const target = await User.findById(targetUserId).select("role deletedAt isAnonymized").lean();
  if (
    !target
    || (target as { role?: string }).role !== "professional"
    || (target as { deletedAt?: Date }).deletedAt
    || (target as { isAnonymized?: boolean }).isAnonymized
  ) {
    throw new UserFacingError(
      403,
      "Support chat is only available for active professional accounts.",
      "FORBIDDEN",
    );
  }
}

/** Gate applied by every write/send/upload path touching a support conversation. */
export async function assertSupportChatWriteAllowed(targetUserId: unknown): Promise<void> {
  await assertSupportChatEnabled();
  await assertSupportChatTargetEligible(targetUserId);
}

export function supportChannelsForRole(
  role: "customer" | "professional",
  supportChatEnabled: boolean,
): { tickets: true; meetings: boolean; chat: boolean } {
  const professional = role === "professional";
  return {
    tickets: true,
    meetings: professional,
    chat: professional && supportChatEnabled,
  };
}
