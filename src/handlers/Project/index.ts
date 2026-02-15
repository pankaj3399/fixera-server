//fixera-server/src/handlers/Project/index.ts
import { Request, Response } from "express";
import mongoose from "mongoose";
import Project from "../../models/project";
import Booking from "../../models/booking";
import ServiceCategory from "../../models/serviceCategory";
import User from "../../models/user";
import { buildProjectScheduleProposals, buildProjectScheduleWindow, getResourcePolicy, toZonedTime, fromZonedTime, type ResourcePolicy } from "../../utils/scheduleEngine";
import { resolveAvailability } from "../../utils/availabilityHelpers";
import { normalizePreparationDuration } from "../../utils/projectDurations";
// import { seedServiceCategories } from '../../scripts/seedProject';

const toIsoDate = (value?: Date | string | null) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const toBlockedRange = (range?: {
  startDate?: Date | string;
  endDate?: Date | string;
  reason?: string;
}) => {
  if (!range?.startDate || !range?.endDate) return null;
  const startDate = toIsoDate(range.startDate);
  const endDate = toIsoDate(range.endDate);
  if (!startDate || !endDate) return null;
  return {
    startDate,
    endDate,
    reason: range.reason,
  };
};

const getDateRange = (start?: string, end?: string, fallbackDays = 180) => {
  const rangeStart = start ? new Date(start) : new Date();
  const rangeEnd = end ? new Date(end) : new Date(rangeStart);

  if (Number.isNaN(rangeStart.getTime())) {
    rangeStart.setTime(Date.now());
  }
  if (Number.isNaN(rangeEnd.getTime())) {
    rangeEnd.setTime(rangeStart.getTime());
  }

  rangeStart.setHours(0, 0, 0, 0);
  if (!end) {
    rangeEnd.setDate(rangeStart.getDate() + fallbackDays);
  }
  rangeEnd.setHours(0, 0, 0, 0);

  if (rangeEnd <= rangeStart) {
    rangeEnd.setDate(rangeStart.getDate() + fallbackDays);
  }

  return { rangeStart, rangeEnd };
};

const toLocalMidnightUtc = (date: Date, timeZone: string) => {
  const zoned = toZonedTime(date, timeZone);
  const localMidnightZoned = new Date(
    Date.UTC(
      zoned.getUTCFullYear(),
      zoned.getUTCMonth(),
      zoned.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
  return fromZonedTime(localMidnightZoned, timeZone);
};

const buildNonWorkingDates = (
  rangeStart: Date,
  rangeEnd: Date,
  timeZone: string,
  availability: Record<string, any>
) => {
  const nonWorking: string[] = [];
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const zoned = toZonedTime(cursor, timeZone);
    const dayAvailability = availability[dayNames[zoned.getUTCDay()]];
    if (!dayAvailability || dayAvailability.available === false) {
      nonWorking.push(toLocalMidnightUtc(cursor, timeZone).toISOString());
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nonWorking;
};

/**
 * Parse and validate subprojectIndex query parameter.
 * Returns a validated index or an error indicator for consistent 400 responses.
 */
type SubprojectIndexResult =
  | { valid: true; index: number | undefined }
  | { valid: false; error: string };

const parseSubprojectIndex = (
  subprojectIndexRaw: string | undefined,
  subprojectsLength: number
): SubprojectIndexResult => {
  if (subprojectIndexRaw === undefined) {
    return { valid: true, index: undefined };
  }

  const parsed = Number(subprojectIndexRaw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return {
      valid: false,
      error: "Invalid subprojectIndex: expected a whole number.",
    };
  }

  if (parsed < 0 || parsed >= subprojectsLength) {
    return {
      valid: false,
      error: "Invalid subprojectIndex: out of range for this project.",
    };
  }

  return { valid: true, index: parsed };
};

export const seedData = async (req: Request, res: Response) => {
  try {
    // await seedServiceCategories();
    res.json({
      message: "Service categories seeded successfully (function disabled)",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to seed service categories" });
  }
};

export const getCategories = async (req: Request, res: Response) => {
  try {
    const country = (req.query.country as string) || "BE";
    const categories = await ServiceCategory.find({
      isActive: true,
      countries: country,
    }).select("name slug description icon services");

    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch categories" });
  }
};

export const getCategoryServices = async (req: Request, res: Response) => {
  try {
    const { categorySlug } = req.params;
    const country = (req.query.country as string) || "BE";

    const category = await ServiceCategory.findOne({
      slug: categorySlug,
      isActive: true,
      countries: country,
    });

    if (!category) {
      return res.status(404).json({ error: "Category not found" });
    }

    const services = category.services.filter(
      (service) => service.isActive && service.countries.includes(country)
    );

    res.json(services);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch services" });
  }
};

export const createOrUpdateDraft = async (req: Request, res: Response) => {
  try {
    console.log("[PROJECT] SAVE PROJECT REQUEST RECEIVED");
    console.log("User ID:", req.user?.id);
    console.log("Request body keys:", Object.keys(req.body));
    console.log("Project ID from request:", req.body.id);

    const professionalId = req.user?.id;
    const projectData = normalizePreparationDuration(req.body);

    if (!professionalId) {
      console.log("[PROJECT] No professional ID found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    let project;

    if (projectData.id) {
      console.log(`[PROJECT] Updating existing project: ${projectData.id}`);
      console.log("Professional ID:", professionalId);

      // First check if project exists
      const existingProject = await Project.findOne({
        _id: projectData.id,
        professionalId,
      });
      console.log("Existing project found:", !!existingProject);
      console.log("Existing project status:", existingProject?.status);
      console.log("Existing project title:", existingProject?.title);

      if (!existingProject) {
        console.log("[PROJECT] Project not found or not owned by user");
        return res.status(404).json({ error: "Project not found" });
      }

      // Log what fields are being updated
      console.log("[PROJECT] Fields being updated:");
      console.log("- Title:", projectData.title);
      console.log(
        "- Description length:",
        projectData.description?.length || 0
      );
      console.log("- Category:", projectData.category);
      console.log("- Service:", projectData.service);

      // Allow updates to existing projects regardless of status for editing
      const updateData: any = {
        ...projectData,
        autoSaveTimestamp: new Date(),
        updatedAt: new Date(),
      };

      // If a published/on_hold project is edited, move it back to pending for re-approval
      const shouldMoveToPending = ["published", "on_hold"].includes(
        (existingProject.status as any) || ""
      );
      if (shouldMoveToPending) {
        updateData.status = "pending";
        updateData.submittedAt = new Date();
        updateData.adminFeedback = undefined;
        updateData.approvedAt = undefined;
        updateData.approvedBy = undefined;
      }

      console.log("[PROJECT] Update query:", { _id: projectData.id, professionalId });
      console.log("[PROJECT] Update data keys:", Object.keys(updateData));

      project = await Project.findOneAndUpdate(
        { _id: projectData.id, professionalId },
        updateData,
        { new: true, runValidators: true }
      );

      console.log("[PROJECT] Project updated successfully");
      console.log("Updated project ID:", project?._id);
      console.log("Updated project title:", project?.title);
      console.log("Updated project status:", project?.status);
    } else {
      console.log("[PROJECT] Creating new project");
      project = new Project({
        ...projectData,
        professionalId,
        status: "draft",
        autoSaveTimestamp: new Date(),
      });
      await project.save();
      console.log("[PROJECT] New project created with ID:", project._id);
    }

    console.log("[PROJECT] Sending response - project save complete");
    console.log("Response project ID:", project?._id);
    console.log("Response status code: 200");

    res.json(project);
  } catch (error: any) {
    console.error("[PROJECT] Auto-save error:", error);
    console.error("Error stack:", error.stack);
    res
      .status(500)
      .json({ error: "Failed to save project draft", details: error.message });
  }
};

export const getDrafts = async (req: Request, res: Response) => {
  try {
    const professionalId = req.user?.id;
    const drafts = await Project.find({
      professionalId,
      status: "draft",
    }).sort({ autoSaveTimestamp: -1 });

    res.json(drafts);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch drafts" });
  }
};

export const getAllProjects = async (req: Request, res: Response) => {
  try {
    const professionalId = req.user?.id;
    const projects = await Project.find({
      professionalId,
    }).sort({ updatedAt: -1 });

    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
};

export const getProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const professionalId = req.user?.id;

    const project = await Project.findOne({
      _id: id,
      professionalId,
    });

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(project);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch project" });
  }
};

// Public endpoint - Get published project by ID (for customers to view/book)
export const getPublishedProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      status: "published",
    }).populate('professionalId', 'name businessInfo.companyName email phone');

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found or not published"
      });
    }

    res.json({
      success: true,
      project
    });
  } catch (error) {
    console.error('Error fetching published project:', error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch project"
    });
  }
};

// Public endpoint - Get team availability (blocked dates) for a project
export const getProjectTeamAvailability = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const subprojectIndexRaw = req.query.subprojectIndex as string | undefined;
    const debugEnabled =
      process.env.ENABLE_DEBUG_PAYLOAD === "true" ||
      (typeof req.query.debug === "string" &&
        req.query.debug.toLowerCase() === "true") ||
      (process.env.DEBUG_PAYLOAD_SECRET &&
        req.headers["x-debug-payload"] === process.env.DEBUG_PAYLOAD_SECRET);

    const project = await Project.findOne({
      _id: id,
      status: "published",
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found"
      });
    }

    const subprojects = Array.isArray(project.subprojects)
      ? project.subprojects
      : [];
    const subprojectIndexResult = parseSubprojectIndex(
      subprojectIndexRaw,
      subprojects.length
    );
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({
        success: false,
        error: subprojectIndexResult.error,
      });
    }
    const subprojectIndex = subprojectIndexResult.index;

    const teamMemberIds = project.resources || [];

    // Validate and convert team member IDs once, before any queries
    // This prevents Mongoose CastError when project.resources contains invalid ObjectIds
    const validatedTeamMemberIds: mongoose.Types.ObjectId[] = [];
    if (Array.isArray(teamMemberIds)) {
      for (const memberId of teamMemberIds) {
        if (memberId == null) {
          console.warn(
            `[getProjectTeamAvailability] Skipping null/undefined team member ID in project.resources for project ${project._id}`
          );
          continue;
        }

        // Handle string IDs
        if (typeof memberId === 'string') {
          if (mongoose.isValidObjectId(memberId)) {
            validatedTeamMemberIds.push(new mongoose.Types.ObjectId(memberId));
          } else {
            console.warn(
              `[getProjectTeamAvailability] Skipping invalid string team member ID "${memberId}" in project.resources for project ${project._id}`
            );
          }
          continue;
        }

        // Handle existing ObjectId instances or objects with toString
        const memberIdStr = String(memberId);
        if (mongoose.isValidObjectId(memberIdStr)) {
          validatedTeamMemberIds.push(new mongoose.Types.ObjectId(memberIdStr));
        } else {
          console.warn(
            `[getProjectTeamAvailability] Skipping invalid team member ID (type: ${typeof memberId}, value: ${memberIdStr}) in project.resources for project ${project._id}`
          );
        }
      }
    }

    const professional = await User.findById(project.professionalId).select(
      "companyAvailability companyBlockedDates companyBlockedRanges blockedDates blockedRanges businessInfo.timezone"
    );

    // Get professional's timezone for proper date handling
    const timeZone = professional?.businessInfo?.timezone || "UTC";

    const availability = resolveAvailability(professional?.companyAvailability);
    const { rangeStart, rangeEnd } = getDateRange(startDate, endDate, 180);
    const nonWorkingDates = buildNonWorkingDates(
      rangeStart,
      rangeEnd,
      timeZone,
      availability
    );

    const blockedCategories = {
      weekends: nonWorkingDates,
      company: {
        dates: [] as string[],
        ranges: [] as Array<{ startDate: string; endDate: string; reason?: string }>,
      },
      personal: {
        dates: [] as string[],
        ranges: [] as Array<{ startDate: string; endDate: string; reason?: string }>,
      },
      bookings: {
        ranges: [] as Array<{ startDate: string; endDate: string; reason?: string }>,
      },
    };

    // Helper to normalize a date key to the professional's local midnight
    const normalizeDateKey = (dateIso: string): string => {
      const date = new Date(dateIso);
      if (Number.isNaN(date.getTime())) return "";
      return toLocalMidnightUtc(date, timeZone).toISOString();
    };

    // Get resource policy to determine if we need multi-resource logic
    const resourcePolicy = getResourcePolicy(project);
    const { minResources, totalResources } = resourcePolicy;

    // Track blocked members per date for multi-resource logic
    // Key: date ISO string (normalized to local midnight UTC), Value: Set of member IDs blocked on that date
    const dateBlockedMembers = new Map<string, Set<string>>();

    // Helper to mark a member as blocked on a date
    const markMemberBlocked = (dateIso: string, memberId: string) => {
      const dateKey = normalizeDateKey(dateIso);
      if (!dateKey) return;
      if (!dateBlockedMembers.has(dateKey)) {
        dateBlockedMembers.set(dateKey, new Set());
      }
      dateBlockedMembers.get(dateKey)!.add(memberId);
    };

    // Helper to expand a date range and mark member as blocked for each day
    // Uses professional's timezone to determine which calendar days are affected
    const expandRangeAndMarkBlocked = (startIso: string, endIso: string, memberId: string) => {
      const start = new Date(startIso);
      const end = new Date(endIso);

      // Validate dates before processing
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        console.warn(`[getProjectTeamAvailability] Invalid date range for member ${memberId}: ${startIso} - ${endIso}`);
        return;
      }

      // Convert to professional's timezone to get correct calendar days
      const startZoned = toZonedTime(start, timeZone);
      const endZoned = toZonedTime(end, timeZone);

      // Get calendar days in the professional's timezone
      const startDay = new Date(Date.UTC(startZoned.getUTCFullYear(), startZoned.getUTCMonth(), startZoned.getUTCDate()));
      const endDay = new Date(Date.UTC(endZoned.getUTCFullYear(), endZoned.getUTCMonth(), endZoned.getUTCDate()));

      const cursor = new Date(startDay);
      while (cursor <= endDay) {
        markMemberBlocked(cursor.toISOString(), memberId);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    };

    // Company blocked dates/ranges block ALL resources - add directly to allBlockedDates
    const allBlockedDates = new Set<string>(nonWorkingDates);
    const allBlockedRanges: Array<{ startDate: string; endDate: string; reason?: string }> = [];

    if (professional?.companyBlockedDates) {
      professional.companyBlockedDates.forEach((blocked) => {
        const date = toIsoDate(blocked.date);
        if (!date) return;
        blockedCategories.company.dates.push(date);
        const normalizedDate = normalizeDateKey(date);
        if (normalizedDate) {
          allBlockedDates.add(normalizedDate); // Company dates always fully blocked
        }
      });
    }

    if (professional?.companyBlockedRanges) {
      professional.companyBlockedRanges.forEach((range) => {
        const blockedRange = toBlockedRange(range);
        if (!blockedRange) return;
        blockedCategories.company.ranges.push(blockedRange);
        allBlockedRanges.push(blockedRange); // Company ranges always fully blocked
      });
    }

    // Fetch team members (name only needed for debug payloads)
    const teamMembers =
      validatedTeamMemberIds.length > 0
        ? await User.find({
          _id: { $in: validatedTeamMemberIds },
        }).select(
          debugEnabled
            ? "_id name blockedDates blockedRanges"
            : "_id blockedDates blockedRanges"
        )
        : [];

    type TeamMemberDebugInfo = Record<
      string,
      {
        name: string;
        personalBlockedDates: string[];
        personalBlockedRanges: any[];
        bookingBlockedDates: string[];
      }
    >;
    const teamMemberDebugInfo: TeamMemberDebugInfo | null = debugEnabled
      ? {}
      : null;
    if (debugEnabled) {
      teamMembers.forEach((member) => {
        const memberId = String(member._id);
        teamMemberDebugInfo![memberId] = {
          name: (member as any).name || "Unknown",
          personalBlockedDates: [],
          personalBlockedRanges: [],
          bookingBlockedDates: [],
        };
      });
    }

    // Process personal blocked dates for each team member (tracked per-member)
    teamMembers.forEach((member) => {
      const memberId = String(member._id);

      if (member.blockedDates) {
        member.blockedDates.forEach((blocked) => {
          const date = toIsoDate(blocked.date);
          if (!date) return;
          blockedCategories.personal.dates.push(date);
          markMemberBlocked(date, memberId);
          // Add to debug info
          if (debugEnabled && teamMemberDebugInfo?.[memberId]) {
            teamMemberDebugInfo[memberId].personalBlockedDates.push(date);
          }
        });
      }

      if (member.blockedRanges) {
        member.blockedRanges.forEach((range) => {
          const blockedRange = toBlockedRange(range);
          if (!blockedRange) return;
          blockedCategories.personal.ranges.push(blockedRange);
          expandRangeAndMarkBlocked(blockedRange.startDate, blockedRange.endDate, memberId);
          // Add to debug info
          if (debugEnabled && teamMemberDebugInfo?.[memberId]) {
            teamMemberDebugInfo[memberId].personalBlockedRanges.push(blockedRange);
          }
        });
      }
    });

    // Booking filter - must match scheduleEngine.ts buildPerMemberBlockedData for consistency
    // Both endpoints must use the same criteria to determine which bookings block resources
    const bookingFilter: any = {
      status: { $nin: ["completed", "cancelled", "refunded"] },
      scheduledStartDate: { $exists: true, $ne: null },
      // Require valid end date to exist (matches scheduleEngine.ts)
      $and: [
        {
          $or: [
            { scheduledBufferEndDate: { $exists: true, $ne: null } },
            { scheduledExecutionEndDate: { $exists: true, $ne: null } },
          ],
        },
      ],
      $or: [
        { project: project._id },
      ],
    };

    // Add team member filters if we have valid IDs
    if (validatedTeamMemberIds.length > 0) {
      bookingFilter.$or.push(
        { assignedTeamMembers: { $in: validatedTeamMemberIds } },
        { professional: { $in: validatedTeamMemberIds } }
      );
    }

    const bookings = await Booking.find(bookingFilter).select(
      "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate status assignedTeamMembers professional"
    );

    // Build set of project resources for efficient lookup (using validated IDs)
    const projectResources = new Set(validatedTeamMemberIds.map((id) => String(id)));
    const finalBlockedDateSet = new Set<string>();

    const rangeIntersectsBlockedDates = (
      range: { startDate: string; endDate: string }
    ): boolean => {
      const startKey = normalizeDateKey(range.startDate);
      const endKey = normalizeDateKey(range.endDate);
      if (!startKey || !endKey) return false;
      const start = new Date(startKey);
      const end = new Date(endKey);

      const cursor = new Date(start);

      while (cursor <= end) {
        const key = normalizeDateKey(cursor.toISOString());
        if (finalBlockedDateSet.has(key)) {
          return true;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      return false;
    };

    // Debug: track bookings info
    const bookingsDebugInfo: Array<{
      bookingId: string;
      scheduledStart: string | null;
      scheduledEnd: string | null;
      blockedMembers: string[];
      blockedMemberNames: string[];
    }> | null = debugEnabled ? [] : null;

    // Track which bookings block which resources
    bookings.forEach((booking) => {
      const scheduledExecutionEndDate =
        booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
      const scheduledBufferStartDate =
        booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
      const scheduledBufferEndDate =
        booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

      // Find which of our project's resources are blocked by this booking.
      // Match scheduleEngine legacy logic for bookings without assigned team members.
      const blockedResourceIds = new Set<string>();

      const assignedTeamMembers = Array.isArray(booking.assignedTeamMembers)
        ? booking.assignedTeamMembers
        : [];
      const hasAssignedMembers = assignedTeamMembers.length > 0;

      if (hasAssignedMembers) {
        assignedTeamMembers.forEach((memberId: any) => {
          const memberIdStr = String(memberId);
          if (projectResources.has(memberIdStr)) {
            blockedResourceIds.add(memberIdStr);
          }
        });
      } else {
        // Legacy: fall back to professional or project match
        if (booking.professional) {
          const profIdStr = String(booking.professional);
          if (projectResources.has(profIdStr)) {
            blockedResourceIds.add(profIdStr);
          }
        }

        const projectId = String(project._id);
        if (booking.project && String(booking.project) === projectId) {
          projectResources.forEach((resourceId) => {
            blockedResourceIds.add(resourceId);
          });
        }
      }

      // Add to bookings debug info
      if (debugEnabled && bookingsDebugInfo && blockedResourceIds.size > 0) {
        const blockedResourceIdsArray = Array.from(blockedResourceIds);
        bookingsDebugInfo.push({
          bookingId: String(booking._id),
          scheduledStart: booking.scheduledStartDate ? toIsoDate(booking.scheduledStartDate) : null,
          scheduledEnd: scheduledExecutionEndDate ? toIsoDate(scheduledExecutionEndDate) : null,
          blockedMembers: blockedResourceIdsArray,
          blockedMemberNames: blockedResourceIdsArray.map(
            (id) => teamMemberDebugInfo?.[id]?.name || "Unknown"
          ),
        });
      }

      // Block the execution period for each blocked resource
      if (booking.scheduledStartDate && scheduledExecutionEndDate) {
        const blockedRange = toBlockedRange({
          startDate: booking.scheduledStartDate,
          endDate: scheduledExecutionEndDate,
          reason: "booking",
        });
        if (blockedRange) {
          blockedCategories.bookings.ranges.push(blockedRange);
          // Mark each blocked resource for each day in the range
          blockedResourceIds.forEach((resourceId) => {
            expandRangeAndMarkBlocked(blockedRange.startDate, blockedRange.endDate, resourceId);
            // Add blocked dates to debug info
            if (debugEnabled && teamMemberDebugInfo?.[resourceId]) {
              const start = new Date(blockedRange.startDate);
              const end = new Date(blockedRange.endDate);
              const cursor = new Date(start);
              while (cursor <= end) {
                const bookingDateKey = normalizeDateKey(cursor.toISOString());
                if (bookingDateKey) {
                  teamMemberDebugInfo[resourceId].bookingBlockedDates.push(
                    bookingDateKey.split("T")[0]
                  );
                }
                cursor.setUTCDate(cursor.getUTCDate() + 1);
              }
            }
          });
        }
      }
      // Block the buffer period (if exists) for each blocked resource
      if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
        const bufferRange = toBlockedRange({
          startDate: scheduledBufferStartDate,
          endDate: scheduledBufferEndDate.toISOString(),
          reason: "booking-buffer",
        });
        if (bufferRange) {
          blockedCategories.bookings.ranges.push(bufferRange);
          // Mark each blocked resource for each day in the range
          blockedResourceIds.forEach((resourceId) => {
            expandRangeAndMarkBlocked(bufferRange.startDate, bufferRange.endDate, resourceId);
          });
        }
      }
    });

    // Apply resource policy logic with window-based throughput and overlap checks
    // Guard: if no resources are available, return early (matches schedule engine behavior)
    // Check both totalResources (from policy) and validatedTeamMemberIds (actual valid ObjectIds)
    // This handles cases where project.resources contains invalid IDs that fail validation
    if (totalResources === 0 || validatedTeamMemberIds.length === 0) {
      console.warn(
        `[getProjectTeamAvailability] Project ${project._id} has no valid resources ` +
        `(totalResources=${totalResources}, validatedTeamMemberIds.length=${validatedTeamMemberIds.length}). ` +
        `Returning no availability.`
      );
      return res.json({
        success: true,
        blockedDates: [],
        blockedRanges: [],
        blockedCategories,
        resourcePolicy,
        noResources: true,
      });
    }

    const useMultiResourceMode = validatedTeamMemberIds.length > 0;
    const requiredOverlap =
      minResources <= 1 ? 100 : resourcePolicy.minOverlapPercentage;
    const requiresFullOverlap =
      resourcePolicy.minOverlapPercentage === 100 || minResources >= totalResources;

    // Get execution duration from project or subprojects for window-based checks
    let executionDays: number | null = null;

    const projectData = project as any;

    // If subprojectIndex is provided, use that specific subproject's execution duration
    if (typeof subprojectIndex === 'number' &&
        projectData.subprojects &&
        Array.isArray(projectData.subprojects) &&
        projectData.subprojects[subprojectIndex]?.executionDuration?.value &&
        projectData.subprojects[subprojectIndex]?.executionDuration?.unit === 'days') {
      executionDays = Math.max(1, Math.ceil(projectData.subprojects[subprojectIndex].executionDuration.value));
    } else if (projectData.executionDuration?.value && projectData.executionDuration?.unit === 'days') {
      // Use project-level execution duration
      executionDays = Math.max(1, Math.ceil(projectData.executionDuration.value));
    } else if (projectData.subprojects && Array.isArray(projectData.subprojects)) {
      // Fallback: use the maximum execution duration from all subprojects for conservative blocking
      let maxExecution = 0;
      for (const sp of projectData.subprojects) {
        if (sp.executionDuration?.value && sp.executionDuration?.unit === 'days') {
          maxExecution = Math.max(maxExecution, sp.executionDuration.value);
        }
      }
      if (maxExecution > 0) {
        executionDays = Math.ceil(maxExecution);
      }
    }


    // Debug: Log resource policy and blocked data summary (gated behind debug flag)
    if (debugEnabled) {
      console.log(`[getProjectTeamAvailability] Project ${project._id}:`, {
        totalResources,
        minResources,
        requiredOverlap,
        executionDays,
        teamMemberIds: validatedTeamMemberIds.map(id => String(id)),
        dateBlockedMembersCount: dateBlockedMembers.size,
      });
    }

    // Per-day blocking for multi-resource availability:
    // - If 100% overlap is required, block any day where not all resources are available.
    // - Otherwise, block only days where all resources are unavailable.
    if (useMultiResourceMode) {
      dateBlockedMembers.forEach((blockedMemberIds, dateIso) => {
        const blockedCount = blockedMemberIds.size;
        const availableResources = totalResources - blockedCount;

        if (requiresFullOverlap) {
          if (availableResources < totalResources) {
            allBlockedDates.add(dateIso);
            finalBlockedDateSet.add(dateIso);
          }
          return;
        }

        if (availableResources <= 0) {
          allBlockedDates.add(dateIso);
          finalBlockedDateSet.add(dateIso);
        }
      });
    } else {
      // strict mode - any blocked member blocks the date
      dateBlockedMembers.forEach((blockedMemberIds, dateIso) => {
        allBlockedDates.add(dateIso);
        finalBlockedDateSet.add(dateIso);
      });
    }

    // In multi-resource days mode, don't add individual booking/personal ranges.
    // We only want to block explicit dates (all resources unavailable or full overlap).
    const useWindowBasedCheck = useMultiResourceMode && executionDays && executionDays > 0;

    if (!useWindowBasedCheck) {
      // Only add ranges in simple mode (single resource or no execution duration)
      blockedCategories.personal.ranges.forEach((range) => {
        if (rangeIntersectsBlockedDates(range)) {
          allBlockedRanges.push(range);
        }
      });

      blockedCategories.bookings.ranges.forEach((range) => {
        if (rangeIntersectsBlockedDates(range)) {
          allBlockedRanges.push(range);
        }
      });
    }


    const blockedDatesArray = Array.from(allBlockedDates);

    // Build response
    const response: any = {
      success: true,
      timezone: timeZone,
      blockedDates: blockedDatesArray,
      blockedRanges: allBlockedRanges,
      blockedCategories,
      resourcePolicy,
    };

    // Only include _debug payload when explicitly enabled
    if (debugEnabled && teamMemberDebugInfo && bookingsDebugInfo) {
      // Build anonymization mapping: real member ID -> anonymized token
      const memberIdToToken = new Map<string, string>();
      let tokenCounter = 1;
      const getAnonymizedToken = (memberId: string): string => {
        if (!memberIdToToken.has(memberId)) {
          memberIdToToken.set(memberId, `resource_${tokenCounter++}`);
        }
        return memberIdToToken.get(memberId)!;
      };

      // Build per-date blocked members info for debug (anonymized)
      const dateBlockedMembersDebug: Record<string, { blockedCount: number; blockedTokens: string[] }> = {};
      dateBlockedMembers.forEach((memberIds, dateKey) => {
        const dateStr = dateKey.split('T')[0];
        dateBlockedMembersDebug[dateStr] = {
          blockedCount: memberIds.size,
          blockedTokens: Array.from(memberIds).map(id => getAnonymizedToken(id)),
        };
      });

      // Anonymize team member debug info (remove names and real IDs)
      const teamMembersAnonymized: Record<string, {
        personalBlockedDatesCount: number;
        personalBlockedRangesCount: number;
        bookingBlockedDatesCount: number;
      }> = {};
      Object.entries(teamMemberDebugInfo).forEach(([memberId, info]) => {
        const token = getAnonymizedToken(memberId);
        teamMembersAnonymized[token] = {
          personalBlockedDatesCount: info.personalBlockedDates.length,
          personalBlockedRangesCount: info.personalBlockedRanges.length,
          bookingBlockedDatesCount: info.bookingBlockedDates.length,
        };
      });

      // Anonymize bookings debug info (remove names and real IDs)
      const bookingsAnonymized = bookingsDebugInfo.map((booking) => ({
        scheduledStart: booking.scheduledStart,
        scheduledEnd: booking.scheduledEnd,
        blockedCount: booking.blockedMembers.length,
        blockedTokens: booking.blockedMembers.map(id => getAnonymizedToken(id)),
      }));

      response._debug = {
        subprojectIndex,
        projectId: String(project._id),
        timeZone,
        totalBlockedDates: blockedDatesArray.length,
        totalBlockedRanges: allBlockedRanges.length,
        useWindowBasedCheck,
        executionDays,
        minResources,
        totalResources,
        requiredOverlap,
        teamMembers: teamMembersAnonymized,
        bookings: bookingsAnonymized,
        dateBlockedMembers: dateBlockedMembersDebug,
      };
    }

    res.json(response);
  } catch (error) {
    console.error('Error fetching team availability:', error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team availability"
    });
  }
};

export const getProjectWorkingHours = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      status: "published",
    }).select("professionalId");

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    const professional = await User.findById(project.professionalId).select(
      "companyAvailability businessInfo.timezone"
    );

    const availability = resolveAvailability(professional?.companyAvailability);

    res.json({
      success: true,
      availability,
      timezone: professional?.businessInfo?.timezone || "UTC",
    });
  } catch (error) {
    console.error("Error fetching working hours:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch working hours",
    });
  }
};

export const getProjectScheduleProposals = async (req: Request, res: Response) => {
  try {
    console.log('[SCHEDULE PROPOSALS API] Request for project:', req.params.id);
    const { id } = req.params;
    const subprojectIndexRaw = req.query.subprojectIndex as string | undefined;

    const project = await Project.findById(id).select("subprojects");
    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    const subprojects = Array.isArray(project.subprojects)
      ? project.subprojects
      : [];
    const subprojectIndexResult = parseSubprojectIndex(
      subprojectIndexRaw,
      subprojects.length
    );
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({
        success: false,
        error: subprojectIndexResult.error,
      });
    }
    const subprojectIndex = subprojectIndexResult.index;

    const proposals = await buildProjectScheduleProposals(id as string, subprojectIndex);

    if (!proposals) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    console.log('[SCHEDULE PROPOSALS API] Response:', {
      earliestProposal: proposals.earliestProposal,
      shortestThroughputProposal: proposals.shortestThroughputProposal
    });

    res.json({
      success: true,
      proposals,
    });
  } catch (error) {
    console.error("Error fetching schedule proposals:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch schedule proposals",
    });
  }
};

/**
 * Get the schedule window (including completion date) for a specific start date.
 * This uses the same backend logic as booking creation to ensure consistency.
 */
export const getProjectScheduleWindow = async (req: Request, res: Response) => {
  try {
    console.log('[SCHEDULE WINDOW API] Request received:', {
      projectId: req.params.id,
      query: req.query
    });

    const { id } = req.params;
    const {
      subprojectIndex: subprojectIndexRaw,
      startDate,
      startTime,
    } = req.query;

    if (!startDate || typeof startDate !== "string") {
      console.log('[SCHEDULE WINDOW API] Missing startDate');
      return res.status(400).json({
        success: false,
        error: "startDate query parameter is required",
      });
    }

    const project = await Project.findById(id).select("subprojects");
    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

    const subprojects = Array.isArray(project.subprojects)
      ? project.subprojects
      : [];
    const subprojectIndexResult = parseSubprojectIndex(
      subprojectIndexRaw as string | undefined,
      subprojects.length
    );
    if (!subprojectIndexResult.valid) {
      return res.status(400).json({
        success: false,
        error: subprojectIndexResult.error,
      });
    }
    const subprojectIndex = subprojectIndexResult.index;

    const window = await buildProjectScheduleWindow({
      projectId: id as string,
      subprojectIndex,
      startDate: startDate as string,
      startTime: typeof startTime === "string" ? startTime : undefined,
    });

    if (!window) {
      console.log('[SCHEDULE WINDOW API] No window returned - date not available');
      return res.status(400).json({
        success: false,
        error: "Selected date is not available or invalid",
      });
    }

    const response = {
      success: true,
      window: {
        scheduledStartDate: window.scheduledStartDate.toISOString(),
        scheduledExecutionEndDate: window.scheduledExecutionEndDate.toISOString(),
        scheduledBufferStartDate: window.scheduledBufferStartDate?.toISOString(),
        scheduledBufferEndDate: window.scheduledBufferEndDate?.toISOString(),
        scheduledBufferUnit: window.scheduledBufferUnit,
        scheduledStartTime: window.scheduledStartTime,
        scheduledEndTime: window.scheduledEndTime,
        throughputDays: window.throughputDays,
      },
    };
    console.log('[SCHEDULE WINDOW API] Success response:', response);
    res.json(response);
  } catch (error) {
    console.error("[SCHEDULE WINDOW API] Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch schedule window",
    });
  }
};

export const submitProject = async (req: Request, res: Response) => {
  try {
    console.log("[PROJECT] SUBMIT PROJECT REQUEST RECEIVED");
    const { id } = req.params;
    const professionalId = req.user?.id;

    console.log("Project ID:", id);
    console.log("Professional ID:", professionalId);

    if (!professionalId) {
      console.log("[PROJECT] No professional ID found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const project = await Project.findOne({
      _id: id,
      professionalId,
    });

    console.log("Project found:", !!project);
    console.log("Project status:", project?.status);

    if (!project) {
      console.log("[PROJECT] Project not found");
      return res.status(404).json({ error: "Project not found" });
    }

    // Allow resubmission for draft, rejected, pending, or existing projects
    if (
      !["draft", "rejected", "pending", "published"].includes(project.status)
    ) {
      console.log("[PROJECT] Invalid status for submission:", project.status);
      return res
        .status(400)
        .json({ error: "Project cannot be submitted in current status" });
    }

    console.log("[PROJECT] Project validation passed, running quality checks...");

    const qualityChecks = [];

    if (!project.title || project.title.length < 30) {
      qualityChecks.push({
        category: "content",
        status: "failed" as const,
        message: "Title must be at least 30 characters long",
        checkedAt: new Date(),
      });
    }

    if (!project.description || project.description.length < 100) {
      qualityChecks.push({
        category: "content",
        status: "failed" as const,
        message: "Description must be at least 100 characters long",
        checkedAt: new Date(),
      });
    }

    if (project.subprojects.length === 0) {
      qualityChecks.push({
        category: "pricing",
        status: "failed" as const,
        message: "At least one subproject/pricing variation is required",
        checkedAt: new Date(),
      });
    }

    const failedChecks = qualityChecks.filter(
      (check) => check.status === "failed"
    );

    if (failedChecks.length > 0) {
      project.qualityChecks = qualityChecks;
      await project.save();
      return res.status(400).json({
        error: "Quality checks failed",
        qualityChecks: failedChecks,
      });
    }

    // Update project status and submission details
    const isResubmission = project.status !== "draft";
    project.status = "pending";
    project.submittedAt = new Date();
    project.qualityChecks = qualityChecks;

    // Clear admin feedback on resubmission
    if (isResubmission) {
      project.adminFeedback = undefined;
    }

    await project.save();

    const message = isResubmission
      ? "Project resubmitted for approval"
      : "Project submitted for approval";
    console.log("[PROJECT] Project submitted successfully");
    console.log("Message:", message);

    res.json({ message, project });
  } catch (error: any) {
    console.error("[PROJECT] Submit project error:", error);
    console.error("Error stack:", error.stack);
    res
      .status(500)
      .json({ error: "Failed to submit project", details: error.message });
  }
};

// Duplicate a project for the current professional
export const duplicateProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const professionalId = req.user?.id;

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const original = await Project.findOne({ _id: id, professionalId });
    if (!original) {
      return res.status(404).json({ error: "Project not found" });
    }

    const plain = original.toObject();
    // Reset fields for a clean draft copy
    delete (plain as any)._id;
    delete (plain as any).id;
    const duplicated = new Project({
      ...plain,
      title: `${plain.title} (Copy)`,
      status: "draft",
      adminFeedback: undefined,
      submittedAt: undefined,
      approvedAt: undefined,
      approvedBy: undefined,
      autoSaveTimestamp: new Date(),
      createdAt: undefined,
      updatedAt: undefined,
    });

    await duplicated.save();
    res.json(duplicated);
  } catch (error) {
    res.status(500).json({ error: "Failed to duplicate project" });
  }
};

// Delete a project owned by the current professional
export const deleteProject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const professionalId = req.user?.id;

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await Project.findOneAndDelete({ _id: id, professionalId });
    if (!result) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete project" });
  }
};

// Update project status (Hold/Resume for published projects)
export const updateProjectStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };
    const professionalId = req.user?.id;

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!status || !["published", "on_hold"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const project = await Project.findOne({ _id: id, professionalId });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const currentStatus = project.status;
    const allowed =
      (currentStatus === "published" && status === "on_hold") ||
      (currentStatus === "on_hold" && status === "published");
    if (!allowed) {
      return res.status(400).json({ error: "Status transition not allowed" });
    }

    project.status = status as any;
    await project.save();
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ error: "Failed to update project status" });
  }
};

// Master listing with search and filters for Manage Projects screen
export const getProjectsMaster = async (req: Request, res: Response) => {
  try {
    const professionalId = req.user?.id;
    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const search = (req.query.search as string) || "";
    const status = (req.query.status as string) || "all";
    const category = (req.query.category as string) || "all";
    const page = Math.max(parseInt((req.query.page as string) || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || "20", 10), 1),
      100
    );

    const filter: any = { professionalId };
    if (status && status !== "all") {
      if (status === "rejected") {
        filter.status = "rejected";
      } else if (status === "cancelled") {
        filter.status = "closed";
      } else {
        filter.status = status;
      }
    }
    if (category && category !== "all") {
      // Match either the primary category field or within services[] selections
      filter.$or = [{ category }, { "services.category": category }];
    }
    if (search) {
      const regex = new RegExp(search, "i");
      filter.$and = (filter.$and || []).concat([
        {
          $or: [{ title: regex }, { description: regex }, { keywords: regex }],
        },
      ]);
    }

    const [items, total, counts] = await Promise.all([
      Project.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Project.countDocuments(filter),
      // Status counts for header cards
      (async () => {
        const pipeline = [
          { $match: { professionalId } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ];
        const raw = await (Project as any).aggregate(pipeline);
        const byStatus: Record<string, number> = raw.reduce(
          (acc: any, r: any) => {
            acc[r._id] = r.count;
            return acc;
          },
          {} as Record<string, number>
        );

        // Derive rejected and cancelled for UI compatibility
        const rejected = await Project.countDocuments({
          professionalId,
          status: "rejected",
        });
        const cancelled = await Project.countDocuments({
          professionalId,
          status: "closed",
        });

        return {
          drafts: byStatus["draft"] || 0,
          pending: byStatus["pending"] || 0,
          published: byStatus["published"] || 0,
          on_hold: byStatus["on_hold"] || 0,
          rejected,
        };
      })(),
    ]);

    res.json({
      items,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
      counts,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch projects" });
  }
};
