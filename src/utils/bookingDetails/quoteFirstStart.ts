import mongoose from "mongoose";
import Project from "../../models/project";
import User from "../../models/user";
import { buildProjectScheduleProposalsWithData } from "../scheduleEngine";

export type QuoteDurationInput = {
  value: number;
  unit: "hours" | "days";
};

export type QuoteFirstStartDurations = {
  executionDuration?: QuoteDurationInput | null;
  preparationDuration?: QuoteDurationInput | null;
  bufferDuration?: QuoteDurationInput | null;
};

/**
 * Map schedule-engine proposals to the persisted quote-table start.
 * Prefers the concrete earliest proposal window; falls back to the earliest
 * bookable day only when the engine found a real day (never the prepEnd
 * fallback it returns when nothing is bookable within 180 days).
 * Never uses the customer preferred date: that is a request, not availability.
 */
export function resolveQuoteFirstStartFromProposals(proposals: any): Date | null {
  if (!proposals || typeof proposals !== "object") return null;
  const debug = (proposals as any)._debug;
  const usedFallback = debug?.usedFallback === true;
  const pick = (value: unknown): Date | null => {
    if (value == null) return null;
    const time = value instanceof Date ? value.getTime() : new Date(value as any).getTime();
    return Number.isFinite(time) ? new Date(time) : null;
  };
  const proposalStart = pick((proposals as any).earliestProposal?.start);
  if (proposalStart) return proposalStart;
  if (usedFallback) return null;
  return pick((proposals as any).earliestBookableDate);
}

const normalizeDuration = (value: unknown, opts: { allowZero: boolean }): QuoteDurationInput | null => {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const numeric = Number(record.value);
  const unit = String(record.unit || "");
  if (!Number.isFinite(numeric)) return null;
  if (unit !== "hours" && unit !== "days") return null;
  if (numeric < 0) return null;
  if (!opts.allowZero && numeric <= 0) return null;
  return { value: numeric, unit: unit as "hours" | "days" };
};

/**
 * Server-side first-possible-start for one quote version. Read-only against
 * the quantity-aware schedule engine (resource/calendar/lead-time/timezone);
 * never reserves. Returns null when unavailable or when inputs are
 * insufficient (professional-only RFQ without a project, missing execution
 * duration, unknown project/professional, engine without resources).
 */
export async function computeQuoteFirstPossibleStart(args: {
  projectId?: string | null;
  subprojectIndex?: number;
  quantity?: number;
  executionDuration?: unknown;
  preparationDuration?: unknown;
  bufferDuration?: unknown;
  excludeBookingId?: string | null;
}): Promise<Date | null> {
  try {
    const projectId = typeof args.projectId === "string" ? args.projectId : null;
    if (!projectId || !mongoose.isValidObjectId(projectId)) return null;
    const execution = normalizeDuration(args.executionDuration, { allowZero: false });
    if (!execution) return null;
    const preparation = normalizeDuration(args.preparationDuration, { allowZero: true });
    const buffer = normalizeDuration(args.bufferDuration, { allowZero: true });
    const quantity =
      typeof args.quantity === "number" && Number.isFinite(args.quantity) && args.quantity > 0
        ? args.quantity
        : 1;

    const project = await Project.findById(projectId).lean();
    if (!project) return null;
    const professionalId = String((project as any).professionalId || "");
    if (!professionalId || !mongoose.isValidObjectId(professionalId)) return null;
    const professional = await User.findById(professionalId).select(
      "companyAvailability companyBlockedDates companyBlockedRanges businessInfo.timezone"
    ).lean();
    if (!professional) return null;

    const subprojectIndex =
      typeof args.subprojectIndex === "number" && Number.isInteger(args.subprojectIndex) && args.subprojectIndex >= 0
        ? args.subprojectIndex
        : undefined;
    const proposals = await buildProjectScheduleProposalsWithData(
      project as any,
      professional as any,
      subprojectIndex,
      {
        execution,
        preparation: preparation || { value: 0, unit: "hours" as const },
        buffer: buffer || { value: 0, unit: "hours" as const },
      },
      typeof args.excludeBookingId === "string" && mongoose.isValidObjectId(args.excludeBookingId)
        ? args.excludeBookingId
        : undefined,
      quantity
    );
    return resolveQuoteFirstStartFromProposals(proposals);
  } catch (error) {
    console.warn("computeQuoteFirstPossibleStart failed, leaving unknown:", (error as Error)?.message || error);
    return null;
  }
}

/**
 * Booking-aware wrapper for the quotation writer seam. Quantity is frozen
 * from the booking snapshots (never a live re-read); the customer's
 * preferred date is deliberately ignored.
 */
export async function computeQuoteFirstPossibleStartForBooking(
  booking: any,
  durations: QuoteFirstStartDurations
): Promise<Date | null> {
  const rawProject = (booking as any)?.project;
  const projectId =
    typeof rawProject === "string"
      ? rawProject
      : typeof rawProject?._id?.toString === "function"
        ? rawProject._id.toString()
        : typeof rawProject?.toString === "function" && mongoose.isValidObjectId(String(rawProject))
          ? String(rawProject)
          : null;
  if (!projectId) return null;
  const rawIndex = (booking as any)?.selectedSubprojectIndex;
  const subprojectIndex = typeof rawIndex === "number" ? rawIndex : undefined;
  const snapshotQuantity = Number(
    (booking as any)?.scheduleSnapshot?.quantity ?? (booking as any)?.checkoutSnapshot?.quantity ?? 1
  );
  const excludeBookingId = (() => {
    const id = (booking as any)?._id;
    if (id == null) return null;
    if (typeof id?.toHexString === "function") return id.toHexString();
    const text = String(id);
    return mongoose.isValidObjectId(text) ? text : null;
  })();
  return computeQuoteFirstPossibleStart({
    projectId,
    subprojectIndex,
    quantity: Number.isFinite(snapshotQuantity) && snapshotQuantity > 0 ? snapshotQuantity : 1,
    executionDuration: durations?.executionDuration,
    preparationDuration: durations?.preparationDuration,
    bufferDuration: durations?.bufferDuration,
    excludeBookingId,
  });
}
