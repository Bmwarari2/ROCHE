import { clinicalStatus, iosNeutral, layout, m3Scheme, typeScale } from "@harbour/ui/tokens";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import {
  buildPalette,
  buildTheme,
  type NativePlatform,
  nativeTypeStyle,
  resolvePlatform,
  resolveScheme,
  type SchemeName,
  statusAppearance,
  statusTone,
  type Tone,
  type TypeVariant,
  toneAppearance,
} from "./theme";

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const PLATFORMS: NativePlatform[] = ["ios", "android"];
const COMBOS: Array<[NativePlatform, SchemeName, boolean]> = PLATFORMS.flatMap((platform) =>
  (["light", "dark"] as const).flatMap((scheme) =>
    [false, true].map((hc) => [platform, scheme, hc] as [NativePlatform, SchemeName, boolean]),
  ),
);

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

describe("resolvePlatform (ADR-0138)", () => {
  it.each([
    ["android", "android"],
    ["ios", "ios"],
    ["web", "ios"],
    [null, "ios"],
  ] as const)("%s looks like %s", (os, expected) => {
    expect(resolvePlatform(os)).toBe(expected);
  });
});

describe("palettes meet WCAG 2.2 AA", () => {
  it.each(COMBOS)(
    "%s %s (high contrast: %s): text, secondary text and controls",
    (platform, scheme, hc) => {
      const p = buildPalette(scheme, hc, platform);
      for (const surface of [p.bg, p.card, p.bgSecondary]) {
        expect(contrastRatio(p.text, surface)).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(p.textSecondary, surface)).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(p.outline, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
      expect(contrastRatio(p.onAccent, p.accent)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(p.onAccentContainer, p.accentContainer)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(p.onPrimaryContainer, p.primaryContainer)).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      expect(contrastRatio(p.text, p.surfaceHigh)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it("on iOS, high contrast promotes secondary text to primary text and strengthens separators", () => {
    for (const scheme of ["light", "dark"] as const) {
      const normal = buildPalette(scheme, false, "ios");
      const hc = buildPalette(scheme, true, "ios");
      expect(hc.textSecondary).toBe(normal.text);
      expect(hc.textTertiary).toBe(normal.text);
      expect(contrastRatio(hc.border, hc.bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("on Android, high contrast uses Material's higher-contrast scheme", () => {
    expect(buildPalette("light", true, "android").accent).toBe(m3Scheme.lightContrast.primary);
    expect(buildPalette("dark", true, "android").text).toBe(m3Scheme.darkContrast.onSurface);
  });

  it("only uses colours from the shared tokens", () => {
    const tokenValues = new Set<string>([
      ...Object.values(m3Scheme).flatMap((theme) => Object.values(theme)),
      ...Object.values(iosNeutral).flatMap((theme) => Object.values(theme)),
    ]);
    for (const [platform, scheme, hc] of COMBOS) {
      for (const [role, value] of Object.entries(buildPalette(scheme, hc, platform))) {
        expect(tokenValues.has(value), `${platform} ${scheme} ${role} ${value}`).toBe(true);
      }
    }
  });

  it("gives both platforms the same brand and status colours, from the Thapsus teal scheme", () => {
    for (const scheme of ["light", "dark"] as const) {
      const ios = buildPalette(scheme, false, "ios");
      const android = buildPalette(scheme, false, "android");
      for (const role of ["accent", "danger", "warning", "success", "accentContainer"] as const) {
        expect(ios[role]).toBe(android[role]);
      }
      expect(ios.accent).toBe(m3Scheme[scheme].primary);
    }
  });

  it("keeps each platform's own surfaces", () => {
    expect(buildPalette("light", false, "ios").bgSecondary).toBe(
      iosNeutral.light.groupedBackground,
    );
    expect(buildPalette("light", false, "android").bgSecondary).toBe(
      m3Scheme.light.surfaceContainer,
    );
    expect(buildPalette("dark", false, "android").card).toBe(m3Scheme.dark.surfaceContainerHigh);
  });
});

describe("text tones meet AA on every surface", () => {
  const tones = ["primary", "secondary", "accent", "link", "danger", "warning", "success"] as const;
  it.each(COMBOS)("%s %s (high contrast: %s)", (platform, scheme, hc) => {
    const theme = buildTheme(scheme, hc, platform);
    for (const tone of tones) {
      for (const surface of [theme.colors.bg, theme.colors.card, theme.colors.bgSecondary]) {
        expect(contrastRatio(theme.textColors[tone], surface)).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });
});

describe("status and flag chips", () => {
  const tones: Tone[] = ["danger", "warning", "success", "info", "neutral"];
  it.each(COMBOS)(
    "%s %s (high contrast: %s): every chip's text is AA on its fill",
    (platform, scheme, hc) => {
      const palette = buildPalette(scheme, hc, platform);
      for (const tone of tones) {
        const { background, foreground } = toneAppearance(tone, palette);
        expect(contrastRatio(foreground, background), tone).toBeGreaterThanOrEqual(AA_TEXT);
      }
    },
  );

  it("fills danger in the error colour, the strongest signal, and uses containers for the rest", () => {
    const palette = buildPalette("light", false, "android");
    expect(toneAppearance("danger", palette)).toEqual({
      background: palette.danger,
      foreground: palette.onDanger,
    });
    expect(toneAppearance("warning", palette).background).toBe(palette.warningContainer);
    expect(toneAppearance("info", palette).background).toBe(palette.accentContainer);
  });

  it.each(Object.keys(clinicalStatus) as Array<keyof typeof clinicalStatus>)(
    "%s pairs an icon and a word with its tone",
    (status) => {
      const palette = buildPalette("light", false, "ios");
      const appearance = statusAppearance(status, palette);
      const token = clinicalStatus[status];
      expect(appearance.label).toBe(token.label);
      expect(appearance.label.length).toBeGreaterThan(0);
      expect(appearance.icon).toBe(token.icon);
      expect(appearance.background).toBe(toneAppearance(statusTone[status], palette).background);
    },
  );

  it("shows overdue as the danger fill", () => {
    expect(statusTone.overdue).toBe("danger");
  });
});

describe("native type scale", () => {
  it.each(
    PLATFORMS.flatMap((platform) =>
      (Object.keys(buildTheme("light", false, platform).type) as TypeVariant[]).map(
        (variant) => [platform, variant] as const,
      ),
    ),
  )("%s %s is never below 15", (platform, variant) => {
    const style = buildTheme("light", false, platform).type[variant];
    expect(style.fontSize).toBeGreaterThanOrEqual(layout.nativeMinFontSize);
    expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
  });

  it("uses each platform's body size and emphasis", () => {
    const ios = buildTheme("light", false, "ios");
    const android = buildTheme("light", false, "android");
    expect(ios.type.body.fontSize).toBe(17);
    expect(android.type.body.fontSize).toBe(16);
    expect(ios.emphasisWeight).toBe("600");
    expect(android.emphasisWeight).toBe("500");
  });

  it("still converts a web token to a native size of at least 15", () => {
    expect(nativeTypeStyle(typeScale.caption).fontSize).toBe(15);
  });
});

describe("shape and touch targets", () => {
  it("uses 44 pt targets on iOS and Material's 48 dp on Android", () => {
    expect(buildTheme("dark", true, "ios").touchTarget).toBe(44);
    expect(buildTheme("dark", true, "android").touchTarget).toBe(48);
  });

  it("uses capsule chips on iOS and Material's small corners on Android", () => {
    expect(buildTheme("light", false, "ios").radius.chip).toBeGreaterThanOrEqual(100);
    expect(buildTheme("light", false, "android").radius.chip).toBe(8);
    expect(buildTheme("light", false, "android").radius.input).toBe(4);
  });
});
