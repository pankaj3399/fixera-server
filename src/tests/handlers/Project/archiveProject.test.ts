import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  projectFindOne: vi.fn(),
  projectFindById: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findById: mocks.userFindById },
}));

vi.mock('../../../models/project', () => ({
  default: {
    findOne: mocks.projectFindOne,
    findById: mocks.projectFindById,
    find: vi.fn(),
  },
}));

vi.mock('../../../models/booking', () => ({
  default: {},
}));

vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: vi.fn(async (_userId: string, work: () => unknown) => work()),
  ACCOUNT_WRITE_FENCE_CODE: 'ACCOUNT_WRITE_FENCE',
}));

import { archiveProject, restoreProject, updateProjectStatus } from '../../../handlers/Project';

const mockRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
};

const projectDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: 'proj1',
  status: 'published',
  statusBeforeArchive: undefined,
  archivedAt: undefined,
  save: vi.fn(async () => undefined),
  ...overrides,
});

describe('project archive and restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const actorAs = (actor: Record<string, unknown>) => {
    mocks.userFindById.mockReturnValue({ select: vi.fn(async () => actor) });
  };

  it('archives a published project as an approved owner, recording the prior status', async () => {
    actorAs({ role: 'professional', professionalStatus: 'approved' });
    const doc = projectDoc();
    mocks.projectFindOne.mockResolvedValue(doc);

    const res = mockRes();
    await archiveProject(
      { user: { id: 'pro1' }, params: { id: 'proj1' } } as unknown as Request,
      res,
    );
    expect(res.body.success).toBe(true);
    expect(doc.status).toBe('archived');
    expect(doc.statusBeforeArchive).toBe('published');
    expect(doc.archivedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalled();
  });

  it('rejects archive for unapproved professionals', async () => {
    actorAs({ role: 'professional', professionalStatus: 'pending' });

    const res = mockRes();
    await archiveProject(
      { user: { id: 'pro1' }, params: { id: 'proj1' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(403);
  });

  it('restores a previously published project as draft, never published', async () => {
    actorAs({ role: 'professional', professionalStatus: 'approved' });
    const doc = projectDoc({ status: 'archived', statusBeforeArchive: 'published', archivedAt: new Date() });
    mocks.projectFindOne.mockResolvedValue(doc);

    const res = mockRes();
    await restoreProject(
      { user: { id: 'pro1' }, params: { id: 'proj1' } } as unknown as Request,
      res,
    );
    expect(res.body.success).toBe(true);
    expect(doc.status).toBe('draft');
    expect(doc.statusBeforeArchive).toBeUndefined();
    expect(doc.archivedAt).toBeUndefined();
  });

  it('restores a previously on-hold project to its verified status', async () => {
    actorAs({ role: 'professional', professionalStatus: 'approved' });
    const doc = projectDoc({ status: 'archived', statusBeforeArchive: 'on_hold', archivedAt: new Date() });
    mocks.projectFindOne.mockResolvedValue(doc);

    const res = mockRes();
    await restoreProject(
      { user: { id: 'pro1' }, params: { id: 'proj1' } } as unknown as Request,
      res,
    );
    expect(res.body.success).toBe(true);
    expect(doc.status).toBe('on_hold');
  });

  it('lets an admin archive any project', async () => {
    actorAs({ role: 'admin' });
    const doc = projectDoc({ status: 'draft' });
    mocks.projectFindById.mockResolvedValue(doc);

    const res = mockRes();
    await archiveProject(
      { user: { id: 'admin1' }, params: { id: 'proj1' } } as unknown as Request,
      res,
    );
    expect(res.body.success).toBe(true);
    expect(doc.status).toBe('archived');
    expect(mocks.projectFindOne).not.toHaveBeenCalled();
  });
});

describe('recorded on-hold transition', () => {
  it('records the hold start and clears it on resume', async () => {
    const doc = projectDoc({ onHoldAt: undefined });
    mocks.projectFindOne.mockResolvedValue(doc);
    const req = (status: string) => ({ user: { id: 'pro1' }, params: { id: 'proj1' }, body: { status } }) as unknown as Request;
    const res = mockRes();
    await updateProjectStatus(req('on_hold'), res);
    expect(res.statusCode).toBe(200);
    expect(doc.onHoldAt).toBeInstanceOf(Date);
    const onHoldAt = doc.onHoldAt;
    doc.save.mockClear();
    await updateProjectStatus(req('on_hold'), mockRes());
    expect(doc.onHoldAt).toBe(onHoldAt);
    expect(doc.save).not.toHaveBeenCalled();
    await updateProjectStatus(req('published'), mockRes());
    expect(doc.onHoldAt).toBeUndefined();
  });
});
