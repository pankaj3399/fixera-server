import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Meeting from '../../models/meeting';
import User from '../../models/user';
import Project from '../../models/project';
import { buildBookingBlockedRanges } from '../../utils/bookingBlocks';
import { UserFacingError } from '../../utils/appErrors';
import {
  meetingIntervalInTimeZone,
  professionalHasBusyConflict,
  resolveStoredCalendarTimeZone,
} from '../../utils/support/availability';
import { listSupportCalendarEvents } from '../../utils/support/calendarEvents';
import {
  buildCalendarReservationKeysForInterval,
  releaseCalendarReservations,
  reserveCalendarKeys,
} from '../../utils/support/calendarReservations';
import { withAnonymizationWriteFence } from '../../utils/support/accountGuard';

const meetingErrorResponse = (res: Response, error: unknown, message: string) => {
    if (error instanceof UserFacingError) {
        return res.status(error.status).json({
            success: false,
            message: error.message,
            msg: error.message,
            code: error.code,
        });
    }
    console.error(message, error);
    return res.status(500).json({ success: false, message, msg: message });
};

const professionalTimeZone = (professional: { timeZone?: string; businessInfo?: { timezone?: string } } | null) =>
    // Writers and readers must agree: the busy readers skip invalid IANA names
    // via resolveStoredCalendarTimeZone, so fall back the same way here.
    resolveStoredCalendarTimeZone(professional);

/**
 * Get employees' availability for a specific date range
 */
export const getEmployeeAvailability = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
        const { employeeIds, startDate, endDate } = req.body;

        if (!employeeIds || !Array.isArray(employeeIds) || employeeIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Employee IDs are required'
            });
        }

        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Start date and end date are required'
            });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);

        if (start >= end) {
            return res.status(400).json({
                success: false,
                message: 'End date must be after start date'
            });
        }

        // Get employees and verify they belong to the professional
        const employees = await User.find({
            _id: { $in: employeeIds },
            role: 'employee',
            'employee.companyId': professionalId,
            'employee.isActive': true
        }).select('name email availability blockedDates blockedRanges employee');

        if (employees.length !== employeeIds.length) {
            return res.status(404).json({
                success: false,
                message: 'One or more employees not found or not associated with your account'
            });
        }

        // Get existing meetings for these employees in the date range
        const existingMeetings = await Meeting.find({
            'attendees.userId': { $in: employeeIds },
            scheduledDate: { $gte: start, $lte: end },
            status: { $in: ['scheduled', 'rescheduled'] }
        }).select('scheduledDate startTime endTime attendees duration');

        // Build availability data for each employee (including booking-blocked ranges)
        const availabilityData = await Promise.all(employees.map(async (member) => {
            const memberMeetings = existingMeetings.filter(meeting =>
                meeting.attendees.some(attendee => attendee.userId === String(member._id))
            );

            // Get blocked dates within the range
            const blockedDatesInRange = member.blockedDates?.filter(blocked => {
                const blockedDate = new Date(blocked.date);
                return blockedDate >= start && blockedDate <= end;
            }) || [];

            // Get blocked ranges that overlap with the requested range
            const blockedRangesInRange = member.blockedRanges?.filter(range => {
                const rangeStart = new Date(range.startDate);
                const rangeEnd = new Date(range.endDate);
                return rangeStart <= end && rangeEnd >= start;
            }) || [];

            // Get booking-blocked ranges (when employee is assigned to active bookings)
            const memberId = String(member._id);
            const allBookingBlockedRanges = await buildBookingBlockedRanges(memberId);
            const bookingBlockedRangesInRange = allBookingBlockedRanges.filter(range => {
                const rangeStart = new Date(range.startDate);
                const rangeEnd = new Date(range.endDate);
                return rangeStart <= end && rangeEnd >= start;
            });

            return {
                userId: member._id,
                name: member.name,
                email: member.email,
                availability: member.availability || {},
                blockedDates: blockedDatesInRange,
                blockedRanges: blockedRangesInRange,
                bookingBlockedRanges: bookingBlockedRangesInRange,
                existingMeetings: memberMeetings.map(meeting => ({
                    meetingId: meeting._id,
                    date: meeting.scheduledDate,
                    startTime: meeting.startTime,
                    endTime: meeting.endTime,
                    duration: meeting.duration
                })),
                availabilityPreference: member.employee?.availabilityPreference || 'personal'
            };
        }));

        // Get the professional's company availability (for employees using same_as_company)
        const professional = await User.findById(professionalId).select('blockedDates blockedRanges companyAvailability companyBlockedDates companyBlockedRanges');

        // Company closures in the requested range (client bug list #21). The
        // meeting scheduler calendar reads per-employee entries only, so the
        // closures are attached to every employee as well as to
        // companyAvailability below.
        const companyBlockedDates = professional?.companyBlockedDates?.filter(blocked => {
            const blockedDate = new Date(blocked.date);
            return blockedDate >= start && blockedDate <= end;
        }) || [];
        const companyBlockedRanges = professional?.companyBlockedRanges?.filter(range => {
            const rangeStart = new Date(range.startDate);
            const rangeEnd = new Date(range.endDate);
            return rangeStart <= end && rangeEnd >= start;
        }) || [];

        res.status(200).json({
            success: true,
            data: {
                employees: availabilityData.map((entry) => ({
                    ...entry,
                    companyBlockedDates,
                    companyBlockedRanges,
                })),
                companyAvailability: {
                    availability: professional?.companyAvailability || {},
                    blockedDates: companyBlockedDates,
                    blockedRanges: companyBlockedRanges
                }
            }
        });

    } catch (error: any) {
        console.error('Get employee availability error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get employee availability. Please try again.',
        });
    }
};

/**
 * Create a new meeting (planning or team meeting)
 */
export const createMeeting = async (req: Request, res: Response) => {
    try {
        const professionalId = String(req.user!.professionalId || req.user!._id || '');
        const {
            projectId,
            meetingType,
            title,
            description,
            scheduledDate,
            startTime,
            endTime,
            duration,
            attendeeIds,
            location,
            meetingLink,
            isOnline,
            agenda
        } = req.body;

        // Validate required fields
        if (!projectId || !meetingType || !title || !scheduledDate || !startTime || !endTime || !duration) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Validate meeting type
        if (!['planning', 'team'].includes(meetingType)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid meeting type. Must be "planning" or "team"'
            });
        }

        // Verify project exists and belongs to the professional
        const project = await Project.findOne({
            _id: projectId,
            professionalId,
            category: 'Renovation'
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Renovation project not found or you do not have permission to create meetings for it'
            });
        }

        // Validate attendees if provided
        let attendees: Array<{ userId: string; name: string; role: string; status: string }> = [];
        if (attendeeIds && Array.isArray(attendeeIds) && attendeeIds.length > 0) {
            const employees = await User.find({
                _id: { $in: attendeeIds },
                role: 'employee',
                'employee.companyId': professionalId,
                'employee.isActive': true
            }).select('name');

            attendees = employees.map(member => ({
                userId: String(member._id),
                name: member.name,
                role: 'employee',
                status: 'pending'
            }));

            if (attendees.length !== attendeeIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'One or more employees not found or not active'
                });
            }
        }

        // Add the professional as an attendee
        const professional = await User.findById(professionalId).select('name timeZone businessInfo');
        attendees.unshift({
            userId: professionalId || '',
            name: professional!.name,
            role: 'professional',
            status: 'accepted'
        });

        const timeZone = professionalTimeZone(professional);
        const interval = meetingIntervalInTimeZone(
            new Date(scheduledDate),
            startTime,
            endTime,
            timeZone,
        );
        if (!interval) {
            return res.status(400).json({
                success: false,
                message: 'A valid meeting date and time range is required',
                msg: 'A valid meeting date and time range is required',
                code: 'VALIDATION',
            });
        }
        const intervalMinutes = Math.max(1, Math.round((interval.end - interval.start) / 60000));
        if (await professionalHasBusyConflict(professionalId, timeZone, new Date(interval.start), intervalMinutes)) {
            return res.status(409).json({
                success: false,
                message: 'This time overlaps another booking, meeting, or support reservation',
                msg: 'This time overlaps another booking, meeting, or support reservation',
                code: 'SLOT_UNAVAILABLE',
            });
        }

        // Create the meeting atomically with the shared calendar reservation.
        const meetingId = new Types.ObjectId();
        const meeting = new Meeting({
            _id: meetingId,
            projectId,
            professionalId,
            meetingType,
            title,
            description,
            scheduledDate: new Date(scheduledDate),
            startTime,
            endTime,
            duration,
            attendees,
            location,
            meetingLink,
            isOnline: isOnline || false,
            agenda,
            status: 'scheduled',
            createdBy: professionalId
        });

        await withAnonymizationWriteFence([professionalId], async (session) => {
            await reserveCalendarKeys(
                {
                    sourceType: 'meeting',
                    sourceId: meetingId,
                    keys: buildCalendarReservationKeysForInterval({
                        role: 'professional',
                        userId: professionalId,
                        startAt: new Date(interval.start),
                        endAt: new Date(interval.end),
                    }),
                },
                session,
            );
            await meeting.save({ session });
            return true;
        });

        res.status(201).json({
            success: true,
            message: 'Meeting created successfully',
            data: meeting
        });

    } catch (error: any) {
        return meetingErrorResponse(res, error, 'Failed to create meeting. Please try again.');
    }
};

/**
 * Get all meetings for a project
 */
export const getProjectMeetings = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
        const { projectId } = req.params;

        // Verify project belongs to the professional
        const project = await Project.findOne({
            _id: projectId,
            professionalId
        });

        if (!project) {
            return res.status(404).json({
                success: false,
                message: 'Project not found or you do not have permission to view it'
            });
        }

        const meetings = await Meeting.find({ projectId })
            .sort({ scheduledDate: 1 })
            .select('-__v');

        res.status(200).json({
            success: true,
            data: meetings
        });

    } catch (error: any) {
        console.error('Get project meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get project meetings. Please try again.',
        });
    }
};

/**
 * Get a specific meeting by ID
 */
export const getMeetingById = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
        const { meetingId } = req.params;

        const meeting = await Meeting.findOne({
            _id: meetingId,
            professionalId
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission to view it'
            });
        }

        res.status(200).json({
            success: true,
            data: meeting
        });

    } catch (error: any) {
        console.error('Get meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get meeting. Please try again.',
        });
    }
};

/**
 * Update a meeting
 */
export const updateMeeting = async (req: Request, res: Response) => {
    try {
        const professionalId = String(req.user!.professionalId || req.user!._id || '');
        const { meetingId } = req.params;
        const updates = req.body;

        const meeting = await Meeting.findOne({
            _id: meetingId,
            professionalId
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission to update it'
            });
        }

        const professional = await User.findById(professionalId).select('timeZone businessInfo');
        const timeZone = professionalTimeZone(professional);
        const oldInterval = meetingIntervalInTimeZone(
            meeting.scheduledDate,
            meeting.startTime,
            meeting.endTime,
            timeZone,
        );
        const nextScheduledDate = updates.scheduledDate !== undefined
            ? new Date(updates.scheduledDate)
            : meeting.scheduledDate;
        const nextStartTime = updates.startTime !== undefined ? updates.startTime : meeting.startTime;
        const nextEndTime = updates.endTime !== undefined ? updates.endTime : meeting.endTime;
        const nextInterval = meetingIntervalInTimeZone(
            nextScheduledDate,
            nextStartTime,
            nextEndTime,
            timeZone,
        );
        if (!nextInterval) {
            return res.status(400).json({
                success: false,
                message: 'A valid meeting date and time range is required',
                msg: 'A valid meeting date and time range is required',
                code: 'VALIDATION',
            });
        }
        const scheduleChanged = !oldInterval ||
            oldInterval.start !== nextInterval.start ||
            oldInterval.end !== nextInterval.end;

        if (
            scheduleChanged &&
            await professionalHasBusyConflict(
                professionalId,
                timeZone,
                new Date(nextInterval.start),
                Math.max(1, Math.round((nextInterval.end - nextInterval.start) / 60000)),
                String(meeting._id),
            )
        ) {
            return res.status(409).json({
                success: false,
                message: 'This time overlaps another booking, meeting, or support reservation',
                msg: 'This time overlaps another booking, meeting, or support reservation',
                code: 'SLOT_UNAVAILABLE',
            });
        }

        // Check if meeting is being rescheduled
        if (scheduleChanged) {
            meeting.previousScheduledDate = meeting.scheduledDate;
            meeting.rescheduledAt = new Date();
            meeting.rescheduledBy = professionalId;
            meeting.status = 'rescheduled';
            if (updates.reschedulingReason) {
                meeting.reschedulingReason = updates.reschedulingReason;
            }
        }

        // Update allowed fields
        const allowedUpdates = [
            'title', 'description', 'scheduledDate', 'startTime', 'endTime',
            'duration', 'location', 'meetingLink', 'isOnline', 'agenda', 'notes'
        ];

        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                (meeting as any)[field] = updates[field];
            }
        });

        if (scheduleChanged) {
            await withAnonymizationWriteFence([professionalId], async (session) => {
                await releaseCalendarReservations('meeting', meeting._id, session);
                await reserveCalendarKeys(
                    {
                        sourceType: 'meeting',
                        sourceId: meeting._id,
                        keys: buildCalendarReservationKeysForInterval({
                            role: 'professional',
                            userId: professionalId,
                            startAt: new Date(nextInterval.start),
                            endAt: new Date(nextInterval.end),
                        }),
                    },
                    session,
                );
                await meeting.save({ session });
                return true;
            });
        } else {
            await withAnonymizationWriteFence([professionalId], async (session) => {
                await meeting.save(session ? { session } : undefined);
            });
        }

        res.status(200).json({
            success: true,
            message: 'Meeting updated successfully',
            data: meeting
        });

    } catch (error: any) {
        return meetingErrorResponse(res, error, 'Failed to update meeting. Please try again.');
    }
};

/**
 * Cancel a meeting
 */
export const cancelMeeting = async (req: Request, res: Response) => {
    try {
        const professionalId = String(req.user!.professionalId || req.user!._id || '');
        const { meetingId } = req.params;
        const { cancellationReason } = req.body;

        const meeting = await Meeting.findOne({
            _id: meetingId,
            professionalId
        });

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: 'Meeting not found or you do not have permission to cancel it'
            });
        }

        if (meeting.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                message: 'Meeting is already cancelled'
            });
        }

        meeting.status = 'cancelled';
        meeting.cancelledAt = new Date();
        meeting.cancelledBy = professionalId;
        meeting.cancellationReason = cancellationReason;

        await withAnonymizationWriteFence([professionalId], async (session) => {
            await meeting.save(session ? { session } : undefined);
            await releaseCalendarReservations('meeting', meeting._id, session);
            return true;
        });

        res.status(200).json({
            success: true,
            message: 'Meeting cancelled successfully',
            data: meeting
        });

    } catch (error: any) {
        return meetingErrorResponse(res, error, 'Failed to cancel meeting. Please try again.');
    }
};

/**
 * Get all meetings for the professional
 */
export const getAllMeetings = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
        const { status, meetingType, startDate, endDate } = req.query;

        const filter: any = { professionalId };

        if (status) {
            filter.status = status;
        }

        if (meetingType) {
            filter.meetingType = meetingType;
        }

        if (startDate || endDate) {
            filter.scheduledDate = {};
            if (startDate) {
                filter.scheduledDate.$gte = new Date(startDate as string);
            }
            if (endDate) {
                filter.scheduledDate.$lte = new Date(endDate as string);
            }
        }

        const meetings = await Meeting.find(filter)
            .sort({ scheduledDate: 1 })
            .select('-__v');

        // The professional's normal calendar reader must include support
        // meetings; otherwise blocking is enforced but invisible. Keep the
        // existing `data` array shape and add a sibling event feed.
        let supportEvents: Awaited<ReturnType<typeof listSupportCalendarEvents>> = [];
        try {
            const professional = await User.findById(professionalId).select('timeZone businessInfo');
            const from = startDate ? new Date(startDate as string) : new Date();
            const to = endDate
                ? new Date(endDate as string)
                : new Date(from.getTime() + 31 * 24 * 60 * 60 * 1000);
            if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to > from) {
                supportEvents = await listSupportCalendarEvents({
                    viewer: 'professional',
                    userId: professionalId,
                    from,
                    to,
                    timeZone: resolveStoredCalendarTimeZone(professional),
                });
            }
        } catch (error) {
            console.error('Failed to load support events for professional calendar:', error);
        }

        res.status(200).json({
            success: true,
            data: meetings,
            supportEvents,
        });

    } catch (error: any) {
        console.error('Get all meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get meetings. Please try again.',
        });
    }
};
