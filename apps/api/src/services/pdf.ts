/**
 * A minimal PDF 1.4 writer for printed packs (ADR-0040): A4 pages of text in the standard
 * Helvetica fonts, with an optional JPEG image on the first page. No dependencies and no
 * JavaScript, forms or external references in the output. Text outside the Windows-1252 range is
 * replaced, so callers keep to plain British English. The tagged PDF/UA renderer of ADR-0001
 * (Typst) replaces it when the documents pipeline gains one.
 */

export interface PdfLine {
  readonly text: string;
  readonly bold?: boolean;
  /** Font size in points; 10 by default. */
  readonly size?: number;
  /** Blank space before the line, in points. */
  readonly gapBefore?: number;
}

export interface PdfImage {
  /** JPEG bytes (baseline or progressive). */
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const FOOTER_Y = 30;
const LINE_FACTOR = 1.3;
const WRAP_COLUMNS = 92;
const IMAGE_BOX = { width: 110, height: 140 };

const REPLACEMENTS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
};

/** Escapes a string for a PDF literal, keeping to Latin-1 (WinAnsi) characters. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const replaced = REPLACEMENTS[ch] ?? ch;
    for (const c of replaced) {
      const code = c.codePointAt(0) ?? 63;
      if (c === "\\" || c === "(" || c === ")") out += `\\${c}`;
      else if (code < 32 || code > 255) out += code === 9 ? " " : "?";
      else out += c;
    }
  }
  return out;
}

/** Splits a line into lines of at most `columns` characters at spaces (no regular expression). */
export function wrap(text: string, columns = WRAP_COLUMNS): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    let rest = word;
    while (rest.length > columns) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(rest.slice(0, columns));
      rest = rest.slice(columns);
    }
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= columns) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  lines.push(current);
  return lines;
}

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
    // Beside the photo on the first page, lines are kept short enough not to run under it.
    const besideImage = withImage && pages.length === 1 && y > imageBottom;
    const columns = Math.floor(((besideImage ? 70 : WRAP_COLUMNS) * 10) / size);
    for (const [n, piece] of wrap(line.text, columns).entries()) {
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

/** Builds the PDF bytes: every page carries the footer (for example the person's identity). */
export function renderPdf(input: {
  readonly title: string;
  readonly lines: readonly PdfLine[];
  readonly footer: (page: number, pages: number) => string;
  readonly image?: PdfImage | null;
}): Uint8Array {
  const pages = paginate(input.lines, Boolean(input.image));
  const objects: string[] = [];
  const binary = new Map<number, Uint8Array>();
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const pagesId = add("");
  const regular = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  const info = add(`<< /Title (${pdfString(input.title)}) /Producer (Harbour) >>`);
  let imageId: number | null = null;
  if (input.image) {
    imageId = add(
      `<< /Type /XObject /Subtype /Image /Width ${input.image.width} /Height ${input.image.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${input.image.jpeg.length} >>`,
    );
    binary.set(imageId, input.image.jpeg);
  }
  const pageIds: number[] = [];
  for (const [index, placed] of pages.entries()) {
    let content = "";
    for (const { line, y } of placed) {
      content += `BT /${line.bold ? "F2" : "F1"} ${line.size ?? 10} Tf ${MARGIN} ${y.toFixed(1)} Td (${pdfString(line.text)}) Tj ET\n`;
    }
    content += `BT /F1 8 Tf ${MARGIN} ${FOOTER_Y} Td (${pdfString(input.footer(index + 1, pages.length))}) Tj ET\n`;
    if (index === 0 && input.image && imageId !== null) {
      const scale = Math.min(
        IMAGE_BOX.width / input.image.width,
        IMAGE_BOX.height / input.image.height,
      );
      const w = input.image.width * scale;
      const h = input.image.height * scale;
      content += `q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${(PAGE_WIDTH - MARGIN - w).toFixed(1)} ${(PAGE_HEIGHT - MARGIN - h).toFixed(1)} cm /Im1 Do Q\n`;
    }
    const contentId = add(
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    );
    const xobject = index === 0 && imageId !== null ? ` /XObject << /Im1 ${imageId} 0 R >>` : "";
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >>${xobject} >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /Lang (en-GB) >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const chunks: Buffer[] = [];
  let length = 0;
  const push = (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  push(Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1"));
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(length);
    const id = index + 1;
    const image = binary.get(id);
    if (image) {
      push(Buffer.from(`${id} 0 obj\n${body}\nstream\n`, "latin1"));
      push(Buffer.from(image));
      push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      push(Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, "latin1"));
    }
  }
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) table += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  table += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(table, "latin1"));
  return new Uint8Array(Buffer.concat(chunks, length));
}
