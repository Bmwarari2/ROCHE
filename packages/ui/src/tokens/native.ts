/**
 * Tokens for the phone app's two looks (ADR-0138): Material 3 on Android, and iOS 26 with Liquid
 * Glass. Brand colours come from the generated Material 3 scheme (`m3-scheme.ts`, seeded with the
 * Thapsus teal) on both platforms. Each platform keeps its own neutral surfaces, type scale and
 * shapes, so the app reads as native on each while the brand and status colours stay the same.
 *
 * Platform-neutral like the rest of `tokens`: plain values, no React Native imports.
 */

/**
 * iOS system neutrals: the grouped background, the cells on it, labels and separators. They follow
 * Apple's semantic colours, except that the secondary label is darker than Apple's translucent grey
 * (which is 3.5:1 on white) so it passes WCAG AA as body text on every surface.
 */
export const iosNeutral = {
  light: {
    background: "#ffffff",
    groupedBackground: "#f2f2f7",
    groupedCell: "#ffffff",
    label: "#000000",
    secondaryLabel: "#6c6c70",
    tertiaryLabel: "#8e8e93",
    separator: "#c6c6c8",
    /** Control borders, at least 3:1 on every surface. */
    control: "#767680",
    /** An opaque tertiary fill: text fields, neutral chips, tracks. */
    fill: "#e9e9eb",
    /** A pressed row. */
    highlight: "#d1d1d6",
  },
  dark: {
    background: "#000000",
    groupedBackground: "#000000",
    groupedCell: "#1c1c1e",
    label: "#ffffff",
    secondaryLabel: "#aeaeb2",
    tertiaryLabel: "#8e8e93",
    separator: "#38383a",
    control: "#8e8e93",
    fill: "#2c2c2e",
    highlight: "#3a3a3c",
  },
} as const;

/** A native text style: size and line height in points, with tracking. */
export interface NativeTypeToken {
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 400 | 500 | 600 | 700;
  readonly tracking: number;
}

const NATIVE_TYPE_VARIANTS = [
  "display",
  "headline",
  "title",
  "eyebrow",
  "intro",
  "body",
  "bodyDense",
  "callout",
  "caption",
] as const;
export type NativeTypeVariant = (typeof NATIVE_TYPE_VARIANTS)[number];

/**
 * Type scales in the platform's system font: SF on iOS (Apple's text styles), Roboto on Android
 * (the Material 3 type scale). Nothing is below 15 points (section 8), so the smaller styles are
 * raised to 15. `eyebrow` is a section heading; `title` the heading of a screen's content.
 */
export const nativeTypeScale = {
  ios: {
    display: { size: 34, lineHeight: 41, weight: 700, tracking: 0.4 },
    headline: { size: 34, lineHeight: 41, weight: 700, tracking: 0.4 },
    title: { size: 28, lineHeight: 34, weight: 700, tracking: 0.38 },
    eyebrow: { size: 20, lineHeight: 25, weight: 600, tracking: -0.45 },
    intro: { size: 20, lineHeight: 25, weight: 400, tracking: -0.45 },
    body: { size: 17, lineHeight: 22, weight: 400, tracking: -0.43 },
    bodyDense: { size: 15, lineHeight: 20, weight: 400, tracking: -0.23 },
    callout: { size: 16, lineHeight: 21, weight: 400, tracking: -0.31 },
    caption: { size: 15, lineHeight: 20, weight: 400, tracking: -0.23 },
  },
  android: {
    display: { size: 36, lineHeight: 44, weight: 400, tracking: 0 },
    headline: { size: 32, lineHeight: 40, weight: 400, tracking: 0 },
    title: { size: 28, lineHeight: 36, weight: 400, tracking: 0 },
    eyebrow: { size: 16, lineHeight: 24, weight: 500, tracking: 0.15 },
    intro: { size: 18, lineHeight: 26, weight: 400, tracking: 0 },
    body: { size: 16, lineHeight: 24, weight: 400, tracking: 0.5 },
    bodyDense: { size: 15, lineHeight: 20, weight: 400, tracking: 0.25 },
    callout: { size: 15, lineHeight: 20, weight: 400, tracking: 0.25 },
    caption: { size: 15, lineHeight: 20, weight: 400, tracking: 0.25 },
  },
} as const satisfies Record<"ios" | "android", Record<NativeTypeVariant, NativeTypeToken>>;

/** The weight of emphasised text: semibold on iOS, medium (Material 3 labels) on Android. */
export const nativeEmphasisWeight = { ios: 600, android: 500 } as const;

/**
 * Corner radii. iOS: capsule controls and the large concentric corners of iOS 26. Android: the
 * Material 3 shape scale (cards large, fields extra small, chips small, buttons full).
 */
export const nativeShape = {
  ios: { pill: 999, card: 24, tile: 28, input: 12, chip: 999, sheet: 34 },
  android: { pill: 999, card: 16, tile: 28, input: 4, chip: 8, sheet: 28 },
} as const;

/** Minimum touch target: 44 points (Apple) and 48 dp (Material 3). */
export const nativeTouchTarget = { ios: 44, android: 48 } as const;
