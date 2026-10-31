import { describe, expect, it } from "vitest";
import {
  checkSignature,
  checkUpload,
  DEFAULT_SIGNATURE_STATEMENT,
  type DocumentCategoryKey,
  isDocumentCategory,
  safeFileName,
  sniffContentType,
} from "./documents";
import {
  type HeldDocumentVersion,
  isDocumentUnderLegalHold,
  isUnderLegalHold,
  type LegalHoldView,
} from "./retention";

const bytes = (...b: number[]) => new Uint8Array(b);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
const PDF = new TextEncoder().encode("%PDF-1.7\n%");
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe("content sniffing", () => {
  it.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["PNG", PNG, "image/png"],
    ["WebP", WEBP, "image/webp"],
    ["PDF", PDF, "application/pdf"],
    ["HTML", HTML, null],
    ["SVG (scriptable, never allowed)", SVG, null],
    ["a truncated PNG", bytes(0x89, 0x50, 0x4e), null],
    ["nothing", bytes(), null],
  ])("%s", (_label, input, expected) => {
    expect(sniffContentType(input)).toBe(expected);
  });
});

describe("upload checks", () => {
  it.each<[string, DocumentCategoryKey, Uint8Array, string | null, boolean, string | null]>([
    ["a photo of a person", "person_photo", JPEG, "image/jpeg", true, null],
    [
      "a PNG photo declared generically",
      "person_photo",
      PNG,
      "application/octet-stream",
      true,
      null,
    ],
    ["a PDF as a photo", "person_photo", PDF, "application/pdf", true, "type_not_allowed"],
    ["HTML pretending to be a JPEG", "person_photo", HTML, "image/jpeg", true, "type_not_allowed"],
    ["a JPEG declared as PNG", "care_attachment", JPEG, "image/png", true, "type_mismatch"],
    [
      "a wound photo without a person",
      "care_attachment",
      JPEG,
      "image/jpeg",
      false,
      "person_required",
    ],
    [
      "a policy about a person",
      "organisation_document",
      PDF,
      "application/pdf",
      true,
      "person_not_allowed",
    ],
    ["a policy PDF", "organisation_document", PDF, "application/pdf; charset=binary", false, null],
    ["an empty file", "person_document", bytes(), "application/pdf", true, "empty"],
  ])("%s", (_label, category, data, declared, hasPerson, problem) => {
    const result = checkUpload(category, { bytes: data, declaredType: declared, hasPerson });
    if (problem === null) expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, problem });
  });

  it("refuses files over the category's limit with the limit in the message", () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG);
    const result = checkUpload("person_photo", {
      bytes: big,
      declaredType: "image/jpeg",
      hasPerson: true,
    });
    expect(result).toMatchObject({
      ok: false,
      problem: "too_large",
      message: "Files of this kind must be 10 MB or smaller.",
    });
  });

  it("names the allowed types in plain English", () => {
    const result = checkUpload("organisation_document", {
      bytes: JPEG,
      declaredType: null,
      hasPerson: false,
    });
    expect(result.ok ? "" : result.message).toBe("This kind of document must be PDF.");
  });

  it("knows its categories", () => {
    expect(isDocumentCategory("person_photo")).toBe(true);
    expect(isDocumentCategory("toString")).toBe(false);
    expect(isDocumentCategory("anything")).toBe(false);
  });
});

describe("safe file names", () => {
  it.each([
    ["Letter from GP.pdf", "Letter from GP.pdf"],
    ["C:\\Users\\me\\Desktop\\scan.pdf", "scan.pdf"],
    ["../../etc/passwd", "passwd"],
    ["..hidden.pdf", "hidden.pdf"],
    ['bad<>:"|?*name.pdf', "badname.pdf"],
    ["tab\there.pdf", "tabhere.pdf"],
    ["", null],
    [null, null],
    ["////", null],
  ])("%s becomes %s", (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });

  it("keeps the extension when trimming a long name", () => {
    const name = `${"a".repeat(200)}.pdf`;
    const safe = safeFileName(name);
    expect(safe?.length).toBe(120);
    expect(safe?.endsWith(".pdf")).toBe(true);
  });
});

describe("typed-name signatures", () => {
  const hash = "ab".repeat(32);
  it("accepts a typed name against the current version with the default statement", () => {
    expect(
      checkSignature({
        typedName: "  Ada   Example ",
        sha256Seen: hash,
        currentSha256: hash.toUpperCase(),
      }),
    ).toEqual({
      ok: true,
      signerName: "Ada Example",
      statement: DEFAULT_SIGNATURE_STATEMENT,
    });
  });

  it.each([
    ["a missing name", { typedName: " " }, "name_required"],
    ["a too-short statement", { statement: "ok" }, "statement_required"],
    ["a changed document", { sha256Seen: "cd".repeat(32) }, "document_changed"],
  ])("refuses %s", (_label, change, problem) => {
    expect(
      checkSignature({
        typedName: "Ada Example",
        sha256Seen: hash,
        currentSha256: hash,
        ...change,
      }),
    ).toMatchObject({
      ok: false,
      problem,
    });
  });
});

describe("legal holds", () => {
  const holds = [
    { personId: "p1", subjectType: null, subjectId: null, releasedAt: null },
    { personId: null, subjectType: "document", subjectId: "d9", releasedAt: null },
    { personId: "p2", subjectType: null, subjectId: null, releasedAt: new Date("2026-01-01") },
  ];
  it.each([
    [
      "anything about a held person",
      { personId: "p1", subjectType: "document", subjectId: "d1" },
      true,
    ],
    ["a held document", { personId: null, subjectType: "document", subjectId: "d9" }, true],
    [
      "a person whose hold was released",
      { personId: "p2", subjectType: "document", subjectId: "d2" },
      false,
    ],
    ["an unrelated record", { personId: "p3", subjectType: "document", subjectId: "d3" }, false],
  ])("%s", (_label, record, expected) => {
    expect(isUnderLegalHold(record, holds)).toBe(expected);
  });
});

describe("legal holds on a document and its versions (security review, 31 October 2026)", () => {
  const holds: LegalHoldView[] = [
    { personId: "p1", subjectType: null, subjectId: null, releasedAt: null },
    { personId: null, subjectType: "document", subjectId: "v1", releasedAt: null },
    { personId: null, subjectType: "incident", subjectId: "i1", releasedAt: null },
    {
      personId: null,
      subjectType: "incident",
      subjectId: "i2",
      releasedAt: new Date("2026-01-01"),
    },
    {
      personId: null,
      subjectType: "document",
      subjectId: "r1",
      releasedAt: new Date("2026-01-01"),
    },
  ];
  const version = (over: Partial<HeldDocumentVersion> = {}): HeldDocumentVersion => ({
    id: "x",
    personId: null,
    subjectType: null,
    subjectId: null,
    legalHold: false,
    ...over,
  });
  it.each<[string, HeldDocumentVersion[], boolean]>([
    ["a document with nothing holding it", [version({ id: "d1", personId: "p9" })], false],
    ["a document about a held person", [version({ id: "d1", personId: "p1" })], true],
    ["a document held by its own id", [version({ id: "v1" })], true],
    ["a document flagged as held", [version({ id: "d1", legalHold: true })], true],
    [
      "a document belonging to a held record",
      [version({ id: "d1", subjectType: "incident", subjectId: "i1" })],
      true,
    ],
    [
      "a document belonging to a record whose hold was released",
      [version({ id: "d1", subjectType: "incident", subjectId: "i2" })],
      false,
    ],
    [
      "a record of another type with the same id",
      [version({ id: "d1", subjectType: "care_note", subjectId: "i1" })],
      false,
    ],
    [
      "a later version when the first version is held",
      [version({ id: "v1" }), version({ id: "v2" }), version({ id: "v3" })],
      true,
    ],
    [
      "the first version when a later version is flagged",
      [version({ id: "d1" }), version({ id: "d2", legalHold: true })],
      true,
    ],
    [
      "versions whose only hold was released",
      [version({ id: "r1" }), version({ id: "r2" })],
      false,
    ],
  ])("%s", (_label, versions, expected) => {
    expect(isDocumentUnderLegalHold(versions, holds)).toBe(expected);
  });
});
