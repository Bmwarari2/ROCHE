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
