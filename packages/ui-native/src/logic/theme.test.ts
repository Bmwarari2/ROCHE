import { clinicalStatus, colorLight, layout, typeScale } from "@harbour/ui/tokens";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import {
  buildPalette,
  buildTheme,
  nativeTypeStyle,
  resolveScheme,
  resolveTextColors,
  type SchemeName,
  statusAppearance,
  type Tone,
  type TypeVariant,
  toneAppearance,
} from "./theme";

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe("resolveScheme", () => {
  it.each([
    ["system", "dark", "dark"],
    ["system", "light", "light"],
    ["system", null, "light"],
    ["system", "unspecified", "light"],
    ["light", "dark", "light"],
    ["dark", "light", "dark"],
  ] as const)("%s with system %s resolves to %s", (preference, system, expected) => {
    expect(resolveScheme(preference, system)).toBe(expected);
  });
});

describe("palettes meet WCAG 2.2 AA", () => {
  const combos: Array<[SchemeName, boolean]> = [
    ["light", false],
    ["light", true],
    ["dark", false],
    ["dark", true],
  ];

  it.each(combos)("%s (high contrast: %s): body and secondary text", (scheme, hc) => {
    const p = buildPalette(scheme, hc);
    for (const surface of [p.bg, p.card, p.bgSecondary]) {
      expect(contrastRatio(p.text, surface)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(p.textSecondary, surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
    expect(contrastRatio(p.onAccent, p.accent)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("high contrast promotes secondary text to primary text and strengthens borders", () => {
    for (const scheme of ["light", "dark"] as const) {
      const normal = buildPalette(scheme, false);
      const hc = buildPalette(scheme, true);
      expect(hc.textSecondary).toBe(normal.text);
      expect(hc.textTertiary).toBe(normal.text);
      expect(contrastRatio(hc.border, hc.bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("only uses colours that exist in the shared tokens", () => {
    const tokenValues = new Set<string>([
      ...Object.values(colorLight),
      ...Object.values(buildPalette("dark", false)),
    ]);
    for (const [scheme, hc] of combos) {
      for (const value of Object.values(buildPalette(scheme, hc))) {
        expect(tokenValues.has(value)).toBe(true);
      }
    }
  });
});

describe("text tones meet AA on every surface", () => {
  const tones = ["primary", "secondary", "accent", "link", "danger", "warning", "success"] as const;
  it.each([
    ["light", false],
    ["light", true],
    ["dark", false],
    ["dark", true],
  ] as const)("%s (high contrast: %s)", (scheme, hc) => {
    const theme = buildTheme(scheme, hc);
    for (const tone of tones) {
      for (const surface of [theme.colors.bg, theme.colors.card, theme.colors.bgSecondary]) {
        expect(contrastRatio(theme.textColors[tone], surface)).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it("keeps the brand colours where they pass and falls back where they do not", () => {
    const light = buildTheme("light", false);
    expect(light.textColors.danger).toBe(colorLight.danger);
    expect(light.textColors.link).toBe(colorLight.link);
    const dark = buildTheme("dark", false);
    expect(dark.textColors.danger).toBe(dark.colors.text);
    expect(resolveTextColors(buildPalette("dark", false)).onAccent).toBe("#ffffff");
  });
});

describe("status and flag chips", () => {
  it.each(["danger", "warning", "success", "info", "neutral"] as Tone[])(
    "%s fill carries white text at AA",
    (tone) => {
      const { background, foreground } = toneAppearance(tone);
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it.each(Object.keys(clinicalStatus) as Array<keyof typeof clinicalStatus>)(
    "%s pairs an icon and a word with the token colour role",
    (status) => {
      const appearance = statusAppearance(status);
      const token = clinicalStatus[status];
      expect(appearance.label).toBe(token.label);
      expect(appearance.label.length).toBeGreaterThan(0);
      expect(appearance.icon).toBe(token.icon);
      expect(appearance.background).toBe(colorLight[token.colorRole]);
    },
  );
});

describe("native type scale", () => {
  it.each(Object.keys(typeScale) as TypeVariant[])("%s is never below 15", (variant) => {
    const style = buildTheme("light", false).type[variant];
    expect(style.fontSize).toBeGreaterThanOrEqual(layout.nativeMinFontSize);
    expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
  });

  it("raises the 12 px caption token to 15 and keeps body at 17", () => {
    expect(nativeTypeStyle(typeScale.caption).fontSize).toBe(15);
    expect(nativeTypeStyle(typeScale.body)).toEqual({
      fontSize: 17,
      lineHeight: 25,
      fontWeight: "400",
      letterSpacing: -0.37,
    });
  });

  it("exposes the 44 pt touch target", () => {
    expect(buildTheme("dark", true).touchTarget).toBe(44);
  });
});
