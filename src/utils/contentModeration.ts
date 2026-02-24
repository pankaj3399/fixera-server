import leoProfanity from "leo-profanity";

// Load French dictionary in addition to the default English one
try {
  const frenchWords = leoProfanity.getDictionary("fr");
  leoProfanity.add(frenchWords);
} catch {
  // French dictionary not available; continue with English only
}

// Category A: Always require admin review (structural/classification changes)
export const CATEGORY_A_FIELDS = [
  "category",
  "service",
  "areaOfWork",
  "certifications",
  "services",
  "categories",
  "serviceConfigurationId",
];

// Category B: Auto-check text, flag media changes (content changes)
export const CATEGORY_B_FIELDS = [
  "title",
  "description",
  "media",
  "subprojects",
  "extraOptions",
  "termsConditions",
  "faq",
  "rfqQuestions",
  "postBookingQuestions",
  "customConfirmationMessage",
];

// Fields that don't require reapproval (operational/config changes)
export const NO_REAPPROVAL_FIELDS = [
  "distance",
  "resources",
  "intakeMeeting",
  "renovationPlanning",
  "priceModel",
  "keywords",
  "timeMode",
  "preparationDuration",
  "executionDuration",
  "bufferDuration",
  "minResources",
  "minOverlapPercentage",
];

export function getFieldCategory(field: string): "A" | "B" | "none" {
  // Handle nested fields like "subprojects.0.name"
  const topLevel = field.split(".")[0];

  if (CATEGORY_A_FIELDS.includes(topLevel)) return "A";
  if (CATEGORY_B_FIELDS.includes(topLevel)) return "B";
  return "none";
}

export interface ModerationResult {
  passed: boolean;
  reasons: string[];
}

/**
 * Moderate text content for profanity and company name leakage.
 */
export function moderateText(
  text: string,
  companyName?: string
): ModerationResult {
  const reasons: string[] = [];

  if (!text || typeof text !== "string") {
    return { passed: true, reasons: [] };
  }

  // Check for profanity
  if (leoProfanity.check(text)) {
    reasons.push("Contains inappropriate language");
  }

  // Check for company name in content (professionals shouldn't embed their company name)
  if (companyName && companyName.length > 2) {
    const escapedCompany = companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const companyRegex = new RegExp(`\\b${escapedCompany}\\b`, "i");
    if (companyRegex.test(text)) {
      reasons.push(`Contains company name "${companyName}"`);
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

/**
 * Moderate a Category B field value. Returns moderation result.
 * - For text fields: runs profanity + company name check
 * - For media: flags any new/changed images or videos for admin review
 * - For arrays (subprojects, FAQ, etc.): extracts text and checks each item
 */
export function moderateFieldValue(
  field: string,
  newValue: any,
  _oldValue: any, // Reserved for future delta-based moderation
  companyName?: string
): ModerationResult {
  // Media always needs manual review if changed
  if (field === "media") {
    return {
      passed: false,
      reasons: ["Media changes require admin review"],
    };
  }

  // Simple text fields
  if (typeof newValue === "string") {
    return moderateText(newValue, companyName);
  }

  // Array fields - extract all text content and check
  if (Array.isArray(newValue)) {
    const allReasons: string[] = [];

    for (const item of newValue) {
      if (typeof item === "string") {
        const result = moderateText(item, companyName);
        if (!result.passed) allReasons.push(...result.reasons);
        continue;
      }
      if (typeof item === "object" && item !== null) {
        // Check common text fields in nested objects
        for (const key of [
          "name",
          "description",
          "question",
          "answer",
          "customConfirmationMessage",
        ]) {
          if (typeof item[key] === "string") {
            const result = moderateText(item[key], companyName);
            if (!result.passed) {
              allReasons.push(
                ...result.reasons.map((r) => `${field}.${key}: ${r}`)
              );
            }
          }
        }
        // Check options array (e.g., multiple choice options)
        if (Array.isArray(item.options)) {
          item.options.forEach((opt: unknown, optIdx: number) => {
            if (typeof opt === "string") {
              const result = moderateText(opt, companyName);
              if (!result.passed) {
                allReasons.push(
                  ...result.reasons.map((r) => `${field}.options[${optIdx}]: ${r}`)
                );
              }
            }
          });
        }
        // Check professionalAttachments descriptions (string entries)
        if (Array.isArray(item.professionalAttachments)) {
          item.professionalAttachments.forEach((att: unknown, attIdx: number) => {
            if (typeof att === "string" && !att.startsWith("http")) {
              const result = moderateText(att, companyName);
              if (!result.passed) {
                allReasons.push(
                  ...result.reasons.map((r) => `${field}.professionalAttachments[${attIdx}]: ${r}`)
                );
              }
            }
          });
        }
      }
    }

    // Deduplicate reasons
    const uniqueReasons = [...new Set(allReasons)];
    return {
      passed: uniqueReasons.length === 0,
      reasons: uniqueReasons,
    };
  }

  return { passed: true, reasons: [] };
}
