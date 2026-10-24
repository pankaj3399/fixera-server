import { beforeEach, describe, expect, it, vi } from "vitest";

const { find } = vi.hoisted(() => ({ find: vi.fn() }));
const { deleteFromS3 } = vi.hoisted(() => ({ deleteFromS3: vi.fn() }));

vi.mock("../../../models/cmsContent", () => ({
  default: { find },
}));

vi.mock("../../../utils/s3Upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/s3Upload")>();
  return { ...actual, deleteFromS3 };
});

import {
  deleteCmsMediaIfUnreferenced,
  isCmsMediaKeyReferenced,
} from "../../../utils/cms/coverImageCleanup";

const SHARED =
  "https://fixera-uploads.s3.us-east-1.amazonaws.com/cms/admin1/1710000000-shared.jpg";
const SHARED_SIGNED = `${SHARED}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef`;
const OTHER =
  "https://fixera-uploads.s3.us-east-1.amazonaws.com/cms/admin1/1710000001-other.jpg";

function mockDocs(docs: Array<Record<string, any>>) {
  find.mockReturnValue({
    select: () => ({ lean: async () => docs }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDocs([]);
  deleteFromS3.mockResolvedValue(undefined);
});

describe("CMS cover image cleanup", () => {
  it("keeps a shared object while a surviving manual translation still references it", async () => {
    mockDocs([
      { _id: "manual-nl", coverImage: SHARED },
      { _id: "source-en", coverImage: OTHER },
    ]);

    await expect(deleteCmsMediaIfUnreferenced(SHARED)).resolves.toBe(false);

    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it("matches references by S3 key even when a document stores a signed URL", async () => {
    mockDocs([{ _id: "auto-nl", coverImage: SHARED_SIGNED }]);

    await expect(isCmsMediaKeyReferenced("cms/admin1/1710000000-shared.jpg")).resolves.toBe(true);

    await deleteCmsMediaIfUnreferenced(SHARED);
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it("keeps an object still referenced as an SEO og:image", async () => {
    mockDocs([{ _id: "manual-fr", seo: { ogImage: SHARED } }]);

    await expect(deleteCmsMediaIfUnreferenced(SHARED)).resolves.toBe(false);
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it("deletes the object when no surviving CMS document references it", async () => {
    mockDocs([{ _id: "source-en", coverImage: OTHER }]);

    await expect(deleteCmsMediaIfUnreferenced(SHARED)).resolves.toBe(true);

    expect(deleteFromS3).toHaveBeenCalledTimes(1);
    expect(deleteFromS3).toHaveBeenCalledWith("cms/admin1/1710000000-shared.jpg");
  });

  it("only attempts cleanup for cms/ objects", async () => {
    await expect(
      deleteCmsMediaIfUnreferenced("https://cdn.example.test/public/cover.jpg")
    ).resolves.toBe(false);

    expect(find).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it("ignores empty or non-URL values", async () => {
    await expect(deleteCmsMediaIfUnreferenced(undefined)).resolves.toBe(false);
    await expect(deleteCmsMediaIfUnreferenced("")).resolves.toBe(false);

    expect(find).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
  });
});
