import type { PersonSummary } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  allergySummary,
  canBreakGlass,
  initials,
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
      communicationNeeds: ["Needs information in large print"],
      sortName: "Example Ada",
    });
    expect(item.allergy.label).toBe("1 allergy");
  });
  it("leaves the room empty when it is not recorded", () => {
    expect(toPersonListItem(ada, t, new Map()).room).toBeNull();
  });
});

describe("canBreakGlass", () => {
  it("needs people.person.break_glass", () => {
    expect(canBreakGlass(["people.person.read", "people.person.break_glass"])).toBe(true);
    expect(canBreakGlass(["people.person.read"])).toBe(false);
  });
});
