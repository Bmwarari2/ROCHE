import { inflateSync } from "node:zlib";

/**
 * Reads the text back out of a PDF made by services/pdf.ts, page by page and line by line, through
 * each font's ToUnicode map: what a screen reader or a copy and paste would get. Test use only.
 */

interface PdfObject {
  readonly dict: string;
  readonly stream: Buffer | null;
}

function objects(bytes: Uint8Array): Map<number, PdfObject> {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("latin1");
  const found = new Map<number, PdfObject>();
  let at = 0;
  for (;;) {
    const start = text.indexOf(" 0 obj\n", at);
    if (start < 0) break;
    let digits = start;
    while (digits > 0 && text[digits - 1] !== "\n") digits--;
    const id = Number(text.slice(digits, start));
    const end = text.indexOf("\nendobj\n", start);
    const body = text.slice(start + 7, end);
    const marker = body.indexOf("\nstream\n");
    if (marker < 0) {
      found.set(id, { dict: body, stream: null });
    } else {
      const dict = body.slice(0, marker);
      const from = start + 7 + marker + 8;
      const to = text.lastIndexOf("\nendstream", end);
      const raw = buffer.subarray(from, to);
      found.set(id, {
        dict,
        stream:
          dict.includes("/FlateDecode") && !dict.includes("/Subtype /Image")
            ? inflateSync(raw)
            : raw,
      });
    }
    at = end + 8;
  }
  return found;
}

const ref = (dict: string, key: string): number | null => {
  const i = dict.indexOf(`/${key} `);
  if (i < 0) return null;
  const rest = dict.slice(i + key.length + 2).trim();
  const n = Number.parseInt(rest, 10);
  return Number.isNaN(n) ? null : n;
};

function toUnicodeMap(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of cmap.split("\n")) {
    if (!line.startsWith("<") || !line.includes("> <")) continue;
    const [glyph, unicode] = line
      .split("> <")
      .map((part) => part.replaceAll("<", "").replaceAll(">", ""));
    if (!glyph || !unicode) continue;
    let text = "";
    for (let i = 0; i < unicode.length; i += 4) {
      text += String.fromCharCode(Number.parseInt(unicode.slice(i, i + 4), 16));
    }
    map.set(glyph.toLowerCase(), text);
  }
  return map;
}

/** Every page's lines of text, in the order they were drawn. */
export function pdfPages(bytes: Uint8Array): string[][] {
  const all = objects(bytes);
  const catalog = [...all.values()].find((o) => o.dict.includes("/Type /Catalog"));
  const pagesId = catalog ? ref(catalog.dict, "Pages") : null;
  const pagesDict = pagesId ? (all.get(pagesId)?.dict ?? "") : "";
  const kids = pagesDict
    .slice(pagesDict.indexOf("[") + 1, pagesDict.indexOf("]"))
    .split(" R")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  return kids.map((pageId) => {
    const page = all.get(pageId)?.dict ?? "";
    const fonts = new Map<string, Map<string, string>>();
    for (const key of ["F1", "F2"]) {
      const fontId = ref(page, key);
      const font = fontId ? all.get(fontId) : undefined;
      const cmapId = font ? ref(font.dict, "ToUnicode") : null;
      const cmap = cmapId ? all.get(cmapId)?.stream : null;
      fonts.set(key, cmap ? toUnicodeMap(cmap.toString("latin1")) : new Map());
    }
    const contentId = ref(page, "Contents");
    const content = contentId ? (all.get(contentId)?.stream?.toString("latin1") ?? "") : "";
    const lines: string[] = [];
    for (const op of content.split("\n")) {
      if (!op.startsWith("BT /")) continue;
      const key = op.slice(4, 6);
      const hex = op.slice(op.indexOf("<") + 1, op.indexOf(">"));
      const map = fonts.get(key) ?? new Map<string, string>();
      let text = "";
      for (let i = 0; i < hex.length; i += 4) text += map.get(hex.slice(i, i + 4)) ?? "�";
      lines.push(text);
    }
    return lines;
  });
}

/** All the text of a PDF, one line per drawn line. */
export function pdfText(bytes: Uint8Array): string {
  return pdfPages(bytes)
    .map((lines) => lines.join("\n"))
    .join("\n");
}
