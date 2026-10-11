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

/** Reads a JPEG's pixel size from its start-of-frame marker, or null when it is not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
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

/** A PNG as a PDF image (8-bit, not interlaced), or null when the pack cannot print it. */
function pngImage(bytes: Uint8Array): ImageObject | null {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8] ?? 0;
      colourType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (type === "PLTE") palette = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (width === 0 || height === 0 || depth !== 8 || interlace !== 0 || idat.length === 0) {
    return null;
  }
  const compressed = Buffer.concat(idat.map((c) => Buffer.from(c)));
  const params = (colours: number) =>
    `/DecodeParms << /Predictor 15 /Colors ${colours} /BitsPerComponent 8 /Columns ${width} >>`;
  const base = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8`;
  if (colourType === 0 || colourType === 2) {
    const colours = colourType === 0 ? 1 : 3;
    return {
      width,
      height,
      dict: `<< ${base} /ColorSpace /${colours === 1 ? "DeviceGray" : "DeviceRGB"} /Filter /FlateDecode ${params(colours)}`,
      data: compressed,
    };
  }
  if (colourType === 3 && palette) {
    const hex = Buffer.from(palette).toString("hex");
    return {
      width,
      height,
      dict: `<< ${base} /ColorSpace [/Indexed /DeviceRGB ${palette.length / 3 - 1} <${hex}>] /Filter /FlateDecode ${params(1)}`,
      data: compressed,
    };
  }
  if (colourType === 4 || colourType === 6) {
    // Colour with alpha: the colour and the alpha go in separate images (a soft mask).
    const colours = colourType === 4 ? 1 : 3;
    const pixels = unfilter(inflateSync(compressed), width, height, colours + 1);
    const colour = new Uint8Array(width * height * colours);
    const alpha = new Uint8Array(width * height);
    for (let p = 0; p < width * height; p++) {
      for (let k = 0; k < colours; k++)
        colour[p * colours + k] = pixels[p * (colours + 1) + k] ?? 0;
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
  return null;
}

/** The photo as a PDF image, or null when it is not a JPEG or PNG the pack can print. */
export function pdfImage(image: PdfImage): ImageObject | null {
  if (image.contentType === "image/jpeg") {
    const size = jpegSize(image.bytes);
    if (!size) return null;
    return {
      ...size,
      dict: `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
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

function paginate(lines: readonly PdfLine[], withImage: boolean): Placed[][] {
  const pages: Placed[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  const imageBottom = PAGE_HEIGHT - MARGIN - IMAGE_BOX.height - 10;
  for (const line of lines) {
    const size = line.size ?? 10;
    const font = packFont(line.bold ? "bold" : "regular");
    // Beside the photo on the first page, lines stop short of it.
    const besideImage = withImage && pages.length === 1 && y > imageBottom;
    const width = besideImage ? TEXT_WIDTH - IMAGE_BOX.width - 15 : TEXT_WIDTH;
    for (const [n, piece] of wrap(line.text, width, size, font).entries()) {
      const step = size * LINE_FACTOR + (n === 0 ? (line.gapBefore ?? 0) : 0);
      if (y - step < FOOTER_Y + 20) {
        pages.push([]);
        y = PAGE_HEIGHT - MARGIN;
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

/** Builds the PDF bytes: every page carries the footer (for example the person's identity). */
export function renderPdf(input: {
  readonly title: string;
  readonly lines: readonly PdfLine[];
  readonly footer: (page: number, pages: number) => string;
  readonly image?: ImageObject | null;
}): Uint8Array {
  const image = input.image ?? null;
  const pages = paginate(input.lines, image !== null);
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
  for (const [index, placed] of pages.entries()) {
    let content = "";
    for (const { line, y } of placed) {
      const key = line.bold ? "F2" : "F1";
      const hex = usage[key].encode(fonts[key], line.text);
      content += `BT /${key} ${line.size ?? 10} Tf ${MARGIN} ${y.toFixed(1)} Td <${hex}> Tj ET\n`;
    }
    for (const [n, piece] of wrap(input.footer(index + 1, pages.length), TEXT_WIDTH, 8).entries()) {
      const hex = usage.F1.encode(fonts.F1, piece);
      content += `BT /F1 8 Tf ${MARGIN} ${FOOTER_Y - n * 10} Td <${hex}> Tj ET\n`;
    }
    if (index === 0 && image && imageId !== null) {
      const scale = Math.min(IMAGE_BOX.width / image.width, IMAGE_BOX.height / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      content += `q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${(PAGE_WIDTH - MARGIN - w).toFixed(1)} ${(PAGE_HEIGHT - MARGIN - h).toFixed(1)} cm /Im1 Do Q\n`;
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
    const file = deflateSync(font.bytes);
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
