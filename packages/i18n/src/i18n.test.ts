import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { catalogues, createTranslator, isLocale, LOCALES, untranslatedWelshKeys } from "./index";
import enGBShared from "./messages/en-GB.json" with { type: "json" };
import cyMobile from "./messages/mobile.cy.json" with { type: "json" };
import enGBMobile from "./messages/mobile.en-GB.json" with { type: "json" };

describe("mobile catalogue", () => {
  it("keeps the mobile copy under its own prefix, apart from the shared keys", () => {
    for (const key of Object.keys(enGBMobile)) {
      expect(key.startsWith("mobile."), key).toBe(true);
      expect(key in enGBShared, key).toBe(false);
    }
    expect(Object.keys(cyMobile).sort()).toEqual(Object.keys(enGBMobile).sort());
  });

  it("marks every Welsh mobile entry that is still English as untranslated", () => {
    for (const [key, message] of Object.entries(cyMobile)) {
      if (message === enGBMobile[key as keyof typeof enGBMobile]) {
        expect(untranslatedWelshKeys.has(key), key).toBe(true);
      }
    }
  });

  it("uses sentence case: a message starts with a capital unless it starts with a value", () => {
    for (const [key, message] of Object.entries(enGBMobile)) {
      if (message.startsWith("{")) continue;
      expect(message[0], `${key}: ${message}`).toBe(message[0]?.toLocaleUpperCase("en-GB"));
    }
  });

  const t = createTranslator("en-GB");

  it.each([
    ["mobile.sync.queued", { count: 0 }, "No changes waiting to upload"],
    ["mobile.sync.queued", { count: 1 }, "1 change waiting to upload"],
    ["mobile.sync.queued", { count: 3 }, "3 changes waiting to upload"],
    ["mobile.sync.issues", { count: 1 }, "1 entry was not saved and needs attention"],
    ["mobile.sync.window", { days: 7 }, "Entries from the last 7 days are kept on this device."],
    [
      "mobile.header.resuscitation",
      { status: "do_not_attempt_cpr" },
      "Resuscitation: do not attempt CPR",
    ],
    ["mobile.header.resuscitation", { status: "not_recorded" }, "Resuscitation: not recorded"],
    ["mobile.entry.status", { status: "queued" }, "Waiting to upload"],
    [
      "mobile.news2.working",
      { item: "Pulse", value: "95 per minute", points: 1 },
      "Pulse: 95 per minute, 1 point",
    ],
    ["mobile.carePlan.actionWho", { role: "care_worker" }, "Who: Care worker"],
    ["mobile.carePlan.actionWho", { role: "unknown_role" }, "Who: Staff"],
  ] as const)("%s %o", (key, values, expected) => {
    expect(t(key, values)).toBe(expected);
  });
});

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

  it("mark every Welsh entry that is still the English text as untranslated", () => {
    const english = catalogues["en-GB"];
    for (const [key, message] of Object.entries(catalogues.cy)) {
      if (message === english[key as keyof typeof english]) {
        expect(untranslatedWelshKeys.has(key), `${key} is English but not marked`).toBe(true);
      }
    }
  });

  it("use sentence case: messages start with a capital unless they continue a sentence", () => {
    // "or" sits between two buttons and "preferred format" follows a comma.
    const continuations = new Set(["common.or", "people.header.preferredFormat"]);
    for (const [key, message] of Object.entries(catalogues["en-GB"])) {
      if (continuations.has(key) || /^[{:]/.test(message)) continue;
      expect(message[0], `${key}: ${message}`).toBe(message[0]?.toLocaleUpperCase("en-GB"));
    }
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
    ["common.charactersRemaining", { count: 1 }, "You have 1 character remaining"],
    ["common.charactersRemaining", { count: 980 }, "You have 980 characters remaining"],
    ["common.charactersOver", { count: 1 }, "You have 1 character too many"],
    ["common.charactersOver", { count: 25 }, "You have 25 characters too many"],
    ["people.list.count", { count: 1 }, "1 person in your care."],
    ["people.list.count", { count: 28 }, "28 people in your care."],
    ["people.list.back", { terminology: "client" }, "Back to clients"],
    ["dashboard.tiles.people.link", { terminology: "person_we_support" }, "View people we support"],
    [
      "people.breakGlass.tooShort",
      { min: 20 },
      "Explain why you need this record in 20 characters or more.",
    ],
    [
      "people.breakGlass.tooLong",
      { max: 1000 },
      "Shorten the reason to 1,000 characters or fewer.",
    ],
    ["notifications.unread", { count: 1 }, "1 notification not read yet."],
    ["notifications.unread", { count: 4 }, "4 notifications not read yet."],
    ["shell.nav.unread", { count: 3 }, "3 unread"],
    [
      "shell.locationSwitcher.regulatorLocation",
      { regulator: "cqc", id: "1-000000001" },
      "CQC location 1-000000001",
    ],
    [
      "shell.locationSwitcher.regulatorLocation",
      { regulator: "care_inspectorate", id: "CS0001" },
      "Care Inspectorate location CS0001",
    ],
    ["security.passkeys.count", { count: 2 }, "2 passkeys"],
    [
      "security.device.browserOnSystem",
      { browser: "Firefox", system: "Linux" },
      "Firefox on Linux",
    ],
  ] as const)("%s %o", (key, values, expected) => {
    expect(t(key, values)).toBe(expected);
  });

  it("names allergy severities and shows one it does not know as recorded, never blank (HZ-007)", () => {
    const severity = (value: string) => t("people.header.allergySeverity", { severity: value });
    expect(["severe", "moderate", "mild"].map(severity)).toEqual(["Severe", "Moderate", "Mild"]);
    expect(severity("life-threatening")).toBe("life-threatening");
    expect(
      t("people.header.allergyReaction", { severity: severity("severe"), reaction: "Rash" }),
    ).toBe("Severe: Rash");
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
