// The Material 3 colour scheme of the Thapsus Care phone app (ADR-0138), generated from the Thapsus
// teal, the seed every Thapsus product uses (the suite design plan; Thapsus-HR ADR-0254).
//
// Google's Material colour utilities (Apache-2.0, a development dependency only) compute it, with the
// same method as Thapsus-HR (SchemeFidelity, which keeps the seed as the light primary container).
// The result is written as plain values to m3-scheme.ts, so the app never ships the library, and
// m3-scheme.test.ts fails if the committed file differs from what this computes. The library's ES
// modules import without file extensions, which Vite resolves and plain Node does not, so the test
// is also the writer: UPDATE_M3_SCHEME=1 pnpm --filter @harbour/ui exec vitest run m3-scheme
//
// Only the test imports this file; nothing in an app does.
import {
  argbFromHex,
  customColor,
  Hct,
  hexFromArgb,
  MaterialDynamicColors,
  SchemeFidelity,
} from "@material/material-color-utilities";

export const SEED = "#0B6B63";

/** Light and dark, and a higher-contrast version of each (M3 contrast level 0.5). */
export const THEMES = ["light", "dark", "lightContrast", "darkContrast"] as const;

const ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "secondary",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
  "surface",
  "onSurface",
  "onSurfaceVariant",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "outline",
  "outlineVariant",
  "inverseSurface",
  "inverseOnSurface",
  "inversePrimary",
  "scrim",
] as const;

/** Status colours M3 does not define: custom colours harmonised toward the seed (as Thapsus-HR). */
const CUSTOM = { success: "#1B7A3A", warning: "#8A5A00" } as const;

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function computeScheme(): Record<(typeof THEMES)[number], Record<string, string>> {
  const seedArgb = argbFromHex(SEED);
  const seed = Hct.fromInt(seedArgb);
  const out = {} as Record<(typeof THEMES)[number], Record<string, string>>;
  for (const theme of THEMES) {
    const dark = theme.startsWith("dark");
    const scheme = new SchemeFidelity(seed, dark, theme.endsWith("Contrast") ? 0.5 : 0);
    const roles: Record<string, string> = {};
    for (const role of ROLES)
      roles[role] = hexFromArgb(MaterialDynamicColors[role].getArgb(scheme));
    for (const [name, hex] of Object.entries(CUSTOM)) {
      const group = customColor(seedArgb, { name, value: argbFromHex(hex), blend: true });
      const g = dark ? group.dark : group.light;
      roles[name] = hexFromArgb(g.color);
      roles[`on${capital(name)}`] = hexFromArgb(g.onColor);
      roles[`${name}Container`] = hexFromArgb(g.colorContainer);
      roles[`on${capital(name)}Container`] = hexFromArgb(g.onColorContainer);
    }
    out[theme] = roles;
  }
  return out;
}

export function schemeModule(): string {
  const body = JSON.stringify(computeScheme(), null, 2).replace(/"(\w+)":/g, "$1:");
  return `/* GENERATED from the seed ${SEED} by packages/ui/src/tokens/m3-scheme-source.ts (UPDATE_M3_SCHEME=1). Do not edit by hand. */
export const m3Scheme = ${body} as const;

export type M3Theme = keyof typeof m3Scheme;
export type M3Role = keyof (typeof m3Scheme)["light"];
`;
}
