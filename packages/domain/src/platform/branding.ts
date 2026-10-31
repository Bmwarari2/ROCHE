/**
 * Tenant white-label accent colour (section 9.1): auto-adjusted so it reaches at least 4.5:1
 * contrast against BOTH white and black, which is possible only for relative luminance in a
 * narrow band (about 0.175 to 0.183). We keep the tenant's hue and saturation and move only the
 * HSL lightness until the luminance lands in that band.
 */

export const MIN_CONTRAST = 4.5;

const HEX = /^#?([0-9a-f]{6})$/i;

export function parseHex(hex: string): [number, number, number] {
  const match = HEX.exec(hex.trim());
  if (!match?.[1]) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const value = match[1];
  return [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

export function toHex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.2 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.2 contrast ratio between two colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]: readonly [number, number, number]): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb([h, s, l]: readonly [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3) * 255,
    hueToRgb(p, q, h) * 255,
    hueToRgb(p, q, h - 1 / 3) * 255,
  ];
}

export function meetsDualContrast(hex: string): boolean {
  return (
    contrastRatio(hex, "#ffffff") >= MIN_CONTRAST && contrastRatio(hex, "#000000") >= MIN_CONTRAST
  );
}

/**
 * Returns the tenant's accent unchanged when it already passes, otherwise the closest colour of
 * the same hue and saturation that reaches 4.5:1 on white and on black.
 */
export function adjustAccentForContrast(hex: string): string {
  const normalised = toHex(parseHex(hex));
  if (meetsDualContrast(normalised)) return normalised;

  const [h, s] = rgbToHsl(parseHex(normalised));
  // Target the luminance where contrast against white and black is equal (about 4.58:1).
  const target = Math.sqrt(1.05 * 0.05) - 0.05;
  let lo = 0;
  let hi = 1;
  let best = normalised;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const candidate = toHex(hslToRgb([h, s, mid]));
    const lum = luminance(candidate);
    if (meetsDualContrast(candidate)) best = candidate;
    if (lum < target) lo = mid;
    else hi = mid;
  }
  if (meetsDualContrast(best)) return best;
  // Rounding to 8-bit channels can step over the band for some hues; fall back to grey in band.
  return "#767676";
}

/**
 * The surfaces a tenant accent meets in Harbour's two themes (PLAT-002; platform.md, white-label
 * branding). These mirror the `bg`, `bgSecondary`, `card` and `onAccent` tokens in
 * `@harbour/ui` (`colorLight`, `colorDark`); apps/web/src/lib/branding.test.ts fails if they drift.
 * The accent fills primary buttons and selected menu items with white text on it, and draws
 * borders, tab underlines, toggles, meters and icons on the page's surfaces. The focus ring keeps
 * Harbour's own colour in both themes, so an accent never weakens it.
 */
export const BRAND_THEMES = {
  light: { onAccent: "#ffffff", bg: "#ffffff", bgSecondary: "#f5f5f7", card: "#ffffff" },
  dark: { onAccent: "#ffffff", bg: "#000000", bgSecondary: "#1d1d1f", card: "#161617" },
} as const;

export type BrandTheme = keyof typeof BRAND_THEMES;

/** Text (and the accent itself as text or an icon) needs 4.5:1; borders and fills 3:1 (WCAG 1.4.11). */
export const NON_TEXT_CONTRAST = 3;

export interface AccentCheck {
  readonly theme: BrandTheme;
  /** `text_on_accent`: white words on the accent; `accent_on_surface`: the accent on a page surface. */
  readonly use: "text_on_accent" | "accent_on_surface";
  readonly surface: "onAccent" | "bg" | "bgSecondary" | "card";
  readonly against: string;
  readonly ratio: number;
  readonly needed: number;
  readonly passes: boolean;
}

export type AccentVerdict =
  | { readonly ok: true; readonly accent: string; readonly checks: readonly AccentCheck[] }
  | { readonly ok: false; readonly problem: "not_a_colour" }
  | {
      readonly ok: false;
      /**
       * `too_light`: white words on it, or the accent on the light theme's white page, fall below
       * 4.5:1. `too_dark`: the accent on the dark theme's black page falls below 4.5:1, or on a
       * dark surface below 3:1. One luminance cannot be both, so exactly one applies.
       */
      readonly problem: "too_light" | "too_dark";
      readonly accent: string;
      readonly checks: readonly AccentCheck[];
      /** The closest colour of the same hue that passes every check, offered to the owner. */
      readonly suggestion: string;
    };

/** Whether the text is a six-digit hex colour, with or without the leading #. */
export function isHexColour(value: string): boolean {
  return HEX.test(value.trim());
}

/** Every contrast an accent must meet in both themes, measured. */
export function accentChecks(hex: string): AccentCheck[] {
  const accent = toHex(parseHex(hex));
  const checks: AccentCheck[] = [];
  for (const theme of Object.keys(BRAND_THEMES) as BrandTheme[]) {
    const surfaces = BRAND_THEMES[theme];
    const measure = (
      use: AccentCheck["use"],
      surface: AccentCheck["surface"],
      needed: number,
    ): AccentCheck => {
      const against = surfaces[surface];
      const ratio = contrastRatio(accent, against);
      return { theme, use, surface, against, ratio, needed, passes: ratio >= needed };
    };
    checks.push(
      measure("text_on_accent", "onAccent", MIN_CONTRAST),
      // On white and on black at 4.5:1, as section 9.1 sets; the other surfaces at 3:1.
      measure("accent_on_surface", "bg", MIN_CONTRAST),
      measure("accent_on_surface", "bgSecondary", NON_TEXT_CONTRAST),
      measure("accent_on_surface", "card", NON_TEXT_CONTRAST),
    );
  }
  return checks;
}

/**
 * Checks a tenant's accent (PLAT-002). A colour that passes is returned normalised (lower case,
 * with the #); one that fails is refused with why, and the closest passing colour of the same hue
 * is suggested for the owner to accept. Harbour never stores a colour that fails.
 */
export function checkAccent(input: string): AccentVerdict {
  if (!isHexColour(input)) return { ok: false, problem: "not_a_colour" };
  const accent = toHex(parseHex(input));
  const checks = accentChecks(accent);
  if (checks.every((c) => c.passes)) return { ok: true, accent, checks };
  // White on the accent and the accent on white are the same ratio: failing either is too light.
  const tooLight = checks.some((c) => !c.passes && c.against === "#ffffff");
  return {
    ok: false,
    problem: tooLight ? "too_light" : "too_dark",
    accent,
    checks,
    suggestion: adjustAccentForContrast(accent),
  };
}

/** The longest display name the shell shows (it shortens with an ellipsis on phones). */
export const BRAND_NAME_MAX = 80;

export type BrandNameVerdict =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly problem: "too_long" | "control_characters" };

/**
 * The organisation's display name (PLAT-002): NFC-normalised, trimmed, inner spaces collapsed;
 * blank means "use the registered name". At most 80 characters; no control, bidirectional or
 * zero-width characters.
 */
export function checkBrandName(input: string | null | undefined): BrandNameVerdict {
  const raw = (input ?? "").normalize("NFC");
  // Bidirectional overrides and zero-width characters too: they could make one organisation's
  // name look like another's in the switcher (security review, PLAT-002).
  if (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(
      raw.replace(/[\t\n\r]/g, " "),
    )
  ) {
    return { ok: false, problem: "control_characters" };
  }
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0) return { ok: true, name: null };
  if ([...name].length > BRAND_NAME_MAX) return { ok: false, problem: "too_long" };
  return { ok: true, name };
}
