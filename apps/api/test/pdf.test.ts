import { randomBytes } from "node:crypto";
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

/** The PNG with its first row's filter byte replaced. */
function withFilter(base: Uint8Array, filter: number): Uint8Array {
  const raw = Buffer.alloc((2 * 3 + 1) * 2, 200);
  raw[0] = filter;
  raw[7] = 0;
  return withIdatData(base, deflateSync(raw));
}

/** A 2 x 2 palette PNG with `entries` palette colours whose pixels all use index `index`. */
function palettePng(entries: number, index: number): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const raw = Buffer.from([0, index, index, 0, index, index]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...(entries > 0 ? [chunk("PLTE", Buffer.alloc(entries * 3, 90))] : []),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** The PNG with its image data replaced. */
function withIdatData(base: Uint8Array, data: Buffer): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(base.subarray(0, 8 + 25)),
      chunk("IDAT", data),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** The PNG with its image data spread over `count` chunks (the first holds it, the rest empty). */
function splitIdat(base: Uint8Array, count: number): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const raw = Buffer.alloc((8 * 3 + 1) * 8, 0);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(base.subarray(0, 8 + 25)),
      chunk("IDAT", deflateSync(raw)),
      ...Array.from({ length: count - 1 }, () => chunk("IDAT", Buffer.alloc(0))),
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
    ["a PNG over 2048 pixels on a side", () => png(2, 2049, 2)],
    ["a PNG with a row filter that does not exist", () => withFilter(png(2, 2, 2), 9)],
    ["a palette PNG whose pixels point past its palette", () => palettePng(2, 5)],
    ["a palette PNG without its palette", () => palettePng(0, 0)],
    ["a PNG in more image chunks than the limit", () => splitIdat(png(2, 8, 8), 1025)],
    [
      "a PNG with more compressed image data than the limit",
      () => withIdatData(png(2, 8, 8), randomBytes(8 * 1024 * 1024 + 1)),
    ],
    ["a PNG whose image data stops short of its header", () => withIdat(png(2, 2, 2), 3)],
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
    expect(pdfImage({ bytes: sof(2049, 10), contentType: "image/jpeg" })).toBeNull();
    expect(pdfImage({ bytes: sof(2, 2), contentType: "image/jpeg" })).not.toBeNull();
    expect(pdfImage({ bytes: sof(2, 2).subarray(0, 8), contentType: "image/jpeg" })).toBeNull();
  });

  it("hazard HZ-023 prints a grey JPEG as grey and a colour one as colour, and refuses CMYK and 12-bit JPEGs", () => {
    const sof = (components: number, precision = 8, marker = 0xc0) =>
      new Uint8Array([
        0xff,
        0xd8,
        0xff,
        marker,
        0,
        8 + components * 3,
        precision,
        0,
        2,
        0,
        2,
        components,
        ...new Array(components * 3).fill(0),
        0,
        0,
      ]);
    expect(pdfImage({ bytes: sof(1), contentType: "image/jpeg" })?.dict).toContain("/DeviceGray");
    expect(pdfImage({ bytes: sof(3), contentType: "image/jpeg" })?.dict).toContain("/DeviceRGB");
    expect(pdfImage({ bytes: sof(4), contentType: "image/jpeg" })).toBeNull();
    expect(pdfImage({ bytes: sof(3, 12), contentType: "image/jpeg" })).toBeNull();
    expect(pdfImage({ bytes: sof(3, 8, 0xc9), contentType: "image/jpeg" })).toBeNull();
    expect(isPrintableImage({ bytes: sof(4), contentType: "image/jpeg" })).toBe(false);
  });

  it("hazard HZ-023 prints a palette PNG whose pixels are all in its palette", () => {
    expect(pdfImage({ bytes: palettePng(2, 1), contentType: "image/png" })).not.toBeNull();
    expect(isPrintableImage({ bytes: palettePng(2, 1), contentType: "image/png" })).toBe(true);
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
    // Said once, in sentence case, on page 1; the section lists both records.
    expect(text.split("the records disagree").length - 1).toBe(1);
    expect(print(PACK)[0] ?? []).toContain(
      "CPR decision: the records disagree. Check the original documents before acting.",
    );
    expect(text).not.toMatch(/RECORDS DISAGREE/);
    expect(text).toContain("ReSPECT: For cardiopulmonary resuscitation.");
    expect(text).toContain("DNACPR: Not for cardiopulmonary resuscitation.");
    expect(text).not.toContain("CPR decision: Not for cardiopulmonary resuscitation.");
  });

  it("hazard HZ-015 prints an ADRT alone as no CPR decision, and says on page 1 to read it", () => {
    const pages = print({
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
    });
    const text = pages.flat().join("\n");
    expect((pages[0] ?? []).join(" ")).toContain(
      "CPR decision: not recorded on a ReSPECT or DNACPR form. An advance decision to refuse treatment is held (01/02/2025): read it before acting.",
    );
    expect(text).not.toContain("CPR decision: not recorded.");
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

  it("hazard HZ-015 prints the CPR decision in force on page 1, however long the medicines list", () => {
    const medicines = Array.from({ length: 25 }, (_, n) => ({
      name: `Medicine number ${n + 1}, a modified-release preparation taken with food and plenty of water`,
      dose: "1 tablet",
      route: "oral",
      frequency:
        "08:00, 12:00, 16:00 and 20:00, and at night when needed for pain or breathlessness",
      timeCritical: n === 0,
    }));
    const pages = print({
      ...PACK,
      content: {
        ...PACK.content,
        medicines: { status: "recorded", source: "emar", items: medicines },
        resuscitation: {
          status: "recorded",
          decision: "do_not_attempt_cpr",
          conflicting: false,
          reviewDueOn: null,
          reviewOverdue: false,
          cprRecords: [
            {
              kind: "dnacpr",
              summary: "Not for cardiopulmonary resuscitation",
              clinician: "Dr Example, GP",
              completedOn: "2026-05-01",
              reviewOn: null,
            },
          ],
          otherRecords: [],
        },
      },
      missingCritical: [],
      attention: [],
    });
    expect(pages.length).toBeGreaterThan(1);
    const first = pages[0] ?? [];
    expect(first).toContain(
      "CPR decision: Not for cardiopulmonary resuscitation (DNACPR, 01/05/2026).",
    );
    // The section with the records comes after the medicines, on a later page.
    expect(first.join(" ")).not.toContain(
      "DNACPR: Not for cardiopulmonary resuscitation. Dr Example",
    );
  });

  it.each([
    [
      "records that disagree",
      PACK.content.resuscitation,
      "CPR decision: the records disagree. Check the original documents before acting.",
    ],
    ["none recorded", { status: "not_recorded", otherRecords: [] }, "CPR decision: not recorded."],
    [
      "no decision in place, with nobody recorded as confirming it",
      {
        status: "no_decision_in_place",
        confirmedBy: null,
        confirmedAt: "2026-10-01T09:00:00.000Z",
      },
      "CPR decision: no decision in place (who confirmed it is not recorded; recorded on 01/10/2026 10:00).",
    ],
  ])("hazard HZ-015 says on page 1 when the CPR decision is %s", (_label, resuscitation, line) => {
    const first = print({ ...PACK, content: { ...PACK.content, resuscitation } })[0] ?? [];
    expect(first).toContain(line);
  });

  it("names the home or the hospital on page 1 when their names have characters it cannot print", () => {
    const first =
      pdfPages(
        renderTransferPackPdf({
          pack: PACK,
          hospitalName: "Ysbyty 医院",
          locationName: "Harbour House",
          names: new Map(),
          photo: null,
          printedAt: new Date("2026-10-11T09:20:00Z"),
        }),
      )[0] ?? [];
    expect(first.join(" ")).toContain('show as "?" in: Hospital name.');
  });
});
