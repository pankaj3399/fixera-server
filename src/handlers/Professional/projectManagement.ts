import { Request, Response } from 'express';
import Project from '../../models/project';
import { normalizePreparationDuration } from '../../utils/projectDurations';

/**
 * Save project draft (create or update)
 * @route POST /api/user/projects
 */
export const saveProjectDraft = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const projectData = normalizePreparationDuration(req.body);

    let project;

    if (projectData._id) {
      // Update existing draft
      project = await Project.findOneAndUpdate(
        { _id: projectData._id, professionalId: userId },
        { ...projectData, autoSaveTimestamp: new Date() },
        { new: true, runValidators: true }
      );
    } else {
      // Create new draft
      project = await Project.create({
        ...projectData,
        professionalId: userId,
        status: 'draft',
        autoSaveTimestamp: new Date()
      });
    }

    res.status(200).json({
      success: true,
      data: project
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Error saving project',
      error: error.message
    });
  }
};

/**
 * Get project by ID
 * @route GET /api/user/projects/:id
 */
export const getProject = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      professionalId: userId
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.status(200).json({
      success: true,
      data: project
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Error fetching project',
      error: error.message
    });
  }
};

/**
 * Get all projects for professional
 * @route GET /api/user/projects
 */
export const getAllProjects = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { status } = req.query;

    const filter: any = { professionalId: userId };
    if (status) filter.status = status;

    const projects = await Project.find(filter)
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: projects
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Error fetching projects',
      error: error.message
    });
  }
};

/**
 * Submit project for approval
 * @route POST /api/user/projects/:id/submit
 */
export const submitProject = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { id } = req.params;

    const project = await Project.findOne({
      _id: id,
      professionalId: userId,
      status: 'draft'
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Draft project not found'
      });
    }

    // Perform quality checks here
    const qualityChecks = performQualityChecks(project);

    project.status = 'pending';
    project.submittedAt = new Date();
    project.qualityChecks = qualityChecks;
    await project.save();

    res.status(200).json({
      success: true,
      message: 'Project submitted for approval',
      data: project
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Error submitting project',
      error: error.message
    });
  }
};

/**
 * Delete project draft
 * @route DELETE /api/user/projects/:id
 */
export const deleteProject = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const { id } = req.params;

    const project = await Project.findOneAndDelete({
      _id: id,
      professionalId: userId,
      status: 'draft'
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Draft project not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Error deleting project',
      error: error.message
    });
  }
};

/**
 * Get projects assigned to an employee
 * @route GET /api/user/employee/projects
 */
export const getEmployeeAssignedProjects = async (req: Request, res: Response) => {
  try {
    const userId = String(req.user?._id);
    const user = req.user;

    // Verify user is an employee
    if (user?.role !== 'employee') {
      return res.status(403).json({
        success: false,
        message: 'Only employees can access this endpoint'
      });
    }

    // Find projects where the employee is in the resources array
    const projects = await Project.find({
      resources: userId,
      status: { $in: ['published', 'on_hold'] } // Only show published or on-hold projects
    })
      .select('title description category service professionalId status createdAt updatedAt')
      .sort({ updatedAt: -1 });

    res.status(200).json({
      success: true,
      data: projects
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Error fetching assigned projects',
      error: error.message
    });
  }
};

// Helper function for quality checks
function performQualityChecks(project: any) {
  const checks: Array<{
    category: string;
    status: 'passed' | 'failed' | 'warning';
    message: string;
    checkedAt: Date;
  }> = [];

  // Example checks
  if (project.description.length < 100) {
    checks.push({
      category: 'description',
      status: 'warning' as const,
      message: 'Description is very short',
      checkedAt: new Date()
    });
  }

  if (project.media?.images?.length === 0) {
    checks.push({
      category: 'media',
      status: 'warning' as const,
      message: 'No images uploaded',
      checkedAt: new Date()
    });
  }

  return checks;
}
