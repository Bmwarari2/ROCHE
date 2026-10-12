import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

/**
 * TrueType fonts for printed packs (ADR-0040): Noto Sans regular and bold (SIL Open Font Licence,
 * from @expo-google-fonts/noto-sans), embedded whole so every character the font has prints as
 * written: Welsh (ŵ, ŷ), Greek (β, μ), Ł, Š, Œ, € and the rest of Latin, Greek and Cyrillic. The
 * reader needs only three tables: the character map, the advance widths and the font's metrics.
 */

export interface TrueTypeFont {
  /** PostScript-style name for the PDF (`NotoSans-Regular`). */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly bbox: readonly [number, number, number, number];
  /** The glyph for a code point, or 0 (the font has no glyph for it). */
  glyph(codePoint: number): number;
  /** A glyph's advance width in font units. */
  advance(glyph: number): number;
}

const FONT_FILES = {
  regular: { dir: "400Regular", file: "NotoSans_400Regular.ttf", name: "NotoSans-Regular" },
  bold: { dir: "700Bold", file: "NotoSans_700Bold.ttf", name: "NotoSans-Bold" },
} as const;

export type FontWeight = keyof typeof FONT_FILES;

/** The font file: next to the bundle in the container (build.mjs copies it), else the package. */
export function fontPath(weight: FontWeight): string {
  const { dir, file } = FONT_FILES[weight];
  const bundled = fileURLToPath(new URL(`./fonts/${file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return nodeModule
    .createRequire(import.meta.url)
    .resolve(`@expo-google-fonts/noto-sans/${dir}/${file}`);
}

class Reader {
  constructor(private readonly view: DataView) {}
  u16 = (at: number) => this.view.getUint16(at);
  i16 = (at: number) => this.view.getInt16(at);
  u32 = (at: number) => this.view.getUint32(at);
}

interface Group {
  readonly start: number;
  readonly end: number;
  readonly glyph: number;
}

/** Reads the cmap subtable for Unicode (format 12, or format 4) into ranges. */
function readCmap(r: Reader, cmap: number): Group[] {
  const count = r.u16(cmap + 2);
  let format4: number | null = null;
  for (let i = 0; i < count; i++) {
    const platform = r.u16(cmap + 4 + i * 8);
    const encoding = r.u16(cmap + 6 + i * 8);
    const offset = cmap + r.u32(cmap + 8 + i * 8);
    const format = r.u16(offset);
    if (format === 12 && (platform === 3 || platform === 0)) {
      const groups: Group[] = [];
      const n = r.u32(offset + 12);
      for (let g = 0; g < n; g++) {
        const at = offset + 16 + g * 12;
        groups.push({ start: r.u32(at), end: r.u32(at + 4), glyph: r.u32(at + 8) });
      }
      return groups;
    }
    if (format === 4 && platform === 3 && encoding === 1) format4 = offset;
  }
  if (format4 === null) throw new Error("The font has no Unicode character map.");
  const segments = r.u16(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  const groups: Group[] = [];
  for (let s = 0; s < segments; s++) {
    const start = r.u16(starts + s * 2);
    const end = r.u16(ends + s * 2);
    const delta = r.i16(deltas + s * 2);
    const rangeOffset = r.u16(rangeOffsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const at = rangeOffsets + s * 2 + rangeOffset + (c - start) * 2;
        const raw = r.u16(at);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) groups.push({ start: c, end: c, glyph });
    }
  }
  return groups;
}

export function parseTrueType(bytes: Uint8Array, name: string): TrueTypeFont {
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const tables = new Map<string, number>();
  const count = r.u16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      bytes[at] ?? 0,
      bytes[at + 1] ?? 0,
      bytes[at + 2] ?? 0,
      bytes[at + 3] ?? 0,
    );
    tables.set(tag, r.u32(at + 8));
  }
  const table = (tag: string) => {
    const at = tables.get(tag);
    if (at === undefined) throw new Error(`The font has no ${tag} table.`);
    return at;
  };
  const head = table("head");
  const hhea = table("hhea");
  const hmtx = table("hmtx");
  const unitsPerEm = r.u16(head + 18);
  const bbox = [r.i16(head + 36), r.i16(head + 38), r.i16(head + 40), r.i16(head + 42)] as const;
  const ascent = r.i16(hhea + 4);
  const descent = r.i16(hhea + 6);
  const metrics = r.u16(hhea + 34);
  const os2 = tables.get("OS/2");
  const capHeight = os2 !== undefined && r.u16(os2) >= 2 ? r.i16(os2 + 88) : ascent;
  const groups = readCmap(r, table("cmap")).sort((a, b) => a.start - b.start);
  const lastAdvance = r.u16(hmtx + (metrics - 1) * 4);
  return {
    name,
    bytes,
    unitsPerEm,
    ascent,
    descent,
    capHeight,
    bbox,
    glyph(codePoint) {
      let low = 0;
      let high = groups.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const g = groups[mid];
        if (!g) break;
        if (codePoint < g.start) high = mid - 1;
        else if (codePoint > g.end) low = mid + 1;
        else return g.glyph + (codePoint - g.start);
      }
      return 0;
    },
    advance(glyph) {
      return glyph < metrics ? r.u16(hmtx + glyph * 4) : lastAdvance;
    },
  };
}

const loaded = new Map<FontWeight, TrueTypeFont>();

/** The packs' font, read once per process. */
export function packFont(weight: FontWeight): TrueTypeFont {
  const cached = loaded.get(weight);
  if (cached) return cached;
  const font = parseTrueType(
    new Uint8Array(readFileSync(fontPath(weight))),
    FONT_FILES[weight].name,
  );
  loaded.set(weight, font);
  return font;
}

/**
 * Text as the pack prints it: composed (NFC, so "ŷ" typed as y plus a combining circumflex is one
 * character the font has), with tabs and other control characters as spaces. Line breaks are kept
 * for the writer to start new lines.
 */
export function printable(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    out += ch === "\n" ? "\n" : code < 32 || (code >= 0x7f && code < 0xa0) ? " " : ch;
  }
  return out;
}

/** The characters in `text` that no pack font can print (they print as "?"). */
export function unprintableCharacters(text: string): string[] {
  const regular = packFont("regular");
  const missing = new Set<string>();
  for (const ch of printable(text)) {
    if (ch === "\n" || ch === " ") continue;
    if (regular.glyph(ch.codePointAt(0) ?? 0) === 0) missing.add(ch);
  }
  return [...missing];
}
