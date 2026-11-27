import { describe, expect, it } from "vitest";
import {
  canonicalizeProjectMedia,
  canonicalizeProjectMediaUrl,
  projectMediaKeyFor,
  projectMediaSignatureExpiresAt,
  projectQuestionAttachmentKeyFor,
  signProjectMediaUrl,
  withSignedProjectMedia,
  withSignedQuestionAttachments,
} from "../../utils/projectMedia";

const OWNER = "64b000000000000000000001";
const OTHER = "64b000000000000000000002";
const BUCKET = "https://fixera-uploads.s3.us-east-1.amazonaws.com";
const IMAGE = `${BUCKET}/projects/temp/image/${OWNER}/1730000000000-aabbccddeeff0011.png`;
const VIDEO = `${BUCKET}/projects/6650aa/video/${OWNER}/1730000000001-aabbccddeeff0012.mp4`;
const DAY = new Date("2026-11-03T08:15:00.000Z");
const LATER_SAME_DAY = new Date("2026-11-03T23:59:00.000Z");
const NEXT_DAY = new Date("2026-11-04T00:01:00.000Z");
const LAST_MINUTE_OF_WINDOW = new Date("2026-11-08T23:59:00.000Z");
const NEXT_WINDOW = new Date("2026-11-09T00:01:00.000Z");

describe("project media read contract", () => {
  it("signs the owner's private project image with a seven-day SigV4 URL aligned to six-day windows", async () => {
    const signed = String(await signProjectMediaUrl(IMAGE, OWNER, DAY));
    expect(signed.startsWith(`${IMAGE}?`)).toBe(true);
    const params = new URL(signed).searchParams;
    expect(params.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(params.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(params.get("X-Amz-Expires")).toBe("604800");
    expect(params.get("X-Amz-Date")).toBe("20261103T000000Z");
    expect(projectMediaSignatureExpiresAt(DAY).toISOString()).toBe("2026-11-10T00:00:00.000Z");
    // Served at the last minute of its window, a URL still has one more day.
    expect(projectMediaSignatureExpiresAt(LAST_MINUTE_OF_WINDOW).getTime() - LAST_MINUTE_OF_WINDOW.getTime())
      .toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it("returns the same URL for the whole six-day window and a new one after it", async () => {
    const first = await signProjectMediaUrl(IMAGE, OWNER, DAY);
    expect(await signProjectMediaUrl(IMAGE, OWNER, LATER_SAME_DAY)).toBe(first);
    expect(await signProjectMediaUrl(IMAGE, OWNER, NEXT_DAY)).toBe(first);
    expect(await signProjectMediaUrl(IMAGE, OWNER, LAST_MINUTE_OF_WINDOW)).toBe(first);
    expect(await signProjectMediaUrl(IMAGE, OWNER, NEXT_WINDOW)).not.toBe(first);
  });

  it("re-signs an already signed URL instead of nesting signatures", async () => {
    const signed = String(await signProjectMediaUrl(IMAGE, OWNER, DAY));
    expect(await signProjectMediaUrl(signed, OWNER, DAY)).toBe(signed);
  });

  it("never signs files that are not the owner's project media", async () => {
    const notMedia = [
      `${BUCKET}/id-proof/${OWNER}/1730000000000-aa.png`,
      `${BUCKET}/projects/temp/certification/${OWNER}/1730000000000-aa.pdf`,
      `${BUCKET}/projects/temp/attachment/${OWNER}/1730000000000-aa.pdf`,
      `${BUCKET}/projects/temp/image/${OTHER}/1730000000000-aa.png`,
      `https://other-bucket.s3.us-east-1.amazonaws.com/projects/temp/image/${OWNER}/a.png`,
      "https://images.example.com/photo.jpg",
      "data:image/png;base64,iVBORw0KGgo=",
    ];
    for (const url of notMedia) {
      expect(projectMediaKeyFor(url, OWNER)).toBeNull();
      expect(await signProjectMediaUrl(url, OWNER, DAY)).toBe(url);
    }
    expect(await signProjectMediaUrl(IMAGE, null, DAY)).toBe(IMAGE);
  });

  it("accepts legacy project-images keys that contain the owner segment", () => {
    expect(projectMediaKeyFor(`${BUCKET}/project-images/${OWNER}/a.png`, OWNER)).toBe(
      `project-images/${OWNER}/a.png`,
    );
    expect(projectMediaKeyFor(`${BUCKET}/project-images/${OTHER}/a.png`, OWNER)).toBeNull();
  });

  it("signs images, videos and video of a project without mutating the stored record", async () => {
    const stored = {
      _id: "p1",
      professionalId: { _id: OWNER, name: "Pro" },
      media: { images: [IMAGE, "https://images.example.com/x.jpg"], videos: [VIDEO], video: VIDEO },
    };
    const signed: any = await withSignedProjectMedia(stored, { now: DAY });
    expect(signed.media.images[0]).toMatch(/X-Amz-Signature=/);
    expect(signed.media.images[1]).toBe("https://images.example.com/x.jpg");
    expect(signed.media.videos[0]).toMatch(/X-Amz-Signature=/);
    expect(signed.media.video).toBe(signed.media.videos[0]);
    expect(stored.media.images[0]).toBe(IMAGE);
    expect(signed.professionalId).toEqual(stored.professionalId);
  });

  it("strips signatures on save so only stable object URLs are persisted", async () => {
    const signedImage = String(await signProjectMediaUrl(IMAGE, OWNER, DAY));
    const signedVideo = String(await signProjectMediaUrl(VIDEO, OWNER, DAY));
    expect(canonicalizeProjectMediaUrl(signedImage)).toBe(IMAGE);
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      canonicalizeProjectMedia({ images: [signedImage, dataUrl], videos: [signedVideo], video: signedVideo }),
    ).toEqual({ images: [IMAGE, dataUrl], videos: [VIDEO], video: VIDEO });
    expect(canonicalizeProjectMediaUrl("https://images.example.com/x.jpg?w=200")).toBe(
      "https://images.example.com/x.jpg?w=200",
    );
  });
});

describe("project media key boundary", () => {
  it("rejects decoded keys with empty, '.' or '..' segments before the owner check", async () => {
    const traversal = [
      // Percent-encoded slashes survive URL parsing and decode into '..' segments.
      `${BUCKET}/projects/temp/image/${OWNER}/..%2F..%2F..%2F..%2Fid-proof%2F${OWNER}%2Fx.png`,
      `${BUCKET}/projects/temp/image/${OWNER}/..%2Fcertification%2F${OWNER}%2Fa.pdf`,
      `${BUCKET}/projects/temp/image/${OWNER}/.%2Fa.png`,
      `${BUCKET}/projects/temp/image/${OWNER}/a%2F..%2Fb.png`,
      `${BUCKET}/projects/temp/video/${OWNER}/..%2F..%2Fattachment%2F${OWNER}%2Fa.pdf`,
      // Empty segments were hidden by filter(Boolean).
      `${BUCKET}/projects/temp//image/${OWNER}/a.png`,
      `${BUCKET}/projects//image/${OWNER}/a.png`,
      `${BUCKET}/projects/temp/image/${OWNER}//a.png`,
      `${BUCKET}/projects/temp/image/${OWNER}%2F%2Fa.png`,
      `${BUCKET}/projects/temp/image/${OWNER}/a.png/`,
      `${BUCKET}/project-images/${OWNER}/..%2F..%2Fid-proof%2Fx.png`,
      `${BUCKET}/project-images//${OWNER}/a.png`,
      `${BUCKET}/project-videos/${OWNER}/.%2Fa.mp4`,
    ];
    for (const url of traversal) {
      expect(projectMediaKeyFor(url, OWNER), url).toBeNull();
      expect(await signProjectMediaUrl(url, OWNER, DAY)).toBe(url);
    }
  });

  it("keeps returning the key for valid modern and legacy media", () => {
    expect(projectMediaKeyFor(IMAGE, OWNER)).toBe(
      `projects/temp/image/${OWNER}/1730000000000-aabbccddeeff0011.png`,
    );
    expect(projectMediaKeyFor(VIDEO, OWNER)).toBe(
      `projects/6650aa/video/${OWNER}/1730000000001-aabbccddeeff0012.mp4`,
    );
    expect(projectMediaKeyFor(`${BUCKET}/project-images/${OWNER}/a.png`, OWNER)).toBe(
      `project-images/${OWNER}/a.png`,
    );
    expect(projectMediaKeyFor(`${BUCKET}/project-videos/${OWNER}/clip.mp4`, OWNER)).toBe(
      `project-videos/${OWNER}/clip.mp4`,
    );
    expect(projectMediaKeyFor(`${BUCKET}/project-images/${OWNER}/2024/a%20b.png`, OWNER)).toBe(
      `project-images/${OWNER}/2024/a b.png`,
    );
  });
});

describe("FT1-RFQ: professional question attachments in the public project payload", () => {
  const ATTACHMENT = `${BUCKET}/projects/6650aa/attachment/${OWNER}/1730000000002-aabbccddeeff0013.pdf`;
  const TEMP_ATTACHMENT = `${BUCKET}/projects/temp/attachment/${OWNER}/1730000000003-aabbccddeeff0014.pdf`;

  it("accepts only the owner's question-attachment keys", () => {
    expect(projectQuestionAttachmentKeyFor(ATTACHMENT, OWNER)).toBe(
      `projects/6650aa/attachment/${OWNER}/1730000000002-aabbccddeeff0013.pdf`,
    );
    expect(projectQuestionAttachmentKeyFor(TEMP_ATTACHMENT, { _id: OWNER })).not.toBeNull();
    expect(projectQuestionAttachmentKeyFor(`${BUCKET}/project-attachments/${OWNER}/a.pdf`, OWNER)).toBe(
      `project-attachments/${OWNER}/a.pdf`,
    );
    const rejected = [
      `${BUCKET}/projects/6650aa/attachment/${OTHER}/a.pdf`,
      `${BUCKET}/projects/6650aa/image/${OWNER}/a.png`,
      `${BUCKET}/projects/6650aa/certification/${OWNER}/a.pdf`,
      `${BUCKET}/rfq-attachments/${OWNER}/a.pdf`,
      `${BUCKET}/id-proof/${OWNER}/a.pdf`,
      `${BUCKET}/projects/6650aa/attachment/${OWNER}/..%2F..%2F..%2Fid-proof%2F${OWNER}%2Fa.pdf`,
      `https://other-bucket.s3.us-east-1.amazonaws.com/projects/6650aa/attachment/${OWNER}/a.pdf`,
      "https://files.example.com/a.pdf",
    ];
    for (const url of rejected) expect(projectQuestionAttachmentKeyFor(url, OWNER), url).toBeNull();
    expect(projectQuestionAttachmentKeyFor(ATTACHMENT, null)).toBeNull();
  });

  it("signs RFQ and post-booking question attachments without mutating the stored project", async () => {
    const stored = {
      _id: "p1",
      professionalId: { _id: OWNER, name: "Pro" },
      rfqQuestions: [
        {
          question: "Floor plan?",
          type: "attachment",
          professionalAttachments: [ATTACHMENT, "https://files.example.com/a.pdf", `${BUCKET}/id-proof/${OWNER}/a.pdf`],
        },
        { question: "Colour?", type: "text" },
      ],
      postBookingQuestions: [
        { question: "Access?", type: "text", professionalAttachments: [{ url: TEMP_ATTACHMENT, name: "Access.pdf" }] },
      ],
    };
    const signed: any = await withSignedQuestionAttachments(stored, { now: DAY });
    const [first, external, idProof] = signed.rfqQuestions[0].professionalAttachments;
    expect(first.startsWith(`${ATTACHMENT}?`)).toBe(true);
    const params = new URL(first).searchParams;
    expect(params.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(params.get("X-Amz-Expires")).toBe("604800");
    expect(params.get("X-Amz-Date")).toBe("20261103T000000Z");
    expect(external).toBe("https://files.example.com/a.pdf");
    expect(idProof).toBe(`${BUCKET}/id-proof/${OWNER}/a.pdf`);
    expect(signed.rfqQuestions[1]).toEqual(stored.rfqQuestions[1]);
    const post = signed.postBookingQuestions[0].professionalAttachments[0];
    expect(post.name).toBe("Access.pdf");
    expect(post.url).toMatch(/X-Amz-Signature=/);
    expect(stored.rfqQuestions[0].professionalAttachments[0]).toBe(ATTACHMENT);
    // Stable within the signing window, so the 5-minute page cache serves a working link.
    const again: any = await withSignedQuestionAttachments(stored, { now: LATER_SAME_DAY });
    expect(again.rfqQuestions[0].professionalAttachments[0]).toBe(first);
  });

  it("re-signs an already signed attachment instead of nesting signatures", async () => {
    const once: any = await withSignedQuestionAttachments(
      { professionalId: OWNER, rfqQuestions: [{ professionalAttachments: [ATTACHMENT] }] },
      { now: DAY },
    );
    const twice: any = await withSignedQuestionAttachments(once, { now: DAY });
    expect(twice.rfqQuestions[0].professionalAttachments[0]).toBe(once.rfqQuestions[0].professionalAttachments[0]);
  });
});
