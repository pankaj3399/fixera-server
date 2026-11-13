import path from "path";
import fs from "fs";
import { describe, expect, it } from "vitest";
import { scanUserFacingMessages } from "./messageScanner";
import { EXCLUDED_FILES, EXCLUDED_MESSAGES } from "./messageExclusions";
import { en, type MessageKey } from "../../i18n/messages/en";
import { nl } from "../../i18n/messages/nl";
import { fr } from "../../i18n/messages/fr";
import { localizeMessage } from "../../i18n/translate";

/**
 * Guard against English-only API copy: every user-facing message the scanner
 * finds must have a catalog key with a Dutch and French translation. Add new
 * copy to src/i18n/messages/{en,nl,fr}.ts (or, for operator/admin-only text,
 * to messageExclusions.ts with a reason).
 */
const ROOT = path.resolve(__dirname, "../../..");
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
const normalize = (text: string) => text.trim().replace(PLACEHOLDER_RE, "{}");
const placeholders = (text: string) => new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]));
/** `booking{value}`: an English plural suffix that translations may drop. */
const suffixPlaceholders = (text: string) => new Set([...text.matchAll(/[A-Za-z]\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]));

const scan = scanUserFacingMessages(ROOT);
const keys = Object.keys(en) as MessageKey[];
const catalogued = new Map(keys.map((key) => [normalize(en[key]), key]));

describe("user-facing API message catalog", () => {
  it("finds the user-facing copy (scanner sanity check)", () => {
    expect(scan.messages.length).toBeGreaterThan(1000);
    expect(scan.inScopeFiles).toContain("src/handlers/Support/service.ts");
    expect(scan.inScopeFiles).not.toContain("src/handlers/Admin/supportItems.ts");
    expect(scan.messages.some((m) => m.text === "Support meetings are only available for professional accounts.")).toBe(true);
  });

  it("has a catalog key for every user-facing message", () => {
    const missing = scan.messages
      .filter((m) => !EXCLUDED_FILES[m.file] && !EXCLUDED_MESSAGES[m.text])
      .filter((m) => !catalogued.has(normalize(m.text)))
      .map((m) => `${m.file}:${m.line} ${JSON.stringify(m.text)}`);
    expect(missing, `Add these to src/i18n/messages/{en,nl,fr}.ts:\n${missing.join("\n")}`).toEqual([]);
  });

  it("has a non-empty Dutch and French translation with intact placeholders for every key", () => {
    const problems: string[] = [];
    for (const key of keys) {
      const source = en[key];
      const expected = placeholders(source);
      const optional = suffixPlaceholders(source);
      for (const [locale, catalog] of [["nl", nl], ["fr", fr]] as const) {
        const value = catalog[key];
        if (typeof value !== "string" || !value.trim()) {
          problems.push(`${locale}:${key} missing`);
          continue;
        }
        const actual = placeholders(value);
        for (const name of actual) if (!expected.has(name)) problems.push(`${locale}:${key} unknown {${name}}`);
        for (const name of expected) if (!actual.has(name) && !optional.has(name)) problems.push(`${locale}:${key} lost {${name}}`);
        if (value.trim() === source.trim() && /[a-z]{3,}\s+[a-z]{3,}/i.test(source)) {
          problems.push(`${locale}:${key} is still English`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(Object.keys(nl).sort()).toEqual([...keys].sort());
    expect(Object.keys(fr).sort()).toEqual([...keys].sort());
  });

  it("maps each English text to exactly one key", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const key of keys) {
      const norm = normalize(en[key]);
      if (seen.has(norm)) duplicates.push(`${seen.get(norm)} / ${key}`);
      seen.set(norm, key);
    }
    expect(duplicates).toEqual([]);
  });

  it("resolves every catalogued message back to its own key at runtime", () => {
    const unresolved: string[] = [];
    for (const key of keys) {
      // Render templates with neutral sample values.
      const rendered = en[key].replace(PLACEHOLDER_RE, (_whole, name: string, offset: number, all: string) =>
        /[A-Za-z]$/.test(all.slice(0, offset)) ? "s" : `7${name.length}`,
      );
      const localized = localizeMessage(rendered, "nl");
      if (!localized || localized.key !== key) unresolved.push(`${key} -> ${localized?.key ?? "none"}`);
    }
    expect(unresolved).toEqual([]);
  });

  it("keeps the exclusion lists current", () => {
    for (const file of Object.keys(EXCLUDED_FILES)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    const scanned = new Set(scan.messages.map((m) => m.text));
    for (const text of Object.keys(EXCLUDED_MESSAGES)) {
      expect(scanned.has(text), text).toBe(true);
    }
  });
});
