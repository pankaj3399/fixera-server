import { describe, expect, it } from "vitest";
import {
  buildSupportParticipantKpis,
  escapeRegex,
  formatChatClosedMessage,
  INBOX_SEARCH_MAX_LENGTH,
  money2,
  normalizeInboxSearch,
  ratePercent,
} from "../../utils/adminSupportChat";

describe("admin support chat helpers", () => {
  it("escapes regex metacharacters in inbox search", () => {
    expect(escapeRegex("ana.april+test@fixtract.com")).toBe("ana\\.april\\+test@fixtract\\.com");
    expect(escapeRegex("(Farouk)")).toBe("\\(Farouk\\)");
  });

  it("trims and caps inbox search length", () => {
    expect(normalizeInboxSearch("  Parv  ")).toBe("Parv");
    expect(normalizeInboxSearch(12)).toBe("");
    expect(normalizeInboxSearch("x".repeat(INBOX_SEARCH_MAX_LENGTH + 10))).toHaveLength(INBOX_SEARCH_MAX_LENGTH);
  });

  it("formats a close notice in UTC", () => {
    expect(formatChatClosedMessage(new Date("2026-08-29T00:35:00.000Z"))).toBe(
      "Chat closed on 29 Aug 2026, 00:35 UTC",
    );
  });

  it("rounds half cents up for currency display", () => {
    expect(money2(10.075)).toBe(10.08);
    expect(money2(undefined)).toBe(0);
  });

  it("computes refund percent from booking count", () => {
    expect(ratePercent(1, 4)).toBe(25);
    expect(ratePercent(0, 0)).toBeNull();
    expect(
      buildSupportParticipantKpis({
        professionalLevel: "Level 2",
        reviewCount: 3,
        avgRating: 4.333,
        projectCount: 8,
        bookingCount: 10,
        completedCount: 6,
        quotedCount: 7,
        disputeCount: 1,
        grossEur: 1234.567,
        refundCount: 2,
      }),
    ).toEqual({
      level: "Level 2",
      reviewCount: 3,
      avgRating: 4.3,
      projectCount: 8,
      bookingCount: 10,
      completedCount: 6,
      quotedCount: 7,
      disputeCount: 1,
      grossEur: 1234.57,
      refundPercent: 20,
    });
  });
});
