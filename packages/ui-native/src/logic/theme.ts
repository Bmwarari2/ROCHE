/**
 * Native theme resolution. Every value comes from the shared tokens in `@harbour/ui/tokens`;
 * the high-contrast palettes re-map roles onto existing token values rather than adding colours.
 *
 * Pure module: no React Native imports, so it is unit-tested in Node.
 */
import {
  type ClinicalStatus,
  type ColorScheme,
  clinicalStatus,
  colorDark,
  colorLight,
  layout,
  motion,
  radius,
  space,
  type TypeStyle,
  typeScale,
} from "@harbour/ui/tokens";
import { contrastRatio } from "./contrast";

export type SchemeName = "light" | "dark";
export type SchemePreference = "system" | SchemeName;

export interface ThemePreference {
  readonly scheme: SchemePreference;
  readonly highContrast: boolean;
}

export const defaultThemePreference: ThemePreference = { scheme: "system", highContrast: false };

export type Palette = { readonly [K in keyof ColorScheme]: string };

export type TypeVariant = keyof typeof typeScale;

/** A React Native text style derived from a type-scale token. */
export interface NativeTypeStyle {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
  readonly letterSpacing: number;
}

/** Semantic text colours. `onAccent` is only for text on accent or status fills. */
export type TextTone =
  | "primary"
  | "secondary"
  | "accent"
  | "link"
  | "danger"
  | "warning"
  | "success"
  | "onAccent";

export interface Theme {
  readonly scheme: SchemeName;
  readonly highContrast: boolean;
  readonly colors: Palette;
  /** Text colour for each tone, guaranteed 4.5:1 on every surface of this palette. */
  readonly textColors: { readonly [K in TextTone]: string };
  readonly type: { readonly [K in TypeVariant]: NativeTypeStyle };
  readonly space: typeof space;
  readonly radius: typeof radius;
  readonly touchTarget: number;
  readonly minFontSize: number;
  readonly hairline: number;
  readonly motionMs: number;
}

/** Resolves "system" against the operating system's current scheme (light when unknown). */
export function resolveScheme(
  preference: SchemePreference,
  systemScheme: string | null | undefined,
): SchemeName {
  if (preference === "light" || preference === "dark") return preference;
  return systemScheme === "dark" ? "dark" : "light";
}

/**
 * Palette for a scheme. High contrast promotes secondary and tertiary text to the primary text
 * colour and strengthens hairlines to the secondary text colour, so nothing relies on a pale grey.
 */
export function buildPalette(scheme: SchemeName, highContrast: boolean): Palette {
  const base: Palette = scheme === "dark" ? colorDark : colorLight;
  if (!highContrast) return { ...base };
  return {
    ...base,
    textSecondary: base.text,
    textTertiary: base.text,
    border: base.textSecondary,
    bgSecondary: base.bg,
    card: base.bg,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Converts a type token to a native text style. Type never goes below `layout.nativeMinFontSize`
 * (15) on mobile, so the 14 px callout and 12 px caption tokens are raised to 15.
 */
export function nativeTypeStyle(style: TypeStyle): NativeTypeStyle {
  const fontSize = Math.max(style.size, layout.nativeMinFontSize);
  return {
    fontSize,
    lineHeight: Math.round(fontSize * style.lineHeight),
    fontWeight: String(style.weight) as NativeTypeStyle["fontWeight"],
    letterSpacing: round(style.letterSpacingEm * fontSize, 2),
  };
}

function buildTypeScale(): Theme["type"] {
  const entries = (Object.keys(typeScale) as TypeVariant[]).map(
    (variant) => [variant, nativeTypeStyle(typeScale[variant])] as const,
  );
  return Object.fromEntries(entries) as Theme["type"];
}

const nativeType = buildTypeScale();

/** WCAG 2.2 AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** Preferred token colours per tone, in order; the first that passes AA on every surface wins. */
const toneCandidates: Record<Exclude<TextTone, "onAccent">, ReadonlyArray<keyof Palette>> = {
  primary: ["text"],
  secondary: ["textSecondary", "text"],
  accent: ["accent", "link", "text"],
  link: ["link", "text"],
  danger: ["danger", "text"],
  warning: ["warning", "text"],
  success: ["success", "text"],
};

/**
 * Resolves text tones against the palette's surfaces (bg, card, bgSecondary). Status colours are
 * fixed across themes and too dark for text on the dark surfaces, so there the tone falls back to
 * the primary text colour; the accompanying icon and words still carry the meaning.
 */
export function resolveTextColors(palette: Palette): Theme["textColors"] {
  const surfaces = [palette.bg, palette.card, palette.bgSecondary];
  const passes = (colour: string) =>
    surfaces.every((surface) => contrastRatio(colour, surface) >= MIN_TEXT_CONTRAST);
  const resolve = (tone: Exclude<TextTone, "onAccent">) =>
    toneCandidates[tone].map((role) => palette[role]).find(passes) ?? palette.text;
  return {
    primary: resolve("primary"),
    secondary: resolve("secondary"),
    accent: resolve("accent"),
    link: resolve("link"),
    danger: resolve("danger"),
    warning: resolve("warning"),
    success: resolve("success"),
    onAccent: palette.onAccent,
  };
}

export function buildTheme(scheme: SchemeName, highContrast: boolean): Theme {
  const colors = buildPalette(scheme, highContrast);
  return {
    scheme,
    highContrast,
    colors,
    textColors: resolveTextColors(colors),
    type: nativeType,
    space,
    radius,
    touchTarget: layout.touchTarget,
    minFontSize: layout.nativeMinFontSize,
    hairline: 1,
    motionMs: motion.durationBase,
  };
}

export type Tone = "danger" | "warning" | "success" | "info" | "neutral";

export interface ToneAppearance {
  readonly background: string;
  readonly foreground: string;
}

/**
 * Filled chip colours for a tone. Status colours are a fixed semantic set independent of the theme
 * (section 8), so fills always come from the light token set, where every fill carries the
 * on-accent (white) foreground at 4.5:1 or better; the dark theme's lighter link and info colours
 * would not.
 */
export function toneAppearance(tone: Tone): ToneAppearance {
  const fill: Record<Tone, string> = {
    danger: colorLight.danger,
    warning: colorLight.warning,
    success: colorLight.success,
    info: colorLight.info,
    neutral: colorLight.textSecondary,
  };
  return { background: fill[tone], foreground: colorLight.onAccent };
}

export interface StatusAppearance extends ToneAppearance {
  readonly label: string;
  /** Lucide icon name from the tokens, for example "circle-alert". */
  readonly icon: string;
}

const statusTone: Record<ClinicalStatus, Tone> = {
  overdue: "danger",
  due: "warning",
  done: "success",
  notApplicable: "neutral",
};

/** Clinical status chip appearance: always an icon and a word, never colour alone. */
export function statusAppearance(status: ClinicalStatus): StatusAppearance {
  const token = clinicalStatus[status];
  return { label: token.label, icon: token.icon, ...toneAppearance(statusTone[status]) };
}
