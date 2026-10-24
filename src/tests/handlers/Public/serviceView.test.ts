import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { find, create, findById } = vi.hoisted(() => ({
  find: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
}));

vi.mock("../../../models/cmsContent", () => ({
  default: { find },
}));

vi.mock("../../../models/serviceView", () => ({
  default: { create },
}));

vi.mock("../../../models/user", () => ({
  default: { findById },
}));

import { recordServiceView } from "../../../handlers/Public/serviceView";

type Doc = Record<string, any>;

let landings: Doc[] = [];
let sourcesById: Record<string, Doc> = {};

function landing(overrides: Doc = {}): Doc {
  return {
    _id: "landing-1",
    type: "landing",
    slug: "solar",
    locale: "en",
    status: "published",
    activeCountries: [],
    translatedFrom: undefined,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
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
}

function mockReq(serviceId = "solar"): Request {
  return {
    params: { serviceId },
    ip: "127.0.0.1",
    headers: { "user-agent": "Mozilla/5.0" },
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  landings = [];
  sourcesById = {};
  create.mockResolvedValue({});

  find.mockImplementation((query: Doc) => ({
    select: () => ({
      lean: async () => {
        if (query._id?.$in) {
          return query._id.$in
            .map((id: string) => sourcesById[String(id)])
            .filter(Boolean);
        }
        return landings;
      },
    }),
  }));
});

describe("landing view tracker source visibility", () => {
  it("records a view for a published independent landing", async () => {
    landings = [landing()];

    const res = mockRes();
    await recordServiceView(mockReq(), res);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ serviceId: "solar" });
    expect(res.body.data).toEqual({ recorded: true });
  });

  it("records a view for a translation whose source is published", async () => {
    landings = [landing({ _id: "landing-nl", locale: "nl", translatedFrom: "source-1" })];
    sourcesById = {
      "source-1": { _id: "source-1", type: "landing", status: "published", activeCountries: [] },
    };

    const res = mockRes();
    await recordServiceView(mockReq(), res);

    expect(create).toHaveBeenCalledTimes(1);
    expect(res.body.data).toEqual({ recorded: true });
  });

  it("does not record a view for a translation whose source was unpublished", async () => {
    landings = [landing({ _id: "landing-nl", locale: "nl", translatedFrom: "source-1" })];
    sourcesById = {
      "source-1": { _id: "source-1", type: "landing", status: "draft", activeCountries: [] },
    };

    const res = mockRes();
    await recordServiceView(mockReq(), res);

    expect(create).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({ recorded: false, reason: "unknown_service" });
  });

  it("does not record a view for a translation whose source no longer exists", async () => {
    landings = [landing({ _id: "landing-nl", locale: "nl", translatedFrom: "missing-source" })];

    const res = mockRes();
    await recordServiceView(mockReq(), res);

    expect(create).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({ recorded: false, reason: "unknown_service" });
  });

  it("ignores unpublished landings", async () => {
    landings = [];

    const res = mockRes();
    await recordServiceView(mockReq(), res);

    expect(find).toHaveBeenCalledWith({
      type: "landing",
      slug: "solar",
      status: "published",
    });
    expect(create).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({ recorded: false, reason: "unknown_service" });
  });
});
