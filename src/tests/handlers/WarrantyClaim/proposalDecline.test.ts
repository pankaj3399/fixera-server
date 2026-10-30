import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({
  claim: null as any,
  customer: null as any,
  professional: null as any,
  notify: vi.fn(async () => ({ notificationId: 'n1', emailSent: true, pushSent: false })),
  chatCreated: [] as any[],
}));

vi.mock('mongoose', async (importOriginal) => {
  const actual: any = await importOriginal();
  const session = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    abortTransaction: vi.fn(),
    endSession: vi.fn(),
  };
  return {
    ...actual,
    default: { ...actual.default, startSession: vi.fn(async () => session) },
  };
});
vi.mock('../../../models/warrantyClaim', () => ({ default: { findById: vi.fn(async () => mocks.claim) } }));
vi.mock('../../../models/booking', () => ({ default: {} }));
vi.mock('../../../models/project', () => ({ default: {} }));
vi.mock('../../../models/conversation', () => ({
  default: {
    findOne: vi.fn(() => ({ session: async () => null })),
    create: vi.fn(async (docs: any[]) => docs.map((doc, index) => ({ ...doc, _id: new Types.ObjectId(`507f1f77bcf86cd7994390${70 + index}`) }))),
    findByIdAndUpdate: vi.fn(async () => null),
  },
}));
vi.mock('../../../models/chatMessage', () => ({
  default: { create: vi.fn(async (docs: any[]) => { mocks.chatCreated.push(...docs); return docs; }) },
}));
const chainableUser = (doc: any) => ({
  select: () => ({ lean: async () => doc }),
});
vi.mock('../../../models/user', () => ({
  default: { findById: vi.fn((id: any) => chainableUser(String(id) === String(mocks.customer?._id) ? mocks.customer : mocks.professional)) },
}));
vi.mock('../../../utils/workingDays', () => ({}));
vi.mock('../../../utils/warranty', () => ({}));
vi.mock('../../../utils/s3Upload', () => ({}));
vi.mock('../../../utils/adminRbac/assertPermission', () => ({}));
vi.mock('../../../utils/notifications/notify', () => ({ notify: mocks.notify }));
vi.mock('../../../utils/displayName', () => ({
  getProfessionalDisplayName: vi.fn((user: any) => user?.name || 'Professional'),
}));
vi.mock('../../../utils/requestParams', () => ({
  params: (input: any) => input,
  param: (input: any) => input,
}));
vi.mock('../../../utils/support/accountGuard', () => ({
  withAnonymizationWriteFence: async (_ids: any, write: any) => write(undefined),
}));
vi.mock('../../../utils/appErrors', () => ({ UserFacingError: class UserFacingError extends Error {} }));
vi.mock('../../../utils/accountAnonymity', () => ({
  isAnonymizedAccount: () => false,
  maskAnonymizedUser: (user: any) => user,
  maskWarrantyClaimForAnonymizedParties: (claim: any) => claim,
  referenceId: (value: any) => (value == null ? null : String(value)),
}));

import { respondToWarrantyProposal } from '../../../handlers/WarrantyClaim/index';
import Conversation from '../../../models/conversation';

const customerId = new Types.ObjectId('507f1f77bcf86cd799439011');
const professionalId = new Types.ObjectId('507f1f77bcf86cd799439012');
const bookingId = new Types.ObjectId('507f1f77bcf86cd799439015');
const claimId = new Types.ObjectId('507f1f77bcf86cd799439021');

const fakeClaim = () => {
  const claim: any = {
    _id: claimId,
    claimNumber: 'WC-1',
    booking: bookingId,
    customer: customerId,
    professional: professionalId,
    status: 'proposal_sent',
    claimType: 'workmanship',
    reason: 'Leak',
    statusHistory: [],
    proposal: {
      message: 'We will fix it',
      proposedBy: professionalId,
      proposedAt: new Date('2026-02-05T10:00:00.000Z'),
    },
    save: vi.fn(async () => claim),
  };
  return claim;
};

const req = (body: Record<string, any>) => ({
  params: { claimId: String(claimId) },
  body,
  user: { _id: String(customerId), role: 'customer' },
}) as any;

const res = () => {
  const response: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return response;
};

describe('respondToWarrantyProposal clarification (client bug list #16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatCreated = [];
    mocks.claim = fakeClaim();
    mocks.customer = { _id: customerId, name: 'Carla Customer' };
    mocks.professional = { _id: professionalId, name: 'Piet Professional' };
  });

  it('rejects a decline without clarification', async () => {
    const response = res();
    await respondToWarrantyProposal(req({ action: 'decline' }), response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].error.code).toBe('CLARIFICATION_REQUIRED');
    expect(mocks.claim.save).not.toHaveBeenCalled();
  });

  it('rejects a decline with a trivially short clarification', async () => {
    const response = res();
    await respondToWarrantyProposal(req({ action: 'decline', clarification: 'no' }), response);
    expect(response.status).toHaveBeenCalledWith(400);
  });

  it('persists the clarification and notifies the professional with it', async () => {
    const response = res();
    await respondToWarrantyProposal(
      req({ action: 'decline', clarification: 'The proposed date does not work for us' }),
      response,
    );
    expect(response.json.mock.calls[0][0].success).toBe(true);
    expect(mocks.claim.proposal).toMatchObject({
      customerDecision: 'declined',
      decisionNote: 'The proposed date does not work for us',
    });
    expect(mocks.claim.escalation).toMatchObject({
      reason: 'Customer declined warranty proposal',
      note: 'The proposed date does not work for us',
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0][0]).toMatchObject({
      userId: String(professionalId),
      eventKey: 'professional.warranty_proposal_declined',
      context: expect.objectContaining({
        clarification: 'The proposed date does not work for us',
        claimNumber: 'WC-1',
      }),
    });
    expect(Conversation.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('accepts legacy note/reason fields as the clarification', async () => {
    const response = res();
    await respondToWarrantyProposal(req({ action: 'decline', note: 'Still leaking after visit' }), response);
    expect(response.json.mock.calls[0][0].success).toBe(true);
    expect(mocks.claim.proposal.decisionNote).toBe('Still leaking after visit');
  });

  it('does not force a clarification on accept', async () => {
    const response = res();
    await respondToWarrantyProposal(req({ action: 'accept' }), response);
    expect(response.json.mock.calls[0][0].success).toBe(true);
    expect(mocks.claim.proposal.customerDecision).toBe('accepted');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
