import type { PersonSummary } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  allergySummary,
  BREAK_GLASS_MAX_LENGTH,
  BREAK_GLASS_MIN_LENGTH,
  canBreakGlass,
  communicationSummary,
  initials,
  justificationProblem,
  type PersonRow,
  personNames,
  toPersonListItem,
} from "./people";

const t = createTranslator("en-GB");

const penicillin = { substance: "Penicillin", severity: "severe", reaction: "Rash" };
const latex = { substance: "Latex", severity: "moderate", reaction: null };

const ada: PersonSummary = {
  id: "0194d000-0000-7000-8a00-000000000001",
  locationId: "0194d000-0000-7000-8000-000000000101",
  status: "active",
  givenName: "Ada",
  familyName: "Example",
  preferredName: "Addie",
  dateOfBirth: "1938-02-01",
  nhsNumber: "9990000018",
  roomLabel: null,
  photoUrl: null,
  allergyStatus: "has_allergies",
  allergies: [penicillin],
  communicationNeeds: [{ code: "demo:large-print", display: "Needs information in large print" }],
  communicationNeedsStatus: "recorded",
  communicationNeedsConfirmedBy: null,
  communicationNeedsConfirmedAt: null,
  iddsiFoodLevel: "not_recorded",
  iddsiDrinkLevel: "not_recorded",
  statusChangedAt: "2026-09-01T00:00:00.000Z",
  resuscitation: {
    status: "not_recorded",
    conflicting: false,
    recordId: null,
    kind: null,
    completedOn: null,
    clinicianName: null,
    clinicianRole: null,
    reviewDueOn: null,
    reviewOverdue: false,
  },
  version: 1,
};

describe("allergySummary", () => {
  it.each([
    ["unknown", [], { tone: "warning", label: "Allergies not recorded", icon: "circle-help" }],
    [
      "no_known_allergies",
      [],
      { tone: "neutral", label: "No known allergies", icon: "circle-check" },
    ],
    ["has_allergies", [penicillin], { tone: "danger", label: "1 allergy", icon: "triangle-alert" }],
    [
      "has_allergies",
      [penicillin, latex],
      { tone: "danger", label: "2 allergies", icon: "triangle-alert" },
    ],
    // Recorded as having allergies but none active: never shown as "No known allergies".
    [
      "has_allergies",
      [],
      { tone: "warning", label: "Allergies not recorded", icon: "circle-help" },
    ],
  ] as const)("%s with %j", (allergyStatus, allergies, expected) => {
    expect(allergySummary({ allergyStatus, allergies: [...allergies] }, t)).toEqual(expected);
  });
});

describe("communicationSummary (HZ-023)", () => {
  const largePrint = { code: "demo:large-print", display: "Needs information in large print" };

  it.each([
    ["needs listed", [largePrint], "recorded", { kind: "recorded", needs: [largePrint.display] }],
    [
      "none identified, recorded positively",
      [],
      "none_identified",
      { kind: "none_identified", label: "None identified" },
    ],
    ["never asked", [], "not_recorded", { kind: "not_recorded", label: "Not recorded" }],
    // An empty list is never read as "none", whatever the status says.
    [
      "recorded with an empty list",
      [],
      "recorded",
      { kind: "not_recorded", label: "Not recorded" },
    ],
  ] as const)("%s", (_label, needs, status, expected) => {
    expect(
      communicationSummary({ communicationNeeds: [...needs], communicationNeedsStatus: status }, t),
    ).toEqual(expected);
  });

  it("shows needs that are listed even if the status says none", () => {
    expect(
      communicationSummary(
        { communicationNeeds: [largePrint], communicationNeedsStatus: "none_identified" },
        t,
      ).kind,
    ).toBe("recorded");
  });

  it("says 'Not recorded' in Welsh shells too (untranslated keys fall back to English)", () => {
    const cy = createTranslator("cy");
    expect(
      communicationSummary(
        { communicationNeeds: [], communicationNeedsStatus: "not_recorded" },
        cy,
      ),
    ).toEqual({ kind: "not_recorded", label: "Not recorded" });
  });
});

describe("names", () => {
  it("prefers the preferred name and keeps the full name", () => {
    expect(personNames(ada)).toEqual({
      preferred: "Addie",
      full: "Ada Example",
      hasPreferred: true,
    });
  });
  it("uses the given name when no preferred name is recorded", () => {
    expect(personNames({ ...ada, preferredName: null })).toEqual({
      preferred: "Ada",
      full: "Ada Example",
      hasPreferred: false,
    });
    expect(personNames({ ...ada, preferredName: "  " }).hasPreferred).toBe(false);
  });
  it("gives two initials", () => {
    expect(initials(ada)).toBe("AE");
    expect(initials({ givenName: "élodie", familyName: "o'Sample" })).toBe("ÉO");
  });
});

describe("toPersonListItem", () => {
  it("prepares a row with UK formats and the room", () => {
    const row: PersonRow = { ...ada, roomLabel: "4" };
    const item = toPersonListItem(row, t, new Map([[ada.locationId, "Rowan House"]]));
    expect(item).toMatchObject({
      preferred: "Addie",
      full: "Ada Example",
      initials: "AE",
      hasPhoto: false,
      room: "Room 4",
      locationName: "Rowan House",
      dateOfBirth: "01/02/1938",
      communication: { kind: "recorded", needs: ["Needs information in large print"] },
      sortName: "Example Ada",
    });
    expect(item.allergy.label).toBe("1 allergy");
  });
  it("leaves the room empty when it is not recorded", () => {
    expect(toPersonListItem(ada, t, new Map()).room).toBeNull();
  });
  it("carries 'Not recorded' for someone never asked about communication needs", () => {
    const item = toPersonListItem(
      { ...ada, communicationNeeds: [], communicationNeedsStatus: "not_recorded" },
      t,
      new Map(),
    );
    expect(item.communication).toEqual({ kind: "not_recorded", label: "Not recorded" });
  });
});

describe("canBreakGlass", () => {
  it("needs people.person.break_glass", () => {
    expect(canBreakGlass(["people.person.read", "people.person.break_glass"])).toBe(true);
    expect(canBreakGlass(["people.person.read"])).toBe(false);
  });
});

describe("justificationProblem", () => {
  it.each([
    ["", "too-short"],
    ["Covering tonight", "too-short"],
    // Spaces around the reason do not count towards the minimum.
    [`  ${"a".repeat(BREAK_GLASS_MIN_LENGTH - 1)}  `, "too-short"],
    ["a".repeat(BREAK_GLASS_MIN_LENGTH), null],
    ["Covering Rowan House tonight for the night nurse", null],
    ["a".repeat(BREAK_GLASS_MAX_LENGTH), null],
    ["a".repeat(BREAK_GLASS_MAX_LENGTH + 1), "too-long"],
  ])("%j is %s", (justification, expected) => {
    expect(justificationProblem(justification)).toBe(expected);
  });
});
