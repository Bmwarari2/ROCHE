/**
 * Native theme resolution (ADR-0138). The phone app looks native on each platform: Material 3 on
 * Android, iOS 26 (Liquid Glass) on iOS. Brand and status colours come from the generated Material 3
 * scheme, seeded with the Thapsus teal, on both platforms; neutral surfaces, type, shapes and the
 * touch target are the platform's own. Every value comes from `@harbour/ui/tokens`.
 *
 * Pure module: no React Native imports, so it is unit-tested in Node.
 */
import {
  type ClinicalStatus,
  type ColorScheme,
  clinicalStatus,
  iosNeutral,
  layout,
  type M3Theme,
  m3Scheme,
  motion,
  type NativeTypeVariant,
  nativeEmphasisWeight,
  nativeShape,
  nativeTouchTarget,
  nativeTypeScale,
  space,
  type TypeStyle,
} from "@harbour/ui/tokens";
import { contrastRatio } from "./contrast";

export type SchemeName = "light" | "dark";
export type SchemePreference = "system" | SchemeName;
/** The look: Material 3 on Android, iOS 26 on iOS (and anywhere else). */
export type NativePlatform = "ios" | "android";

export interface ThemePreference {
  readonly scheme: SchemePreference;
  readonly highContrast: boolean;
}

export const defaultThemePreference: ThemePreference = { scheme: "system", highContrast: false };

/** The colour roles every component uses. */
export type Palette = { readonly [K in keyof ColorScheme]: string } & {
  /** Selection and tonal buttons (M3 secondary container). */
  readonly accentContainer: string;
  readonly onAccentContainer: string;
  /** Emphasised fills such as initials (M3 primary container). */
  readonly primaryContainer: string;
  readonly onPrimaryContainer: string;
  /** Filled fields, neutral chips and tracks. */
  readonly surfaceHigh: string;
  /** Control borders, at least 3:1 on every surface. */
  readonly outline: string;
  /** A pressed row. */
  readonly pressed: string;
  readonly onDanger: string;
  readonly dangerContainer: string;
  readonly onDangerContainer: string;
  readonly warningContainer: string;
  readonly onWarningContainer: string;
  readonly successContainer: string;
  readonly onSuccessContainer: string;
};

export type TypeVariant = NativeTypeVariant;

/** A React Native text style. */
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

export interface NativeRadius {
  readonly pill: number;
  readonly card: number;
  readonly tile: number;
  readonly input: number;
  readonly chip: number;
  readonly sheet: number;
}

export interface Theme {
  readonly platform: NativePlatform;
  readonly scheme: SchemeName;
  readonly highContrast: boolean;
  readonly colors: Palette;
  /** Text colour for each tone, guaranteed 4.5:1 on every surface of this palette. */
  readonly textColors: { readonly [K in TextTone]: string };
  readonly type: { readonly [K in TypeVariant]: NativeTypeStyle };
  /** The weight of emphasised text: semibold on iOS, medium on Android. */
  readonly emphasisWeight: "500" | "600";
  readonly space: typeof space;
  readonly radius: NativeRadius;
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

/** The platform's look; anything that is not Android (iOS, and web in previews) gets iOS's. */
export function resolvePlatform(os: string | null | undefined): NativePlatform {
  return os === "android" ? "android" : "ios";
}

function m3Theme(scheme: SchemeName, highContrast: boolean): M3Theme {
  if (scheme === "dark") return highContrast ? "darkContrast" : "dark";
  return highContrast ? "lightContrast" : "light";
}

/** Brand and status roles from the Material 3 scheme, the same on both platforms. */
function brandRoles(scheme: SchemeName, highContrast: boolean) {
  const m = m3Scheme[m3Theme(scheme, highContrast)];
  return {
    link: m.primary,
    accent: m.primary,
    accentHover: m.primaryContainer,
    onAccent: m.onPrimary,
    success: m.success,
    warning: m.warning,
    danger: m.error,
    info: m.primary,
    focusRing: m.secondary,
    accentContainer: m.secondaryContainer,
    onAccentContainer: m.onSecondaryContainer,
    primaryContainer: m.primaryContainer,
    onPrimaryContainer: m.onPrimaryContainer,
    onDanger: m.onError,
    dangerContainer: m.errorContainer,
    onDangerContainer: m.onErrorContainer,
    warningContainer: m.warningContainer,
    onWarningContainer: m.onWarningContainer,
    successContainer: m.successContainer,
    onSuccessContainer: m.onSuccessContainer,
  };
}

/**
 * Android, Material 3: the page is `surface-container` in light (rows and cards rise to the lowest
 * container) and `surface` in dark (rows rise to the high container), as in Thapsus-HR.
 */
function androidPalette(scheme: SchemeName, highContrast: boolean): Palette {
  const m = m3Scheme[m3Theme(scheme, highContrast)];
  const dark = scheme === "dark";
  return {
    ...brandRoles(scheme, highContrast),
    bg: m.surface,
    bgSecondary: dark ? m.surface : m.surfaceContainer,
    card: dark ? m.surfaceContainerHigh : m.surfaceContainerLowest,
    text: m.onSurface,
    textSecondary: m.onSurfaceVariant,
    textTertiary: m.onSurfaceVariant,
    border: highContrast ? m.outline : m.outlineVariant,
    outline: m.outline,
    nav: m.surfaceContainer,
    navFallback: m.surfaceContainer,
    surfaceHigh: m.surfaceContainerHighest,
    pressed: m.surfaceContainerHighest,
  };
}

/**
 * iOS: the system's grouped surfaces and labels with the brand roles. High contrast promotes
 * secondary and tertiary text to the primary text colour and strengthens separators to the control
 * colour, so nothing relies on a pale grey.
 */
function iosPalette(scheme: SchemeName, highContrast: boolean): Palette {
  const n = iosNeutral[scheme];
  return {
    ...brandRoles(scheme, highContrast),
    bg: n.background,
    bgSecondary: n.groupedBackground,
    card: n.groupedCell,
    text: n.label,
    textSecondary: highContrast ? n.label : n.secondaryLabel,
    textTertiary: highContrast ? n.label : n.tertiaryLabel,
    border: highContrast ? n.control : n.separator,
    outline: n.control,
    nav: n.groupedCell,
    navFallback: n.groupedCell,
    surfaceHigh: n.fill,
    pressed: n.highlight,
  };
}

export function buildPalette(
  scheme: SchemeName,
  highContrast: boolean,
  platform: NativePlatform = "ios",
): Palette {
  return platform === "android"
    ? androidPalette(scheme, highContrast)
    : iosPalette(scheme, highContrast);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Converts a web type token to a native text style, never below `layout.nativeMinFontSize` (15).
 * Kept for screens that size text from the web scale; the theme uses the platform scales.
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

function buildTypeScale(platform: NativePlatform): Theme["type"] {
  const scale = nativeTypeScale[platform];
  const entries = (Object.keys(scale) as TypeVariant[]).map((variant) => {
    const token = scale[variant];
    const fontSize = Math.max(token.size, layout.nativeMinFontSize);
    const style: NativeTypeStyle = {
      fontSize,
      lineHeight: Math.max(token.lineHeight, fontSize),
      fontWeight: String(token.weight) as NativeTypeStyle["fontWeight"],
      letterSpacing: token.tracking,
    };
    return [variant, style] as const;
  });
  return Object.fromEntries(entries) as Theme["type"];
}

const typeScales: Record<NativePlatform, Theme["type"]> = {
  ios: buildTypeScale("ios"),
  android: buildTypeScale("android"),
};

/** WCAG 2.2 AA for normal text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** Preferred colours per tone, in order; the first that passes AA on every surface wins. */
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
 * Resolves text tones against the palette's surfaces (bg, card, bgSecondary). A tone that does not
 * reach AA on every surface falls back to the primary text colour; the accompanying icon and words
 * still carry the meaning.
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

export function buildTheme(
  scheme: SchemeName,
  highContrast: boolean,
  platform: NativePlatform = "ios",
): Theme {
  const colors = buildPalette(scheme, highContrast, platform);
  return {
    platform,
    scheme,
    highContrast,
    colors,
    textColors: resolveTextColors(colors),
    type: typeScales[platform],
    emphasisWeight: String(nativeEmphasisWeight[platform]) as Theme["emphasisWeight"],
    space,
    radius: nativeShape[platform],
    touchTarget: nativeTouchTarget[platform],
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
 * Chip colours for a tone. Danger is a filled error colour, the strongest signal, kept for what
 * must not be missed (overdue, allergies, a do-not-resuscitate decision); the others are tonal
 * containers with their matching text colour. Every pair is at least 4.5:1 in every theme, and a
 * chip always carries an icon and a word as well.
 */
export function toneAppearance(tone: Tone, palette: Palette): ToneAppearance {
  switch (tone) {
    case "danger":
      return { background: palette.danger, foreground: palette.onDanger };
    case "warning":
      return { background: palette.warningContainer, foreground: palette.onWarningContainer };
    case "success":
      return { background: palette.successContainer, foreground: palette.onSuccessContainer };
    case "info":
      return { background: palette.accentContainer, foreground: palette.onAccentContainer };
    case "neutral":
      return { background: palette.surfaceHigh, foreground: palette.text };
  }
}

export interface StatusAppearance extends ToneAppearance {
  readonly label: string;
  /** Lucide icon name from the tokens, for example "circle-alert". */
  readonly icon: string;
}

export const statusTone: Readonly<Record<ClinicalStatus, Tone>> = {
  overdue: "danger",
  due: "warning",
  done: "success",
  notApplicable: "neutral",
  notRecorded: "warning",
};

/** Clinical status chip appearance: always an icon and a word, never colour alone. */
export function statusAppearance(status: ClinicalStatus, palette: Palette): StatusAppearance {
  const token = clinicalStatus[status];
  return {
    label: token.label,
    icon: token.icon,
    ...toneAppearance(statusTone[status], palette),
  };
}
