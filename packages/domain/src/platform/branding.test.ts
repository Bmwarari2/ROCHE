import { describe, expect, it } from "vitest";
import {
  accentChecks,
  adjustAccentForContrast,
  BRAND_NAME_MAX,
  checkAccent,
  checkBrandName,
  contrastRatio,
  isHexColour,
} from "./branding";

/**
 * White-label accent and display name (PLAT-002; platform.md, white-label branding). Table-driven:
 * every accent that passes must keep white words on it and the accent itself readable in the light
 * and dark themes; every one that fails is refused with the right reason and a passing suggestion.
 */

describe("checkAccent: colours that pass", () => {
  it.each([
    ["#767676", "#767676"],
    ["#0074E8", "#0074e8"],
    ["0074e8", "#0074e8"],
    [" #E21C6A ", "#e21c6a"],
    ["#ed0000", "#ed0000"],
    ["#008900", "#008900"],
  ])("%s passes and is stored as %s", (input, stored) => {
    const verdict = checkAccent(input);
    expect(verdict).toMatchObject({ ok: true, accent: stored });
    if (verdict.ok) expect(verdict.checks.every((c) => c.passes)).toBe(true);
  });
});

describe("checkAccent: colours that fail", () => {
  it.each([
    // White words on these fall below 4.5:1.
    ["#ffff00", "too_light"],
    ["#00ff00", "too_light"],
    ["#ff69b4", "too_light"],
    ["#ffffff", "too_light"],
    ["#0077ed", "too_light"],
    // Harbour's own default is 4.47:1 on black: just short of the 4.5:1 section 9.1 asks for.
    ["#0071e3", "too_dark"],
    ["#000080", "too_dark"],
    ["#123456", "too_dark"],
    ["#000000", "too_dark"],
    ["#1a7f36", "too_dark"],
  ])("%s is refused as %s, with a passing suggestion", (input, problem) => {
    const verdict = checkAccent(input);
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.problem === "not_a_colour") throw new Error("expected a contrast");
    expect(verdict.problem).toBe(problem);
    expect(verdict.checks.some((c) => !c.passes)).toBe(true);
    const again = checkAccent(verdict.suggestion);
    expect(again.ok).toBe(true);
  });

  it.each(["blue", "#fff", "#12345", "#1234567", "", "#gggggg", "rgb(0,0,0)"])(
    "%j is not a colour",
    (input) => {
      expect(checkAccent(input)).toEqual({ ok: false, problem: "not_a_colour" });
      expect(isHexColour(input)).toBe(false);
    },
  );
});

describe("accentChecks", () => {
  it("measures white words on the accent and the accent on every surface in both themes", () => {
    const checks = accentChecks("#767676");
    expect(checks).toHaveLength(8);
    expect(checks.map((c) => `${c.theme}:${c.use}:${c.surface}:${c.needed}`)).toEqual([
      "light:text_on_accent:onAccent:4.5",
      "light:accent_on_surface:bg:4.5",
      "light:accent_on_surface:bgSecondary:3",
      "light:accent_on_surface:card:3",
      "dark:text_on_accent:onAccent:4.5",
      "dark:accent_on_surface:bg:4.5",
      "dark:accent_on_surface:bgSecondary:3",
      "dark:accent_on_surface:card:3",
    ]);
    for (const c of checks) expect(c.ratio).toBeCloseTo(contrastRatio("#767676", c.against), 6);
  });

  it.each(["#ff0000", "#00ffff", "#ffa500", "#800080", "#2e8b57", "#0071e3", "#fafafa"])(
    "the suggestion for %s passes every check, on white and on black",
    (input) => {
      const adjusted = adjustAccentForContrast(input);
      expect(accentChecks(adjusted).every((c) => c.passes)).toBe(true);
    },
  );
});

describe("checkBrandName", () => {
  it.each([
    ["Riverside Care", "Riverside Care"],
    ["  Riverside   Care  ", "Riverside Care"],
    ["Ty\u0302 Gofal", "Ty\u0302 Gofal"],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
    ["Line\none", "Line one"],
    ["x".repeat(BRAND_NAME_MAX), "x".repeat(BRAND_NAME_MAX)],
  ])("%j is kept as %j", (input, name) => {
    expect(checkBrandName(input)).toEqual({ ok: true, name });
  });

  it.each([
    ["x".repeat(BRAND_NAME_MAX + 1), "too_long"],
    ["Bell\u0007", "control_characters"],
    ["Null\u0000", "control_characters"],
    ["Split\u2028line", "control_characters"],
  ])("%j is refused as %s", (input, problem) => {
    expect(checkBrandName(input)).toEqual({ ok: false, problem });
  });
});
