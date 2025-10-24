import { Request, Response } from 'express';
import Project from '../../models/project';

export const getPendingProjects = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const pendingProjects = await Project.find({
            status: 'pending'
        }).sort({ submittedAt: 1 });

        res.json(pendingProjects);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending projects' });
    }
};

export const approveProject = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'pending' },
            {
                status: 'published',
                approvedAt: new Date(),
                approvedBy: req.user?.id
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ message: 'Project approved', project });
    } catch (error) {
        res.status(500).json({ error: 'Failed to approve project' });
    }
};

export const rejectProject = async (req: Request, res: Response) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { id } = req.params;
        const { feedback } = req.body;

        const project = await Project.findOneAndUpdate(
            { _id: id, status: 'pending' },
            {
                status: 'rejected',
                adminFeedback: feedback
            },
            { new: true }
        );

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json({ message: 'Project rejected', project });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject project' });
    }
};