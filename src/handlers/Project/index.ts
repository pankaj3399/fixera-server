import { Request, Response } from "express";
import mongoose from "mongoose";
import Project from "../../models/project";
import Booking from "../../models/booking";
import ServiceCategory from "../../models/serviceCategory";
import User from "../../models/user";
import { buildProjectScheduleProposals, getResourcePolicy, type ResourcePolicy } from "../../utils/scheduleEngine";
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

const buildWeekendDates = (rangeStart: Date, rangeEnd: Date) => {
  const weekends: string[] = [];
  const cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const day = cursor.getDay();
    if (day === 0 || day === 6) {
      weekends.push(cursor.toISOString());
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return weekends;
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
    console.log("📝 SAVE PROJECT REQUEST RECEIVED");
    console.log("User ID:", req.user?.id);
    console.log("Request body keys:", Object.keys(req.body));
    console.log("Project ID from request:", req.body.id);

    const professionalId = req.user?.id;
    const projectData = normalizePreparationDuration(req.body);

    if (!professionalId) {
      console.log("❌ No professional ID found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    let project;

    if (projectData.id) {
      console.log(`🔄 UPDATING existing project: ${projectData.id}`);
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
        console.log("❌ Project not found or not owned by user");
        return res.status(404).json({ error: "Project not found" });
      }

      // Log what fields are being updated
      console.log("📝 Fields being updated:");
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

      console.log("🔧 Update query:", { _id: projectData.id, professionalId });
      console.log("🔧 Update data keys:", Object.keys(updateData));

      project = await Project.findOneAndUpdate(
        { _id: projectData.id, professionalId },
        updateData,
        { new: true, runValidators: true }
      );

      console.log("✅ Project updated successfully");
      console.log("Updated project ID:", project?._id);
      console.log("Updated project title:", project?.title);
      console.log("Updated project status:", project?.status);
    } else {
      console.log("🆕 CREATING new project");
      project = new Project({
        ...projectData,
        professionalId,
        status: "draft",
        autoSaveTimestamp: new Date(),
      });
      await project.save();
      console.log("✅ New project created with ID:", project._id);
    }

    console.log("📤 SENDING RESPONSE - Project save complete");
    console.log("Response project ID:", project?._id);
    console.log("Response status code: 200");

    res.json(project);
  } catch (error: any) {
    console.error("❌ AUTO-SAVE ERROR:", error);
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

    const teamMemberIds = project.resources || [];

    const professional = await User.findById(project.professionalId).select(
      "companyAvailability companyBlockedDates companyBlockedRanges blockedDates blockedRanges businessInfo.timezone"
    );

    const { rangeStart, rangeEnd } = getDateRange(startDate, endDate, 180);
    const weekendDates = buildWeekendDates(rangeStart, rangeEnd);

    const blockedCategories = {
      weekends: weekendDates,
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

    const allBlockedDates = new Set<string>(weekendDates);
    const allBlockedRanges: Array<{ startDate: string; endDate: string; reason?: string }> = [];

    if (professional?.companyBlockedDates) {
      professional.companyBlockedDates.forEach((blocked) => {
        const date = toIsoDate(blocked.date);
        if (!date) return;
        blockedCategories.company.dates.push(date);
        allBlockedDates.add(date);
      });
    }

    if (professional?.companyBlockedRanges) {
      professional.companyBlockedRanges.forEach((range) => {
        const blockedRange = toBlockedRange(range);
        if (!blockedRange) return;
        blockedCategories.company.ranges.push(blockedRange);
        allBlockedRanges.push(blockedRange);
      });
    }

    // Include the professional's personal blocked dates (shown in their profile calendar)
    if (professional?.blockedDates) {
      professional.blockedDates.forEach((blocked) => {
        const date = toIsoDate(blocked.date);
        if (!date) return;
        blockedCategories.personal.dates.push(date);
        allBlockedDates.add(date);
      });
    }

    if (professional?.blockedRanges) {
      professional.blockedRanges.forEach((range) => {
        const blockedRange = toBlockedRange(range);
        if (!blockedRange) return;
        blockedCategories.personal.ranges.push(blockedRange);
        allBlockedRanges.push(blockedRange);
      });
    }

    const teamMembers =
      teamMemberIds.length > 0
        ? await User.find({
            _id: { $in: teamMemberIds },
          }).select("blockedDates blockedRanges")
        : [];

    teamMembers.forEach((member) => {
      if (member.blockedDates) {
        member.blockedDates.forEach((blocked) => {
          const date = toIsoDate(blocked.date);
          if (!date) return;
          blockedCategories.personal.dates.push(date);
          allBlockedDates.add(date);
        });
      }

      if (member.blockedRanges) {
        member.blockedRanges.forEach((range) => {
          const blockedRange = toBlockedRange(range);
          if (!blockedRange) return;
          blockedCategories.personal.ranges.push(blockedRange);
          allBlockedRanges.push(blockedRange);
        });
      }
    });

    // Convert string IDs to ObjectIds for proper MongoDB matching
    // Validate IDs before conversion to avoid runtime exceptions
    if (!mongoose.isValidObjectId(project.professionalId)) {
      console.error('Invalid professionalId:', project.professionalId);
      return res.status(400).json({
        success: false,
        error: "Invalid professional ID in project"
      });
    }
    const professionalObjectId = new mongoose.Types.ObjectId(project.professionalId);

    // Filter and convert team member IDs, skipping invalid entries
    // Handles both string IDs and existing ObjectId instances
    const teamMemberObjectIds: mongoose.Types.ObjectId[] = [];
    if (Array.isArray(teamMemberIds)) {
      for (const id of teamMemberIds) {
        if (id == null) {
          console.warn(
            `[getProjectTeamAvailability] Skipping null/undefined team member ID in teamMemberIds for project ${project._id}`
          );
          continue;
        }

        // Handle string IDs
        if (typeof id === 'string') {
          if (mongoose.isValidObjectId(id)) {
            teamMemberObjectIds.push(new mongoose.Types.ObjectId(id));
          } else {
            console.warn(
              `[getProjectTeamAvailability] Skipping invalid string team member ID "${id}" in teamMemberIds for project ${project._id}`
            );
          }
          continue;
        }

        // Handle existing ObjectId instances or objects with toString
        const idStr = String(id);
        if (mongoose.isValidObjectId(idStr)) {
          teamMemberObjectIds.push(new mongoose.Types.ObjectId(idStr));
        } else {
          console.warn(
            `[getProjectTeamAvailability] Skipping invalid team member ID (type: ${typeof id}, value: ${idStr}) in teamMemberIds for project ${project._id}`
          );
        }
      }
    }

    const bookingFilter: any = {
      status: { $nin: ["completed", "cancelled", "refunded"] },
      scheduledStartDate: { $exists: true, $ne: null },
      $or: [
        { project: project._id },
        // Include bookings where the professional (project owner) is booked on ANY project
        { professional: professionalObjectId },
        // Include bookings where the professional is assigned as a team member on OTHER projects
        { assignedTeamMembers: professionalObjectId },
      ],
    };

    if (teamMemberObjectIds.length > 0) {
      bookingFilter.$or.push(
        { assignedTeamMembers: { $in: teamMemberObjectIds } },
        { professional: { $in: teamMemberObjectIds } }
      );
    }

    const bookings = await Booking.find(bookingFilter).select(
      "scheduledStartDate scheduledExecutionEndDate scheduledBufferStartDate scheduledBufferEndDate scheduledBufferUnit executionEndDate bufferStartDate scheduledEndDate status"
    );

    bookings.forEach((booking) => {
      const scheduledExecutionEndDate =
        booking.scheduledExecutionEndDate || (booking as any).executionEndDate;
      const scheduledBufferStartDate =
        booking.scheduledBufferStartDate || (booking as any).bufferStartDate;
      const scheduledBufferEndDate =
        booking.scheduledBufferEndDate || (booking as any).scheduledEndDate;

      // Block the execution period
      if (booking.scheduledStartDate && scheduledExecutionEndDate) {
        const blockedRange = toBlockedRange({
          startDate: booking.scheduledStartDate,
          endDate: scheduledExecutionEndDate,
          reason: "booking",
        });
        if (blockedRange) {
          blockedCategories.bookings.ranges.push(blockedRange);
          allBlockedRanges.push(blockedRange);
        }
      }
      // Block the buffer period (if exists)
      if (scheduledBufferStartDate && scheduledBufferEndDate && scheduledExecutionEndDate) {
        // Don't extend buffer end date - use the actual scheduled end
        // Extending to UTC 23:59:59 causes timezone issues (bleeds into next day in other timezones)
        const bufferRange = toBlockedRange({
          startDate: scheduledBufferStartDate,
          endDate: scheduledBufferEndDate.toISOString(),
          reason: "booking-buffer",
        });
        if (bufferRange) {
          blockedCategories.bookings.ranges.push(bufferRange);
          allBlockedRanges.push(bufferRange);
        }
      }
    });

    // Build resource policy from project settings using shared helper
    const resourcePolicy = getResourcePolicy(project);

    res.json({
      success: true,
      blockedDates: Array.from(allBlockedDates),
      blockedRanges: allBlockedRanges,
      blockedCategories,
      resourcePolicy,
    });
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
    const { id } = req.params;
    const subprojectIndexRaw = req.query.subprojectIndex;
    let subprojectIndex: number | undefined;

    if (typeof subprojectIndexRaw === "string") {
      const parsed = Number.parseInt(subprojectIndexRaw, 10);
      if (!Number.isNaN(parsed)) {
        subprojectIndex = parsed;
      }
    }

    const proposals = await buildProjectScheduleProposals(id, subprojectIndex);

    if (!proposals) {
      return res.status(404).json({
        success: false,
        error: "Project not found",
      });
    }

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

export const submitProject = async (req: Request, res: Response) => {
  try {
    console.log("🚀 SUBMIT PROJECT REQUEST RECEIVED");
    const { id } = req.params;
    const professionalId = req.user?.id;

    console.log("Project ID:", id);
    console.log("Professional ID:", professionalId);

    if (!professionalId) {
      console.log("❌ No professional ID found");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const project = await Project.findOne({
      _id: id,
      professionalId,
    });

    console.log("Project found:", !!project);
    console.log("Project status:", project?.status);

    if (!project) {
      console.log("❌ Project not found");
      return res.status(404).json({ error: "Project not found" });
    }

    // Allow resubmission for draft, rejected, pending, or existing projects
    if (
      !["draft", "rejected", "pending", "published"].includes(project.status)
    ) {
      console.log("❌ Invalid status for submission:", project.status);
      return res
        .status(400)
        .json({ error: "Project cannot be submitted in current status" });
    }

    console.log("✅ Project validation passed, running quality checks...");

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
    console.log("✅ Project submitted successfully");
    console.log("Message:", message);

    res.json({ message, project });
  } catch (error: any) {
    console.error("❌ SUBMIT PROJECT ERROR:", error);
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
