import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import errorHandler from "../../handlers/error";
import { UserFacingError } from "../../utils/appErrors";
import { localizeApiResponses, localizeResponseBody } from "../../i18n/middleware";
import { resolveMessageLocale } from "../../i18n/locale";
import { localizeMessage } from "../../i18n/translate";
import { en } from "../../i18n/messages/en";
import { nl } from "../../i18n/messages/nl";
import { fr } from "../../i18n/messages/fr";

describe("resolveMessageLocale", () => {
  it("picks the first supported language by preference", () => {
    expect(resolveMessageLocale("nl")).toBe("nl");
    expect(resolveMessageLocale("fr-BE,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(resolveMessageLocale("de-DE,de;q=0.9,nl;q=0.5,en;q=0.7")).toBe("en");
    expect(resolveMessageLocale("en;q=0.2, nl-BE")).toBe("nl");
  });

  it("returns null without a supported language", () => {
    expect(resolveMessageLocale(undefined)).toBeNull();
    expect(resolveMessageLocale("")).toBeNull();
    expect(resolveMessageLocale("de-DE,es")).toBeNull();
    expect(resolveMessageLocale("nl;q=0")).toBeNull();
  });
});

describe("localizeMessage", () => {
  it("translates exact catalog copy", () => {
    const result = localizeMessage("Support meetings are only available for professional accounts.", "nl");
    expect(result?.key).toBe("support.support_meetings_only_available_professional_accounts");
    expect(result?.text).toBe(nl["support.support_meetings_only_available_professional_accounts"]);
  });

  it("translates templates and catalogued labels inside them", () => {
    const result = localizeMessage("Subject is required.", "fr");
    expect(result?.key).toBe("support.label_required");
    expect(result?.params).toEqual({ label: "Subject" });
    expect(result?.text).toBe(fr["support.label_required"].replace("{label}", fr["term.subject"]));
    expect(result?.text).not.toContain("Subject");
  });

  it("keeps non-copy values (numbers, ids) as they are", () => {
    const result = localizeMessage("Subject must be 200 characters or fewer.", "nl");
    expect(result?.text).toContain("200");
    expect(result?.text).toContain(nl["term.subject"]);
  });

  it("translates joined validator messages part by part", () => {
    const result = localizeMessage("Name is required, Email is required", "fr");
    expect(result?.text).toBe(`${fr["validation.name_required"]}, ${fr["account.email_required"]}`);
  });

  it("returns null for unknown text so English is kept", () => {
    expect(localizeMessage("Some brand new sentence nobody catalogued.", "nl")).toBeNull();
  });

  it("returns English copy for en", () => {
    expect(localizeMessage("Subject is required.", "en")?.text).toBe("Subject is required.");
  });
});

describe("localizeResponseBody", () => {
  it("localizes msg/message/error envelopes and annotates the key", () => {
    const body = { success: false, msg: "Subject is required.", message: "Subject is required.", code: "VALIDATION" };
    const out = localizeResponseBody(body, "nl", 400) as Record<string, unknown>;
    expect(out.msg).toBe(out.message);
    expect(out.msg).not.toBe("Subject is required.");
    expect(out.messageKey).toBe("support.label_required");
    expect(out.messageParams).toEqual({ label: "Subject" });
    expect(out.messageEn).toBe("Subject is required.");
    expect(out.code).toBe("VALIDATION");
    // The original object is not mutated (handlers may reuse constants).
    expect(body.msg).toBe("Subject is required.");
  });

  it("localizes nested error.message and data.message", () => {
    const out = localizeResponseBody(
      { success: false, error: { code: "X", message: "Booking not found" } },
      "fr",
      404,
    ) as { error: { message: string; code: string } };
    expect(out.error.code).toBe("X");
    expect(out.error.message).not.toBe("Booking not found");
  });

  it("leaves non-envelope payloads and unknown copy untouched", () => {
    const payload = { message: "Booking not found" };
    expect(localizeResponseBody(payload, "nl", 200)).toBe(payload);
    const unknown = { success: false, msg: "Brand new uncatalogued sentence." };
    expect(localizeResponseBody(unknown, "nl", 400)).toBe(unknown);
    const list = [{ msg: "Booking not found" }];
    expect(localizeResponseBody(list, "nl", 200)).toBe(list);
  });

  it("adds the key but no messageEn for English", () => {
    const out = localizeResponseBody({ success: false, msg: "Booking not found" }, "en", 404) as Record<string, unknown>;
    expect(out.msg).toBe("Booking not found");
    expect(out.messageKey).toBeTruthy();
    expect(out.messageEn).toBeUndefined();
  });
});

describe("localizeApiResponses middleware", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(localizeApiResponses);
    app.use(express.json({ limit: "1kb" }));
    app.post("/support", () => {
      throw new UserFacingError(403, "Support meetings are only available for professional accounts.", "FORBIDDEN");
    });
    app.get("/ok", (_req, res) => {
      res.json({ success: true, msg: "Customer profile updated successfully" });
    });
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("keeps English and the exact legacy body without Accept-Language", async () => {
    const spy = quiet();
    const res = await fetch(`${base}/support`, { method: "POST", headers: { "accept-language": "" } });
    spy.mockRestore();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      msg: "Support meetings are only available for professional accounts.",
      message: "Support meetings are only available for professional accounts.",
      code: "FORBIDDEN",
    });
  });

  it.each(["nl", "fr"] as const)("localizes UserFacingError copy for %s", async (locale) => {
    const spy = quiet();
    const res = await fetch(`${base}/support`, { method: "POST", headers: { "accept-language": locale } });
    spy.mockRestore();
    const body = await res.json();
    const key = "support.support_meetings_only_available_professional_accounts" as const;
    expect(res.status).toBe(403);
    expect(res.headers.get("vary")).toMatch(/accept-language/i);
    expect(body).toMatchObject({
      success: false,
      msg: (locale === "nl" ? nl : fr)[key],
      message: (locale === "nl" ? nl : fr)[key],
      code: "FORBIDDEN",
      messageKey: key,
      messageEn: en[key],
    });
  });

  it("localizes body-parser errors produced by the shared error handler", async () => {
    const spy = quiet();
    const res = await fetch(`${base}/support`, {
      method: "POST",
      headers: { "accept-language": "fr", "content-type": "application/json" },
      body: "{not json",
    });
    spy.mockRestore();
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.messageEn).toBe("The request body is not valid JSON.");
    expect(body.msg).not.toBe(body.messageEn);
  });

  it("localizes success messages", async () => {
    const res = await fetch(`${base}/ok`, { headers: { "accept-language": "nl-BE,nl;q=0.9" } });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.messageEn).toBe("Customer profile updated successfully");
    expect(body.msg).not.toBe("Customer profile updated successfully");
  });
});
