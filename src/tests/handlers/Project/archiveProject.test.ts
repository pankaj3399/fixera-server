import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  userFindById: vi.fn(),
  userFind: vi.fn(),
  projectFindOne: vi.fn(),
  projectFindById: vi.fn(),
  projectFind: vi.fn(),
  projectFindOneAndUpdate: vi.fn(),
  projectCountDocuments: vi.fn(),
  projectDistinct: vi.fn(),
  projectAggregate: vi.fn(),
}));

vi.mock('../../../models/user', () => ({
  default: { findById: mocks.userFindById, find: mocks.userFind },
}));

vi.mock('../../../models/project', () => ({
  default: {
    findOne: mocks.projectFindOne,
    findById: mocks.projectFindById,
    find: mocks.projectFind,
    findOneAndUpdate: mocks.projectFindOneAndUpdate,
    countDocuments: mocks.projectCountDocuments,
    distinct: mocks.projectDistinct,
    aggregate: mocks.projectAggregate,
  },
}));

vi.mock('../../../models/booking', () => ({
  default: {},
}));

vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: vi.fn(async (_userId: string, work: () => unknown) => work()),
  ACCOUNT_WRITE_FENCE_CODE: 'ACCOUNT_WRITE_FENCE',
}));

import {
  archiveProject,
  createOrUpdateDraft,
  getProjectsMaster,
  restoreProject,
  updateProjectStatus,
} from '../../../handlers/Project';

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

  it('lets an admin with projects.approve archive any project', async () => {
    actorAs({ role: 'admin', adminRole: 'operations' });
    const doc = projectDoc({ status: 'published' });
    mocks.projectFindById.mockResolvedValue(doc);

    const res = mockRes();
    await archiveProject(
      { user: { id: 'admin1' }, params: { id: 'proj1' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(doc.status).toBe('archived');
  });

  it('denies archive and restore to an admin without projects.approve', async () => {
    actorAs({ role: 'admin', adminRole: 'marketing' });
    const doc = projectDoc({ status: 'archived', statusBeforeArchive: 'draft' });
    mocks.projectFindById.mockResolvedValue(doc);

    const archiveRes = mockRes();
    await archiveProject(
      { user: { id: 'admin1' }, params: { id: 'proj1' } } as unknown as Request,
      archiveRes,
    );
    expect(archiveRes.statusCode).toBe(403);
    expect(archiveRes.body.code).toBe('ADMIN_PERMISSION_DENIED');

    const restoreRes = mockRes();
    await restoreProject(
      { user: { id: 'admin1' }, params: { id: 'proj1' } } as unknown as Request,
      restoreRes,
    );
    expect(restoreRes.statusCode).toBe(403);
    expect(restoreRes.body.code).toBe('ADMIN_PERMISSION_DENIED');
    expect(mocks.projectFindById).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('archived projects stay read-only through the draft endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a draft update that would reopen an archived project', async () => {
    mocks.userFindById.mockReturnValue({
      select: vi.fn(async () => ({
        role: 'professional',
        professionalStatus: 'approved',
        stripe: { accountId: 'acct_1', onboardingCompleted: true },
      })),
    });
    mocks.projectFindOne.mockResolvedValue({ _id: 'proj1', status: 'archived', title: 'Old' });

    const res = mockRes();
    await createOrUpdateDraft(
      { user: { id: 'pro1' }, body: { id: 'proj1', status: 'published', title: 'Reopened' } } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PROJECT_ARCHIVED');
    expect(mocks.projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('project master team names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves resource names only for the professional and their own employees', async () => {
    const PRO_ID = '507f1f77bcf86cd799439011';
    const EMPLOYEE_ID = '507f1f77bcf86cd799439012';
    const FOREIGN_ID = '507f1f77bcf86cd799439013';
    const findChain: any = {};
    findChain.sort = vi.fn(() => findChain);
    findChain.skip = vi.fn(() => findChain);
    findChain.limit = vi.fn(() => findChain);
    findChain.lean = vi.fn(async () => [{ _id: 'proj1', resources: [PRO_ID, EMPLOYEE_ID, FOREIGN_ID] }]);
    mocks.projectFind.mockReturnValue(findChain);
    mocks.projectCountDocuments.mockResolvedValue(1);
    mocks.projectDistinct.mockResolvedValue([]);
    mocks.projectAggregate.mockResolvedValue([]);
    const userLean = vi.fn(async () => [
      { _id: PRO_ID, name: 'Owner' },
      { _id: EMPLOYEE_ID, name: 'Employee' },
    ]);
    mocks.userFind.mockReturnValue({ select: vi.fn(() => ({ lean: userLean })) });

    const res = mockRes();
    await getProjectsMaster(
      { user: { id: PRO_ID }, query: {} } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(200);
    const lookup = mocks.userFind.mock.calls[0][0];
    expect(lookup.$or).toEqual([
      { _id: PRO_ID },
      { role: 'employee', 'employee.companyId': PRO_ID },
    ]);
    expect(res.body.items[0].teamMembers).toEqual([
      { id: PRO_ID, name: 'Owner' },
      { id: EMPLOYEE_ID, name: 'Employee' },
      { id: FOREIGN_ID, name: null },
    ]);
  });
});

describe('project status counts use sibling filters', () => {
  it('keeps search/category/service, but removes only the selected status', async () => {
    vi.clearAllMocks();
    const chain: any = {};
    for (const method of ['sort', 'skip', 'limit']) chain[method] = vi.fn(() => chain);
    chain.lean = vi.fn(async () => []);
    mocks.projectFind.mockReturnValue(chain);
    mocks.projectCountDocuments.mockResolvedValue(0);
    mocks.projectDistinct.mockResolvedValue([]);
    mocks.projectAggregate.mockResolvedValue([]);
    const res = mockRes();
    await getProjectsMaster({ user: { id: '507f1f77bcf86cd799439011' }, query: { status: 'published', category: 'Indoor', service: 'Plumbing', search: 'A.*' } } as any, res);
    expect(res.statusCode).toBe(200);
    const listFilter = mocks.projectFind.mock.calls[0][0];
    const countFilter = mocks.projectAggregate.mock.calls[0][0][0].$match;
    expect(countFilter.status).toBeUndefined();
    expect(countFilter.$or).toEqual(listFilter.$or);
    expect(countFilter.$and).toEqual(listFilter.$and);
    expect(countFilter.$and[1].$or[0].title.test('A.*')).toBe(true);
    expect(countFilter.$and[1].$or[0].title.test('ABC')).toBe(false);
  });
});

describe('project service counts use sibling filters (FT2 #10a)', () => {
  it('keeps status/category/search, drops only the selected service, and returns per-service counts', async () => {
    vi.clearAllMocks();
    const chain: any = {};
    for (const method of ['sort', 'skip', 'limit']) chain[method] = vi.fn(() => chain);
    chain.lean = vi.fn(async () => []);
    mocks.projectFind.mockReturnValue(chain);
    mocks.projectCountDocuments.mockResolvedValue(0);
    mocks.projectDistinct.mockResolvedValue(['Painting', 'Plumbing']);
    mocks.projectAggregate.mockImplementation(async (pipeline: any[]) =>
      pipeline.some((stage) => stage.$unwind === '$serviceValues')
        ? [{ _id: 'Plumbing', count: 3 }, { _id: 'Painting', count: 1 }]
        : []);
    const res = mockRes();
    await getProjectsMaster({ user: { id: '507f1f77bcf86cd799439011' }, query: { status: 'published', category: 'Indoor', service: 'Plumbing', search: 'A.*' } } as any, res);
    expect(res.statusCode).toBe(200);
    const servicePipeline = (mocks.projectAggregate.mock.calls as any[])
      .map((call) => call[0] as any[])
      .find((pipeline) => pipeline.some((stage) => stage.$unwind === '$serviceValues'))!;
    const match = servicePipeline[0].$match;
    expect(match.status).toBe('published');
    // Category $or kept; the service clause is not applied to its own counts.
    expect(match.$or).toEqual([{ category: 'Indoor' }, { 'services.category': 'Indoor' }]);
    expect(JSON.stringify(match)).not.toContain('Plumbing');
    expect(match.$and[0].$or[0].title.test('A.*')).toBe(true);
    expect(res.body.serviceCounts).toEqual({ Plumbing: 3, Painting: 1 });
  });

  it('applies the default non-archived scope to the service counts', async () => {
    vi.clearAllMocks();
    const chain: any = {};
    for (const method of ['sort', 'skip', 'limit']) chain[method] = vi.fn(() => chain);
    chain.lean = vi.fn(async () => []);
    mocks.projectFind.mockReturnValue(chain);
    mocks.projectCountDocuments.mockResolvedValue(0);
    mocks.projectDistinct.mockResolvedValue([]);
    mocks.projectAggregate.mockResolvedValue([]);
    const res = mockRes();
    await getProjectsMaster({ user: { id: '507f1f77bcf86cd799439011' }, query: {} } as any, res);
    const servicePipeline = (mocks.projectAggregate.mock.calls as any[])
      .map((call) => call[0] as any[])
      .find((pipeline) => pipeline.some((stage) => stage.$unwind === '$serviceValues'))!;
    expect(servicePipeline[0].$match.status).toEqual({ $ne: 'archived' });
    expect(res.body.serviceCounts).toEqual({});
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
