import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { characterCount, peopleLabel, t } from "./i18n";

describe("t", () => {
  it("is British English", () => {
    expect(t.locale).toBe("en-GB");
    expect(t("app.name")).toBe("Harbour");
  });
});

describe("peopleLabel", () => {
  it.each([
    ["resident", "Residents"],
    ["client", "Clients"],
    ["person_we_support", "People we support"],
  ] as const)("%s is %s", (terminology, expected) => {
    expect(peopleLabel(terminology)).toBe(expected);
  });
});

describe("characterCount", () => {
  it.each([
    [1000, "You have 1,000 characters remaining"],
    [2, "You have 2 characters remaining"],
    [1, "You have 1 character remaining"],
    [0, "You have 0 characters remaining"],
    [-1, "You have 1 character too many"],
    [-30, "You have 30 characters too many"],
  ])("%i remaining reads %s", (remaining, expected) => {
    expect(characterCount(remaining)).toBe(expected);
  });

  it("uses the translator it is given", () => {
    expect(characterCount(5, createTranslator("cy"))).toBe("You have 5 characters remaining");
  });
});
