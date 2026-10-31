/**
 * Removes metadata from an image that is shown to everyone (the organisation's logo, PLAT-002):
 * EXIF (which can hold a GPS position, a name or a device serial), XMP, IPTC, comments and PNG text
 * chunks. The pixels are left as they are. Pure; returns null for a file that is not a well-formed
 * PNG or JPEG (including bytes after the end of the image), which the caller refuses.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** PNG chunks that carry text, EXIF or a time stamp rather than the picture. */
const PNG_DROPPED = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function stripPng(bytes: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (!PNG_DROPPED.has(type)) out.push(bytes.subarray(at, end));
    at = end;
    if (type === "IEND") return at === bytes.length ? concat(out) : null;
  }
  return null;
}

/**
 * JPEG segments kept before the scan: APP0 (JFIF), APP2 (the ICC colour profile) and APP14 (Adobe
 * colour transform), and every non-APP marker. APP1 (EXIF, XMP), APP13 (IPTC), the other APPn and
 * comments go.
 */
function keptJpegMarker(marker: number): boolean {
  if (marker === 0xfe) return false;
  if (marker >= 0xe0 && marker <= 0xef)
    return marker === 0xe0 || marker === 0xe2 || marker === 0xee;
  return true;
}

function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (length < 2) return null;
    const end = at + 2 + length;
    if (end > bytes.length) return null;
    if (keptJpegMarker(marker)) out.push(bytes.subarray(at, end));
    if (marker === 0xda) {
      // Start of scan: the compressed picture follows, to the end of the file.
      out.push(bytes.subarray(end));
      return concat(out);
    }
    at = end;
  }
  return null;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

export function stripImageMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return stripPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
  return null;
}
