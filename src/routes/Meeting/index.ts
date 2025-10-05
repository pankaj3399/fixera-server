import { Router } from 'express';
import {
    createMeeting,
    getProjectMeetings,
    getMeetingById,
    updateMeeting,
    cancelMeeting,
    getAllMeetings,
    getTeamAvailability
} from '../../handlers/Meeting';
import { authMiddleware } from '../../middlewares/auth';

const router = Router();

// All routes require authentication
router.use(authMiddleware(['professional']));

/**
 * @route   POST /api/meetings/availability
 * @desc    Get team members' availability for a date range
 * @access  Professional
 */
router.post('/availability', getTeamAvailability);

/**
 * @route   POST /api/meetings
 * @desc    Create a new meeting (planning or team)
 * @access  Professional
 */
router.post('/', createMeeting);

/**
 * @route   GET /api/meetings
 * @desc    Get all meetings for the professional
 * @access  Professional
 */
router.get('/', getAllMeetings);

/**
 * @route   GET /api/meetings/project/:projectId
 * @desc    Get all meetings for a specific project
 * @access  Professional
 */
router.get('/project/:projectId', getProjectMeetings);

/**
 * @route   GET /api/meetings/:meetingId
 * @desc    Get a specific meeting by ID
 * @access  Professional
 */
router.get('/:meetingId', getMeetingById);

/**
 * @route   PUT /api/meetings/:meetingId
 * @desc    Update a meeting
 * @access  Professional
 */
router.put('/:meetingId', updateMeeting);

/**
 * @route   POST /api/meetings/:meetingId/cancel
 * @desc    Cancel a meeting
 * @access  Professional
 */
router.post('/:meetingId/cancel', cancelMeeting);

export default router;
