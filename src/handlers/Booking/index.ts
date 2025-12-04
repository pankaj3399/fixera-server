import { Request, Response, NextFunction } from "express";
import Booking, { IBooking, BookingStatus } from "../../models/booking";
import User from "../../models/user";
import Project from "../../models/project";
import mongoose from "mongoose";

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
      urgency,
      selectedExtraOptions,
      selectedSubprojectIndex,
      estimatedUsage
    } = req.body;

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

        // Enforce preparation time rule: client cannot book before preparation time has passed.
        const preferredStart = preferredStartDate || rfqData?.preferredStartDate;
        if (preferredStart && project.preparationDuration) {
          const now = new Date();
          const prepValue = project.preparationDuration.value || 0;
          const prepUnit = project.preparationDuration.unit || "days";
          const earliestBookable = new Date(now);
          if (prepUnit === "hours") {
            earliestBookable.setHours(earliestBookable.getHours() + prepValue);
          } else {
            earliestBookable.setDate(earliestBookable.getDate() + prepValue);
          }

          const preferred = new Date(preferredStart);
          if (preferred < earliestBookable) {
            return res.status(400).json({
              success: false,
              msg: "Selected start date is earlier than allowed by preparation time",
            });
          }
        }

        // Validate selected extra options if provided
        if (selectedExtraOptions && Array.isArray(selectedExtraOptions)) {
          if (selectedExtraOptions.length > 0) {
            // Verify all selected option indices are valid
            const maxIndex = project.extraOptions?.length || 0;
            const invalidOptions = selectedExtraOptions.filter(
              (idx: number) => typeof idx !== 'number' || idx < 0 || idx >= maxIndex
            );

            if (invalidOptions.length > 0) {
              return res.status(400).json({
                success: false,
                msg: "Invalid extra option selection. Some selected options do not exist.",
              });
            }
          }
        }
      }

    // For project bookings, check if date is available before creating booking
    if (bookingType === 'project' && projectId && (preferredStartDate || rfqData.preferredStartDate)) {
      const requestedDate = new Date(preferredStartDate || rfqData.preferredStartDate);
      const project = await Project.findById(projectId);

      if (project) {
        // Get resources
        const resourceIds: string[] = Array.isArray((project as any).resources)
          ? (project as any).resources.map((r: any) => r.toString())
          : [];
        if (!resourceIds.length && (project as any).professionalId) {
          resourceIds.push((project as any).professionalId.toString());
        }

        if (resourceIds.length > 0) {
          // Check if any resource has the date blocked
          const users = await User.find({ _id: { $in: resourceIds } });

          for (const user of users) {
            // Check blocked ranges
            if (user.blockedRanges) {
              for (const range of user.blockedRanges) {
                if (requestedDate >= range.startDate && requestedDate <= range.endDate) {
                  return res.status(400).json({
                    success: false,
                    msg: `The selected date is not available. This resource is blocked from ${range.startDate.toISOString()} to ${range.endDate.toISOString()}.`
                  });
                }
              }
            }
          }
        }
      }
    }

    // Prepare selected extra options with full details for storage
    let extraOptionsWithDetails: any[] = [];
    if (bookingType === 'project' && selectedExtraOptions && Array.isArray(selectedExtraOptions) && selectedExtraOptions.length > 0) {
      const project = await Project.findById(projectId);
      if (project && project.extraOptions) {
        extraOptionsWithDetails = selectedExtraOptions.map((idx: number) => {
          const option = project.extraOptions[idx];
          return {
            index: idx,
            name: option.name,
            description: option.description,
            price: option.price
          };
        });
      }
    }

    // Create booking
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
        preferredStartDate: preferredStartDate || rfqData.preferredStartDate,
        urgency: urgency || rfqData.urgency || 'medium',
        budget: normalizedBudget,
        attachments: rfqData.attachments || []
      }
    };

    if (bookingType === 'professional') {
      bookingData.professional = professionalId;
    } else {
      bookingData.project = projectId;
      // For project bookings, set scheduledStartDate from preferred date
      if (preferredStartDate || rfqData.preferredStartDate) {
        bookingData.scheduledStartDate = new Date(preferredStartDate || rfqData.preferredStartDate);
      }
      // Store project booking specific data
      if (typeof selectedSubprojectIndex === 'number') {
        bookingData.selectedSubprojectIndex = selectedSubprojectIndex;
      }
      if (estimatedUsage) {
        bookingData.estimatedUsage = estimatedUsage;
      }
      if (extraOptionsWithDetails.length > 0) {
        bookingData.selectedExtraOptions = extraOptionsWithDetails;
      }
    }

    const booking = await Booking.create(bookingData);

    // For project bookings, block dates immediately when booking is created
    // This prevents double-booking even in RFQ stage
    if (bookingType === 'project' && projectId && bookingData.scheduledStartDate) {
      console.log('🔒 Blocking dates immediately for new project booking (RFQ stage)');
      const project = await Project.findById(projectId);

      if (project && project.executionDuration) {
        const executionValue = project.executionDuration.value || 0;
        const executionUnit = project.executionDuration.unit || 'days';
        const bufferValue = project.bufferDuration?.value || 0;
        const bufferUnit = project.bufferDuration?.unit || executionUnit;

        const scheduleStart = new Date(bookingData.scheduledStartDate);
        let scheduleEnd = new Date(scheduleStart);

        if (executionUnit === 'hours') {
          scheduleEnd.setHours(scheduleEnd.getHours() + executionValue);
        } else {
          scheduleEnd.setDate(scheduleEnd.getDate() + executionValue);
        }

        let bufferEnd = new Date(scheduleEnd);
        if (bufferUnit === 'hours') {
          bufferEnd.setHours(bufferEnd.getHours() + bufferValue);
        } else {
          bufferEnd.setDate(bufferEnd.getDate() + bufferValue);
        }

        // Update booking with calculated dates
        booking.scheduledEndDate = scheduleEnd;
        await booking.save();

        // Block resources
        const resourceIds: string[] = Array.isArray((project as any).resources)
          ? (project as any).resources.map((r: any) => r.toString())
          : [];
        if (!resourceIds.length && (project as any).professionalId) {
          resourceIds.push((project as any).professionalId.toString());
        }

        if (resourceIds.length) {
          const reason = `project-booking:${(booking._id as mongoose.Types.ObjectId).toString()}`;
          console.log('🔒 Blocking resources:', resourceIds);
          console.log('🔒 Blocking period:', scheduleStart, 'to', bufferEnd);

          await User.updateMany(
            { _id: { $in: resourceIds } },
            {
              $push: {
                blockedRanges: {
                  startDate: scheduleStart,
                  endDate: bufferEnd,
                  reason,
                  createdAt: new Date(),
                },
              },
            }
          );

          console.log('✅ Blocked dates immediately for new booking');
        }
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
      query.professional = userId;
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
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        msg: "Invalid booking ID"
      });
    }

    const booking = await Booking.findById(bookingId)
      .populate('customer', 'name email phone customerType location')
      .populate('professional', 'name email businessInfo hourlyRate availability')
      .populate('project', 'title description pricing category service team')
      .populate('assignedTeamMembers', 'name email');

    if (!booking) {
      return res.status(404).json({
        success: false,
        msg: "Booking not found"
      });
    }

    // Check authorization - only customer or professional can view
    const userIdStr = userId?.toString();
    const isCustomer = booking.customer._id.toString() === userIdStr;
    const isProfessional = booking.professional?._id.toString() === userIdStr;

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
    if (booking.professional?.toString() !== userId) {
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
    if (booking.customer.toString() !== userId) {
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
        let scheduleEnd = new Date(scheduleStart);

        if (executionUnit === 'hours') {
          scheduleEnd.setHours(scheduleEnd.getHours() + executionValue);
        } else {
          scheduleEnd.setDate(scheduleEnd.getDate() + executionValue);
        }

        // Compute end including buffer
        let bufferEnd = new Date(scheduleEnd);
        if (bufferUnit === 'hours') {
          bufferEnd.setHours(bufferEnd.getHours() + bufferValue);
        } else {
          bufferEnd.setDate(bufferEnd.getDate() + bufferValue);
        }

        console.log('📅 Calculated dates:', {
          start: scheduleStart,
          executionEnd: scheduleEnd,
          bufferEnd: bufferEnd,
          totalDuration: `${Math.round((bufferEnd.getTime() - scheduleStart.getTime()) / (1000 * 60 * 60))} hours`
        });

        booking.scheduledStartDate = scheduleStart;
        booking.scheduledEndDate = scheduleEnd;
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
