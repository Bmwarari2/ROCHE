import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "./image-metadata";

/** Metadata stripping for the shared logo (PLAT-002; security review): table-driven. */

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** A PNG chunk; the CRC is not checked by the stripper, so zeros stand in. */
const chunk = (type: string, data: number[]) => [
  ...u32(data.length),
  ...ascii(type),
  ...data,
  0,
  0,
  0,
  0,
];
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const IDAT = chunk("IDAT", [1, 2, 3]);
const IEND = chunk("IEND", []);
const GPS = ascii("GPS 51.5N 0.1W");

const seg = (marker: number, data: number[]) => [
  0xff,
  marker,
  ...[(data.length + 2) >> 8, (data.length + 2) & 255],
  ...data,
];
const SOI = [0xff, 0xd8];
const APP0 = seg(0xe0, ascii("JFIF\0"));
const SOS = seg(0xda, [1, 2, 3]);
const SCAN = [9, 9, 9, 0xff, 0xd9];

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

describe("stripImageMetadata", () => {
  it.each([
    ["tEXt", chunk("tEXt", GPS)],
    ["zTXt", chunk("zTXt", GPS)],
    ["iTXt", chunk("iTXt", GPS)],
    ["eXIf", chunk("eXIf", GPS)],
    ["tIME", chunk("tIME", [7, 234, 10, 31, 12, 0, 0])],
  ])("drops a PNG %s chunk and keeps the picture", (_type, meta) => {
    const clean = bytes(SIG, IHDR, IDAT, IEND);
    expect(stripImageMetadata(bytes(SIG, IHDR, meta, IDAT, IEND))).toEqual(clean);
  });

  it.each([
    ["APP1 (EXIF and XMP)", seg(0xe1, [...ascii("Exif\0\0"), ...GPS])],
    ["APP13 (IPTC)", seg(0xed, GPS)],
    ["a comment", seg(0xfe, GPS)],
    ["APP15", seg(0xef, GPS)],
  ])("drops a JPEG %s segment and keeps the scan", (_name, meta) => {
    const clean = bytes(SOI, APP0, SOS, SCAN);
    expect(stripImageMetadata(bytes(SOI, APP0, meta, SOS, SCAN))).toEqual(clean);
  });

  it("keeps the JPEG colour profile (APP2) and Adobe segment (APP14)", () => {
    const icc = seg(0xe2, ascii("ICC_PROFILE\0"));
    const adobe = seg(0xee, ascii("Adobe"));
    const image = bytes(SOI, APP0, icc, adobe, SOS, SCAN);
    expect(stripImageMetadata(image)).toEqual(image);
  });

  it.each([
    ["bytes after the PNG's end", bytes(SIG, IHDR, IDAT, IEND, ascii("trailing"))],
    ["a PNG with no end", bytes(SIG, IHDR, IDAT)],
    ["a PNG chunk longer than the file", bytes(SIG, [0, 0, 1, 0], ascii("IDAT"), [1])],
    ["a JPEG segment that is not a marker", bytes(SOI, [0x00, 0x01, 0x02, 0x03])],
    ["a JPEG with no scan", bytes(SOI, APP0)],
    ["a JPEG segment length below 2", bytes(SOI, [0xff, 0xe0, 0, 1])],
    ["a JPEG segment longer than the file", bytes(SOI, [0xff, 0xe0, 0, 99])],
    ["an SVG", new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))],
    ["a PDF", new Uint8Array(ascii("%PDF-1.7"))],
    ["nothing", new Uint8Array()],
  ])("refuses %s", (_name, input) => {
    expect(stripImageMetadata(input)).toBeNull();
  });
});
