import { deflateSync, inflateSync } from "node:zlib";
import { packFont, printable, type TrueTypeFont } from "./pdf-font";

/**
 * A small PDF 1.7 writer for printed packs (ADR-0040): A4 pages of text in Noto Sans, embedded
 * as TrueType (Type 0, Identity-H, with a ToUnicode map so text can be copied and read aloud),
 * and an optional JPEG or PNG photo on the first page. No JavaScript, forms or external
 * references in the output, and no dependency beyond the font. Lines are wrapped by their
 * measured width; a line break in the text starts a new line. A character the font lacks prints
 * as "?" and callers name the affected sections on the first page (`unprintableCharacters`).
 */

export interface PdfLine {
  readonly text: string;
  readonly bold?: boolean;
  /** Font size in points; 10 by default. */
  readonly size?: number;
  /** Blank space before the line, in points. */
  readonly gapBefore?: number;
  /** Starts a new page (unless the page is still empty). */
  readonly pageBreakBefore?: boolean;
  /**
   * Whose page this is, from this line on: passed to the footer of every page it reaches, so a
   * page that continues someone's record still names them (HZ-001).
   */
  readonly owner?: string;
}

/** A photo as stored: JPEG or PNG bytes. */
export interface PdfImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const FOOTER_Y = 30;
const LINE_FACTOR = 1.3;
const IMAGE_BOX = { width: 110, height: 140 };
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

// ------------------------------------------------------------------------------------------------
// Measuring and wrapping
// ------------------------------------------------------------------------------------------------

function glyphOf(font: TrueTypeFont, ch: string): number {
  const glyph = font.glyph(ch.codePointAt(0) ?? 0);
  return glyph !== 0 ? glyph : font.glyph(63); // "?"
}

/** The width of `text` in points at `size`. */
export function measure(text: string, size: number, font: TrueTypeFont = packFont("regular")) {
  let units = 0;
  for (const ch of text) units += font.advance(glyphOf(font, ch));
  return (units * size) / font.unitsPerEm;
}

/** Splits text into lines no wider than `width` points, at spaces and at line breaks. */
export function wrap(
  text: string,
  width: number,
  size = 10,
  font: TrueTypeFont = packFont("regular"),
): string[] {
  const lines: string[] = [];
  for (const paragraph of printable(text).split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      let rest = word;
      // A word wider than the line is broken by characters.
      while (measure(rest, size, font) > width) {
        if (current) {
          lines.push(current);
          current = "";
        }
        let cut = 1;
        const chars = [...rest];
        while (cut < chars.length && measure(chars.slice(0, cut + 1).join(""), size, font) <= width)
          cut++;
        lines.push(chars.slice(0, cut).join(""));
        rest = chars.slice(cut).join("");
      }
      const candidate = current ? `${current} ${rest}` : rest;
      if (measure(candidate, size, font) <= width) current = candidate;
      else {
        lines.push(current);
        current = rest;
      }
    }
    lines.push(current);
  }
  return lines;
}

// ------------------------------------------------------------------------------------------------
// Images
// ------------------------------------------------------------------------------------------------

/**
 * The largest photo the pack prints: 2048 pixels on each side. A photo for identification needs far
 * less; anything larger is named on the first page rather than decoded, so a crafted file cannot
 * hold the API's CPU or memory (HZ-023).
 */
export const MAX_IMAGE_SIDE = 2048;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;
/** A PNG with more image-data chunks, or more compressed data, than this is not decoded. */
export const MAX_PNG_IDAT_CHUNKS = 1024;
export const MAX_PNG_COMPRESSED_BYTES = 8 * 1024 * 1024;

const sizeAllowed = (width: number, height: number) =>
  width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE;

/** Frame markers a PDF reader decodes: baseline, extended and progressive Huffman JPEGs. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

interface JpegFrame {
  readonly width: number;
  readonly height: number;
  /** 1 (grey) or 3 (colour); CMYK (4) and other counts are not printed. */
  readonly components: 1 | 3;
}

/**
 * Reads a JPEG's start-of-frame: its pixel size and number of colour components, or null when it
 * is not a JPEG the pack prints (12-bit, arithmetic-coded, CMYK, or over the size limit).
 */
export function jpegFrame(bytes: Uint8Array): JpegFrame | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (!JPEG_FRAMES.has(marker) || bytes[i + 4] !== 8) return null;
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      const components = bytes[i + 9];
      if (components !== 1 && components !== 3) return null;
      return sizeAllowed(width, height) ? { width, height, components } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** A JPEG's pixel size, or null when the pack cannot print it. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const frame = jpegFrame(bytes);
  return frame ? { width: frame.width, height: frame.height } : null;
}

export interface ImageObject {
  readonly width: number;
  readonly height: number;
  readonly dict: string;
  readonly data: Uint8Array;
  readonly mask?: { readonly dict: string; readonly data: Uint8Array };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the PNG row filters (8-bit samples, `bpp` bytes per pixel). */
function unfilter(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)] ?? 0;
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const raw = data[row + x] ?? 0;
      const left = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      out[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  return out;
}

interface ParsedPng {
  readonly width: number;
  readonly height: number;
  readonly colourType: 0 | 2 | 3 | 4 | 6;
  readonly palette: Uint8Array | null;
  readonly compressed: Buffer;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Reads a PNG's chunks without decompressing anything: every chunk is bounds-checked, IHDR comes
 * first, IEND is present, only 8-bit, non-interlaced images within the size limit pass, a palette
 * image has its palette, and the number and total size of the image-data chunks are capped.
 */
function parsePng(bytes: Uint8Array): ParsedPng | null {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  let at = 8;
  let ended = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    if (at + 12 + length > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      if (length !== 13 || at !== 8) return null;
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8] ?? 0;
      colourType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (width === 0) {
      return null;
    } else if (type === "PLTE") {
      if (length % 3 !== 0 || length === 0 || length > 768) return null;
      palette = body;
    } else if (type === "IDAT") {
      idatBytes += length;
      if (idat.length >= MAX_PNG_IDAT_CHUNKS || idatBytes > MAX_PNG_COMPRESSED_BYTES) return null;
      idat.push(body);
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  if (
    !ended ||
    !sizeAllowed(width, height) ||
    depth !== 8 ||
    interlace !== 0 ||
    idat.length === 0 ||
    !(colourType in CHANNELS) ||
    (colourType === 3 && palette === null)
  ) {
    return null;
  }
  return {
    width,
    height,
    colourType: colourType as ParsedPng["colourType"],
    palette,
    compressed: Buffer.concat(idat.map((c) => Buffer.from(c))),
  };
}

/**
 * Decompresses a parsed PNG's image data, capped at exactly the size its header promises, and
 * checks every row's filter byte (0 to 4) and, for a palette image, every index against the
 * palette. Returns the filtered rows, or null when they are not exactly right.
 */
function inflatePng(
  png: ParsedPng,
): { readonly rows: Buffer; readonly pixels: Uint8Array | null } | null {
  const bpp = CHANNELS[png.colourType] ?? 1;
  const stride = png.width * bpp;
  const expected = png.height * (stride + 1);
  const rows = inflateSync(png.compressed, { maxOutputLength: expected });
  if (rows.length !== expected) return null;
  for (let y = 0; y < png.height; y++) {
    if ((rows[y * (stride + 1)] ?? 255) > 4) return null;
  }
  if (png.colourType !== 3 || !png.palette) return { rows, pixels: null };
  const pixels = unfilter(rows, png.width, png.height, 1);
  const entries = png.palette.length / 3;
  for (const index of pixels) if (index >= entries) return null;
  return { rows, pixels };
}

/**
 * A PNG as a PDF image, or null when the pack cannot print it (see `parsePng` and `inflatePng`).
 * Grey, colour and palette images keep their own compressed data; only an image with
 * transparency is split into colour and a soft mask, which needs compressing again.
 */
function pngImage(bytes: Uint8Array): ImageObject | null {
  const png = parsePng(bytes);
  if (!png) return null;
  const inflated = inflatePng(png);
  if (!inflated) return null;
  const { width, height, colourType } = png;
  const params = (colours: number) =>
    `/DecodeParms << /Predictor 15 /Colors ${colours} /BitsPerComponent 8 /Columns ${width} >>`;
  const base = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8`;
  if (colourType === 0 || colourType === 2) {
    const colours = colourType === 0 ? 1 : 3;
    return {
      width,
      height,
      dict: `<< ${base} /ColorSpace /${colours === 1 ? "DeviceGray" : "DeviceRGB"} /Filter /FlateDecode ${params(colours)}`,
      data: png.compressed,
    };
  }
  if (colourType === 3 && png.palette) {
    const hex = Buffer.from(png.palette).toString("hex");
    return {
      width,
      height,
      dict: `<< ${base} /ColorSpace [/Indexed /DeviceRGB ${png.palette.length / 3 - 1} <${hex}>] /Filter /FlateDecode ${params(1)}`,
      data: png.compressed,
    };
  }
  // Colour with alpha: the colour and the alpha go in separate images (a soft mask).
  const colours = colourType === 4 ? 1 : 3;
  const pixels = unfilter(inflated.rows, width, height, colours + 1);
  const colour = new Uint8Array(width * height * colours);
  const alpha = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    for (let k = 0; k < colours; k++) colour[p * colours + k] = pixels[p * (colours + 1) + k] ?? 0;
    alpha[p] = pixels[p * (colours + 1) + colours] ?? 255;
  }
  return {
    width,
    height,
    dict: `<< ${base} /ColorSpace /${colours === 1 ? "DeviceGray" : "DeviceRGB"} /Filter /FlateDecode`,
    data: deflateSync(colour),
    mask: {
      dict: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode`,
      data: deflateSync(alpha),
    },
  };
}

/**
 * The photo as a PDF image, or null when it is not a JPEG or PNG the pack can print. Never throws:
 * a broken or hostile file means "cannot be printed", named on the first page (HZ-001, HZ-023).
 */
export function pdfImage(image: PdfImage): ImageObject | null {
  try {
    return decodeImage(image);
  } catch {
    return null;
  }
}

/**
 * Whether a photo will print on the pack: the same checks the PDF's decoder makes, without
 * building the PDF image (nothing is compressed again). Decided once, when a photo is uploaded,
 * and stored with the document (`document.image_printable`). Never throws.
 */
export function isPrintableImage(image: PdfImage): boolean {
  try {
    if (image.contentType === "image/jpeg") return jpegFrame(image.bytes) !== null;
    if (image.contentType !== "image/png") return false;
    const png = parsePng(image.bytes);
    return png !== null && inflatePng(png) !== null;
  } catch {
    return false;
  }
}

function decodeImage(image: PdfImage): ImageObject | null {
  if (image.contentType === "image/jpeg") {
    const frame = jpegFrame(image.bytes);
    if (!frame) return null;
    return {
      width: frame.width,
      height: frame.height,
      dict: `<< /Type /XObject /Subtype /Image /Width ${frame.width} /Height ${frame.height} /ColorSpace /${frame.components === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode`,
      data: image.bytes,
    };
  }
  if (image.contentType === "image/png") return pngImage(image.bytes);
  return null;
}

// ------------------------------------------------------------------------------------------------
// Layout
// ------------------------------------------------------------------------------------------------

interface Placed {
  readonly line: PdfLine;
  readonly y: number;
}

function paginate(
  lines: readonly PdfLine[],
  withImage: boolean,
  headerHeight = 0,
  /** Where the first page's text starts, when something is drawn above it (a letter's blocks). */
  firstTop?: number,
): Placed[][] {
  const pages: Placed[][] = [[]];
  const top = PAGE_HEIGHT - MARGIN - headerHeight;
  let y = firstTop ?? top;
  const imageBottom = top - IMAGE_BOX.height - 10;
  for (const line of lines) {
    const size = line.size ?? 10;
    const font = packFont(line.bold ? "bold" : "regular");
    // Beside the photo on the first page, lines stop short of it.
    const besideImage = withImage && pages.length === 1 && y > imageBottom;
    const width = besideImage ? TEXT_WIDTH - IMAGE_BOX.width - 15 : TEXT_WIDTH;
    if (line.pageBreakBefore && (pages.at(-1)?.length ?? 0) > 0) {
      pages.push([]);
      y = top;
    }
    for (const [n, piece] of wrap(line.text, width, size, font).entries()) {
      const step = size * LINE_FACTOR + (n === 0 ? (line.gapBefore ?? 0) : 0);
      if (y - step < FOOTER_Y + 20) {
        pages.push([]);
        y = top;
      }
      y -= step;
      pages.at(-1)?.push({ line: { ...line, text: piece }, y });
    }
  }
  return pages;
}

/** Glyphs used per font, for the widths and the ToUnicode map. */
class Usage {
  readonly glyphs = new Map<number, string>();
  encode(font: TrueTypeFont, text: string): string {
    let hex = "";
    for (const ch of text) {
      const glyph = glyphOf(font, ch);
      if (!this.glyphs.has(glyph))
        this.glyphs.set(glyph, font.glyph(ch.codePointAt(0) ?? 0) === 0 ? "?" : ch);
      hex += glyph.toString(16).padStart(4, "0");
    }
    return hex;
  }
}

function utf16Hex(text: string): string {
  let hex = "";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0");
  return hex;
}

function toUnicodeCMap(usage: Usage): string {
  const entries = [...usage.glyphs.entries()].sort((a, b) => a[0] - b[0]);
  let body = "";
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [glyph, ch] of chunk) {
      body += `<${glyph.toString(16).padStart(4, "0")}> <${utf16Hex(ch)}>\n`;
    }
    body += "endbfchar\n";
  }
  return (
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    body +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
  );
}

/** A literal string for the document information dictionary (UTF-16 with a byte order mark). */
function infoString(text: string): string {
  return `<feff${utf16Hex(text)}>`;
}

/**
 * Each embedded font file, compressed once per loaded font rather than once per pack (about
 * 1.26 MB of fonts). Keyed by the font itself, so a font parsed again is compressed again.
 */
const compressedFonts = new WeakMap<TrueTypeFont, Buffer>();
function compressedFont(font: TrueTypeFont): Buffer {
  let file = compressedFonts.get(font);
  if (!file) {
    file = deflateSync(font.bytes);
    compressedFonts.set(font, file);
  }
  return file;
}

/** Header lines are 9 point bold, wrapped, with this much space below them. */
const HEADER_SIZE = 9;
const HEADER_GAP = 8;

/** Points in a millimetre. */
const MM = 72 / 25.4;

/**
 * Where a posted letter's blocks sit on page 1 (comms.md section 11; H-228), in millimetres from
 * the page's top left. The recipient's address is placed for the window of a standard DL or C5
 * left-hand window envelope (about 90 by 35 mm, 20 mm from the left), and nothing else is drawn in
 * the window's band; the provider's letterhead is at the top right, clear of it; the letter's text
 * starts below. The print test on real envelopes confirms the positions before letters are posted
 * (human action H-228).
 */
export const LETTER_LAYOUT = {
  addressLeftMm: 20,
  addressTopMm: 50,
  addressWidthMm: 85,
  addressHeightMm: 35,
  letterheadLeftMm: 120,
  letterheadTopMm: 15,
  bodyTopMm: 100,
} as const;

/** A posted letter's blocks on page 1: the provider's letterhead and the recipient's address. */
export interface LetterBlocks {
  readonly letterhead: readonly string[];
  readonly address: readonly string[];
}

const LETTER_SIZE = 10;

/** The letter's two blocks as placed lines, each wrapped to its width and cut to its height. */
function letterLines(
  letter: LetterBlocks,
): { text: string; x: number; y: number; bold: boolean }[] {
  const out: { text: string; x: number; y: number; bold: boolean }[] = [];
  const step = LETTER_SIZE * LINE_FACTOR;
  const place = (
    lines: readonly string[],
    leftMm: number,
    topMm: number,
    widthPt: number,
    maxLines: number,
    boldFirst: boolean,
  ) => {
    const pieces = lines.flatMap((text, n) =>
      wrap(text, widthPt, LETTER_SIZE, packFont(boldFirst && n === 0 ? "bold" : "regular")).map(
        (piece) => ({ piece, bold: boldFirst && n === 0 }),
      ),
    );
    for (const [n, { piece, bold }] of pieces.slice(0, maxLines).entries()) {
      out.push({
        text: piece,
        x: leftMm * MM,
        y: PAGE_HEIGHT - topMm * MM - (n + 1) * step,
        bold,
      });
    }
  };
  const L = LETTER_LAYOUT;
  place(
    letter.letterhead,
    L.letterheadLeftMm,
    L.letterheadTopMm,
    PAGE_WIDTH - L.letterheadLeftMm * MM - MARGIN,
    Math.floor(((L.addressTopMm - L.letterheadTopMm - 5) * MM) / step),
    true,
  );
  place(
    letter.address,
    L.addressLeftMm,
    L.addressTopMm,
    L.addressWidthMm * MM,
    Math.floor((L.addressHeightMm * MM) / step),
    false,
  );
  return out;
}

/**
 * Builds the PDF bytes: every page carries the footer (for example the person's identity) and,
 * when given, the same header lines at the top (for example a downtime pack's freshness words).
 */
export function renderPdf(input: {
  readonly title: string;
  readonly lines: readonly PdfLine[];
  /** `owner`: the `owner` of the last line placed on or before this page, if any. */
  readonly footer: (page: number, pages: number, owner: string | undefined) => string;
  readonly image?: ImageObject | null;
  readonly header?: readonly string[];
  /** A posted letter: the letterhead and the window-envelope address on page 1 (H-228). */
  readonly letter?: LetterBlocks;
}): Uint8Array {
  const image = input.image ?? null;
  const headerLines = (input.header ?? []).flatMap((text) =>
    wrap(text, TEXT_WIDTH, HEADER_SIZE, packFont("bold")),
  );
  const headerHeight =
    headerLines.length === 0 ? 0 : headerLines.length * HEADER_SIZE * LINE_FACTOR + HEADER_GAP;
  const letter = input.letter ? letterLines(input.letter) : [];
  const pages = paginate(
    input.lines,
    image !== null,
    headerHeight,
    input.letter ? PAGE_HEIGHT - LETTER_LAYOUT.bodyTopMm * MM : undefined,
  );
  const fonts = { F1: packFont("regular"), F2: packFont("bold") } as const;
  const usage = { F1: new Usage(), F2: new Usage() };

  const objects: { dict: string; stream?: Uint8Array }[] = [];
  const add = (dict: string, stream?: Uint8Array) => {
    objects.push(stream ? { dict, stream } : { dict });
    return objects.length;
  };
  const reserve = () => add("");
  const catalog = reserve();
  const pagesId = reserve();
  const fontIds = { F1: reserve(), F2: reserve() };
  const info = add(`<< /Title ${infoString(input.title)} /Producer (Harbour) >>`);
  let imageId: number | null = null;
  if (image) {
    const maskId = image.mask
      ? add(`${image.mask.dict} /Length ${image.mask.data.length} >>`, image.mask.data)
      : null;
    imageId = add(
      `${image.dict}${maskId ? ` /SMask ${maskId} 0 R` : ""} /Length ${image.data.length} >>`,
      image.data,
    );
  }

  const pageIds: number[] = [];
  let owner: string | undefined;
  for (const [index, placed] of pages.entries()) {
    const footerOwner = placed[0]?.line.owner ?? owner;
    for (const { line } of placed) owner = line.owner ?? owner;
    let content = "";
    for (const [n, piece] of headerLines.entries()) {
      const hex = usage.F2.encode(fonts.F2, piece);
      const y = PAGE_HEIGHT - MARGIN - (n + 1) * HEADER_SIZE * LINE_FACTOR;
      content += `BT /F2 ${HEADER_SIZE} Tf ${MARGIN} ${y.toFixed(1)} Td <${hex}> Tj ET\n`;
    }
    if (index === 0) {
      for (const block of letter) {
        const key = block.bold ? "F2" : "F1";
        const hex = usage[key].encode(fonts[key], block.text);
        content += `BT /${key} ${LETTER_SIZE} Tf ${block.x.toFixed(1)} ${block.y.toFixed(1)} Td <${hex}> Tj ET\n`;
      }
    }
    for (const { line, y } of placed) {
      const key = line.bold ? "F2" : "F1";
      const hex = usage[key].encode(fonts[key], line.text);
      content += `BT /${key} ${line.size ?? 10} Tf ${MARGIN} ${y.toFixed(1)} Td <${hex}> Tj ET\n`;
    }
    const footer = input.footer(index + 1, pages.length, footerOwner);
    for (const [n, piece] of wrap(footer, TEXT_WIDTH, 8).entries()) {
      const hex = usage.F1.encode(fonts.F1, piece);
      content += `BT /F1 8 Tf ${MARGIN} ${FOOTER_Y - n * 10} Td <${hex}> Tj ET\n`;
    }
    if (index === 0 && image && imageId !== null) {
      const scale = Math.min(IMAGE_BOX.width / image.width, IMAGE_BOX.height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      content += `q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${(PAGE_WIDTH - MARGIN - w).toFixed(1)} ${(PAGE_HEIGHT - MARGIN - headerHeight - h).toFixed(1)} cm /Im1 Do Q\n`;
    }
    const data = deflateSync(Buffer.from(content, "latin1"));
    const contentId = add(`<< /Length ${data.length} /Filter /FlateDecode >>`, data);
    const xobject = index === 0 && imageId !== null ? ` /XObject << /Im1 ${imageId} 0 R >>` : "";
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R >>${xobject} >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  for (const key of ["F1", "F2"] as const) {
    const font = fonts[key];
    const scale = 1000 / font.unitsPerEm;
    const file = compressedFont(font);
    const fileId = add(
      `<< /Length ${file.length} /Length1 ${font.bytes.length} /Filter /FlateDecode >>`,
      file,
    );
    const [x1, y1, x2, y2] = font.bbox.map((v) => Math.round(v * scale));
    const descriptor = add(
      `<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [${x1} ${y1} ${x2} ${y2}] ` +
        `/ItalicAngle 0 /Ascent ${Math.round(font.ascent * scale)} /Descent ${Math.round(font.descent * scale)} ` +
        `/CapHeight ${Math.round(font.capHeight * scale)} /StemV 80 /FontFile2 ${fileId} 0 R >>`,
    );
    const widths = [...usage[key].glyphs.keys()]
      .sort((a, b) => a - b)
      .map((g) => `${g} [${Math.round(font.advance(g) * scale)}]`)
      .join(" ");
    const cid = add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} ` +
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
        `/FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW 500 /W [${widths}] >>`,
    );
    const cmap = deflateSync(Buffer.from(toUnicodeCMap(usage[key]), "latin1"));
    const toUnicode = add(`<< /Length ${cmap.length} /Filter /FlateDecode >>`, cmap);
    objects[fontIds[key] - 1] = {
      dict:
        `<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H ` +
        `/DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
    };
  }
  objects[catalog - 1] = { dict: `<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (en-GB) >>` };
  objects[pagesId - 1] = {
    dict: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  };

  const chunks: Buffer[] = [];
  let length = 0;
  const push = (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  push(Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1"));
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const id = index + 1;
    if (object.stream) {
      push(Buffer.from(`${id} 0 obj\n${object.dict}\nstream\n`, "latin1"));
      push(Buffer.from(object.stream));
      push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      push(Buffer.from(`${id} 0 obj\n${object.dict}\nendobj\n`, "latin1"));
    }
  }
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) table += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  table += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(table, "latin1"));
  return new Uint8Array(Buffer.concat(chunks, length));
}
