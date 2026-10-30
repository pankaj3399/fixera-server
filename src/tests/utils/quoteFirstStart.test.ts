import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const mocks = vi.hoisted(() => ({
  project: null as any,
  professional: null as any,
  proposals: null as any,
  proposalsError: null as any,
  proposalsCalls: [] as any[],
}));

vi.mock("../../models/project", () => ({
  default: { findById: (id: any) => ({ lean: async () => mocks.project }) },
}));
vi.mock("../../models/user", () => ({
  default: { findById: (id: any) => ({ select: (_fields: string) => ({ lean: async () => mocks.professional }) }) },
}));
vi.mock("../../utils/scheduleEngine", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    buildProjectScheduleProposalsWithData: async (...args: any[]) => {
      mocks.proposalsCalls.push(args);
      if (mocks.proposalsError) throw mocks.proposalsError;
      return mocks.proposals;
    },
  };
});

import {
  computeQuoteFirstPossibleStart,
  computeQuoteFirstPossibleStartForBooking,
  resolveQuoteFirstStartFromProposals,
} from "../../utils/bookingDetails/quoteFirstStart";
import Booking from "../../models/booking";
import { buildSharedQuoteRow } from "../../utils/bookingDetails/overviewRows";

const projectId = new Types.ObjectId().toHexString();
const professionalId = new Types.ObjectId().toHexString();
const bookingId = new Types.ObjectId().toHexString();

describe("resolveQuoteFirstStartFromProposals pure mapping", () => {
  it("prefers the concrete earliest proposal window", () => {
    const out = resolveQuoteFirstStartFromProposals({
      earliestProposal: { start: "2026-05-04T08:00:00.000Z" },
      earliestBookableDate: "2026-05-04T00:00:00.000Z",
      _debug: { usedFallback: false },
    });
    expect(out?.toISOString()).toBe("2026-05-04T08:00:00.000Z");
  });

  it("falls back to the earliest bookable day only when it is real", () => {
    const out = resolveQuoteFirstStartFromProposals({
      earliestBookableDate: "2026-05-06T00:00:00.000Z",
      _debug: { usedFallback: false },
    });
    expect(out?.toISOString()).toBe("2026-05-06T00:00:00.000Z");
  });

  it("returns null on no-slot fallback (prepEnd is not availability)", () => {
    expect(
      resolveQuoteFirstStartFromProposals({
        earliestBookableDate: "2026-05-06T00:00:00.000Z",
        _debug: { usedFallback: true },
      })
    ).toBeNull();
    expect(resolveQuoteFirstStartFromProposals(null)).toBeNull();
    expect(resolveQuoteFirstStartFromProposals({ _debug: { usedFallback: true } })).toBeNull();
    expect(resolveQuoteFirstStartFromProposals({ earliestProposal: { start: "not-a-date" } })).toBeNull();
  });
});

describe("computeQuoteFirstPossibleStart writer seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proposalsCalls = [];
    mocks.proposalsError = null;
    mocks.project = { _id: projectId, professionalId, resources: [professionalId] };
    mocks.professional = {
      _id: professionalId,
      companyAvailability: { monday: { available: true } },
      businessInfo: { timezone: "Europe/Brussels" },
    };
    mocks.proposals = {
      earliestProposal: { start: "2026-05-04T08:00:00.000Z" },
      earliestBookableDate: "2026-05-04T00:00:00.000Z",
      _debug: { usedFallback: false },
    };
  });

  it("returns null without a project (professional-only RFQ has insufficient data)", async () => {
    await expect(
      computeQuoteFirstPossibleStart({ projectId: null, executionDuration: { value: 1, unit: "days" } })
    ).resolves.toBeNull();
    await expect(
      computeQuoteFirstPossibleStartForBooking(
        { _id: bookingId, bookingType: "professional", project: null },
        { executionDuration: { value: 1, unit: "days" } }
      )
    ).resolves.toBeNull();
    expect(mocks.proposalsCalls.length).toBe(0);
  });

  it("returns null for missing execution duration and never calls the engine", async () => {
    await expect(
      computeQuoteFirstPossibleStart({ projectId, executionDuration: null })
    ).resolves.toBeNull();
    expect(mocks.proposalsCalls.length).toBe(0);
  });

  it("passes quantity-aware durations and excludes the quoting booking", async () => {
    const out = await computeQuoteFirstPossibleStartForBooking(
      {
        _id: bookingId,
        project: projectId,
        selectedSubprojectIndex: 2,
        scheduleSnapshot: { quantity: 3 },
      },
      {
        executionDuration: { value: 2, unit: "days" },
        preparationDuration: { value: 4, unit: "hours" },
        bufferDuration: { value: 1, unit: "days" },
      }
    );
    expect(out?.toISOString()).toBe("2026-05-04T08:00:00.000Z");
    expect(mocks.proposalsCalls.length).toBe(1);
    const [_project, _professional, subprojectIndex, override, excludeId, quantity] = mocks.proposalsCalls[0];
    expect(subprojectIndex).toBe(2);
    expect(override).toEqual({
      execution: { value: 2, unit: "days" },
      preparation: { value: 4, unit: "hours" },
      buffer: { value: 1, unit: "days" },
    });
    expect(excludeId).toBe(bookingId);
    expect(quantity).toBe(3);
  });

  it("returns null when the engine has no slot, no resources, or throws (never blocks the quote)", async () => {
    mocks.proposals = null;
    await expect(
      computeQuoteFirstPossibleStart({ projectId, executionDuration: { value: 1, unit: "days" } })
    ).resolves.toBeNull();
    mocks.proposals = { earliestBookableDate: "2026-05-06T00:00:00.000Z", _debug: { usedFallback: true } };
    await expect(
      computeQuoteFirstPossibleStart({ projectId, executionDuration: { value: 8, unit: "hours" } })
    ).resolves.toBeNull();
    mocks.proposalsError = new Error("calendar down");
    await expect(
      computeQuoteFirstPossibleStart({ projectId, executionDuration: { value: 8, unit: "hours" } })
    ).resolves.toBeNull();
  });
});

describe("quote version persistence and dashboard projection", () => {
  it("persists firstPossibleStart through the real Booking schema (writer seam serialization)", () => {
    const versionDate = new Date("2026-05-04T08:00:00.000Z");
    const doc = new Booking({
      customer: new Types.ObjectId(),
      bookingType: "project",
      project: new Types.ObjectId(),
      status: "quoted",
      location: { type: "Point", coordinates: [4.35, 50.85] },
      vatDecision: { action: "rfq", standardRate: 21, appliedRate: 21 },
      rfqData: { serviceType: "Cleaning", description: "Deep clean of two rooms" },
      quoteVersions: [
        {
          version: 1,
          quotationNumber: "Q-1-v1",
          scope: "Full deep clean scope",
          warrantyDuration: { value: 12, unit: "months" },
          materialsIncluded: false,
          description: "Deep clean",
          totalAmount: 100,
          preparationDuration: { value: 4, unit: "hours" },
          executionDuration: { value: 8, unit: "hours" },
          validUntil: new Date("2026-06-01T00:00:00.000Z"),
          firstPossibleStart: versionDate,
        },
      ],
    } as any);
    const validationError = doc.validateSync();
    expect(validationError == null).toBe(true);
    const plain = doc.toObject() as any;
    expect(new Date(plain.quoteVersions[0].firstPossibleStart).toISOString()).toBe(versionDate.toISOString());
  });

  it("projects the pinned version start, keeps RFQ-initial unknown as null", () => {
    const row = buildSharedQuoteRow({
      _id: "b1",
      status: "quoted",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      currentQuoteVersion: 2,
      quoteVersions: [
        { version: 1, firstPossibleStart: new Date("2026-05-01T08:00:00.000Z"), executionDuration: { value: 1, unit: "days" } },
        { version: 2, firstPossibleStart: new Date("2026-05-04T08:00:00.000Z"), executionDuration: { value: 2, unit: "days" } },
      ],
    } as any);
    expect(row.firstPossibleStart).toBe("2026-05-04T08:00:00.000Z");
    expect(row.executionDuration).toBe("2 days");

    const rfq = buildSharedQuoteRow({ _id: "b2", status: "rfq", createdAt: new Date("2026-04-01T00:00:00.000Z") } as any);
    expect(rfq.firstPossibleStart).toBeNull();
    expect(rfq.pinnedVersion).toBeNull();
  });
});
