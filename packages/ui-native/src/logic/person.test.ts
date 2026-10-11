import { describe, expect, it } from "vitest";
import {
  communicationFlagLabel,
  describeAllergyFlag,
  formatNhsNumber,
  fullName,
  initialsFor,
  isValidNhsNumber,
  knownAsName,
  parseAllergyStatus,
} from "./person";

describe("initialsFor", () => {
  it.each([
    [{ givenName: "Ada", familyName: "Example" }, "AE"],
    [{ preferredName: "Bea", givenName: "Beatrice", familyName: "Sample" }, "BS"],
    [{ givenName: "  ada  ", familyName: " example" }, "AE"],
    [{ givenName: "Mary-Jane", familyName: "O'Example" }, "MO"],
    [{ givenName: "'Kit'", familyName: "(Test)" }, "KT"],
    [{ givenName: "Élodie", familyName: "Ñame" }, "ÉÑ"],
    [{ givenName: "Ada" }, "A"],
    [{ familyName: "Example" }, "E"],
    [{ givenName: "", familyName: "" }, ""],
    [{ givenName: null, familyName: null }, ""],
    [{ givenName: "123", familyName: "--" }, ""],
  ])("%j gives %s", (name, expected) => {
    expect(initialsFor(name)).toBe(expected);
  });
});

describe("names", () => {
  it("prefers the preferred name for the known-as name", () => {
    expect(knownAsName({ preferredName: "Bea", givenName: "Beatrice", familyName: "Sample" })).toBe(
      "Bea",
    );
    expect(knownAsName({ preferredName: " ", givenName: "Ada", familyName: "Example" })).toBe(
      "Ada",
    );
  });

  it("builds the full name from given and family names", () => {
    expect(fullName({ preferredName: "Bea", givenName: "Beatrice", familyName: "Sample" })).toBe(
      "Beatrice Sample",
    );
    expect(fullName({ givenName: "Ada" })).toBe("Ada");
  });
});

describe("NHS numbers", () => {
  const testRange = [
    "9990000018",
    "9990000026",
    "9990000034",
    "9990000042",
    "9990000050",
    "9990000069",
    "9990000077",
    "9990000085",
    "9990000093",
    "9990000107",
  ];

  it.each(testRange)("%s from the test range has a valid check digit", (value) => {
    expect(isValidNhsNumber(value)).toBe(true);
  });

  it.each(["9990000019", "999000001", "99900000180", "abcdefghij", "9990000010"])(
    "%s is invalid",
    (value) => {
      expect(isValidNhsNumber(value)).toBe(false);
    },
  );

  it("formats 10 digits in 3-3-4 groups and leaves anything else unchanged", () => {
    expect(formatNhsNumber("9990000018")).toBe("999 000 0018");
    expect(formatNhsNumber("999 000 0018")).toBe("999 000 0018");
    expect(formatNhsNumber("12345")).toBe("12345");
    expect(formatNhsNumber(null)).toBeNull();
  });
});

describe("allergy flag (HZ-007)", () => {
  it.each([
    ["has_allergies", 2, "danger", "Allergies (2)", true],
    ["has_allergies", 1, "danger", "Allergies (1)", true],
    ["has_allergies", 0, "danger", "Allergies (details not on device)", true],
    ["no_known_allergies", 0, "neutral", "No known allergies", false],
    ["no_known_allergies", 1, "danger", "Allergies (1)", true],
    ["unknown", 0, "warning", "Allergies not recorded", true],
    ["unknown", 3, "danger", "Allergies (3)", true],
    [null, 0, "warning", "Allergies not recorded", true],
    [undefined, 0, "warning", "Allergies not recorded", true],
    ["NKDA", 0, "warning", "Allergies not recorded", true],
  ])("status %s with %i rows: %s %s", (status, count, tone, label, showInLists) => {
    const flag = describeAllergyFlag(status, count);
    expect(flag.tone).toBe(tone);
    expect(flag.label).toBe(label);
    expect(flag.showInLists).toBe(showInLists);
    expect(flag.label).toMatch(/[Aa]llergies/);
    expect(flag.accessibilityLabel.length).toBeGreaterThan(0);
  });

  it("never turns an unknown status into a calm state", () => {
    for (const status of ["unknown", "", "none", null]) {
      expect(describeAllergyFlag(status, 0).tone).not.toBe("neutral");
    }
  });

  it("parses statuses defensively", () => {
    expect(parseAllergyStatus("has_allergies")).toBe("has_allergies");
    expect(parseAllergyStatus("no_known_allergies")).toBe("no_known_allergies");
    expect(parseAllergyStatus("HAS_ALLERGIES")).toBe("unknown");
  });

  it("speaks counts in words", () => {
    expect(describeAllergyFlag("has_allergies", 1).accessibilityLabel).toBe(
      "Allergies: 1 allergy recorded",
    );
    expect(describeAllergyFlag("has_allergies", 3).accessibilityLabel).toBe(
      "Allergies: 3 allergies recorded",
    );
  });
});

describe("communication needs flag", () => {
  it("labels communication needs", () => {
    expect(communicationFlagLabel(0)).toBe("");
    expect(communicationFlagLabel(1)).toBe("Communication need");
    expect(communicationFlagLabel(2)).toBe("Communication needs (2)");
  });
});
