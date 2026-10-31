import { BRAND_THEMES } from "@harbour/domain";
import { colorDark, colorLight } from "@harbour/ui/tokens";
import { describe, expect, it } from "vitest";
import {
  accentAdvice,
  accentStyle,
  brandingShown,
  checkLabel,
  logoProblem,
  logoSrc,
  ratioLabel,
  readBranding,
} from "./branding";
import { t } from "./i18n";

/** White-label branding in the web app (PLAT-002): pure helpers, table-driven. */

describe("the theme surfaces the accent is checked against", () => {
  it.each([
    ["light", colorLight],
    ["dark", colorDark],
  ] as const)("match the %s tokens in @harbour/ui", (theme, tokens) => {
    const surfaces = BRAND_THEMES[theme];
    expect(surfaces).toEqual({
      onAccent: tokens.onAccent,
      bg: tokens.bg,
      bgSecondary: tokens.bgSecondary,
      card: tokens.card,
    });
  });
});

describe("accentStyle", () => {
  it("sets the accent in both themes, never the focus ring or status colours", () => {
    const style = accentStyle("#0074E8");
    expect(style).toBe(
      ":root,[data-theme]{--accent:#0074e8 !important;--accent-hover:#0074e8 !important;}",
    );
    expect(style).not.toMatch(/focus|status|info/);
  });

  it.each([
    null,
    undefined,
    "",
    "#0071e3",
    "#ffff00",
    "red;}body{display:none",
    "#000000;}body{x",
    "#0074e8\n}body{display:none",
    "red",
    "#12345",
  ])("applies nothing for %j (no accent, or one that fails)", (accent) => {
    expect(accentStyle(accent)).toBeNull();
  });
});

describe("accentAdvice", () => {
  it.each([
    ["", "empty"],
    ["  ", "empty"],
    ["blue", "not_a_colour"],
    ["#0074e8", "passes"],
    ["#ffff00", "fails"],
    ["#000080", "fails"],
  ])("%j is %s", (raw, state) => {
    expect(accentAdvice(raw, t).state).toBe(state);
  });

  it("says why a colour fails in plain English and offers one that passes", () => {
    const light = accentAdvice("#ffff00", t);
    if (light.state !== "fails") throw new Error("expected a failure");
    expect(light.message).toBe(
      "This colour cannot be used: it is too light, so white words on it, such as on buttons, would be hard to read.",
    );
    expect(accentAdvice(light.suggestion, t).state).toBe("passes");
    const dark = accentAdvice("#000080", t);
    if (dark.state !== "fails") throw new Error("expected a failure");
    expect(dark.message).toBe(
      "This colour cannot be used: it is too dark, so it would be hard to see against the dark theme's black background.",
    );
  });
});

describe("checkLabel and ratioLabel", () => {
  it.each([
    [4.54, "4.5:1"],
    [4.499, "4.4:1"],
    [21, "21.0:1"],
    [3, "3.0:1"],
  ])("%s reads as %s, rounded down", (ratio, label) => {
    expect(ratioLabel(ratio)).toBe(label);
  });

  it("names each check in words", () => {
    const advice = accentAdvice("#767676", t);
    if (advice.state !== "passes") throw new Error("expected a pass");
    expect(advice.checks.map((c) => checkLabel(c, t))).toEqual([
      "White words on it, light theme: 4.5:1 (needs 4.5:1)",
      "On the page, light theme: 4.5:1 (needs 4.5:1)",
      "On a grey background, light theme: 4.1:1 (needs 3.0:1)",
      "On a card, light theme: 4.5:1 (needs 3.0:1)",
      "White words on it, dark theme: 4.5:1 (needs 4.5:1)",
      "On the page, dark theme: 4.6:1 (needs 4.5:1)",
      "On a grey background, dark theme: 3.7:1 (needs 3.0:1)",
      "On a card, dark theme: 3.9:1 (needs 3.0:1)",
    ]);
  });
});

describe("readBranding", () => {
  const form = (values: Record<string, string>) => ({
    get: (name: string) => values[name] ?? null,
  });

  it.each([
    [{ displayName: " Lodge  Care ", accent: "#0074E8" }, "Lodge Care", "#0074e8"],
    [{ displayName: "", accent: "" }, null, null],
  ])("reads %j", (values, displayName, accent) => {
    expect(readBranding(form(values), 7, t)).toEqual({
      ok: true,
      value: { displayName, accent, expectedVersion: 7 },
    });
  });

  it("refuses a failing colour at its field, with the suggestion, and a long name", () => {
    const read = readBranding(form({ displayName: "x".repeat(81), accent: "#ffff00" }), 1, t);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.fields.displayName).toBe("Keep the display name to 80 characters or fewer.");
    expect(read.fields.accent).toMatch(
      /too light.*Try #[0-9a-f]{6}, the nearest colour that works\./,
    );
  });

  it("refuses text that is not a colour", () => {
    const read = readBranding(form({ accent: "teal" }), 1, t);
    expect(read).toEqual({
      ok: false,
      fields: { accent: "Enter the colour as a six-digit hex code, for example #0074e8." },
    });
  });
});

describe("the logo", () => {
  it.each([
    [null, "Choose an image file for the logo."],
    [{ type: "image/png", size: 0 }, "Choose an image file for the logo."],
    [{ type: "image/svg+xml", size: 100 }, "Choose a PNG or JPEG image."],
    [{ type: "application/pdf", size: 100 }, "Choose a PNG or JPEG image."],
    [{ type: "image/png", size: 512 * 1024 + 1 }, "Choose an image of 512 KB or less."],
    [{ type: "image/webp", size: 100 }, "Choose a PNG or JPEG image."],
    [{ type: "image/png", size: 512 * 1024 }, null],
    [{ type: "image/jpeg", size: 2048 }, null],
  ])("%j: %j", (file, problem) => {
    expect(logoProblem(file, t)).toBe(problem);
  });

  it("changes address with the document, so a new logo is fetched at once", () => {
    expect(logoSrc("0194d000-0000-7000-8000-000000000001")).toBe(
      "/branding/logo?v=0194d000-0000-7000-8000-000000000001",
    );
    expect(logoSrc(null)).toBeNull();
  });

  it("is managed only with platform.tenant.manage", () => {
    expect(brandingShown(["platform.tenant.manage"])).toBe(true);
    expect(brandingShown(["platform.dpia.read", "people.person.read"])).toBe(false);
  });
});
