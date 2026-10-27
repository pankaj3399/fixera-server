import type { Request, Response } from 'express';
import Project from '../../models/project';
import {
  generateProjectCopy,
  parseProjectCopyRequest,
  ProjectCopyConfigurationError,
  ProjectCopyInputError,
  ProjectCopyOutputError,
  ProjectCopyProviderError,
  ProjectCopyRefusalError,
  ProjectCopyTimeoutError,
} from '../../utils/projectCopyGeneration';

const generatingProfessionals = new Set<string>();

export const generateCopy = async (req: Request, res: Response) => {
  const user = req.user as any;
  if (!user) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
  if (user.role !== 'professional' || user.professionalStatus !== 'approved' || user.deletedAt || user.isAnonymized || user.accountStatus === 'suspended') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN' });
  }

  let request;
  try {
    request = parseProjectCopyRequest(req.body);
  } catch (error) {
    if (error instanceof ProjectCopyInputError) return res.status(400).json({ success: false, code: 'AI_INVALID_REQUEST' });
    throw error;
  }

  const professionalId = String(user._id || user.id || user.professionalId || '');
  if (!professionalId) return res.status(403).json({ success: false, code: 'FORBIDDEN' });
  if (request.projectId) {
    let project;
    try {
      project = await Project.findById(request.projectId);
    } catch {
      return res.status(404).json({ success: false, code: 'PROJECT_NOT_FOUND' });
    }
    if (!project || String((project as any).professionalId) !== professionalId) {
      return res.status(404).json({ success: false, code: 'PROJECT_NOT_FOUND' });
    }
  }
  if (generatingProfessionals.has(professionalId)) {
    return res.status(429).json({ success: false, code: 'AI_RATE_LIMITED' });
  }

  generatingProfessionals.add(professionalId);
  try {
    const result = await generateProjectCopy(request);
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ProjectCopyConfigurationError) return res.status(503).json({ success: false, code: 'AI_NOT_CONFIGURED' });
    if (error instanceof ProjectCopyTimeoutError) return res.status(504).json({ success: false, code: 'AI_TIMEOUT' });
    if (error instanceof ProjectCopyRefusalError) return res.status(422).json({ success: false, code: 'AI_REFUSED' });
    if (error instanceof ProjectCopyOutputError) return res.status(502).json({ success: false, code: 'AI_INVALID_RESPONSE' });
    if (error instanceof ProjectCopyProviderError) return res.status(502).json({ success: false, code: 'AI_UNAVAILABLE' });
    return res.status(500).json({ success: false, code: 'AI_UNAVAILABLE' });
  } finally {
    generatingProfessionals.delete(professionalId);
  }
};
