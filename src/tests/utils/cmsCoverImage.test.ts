import { describe, expect, it } from "vitest";
import {
  applyCoverImageUpdate,
  canonicalizeCmsHtmlImages,
  canonicalizeCmsMediaUrl,
  coverImageForCreate,
} from "../../utils/cmsCoverImage";

const CANONICAL =
  "https://fixera-uploads.s3.us-east-1.amazonaws.com/cms/admin1/1710000000-aabbccdd.jpg";
const PRESIGNED = `${CANONICAL}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260901%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260901T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef`;
const OTHER =
  "https://fixera-uploads.s3.us-east-1.amazonaws.com/cms/admin1/1710000001-replacement.jpg";

describe("CMS cover image persist", () => {
  it("does not treat a presigned echo of the same object as a replacement", () => {
    const result = applyCoverImageUpdate(CANONICAL, PRESIGNED);
    expect(result.applied).toBe(true);
    expect(result.coverImage).toBe(CANONICAL);
    expect(result.previousToCleanup).toBeUndefined();
  });

  it("canonicalizes a previously stored signed URL when the editor resubmits the same object", () => {
    const result = applyCoverImageUpdate(PRESIGNED, `${PRESIGNED}&x-id=GetObject`);
    expect(result.coverImage).toBe(CANONICAL);
    expect(result.previousToCleanup).toBeUndefined();
  });

  it("cleans up the previous object only when the key actually changes", () => {
    const result = applyCoverImageUpdate(CANONICAL, OTHER);
    expect(result.coverImage).toBe(OTHER);
    expect(result.previousToCleanup).toBe(CANONICAL);
  });

  it("clears the cover and schedules cleanup when the editor sends an empty string", () => {
    const result = applyCoverImageUpdate(CANONICAL, "  ");
    expect(result.coverImage).toBeUndefined();
    expect(result.previousToCleanup).toBe(CANONICAL);
  });

  it("leaves the stored cover untouched when the field is omitted", () => {
    const result = applyCoverImageUpdate(CANONICAL, undefined);
    expect(result.applied).toBe(false);
    expect(result.coverImage).toBe(CANONICAL);
    expect(result.previousToCleanup).toBeUndefined();
  });

  it("stores a canonical URL on create even if upload returned a signed URL", () => {
    expect(coverImageForCreate(PRESIGNED)).toBe(CANONICAL);
    expect(coverImageForCreate("  ")).toBeUndefined();
    expect(coverImageForCreate(undefined)).toBeUndefined();
  });

  it("persists a newly uploaded cover as an unsigned URL without cleanup", () => {
    const result = applyCoverImageUpdate(undefined, PRESIGNED);
    expect(result.coverImage).toBe(CANONICAL);
    expect(result.previousToCleanup).toBeUndefined();
  });

  it("strips signatures from persisted HTML body images", () => {
    const html = `<p>Hero</p><img src="${PRESIGNED}" alt="cover"><p>Done</p>`;
    expect(canonicalizeCmsHtmlImages(html)).toBe(
      `<p>Hero</p><img src="${CANONICAL}" alt="cover"><p>Done</p>`
    );
  });

  it("canonicalizes img src attributes that have whitespace around =", () => {
    const html = `<img alt="cover" src = "${PRESIGNED}">`;
    expect(canonicalizeCmsHtmlImages(html)).toBe(`<img alt="cover" src = "${CANONICAL}">`);
  });

  it("does not treat src= text inside another attribute as an image URL", () => {
    const html = `<img alt='diagram src="${PRESIGNED}"' src="${PRESIGNED}">`;
    expect(canonicalizeCmsHtmlImages(html)).toBe(
      `<img alt='diagram src="${PRESIGNED}"' src="${CANONICAL}">`
    );
  });

  it("handles > characters inside quoted attribute values", () => {
    const html = `<img alt="A > B" src="${PRESIGNED}">`;
    expect(canonicalizeCmsHtmlImages(html)).toBe(`<img alt="A > B" src="${CANONICAL}">`);
  });

  it("strips query strings from S3 media URLs without changing the key", () => {
    expect(canonicalizeCmsMediaUrl(` ${PRESIGNED} `)).toBe(CANONICAL);
    expect(canonicalizeCmsMediaUrl("not a url")).toBe("not a url");
  });

  it("keeps query parameters on non-S3 URLs", () => {
    const cdn = "https://cdn.example.com/hero.jpg?w=1600&sig=abc";
    expect(canonicalizeCmsMediaUrl(cdn)).toBe(cdn);
    const result = applyCoverImageUpdate(cdn, `${cdn}&v=2`);
    expect(result.coverImage).toBe(`${cdn}&v=2`);
    expect(result.previousToCleanup).toBe(cdn);
  });
});
