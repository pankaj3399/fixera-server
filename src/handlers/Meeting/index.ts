import { Request, Response } from 'express';
import Meeting from '../../models/meeting';
import User from '../../models/user';
import Project from '../../models/project';

/**
 * Get team members' availability for a specific date range
 */
export const getTeamAvailability = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
        const { teamMemberIds, startDate, endDate } = req.body;

        if (!teamMemberIds || !Array.isArray(teamMemberIds) || teamMemberIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Team member IDs are required'
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

        // Get team members and verify they belong to the professional
        const teamMembers = await User.find({
            _id: { $in: teamMemberIds },
            role: 'team_member',
            'teamMember.companyId': professionalId,
            'teamMember.isActive': true
        }).select('name email availability blockedDates blockedRanges teamMember');

        if (teamMembers.length !== teamMemberIds.length) {
            return res.status(404).json({
                success: false,
                message: 'One or more team members not found or not associated with your account'
            });
        }

        // Get existing meetings for these team members in the date range
        const existingMeetings = await Meeting.find({
            'attendees.userId': { $in: teamMemberIds },
            scheduledDate: { $gte: start, $lte: end },
            status: { $in: ['scheduled', 'rescheduled'] }
        }).select('scheduledDate startTime endTime attendees duration');

        // Build availability data for each team member
        const availabilityData = teamMembers.map(member => {
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

            return {
                userId: member._id,
                name: member.name,
                email: member.email,
                availability: member.availability || {},
                blockedDates: blockedDatesInRange,
                blockedRanges: blockedRangesInRange,
                existingMeetings: memberMeetings.map(meeting => ({
                    meetingId: meeting._id,
                    date: meeting.scheduledDate,
                    startTime: meeting.startTime,
                    endTime: meeting.endTime,
                    duration: meeting.duration
                })),
                availabilityPreference: member.teamMember?.availabilityPreference || 'personal'
            };
        });

        // Get the professional's company availability (for team members using same_as_company)
        const professional = await User.findById(professionalId).select('availability blockedDates blockedRanges companyAvailability companyBlockedDates companyBlockedRanges');

        res.status(200).json({
            success: true,
            data: {
                teamMembers: availabilityData,
                companyAvailability: {
                    availability: professional?.companyAvailability || {},
                    blockedDates: professional?.companyBlockedDates?.filter(blocked => {
                        const blockedDate = new Date(blocked.date);
                        return blockedDate >= start && blockedDate <= end;
                    }) || [],
                    blockedRanges: professional?.companyBlockedRanges?.filter(range => {
                        const rangeStart = new Date(range.startDate);
                        const rangeEnd = new Date(range.endDate);
                        return rangeStart <= end && rangeEnd >= start;
                    }) || []
                }
            }
        });

    } catch (error: any) {
        console.error('Get team availability error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get team availability',
            error: error.message
        });
    }
};

/**
 * Create a new meeting (planning or team meeting)
 */
export const createMeeting = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
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
            const teamMembers = await User.find({
                _id: { $in: attendeeIds },
                role: 'team_member',
                'teamMember.companyId': professionalId,
                'teamMember.isActive': true
            }).select('name');

            attendees = teamMembers.map(member => ({
                userId: String(member._id),
                name: member.name,
                role: 'team_member',
                status: 'pending'
            }));

            if (attendees.length !== attendeeIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'One or more team members not found or not active'
                });
            }
        }

        // Add the professional as an attendee
        const professional = await User.findById(professionalId).select('name');
        attendees.unshift({
            userId: professionalId || '',
            name: professional!.name,
            role: 'professional',
            status: 'accepted'
        });

        // Create the meeting
        const meeting = new Meeting({
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

        await meeting.save();

        res.status(201).json({
            success: true,
            message: 'Meeting created successfully',
            data: meeting
        });

    } catch (error: any) {
        console.error('Create meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create meeting',
            error: error.message
        });
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
            message: 'Failed to get project meetings',
            error: error.message
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
            message: 'Failed to get meeting',
            error: error.message
        });
    }
};

/**
 * Update a meeting
 */
export const updateMeeting = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
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

        // Check if meeting is being rescheduled
        if (updates.scheduledDate && updates.scheduledDate !== meeting.scheduledDate.toISOString()) {
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

        await meeting.save();

        res.status(200).json({
            success: true,
            message: 'Meeting updated successfully',
            data: meeting
        });

    } catch (error: any) {
        console.error('Update meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update meeting',
            error: error.message
        });
    }
};

/**
 * Cancel a meeting
 */
export const cancelMeeting = async (req: Request, res: Response) => {
    try {
        const { professionalId } = req.user!;
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

        await meeting.save();

        res.status(200).json({
            success: true,
            message: 'Meeting cancelled successfully',
            data: meeting
        });

    } catch (error: any) {
        console.error('Cancel meeting error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel meeting',
            error: error.message
        });
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

        res.status(200).json({
            success: true,
            data: meetings
        });

    } catch (error: any) {
        console.error('Get all meetings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get meetings',
            error: error.message
        });
    }
};
