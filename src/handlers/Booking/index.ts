import { Request, Response, NextFunction } from "express";
import Booking, { IBooking, BookingStatus } from "../../models/booking";
import User, { IUser } from "../../models/user";
import Project from "../../models/project";
import mongoose from "mongoose";
import {
  buildProjectScheduleWindow,
  validateProjectScheduleSelection,
} from "../../utils/scheduleEngine";

// Create a new booking (RFQ submission)
export const createBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id; // From auth middleware
    const {
      bookingType, // 'professional' or 'project'
      professionalId,
      projectId,
      rfqData, // Service type, description, answers, budget, etc.
      preferredStartDate,
      preferredStartTime,
      selectedSubprojectIndex,
      urgency,
      customerBlocks
    } = req.body;
    const resolvedPreferredStartDate = preferredStartDate || rfqData?.preferredStartDate;
    const resolvedPreferredStartTime = preferredStartTime || rfqData?.preferredStartTime;

    const resolveDurationValue = (
      source?: { value?: number; unit?: 'hours' | 'days' } | null
    ): { value: number; unit: 'hours' | 'days' } => ({
      value: source?.value || 0,
      unit: (source?.unit || 'days') as 'hours' | 'days'
    });

    const computeSchedulePlan = async (
      projectDoc: any,
      subprojectIndex: number | null | undefined,
      scheduledStart: Date,
      teamMembers: IUser[]
    ) => {
      const subproject =
        typeof subprojectIndex === 'number' && projectDoc.subprojects?.[subprojectIndex]
          ? projectDoc.subprojects[subprojectIndex]
          : null;

      const execution = resolveDurationValue(subproject?.executionDuration || projectDoc.executionDuration);
      if (execution.value <= 0) {
        return null;
      }

      const bufferSource = subproject?.buffer || projectDoc.bufferDuration;
      const buffer = bufferSource ? resolveDurationValue(bufferSource) : { value: 0, unit: execution.unit };

      const scheduleStart = new Date(scheduledStart);
      let scheduleEnd: Date;
      if (execution.unit === 'hours') {
        scheduleEnd = new Date(scheduleStart);
        scheduleEnd.setHours(scheduleEnd.getHours() + execution.value);
      } else {
        if (teamMembers.length > 0) {
          scheduleEnd = await addWorkingDays(scheduleStart, execution.value, teamMembers);
        } else {
          scheduleEnd = new Date(scheduleStart);
          scheduleEnd.setDate(scheduleEnd.getDate() + execution.value);
        }
      }

      let bufferEnd: Date;
      if (buffer.unit === 'hours') {
        bufferEnd = new Date(scheduleEnd);
        bufferEnd.setHours(bufferEnd.getHours() + buffer.value);
      } else if (buffer.value > 0) {
        if (teamMembers.length > 0) {
          const lastBufferDay = await addWorkingDays(scheduleEnd, buffer.value + 1, teamMembers);
          bufferEnd = new Date(lastBufferDay);
          bufferEnd.setDate(bufferEnd.getDate() + 1); // Make end exclusive
        } else {
          bufferEnd = new Date(scheduleEnd);
          bufferEnd.setDate(bufferEnd.getDate() + buffer.value + 1); // +1 for exclusive end
        }
      } else {
        bufferEnd = new Date(scheduleEnd);
      }

      return {
        scheduleStart,
        scheduleEnd,
        bufferEnd,
        executionValue: execution.value,
        executionUnit: execution.unit,
        bufferValue: buffer.value,
        bufferUnit: buffer.unit
      };
    };

    const getBookingInterval = async (
      bookingDoc: any,
      projectDoc: any,
      teamMembers: IUser[]
    ): Promise<{ start: Date; end: Date } | null> => {
      if (bookingDoc.scheduledStartDate && bookingDoc.scheduledEndDate) {
        return {
          start: new Date(bookingDoc.scheduledStartDate),
          end: new Date(bookingDoc.scheduledEndDate)
        };
      }

      if (!bookingDoc.rfqData?.preferredStartDate) {
        return null;
      }

      const intervalStart = new Date(bookingDoc.rfqData.preferredStartDate);
      if (bookingDoc.rfqData.preferredStartTime) {
        const [hours, minutes] = bookingDoc.rfqData.preferredStartTime.split(':').map(Number);
        if (!Number.isNaN(hours) && !Number.isNaN(minutes)) {
          intervalStart.setHours(hours, minutes, 0, 0);
        }
      }

      const subproject =
        typeof bookingDoc.selectedSubprojectIndex === 'number' &&
        projectDoc.subprojects?.[bookingDoc.selectedSubprojectIndex]
          ? projectDoc.subprojects[bookingDoc.selectedSubprojectIndex]
          : null;
      const execution = resolveDurationValue(subproject?.executionDuration || projectDoc.executionDuration);
      if (execution.value <= 0) {
        return null;
      }

      let intervalEnd: Date;
      if (execution.unit === 'hours') {
        intervalEnd = new Date(intervalStart);
        intervalEnd.setHours(intervalEnd.getHours() + execution.value);
      } else {
        if (teamMembers.length > 0) {
          intervalEnd = await addWorkingDays(intervalStart, execution.value, teamMembers);
        } else {
          intervalEnd = new Date(intervalStart);
          intervalEnd.setDate(intervalEnd.getDate() + execution.value);
        }
      }

      return {
        start: intervalStart,
        end: intervalEnd
      };
    };

    let projectDoc: any = null;
    let projectResourceIds: string[] = [];
    let projectTeamMembers: IUser[] = [];

    // Validate required fields
    if (!bookingType || (bookingType !== 'professional' && bookingType !== 'project')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking type. Must be 'professional' or 'project'"
      });
    }

    if (bookingType === 'professional' && !professionalId) {
      return res.status(400).json({
        success: false,
        msg: "Professional ID is required for professional bookings"
      });
    }

    if (bookingType === 'project' && !projectId) {
      return res.status(400).json({
        success: false,
        msg: "Project ID is required for project bookings"
      });
    }

    if (!rfqData || !rfqData.serviceType || !rfqData.description) {
      return res.status(400).json({
        success: false,
        msg: "RFQ data with service type and description is required"
      });
    }

    // Calculate total price including add-ons for project bookings
    let calculatedTotal = 0;
    let addOnsTotal = 0;

    if (bookingType === 'project' && projectId) {
      const project = await Project.findById(projectId);

      if (project && typeof selectedSubprojectIndex === 'number') {
        const subproject = project.subprojects[selectedSubprojectIndex];

        if (subproject) {
          // Calculate base price
          if (subproject.pricing.type === 'fixed' && subproject.pricing.amount) {
            calculatedTotal = subproject.pricing.amount;
          } else if (subproject.pricing.type === 'unit' && subproject.pricing.amount && estimatedUsage) {
            calculatedTotal = subproject.pricing.amount * estimatedUsage;
          }

          // Calculate add-ons total
          if (selectedExtraOptions && Array.isArray(selectedExtraOptions) && selectedExtraOptions.length > 0) {
            addOnsTotal = selectedExtraOptions.reduce((sum: number, idx: number) => {
              const option = project.extraOptions?.[idx];
              return sum + (option?.price || 0);
            }, 0);

            calculatedTotal += addOnsTotal;
          }

          console.log('[BOOKING] Price calculation:', {
            basePrice: calculatedTotal - addOnsTotal,
            addOnsTotal,
            grandTotal: calculatedTotal,
            selectedExtraOptions
          });
        }
      }
    }

    // Normalize budget: use calculated total if available, otherwise use frontend-provided budget
    const normalizedBudget =
      calculatedTotal > 0
        ? {
            min: calculatedTotal,
            max: calculatedTotal,
            currency: "EUR",
          }
        : rfqData && typeof rfqData.budget === "number"
        ? {
            min: rfqData.budget,
            max: rfqData.budget,
            currency: "EUR",
          }
        : rfqData?.budget;

    // Get customer details with location
    const customer = await User.findById(userId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        msg: "Customer not found"
      });
    }

    if (customer.role !== 'customer') {
      return res.status(403).json({
        success: false,
        msg: "Only customers can create bookings"
      });
    }

    // Validate customer has location set
    if (!customer.location || !customer.location.coordinates || customer.location.coordinates.length !== 2) {
      return res.status(400).json({
        success: false,
        msg: "Customer location is required. Please update your profile with your address."
      });
    }

    // Create booking payload (base fields)
    const bookingData: any = {
      customer: userId,
      bookingType,
      status: 'rfq',
      location: {
        type: 'Point',
        coordinates: customer.location.coordinates,
        address: customer.location.address,
        city: customer.location.city,
        country: customer.location.country,
        postalCode: customer.location.postalCode
      },
      rfqData: {
        serviceType: rfqData.serviceType,
        description: rfqData.description,
        answers: rfqData.answers || [],
        preferredStartDate: resolvedPreferredStartDate,
        preferredStartTime: resolvedPreferredStartTime,
        urgency: urgency || rfqData.urgency || 'medium',
        budget: normalizedBudget,
        attachments: rfqData.attachments || []
      }
    };

    if (customerBlocks) {
      bookingData.customerBlocks = customerBlocks;
    }

    // Validate professional or project exists
    if (bookingType === 'professional') {
      const professional = await User.findById(professionalId);
      if (!professional || professional.role !== 'professional') {
        return res.status(404).json({
          success: false,
          msg: "Professional not found"
        });
      }

      if (professional.professionalStatus !== 'approved') {
        return res.status(400).json({
          success: false,
          msg: "Professional is not approved to accept bookings"
        });
      }

      bookingData.professional = professionalId;
    } else {
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({
          success: false,
          msg: "Project not found"
        });
      }

      if (project.status !== 'published') {
        return res.status(400).json({
          success: false,
          msg: "Project is not available for booking"
        });
      }

      bookingData.project = projectId;
      bookingData.professional = project.professionalId;

      let fallbackTeamMembers: mongoose.Types.ObjectId[] | null = null;
      // Validate and normalize resource IDs, filtering out invalid entries and duplicates
      if (project.resources && Array.isArray(project.resources) && project.resources.length > 0) {
        const seenIds = new Set<string>();
        const validTeamMembers: mongoose.Types.ObjectId[] = [];

        for (const id of project.resources) {
          // Skip null/undefined values
          if (id == null) continue;

          // Convert to string for validation and deduplication
          const idStr = typeof id === 'string' ? id : String(id);

          // Validate the ID format
          if (!mongoose.isValidObjectId(idStr)) continue;

          // Skip duplicates
          if (seenIds.has(idStr)) continue;

          seenIds.add(idStr);
          validTeamMembers.push(new mongoose.Types.ObjectId(idStr));
        }

        if (validTeamMembers.length > 0) {
          fallbackTeamMembers = validTeamMembers;
        }
      }

      const rawStartDate =
        preferredStartDate || rfqData?.preferredStartDate || undefined;
      const rawStartTime =
        preferredStartTime || rfqData?.preferredStartTime || undefined;
      const normalizedStartDate =
        typeof rawStartDate === "string"
          ? /^\d{4}-\d{2}-\d{2}$/.test(rawStartDate)
            ? rawStartDate
            : (() => {
                const parsed = new Date(rawStartDate);
                if (Number.isNaN(parsed.getTime())) return rawStartDate;
                return parsed.toISOString().slice(0, 10);
              })()
          : undefined;

      const parsedSubprojectIndex =
        typeof selectedSubprojectIndex === "number"
          ? selectedSubprojectIndex
          : typeof selectedSubprojectIndex === "string"
          ? Number.parseInt(selectedSubprojectIndex, 10)
          : undefined;
      const subprojectIndex =
        typeof parsedSubprojectIndex === "number" &&
        !Number.isNaN(parsedSubprojectIndex)
          ? parsedSubprojectIndex
          : undefined;

      const validation = await validateProjectScheduleSelection({
        projectId,
        subprojectIndex,
        startDate: normalizedStartDate,
        startTime: typeof rawStartTime === "string" ? rawStartTime : undefined,
        customerBlocks,
      });

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          msg: validation.reason || "Selected schedule is not available",
        });
      }

      if (normalizedStartDate) {
        const window = await buildProjectScheduleWindow({
          projectId,
          subprojectIndex,
          startDate: normalizedStartDate,
          startTime: typeof rawStartTime === "string" ? rawStartTime : undefined,
          customerBlocks,
        });

        if (!window) {
          return res.status(400).json({
            success: false,
            msg: "Unable to schedule the selected window",
          });
        }

        bookingData.scheduledStartDate = window.scheduledStartDate;
        if (window.scheduledExecutionEndDate) {
          bookingData.scheduledExecutionEndDate = window.scheduledExecutionEndDate;
        }
        if (window.scheduledBufferStartDate) {
          bookingData.scheduledBufferStartDate = window.scheduledBufferStartDate;
        }
        if (window.scheduledBufferEndDate) {
          bookingData.scheduledBufferEndDate = window.scheduledBufferEndDate;
        }
        if (window.scheduledBufferUnit) {
          bookingData.scheduledBufferUnit = window.scheduledBufferUnit;
        }
        if (window.scheduledStartTime) {
          bookingData.scheduledStartTime = window.scheduledStartTime;
        }
        if (window.scheduledEndTime) {
          bookingData.scheduledEndTime = window.scheduledEndTime;
        }
        if (window.assignedTeamMembers && window.assignedTeamMembers.length > 0) {
          bookingData.assignedTeamMembers = window.assignedTeamMembers;
        }
      }

      if (!bookingData.assignedTeamMembers && fallbackTeamMembers) {
        bookingData.assignedTeamMembers = fallbackTeamMembers;
      }
    }

    const booking = await Booking.create(bookingData);

    // For project bookings, block dates immediately when booking is created
    // This prevents double-booking even in RFQ stage
    if (bookingType === 'project' && projectId && schedulePlan) {
      console.log('[BOOKING] Blocking dates immediately for new project booking (RFQ stage)');

      if (projectResourceIds.length) {
        const reason = `project-booking:${(booking._id as mongoose.Types.ObjectId).toString()}`;
        console.log('[BOOKING] Blocking resources:', projectResourceIds);
        console.log('[BOOKING] Blocking period:', schedulePlan.scheduleStart, 'to', schedulePlan.bufferEnd);

        await User.updateMany(
          { _id: { $in: projectResourceIds } },
          {
            $push: {
              blockedRanges: {
                startDate: schedulePlan.scheduleStart,
                endDate: schedulePlan.bufferEnd,
                executionEndDate: schedulePlan.scheduleEnd,
                reason,
                createdAt: new Date(),
              },
            },
          }
        );

        console.log('? Blocked dates immediately for new booking');
      } else {
        console.warn('[BOOKING] No resources available to block for this project.');
      }
    }

    // Populate references for response
    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' },
      { path: 'project', select: 'title description pricing' }
    ]);

    return res.status(201).json({
      success: true,
      msg: "Booking request created successfully",
      booking
    });

  } catch (error: any) {
    console.error('Create booking error:', error);

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({
        success: false,
        msg: messages.join(', ')
      });
    }

    next(error);
  }
};

// Get bookings for current user (customer or professional)
export const getMyBookings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { status, page = 1, limit = 20 } = req.query;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        msg: "User not found"
      });
    }

    const query: any = {};

    // Build query based on user role
    if (user.role === 'customer') {
      query.customer = userId;
    } else if (user.role === 'professional') {
      const projectIds = await Project.find({
        professionalId: userId,
      }).select("_id");
      const projectIdList = projectIds.map((project) => project._id);
      query.$or = [
        { professional: userId },
        { project: { $in: projectIdList } },
      ];
    } else {
      return res.status(403).json({
        success: false,
        msg: "Only customers and professionals can view bookings"
      });
    }

    // Filter by status if provided
    if (status && typeof status === 'string') {
      query.status = status;
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [bookings, total] = await Promise.all([
      Booking.find(query)
        .populate('customer', 'name email phone customerType')
        .populate('professional', 'name email businessInfo')
        .populate('project', 'title description pricing category service')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Booking.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      bookings,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit))
      }
    });

  } catch (error: any) {
    console.error('Get bookings error:', error);
    next(error);
  }
};

// Get single booking by ID
export const getBookingById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId ? userId.toString() : '';
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID"
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email businessInfo hourlyRate')
      .populate('project', 'title description pricing category service team postBookingQuestions')
      .populate('assignedTeamMembers', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization - only customer or professional can view
    const isCustomer = booking.customer._id.toString() === userIdString;
    const isProfessional = booking.professional?._id.toString() === userIdString;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to view this booking"
      });
    }

    return res.status(200).json({
      success: true,
      booking
    });

  } catch (error: any) {
    console.error('Get booking error:', error);
    next(error);
  }
};

export const submitPostBookingAnswers = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?._id;
    const userIdString = userId ? userId.toString() : '';
    const { bookingId } = req.params;
    const { answers } = req.body as {
      answers?: Array<{ questionId?: string; question?: string; answer?: string }>;
    };

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID",
      });
    }

    if (!Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        msg: "Answers are required",
      });
    }

    const booking = await Booking.findById(bookingId).populate(
      "project",
      "postBookingQuestions"
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found",
      });
    }

    if (booking.customer.toString() !== userIdString) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to submit answers for this booking",
      });
    }

    if ((booking.postBookingData?.length || 0) > 0) {
      return res.status(400).json({
        success: false,
        msg: "Post-booking answers already submitted",
      });
    }

    const project = booking.project as any;
    const postBookingQuestions = project?.postBookingQuestions || [];
    if (postBookingQuestions.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "No post-booking questions available for this booking",
      });
    }

    const normalizedAnswers = answers.map((answer) => ({
      questionId: answer.questionId || "",
      question: answer.question || "",
      answer: (answer.answer || "").trim(),
    }));

    const hasMissingRequired = postBookingQuestions.some((question: any) => {
      if (!question?.isRequired) {
        return false;
      }

      const questionId = question._id?.toString() || question.id;
      const matched = normalizedAnswers.find((answer) => {
        if (questionId && answer.questionId === questionId) {
          return true;
        }
        if (question?.question && answer.question === question.question) {
          return true;
        }
        return false;
      });

      return !matched || !matched.answer;
    });

    if (hasMissingRequired) {
      return res.status(400).json({
        success: false,
        msg: "Please answer all required questions",
      });
    }

    booking.postBookingData = normalizedAnswers.filter(
      (answer) => answer.answer
    ) as any;

    await booking.save();

    return res.status(200).json({
      success: true,
      msg: "Post-booking answers submitted successfully",
      postBookingData: booking.postBookingData,
    });
  } catch (error: any) {
    console.error("Submit post-booking answers error:", error);
    next(error);
  }
};

// Submit quote (Professional only)
export const submitQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { bookingId } = req.params;
    const {
      amount,
      currency,
      description,
      breakdown,
      validUntil,
      termsAndConditions,
      estimatedDuration
    } = req.body;

    // Validate
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        msg: "Valid quote amount is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check if user is the professional for this booking
    if (booking.professional?.toString() !== userId?.toString()) {
      return res.status(403).json({
        success: false,
        msg: "Only the assigned professional can submit a quote"
      });
    }

    // Check booking status
    if (booking.status !== 'rfq') {
      return res.status(400).json({
        success: false,
        msg: "Quote can only be submitted for RFQ bookings"
      });
    }

    // Update booking with quote
    booking.quote = {
      amount,
      currency: currency || 'EUR',
      description,
      breakdown,
      validUntil: validUntil ? new Date(validUntil) : undefined,
      termsAndConditions,
      estimatedDuration,
      submittedAt: new Date(),
      submittedBy: new mongoose.Types.ObjectId(userId as string)
    };

    await (booking as any).updateStatus('quoted', userId, 'Quote submitted by professional');

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' }
    ]);

    return res.status(200).json({
      success: true,
      msg: "Quote submitted successfully",
      booking
    });

  } catch (error: any) {
    console.error('Submit quote error:', error);
    next(error);
  }
};

// Accept/Reject quote (Customer only)
export const respondToQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { bookingId } = req.params;
    const { action } = req.body; // 'accept' or 'reject'

    if (!action || (action !== 'accept' && action !== 'reject')) {
      return res.status(400).json({
        success: false,
        msg: "Invalid action. Must be 'accept' or 'reject'"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check if user is the customer
    if (booking.customer.toString() !== userId?.toString()) {
      return res.status(403).json({
        success: false,
        msg: "Only the customer can respond to quotes"
      });
    }

    // Check booking status
    if (booking.status !== 'quoted') {
      return res.status(400).json({
        success: false,
        msg: "Can only respond to bookings with submitted quotes"
      });
    }

    const newStatus: BookingStatus = action === 'accept' ? 'quote_accepted' : 'quote_rejected';
    const note = action === 'accept' ? 'Quote accepted by customer' : 'Quote rejected by customer';

    await (booking as any).updateStatus(newStatus, userId, note);

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' }
    ]);

    return res.status(200).json({
      success: true,
      msg: `Quote ${action}ed successfully`,
      booking
    });

  } catch (error: any) {
    console.error('Respond to quote error:', error);
    next(error);
  }
};

// Update booking status
export const updateBookingStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { bookingId } = req.params;
    const { status, note } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        msg: "Status is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization
    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to update this booking"
      });
    }

    const previousStatus = booking.status;
    await (booking as any).updateStatus(status, userId, note);

    // Ensure TypeScript treats the booking id as a string for later use
    const bookingIdStr = (booking as any)._id?.toString();

    // When a project booking is confirmed or started, ensure dates are blocked
    // This is redundant now (dates blocked at creation), but kept as safety net
    if (
      booking.bookingType === 'project' &&
      (status === 'booked' || status === 'in_progress') &&
      previousStatus !== 'booked' &&
      previousStatus !== 'in_progress' &&
      booking.project
    ) {
      console.log('🔒 Verifying/ensuring dates are blocked for booking:', bookingIdStr);
      const project = await Project.findById(booking.project);
      if (project && project.executionDuration) {
        const mode: 'hours' | 'days' =
          project.timeMode || project.executionDuration.unit || 'days';

        const executionValue = project.executionDuration.value || 0;
        const executionUnit = project.executionDuration.unit || 'days';

        // Buffer duration is optional, default to 0 if not set
        const bufferValue = project.bufferDuration?.value || 0;
        const bufferUnit = project.bufferDuration?.unit || executionUnit;

        const start =
          booking.scheduledStartDate ||
          booking.rfqData?.preferredStartDate ||
          new Date();

        console.log('📊 Project details:', {
          timeMode: mode,
          executionDuration: `${executionValue} ${executionUnit}`,
          bufferDuration: `${bufferValue} ${bufferUnit}`,
          minResources: project.minResources,
          resourceCount: project.resources?.length || 0
        });

        const scheduleStart = new Date(start);
        let scheduleEnd: Date;
        let bufferEnd: Date;

        // Get team members for working days calculation
        const projectData = project as any;
        const teamResourceIds: string[] = Array.isArray(projectData.resources)
          ? projectData.resources.map((r: any) => r.toString())
          : [];
        if (!teamResourceIds.length && projectData.professionalId) {
          teamResourceIds.push(projectData.professionalId.toString());
        }
        const teamMembers: IUser[] = teamResourceIds.length
          ? await User.find({ _id: { $in: teamResourceIds } })
          : [];

        if (executionUnit === 'hours') {
          // Hours mode: just add hours
          scheduleEnd = new Date(scheduleStart);
          scheduleEnd.setHours(scheduleEnd.getHours() + executionValue);
        } else {
          // Days mode: use working days calculation
          if (teamMembers.length > 0) {
            scheduleEnd = await addWorkingDays(scheduleStart, executionValue, teamMembers);
          } else {
            scheduleEnd = new Date(scheduleStart);
            scheduleEnd.setDate(scheduleEnd.getDate() + executionValue);
          }
        }

        // Compute buffer end
        if (bufferUnit === 'hours') {
          bufferEnd = new Date(scheduleEnd);
          bufferEnd.setHours(bufferEnd.getHours() + bufferValue);
        } else if (bufferValue > 0) {
          if (teamMembers.length > 0) {
            const lastBufferDay = await addWorkingDays(scheduleEnd, bufferValue + 1, teamMembers);
            bufferEnd = new Date(lastBufferDay);
            bufferEnd.setDate(bufferEnd.getDate() + 1); // Make end exclusive
          } else {
            bufferEnd = new Date(scheduleEnd);
            bufferEnd.setDate(bufferEnd.getDate() + bufferValue + 1); // +1 for exclusive end
          }
        } else {
          bufferEnd = new Date(scheduleEnd);
        }

        console.log('📅 Calculated dates:', {
          start: scheduleStart,
          executionEnd: scheduleEnd,
          bufferEnd: bufferEnd,
          totalDuration: `${Math.round((bufferEnd.getTime() - scheduleStart.getTime()) / (1000 * 60 * 60))} hours`
        });

        booking.scheduledStartDate = scheduleStart;
        // Use bufferEnd for scheduledEndDate so professional's calendar is blocked including buffer time
        booking.scheduledEndDate = bufferEnd;
        booking.scheduledExecutionEndDate = scheduleEnd;
        await booking.save();

        // Block execution + buffer in team calendars via blockedRanges with a reason tag.
        const projectDoc = project as any;
        const resourceIds: string[] = Array.isArray(projectDoc.resources)
          ? projectDoc.resources.map((r: any) => r.toString())
          : [];
        if (!resourceIds.length && projectDoc.professionalId) {
          resourceIds.push(projectDoc.professionalId.toString());
        }

	        if (resourceIds.length && bookingIdStr) {
	          const reason = `project-booking:${bookingIdStr}`;

          // Check if already blocked to avoid duplicates
          const alreadyBlocked = await User.findOne({
            _id: { $in: resourceIds },
            'blockedRanges.reason': reason
          });

          if (!alreadyBlocked) {
            console.log('🔒 Blocking resources:', resourceIds);
            console.log('🔒 Blocking period:', scheduleStart, 'to', bufferEnd);

            await User.updateMany(
              { _id: { $in: resourceIds } },
              {
                $push: {
                  blockedRanges: {
                    startDate: scheduleStart,
                    endDate: bufferEnd,
                    executionEndDate: scheduleEnd,
                    reason,
                    createdAt: new Date(),
                  },
                },
              }
            );

            console.log('✅ Successfully blocked dates for', resourceIds.length, 'resources');
          } else {
            console.log('ℹ️ Dates already blocked for this booking, skipping');
          }
        }
      }
    }

    // When a project booking is completed, cancelled, or rejected, release blocked dates
	    if (
	      booking.bookingType === 'project' &&
	      (status === 'completed' || status === 'cancelled' || status === 'quote_rejected') &&
	      bookingIdStr
	    ) {
	      const reason = `project-booking:${bookingIdStr}`;
        console.log('🔓 Releasing blocked dates for booking:', bookingIdStr, '(Status:', status, ')');

        const result = await User.updateMany(
          { 'blockedRanges.reason': reason },
          { $pull: { blockedRanges: { reason } } }
        );

        console.log('✅ Released blocked dates for', result.modifiedCount, 'resources');
    }

    await booking.populate([
      { path: 'customer', select: 'name email phone' },
      { path: 'professional', select: 'name email businessInfo' }
    ]);

    return res.status(200).json({
      success: true,
      msg: "Booking status updated successfully",
      booking
    });

  } catch (error: any) {
    console.error('Update booking status error:', error);
    next(error);
  }
};

// Cancel booking
export const cancelBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { bookingId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        msg: "Cancellation reason is required"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization
    const isCustomer = booking.customer.toString() === userId;
    const isProfessional = booking.professional?.toString() === userId;

    if (!isCustomer && !isProfessional) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to cancel this booking"
      });
    }

    // Cannot cancel completed bookings
    if (booking.status === 'completed') {
      return res.status(400).json({
        success: false,
        msg: "Cannot cancel completed bookings"
      });
    }

    booking.cancellation = {
      cancelledBy: new mongoose.Types.ObjectId(userId as string),
      reason,
      cancelledAt: new Date()
    };

    await (booking as any).updateStatus('cancelled', userId, `Booking cancelled: ${reason}`);

    return res.status(200).json({
      success: true,
      msg: "Booking cancelled successfully",
      booking
    });

  } catch (error: any) {
    console.error('Cancel booking error:', error);
    next(error);
  }
};

// Submit post-booking answers
export const submitPostBookingAnswers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?._id;
    const { bookingId } = req.params;
    const { answers } = req.body;

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        msg: "Answers are required and must be an array"
      });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Only the customer who made the booking can submit answers
    if (booking.customer.toString() !== userId?.toString()) {
      return res.status(403).json({
        success: false,
        msg: "You do not have permission to submit answers for this booking"
      });
    }

    // Validate answer format
    const validatedAnswers = answers.map((answer: any, index: number) => ({
      questionId: answer.questionId || `q-${index}`,
      question: answer.question || '',
      answer: answer.answer || ''
    })).filter((a: any) => a.question && a.answer);

    // Update booking with post-booking data
    booking.postBookingData = validatedAnswers;
    await booking.save();

    console.log('[BOOKING] Post-booking answers saved for booking:', bookingId);

    return res.status(200).json({
      success: true,
      msg: "Post-booking answers submitted successfully",
      booking
    });

  } catch (error: any) {
    console.error('Submit post-booking answers error:', error);
    next(error);
  }
};
