import { IChangeEntry } from "../models/project";
import {
  getFieldCategory,
  moderateFieldValue,
  CATEGORY_A_FIELDS,
  CATEGORY_B_FIELDS,
  NO_REAPPROVAL_FIELDS,
} from "./contentModeration";

// All tracked fields for diff comparison
const TRACKED_FIELDS = [
  ...CATEGORY_A_FIELDS,
  ...CATEGORY_B_FIELDS,
  ...NO_REAPPROVAL_FIELDS,
];

/**
 * Recursively sort object keys to produce a deterministic structure.
 * Arrays are preserved in order; primitives pass through unchanged.
 */
function sortKeys(val: any): any {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(val).sort()) {
    if (key === "__v" || key === "_id" || key === "id") continue;
    sorted[key] = sortKeys(val[key]);
  }
  return sorted;
}

/**
 * Normalize a value for comparison by stripping Mongoose internals
 * and converting to a stable, deterministic JSON representation.
 */
function normalize(value: any): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "object") {
    // Convert Mongoose documents / ObjectIds to plain objects
    const plain =
      typeof value.toObject === "function"
        ? value.toObject()
        : typeof value.toJSON === "function"
        ? value.toJSON()
        : value;
    return JSON.stringify(sortKeys(plain));
  }
  return String(value);
}

/**
 * Compute the diff between the previous approved snapshot and the current project data.
 * Returns an array of change entries with category classification and moderation results.
 */
export function computeProjectDiff(
  previousSnapshot: Record<string, any>,
  currentData: Record<string, any>,
  companyName?: string
): IChangeEntry[] {
  const changes: IChangeEntry[] = [];

  for (const field of TRACKED_FIELDS) {
    const oldVal = previousSnapshot[field];
    const newVal = currentData[field];

    const oldNorm = normalize(oldVal);
    const newNorm = normalize(newVal);

    if (oldNorm === newNorm) continue;

    if (process.env.NODE_ENV !== "production") {
      console.log(`[DIFF] Field "${field}" changed | category: ${getFieldCategory(field)}`);
    }

    const category = getFieldCategory(field);

    const entry: IChangeEntry = {
      field,
      category,
      oldValue: oldVal ?? null,
      newValue: newVal ?? null,
    };

    // Run content moderation on Category B changes
    if (category === "B") {
      entry.moderationResult = moderateFieldValue(
        field,
        newVal,
        oldVal,
        companyName
      );
    }

    changes.push(entry);
  }

  return changes;
}

/**
 * Determine the reapproval type based on the computed changes.
 * - "full": any Category A change is present
 * - "moderation_failed": no Category A, but Category B moderation failed
 * - "none": only non-flagged changes (Category B passed + "none" fields)
 */
export function determineReapprovalType(
  changes: IChangeEntry[]
): "full" | "moderation_failed" | "none" {
  if (changes.length === 0) return "none";

  // Any Category A change → full reapproval
  if (changes.some((c) => c.category === "A")) return "full";

  // Any Category B moderation failure → moderation_failed
  if (
    changes.some(
      (c) => c.category === "B" && c.moderationResult && !c.moderationResult.passed
    )
  ) {
    return "moderation_failed";
  }

  // All changes are either "none" category or Category B that passed moderation
  return "none";
}
