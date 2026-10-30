import { Request, Response } from "express";
import connectDB from "../../config/db";
import LoyaltyConfig from "../../models/loyaltyConfig";
import ProfessionalLevelConfig from "../../models/professionalLevelConfig";

const MAX_BADGE_LENGTH = 40;

/**
 * Admin-authored free text served on a public endpoint. Strip markup and
 * control characters, cap length, and fall back to undefined when empty so
 * the frontend never renders raw HTML or layout-breaking strings.
 */
const sanitizeBadge = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const withoutMarkup = value.replace(/<[^>]*>/g, "");
  // Drop C0 control characters and DEL by code point (charCodeAt keeps this
  // free of raw escape sequences and surrogate-safe via Array.from).
  const withoutControls = Array.from(withoutMarkup)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  const stripped = withoutControls.trim();
  if (!stripped) return undefined;
  return stripped.slice(0, MAX_BADGE_LENGTH);
};

/**
 * Public read-only tier/level metadata for tag colours.
 *
 * The frontend colours loyalty/professional tags from the admin-configured
 * `color` (with model defaults as fallback). Only display-safe fields are
 * exposed; thresholds and internal config metadata stay admin-only.
 */
export const getPublicLoyaltyTiers = async (_req: Request, res: Response) => {
  try {
    await connectDB();
    const config = await LoyaltyConfig.getCurrentConfig();
    const tiers = (config.tiers || [])
      .filter((tier: any) => tier?.isActive !== false)
      .sort((a: any, b: any) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
      .map((tier: any) => ({
        name: String(tier?.name || ""),
        color: typeof tier?.color === "string" && tier.color ? tier.color : "#6B7280",
        icon: typeof tier?.icon === "string" && tier.icon ? tier.icon : "star",
        order: Number(tier?.order) || 0,
      }))
      .filter((tier: any) => tier.name);
    return res.status(200).json({ success: true, data: { tiers } });
  } catch (error) {
    console.error("Public loyalty tiers error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load loyalty tiers" });
  }
};

export const getPublicProfessionalLevels = async (_req: Request, res: Response) => {
  try {
    await connectDB();
    const config = await ProfessionalLevelConfig.getCurrentConfig();
    const levels = (config.levels || [])
      .filter((level: any) => level?.isActive !== false)
      .sort((a: any, b: any) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
      .map((level: any) => ({
        name: String(level?.name || ""),
        color: typeof level?.color === "string" && level.color ? level.color : "#6B7280",
        icon: typeof level?.icon === "string" && level.icon ? level.icon : "star",
        badge: sanitizeBadge(level?.perks?.badge),
        order: Number(level?.order) || 0,
      }))
      .filter((level: any) => level.name);
    return res.status(200).json({ success: true, data: { levels } });
  } catch (error) {
    console.error("Public professional levels error:", error);
    return res.status(500).json({ success: false, msg: "Failed to load professional levels" });
  }
};
