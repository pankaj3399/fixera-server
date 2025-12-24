import { Request, Response } from "express";
import { Types } from "mongoose";
import Project from "../../models/project";
import ServiceCategory from "../../models/serviceCategory";
import User from "../../models/user";
import Booking from "../../models/booking";
import { getScheduleProposalsForProject, calculateFirstAvailableDate } from "./scheduling";
// import { seedServiceCategories } from '../../scripts/seedProject';

const buildProfessionalOwnershipFilter = (professionalId: string) => {
  const idStr = professionalId.toString();
  const conditions: any[] = [
    {
      $expr: {
        $eq: [{ $toString: "$professionalId" }, idStr],
      },
    },
  ];

  if (Types.ObjectId.isValid(idStr)) {
    conditions.push({
      professionalId: new Types.ObjectId(idStr),
    });
  }

  return { $or: conditions };
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
    const projectData = req.body;

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

    console.log('🔍 getProject called:', {
      projectId: id,
      userId: professionalId,
      userIdType: typeof professionalId
    });

    if (!professionalId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ownershipFilter = buildProfessionalOwnershipFilter(professionalId.toString());
    console.log('🔐 Ownership filter:', JSON.stringify(ownershipFilter, null, 2));

    const projectId = Types.ObjectId.isValid(id)
      ? new Types.ObjectId(id)
      : id;
    const query = {
      $and: [
        { _id: projectId },
        ownershipFilter
      ]
    };
    console.log('🔎 Query:', JSON.stringify(query, null, 2));

    const project = await Project.findOne(query);

    console.log('📦 Project found:', !!project);

    if (!project) {
      // Debug: Try to find the project without ownership check
      const anyProject = await Project.findById(id);
      console.log('🔍 Debug - Project exists:', !!anyProject);
      if (anyProject) {
        console.log('🔍 Debug - Project professionalId:', anyProject.professionalId);
        console.log('🔍 Debug - User ID:', professionalId);
      }
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(project);
  } catch (error) {
    console.error('❌ Error fetching project:', error);
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
    }).populate('professionalId', 'name businessInfo email phone');

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found or not published"
      });
    }

    const projectData = project.toObject();
    const firstAvailableDate = await calculateFirstAvailableDate(project);

    res.json({
      success: true,
      project: {
        ...projectData,
        firstAvailableDate
      }
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

    // Get all team member IDs from resources
    const teamMemberIds = project.resources || [];

    if (teamMemberIds.length === 0) {
      return res.json({
        success: true,
        blockedDates: [],
        blockedRanges: []
      });
    }

    // Fetch all team members
    const teamMembers = await User.find({
      _id: { $in: teamMemberIds }
    }).select('blockedDates blockedRanges companyBlockedDates companyBlockedRanges');

    // Collect all blocked dates (union of all team members)
    const allBlockedDates = new Set<string>();
    const allBlockedRanges: Array<{ startDate: string; endDate: string; reason?: string }> = [];

    const PARTIAL_BLOCK_THRESHOLD_HOURS = 4;
    const bookingIds = new Set<string>();

    teamMembers.forEach((member) => {
      (member.blockedRanges || []).forEach((range) => {
        if (typeof range.reason === 'string' && range.reason.startsWith('project-booking:')) {
          bookingIds.add(range.reason.split(':')[1]);
        }
      });

      (member.companyBlockedRanges || []).forEach((range) => {
        if (typeof range.reason === 'string' && range.reason.startsWith('project-booking:')) {
          bookingIds.add(range.reason.split(':')[1]);
        }
      });
    });

    const bookingExecutionInfo = new Map<string, { executionHours: number; executionEnd?: Date }>();
    if (bookingIds.size > 0) {
      const bookingObjectIds = Array.from(bookingIds)
        .filter((id) => id)
        .map((id) => new Types.ObjectId(id));

      const relatedBookings = await Booking.find({ _id: { $in: bookingObjectIds } })
        .select('project selectedSubprojectIndex scheduledStartDate scheduledExecutionEndDate scheduledEndDate rfqData');

      const relatedProjectIds = Array.from(
        new Set(
          relatedBookings
            .map((b) => b.project?.toString())
            .filter((id): id is string => Boolean(id))
        )
      ).map((id) => new Types.ObjectId(id));

      const relatedProjects = relatedProjectIds.length
        ? await Project.find({ _id: { $in: relatedProjectIds } })
            .select('executionDuration subprojects')
        : [];

      const projectById = new Map(
        relatedProjects.map((p) => [(p._id as any).toString(), p])
      );

      const getExecutionHours = (booking: any, bookingProject: any): number => {
        if (booking.scheduledStartDate && booking.scheduledExecutionEndDate) {
          const start = new Date(booking.scheduledStartDate);
          const end = new Date(booking.scheduledExecutionEndDate);
          const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
          if (diffHours > 0) {
            return diffHours;
          }
        }

        if (
          typeof booking.selectedSubprojectIndex === 'number' &&
          bookingProject?.subprojects?.[booking.selectedSubprojectIndex]
        ) {
          const execDuration = bookingProject.subprojects[booking.selectedSubprojectIndex].executionDuration;
          if (execDuration?.value) {
            return execDuration.unit === 'hours'
              ? execDuration.value
              : execDuration.value * 24;
          }
        }

        if (bookingProject?.executionDuration?.value) {
          return bookingProject.executionDuration.unit === 'hours'
            ? bookingProject.executionDuration.value
            : bookingProject.executionDuration.value * 24;
        }

        return 0;
      };

      for (const booking of relatedBookings) {
        const bookingProject = booking.project
          ? projectById.get(booking.project.toString())
          : undefined;
        if (!bookingProject) {
          continue;
        }

        const executionHours = getExecutionHours(booking, bookingProject);
        let executionEnd: Date | undefined;

        if (booking.scheduledExecutionEndDate) {
          executionEnd = new Date(booking.scheduledExecutionEndDate);
        } else {
          let start: Date | undefined;
          if (booking.scheduledStartDate) {
            start = new Date(booking.scheduledStartDate);
          } else if (booking.rfqData?.preferredStartDate) {
            start = new Date(booking.rfqData.preferredStartDate);
            if (booking.rfqData.preferredStartTime) {
              const [hours, minutes] = booking.rfqData.preferredStartTime.split(':').map(Number);
              start.setHours(hours, minutes, 0, 0);
            }
          }

          if (start && executionHours > 0) {
            const end = new Date(start);
            end.setHours(end.getHours() + executionHours);
            executionEnd = end;
          } else if (booking.scheduledEndDate) {
            executionEnd = new Date(booking.scheduledEndDate);
          }
        }

        const bookingId = (booking as { _id: Types.ObjectId | string })._id;
        if (!bookingId) {
          continue;
        }
        bookingExecutionInfo.set(bookingId.toString(), { executionHours, executionEnd });
      }
    }

    teamMembers.forEach(member => {
      // Add individual blocked dates
      if (member.blockedDates) {
        member.blockedDates.forEach(blocked => {
          allBlockedDates.add(blocked.date.toISOString());
        });
      }

      // Add individual blocked ranges
      if (member.blockedRanges) {
        member.blockedRanges.forEach(range => {
          if (typeof range.reason === 'string' && range.reason.startsWith('project-booking:')) {
            const bookingId = range.reason.split(':')[1];
            const execInfo = bookingExecutionInfo.get(bookingId);
            if (execInfo?.executionHours && execInfo.executionHours <= PARTIAL_BLOCK_THRESHOLD_HOURS) {
              return;
            }

            if (execInfo?.executionEnd) {
              allBlockedRanges.push({
                startDate: range.startDate.toISOString(),
                endDate: execInfo.executionEnd.toISOString(),
                reason: range.reason
              });
              return;
            }
          }

          allBlockedRanges.push({
            startDate: range.startDate.toISOString(),
            endDate: range.endDate.toISOString(),
            reason: range.reason
          });
        });
      }

      // Add company blocked dates
      if (member.companyBlockedDates) {
        member.companyBlockedDates.forEach(blocked => {
          allBlockedDates.add(blocked.date.toISOString());
        });
      }

      // Add company blocked ranges
      if (member.companyBlockedRanges) {
        member.companyBlockedRanges.forEach(range => {
          if (typeof range.reason === 'string' && range.reason.startsWith('project-booking:')) {
            const bookingId = range.reason.split(':')[1];
            const execInfo = bookingExecutionInfo.get(bookingId);
            if (execInfo?.executionHours && execInfo.executionHours <= PARTIAL_BLOCK_THRESHOLD_HOURS) {
              return;
            }

            if (execInfo?.executionEnd) {
              allBlockedRanges.push({
                startDate: range.startDate.toISOString(),
                endDate: execInfo.executionEnd.toISOString(),
                reason: range.reason
              });
              return;
            }
          }

          allBlockedRanges.push({
            startDate: range.startDate.toISOString(),
            endDate: range.endDate.toISOString(),
            reason: range.reason
          });
        });
      }
    });

    const getBookingExecutionHours = (booking: any): number => {
      if (booking.scheduledStartDate && booking.scheduledExecutionEndDate) {
        const start = new Date(booking.scheduledStartDate);
        const end = new Date(booking.scheduledExecutionEndDate);
        const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        if (diffHours > 0) {
          return diffHours;
        }
      }

      if (
        typeof booking.selectedSubprojectIndex === 'number' &&
        project.subprojects?.[booking.selectedSubprojectIndex]
      ) {
        const subproject = project.subprojects[booking.selectedSubprojectIndex];
        const execDuration = subproject.executionDuration;
        if (execDuration?.value) {
          return execDuration.unit === 'hours'
            ? execDuration.value
            : execDuration.value * 24;
        }
      }

      if (project.executionDuration?.value) {
        return project.executionDuration.unit === 'hours'
          ? project.executionDuration.value
          : project.executionDuration.value * 24;
      }

      return 0;
    };

    // Add existing bookings as blocked ranges (prevent double-booking)
    const existingBookings = await Booking.find({
      project: id,
      status: { $in: ['rfq', 'quoted', 'quote_accepted', 'payment_pending', 'booked', 'in_progress'] }
    }).select('rfqData selectedSubprojectIndex scheduledStartDate scheduledEndDate scheduledExecutionEndDate');

    console.log(`[AVAILABILITY] Found ${existingBookings.length} existing bookings for project ${id}`);

    for (const booking of existingBookings) {
      if (booking.scheduledStartDate && booking.scheduledEndDate) {
        const executionHours = getBookingExecutionHours(booking);
        if (executionHours <= PARTIAL_BLOCK_THRESHOLD_HOURS) {
          continue;
        }

        const bookingStart = new Date(booking.scheduledStartDate);
        const bookingEnd = booking.scheduledExecutionEndDate
          ? new Date(booking.scheduledExecutionEndDate)
          : (() => {
              const end = new Date(bookingStart);
              end.setHours(end.getHours() + executionHours);
              return end;
            })();

        allBlockedRanges.push({
          startDate: bookingStart.toISOString(),
          endDate: bookingEnd.toISOString(),
          reason: 'Existing booking'
        });
        continue;
      }

      if (!booking.rfqData?.preferredStartDate) continue;

      // Get execution duration from the selected subproject or project
      let executionHours = 0;
      if (typeof booking.selectedSubprojectIndex === 'number' && project.subprojects?.[booking.selectedSubprojectIndex]) {
        const subproject = project.subprojects[booking.selectedSubprojectIndex];
        const execDuration = subproject.executionDuration;
        if (execDuration) {
          executionHours = execDuration.unit === 'hours' ? (execDuration.value || 0) : (execDuration.value || 0) * 24;
        }
      } else if (project.executionDuration) {
        executionHours = project.executionDuration.unit === 'hours'
          ? (project.executionDuration.value || 0)
          : (project.executionDuration.value || 0) * 24;
      }

      if (executionHours <= 0) {
        continue;
      }

      if (executionHours <= PARTIAL_BLOCK_THRESHOLD_HOURS) {
        continue;
      }

      // For hours mode with specific start time
      if (project.timeMode === 'hours' && booking.rfqData.preferredStartTime) {
        const startDate = new Date(booking.rfqData.preferredStartDate);
        const [hours, minutes] = booking.rfqData.preferredStartTime.split(':').map(Number);
        startDate.setHours(hours, minutes, 0, 0);

        const endDate = new Date(startDate);
        endDate.setHours(endDate.getHours() + executionHours);

        console.log(`[AVAILABILITY] Blocking time slot: ${startDate.toISOString()} to ${endDate.toISOString()} (${executionHours}h)`);

        allBlockedRanges.push({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          reason: 'Existing booking'
        });
      }
      // For days mode, block the entire day(s)
      else if (project.timeMode === 'days') {
        const startDate = new Date(booking.rfqData.preferredStartDate);
        startDate.setHours(0, 0, 0, 0);

        const durationDays = Math.ceil(executionHours / 24);
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + durationDays);

        allBlockedRanges.push({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          reason: 'Existing booking'
        });
      }
    }

    res.json({
      success: true,
      blockedDates: Array.from(allBlockedDates),
      blockedRanges: allBlockedRanges
    });
  } catch (error) {
    console.error('Error fetching team availability:', error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch team availability"
    });
  }
};

// Public endpoint - Get schedule proposals for a project (hours/days modes)
export const getProjectScheduleProposals = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const subprojectIndexParam = req.query.subprojectIndex as string | undefined;
    const parsedSubprojectIndex =
      typeof subprojectIndexParam === 'string' ? Number(subprojectIndexParam) : undefined;
    const hasValidSubprojectIndex =
      typeof parsedSubprojectIndex === 'number' &&
      Number.isInteger(parsedSubprojectIndex) &&
      parsedSubprojectIndex >= 0;

    const project = await Project.findOne({
      _id: id,
      status: "published",
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found or not published",
      });
    }

    const proposals = await getScheduleProposalsForProject(
      id,
      hasValidSubprojectIndex ? { subprojectIndex: parsedSubprojectIndex } : undefined
    );

    if (!proposals) {
      return res.status(404).json({
        success: false,
        error: "Unable to generate schedule proposals",
      });
    }

    res.json({
      success: true,
      proposals,
    });
  } catch (error) {
    console.error("Error fetching project schedule proposals:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch project schedule proposals",
    });
  }
};

// Public endpoint - Get professional working hours for a project
export const getProjectProfessionalWorkingHours = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      status: "published",
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        error: "Project not found or not published",
      });
    }

    // Get the professional or the first team member for working hours
    let professionalId = project.professionalId;
    if (project.resources && project.resources.length > 0) {
      professionalId = project.resources[0] as any;
    }

    const professional = await User.findById(professionalId).select('availability businessInfo.timezone');

    if (!professional || !professional.availability) {
      // Return default working hours if not set
      return res.json({
        success: true,
        availability: {
          monday: { available: true, startTime: "09:00", endTime: "17:00" },
          tuesday: { available: true, startTime: "09:00", endTime: "17:00" },
          wednesday: { available: true, startTime: "09:00", endTime: "17:00" },
          thursday: { available: true, startTime: "09:00", endTime: "17:00" },
          friday: { available: true, startTime: "09:00", endTime: "17:00" },
          saturday: { available: false },
          sunday: { available: false },
        },
        timezone: 'UTC',
      });
    }

    res.json({
      success: true,
      availability: professional.availability,
      timezone: professional.businessInfo?.timezone || 'UTC',
    });
  } catch (error) {
    console.error("Error fetching professional working hours:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch professional working hours",
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

    const ownershipFilter = buildProfessionalOwnershipFilter(
      professionalId.toString()
    );
    const projectId = Types.ObjectId.isValid(id)
      ? new Types.ObjectId(id)
      : id;
    const original = await Project.findOne({
      ...ownershipFilter,
      _id: projectId,
    });
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

    await duplicated.save({ validateBeforeSave: false });
    res.json(duplicated);
  } catch (error) {
    console.error("Duplicate project failed:", error);
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

    const ownershipFilter = buildProfessionalOwnershipFilter(
      professionalId.toString()
    );
    const projectId = Types.ObjectId.isValid(id)
      ? new Types.ObjectId(id)
      : id;
    const result = await Project.findOneAndDelete({
      ...ownershipFilter,
      _id: projectId,
    });
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

    const ownershipFilter = buildProfessionalOwnershipFilter(
      professionalId.toString()
    );
    const projectId = Types.ObjectId.isValid(id)
      ? new Types.ObjectId(id)
      : id;
    const project = await Project.findOne({
      ...ownershipFilter,
      _id: projectId,
    });
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

    const ownershipFilter = buildProfessionalOwnershipFilter(
      professionalId.toString()
    );
    const filterConditions: any[] = [ownershipFilter];

    if (status && status !== "all") {
      if (status === "rejected") {
        filterConditions.push({ status: "rejected" });
      } else if (status === "cancelled") {
        filterConditions.push({ status: "closed" });
      } else {
        filterConditions.push({ status });
      }
    }

    if (category && category !== "all") {
      filterConditions.push({
        $or: [{ category }, { "services.category": category }],
      });
    }

    if (search) {
      const regex = new RegExp(search, "i");
      filterConditions.push({
        $or: [{ title: regex }, { description: regex }, { keywords: regex }],
      });
    }

    const filter =
      filterConditions.length === 1
        ? ownershipFilter
        : { $and: filterConditions };

    const [items, total, counts] = await Promise.all([
      Project.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Project.countDocuments(filter),
      // Status counts for header cards
      (async () => {
        const ownershipMatchStage = ownershipFilter;
        const pipeline = [
          { $match: ownershipMatchStage },
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
        const rejectionFilter = {
          $and: [ownershipFilter, { status: "rejected" }],
        };
        const rejected = await Project.countDocuments(rejectionFilter);

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
