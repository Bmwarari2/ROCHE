import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { catalogues, createTranslator, isLocale, LOCALES, untranslatedWelshKeys } from "./index";

const EMOJI = /\p{Extended_Pictographic}/u;
// Common American spellings that must not appear in British English copy (section 5.4).
const AMERICAN =
  /\b(color|colors|organization|organizations|center|behavior|favorite|gray|canceled|license[ds]?|program|catalog|analyze|authorize|recognize|apologize|prioritize)\b/i;

describe("catalogues", () => {
  it("have identical keys in every locale", () => {
    const english = Object.keys(catalogues["en-GB"]).sort();
    for (const locale of LOCALES) expect(Object.keys(catalogues[locale]).sort()).toEqual(english);
  });

  it("parse as ICU messages", () => {
    for (const locale of LOCALES) {
      for (const [key, message] of Object.entries(catalogues[locale])) {
        expect(() => new IntlMessageFormat(message, locale), `${locale} ${key}`).not.toThrow();
      }
    }
  });

  it("contain no emoji and no American spellings", () => {
    for (const [key, message] of Object.entries(catalogues["en-GB"])) {
      expect(EMOJI.test(message), key).toBe(false);
      expect(AMERICAN.test(message), `${key}: ${message}`).toBe(false);
    }
  });

  it("track every untranslated Welsh key", () => {
    for (const key of untranslatedWelshKeys) expect(key in catalogues.cy).toBe(true);
  });
});

describe("createTranslator", () => {
  const t = createTranslator("en-GB");

  it.each([
    ["people.header.allergies", { count: 0 }, "No known allergies"],
    ["people.header.allergies", { count: 1 }, "1 allergy"],
    ["people.header.allergies", { count: 3 }, "3 allergies"],
    ["shell.nav.people", { terminology: "resident" }, "Residents"],
    ["shell.nav.people", { terminology: "client" }, "Clients"],
    ["shell.nav.people", { terminology: "person_we_support" }, "People we support"],
    ["sync.lastSynced", { minutes: 0 }, "Last synced just now"],
    ["sync.lastSynced", { minutes: 12 }, "Last synced 12 minutes ago"],
  ] as const)("%s %o", (key, values, expected) => {
    expect(t(key, values)).toBe(expected);
  });

  it("falls back to English for untranslated Welsh keys", () => {
    const cy = createTranslator("cy");
    expect(cy("common.save")).toBe("Save");
    expect(cy.locale).toBe("cy");
  });

  it("recognises locales", () => {
    expect(isLocale("cy")).toBe(true);
    expect(isLocale("en-US")).toBe(false);
  });
});
