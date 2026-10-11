import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isPrintableImage, pdfImage, renderPdf, wrap } from "../src/services/pdf";
import { packFont, unprintableCharacters } from "../src/services/pdf-font";
import { renderTransferPackPdf, type StoredPack } from "../src/services/transfer-pack-pdf";
import { pdfPages, pdfText } from "./support/pdf-text";

/**
 * The printed packs' PDF writer (ADR-0040): Noto Sans embedded as TrueType so names and clinical
 * words print as written (HZ-001, HZ-007, HZ-023), line breaks kept, characters the font lacks
 * named on the first page, and JPEG or PNG photos drawn.
 */

const page = (lines: string[]) =>
  renderPdf({
    title: "Test",
    lines: lines.map((text) => ({ text })),
    footer: (n, of) => `page ${n} of ${of}`,
  });

describe("hazard HZ-023 text prints as written", () => {
  it.each([
    "β-lactam antibiotics: anaphylaxis",
    "Alendronic acid 25 μg weekly",
    "Llŷr Example, Ŵyn Example",
    "Łukasz Example",
    "Œdème; Šárka Example; costs € 12",
  ])("prints %s", (text) => {
    expect(unprintableCharacters(text)).toEqual([]);
    expect(pdfText(page([text]))).toContain(text);
  });

  it("composes a letter typed with a combining accent before printing it", () => {
    expect(pdfText(page(["Llŷr"]))).toContain("Llŷr");
  });

  it("names the characters the font cannot print, and prints them as a question mark", () => {
    expect(unprintableCharacters("Name 漢字 Example")).toEqual(["漢", "字"]);
    expect(pdfText(page(["Name 漢 Example"]))).toContain("Name ? Example");
  });

  it("starts a new line at each line break instead of printing a symbol", () => {
    const lines = pdfPages(page(["First line\nSecond line"]))[0] ?? [];
    expect(lines).toContain("First line");
    expect(lines).toContain("Second line");
  });

  it("wraps by measured width and never loses a word", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const lines = wrap(text, 200, 10, packFont("regular"));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.join(" ")).toBe(text);
  });

  it("carries the footer on every page", () => {
    const many = Array.from({ length: 120 }, (_, i) => `Line ${i}`);
    const pages = pdfPages(page(many));
    expect(pages.length).toBeGreaterThan(1);
    for (const [n, lines] of pages.entries()) {
      expect(lines).toContain(`page ${n + 1} of ${pages.length}`);
    }
  });
});

/** A small PNG of the given colour type (8-bit unless said, not interlaced unless said). */
function png(
  colourType: 0 | 2 | 6,
  width = 2,
  height = 2,
  options: { depth?: number; interlace?: number } = {},
): Uint8Array {
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : 4;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * channels + 1)] = y === 0 ? 0 : 2; // filters: none, then up
    for (let x = 0; x < width * channels; x++) raw[y * (width * channels + 1) + 1 + x] = 200;
  }
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = options.depth ?? 8;
  ihdr[9] = colourType;
  ihdr[12] = options.interlace ?? 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** A PNG whose image data inflates to `size` bytes, far more than its 2 x 2 header allows. */
function withIdat(base: Uint8Array, size: number): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const header = Buffer.from(base.subarray(0, 8 + 25));
  return new Uint8Array(
    Buffer.concat([
      header,
      chunk("IDAT", deflateSync(Buffer.alloc(size, 7))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("hazard HZ-001 the photo", () => {
  it.each([
    ["grey", 0],
    ["colour", 2],
    ["colour with transparency", 6],
  ] as const)("draws a %s PNG", (_label, type) => {
    const image = pdfImage({ bytes: png(type), contentType: "image/png" });
    expect(image).not.toBeNull();
    const bytes = renderPdf({
      title: "Photo",
      lines: [{ text: "With a photo" }],
      footer: () => "footer",
      image,
    });
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("/Subtype /Image");
    expect(text.includes("/SMask")).toBe(type === 6);
  });

  it.each([
    ["a 16-bit PNG", () => png(2, 2, 2, { depth: 16 })],
    ["an interlaced PNG", () => png(2, 2, 2, { interlace: 1 })],
    ["a PNG claiming 20000 x 20000 pixels", () => png(6, 20_000, 20_000)],
    ["a PNG over the pixel limit", () => png(2, 4097, 4096)],
    ["a 16-byte truncated PNG", () => png(2).subarray(0, 16)],
    ["a PNG whose chunk runs past the end", () => png(6).subarray(0, 40)],
    ["a PNG whose data inflates past its header", () => withIdat(png(6, 2, 2), 64 * 1024)],
  ])("hazard HZ-023 treats %s as not printable, without decoding it", (_label, make) => {
    const bytes = make();
    expect(pdfImage({ bytes, contentType: "image/png" })).toBeNull();
    expect(isPrintableImage({ bytes, contentType: "image/png" })).toBe(false);
  });

  it("hazard HZ-023 treats a JPEG over the pixel limit, or truncated, as not printable", () => {
    const sof = (w: number, h: number) =>
      new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0,
        17,
        8,
        h >> 8,
        h & 0xff,
        w >> 8,
        w & 0xff,
        3,
        ...new Array(12).fill(0),
      ]);
    expect(pdfImage({ bytes: sof(20_000, 20_000), contentType: "image/jpeg" })).toBeNull();
    expect(pdfImage({ bytes: sof(2, 2), contentType: "image/jpeg" })).not.toBeNull();
    expect(pdfImage({ bytes: sof(2, 2).subarray(0, 8), contentType: "image/jpeg" })).toBeNull();
  });

  it("refuses an image it cannot print (WebP, or not what it claims to be)", () => {
    expect(pdfImage({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/webp" })).toBeNull();
    expect(pdfImage({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" })).toBeNull();
    expect(pdfImage({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" })).toBeNull();
  });
});

const PACK: StoredPack = {
  personId: "0194d000-0000-7000-8000-000000000401",
  generatedAt: "2026-10-11T09:15:00.000Z",
  identity: {
    givenName: "Łukasz",
    familyName: "Example",
    preferredName: null,
    dateOfBirth: "1940-03-02",
    nhsNumber: "9990000018",
  },
  sections: [
    {
      key: "allergies",
      title: "Allergies and adverse reactions",
      critical: true,
      status: "included",
      asOf: "2026-10-01T10:00:00.000Z",
    },
    {
      key: "medicines",
      title: "Current medicines",
      critical: true,
      status: "not_recorded",
      asOf: null,
    },
    {
      key: "resuscitation",
      title: "Resuscitation status (ReSPECT, DNACPR)",
      critical: true,
      status: "included",
      asOf: "2026-10-01T10:00:00.000Z",
    },
    {
      key: "eating_and_drinking",
      title: "Eating and drinking (IDDSI levels)",
      critical: true,
      status: "included",
      asOf: "2026-10-01T10:00:00.000Z",
    },
    { key: "about_me", title: "About Me", critical: true, status: "included", asOf: null },
  ],
  content: {
    allergies: {
      status: "has_allergies",
      allergies: [
        { substance: "β-lactam antibiotics", severity: "severe", reaction: "Anaphylaxis" },
      ],
    },
    medicines: { status: "not_recorded" },
    resuscitation: {
      status: "recorded",
      decision: "do_not_attempt_cpr",
      conflicting: true,
      reviewDueOn: "2026-10-01",
      reviewOverdue: true,
      cprRecords: [
        {
          kind: "respect",
          summary: "For cardiopulmonary resuscitation",
          clinician: "Dr Example, GP",
          completedOn: "2026-06-01",
          reviewOn: "2026-10-01",
        },
        {
          kind: "dnacpr",
          summary: "Not for cardiopulmonary resuscitation",
          clinician: "Dr Other, consultant",
          completedOn: "2026-05-01",
          reviewOn: null,
        },
      ],
      otherRecords: [],
    },
    eatingAndDrinking: { foodLevel: "7EC", drinkLevel: "1", notes: null },
    aboutMe: {
      document: { what_is_most_important_to_me: { text: "My son Llŷr\nand my garden" } },
    },
  },
  missingCritical: ["medicines"],
  attention: [
    {
      key: "resuscitation",
      code: "resuscitation_conflict",
      message:
        "The resuscitation records disagree. Both are printed; check the original documents before acting on either.",
      onDate: null,
    },
    {
      key: "resuscitation",
      code: "resuscitation_review_overdue",
      message: "The resuscitation decision is past its review date.",
      onDate: "2026-10-01",
    },
  ],
  itemsLeftBehind: [],
};

const print = (pack: StoredPack) =>
  pdfPages(
    renderTransferPackPdf({
      pack,
      hospitalName: "Example General Hospital",
      locationName: "Harbour House",
      names: new Map(),
      photo: null,
      printedAt: new Date("2026-10-11T09:20:00Z"),
    }),
  );

describe("hazard HZ-023 the printed transfer pack", () => {
  it("names the person and lists what is missing and what needs checking on the first page", () => {
    const first = print(PACK)[0] ?? [];
    expect(first).toContain("EXAMPLE, Łukasz");
    expect(first).toContain("Medicines: not recorded since admission. Check the MAR.");
    expect(first).toContain("CHECK BEFORE RELYING ON THIS PACK");
    expect(first.join(" ")).toContain("The resuscitation records disagree.");
    expect(first.join(" ")).toContain("past its review date. (01/10/2026)");
    expect(first).not.toContain("Every safety-critical section is recorded.");
  });

  it("hazard HZ-015 prints ReSPECT and DNACPR that disagree with both records, never resolved", () => {
    const text = print(PACK).flat().join("\n");
    expect(text).toContain(
      "CPR decision: THE RECORDS DISAGREE. Check the original documents. Both are listed.",
    );
    expect(text).toContain("ReSPECT: For cardiopulmonary resuscitation.");
    expect(text).toContain("DNACPR: Not for cardiopulmonary resuscitation.");
    expect(text).not.toContain("CPR decision: Not for cardiopulmonary resuscitation.");
  });

  it("hazard HZ-015 prints an ADRT alone as no CPR decision", () => {
    const text = print({
      ...PACK,
      content: {
        ...PACK.content,
        resuscitation: {
          status: "not_recorded",
          otherRecords: [
            {
              kind: "adrt",
              summary: "Refuses artificial ventilation",
              clinician: "Not recorded",
              completedOn: "2025-02-01",
              reviewOn: null,
            },
          ],
        },
      },
    })
      .flat()
      .join("\n");
    expect(text).toContain("CPR decision: not recorded.");
    expect(text).toContain("Advance decision to refuse treatment: Refuses artificial ventilation.");
  });

  it("hazard HZ-016 prints the IDDSI levels with their names", () => {
    const text = print(PACK).flat().join("\n");
    expect(text).toContain("Food: IDDSI Level 7EC Easy to chew (black).");
    expect(text).toContain("Drinks: IDDSI Level 1 Slightly thick (grey).");
  });

  it("hazard HZ-007 prints clinical words as written, with line breaks kept", () => {
    const text = print(PACK).flat().join("\n");
    expect(text).toContain("β-lactam antibiotics: severe. Reaction: Anaphylaxis");
    expect(text).toContain("What is most important to me: My son Llŷr");
    expect(text).toContain("and my garden");
  });

  it("names on the first page any section with characters it cannot print", () => {
    const first =
      print({
        ...PACK,
        content: {
          ...PACK.content,
          aboutMe: { document: { what_is_most_important_to_me: { text: "漢字" } } },
        },
      })[0] ?? [];
    expect(first.join(" ")).toContain(
      'Some characters could not be printed and show as "?" in: About Me.',
    );
  });
});
