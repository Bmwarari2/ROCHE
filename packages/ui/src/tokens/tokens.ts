/**
 * Harbour design tokens (master prompt section 8).
 *
 * This object is platform-neutral: it must not reference the DOM, CSS or React Native APIs, because
 * it is the single source for both `tokens.css` (web) and `@harbour/ui-native` (iOS and Android).
 * Values are in CSS pixels (web) and density-independent points (native).
 */

export const colorLight = {
  bg: "#ffffff",
  bgSecondary: "#f5f5f7",
  card: "#ffffff",
  text: "#1d1d1f",
  /** 5:1 on white, AA for body text. */
  textSecondary: "#6e6e73",
  /** Large text or on dark backgrounds only. */
  textTertiary: "#86868b",
  border: "#d2d2d7",
  link: "#0066cc",
  accent: "#0071e3",
  accentHover: "#0077ed",
  onAccent: "#ffffff",
  success: "#1a7f36",
  warning: "#b25000",
  danger: "#d70015",
  info: "#0071e3",
  nav: "rgba(255,255,255,0.72)",
  navFallback: "rgba(255,255,255,0.92)",
  /** Keyboard focus indicator: at least 3:1 against the canvas in both themes. */
  focusRing: "#0066cc",
} as const;

export const colorDark = {
  bg: "#000000",
  bgSecondary: "#1d1d1f",
  card: "#161617",
  text: "#f5f5f7",
  textSecondary: "#86868b",
  textTertiary: "#86868b",
  border: "#424245",
  link: "#2997ff",
  accent: "#0071e3",
  accentHover: "#0077ed",
  onAccent: "#ffffff",
  /** Status colours are fixed across themes (section 8); chips render them as fills with white text. */
  success: "#1a7f36",
  warning: "#b25000",
  danger: "#d70015",
  info: "#2997ff",
  nav: "rgba(22,22,23,0.8)",
  navFallback: "rgba(22,22,23,0.92)",
  focusRing: "#2997ff",
} as const;

export type ColorScheme = { readonly [K in keyof typeof colorLight]: string };

/**
 * Clinical status: a fixed semantic set, always rendered with an icon and a word, never colour only.
 * Each status names the colour role it uses so both themes stay consistent.
 */
export const clinicalStatus = {
  overdue: { colorRole: "danger", icon: "circle-alert", label: "Overdue" },
  due: { colorRole: "warning", icon: "clock", label: "Due" },
  done: { colorRole: "success", icon: "circle-check", label: "Done" },
  notApplicable: { colorRole: "textSecondary", icon: "circle-minus", label: "Not applicable" },
  /**
   * Something that must be recorded and is not (allergies, communication needs): a warning with a
   * question mark, never the clock of a task that is due, and never blank or "none".
   */
  notRecorded: { colorRole: "warning", icon: "circle-help", label: "Not recorded" },
} as const satisfies Record<string, { colorRole: keyof ColorScheme; icon: string; label: string }>;

export type ClinicalStatus = keyof typeof clinicalStatus;

/**
 * Filled status backgrounds, identical in both themes. Every fill carries white text at 4.5:1 or
 * better (white on success 5.08, warning 5.20, danger 5.38, not applicable 5.07, info 4.69).
 * Not applicable uses the light-theme secondary text colour because the dark-theme value (#86868b)
 * is too light to carry white text.
 */
export const statusFill = {
  overdue: colorLight.danger,
  due: colorLight.warning,
  done: colorLight.success,
  notApplicable: colorLight.textSecondary,
  info: colorLight.info,
  onFill: "#ffffff",
} as const;

export const fontFamily = {
  /** System stack first so Apple devices render SF legally; Inter (SIL OFL) elsewhere. */
  sans: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  /**
   * The web stack as served: Fontsource registers the self-hosted Inter face as "Inter Variable",
   * so it is named before "Inter" (which still matches a locally installed copy).
   */
  webSans:
    '-apple-system, BlinkMacSystemFont, "Inter Variable", "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  /** React Native uses the platform font; Inter is bundled for Android parity. */
  nativeSans: "System",
} as const;

export interface TypeStyle {
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 400 | 500 | 600 | 700;
  readonly letterSpacingEm: number;
}

/** Type scale: size / line-height (unitless ratio) / weight / letter-spacing in em. */
export const typeScale = {
  display: { size: 80, lineHeight: 1.05, weight: 600, letterSpacingEm: -0.015 },
  headline: { size: 48, lineHeight: 1.08, weight: 600, letterSpacingEm: -0.003 },
  title: { size: 32, lineHeight: 1.125, weight: 600, letterSpacingEm: 0.004 },
  eyebrow: { size: 24, lineHeight: 1.17, weight: 600, letterSpacingEm: 0.009 },
  intro: { size: 21, lineHeight: 1.38, weight: 400, letterSpacingEm: 0.011 },
  body: { size: 17, lineHeight: 1.47, weight: 400, letterSpacingEm: -0.022 },
  bodyDense: { size: 15, lineHeight: 1.47, weight: 400, letterSpacingEm: -0.016 },
  callout: { size: 14, lineHeight: 1.43, weight: 400, letterSpacingEm: -0.016 },
  caption: { size: 12, lineHeight: 1.33, weight: 400, letterSpacingEm: -0.01 },
} as const satisfies Record<string, TypeStyle>;

/**
 * Responsive overrides at the two Apple breakpoints: the marketing scale shrinks, and on a phone
 * the small sizes grow, so nothing a carer reads is under 15 px (callout) or 13 px (caption).
 */
export const typeScaleResponsive = {
  medium: {
    display: { size: 64, lineHeight: 1.0625 },
    headline: { size: 40, lineHeight: 1.08 },
  },
  small: {
    display: { size: 48, lineHeight: 1.08 },
    headline: { size: 32, lineHeight: 1.08 },
    callout: { size: 15, lineHeight: 1.47 },
    caption: { size: 13, lineHeight: 1.38 },
  },
} as const;

export const breakpoints = {
  /** At or below this width the content column narrows to 692 px. */
  medium: 1068,
  /** At or below this width the content column is 87.5% of the viewport. */
  small: 734,
  /** Product shell wide tables. */
  wide: 1440,
} as const;

export const layout = {
  contentWidth: 980,
  contentWidthMedium: 692,
  contentWidthSmallPercent: 87.5,
  gutter: 22,
  sectionPaddingMin: 100,
  sectionPaddingMax: 150,
  shellPagePadding: 32,
  navHeight: 44,
  navHeightTouchMax: 48,
  /** Minimum interactive target (WCAG 2.2 AA and section 8). */
  touchTarget: 44,
  /** Mobile: type never below this size. */
  nativeMinFontSize: 15,
} as const;

/** 8 px spacing grid. */
export const space = {
  0: 0,
  0.5: 4,
  1: 8,
  1.5: 12,
  2: 16,
  3: 24,
  4: 32,
  5: 40,
  6: 48,
  8: 64,
  10: 80,
  12: 96,
  16: 128,
} as const;

export const radius = {
  pill: 980,
  card: 18,
  tile: 28,
  input: 12,
  chip: 8,
} as const;

export const elevation = {
  /** The only shadow, for floating panels. Everything else uses hairline borders. */
  floating: { css: "0 4px 20px rgba(0,0,0,0.08)", offsetY: 4, blur: 20, opacity: 0.08 },
  hairline: 1,
} as const;

export const motion = {
  durationFast: 200,
  durationBase: 250,
  durationSlow: 300,
  easing: "cubic-bezier(0, 0, 0.2, 1)",
  revealTranslate: 12,
} as const;

export const navBlur = {
  backdropFilter: "saturate(180%) blur(20px)",
  textSizeDesktop: 12,
  textSizeDrawer: 17,
} as const;

export const button = {
  paddingY: 8,
  paddingX: 16,
  fontSize: 17,
  minHeight: 44,
} as const;

export const tokens = {
  color: { light: colorLight, dark: colorDark },
  clinicalStatus,
  statusFill,
  fontFamily,
  typeScale,
  typeScaleResponsive,
  breakpoints,
  layout,
  space,
  radius,
  elevation,
  motion,
  navBlur,
  button,
} as const;

export type Tokens = typeof tokens;
